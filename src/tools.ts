/**
 * Tool registry and the v1 tool set.
 *
 * Every model-facing call goes through the same pipeline:
 * pre-execute gate (validation and file permission) -> execute (timeout
 * wrapper) -> post-execute. Failures become structured `{error, message}`
 * results instead of raw exceptions.
 */
import { exec } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FilePermission, ResolvedConfig } from './config';
import { checkPathAccess, PermissionDenied } from './file-permission';
import type { StoredMessage } from './storage';

export type ToolErrorCode = 'timeout' | 'denied' | 'failed';

export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export interface TaskSummary {
  taskId: string;
  tooltype: string;
  status: string;
  visibility: string;
  publisherId: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDetail extends TaskSummary {
  listeners: string[];
  args: unknown;
  result: unknown;
  error: string | null;
}

export interface AttentionInput {
  members?: string[];
  groups?: string[];
  ttl_ms?: number;
}

export interface AttentionView {
  members: string[];
  groups: string[];
  expires_at: string;
  ttl_ms: number;
}

/** The narrow group surface tools receive; the caller id is never an argument. */
export interface ToolGroupApi {
  send(text: string): number;
  sendWithAttention(text: string, input: AttentionInput): { message_id: number; attention?: AttentionView };
  searchMessages(options: {
    query: string;
    since?: string;
    until?: string;
    cursor?: number;
    limit?: number;
  }): { messages: StoredMessage[]; nextCursor: number | null };
  listTasks(): TaskSummary[];
  getTask(taskId: string): TaskDetail | undefined;
  startTask(
    tooltype: string,
    args: Record<string, unknown>,
    listeners: string[] | undefined,
    visibility: 'private' | 'public',
  ): string;
}

export interface ToolContext {
  callerId: string;
  group: ToolGroupApi;
  config: ResolvedConfig;
  workingDirectory: string;
  filePermission: FilePermission;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Async tools create a background task instead of blocking the loop. */
  async?: boolean;
  timeoutMs?: number;
  pre?(args: Record<string, unknown>, ctx: ToolContext): void | Promise<void>;
  execute(args: Record<string, unknown>, ctx: ToolContext): unknown | Promise<unknown>;
  post?(result: unknown, ctx: ToolContext): unknown;
}

export class ToolRegistry {
  private readonly byName = new Map<string, ToolDefinition>();

  constructor(readonly definitions: ToolDefinition[]) {
    for (const definition of definitions) {
      if (this.byName.has(definition.name)) throw new Error(`duplicate tool "${definition.name}"`);
      this.byName.set(definition.name, definition);
    }
  }

  get(name: string): ToolDefinition | undefined {
    return this.byName.get(name);
  }

  schemas(): { name: string; description: string; parameters: Record<string, unknown> }[] {
    return this.definitions.map((definition) => ({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    }));
  }

  /** Run one tool call, converting every failure into a JSON result. */
  async run(
    definition: ToolDefinition,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<{ content: string; isError: boolean }> {
    try {
      await definition.pre?.(args, ctx);
      const raw = await this.withTimeout(definition, args, ctx);
      const result = definition.post === undefined ? raw : definition.post(raw, ctx);
      return { content: JSON.stringify(result ?? null), isError: false };
    } catch (error) {
      if (error instanceof PermissionDenied) {
        return { content: JSON.stringify({ error: 'denied', message: error.message }), isError: true };
      }
      if (error instanceof ToolError) {
        return { content: JSON.stringify({ error: error.code, message: error.message }), isError: true };
      }
      return {
        content: JSON.stringify({ error: 'failed', message: (error as Error).message }),
        isError: true,
      };
    }
  }

  private async withTimeout(
    definition: ToolDefinition,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<unknown> {
    const limit = definition.timeoutMs ?? 60_000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ToolError('timeout', `tool "${definition.name}" timed out after ${limit}ms`)),
        limit,
      );
      timer.unref();
    });
    try {
      return await Promise.race([Promise.resolve(definition.execute(args, ctx)), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

function stringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new ToolError('failed', `missing argument "${name}"`);
    return '';
  }
  if (typeof value !== 'string') throw new ToolError('failed', `argument "${name}" must be a string`);
  if (required && value.trim() === '') throw new ToolError('failed', `argument "${name}" must not be empty`);
  return value;
}

function optionalNumber(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ToolError('failed', `argument "${name}" must be a number`);
  }
  return value;
}

function optionalStringArray(
  args: Record<string, unknown>,
  name: string,
): string[] | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry === '')) {
    throw new ToolError('failed', `argument "${name}" must be an array of non-empty strings`);
  }
  return value as string[];
}

