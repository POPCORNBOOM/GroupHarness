/**
 * Console commands shared by the TUI command bar and the one-shot CLI. The
 * console is a control plane: it never sends chat messages, so every command
 * here is a read or an audited administrative write.
 */
import type { FilePermission, ModelConfig, PathRule } from './config';
import type { Harness } from './harness';
import type { GroupView } from './group';
import type { AgentConfigPatch, GroupConfigPatch } from './group-admin';
import { PERMISSION_IDS, isPermissionId } from './permissions';
import type { ListenConfig } from './meta';
import type { SearchOptions } from './storage';

export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandError';
  }
}

const MODEL_KEYS = [
  'format',
  'baseurl',
  'apikey',
  'model',
  'reasoning_effort',
  'context_window',
  'max_output_tokens',
] as const;

const PERMISSION_KEYS = ['default', 'read', 'write', 'execute', 'deny'] as const;

/** Split a command line, honoring single and double quotes. */
export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: string | undefined;
  let hasCurrent = false;
  for (const char of line) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else current += char;
      hasCurrent = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasCurrent = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (hasCurrent) {
        tokens.push(current);
        current = '';
        hasCurrent = false;
      }
      continue;
    }
    current += char;
    hasCurrent = true;
  }
  if (quote !== undefined) throw new CommandError('unterminated quote');
  if (hasCurrent) tokens.push(current);
  return tokens;
}

function parseInteger(value: string, field: string, min = 1): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    throw new CommandError(`${field} must be an integer >= ${min}`);
  }
  return parsed;
}

function parseList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

function parsePermissionValue(key: (typeof PERMISSION_KEYS)[number], value: string): PathRule | 'inherit' {
  if (key === 'default') {
    if (value !== 'inherit' && value !== 'deny_all') {
      throw new CommandError('default must be "inherit" or "deny_all"');
    }
    return value;
  }
  if (value === 'deny_all') return 'deny_all';
  return parseList(value);
}

function parseModelValue(key: (typeof MODEL_KEYS)[number], value: string): string | number {
  if (key === 'format') {
    if (value !== 'completion' && value !== 'anthropic') {
      throw new CommandError('format must be "completion" or "anthropic"');
    }
    return value;
  }
  if (key === 'context_window' || key === 'max_output_tokens') return parseInteger(value, key);
  return value;
}

function applyConfigToken(patch: { model?: Partial<ModelConfig>; filePermission?: Partial<FilePermission>; workingDirectory?: string }, token: string): void {
  const split = token.indexOf('=');
  if (split <= 0) throw new CommandError(`expected key=value, got "${token}"`);
  const key = token.slice(0, split);
  const value = token.slice(split + 1);
  if ((MODEL_KEYS as readonly string[]).includes(key)) {
    const model = patch.model ?? {};
    (model as Record<string, unknown>)[key] = parseModelValue(key as (typeof MODEL_KEYS)[number], value);
    patch.model = model;
    return;
  }
  if (key === 'dir' || key === 'working_directory') {
    patch.workingDirectory = value;
    return;
  }
  if ((PERMISSION_KEYS as readonly string[]).includes(key)) {
    const permission = patch.filePermission ?? {};
    (permission as Record<string, unknown>)[key] = parsePermissionValue(
      key as (typeof PERMISSION_KEYS)[number],
      value,
    );
    patch.filePermission = permission;
    return;
  }
  throw new CommandError(`unknown config key "${key}"`);
}

function formatListen(listen: ListenConfig | undefined): string {
  if (listen === undefined) return 'all';
  const parts: string[] = [listen.mode];
  if (listen.senders.length > 0) parts.push(`senders=${listen.senders.join(',')}`);
  if (listen.kinds.length > 0) parts.push(`kinds=${listen.kinds.join(',')}`);
  return parts.join(' ');
}

function formatPermissions(permission: FilePermission): string {
  const rule = (value: PathRule | undefined): string =>
    value === 'deny_all'
      ? 'deny_all'
      : value === undefined || value.length === 0
        ? permission.default
        : value.join(',');
  const parts = [`read=${rule(permission.read)}`, `write=${rule(permission.write)}`, `execute=${rule(permission.execute)}`];
  if (permission.deny !== undefined && permission.deny.length > 0) parts.push(`deny=${permission.deny.join(',')}`);
  return parts.join(' ');
}

