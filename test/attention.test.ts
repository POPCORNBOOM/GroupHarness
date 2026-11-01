import assert from 'node:assert/strict';
import test from 'node:test';
import { Harness } from '../src/harness';
import { demoMeta, makeRoot, writeFixture } from './helpers';

const GUARD = { bypass_permission: true } as const;

test('member attention wakes an agent without a mention', async () => {
  const root = makeRoot();
  writeFixture(root, { meta: demoMeta(), agentLayers: { bob: { tools: [] } } });
  const harness = await Harness.open({ rootDir: root, runtime: false, im: false });
  const group = harness.requireGroup('demo');
  const view = group.agentApi('bob').sendWithAttention('watching alice', {
    members: ['alice'],
    ttl_ms: 5_000,
  });
  assert.ok(view.attention);
  assert.equal(view.attention?.members[0], 'alice');
  group.send('alice', 'no mention here', 'user_message', 'test');
  const pending = group.store.takePending('bob');
  assert.equal(pending.length, 1);
  assert.equal((pending[0]!.payload as { kind: string }).kind, 'chat');
  const payload = pending[0]!.payload as { trigger: { text: string }; history: unknown[]; context_before: number };
  assert.equal(payload.trigger.text, 'no mention here');
  assert.deepEqual(payload.history, []);
  assert.equal(payload.context_before, 0);
  await harness.close();
});

test('identity group attention expands live and can be cleared', async () => {
  const root = makeRoot();
  writeFixture(root, { meta: demoMeta(), agentLayers: { bob: { tools: [] } } });
  const harness = await Harness.open({ rootDir: root, runtime: false, im: false });
  const group = harness.requireGroup('demo');
  harness.admin('demo').setIdentityGroups(GUARD, 'alice', ['core', 'crew']);
  group.agentApi('bob').sendWithAttention('watching crew', { groups: ['crew'], ttl_ms: 5_000 });
  group.send('alice', 'crew message', 'user_message', 'test');
  assert.equal(group.store.takePending('bob').length, 1);
  group.agentApi('bob').sendWithAttention('clear', {});
  group.send('alice', 'after clear', 'user_message', 'test');
  assert.equal(group.store.takePending('bob').length, 0);
  await harness.close();
});

test('attention supports agent senders, rejects self, and rejects unknown scopes', async () => {
  const root = makeRoot();
  const meta = demoMeta();
  meta.members.push({ id: 'carol', type: 'agent' });
  writeFixture(root, { meta, agentLayers: { bob: { tools: [] }, carol: { tools: [] } } });
  const harness = await Harness.open({ rootDir: root, runtime: false, im: false });
  const group = harness.requireGroup('demo');
  const api = group.agentApi('bob');
  assert.throws(() => api.sendWithAttention('self', { members: ['bob'] }), /yourself/);
  assert.throws(() => api.sendWithAttention('unknown', { members: ['nobody'] }), /unknown member/);
  assert.throws(() => api.sendWithAttention('unknown', { groups: ['nope'] }), /unknown identity group/);
  api.sendWithAttention('watching carol', { members: ['carol'], ttl_ms: 5_000 });
  group.send('carol', 'agent to agent', 'agent_message', 'test');
  assert.equal(group.store.takePending('bob').length, 1);
  await harness.close();
});

test('attention expires back to policy-only routing', async () => {
  const root = makeRoot();
  writeFixture(root, { meta: demoMeta(), agentLayers: { bob: { tools: [] } } });
  const harness = await Harness.open({ rootDir: root, runtime: false, im: false });
  const group = harness.requireGroup('demo');
  group.agentApi('bob').sendWithAttention('short', { members: ['alice'], ttl_ms: 1 });
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  group.send('alice', 'after expiry', 'user_message', 'test');
  assert.equal(group.store.takePending('bob').length, 0);
  await harness.close();
});