function expectArg(args: Record<string, unknown>): AttentionInput | undefined {
  const value = args.expect;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ToolError('failed', 'argument "expect" must be an object');
  }
  const record = value as Record<string, unknown>;
  const members = optionalStringArray(record, 'members');
  const groups = optionalStringArray(record, 'groups');
  const ttl = optionalNumber(record, 'ttl_ms');
  return {
    ...(members === undefined ? {} : { members }),
    ...(groups === undefined ? {} : { groups }),
    ...(ttl === undefined ? {} : { ttl_ms: ttl }),
  };
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ToolError('failed', `argument "${name}" must be a string`);
  return value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function truncateText(text: string, max: number): { text: string; truncated: boolean } {
  return text.length <= max ? { text, truncated: false } : { text: text.slice(0, max), truncated: true };
}

const sendMessageTool: ToolDefinition = {
  name: 'send_message',
  description:
    'Send a message to the group as yourself. Required to be seen by anyone. Optionally declare expected follow-up senders; their messages wake you without @ until the TTL expires.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Message text; mention with @member_id.' },
      expect: {
        type: 'object',
        description: 'Temporarily also wake for messages from these members/identity groups.',
        properties: {
          members: { type: 'array', items: { type: 'string' }, description: 'Member ids.' },
          groups: { type: 'array', items: { type: 'string' }, description: 'Identity group keys.' },
          ttl_ms: { type: 'number', description: 'Clamped to 1s..10min; default 2min.' },
        },
      },
    },
    required: ['text'],
  },
  execute(args, ctx) {
    const text = stringArg(args, 'text');
    const expect = expectArg(args);
    if (expect === undefined) return { message_id: ctx.group.send(text) };
    return ctx.group.sendWithAttention(text, expect);
  },
};

const searchMessagesTool: ToolDefinition = {
  name: 'search_messages',
  description:
    'Search group chat messages by keyword. Returns messages oldest first plus next_cursor for pagination.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keyword. Two-character CJK keywords use a LIKE fallback.' },
      since: { type: 'string', description: 'ISO8601 lower bound (inclusive).' },
      until: { type: 'string', description: 'ISO8601 upper bound (inclusive).' },
      cursor: { type: 'number', description: 'Return messages with id greater than this.' },
      limit: { type: 'number', description: 'Page size, default 50, max 200.' },
    },
    required: ['query'],
  },
  execute(args, ctx) {
    const query = stringArg(args, 'query');
    const since = optionalString(args, 'since');
    const until = optionalString(args, 'until');
    const cursor = optionalNumber(args, 'cursor');
    const limit = optionalNumber(args, 'limit');
    const page = ctx.group.searchMessages({
      query,
      ...(since === undefined ? {} : { since }),
      ...(until === undefined ? {} : { until }),
      ...(cursor === undefined ? {} : { cursor }),
      ...(limit === undefined ? {} : { limit }),
    });
    return { messages: page.messages, next_cursor: page.nextCursor };
  },
};

const listTasksTool: ToolDefinition = {
  name: 'list_tasks',
  description: 'List background tasks visible to you (yours, tasks you listen to, public tasks).',
  parameters: { type: 'object', properties: {} },
  execute(_args, ctx) {
    return { tasks: ctx.group.listTasks() };
  },
};

const getTaskTool: ToolDefinition = {
  name: 'get_task',
  description: 'Read one background task and its result. Private tasks you cannot see return 不可见.',
  parameters: {
    type: 'object',
    properties: { task_id: { type: 'string' } },
    required: ['task_id'],
  },
  execute(args, ctx) {
    const taskId = stringArg(args, 'task_id');
    const task = ctx.group.getTask(taskId);
    if (task === undefined) throw new ToolError('denied', '不可见');
    return task;
  },
};

const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: 'Read a UTF-8 text file. Binary files and files over 64 KiB are refused or truncated.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or working-directory-relative path.' },
    },
    required: ['path'],
  },
  pre(args, ctx) {
    checkPathAccess(ctx.filePermission, 'read', stringArg(args, 'path'), ctx.workingDirectory);
  },
  execute(args, ctx) {
    const path = checkPathAccess(ctx.filePermission, 'read', stringArg(args, 'path'), ctx.workingDirectory);
    const stats = statSync(path);
    if (stats.isDirectory()) throw new ToolError('failed', `${path} is a directory; use list_dir`);
    const buffer = readFileSync(path);
    if (buffer.subarray(0, 4096).includes(0)) throw new ToolError('failed', 'binary file');
    const slice = buffer.subarray(0, 64 * 1024);
    return {
      path,
      content: slice.toString('utf8'),
      truncated: buffer.length > slice.length,
    };
  },
};

const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description: 'Write a UTF-8 text file, creating parent directories inside the allowed paths.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or working-directory-relative path.' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  },
  pre(args, ctx) {
    checkPathAccess(ctx.filePermission, 'write', stringArg(args, 'path'), ctx.workingDirectory);
  },
  execute(args, ctx) {
    const target = checkPathAccess(ctx.filePermission, 'write', stringArg(args, 'path'), ctx.workingDirectory);
    const content = stringArg(args, 'content', false);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
    return { path: target, bytes: Buffer.byteLength(content, 'utf8') };
  },
};

