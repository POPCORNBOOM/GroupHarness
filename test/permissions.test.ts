import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPermissionState, checkPermission, identityGroupsOf, SYSTEM_MEMBER } from '../src/permissions';

test('permissions resolve through identity groups, admins, and the system identity group', () => {
  const state = buildPermissionState(
    ['admin'],
    { core: ['alice'], crew: ['bob'], system: ['root'] },
    { manage_group: ['core'], read_private_task: ['crew'] },
  );
  assert.equal(checkPermission(state, 'admin', 'manage_group'), true, 'admins implicitly hold every permission');
  assert.equal(checkPermission(state, SYSTEM_MEMBER, 'manage_group'), true, 'the system pseudo-member is always allowed');
  assert.equal(checkPermission(state, 'root', 'manage_group'), true, 'membership in the system group is auto-allowed');
  assert.equal(checkPermission(state, 'alice', 'manage_group'), true);
  assert.equal(checkPermission(state, 'alice', 'read_private_task'), false);
  assert.equal(checkPermission(state, 'bob', 'read_private_task'), true);
  assert.equal(checkPermission(state, 'carol', 'read_private_task'), false);
  assert.deepEqual(identityGroupsOf(state, 'alice'), ['core']);
  assert.deepEqual(identityGroupsOf(state, 'carol'), []);
});

test('granting a permission to the system group does not grant it to outsiders', () => {
  const state = buildPermissionState([], { core: ['alice'], system: ['root'] }, { manage_group: ['system'] });
  assert.equal(checkPermission(state, 'root', 'manage_group'), true);
  assert.equal(checkPermission(state, 'alice', 'manage_group'), false);
});
