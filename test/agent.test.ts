import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { Harness } from '../src/harness';
import { ScriptedLlm, FakeTransport, demoMeta, lastUserText, makeRoot, textCompletion, toolCompletion, waitFor, writeFixture } from './helpers';

const CONTEXT = '/.groupharness/groups/demo/agents/bob/context.jsonl';

test('an agent wakes on a mention, calls tools, replies, and persists context across restart', async () => {
  const root = makeRoot();
  writeFixture(root, { meta: demoMeta(), agentLayers: { bob: { tools: [] } } });
  const llm = new ScriptedLlm((_request, index) => {
    if (index === 0) return toolCompletion('send_message', { text: '@alice hi there' }, 'call_1');
    return textCompletion('done');
  });
  const harness = await Harness.open({ rootDir: root, runtime: true, im: false, llm });
  const group = harness.requireGroup('demo');
  group.send('alice', '@bob hello', 'user_message', 'test');
  await harness.waitIdle(5_000);

  const messages = group.latestMessages(10);
  assert.ok(messages.some((message) => message.sender_id === 'bob' && message.text.includes('hi there')));
  assert.equal(llm.requests.length, 2);
  const first = llm.requests[0]!;
  assert.match(first.system, /"bob"/);
  assert.match(lastUserText(first), /\[群聊历史记录\]/);
  assert.match(lastUserText(first), /@bob hello/);
  const toolResult = llm.requests[1]!.messages.find((message) => message.role === 'tool');
  assert.ok(toolResult !== undefined);
  assert.equal((JSON.parse(toolResult.content) as { message_id: number }).message_id, 2);
  assert.equal(group.store.takePending('bob').length, 0);

  const contextLines = readFileSync(root + CONTEXT, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(contextLines.map((line: { role: string }) => line.role), [
    'user',
    'assistant',
    'tool',
    'assistant',
  ]);
  await harness.close();

  const secondLlm = new ScriptedLlm(() => textCompletion('no reply'));
  const reopened = await Harness.open({ rootDir: root, runtime: true, im: false, llm: secondLlm });
  reopened.requireGroup('demo').send('alice', '@bob again', 'user_message', 'test');
  await reopened.waitIdle(5_000);
  const restored = secondLlm.requests[0]!;
  assert.ok(restored.messages.some((message) => message.role === 'user' && message.content.includes('@bob hello')));
  assert.ok(restored.messages.some((message) => message.role === 'tool' && message.content.includes('message_id')));
  await reopened.close();
});

test('file tools respect the merged file permission and report denials', async () => {
  const root = makeRoot();
  const work = join(root, 'work');
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, 'data.txt'), 'file-content-42');
  writeFixture(root, {
    meta: demoMeta(),
    agentLayers: {
      bob: {
        tools: ['read_file'],
        working_directory: 'work',
        file_permission: { read: [work] },
      },
    },
  });
  const llm = new ScriptedLlm((_request, index) => {
    if (index === 0) return toolCompletion('read_file', { path: 'data.txt' }, 'call_read');
    if (index === 1) return toolCompletion('read_file', { path: '/etc/hosts' }, 'call_denied');
    if (index === 2) return toolCompletion('send_message', { text: 'files read' }, 'call_send');
    return textCompletion('done');
  });
  const harness = await Harness.open({ rootDir: root, runtime: true, im: false, llm });
  harness.requireGroup('demo').send('alice', '@bob inspect', 'user_message', 'test');
  await harness.waitIdle(5_000);

  const toolMessages = llm.requests[2]!.messages.filter((message) => message.role === 'tool');
  assert.equal(toolMessages.length, 2);
  assert.ok(toolMessages[0]!.content.includes('file-content-42'));
  assert.ok(toolMessages[1]!.content.includes('"error":"denied"'));
  assert.ok(harness.requireGroup('demo').latestMessages(5).some((message) => message.text === 'files read'));
  await harness.close();
});