const listDirTool: ToolDefinition = {
  name: 'list_dir',
  description: 'List entries of a directory (default: the working directory).',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
  },
  pre(args, ctx) {
    checkPathAccess(ctx.filePermission, 'read', optionalString(args, 'path') ?? '.', ctx.workingDirectory);
  },
  execute(args, ctx) {
    const target = checkPathAccess(
      ctx.filePermission,
      'read',
      optionalString(args, 'path') ?? '.',
      ctx.workingDirectory,
    );
    const entries = readdirSync(target, { withFileTypes: true })
      .slice(0, 500)
      .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other' }));
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return { path: target, entries };
  },
};

function makeRunCommand(async: boolean): ToolDefinition {
  const timeoutDefault = async ? 300_000 : 30_000;
  const timeoutMax = async ? 1_800_000 : 600_000;
  return {
    name: async ? 'run_command_async' : 'run_command',
    description: async
      ? 'Start a shell command in the background and return a task id immediately. The result arrives later as a task result event. listeners also receive it; visibility defaults to private.'
      : 'Run a shell command in the working directory and wait for it. Returns exit_code, stdout, stderr.',
    async,
    timeoutMs: timeoutMax + 5_000,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string', description: 'Relative to the working directory; defaults to it.' },
        timeout_ms: { type: 'number', description: `Default ${timeoutDefault}, max ${timeoutMax}.` },
        ...(async
          ? {
              listeners: {
                type: 'array',
                items: { type: 'string' },
                description: 'Member ids that also receive the result.',
              },
              visibility: { type: 'string', enum: ['private', 'public'] },
            }
          : {}),
      },
      required: ['command'],
    },
    pre(args, ctx) {
      const cwd = optionalString(args, 'cwd') ?? '.';
      checkPathAccess(ctx.filePermission, 'execute', cwd, ctx.workingDirectory);
    },
    async execute(args, ctx) {
      const command = stringArg(args, 'command');
      const cwdArg = optionalString(args, 'cwd') ?? '.';
      const workingDirectory = checkPathAccess(ctx.filePermission, 'execute', cwdArg, ctx.workingDirectory);
      const timeout = clamp(optionalNumber(args, 'timeout_ms') ?? timeoutDefault, 1_000, timeoutMax);
      return runShell(command, workingDirectory, timeout);
    },
  };
}

interface ShellResult {
  exit_code: number | null;
  timed_out: boolean;
  stdout: string;
  stderr: string;
}

function runShell(command: string, cwd: string, timeout: number): Promise<ShellResult> {
  return new Promise((resolvePromise, reject) => {
    exec(
      command,
      { cwd, timeout, maxBuffer: 1024 * 1024, env: process.env },
      (error, stdout, stderr) => {
        const out = truncateText(stdout, 32 * 1024);
        const err = truncateText(stderr, 32 * 1024);
        if (error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new ToolError('failed', `cannot start shell: ${error.message}`));
          return;
        }
        const killed = error !== null && (error as { killed?: boolean }).killed === true;
        resolvePromise({
          exit_code: error === null ? 0 : typeof error.code === 'number' ? error.code : null,
          timed_out: killed,
          stdout: out.text + (out.truncated ? '\n[stdout truncated]' : ''),
          stderr: err.text + (err.truncated ? '\n[stderr truncated]' : ''),
        });
      },
    );
  });
}

export const SYSTEM_TOOL_DEFINITIONS: ToolDefinition[] = [
  sendMessageTool,
  searchMessagesTool,
  listTasksTool,
  getTaskTool,
];

export const BUSINESS_TOOL_DEFINITIONS: ToolDefinition[] = [
  readFileTool,
  writeFileTool,
  listDirTool,
  makeRunCommand(false),
  makeRunCommand(true),
];

const businessByName = new Map(BUSINESS_TOOL_DEFINITIONS.map((definition) => [definition.name, definition]));

/** Throw on unknown business tool names so a typo fails at group load. */
export function validateToolNames(names: readonly string[]): void {
  for (const name of names) {
    if (!businessByName.has(name)) {
      throw new Error(`unknown business tool "${name}" (known: ${[...businessByName.keys()].join(', ')})`);
    }
  }
}

/** Build the registry for one agent: system tools plus its enabled business tools. */
export function buildToolRegistry(enabled: readonly string[]): ToolRegistry {
  const definitions = [...SYSTEM_TOOL_DEFINITIONS];
  const seen = new Set<string>();
  for (const name of enabled) {
    if (seen.has(name)) continue;
    seen.add(name);
    const definition = businessByName.get(name);
    if (definition === undefined) throw new Error(`unknown business tool "${name}"`);
    definitions.push(definition);
  }
  return new ToolRegistry(definitions);
}
