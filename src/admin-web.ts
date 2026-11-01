/**
 * Local web administration console, served from the same port as the mock IM.
 *
 * The page is plain HTML/CSS/JS (no build step). API calls require the random
 * token printed by `npm start`; the page is public but useless without it.
 * Writes use {@link GroupAdmin} with the `web` audit actor, so they follow the
 * same validation and audit path as the terminal console.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ConfigError, maskSecrets } from './config';
import { GroupAdmin, type AgentConfigPatch, type GroupConfigPatch } from './group-admin';
import type { Group } from './group';
import type { Harness, SettingsPatch } from './harness';
import type { ListenConfig, ResponsePolicy } from './meta';
import { PERMISSION_IDS, type PermissionId } from './permissions';
import type { SearchOptions } from './storage';
import { BUSINESS_TOOL_DEFINITIONS } from './tools';

const GUARD = { bypass_permission: true } as const;
const BODY_LIMIT = 64 * 1024;
const CONTEXT_CHUNK = 1024 * 1024;
const PAGE = readFileSync(new URL('./admin.html', import.meta.url), 'utf8');

interface ContextOptions {
  before?: number;
  after?: number;
  limit: number;
}

interface ContextPage {
  messages: unknown[];
  before: number;
  after: number;
  size: number;
  mtimeMs: number;
  hasMore: boolean;
}

function readRange(fd: number, start: number, end: number): Buffer {
  const length = Math.max(0, end - start);
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = readSync(fd, buffer, offset, length - offset, start + offset);
    if (read <= 0) break;
    offset += read;
  }
  return buffer.subarray(0, offset);
}

interface LineRange {
  start: number;
  end: number;
  complete: boolean;
}

function lineRanges(buffer: Buffer): LineRange[] {
  const ranges: LineRange[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x0a) continue;
    if (index > start) ranges.push({ start, end: index, complete: true });
    start = index + 1;
  }
  if (start < buffer.length) ranges.push({ start, end: buffer.length, complete: false });
  return ranges;
}

function parseContextLines(buffer: Buffer, ranges: LineRange[]): unknown[] {
  const messages: unknown[] = [];
  for (const range of ranges) {
    try {
      messages.push(JSON.parse(buffer.subarray(range.start, range.end).toString('utf8')) as unknown);
    } catch {
      // A torn or invalid line is skipped; context.jsonl itself does the same.
    }
  }
  return messages;
}

/** Read a byte window from context.jsonl without loading the whole file. */
function readContextWindow(path: string, options: ContextOptions): ContextPage {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const stat = statSync(path);
    const size = stat.size;
    const limit = Math.min(Math.max(options.limit, 1), 200);
    if (options.after !== undefined) {
      const start = Math.min(Math.max(options.after, 0), size);
      const end = Math.min(size, start + CONTEXT_CHUNK);
      const buffer = readRange(fd, start, end);
      const complete = lineRanges(buffer).filter((range) => range.complete);
      const selected = complete.slice(0, limit);
      const messages = parseContextLines(buffer, selected);
      const last = selected.at(-1);
      const after = last === undefined ? start : start + last.end + 1;
      return { messages, before: start, after, size, mtimeMs: stat.mtimeMs, hasMore: after < size };
    }
    const before = Math.min(Math.max(options.before ?? size, 0), size);
    const start = Math.max(0, before - CONTEXT_CHUNK);
    const buffer = readRange(fd, start, before);
    let ranges = lineRanges(buffer);
    if (start > 0 && ranges.length > 0) ranges = ranges.slice(1);
    const complete = ranges.filter((range) => range.complete);
    const selected = complete.slice(-limit);
    const messages = parseContextLines(buffer, selected);
    const first = selected[0];
    const last = complete.at(-1);
    const nextBefore = first === undefined ? 0 : start + first.start;
    const after = last === undefined ? start : start + last.end + 1;
    return {
      messages,
      before: nextBefore,
      after,
      size,
      mtimeMs: stat.mtimeMs,
      hasMore: nextBefore > 0,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { messages: [], before: 0, after: 0, size: 0, mtimeMs: 0, hasMore: false };
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'expected a JSON object');
  }
  return value as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `"${key}" must be a non-empty string`);
  }
  return value;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, `"${key}" must be a string`);
  return value;
}