export function formatGroupView(group: GroupView): string {
  const lines: string[] = [];
  lines.push(`group ${group.id} — ${group.name}`);
  lines.push(`admins: ${group.admins.length === 0 ? '(none)' : group.admins.join(', ')}`);
  lines.push('members:');
  for (const member of group.members) {
    const bits = [`${member.id} (${member.type})`];
    bits.push(`groups=${member.identityGroups.length === 0 ? '-' : member.identityGroups.join(',')}`);
    if (member.type === 'user') bits.push(`listen=${formatListen(member.listen)}`);
    if (member.admin) bits.push('admin');
    lines.push('  ' + bits.join(' '));
  }
  if (group.members.length === 0) lines.push('  (empty)');
  lines.push('identity groups:');
  const groupNames = Object.keys(group.identityGroups).sort();
  if (groupNames.length === 0) lines.push('  (none)');
  for (const key of groupNames) {
    lines.push(`  ${key}: ${group.identityGroups[key]?.join(', ') ?? ''}`);
  }
  lines.push('permissions:');
  for (const permission of PERMISSION_IDS) {
    const groups = group.permissions[permission];
    lines.push(`  ${permission}: ${groups === undefined || groups.length === 0 ? '(none)' : groups.join(', ')}`);
  }
  lines.push('policies:');
  if (group.policies.length === 0) lines.push('  (none)');
  for (const policy of group.policies) {
    lines.push(
      `  ${policy.agent}: trigger=${policy.trigger_mode} sender=${policy.sender_type} context_before=${policy.context_before}`,
    );
  }
  lines.push(
    `model: ${group.model.format} ${group.model.model || '(unset)'} baseurl=${group.model.baseurl || '(unset)'} apikey=${group.model.apikey || '(unset)'}`,
  );
  lines.push(`working_directory: ${group.workingDirectory}`);
  lines.push(`file_permission: ${formatPermissions(group.filePermission)}`);
  return lines.join('\n');
}

function shorten(text: string, max = 160): string {
  const single = text.replaceAll('\n', ' \\n ');
  return single.length <= max ? single : single.slice(0, max) + '…';
}

export const HELP_TEXT = `commands:
  groups                          list groups
  group <group>                   show a group
  create <group> [name...]        create a group
  member-add <group> <id> <user|agent>
  admins <group> [member...]      set admins
  identity <group> <member> [groupKey...]   set identity groups
  permission <group> <permission> [groupKey...]
  listen <group> <user> <all|blacklist|whitelist> [senders=a,b] [kinds=user_message,...]
  policy-add <group> <agent> <mention|all> <user|agent|all> [context_before]
  policy-clear <group> <agent>
  agent <group> <agent>           show resolved agent config
  agent-set <group> <agent> key=value...   (model fields, tools, dir, read/write/execute/deny/default)
  group-set <group> key=value...
  messages <group> [limit]        newest chat messages
  search <group> <query> [since=ISO] [until=ISO] [limit=N] [cursor=N]
  tasks <group> [limit]           task summaries
  task <group> <task_id>          task detail (private reads audited)
  reload                          re-read config.toml and meta.toml
  help`;

