/**
 * Group metadata (`meta.toml`): members, admins, identity groups, permission
 * bindings, response policies, listens, and group-level config overrides.
 * Validation is strict; a typo is a startup error with the file path.
 */
import {
  assertKnownKeys,
  ConfigError,
  parseConfigLayer,
  readTomlFile,
  stringifyTomlSafe,
  writeTomlFile,
  type AgentConfigLayer,
  type FilePermission,
  type ModelConfig,
} from './config';
import { isPermissionId, type PermissionId } from './permissions';
import type { MessageKind } from './storage';

export type TriggerMode = 'mention' | 'all';
export type SenderType = 'user' | 'agent' | 'all';
export type ListenMode = 'all' | 'blacklist' | 'whitelist';

export interface ListenConfig {
  mode: ListenMode;
  senders: string[];
  kinds: MessageKind[];
}

export interface MemberMeta {
  id: string;
  type: 'user' | 'agent';
  listen?: ListenConfig;
}

export interface ResponsePolicy {
  agent: string;
  trigger_mode: TriggerMode;
  sender_type: SenderType;
  /** How many group messages before the trigger are included. */
  context_before: number;
}

export interface GroupMeta {
  name: string;
  admins: string[];
  members: MemberMeta[];
  identity_groups: Record<string, string[]>;
  permissions: Partial<Record<PermissionId, string[]>>;
  policies: ResponsePolicy[];
  model?: Partial<ModelConfig>;
  file_permission?: Partial<FilePermission>;
  working_directory?: string;
}

const MESSAGE_KINDS: MessageKind[] = ['user_message', 'agent_message', 'system_restart'];

function fail(path: string, message: string): never {
  throw new ConfigError(path, message);
}

function stringArray(path: string, value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    fail(path, `${field} must be an array of non-empty strings`);
  }
  return value as string[];
}

function parseListen(path: string, raw: unknown, field: string): ListenConfig | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail(path, `${field} must be a table`);
  const table = raw as Record<string, unknown>;
  assertKnownKeys(path, table, ['mode', 'senders', 'kinds'], `${field}.`);
  const mode = table.mode ?? 'all';
  if (mode !== 'all' && mode !== 'blacklist' && mode !== 'whitelist') {
    fail(path, `${field}.mode must be "all", "blacklist", or "whitelist"`);
  }
  const senders = table.senders === undefined ? [] : stringArray(path, table.senders, `${field}.senders`);
  const kindsRaw = table.kinds === undefined ? [] : stringArray(path, table.kinds, `${field}.kinds`);
  for (const kind of kindsRaw) {
    if (!MESSAGE_KINDS.includes(kind as MessageKind)) {
      fail(path, `${field}.kinds contains unknown message kind "${kind}"`);
    }
  }
  return { mode, senders, kinds: kindsRaw as MessageKind[] };
}

function parseMembers(path: string, raw: unknown): MemberMeta[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail(path, 'members must be an array of tables');
  const out: MemberMeta[] = [];
  const seen = new Set<string>();
  for (const entry of raw as unknown[]) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(path, 'every member must be a table');
    }
    const table = entry as Record<string, unknown>;
    assertKnownKeys(path, table, ['id', 'type', 'listen'], 'members[].');
    const id = table.id;
    if (typeof id !== 'string' || id.length === 0) fail(path, 'member id must be a non-empty string');
    if (id === 'system') fail(path, 'member id "system" is reserved');
    if (/[\s@]/.test(id)) fail(path, `member id "${id}" must not contain whitespace or @`);
    if (seen.has(id)) fail(path, `duplicate member id "${id}"`);
    seen.add(id);
    if (table.type !== 'user' && table.type !== 'agent') {
      fail(path, `member "${id}" type must be "user" or "agent"`);
    }
    const listen = parseListen(path, table.listen, `members.${id}.listen`);
    out.push({ id, type: table.type, ...(listen === undefined ? {} : { listen }) });
  }
  return out;
}

function parseIdentityGroups(
  path: string,
  raw: unknown,
  members: readonly MemberMeta[],
): Record<string, string[]> {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail(path, 'identity_groups must be a table');
  const out: Record<string, string[]> = {};
  const memberIds = new Set(members.map((member) => member.id));
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.length === 0) fail(path, 'identity group keys must not be empty');
    const ids = stringArray(path, value, `identity_groups.${key}`);
    for (const id of ids) {
      if (id !== 'system' && !memberIds.has(id)) {
        fail(path, `identity_groups.${key} references unknown member "${id}"`);
      }
    }
    out[key] = ids;
  }
  return out;
}

function parsePermissions(path: string, raw: unknown): Partial<Record<PermissionId, string[]>> {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail(path, 'permissions must be a table');
  const out: Partial<Record<PermissionId, string[]>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isPermissionId(key)) fail(path, `unknown permission "${key}"`);
    out[key] = stringArray(path, value, `permissions.${key}`);
  }
  return out;
}

