/**
 * Administrative handle for one group. The harness constructs this next to the
 * group; tools and IM adapters never see it. Every call carries an explicit
 * `bypass_permission` guard, and every write (success or failure) is audited.
 */
import type { AuditLog } from './audit';
import type { AgentConfigLayer, FilePermission, ModelConfig, PathRule } from './config';
import type { Group } from './group';
import type { GroupMeta, ListenConfig, ResponsePolicy } from './meta';
import { isPermissionId, SYSTEM_MEMBER, type PermissionId } from './permissions';

export interface InternalGuard {
  bypass_permission: true;
}

export interface AgentConfigPatch {
  model?: Partial<ModelConfig>;
  tools?: string[];
  workingDirectory?: string;
  filePermission?: Partial<FilePermission>;
}

export interface GroupConfigPatch {
  model?: Partial<ModelConfig>;
  filePermission?: Partial<FilePermission>;
  workingDirectory?: string;
}

function assertInternal(guard: InternalGuard): void {
  if (guard.bypass_permission !== true) throw new Error('internal group API requires bypass_permission');
}

export class GroupAdmin {
  constructor(
    private readonly group: Group,
    private readonly audit: AuditLog,
  ) {}

  registerMember(guard: InternalGuard, input: { id: string; type: 'user' | 'agent' }): void {
    assertInternal(guard);
    const before = this.group.metaSnapshot();
    this.attempt('member_register', input.id, before.members, () => {
      const id = input.id.trim();
      if (id === '' || /[\s@]/.test(id)) throw new Error('member id must be non-empty and contain no whitespace or @');
      if (id === SYSTEM_MEMBER) throw new Error(`member id "${SYSTEM_MEMBER}" is reserved`);
      if (input.type !== 'user' && input.type !== 'agent') throw new Error('member type must be "user" or "agent"');
      if (before.members.some((member) => member.id === id)) throw new Error(`member "${id}" already exists`);
      const next = structuredClone(before);
      next.members.push({ id, type: input.type });
      this.group.replaceMeta(next);
      this.success('member_register', id, before.members, next.members);
    });
  }

  setAdmins(guard: InternalGuard, ids: string[]): void {
    assertInternal(guard);
    const before = this.group.metaSnapshot();
    this.attempt('set_admins', 'admins', before.admins, () => {
      for (const id of ids) {
        if (id === SYSTEM_MEMBER) throw new Error('system cannot be listed as an admin');
        if (!before.members.some((member) => member.id === id)) throw new Error(`"${id}" is not a member`);
      }
      const next = structuredClone(before);
      next.admins = [...new Set(ids)];
      this.group.replaceMeta(next);
      this.success('set_admins', 'admins', before.admins, next.admins);
    });
  }

  setIdentityGroups(guard: InternalGuard, memberId: string, groups: string[]): void {
    assertInternal(guard);
    const before = this.group.metaSnapshot();
    const beforeGroups = groupKeysFor(before, memberId);
    this.attempt('set_identity_groups', memberId, beforeGroups, () => {
      if (!before.members.some((member) => member.id === memberId)) {
        throw new Error(`"${memberId}" is not a member`);
      }
      for (const key of groups) {
        if (key.trim() === '' || /\s/.test(key)) {
          throw new Error('identity group keys must be non-empty and contain no whitespace');
        }
      }
      const next = structuredClone(before);
      for (const key of Object.keys(next.identity_groups)) {
        next.identity_groups[key] = (next.identity_groups[key] ?? []).filter((id) => id !== memberId);
      }
      for (const key of new Set(groups)) {
        const ids = next.identity_groups[key] ?? [];
        if (!ids.includes(memberId)) ids.push(memberId);
        next.identity_groups[key] = ids;
      }
      this.group.replaceMeta(next);
      this.success('set_identity_groups', memberId, beforeGroups, groups);
    });
  }

  setPermissionGroups(guard: InternalGuard, permission: PermissionId, groups: string[]): void {
    assertInternal(guard);
    const before = this.group.metaSnapshot();
    this.attempt('set_permission_groups', permission, before.permissions[permission], () => {
      if (!isPermissionId(permission)) throw new Error(`unknown permission "${permission}"`);
      for (const key of groups) {
        if (key.trim() === '') throw new Error('identity group keys must not be empty');
      }
      const next = structuredClone(before);
      next.permissions[permission] = [...new Set(groups)];
      this.group.replaceMeta(next);
      this.success('set_permission_groups', permission, before.permissions[permission], groups);
    });
  }

  setListen(guard: InternalGuard, memberId: string, listen: ListenConfig): void {
    assertInternal(guard);
    const before = this.group.metaSnapshot();
    const index = before.members.findIndex((member) => member.id === memberId);
    this.attempt('set_listen_config', memberId, before.members[index]?.listen, () => {
      if (index < 0) throw new Error(`"${memberId}" is not a member`);
      if (before.members[index]?.type !== 'user') throw new Error('listen config applies to user members');
      const next = structuredClone(before);
      next.members[index] = { ...next.members[index]!, listen: structuredClone(listen) };
      this.group.replaceMeta(next);
      this.success('set_listen_config', memberId, before.members[index]?.listen, listen);
    });
  }