export async function runCommand(harness: Harness, line: string): Promise<string> {
  const tokens = tokenize(line.trim());
  const [command, ...args] = tokens;
  if (command === undefined || command === '') return '';
  switch (command) {
    case 'help':
      return HELP_TEXT;
    case 'groups': {
      const groups = harness.listGroups();
      if (groups.length === 0) return 'no groups; use "create <group>"';
      return groups
        .map((group) => {
          const view = group.view();
          const users = view.members.filter((member) => member.type === 'user').length;
          const agents = view.members.length - users;
          return `${view.id}\t${view.name}\tmembers=${view.members.length} (users=${users}, agents=${agents})\tpolicies=${view.policies.length}`;
        })
        .join('\n');
    }
    case 'group': {
      const groupId = args[0];
      if (groupId === undefined) throw new CommandError('usage: group <group>');
      return formatGroupView(harness.requireGroup(groupId).view());
    }
    case 'create': {
      const groupId = args[0];
      if (groupId === undefined) throw new CommandError('usage: create <group> [name...]');
      const name = args.slice(1).join(' ') || groupId;
      const group = harness.createGroup(groupId, name);
      return `created group ${group.id} at ${group.dir}`;
    }
    case 'member-add': {
      const [groupId, memberId, type] = args;
      if (groupId === undefined || memberId === undefined || (type !== 'user' && type !== 'agent')) {
        throw new CommandError('usage: member-add <group> <id> <user|agent>');
      }
      harness.admin(groupId).registerMember(guard(), { id: memberId, type });
      return `added ${type} ${memberId} to ${groupId}`;
    }
    case 'admins': {
      const [groupId, ...members] = args;
      if (groupId === undefined) throw new CommandError('usage: admins <group> [member...]');
      harness.admin(groupId).setAdmins(guard(), members);
      return `admins for ${groupId}: ${members.length === 0 ? '(none)' : members.join(', ')}`;
    }
    case 'identity': {
      const [groupId, memberId, ...groups] = args;
      if (groupId === undefined || memberId === undefined) {
        throw new CommandError('usage: identity <group> <member> [groupKey...]');
      }
      harness.admin(groupId).setIdentityGroups(guard(), memberId, groups);
      return `identity groups for ${memberId}: ${groups.length === 0 ? '(none)' : groups.join(', ')}`;
    }
    case 'permission': {
      const [groupId, permission, ...groups] = args;
      if (groupId === undefined || permission === undefined) {
        throw new CommandError(`usage: permission <group> <${PERMISSION_IDS.join('|')}> [groupKey...]`);
      }
      if (!isPermissionId(permission)) throw new CommandError(`unknown permission "${permission}"`);
      harness.admin(groupId).setPermissionGroups(guard(), permission, groups);
      return `${permission} granted to: ${groups.length === 0 ? '(none)' : groups.join(', ')}`;
    }
    case 'listen': {
      const [groupId, memberId, mode, ...rest] = args;
      if (
        groupId === undefined ||
        memberId === undefined ||
        (mode !== 'all' && mode !== 'blacklist' && mode !== 'whitelist')
      ) {
        throw new CommandError('usage: listen <group> <user> <all|blacklist|whitelist> [senders=a,b] [kinds=...]');
      }
      const listen: ListenConfig = { mode, senders: [], kinds: [] };
      for (const token of rest) {
        const [key, value = ''] = token.split('=', 2);
        if (key === 'senders') listen.senders = parseList(value);
        else if (key === 'kinds') {
          const kinds = parseList(value);
          if (kinds.some((kind) => kind !== 'user_message' && kind !== 'agent_message' && kind !== 'system_restart')) {
            throw new CommandError('kinds must be user_message, agent_message, or system_restart');
          }
          listen.kinds = kinds as ListenConfig['kinds'];
        } else {
          throw new CommandError(`unknown listen option "${key}"`);
        }
      }
      harness.admin(groupId).setListen(guard(), memberId, listen);
      return `listen for ${memberId}: ${formatListen(listen)}`;
    }
    case 'policy-add': {
      const [groupId, agentId, trigger, sender, contextRaw] = args;
      if (
        groupId === undefined ||
        agentId === undefined ||
        (trigger !== 'mention' && trigger !== 'all') ||
        (sender !== 'user' && sender !== 'agent' && sender !== 'all')
      ) {
        throw new CommandError('usage: policy-add <group> <agent> <mention|all> <user|agent|all> [context_before]');
      }
      const context = contextRaw === undefined ? 0 : parseInteger(contextRaw, 'context_before', 0);
      harness.admin(groupId).addPolicy(guard(), {
        agent: agentId,
        trigger_mode: trigger,
        sender_type: sender,
        context_before: context,
      });
      return `policy added for ${agentId}`;
    }
    case 'policy-clear': {
      const [groupId, agentId] = args;
      if (groupId === undefined || agentId === undefined) throw new CommandError('usage: policy-clear <group> <agent>');
      harness.admin(groupId).clearPolicies(guard(), agentId);
      return `policies cleared for ${agentId}`;
    }
    case 'agent': {
      const [groupId, agentId] = args;
      if (groupId === undefined || agentId === undefined) throw new CommandError('usage: agent <group> <agent>');
      const view = harness.requireGroup(groupId).agentView(agentId);
      if (view === undefined) throw new CommandError(`"${agentId}" is not an agent in "${groupId}"`);
      return [
        `agent ${view.id} in ${groupId}`,
        `model: ${view.model.format} ${view.model.model || '(unset)'} baseurl=${view.model.baseurl || '(unset)'} apikey=${view.model.apikey || '(unset)'}`,
        `tools: ${view.tools.length === 0 ? '(system only)' : view.tools.join(', ')}`,
        `working_directory: ${view.workingDirectory}`,
        `file_permission: ${formatPermissions(view.filePermission)}`,
      ].join('\n');
    }
    case 'agent-set': {
      const [groupId, agentId, ...pairs] = args;
      if (groupId === undefined || agentId === undefined || pairs.length === 0) {
        throw new CommandError('usage: agent-set <group> <agent> key=value...');
      }
      const patch: AgentConfigPatch = {};
      for (const token of pairs) {
        if (token.startsWith('tools=')) {
          patch.tools = parseList(token.slice('tools='.length));
          continue;
        }
        applyConfigToken(patch, token);
      }
      harness.admin(groupId).setAgentConfig(guard(), agentId, patch);
      return `updated agent ${agentId} in ${groupId}`;
    }
    case 'group-set': {
      const [groupId, ...pairs] = args;
      if (groupId === undefined || pairs.length === 0) throw new CommandError('usage: group-set <group> key=value...');
      const patch: GroupConfigPatch = {};
      for (const token of pairs) applyConfigToken(patch, token);
      harness.admin(groupId).setGroupConfig(guard(), patch);
      return `updated group ${groupId}`;
    }
    case 'messages': {
      const [groupId, limitRaw] = args;
      if (groupId === undefined) throw new CommandError('usage: messages <group> [limit]');
      const limit = limitRaw === undefined ? 20 : Math.min(parseInteger(limitRaw, 'limit'), 100);
      const messages = harness.requireGroup(groupId).latestMessages(limit);
      if (messages.length === 0) return 'no messages';
      return messages
        .map((message) => `#${message.id} ${message.sender_id} [${message.kind}] ${shorten(message.text)}`)
        .join('\n');
    }
    case 'search': {
      const [groupId, ...rest] = args;
      if (groupId === undefined || rest.length === 0) {
        throw new CommandError('usage: search <group> <query> [since=ISO] [until=ISO] [limit=N] [cursor=N]');
      }
      const options: SearchOptions = { query: '' };
      const words: string[] = [];
      for (const token of rest) {
        const split = token.indexOf('=');
        if (split > 0 && ['since', 'until', 'limit', 'cursor'].includes(token.slice(0, split))) {
          const key = token.slice(0, split);
          const value = token.slice(split + 1);
          if (key === 'since' || key === 'until') {
            if (Number.isNaN(Date.parse(value))) throw new CommandError(`${key} must be an ISO8601 date`);
            options[key] = value;
          } else if (key === 'limit') {
            options.limit = parseInteger(value, 'limit');
          } else {
            options.cursor = parseInteger(value, 'cursor', 0);
          }
        } else {
          words.push(token);
        }
      }
      options.query = words.join(' ');
      if (options.query.trim() === '') throw new CommandError('search query must not be empty');
      const page = harness.requireGroup(groupId).consoleSearch(options);
      const lines = page.messages.map(
        (message) => `#${message.id} ${message.sender_id} [${message.kind}] ${shorten(message.text)}`,
      );
      if (lines.length === 0) lines.push('no matches');
      if (page.nextCursor !== null) lines.push(`next_cursor=${page.nextCursor}`);
      return lines.join('\n');
    }
    case 'tasks': {
      const [groupId, limitRaw] = args;
      if (groupId === undefined) throw new CommandError('usage: tasks <group> [limit]');
      const limit = limitRaw === undefined ? 20 : Math.min(parseInteger(limitRaw, 'limit'), 200);
      const tasks = harness.requireGroup(groupId).adminTasks(limit);
      if (tasks.length === 0) return 'no tasks';
      return tasks
        .map(
          (task) =>
            `${task.taskId} ${task.tooltype} [${task.status}] visibility=${task.visibility} publisher=${task.publisherId} created=${task.createdAt}`,
        )
        .join('\n');
    }
    case 'task': {
      const [groupId, taskId] = args;
      if (groupId === undefined || taskId === undefined) throw new CommandError('usage: task <group> <task_id>');
      const task = harness.requireGroup(groupId).adminTaskDetail(taskId);
      if (task === undefined) throw new CommandError(`no task "${taskId}"`);
      return JSON.stringify(task, null, 2);
    }
    case 'reload': {
      harness.reload();
      return 'config reloaded; agents pick it up after their current loop';
    }
    default:
      throw new CommandError(`unknown command "${command}"; try help`);
  }
}

function guard(): { bypass_permission: true } {
  return { bypass_permission: true };
}