function stringArray(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new HttpError(400, `"${key}" must be an array of strings`);
  }
  return value as string[];
}

function numberValue(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new HttpError(400, `"${key}" must be a number`);
  }
  return value;
}

function isLoopback(hostname: string): boolean {
  const name = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return name === 'localhost' || name === '127.0.0.1' || name === '::1';
}

function displayHost(host: string): string {
  if (host === '0.0.0.0' || host === '::' || host === '') return '127.0.0.1';
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function parseNumber(value: string | null, name: string, min = 0): number | undefined {
  if (value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    throw new HttpError(400, `"${name}" must be an integer >= ${min}`);
  }
  return parsed;
}

export class AdminWeb {
  readonly token = randomBytes(24).toString('base64url');

  constructor(private readonly harness: Harness) {}

  /** Printable admin URL; call after the server has bound its port. */
  url(port: number): string {
    const host = displayHost(this.harness.globalConfig().im.host);
    return `http://${host}:${port}/?token=${this.token}`;
  }

  handle(request: IncomingMessage, response: ServerResponse): void {
    this.route(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      this.sendJson(response, status, { error: (error as Error).message });
    });
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const method = request.method ?? 'GET';

    if (url.pathname === '/' || url.pathname === '/index.html') {
      this.sendHtml(response);
      return;
    }
    if (!url.pathname.startsWith('/api/')) {
      this.sendText(response, 404, 'not found');
      return;
    }
    if (!this.authorized(request, url)) throw new HttpError(401, 'unauthorized: use the token printed by npm start');
    if (method !== 'GET') {
      const origin = request.headers.origin;
      if (origin !== undefined) {
        try {
          const originUrl = new URL(origin);
          const requestHost = request.headers.host ?? '';
          if (originUrl.host !== requestHost) {
            const requestUrl = new URL(`http://${requestHost}`);
            const sameLoopback =
              isLoopback(originUrl.hostname) && isLoopback(requestUrl.hostname) && originUrl.port === requestUrl.port;
            if (!sameLoopback) throw new HttpError(403, 'cross-origin request rejected');
          }
        } catch (error) {
          if (error instanceof HttpError) throw error;
          throw new HttpError(400, 'invalid origin');
        }
      }
    }

    if (method === 'GET' && url.pathname === '/api/state') {
      this.sendJson(response, 200, this.state(url));
      return;
    }
    if (method === 'GET' && url.pathname === '/api/settings') {
      this.sendJson(response, 200, this.settingsView());
      return;
    }
    if (method === 'PUT' && url.pathname === '/api/settings') {
      const body = asRecord(await this.readJson(request));
      const patch = asRecord(body.patch);
      try {
        this.harness.updateSettings(patch as SettingsPatch, 'web');
      } catch (error) {
        if (error instanceof ConfigError) throw new HttpError(400, error.message);
        throw error;
      }
      this.sendJson(response, 200, { ok: true });
      return;
    }
    if (method === 'GET' && url.pathname === '/api/messages') {
      const group = this.groupFromQuery(url);
      const before = parseNumber(url.searchParams.get('before'), 'before', 0);
      const after = parseNumber(url.searchParams.get('after'), 'after', 0);
      if (before !== undefined && after !== undefined) {
        throw new HttpError(400, 'use either "before" or "after", not both');
      }
      const limit = Math.min(parseNumber(url.searchParams.get('limit'), 'limit', 1) ?? 50, 200);
      const messages =
        before !== undefined
          ? group.messagesBefore(before, limit)
          : after !== undefined
            ? group.messagesAfter(after, limit)
            : group.latestMessages(limit);
      const first = messages[0];
      const last = messages[messages.length - 1];
      const hasMore =
        after !== undefined
          ? last !== undefined && group.messagesAfter(last.id, 1).length > 0
          : first !== undefined && group.messagesBefore(first.id, 1).length > 0;
      this.sendJson(response, 200, {
        messages,
        before: first?.id ?? null,
        after: last?.id ?? null,
        hasMore,
      });
      return;
    }
    if (method === 'GET' && url.pathname === '/api/context') {
      const group = this.groupFromQuery(url);
      const agent = url.searchParams.get('agent') ?? '';
      if (agent === '') throw new HttpError(400, '"agent" is required');
      if (group.memberType(agent) !== 'agent') throw new HttpError(400, '"agent" must name an agent member');
      const before = parseNumber(url.searchParams.get('before'), 'before', 0);
      const after = parseNumber(url.searchParams.get('after'), 'after', 0);
      if (before !== undefined && after !== undefined) {
        throw new HttpError(400, 'use either "before" or "after", not both');
      }
      const limit = parseNumber(url.searchParams.get('limit'), 'limit', 1) ?? 50;
      this.sendJson(response, 200, readContextWindow(group.contextPath(agent), { before, after, limit }));
      return;
    }
    if (method === 'GET' && url.pathname === '/api/search') {
      this.sendJson(response, 200, this.search(url));
      return;
    }
    if (method === 'GET' && url.pathname === '/api/task') {
      const group = this.groupFromQuery(url);
      const id = url.searchParams.get('id') ?? '';
      if (id === '') throw new HttpError(400, '"id" is required');
      const task = group.adminTaskDetail(id);
      if (task === undefined) throw new HttpError(404, `no task "${id}"`);
      this.sendJson(response, 200, task);
      return;
    }
    if (method === 'POST' && url.pathname === '/api/groups') {
      const body = asRecord(await this.readJson(request));
      const id = requiredString(body, 'id');
      const name = optionalString(body, 'name');
      const group = this.harness.createGroup(id, name, 'web');
      this.sendJson(response, 200, { ok: true, id: group.id });
      return;
    }
    if (method === 'POST' && url.pathname === '/api/messages') {
      const body = asRecord(await this.readJson(request));
      const group = this.groupOf(requiredString(body, 'group'));
      const user = requiredString(body, 'user');
      const text = requiredString(body, 'text');
      try {
        if (group.memberType(user) !== 'user') {
          throw new HttpError(400, '"user" must name a user member');
        }
        const id = group.send(user, text, 'user_message', 'web-admin');
        this.harness.audit.record({
          actor: 'web',
          group_id: group.id,
          action: 'send_as_user',
          target: user,
          after: { message_id: id, text },
          ok: true,
        });
        this.sendJson(response, 200, { ok: true, id });
      } catch (error) {
        this.harness.audit.record({
          actor: 'web',
          group_id: group.id,
          action: 'send_as_user',
          target: user,
          after: { text },
          ok: false,
          error: (error as Error).message,
        });
        throw error;
      }
      return;
    }
    if (method === 'POST' && url.pathname === '/api/members') {
      const body = asRecord(await this.readJson(request));
      const group = this.groupOf(requiredString(body, 'group'));
      const type = requiredString(body, 'type');
      if (type !== 'user' && type !== 'agent') throw new HttpError(400, '"type" must be "user" or "agent"');
      this.admin(group).registerMember(GUARD, { id: requiredString(body, 'id'), type });
      this.sendJson(response, 200, { ok: true });
      return;
    }
    if (method === 'PUT' && url.pathname === '/api/admins') {
      const body = asRecord(await this.readJson(request));
      this.admin(this.groupOf(requiredString(body, 'group'))).setAdmins(GUARD, stringArray(body, 'admins'));
      this.sendJson(response, 200, { ok: true });
      return;
    }
    if (method === 'PUT' && url.pathname === '/api/identity-groups') {
      const body = asRecord(await this.readJson(request));
      this.admin(this.groupOf(requiredString(body, 'group'))).setIdentityGroups(
        GUARD,
        requiredString(body, 'member'),
        stringArray(body, 'groups'),
      );
      this.sendJson(response, 200, { ok: true });
      return;
    }
    if (method === 'PUT' && url.pathname === '/api/permissions') {
      const body = asRecord(await this.readJson(request));
      const permission = requiredString(body, 'permission') as PermissionId;
      this.admin(this.groupOf(requiredString(body, 'group'))).setPermissionGroups(
        GUARD,
        permission,
        stringArray(body, 'groups'),
      );
      this.sendJson(response, 200, { ok: true });
      return;
    }
    if (method === 'PUT' && url.pathname === '/api/listen') {
      const body = asRecord(await this.readJson(request));
      const listen = asRecord(body.listen) as unknown as ListenConfig;
      this.admin(this.groupOf(requiredString(body, 'group'))).setListen(
        GUARD,
        requiredString(body, 'member'),
        listen,
      );
      this.sendJson(response, 200, { ok: true });
      return;
    }
    if (method === 'POST' && url.pathname === '/api/policies') {
      const body = asRecord(await this.readJson(request));
      const policy: ResponsePolicy = {
        agent: requiredString(body, 'agent'),
        trigger_mode: requiredString(body, 'trigger_mode') as ResponsePolicy['trigger_mode'],
        sender_type: requiredString(body, 'sender_type') as ResponsePolicy['sender_type'],
        context_before: numberValue(body, 'context_before'),
      };
      this.admin(this.groupOf(requiredString(body, 'group'))).addPolicy(GUARD, policy);
      this.sendJson(response, 200, { ok: true });
      return;
    }
    if (method === 'DELETE' && url.pathname === '/api/policies') {
      const group = this.groupFromQuery(url);
      const agent = url.searchParams.get('agent') ?? '';
      if (agent === '') throw new HttpError(400, '"agent" is required');
      this.admin(group).clearPolicies(GUARD, agent);
      this.sendJson(response, 200, { ok: true });
      return;
    }
    if (method === 'PUT' && url.pathname === '/api/agent-config') {
      const body = asRecord(await this.readJson(request));
      const patch = asRecord(body.patch);
      if (patch.tools !== undefined && (!Array.isArray(patch.tools) || patch.tools.some((tool) => typeof tool !== 'string'))) {
        throw new HttpError(400, '"patch.tools" must be an array of tool names');
      }
      this.admin(this.groupOf(requiredString(body, 'group'))).setAgentConfig(
        GUARD,
        requiredString(body, 'agent'),
        patch as unknown as AgentConfigPatch,
      );
      this.sendJson(response, 200, { ok: true });
      return;
    }
    if (method === 'PUT' && url.pathname === '/api/group-config') {
      const body = asRecord(await this.readJson(request));
      const patch = asRecord(body.patch) as unknown as GroupConfigPatch;
      this.admin(this.groupOf(requiredString(body, 'group'))).setGroupConfig(GUARD, patch);
      this.sendJson(response, 200, { ok: true });
      return;
    }
    if (method === 'POST' && url.pathname === '/api/reload') {
      this.harness.reload();
      this.sendJson(response, 200, { ok: true });
      return;
    }
    throw new HttpError(404, `unknown API route: ${method} ${url.pathname}`);
  }

  private state(url: URL): unknown {
    const requested = url.searchParams.get('group') ?? undefined;
    const groups = this.harness.listGroups().map((group) => {
      try {
        const view = group.view();
        return {
          id: group.id,
          name: view.name,
          members: view.members.length,
          agents: view.members.filter((member) => member.type === 'agent').length,
          policies: view.policies.length,
        };
      } catch (error) {
        return {
          id: group.id,
          name: group.name,
          members: 0,
          agents: 0,
          policies: 0,
          error: (error as Error).message,
        };
      }
    });
    const group = requested === undefined
      ? this.harness.listGroups()[0]
      : this.harness.group(requested);
    if (requested !== undefined && group === undefined) throw new HttpError(404, `unknown group "${requested}"`);
    return {
      groups,
      group: group === undefined ? null : this.groupState(group),
      permissionIds: [...PERMISSION_IDS],
      businessTools: BUSINESS_TOOL_DEFINITIONS.map((definition) => definition.name),
      im: this.imUrl(),
      settings: this.settingsView(),
    };
  }

  private settingsView(): unknown {
    const global = this.harness.globalConfig();
    return {
      model: maskSecrets(global.model),
      filePermission: global.filePermission,
      workingDirectory: global.workingDirectory,
      im: global.im,
      webui: global.webui,
      configPath: this.harness.configPath,
    };
  }

  private groupState(group: Group): unknown {
    const view = group.view();
    const meta = group.metaSnapshot();
    const agents = view.members
      .filter((member) => member.type === 'agent')
      .map((member) => {
        let resolved: unknown;
        let overrides: unknown = {};
        try {
          resolved = group.agentView(member.id) ?? null;
        } catch (error) {
          resolved = { error: (error as Error).message };
        }
        try {
          overrides = maskSecrets(group.readAgentLayer(member.id));
        } catch (error) {
          overrides = { error: (error as Error).message };
        }
        return { id: member.id, resolved, overrides };
      });
    return {
      ...view,
      overrides: {
        model: maskSecrets(meta.model ?? {}),
        filePermission: meta.file_permission ?? {},
        workingDirectory: meta.working_directory ?? '',
      },
      agents,
      tasks: group.adminTasks(100),
      messages: group.latestMessages(100),
    };
  }

  private search(url: URL): unknown {
    const group = this.groupFromQuery(url);
    const query = url.searchParams.get('q') ?? '';
    if (query.trim() === '') throw new HttpError(400, '"q" is required');
    const since = url.searchParams.get('since');
    const until = url.searchParams.get('until');
    const limit = parseNumber(url.searchParams.get('limit'), 'limit', 1);
    const cursor = parseNumber(url.searchParams.get('cursor'), 'cursor', 0);
    const options: SearchOptions = {
      query,
      ...(since === null || since === '' ? {} : { since }),
      ...(until === null || until === '' ? {} : { until }),
      ...(limit === undefined ? {} : { limit }),
      ...(cursor === undefined ? {} : { cursor }),
    };
    return group.consoleSearch(options);
  }

  private imUrl(): string {
    const port = this.harness.imPort;
    if (port === undefined) return '';
    return `ws://${displayHost(this.harness.globalConfig().im.host)}:${port}`;
  }

  private groupOf(id: string): Group {
    const group = this.harness.group(id);
    if (group === undefined) throw new HttpError(404, `unknown group "${id}"`);
    return group;
  }

  private groupFromQuery(url: URL): Group {
    const id = url.searchParams.get('group') ?? '';
    if (id === '') throw new HttpError(400, '"group" is required');
    return this.groupOf(id);
  }

  private admin(group: Group): GroupAdmin {
    return new GroupAdmin(group, this.harness.audit, 'web');
  }

  private authorized(request: IncomingMessage, url: URL): boolean {
    const header = request.headers['x-admin-token'];
    const provided = typeof header === 'string' ? header : url.searchParams.get('token');
    if (provided === null || provided === undefined) return false;
    const actual = Buffer.from(provided);
    const expected = Buffer.from(this.token);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private async readJson(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      size += buffer.length;
      if (size > BODY_LIMIT) throw new HttpError(413, 'request body too large');
      chunks.push(buffer);
    }
    if (size === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw new HttpError(400, 'invalid JSON body');
    }
  }

  private sendHtml(response: ServerResponse): void {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    response.end(PAGE);
  }

  private sendJson(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(JSON.stringify(value));
  }

  private sendText(response: ServerResponse, status: number, text: string): void {
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(text);
  }
}
