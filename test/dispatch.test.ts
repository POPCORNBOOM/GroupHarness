import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { Harness } from '../src/harness';
import { FakeTransport, demoMeta, makeRoot, writeFixture } from './helpers';

test('mention, sender type, self-exclusion, and one queue item per agent', async () => {
  const root = makeRoot();
  const meta = demoMeta();
  meta.members.push({ id: 'carol', type: 'agent' });
  meta.members.push({ id: 'dave', type: 'user' });
  meta.policies = [
    { agent: 'bob', trigger_mode: 'mention', sender_type: 'user', context_before: 1 },
    { agent: 'bob', trigger_mode: 'all', sender_type: 'user', context_before: 3 },
    { agent: 'carol', trigger_mode: 'all', sender_type: 'agent', context_before: 0 },
    { agent: 'bob', trigger_mode: 'all', sender_type: 'agent', context_before: 0 },
  ];
  writeFixture(root, { meta, agentLayers: { bob: { tools: [] }, carol: { tools: [] } } });
  const harness = await Harness.open({ rootDir: root, runtime: false, im: false });
  const group = harness.requireGroup('demo');

  group.send('alice', 'first', 'user_message', 'test');
  group.send('alice', 'second', 'user_message', 'test');
  group.store.takePending('bob').forEach((item) => group.store.markQueueStatus([item.id], 'done'));

  group.send('alice', '@bob third', 'user_message', 'test');
  const bobItems = group.store.takePending('bob');
  assert.equal(bobItems.length, 1);
  const payload = bobItems[0]?.payload as {
    trigger: { text: string };
    history: { text: string }[];
    context_before: number;
  };
  assert.equal(payload.trigger.text, '@bob third');
  assert.equal(payload.context_before, 3);
  assert.deepEqual(payload.history.map((line) => line.text), ['first', 'second']);
  group.store.markQueueStatus(bobItems.map((item) => item.id), 'done');

  group.send('bob', 'hello all', 'agent_message', 'test');
  assert.equal(group.store.takePending('carol').length, 1);
  assert.equal(group.store.takePending('bob').length, 0, 'an agent never dispatches its own message to itself');
  assert.equal(group.store.takePending('dave').length, 0, 'users are not dispatched through the queue');
  assert.throws(() => group.send('system', 'nope', 'system_restart', 'test'), /internal restart/);
  assert.throws(() => group.send('alice', 'wrong kind', 'agent_message', 'test'), /cannot send kind/);
  await harness.close();
});

test('user listen filters route group messages and restart bypasses them', async () => {
  const root = makeRoot();
  const meta = demoMeta();
  meta.members.push({ id: 'carol', type: 'user' });
  meta.members[0] = { id: 'alice', type: 'user', listen: { mode: 'blacklist', senders: ['bob'], kinds: [] } };
  meta.members.push({ id: 'dave', type: 'user', listen: { mode: 'whitelist', senders: [], kinds: ['agent_message'] } });
  meta.policies = [];
  writeFixture(root, { meta, agentLayers: { bob: { tools: [] } } });
  const harness = await Harness.open({ rootDir: root, runtime: false, im: false });
  const group = harness.requireGroup('demo');
  const alice = new FakeTransport();
  const carol = new FakeTransport();
  const dave = new FakeTransport();
  group.attachTransport('alice', alice);
  group.attachTransport('carol', carol);
  group.attachTransport('dave', dave);

  group.send('bob', 'agent speaking', 'agent_message', 'test');
  assert.equal(alice.messages.length, 0, 'bob is blacklisted for alice');
  assert.equal(carol.messages.length, 1);
  assert.equal(dave.messages.length, 1, 'whitelist matches agent_message');

  group.send('alice', 'user speaking', 'user_message', 'test');
  assert.equal(alice.messages.length, 0, 'sender is not echoed to itself');
  assert.equal(carol.messages.length, 2);
  assert.equal(dave.messages.length, 1, 'whitelist only accepts agent messages');

  group.deliverRestart();
  assert.equal(alice.messages.length, 1, 'restart bypasses listen filters');
  assert.equal(carol.messages.length, 3);
  assert.equal(dave.messages.length, 2);
  assert.equal(group.latestMessages(1)[0]?.kind, 'system_restart');
  await harness.close();
});

test('admin writes are audited and credentials are masked', async () => {
  const root = makeRoot();
  writeFixture(root, { meta: demoMeta(), agentLayers: { bob: { tools: [] } } });
  const harness = await Harness.open({ rootDir: root, runtime: false, im: false });
  const admin = harness.admin('demo');
  admin.setAgentConfig(
    { bypass_permission: true },
    'bob',
    { model: { apikey: 'sk-very-secret-key-123456' } },
  );
  await harness.audit.close();
  const auditText = readFileSync(root + '/.groupharness/audit.jsonl', 'utf8');
  assert.ok(auditText.includes('set_agent_config'));
  assert.ok(!auditText.includes('sk-very-secret-key-123456'));
  assert.ok(auditText.includes('sk-\u20263456'));
  await harness.close();
});

test('failed admin writes are audited with ok=false', async () => {
  const root = makeRoot();
  writeFixture(root, { meta: demoMeta(), agentLayers: { bob: { tools: [] } } });
  const harness = await Harness.open({ rootDir: root, runtime: false, im: false });
  assert.throws(
    () => harness.admin('demo').registerMember({ bypass_permission: true }, { id: 'alice', type: 'user' }),
    /already exists/,
  );
  await harness.audit.close();
  const auditText = readFileSync(root + '/.groupharness/audit.jsonl', 'utf8');
  assert.match(auditText, /"action":"member_register"/);
  assert.match(auditText, /"ok":false/);
  assert.match(auditText, /already exists/);
  await harness.close();
});

test('group meta config errors fail startup with the file path', async () => {
  const root = makeRoot();
  writeFixture(root, { meta: demoMeta(), agentLayers: { bob: { tools: [] } } });
  const metaPath = root + '/.groupharness/groups/demo/meta.toml';
  writeFileSync(metaPath, 'unknown_key = 1\n' + readFileSync(metaPath, 'utf8'));
  await assert.rejects(
    () => Harness.open({ rootDir: root, runtime: false, im: false }),
    (error: unknown) => /unknown key "unknown_key"/.test((error as Error).message),
  );
});