test('async tools create a task and deliver its result through the separate channel', async () => {
  const root = makeRoot();
  const meta = demoMeta();
  meta.members.push({ id: 'carol', type: 'user' });
  writeFixture(root, { meta, agentLayers: { bob: { tools: ['run_command_async'], working_directory: 'work' } } });
  const llm = new ScriptedLlm((request) => {
    if (lastUserText(request).includes('[任务结果]')) {
      if (request.messages.some((message) => message.role === 'tool' && message.content.includes('message_id'))) {
        return textCompletion('done');
      }
      return toolCompletion('send_message', { text: 'task done' }, 'call_report');
    }
    if (request.messages.some((message) => message.role === 'tool' && message.content.includes('task_id'))) {
      return textCompletion('started');
    }
    return toolCompletion(
      'run_command_async',
      { command: 'echo task-output', listeners: ['alice'], visibility: 'private' },
      'call_task',
    );
  });
  const harness = await Harness.open({ rootDir: root, runtime: true, im: false, llm });
  const group = harness.requireGroup('demo');
  const alice = new FakeTransport();
  group.attachTransport('alice', alice);
  group.send('alice', '@bob start a task', 'user_message', 'test');
  await waitFor(() => alice.tasks.length === 1 && group.latestMessages(20).some((message) => message.text === 'task done'), 15_000);

  const detail = alice.tasks[0]!;
  assert.equal(detail.status, 'done');
  assert.equal(detail.visibility, 'private');
  assert.deepEqual(detail.result, { exit_code: 0, timed_out: false, stdout: 'task-output\n', stderr: '' });
  assert.equal(group.getTask('carol', detail.taskId), undefined, 'private task is invisible to non-listeners');
  assert.ok(group.getTask('alice', detail.taskId) !== undefined);
  harness.admin('demo').setAdmins({ bypass_permission: true }, ['alice', 'carol']);
  assert.ok(group.getTask('carol', detail.taskId) !== undefined, 'admins can read a private task');
  await harness.audit.close();
  const auditText = readFileSync(root + '/.groupharness/audit.jsonl', 'utf8');
  assert.ok(auditText.includes('read_private_task'));
  assert.equal(group.adminTasks(5)[0]?.status, 'done');
  await harness.close();
});

test('an agent added at runtime starts consuming immediately', async () => {
  const root = makeRoot();
  writeFixture(root, { meta: demoMeta(), agentLayers: { bob: { tools: [] } } });
  const llm = new ScriptedLlm((_request, index) => {
    if (index === 0) return toolCompletion('send_message', { text: 'carol here' }, 'call_1');
    return textCompletion('done');
  });
  const harness = await Harness.open({ rootDir: root, runtime: true, im: false, llm });
  const admin = harness.admin('demo');
  admin.registerMember({ bypass_permission: true }, { id: 'carol', type: 'agent' });
  admin.addPolicy(
    { bypass_permission: true },
    { agent: 'carol', trigger_mode: 'all', sender_type: 'user', context_before: 0 },
  );
  harness.requireGroup('demo').send('alice', 'hello all', 'user_message', 'test');
  await harness.waitIdle(5_000);
  assert.ok(
    harness
      .requireGroup('demo')
      .latestMessages(5)
      .some((message) => message.sender_id === 'carol' && message.text === 'carol here'),
  );
  await harness.close();
});

test('pending events are consumed before the startup restart', async () => {
  const root = makeRoot();
  writeFixture(root, { meta: demoMeta(), agentLayers: { bob: { tools: [] } } });
  const control = await Harness.open({ rootDir: root, runtime: false, im: false });
  control.requireGroup('demo').send('alice', '@bob old pending', 'user_message', 'test');
  await control.close();

  const llm = new ScriptedLlm(() => textCompletion('idle'));
  const harness = await Harness.open({ rootDir: root, runtime: true, im: false, deliverRestart: true, llm });
  await harness.waitIdle(5_000);
  const text = lastUserText(llm.requests[0]!);
  assert.ok(text.includes('old pending'));
  assert.ok(text.includes('[系统重启]'));
  assert.ok(text.indexOf('old pending') < text.indexOf('[系统重启]'), 'old work is rendered before the restart');
  await harness.close();
});

test('startup injects system_restart after loading pending work without resetting context', async () => {
  const root = makeRoot();
  writeFixture(root, { meta: demoMeta(), agentLayers: { bob: { tools: [] } } });
  const llm = new ScriptedLlm(() => textCompletion('idle'));
  const harness = await Harness.open({ rootDir: root, runtime: true, im: false, deliverRestart: true, llm });
  await harness.waitIdle(5_000);
  const group = harness.requireGroup('demo');
  assert.equal(group.latestMessages(1)[0]?.kind, 'system_restart');
  assert.ok(lastUserText(llm.requests[0]!).includes('[系统重启]'));
  await harness.close();
});