  addPolicy(guard: InternalGuard, policy: ResponsePolicy): void {
    assertInternal(guard);
    const before = this.group.metaSnapshot();
    const beforePolicies = before.policies.filter((entry) => entry.agent === policy.agent);
    this.attempt('add_policy', policy.agent, beforePolicies, () => {
      if (!before.members.some((member) => member.id === policy.agent && member.type === 'agent')) {
        throw new Error(`"${policy.agent}" is not an agent member`);
      }
      if (policy.context_before < 0 || !Number.isSafeInteger(policy.context_before)) {
        throw new Error('context_before must be a non-negative integer');
      }
      const next = structuredClone(before);
      next.policies.push({ ...policy });
      this.group.replaceMeta(next);
      this.success(
        'add_policy',
        policy.agent,
        beforePolicies,
        next.policies.filter((entry) => entry.agent === policy.agent),
      );
    });
  }

  clearPolicies(guard: InternalGuard, agentId: string): void {
    assertInternal(guard);
    const before = this.group.metaSnapshot();
    const beforePolicies = before.policies.filter((policy) => policy.agent === agentId);
    this.attempt('clear_policies', agentId, beforePolicies, () => {
      const next = structuredClone(before);
      next.policies = next.policies.filter((policy) => policy.agent !== agentId);
      this.group.replaceMeta(next);
      this.success('clear_policies', agentId, beforePolicies, []);
    });
  }

  setAgentConfig(guard: InternalGuard, agentId: string, patch: AgentConfigPatch): void {
    assertInternal(guard);
    this.attempt('set_agent_config', agentId, undefined, () => {
      if (this.group.memberType(agentId) !== 'agent') throw new Error(`"${agentId}" is not an agent`);
      const before = this.group.readAgentLayer(agentId);
      const next = mergeAgentLayer(before, patch);
      this.group.writeAgentLayer(agentId, next);
      this.success('set_agent_config', agentId, before, next);
    });
  }

  setGroupConfig(guard: InternalGuard, patch: GroupConfigPatch): void {
    assertInternal(guard);
    const before = this.group.metaSnapshot();
    this.attempt('set_group_config', 'config', configLayers(before), () => {
      const next = structuredClone(before);
      if (patch.model !== undefined) {
        next.model = mergeModelLayer(before.model, patch.model);
        if (Object.keys(next.model).length === 0) delete next.model;
      }
      if (patch.filePermission !== undefined) {
        next.file_permission = mergePermissionLayer(before.file_permission, patch.filePermission);
        if (Object.keys(next.file_permission).length === 0) delete next.file_permission;
      }
      if (patch.workingDirectory !== undefined) {
        if (patch.workingDirectory === '') delete next.working_directory;
        else next.working_directory = patch.workingDirectory;
      }
      this.group.replaceMeta(next);
      this.success('set_group_config', 'config', configLayers(before), configLayers(next));
    });
  }

  reload(guard: InternalGuard): void {
    assertInternal(guard);
    this.group.reloadMeta();
  }

  private attempt(action: string, target: string, before: unknown, run: () => void): void {
    try {
      run();
    } catch (error) {
      this.audit.record({
        actor: 'tui',
        group_id: this.group.id,
        action,
        target,
        before,
        ok: false,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  private success(action: string, target: string, before: unknown, after: unknown): void {
    this.audit.record({
      actor: 'tui',
      group_id: this.group.id,
      action,
      target,
      before,
      after,
      ok: true,
    });
  }
}

function groupKeysFor(meta: GroupMeta, memberId: string): string[] {
  return Object.entries(meta.identity_groups)
    .filter(([, members]) => members.includes(memberId))
    .map(([key]) => key)
    .sort();
}

function mergeModelLayer(
  current: Partial<ModelConfig> | undefined,
  patch: Partial<ModelConfig>,
): Partial<ModelConfig> {
  const next: Partial<ModelConfig> = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(patch) as [keyof ModelConfig, ModelConfig[keyof ModelConfig]][]) {
    if (value === undefined) continue;
    if (value === '') delete next[key];
    else (next as Record<string, unknown>)[key] = value;
  }
  return next;
}

function mergePermissionLayer(
  current: Partial<FilePermission> | undefined,
  patch: Partial<FilePermission>,
): Partial<FilePermission> {
  const next: Partial<FilePermission> = structuredClone(current ?? {});
  if (patch.default !== undefined) {
    if (patch.default === 'inherit') delete next.default;
    else next.default = patch.default;
  }
  for (const key of ['read', 'write', 'execute', 'deny'] as const) {
    const value = patch[key] as PathRule | string[] | undefined;
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) delete next[key];
    else (next as Record<string, unknown>)[key] = Array.isArray(value) ? [...value] : value;
  }
  return next;
}

function mergeAgentLayer(current: AgentConfigLayer, patch: AgentConfigPatch): AgentConfigLayer {
  const next: AgentConfigLayer = structuredClone(current);
  if (patch.model !== undefined) {
    const model = mergeModelLayer(next.model, patch.model);
    if (Object.keys(model).length === 0) delete next.model;
    else next.model = model;
  }
  if (patch.tools !== undefined) next.tools = [...new Set(patch.tools)];
  if (patch.workingDirectory !== undefined) {
    if (patch.workingDirectory === '') delete next.working_directory;
    else next.working_directory = patch.workingDirectory;
  }
  if (patch.filePermission !== undefined) {
    const permission = mergePermissionLayer(next.file_permission, patch.filePermission);
    if (Object.keys(permission).length === 0) delete next.file_permission;
    else next.file_permission = permission;
  }
  return next;
}

function configLayers(meta: GroupMeta): Record<string, unknown> {
  return {
    model: meta.model ?? {},
    filePermission: meta.file_permission ?? {},
    workingDirectory: meta.working_directory ?? '',
  };
}
