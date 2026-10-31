import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CommandError, runCommand, tokenize } from '../src/commands';
import { Harness } from '../src/harness';
import { demoMeta, makeRoot, writeFixture } from './helpers';

test('tokenizer keeps quoted arguments together and rejects unterminated quotes', () => {
  assert.deepEqual(tokenize('group demo'), ['group', 'demo']);
  assert.deepEqual(tokenize('create demo "My Demo Group"'), ['create', 'demo', 'My Demo Group']);
  assert.deepEqual(tokenize("policy-add demo bob mention user 3"), ['policy-add', 'demo', 'bob', 'mention', 'user', '3']);
  assert.throws(() => tokenize('create demo "oops'), (error: unknown) => error instanceof CommandError);
});

test('console commands manage a group end to end', async () => {
  const root = makeRoot();
  writeFixture(root, { meta: demoMeta(), agentLayers: { bob: { tools: [] } } });
  const harness = await Harness.open({ rootDir: root, runtime: false, im: false });

  assert.match(await runCommand(harness, 'create second "Second Group"'), /created group second/);
  assert.match(await runCommand(harness, 'member-add second alice user'), /added user alice/);
  assert.match(await runCommand(harness, 'member-add second bob agent'), /added agent bob/);
  await runCommand(harness, 'admins second alice');
  await runCommand(harness, 'identity second alice core');
  await runCommand(harness, 'permission second manage_group core');

  const groups = await runCommand(harness, 'groups');
  assert.match(groups, /demo/);
  assert.match(groups, /second/);

  await runCommand(harness, 'agent-set demo bob apikey=sk-secret-12345 model=model-x dir=work tools=read_file');
  const agentView = await runCommand(harness, 'agent demo bob');
  assert.match(agentView, /model-x/);
  assert.match(agentView, /sk-…2345/);
  assert.doesNotMatch(agentView, /sk-secret-12345/);
  assert.match(agentView, /read_file/);

  await runCommand(harness, 'group-set demo read=/tmp/write-space');
  const groupView = await runCommand(harness, 'group demo');
  assert.match(groupView, /file_permission: read=\/tmp\/write-space/);

  await runCommand(harness, 'listen demo alice whitelist senders=bob kinds=agent_message');
  const listened = await runCommand(harness, 'group demo');
  assert.match(listened, /listen=whitelist senders=bob kinds=agent_message/);

  await runCommand(harness, 'policy-clear demo bob');
  assert.match(await runCommand(harness, 'group demo'), /policies:\n  \(none\)/);

  harness.requireGroup('demo').send('alice', 'hello console', 'user_message', 'test');
  assert.match(await runCommand(harness, 'messages demo'), /hello console/);
  assert.match(await runCommand(harness, 'search demo hello'), /hello console/);
  assert.match(await runCommand(harness, 'tasks demo'), /no tasks/);
  assert.match(await runCommand(harness, 'reload'), /config reloaded/);

  assert.match(await runCommand(harness, 'help'), /policy-add/);
  await assert.rejects(() => runCommand(harness, 'nope'), /unknown command/);
  await assert.rejects(() => runCommand(harness, 'group missing'), /unknown group/);
  await assert.rejects(
    () => runCommand(harness, 'permission demo not_a_permission'),
    /unknown permission/,
  );

  await harness.audit.close();
  const auditText = readFileSync(root + '/.groupharness/audit.jsonl', 'utf8');
  assert.ok(auditText.includes('group_create'));
  assert.ok(auditText.includes('set_agent_config'));
  assert.ok(!auditText.includes('sk-secret-12345'));
  await harness.close();
});
