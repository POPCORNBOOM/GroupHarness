/**
 * Permission model: permissions bind to identity groups, members belong to
 * identity groups, admins implicitly hold everything (and are audited as
 * themselves), and the `system` pseudo-member is always allowed.
 */
export const PERMISSION_IDS = [
  'read_private_task',
  'set_member_permissions',
  'set_member_identity_groups',
  'set_member_listen_config',
  'manage_agent_config',
  'manage_group',
] as const;

export type PermissionId = (typeof PERMISSION_IDS)[number];

export interface PermissionState {
  admins: Set<string>;
  /** identity group key -> member ids */
  identityGroups: Map<string, Set<string>>;
  /** permission id -> identity group keys */
  permissionGroups: Map<string, Set<string>>;
}

export const SYSTEM_MEMBER = 'system';

export function isPermissionId(value: string): value is PermissionId {
  return (PERMISSION_IDS as readonly string[]).includes(value);
}

export function identityGroupsOf(state: PermissionState, memberId: string): string[] {
  const out: string[] = [];
  for (const [key, members] of state.identityGroups) {
    if (members.has(memberId)) out.push(key);
  }
  return out.sort();
}

/** True when any identity group the member belongs to holds the permission. */
export function checkPermission(state: PermissionState, memberId: string, permission: PermissionId): boolean {
  if (memberId === SYSTEM_MEMBER) return true;
  if (state.admins.has(memberId)) return true;
  const memberGroups = identityGroupsOf(state, memberId);
  // The built-in `system` identity group is auto-allowed; only system can edit it.
  if (memberGroups.includes('system')) return true;
  const groups = state.permissionGroups.get(permission);
  if (groups === undefined) return false;
  return memberGroups.some((key) => groups.has(key));
}

/** Build the lookup state from persisted meta fields. */
export function buildPermissionState(
  admins: readonly string[],
  identityGroups: Readonly<Record<string, readonly string[]>>,
  permissionGroups: Readonly<Record<string, readonly string[]>>,
): PermissionState {
  const groups = new Map<string, Set<string>>();
  for (const [key, members] of Object.entries(identityGroups)) {
    groups.set(key, new Set(members));
  }
  const permissions = new Map<string, Set<string>>();
  for (const [permission, keys] of Object.entries(permissionGroups)) {
    permissions.set(permission, new Set(keys));
  }
  return { admins: new Set(admins), identityGroups: groups, permissionGroups: permissions };
}