function parsePolicies(path: string, raw: unknown, members: readonly MemberMeta[]): ResponsePolicy[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail(path, 'policies must be an array of tables');
  const agents = new Set(members.filter((member) => member.type === 'agent').map((member) => member.id));
  const out: ResponsePolicy[] = [];
  for (const entry of raw as unknown[]) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(path, 'every policy must be a table');
    }
    const table = entry as Record<string, unknown>;
    assertKnownKeys(path, table, ['agent', 'trigger_mode', 'sender_type', 'context_before'], 'policies[].');
    const agent = table.agent;
    if (typeof agent !== 'string' || !agents.has(agent)) {
      fail(path, `policy agent must be an agent member (got "${String(agent)}")`);
    }
    const trigger = table.trigger_mode ?? 'mention';
    if (trigger !== 'mention' && trigger !== 'all') fail(path, 'policy trigger_mode must be "mention" or "all"');
    const sender = table.sender_type ?? 'all';
    if (sender !== 'user' && sender !== 'agent' && sender !== 'all') {
      fail(path, 'policy sender_type must be "user", "agent", or "all"');
    }
    const context = table.context_before ?? 0;
    if (typeof context !== 'number' || !Number.isSafeInteger(context) || context < 0) {
      fail(path, 'policy context_before must be a non-negative integer');
    }
    out.push({ agent, trigger_mode: trigger, sender_type: sender, context_before: context });
  }
  return out;
}

/** Validate a parsed meta object. */
export function parseGroupMeta(path: string, raw: Record<string, unknown>, groupId: string): GroupMeta {
  assertKnownKeys(path, raw, [
    'name',
    'admins',
    'members',
    'identity_groups',
    'permissions',
    'policies',
    'model',
    'file_permission',
    'working_directory',
  ]);
  const members = parseMembers(path, raw.members);
  const memberIds = new Set(members.map((member) => member.id));
  const admins = raw.admins === undefined ? [] : stringArray(path, raw.admins, 'admins');
  for (const admin of admins) {
    if (admin === 'system' || !memberIds.has(admin)) fail(path, `admin "${admin}" is not a member`);
  }
  const layer = parseConfigLayer(path, {
    model: raw.model,
    file_permission: raw.file_permission,
    working_directory: raw.working_directory,
  });
  const name = raw.name === undefined ? groupId : raw.name;
  if (typeof name !== 'string' || name.length === 0) fail(path, 'name must be a non-empty string');
  return {
    name,
    admins,
    members,
    identity_groups: parseIdentityGroups(path, raw.identity_groups, members),
    permissions: parsePermissions(path, raw.permissions),
    policies: parsePolicies(path, raw.policies, members),
    ...(layer.model === undefined ? {} : { model: layer.model }),
    ...(layer.file_permission === undefined ? {} : { file_permission: layer.file_permission }),
    ...(layer.working_directory === undefined ? {} : { working_directory: layer.working_directory }),
  };
}

/** Serialize a meta object to TOML text (used for atomic validated writes). */
export function serializeGroupMeta(meta: GroupMeta): string {
  return stringifyTomlSafe(toTomlObject(meta));
}

/** Load and validate a group's meta.toml. */
export function loadGroupMeta(path: string, groupId: string): GroupMeta {
  return parseGroupMeta(path, readTomlFile(path), groupId);
}

function toTomlObject(meta: GroupMeta): Record<string, unknown> {
  const object: Record<string, unknown> = {
    name: meta.name,
    admins: meta.admins,
    members: meta.members.map((member) => ({
      id: member.id,
      type: member.type,
      ...(member.listen === undefined
        ? {}
        : {
            listen: {
              mode: member.listen.mode,
              ...(member.listen.senders.length > 0 ? { senders: member.listen.senders } : {}),
              ...(member.listen.kinds.length > 0 ? { kinds: member.listen.kinds } : {}),
            },
          }),
    })),
    identity_groups: meta.identity_groups,
    permissions: meta.permissions,
    policies: meta.policies,
  };
  if (meta.model !== undefined) object.model = meta.model;
  if (meta.file_permission !== undefined) object.file_permission = meta.file_permission;
  if (meta.working_directory !== undefined) object.working_directory = meta.working_directory;
  return object;
}

/** Persist a validated meta object. */
export function saveGroupMeta(path: string, meta: GroupMeta): void {
  writeTomlFile(path, toTomlObject(meta));
}

/** A fresh group with no members and no overrides. */
export function emptyGroupMeta(name: string): GroupMeta {
  return {
    name,
    admins: [],
    members: [],
    identity_groups: {},
    permissions: {},
    policies: [],
  };
}

/** The config layer a group contributes to the fallback chain. */
export function groupConfigLayer(meta: GroupMeta): AgentConfigLayer {
  return {
    ...(meta.model === undefined ? {} : { model: meta.model }),
    ...(meta.file_permission === undefined ? {} : { file_permission: meta.file_permission }),
    ...(meta.working_directory === undefined ? {} : { working_directory: meta.working_directory }),
  };
}
