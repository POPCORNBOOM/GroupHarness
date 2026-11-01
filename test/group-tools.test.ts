import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { Harness } from '../src/harness';
import { ScriptedLlm, demoMeta, lastUserText, makeRoot, textCompletion, writeFixture } from './helpers';

const GUARD = { bypass_permission: true } as const;

test('group tools are registered, listed, and assigned without bypassing GroupAdmin', async () => {
  const root = makeRoot();
  writeFixture(root, { meta: demoMeta(), agentLayers: { bob: { tools: [] } } });
  const harness = await Harness.open({ rootDir: root, runtime: false, im: false });
  const group = harness.requireGroup('demo');
  assert.ok(group.availableTools().some((tool) => tool.name === 'read_file'));
  assert.deepEqual(group.agentView('bob')?.tools, []);

  assert.throws(
    () => harness.admin('demo').registerAgentTool({} as never, 'bob', 'read_file'),
    /bypass_permission/,
  );
  harness.admin('demo').registerAgentTool(GUARD, 'bob', 'read_file');
  assert.deepEqual(group.agentView('bob')?.tools, ['read_file']);
  harness.admin('demo').unregisterAgentTool(GUARD, 'bob', 'read_file');
  assert.deepEqual(group.agentView('bob')?.tools, []);

  const work = join(root, 'work-next');
  mkdirSync(work, { recursive: true });
  harness.admin('demo').setAgentWorkingDirectory(GUARD, 'bob', work);
  assert.equal(group.agentView('bob')?.workingDirectory, work);
  await harness.close();
});

test('tool and working-directory changes wake the agent with a config update', async () => {
  const root = makeRoot();
  writeFixture(root, { meta: demoMeta(), agentLayers: { bob: { tools: [] } } });
  const llm = new ScriptedLlm(() => textCompletion('done'));
  const harness = await Harness.open({ rootDir: root, runtime: true, im: false, llm });
  const group = harness.requireGroup('demo');
  const admin = harness.admin('demo');

  admin.registerAgentTool(GUARD, 'bob', 'read_file');
  await harness.waitIdle(5_000);
  assert.equal(llm.requests.length, 1);
  const first = lastUserText(llm.requests[0]!);
  assert.match(first, /The agent configuration changed\. Tools added: read_file\./);
  assert.match(llm.requests[0]!.system, /Business tools enabled for you: read_file\./);
  assert.ok(llm.requests[0]!.tools.some((tool) => tool.name === 'read_file'));
  assert.deepEqual(group.agentView('bob')?.tools, ['read_file']);

  const work = join(root, 'work-next');
  mkdirSync(work, { recursive: true });
  admin.setAgentWorkingDirectory(GUARD, 'bob', work);
  await harness.waitIdle(5_000);
  assert.equal(llm.requests.length, 2);
  assert.match(lastUserText(llm.requests[1]!), /Working directory changed from ".*" to ".*work-next"./);

  admin.unregisterAgentTool(GUARD, 'bob', 'read_file');
  await harness.waitIdle(5_000);
  assert.equal(llm.requests.length, 3);
  assert.match(lastUserText(llm.requests[2]!), /Tools removed: read_file\./);
  assert.deepEqual(group.agentView('bob')?.tools, []);
  await harness.close();
});
