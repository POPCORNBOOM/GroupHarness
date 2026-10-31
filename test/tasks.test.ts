import assert from 'node:assert/strict';
import test from 'node:test';
import { Harness } from '../src/harness';
import type { TaskRecord } from '../src/storage';
import { FakeTransport, demoMeta, makeRoot, writeFixture } from './helpers';

function taskRecord(taskId: string, visibility: 'private' | 'public', publisherId = 'bob'): TaskRecord {
  const now = '2026-01-01T00:00:00Z';
  return {
    taskId,
    tooltype: 'run_command_async',
    args: { command: 'echo x' },
    publisherId,
    listeners: [],
    visibility,
    status: 'pending',
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
}

test('public results reach every member; private results stay with publisher and listeners', async () => {
  const root = makeRoot();
  const meta = demoMeta();
  meta.members.push({ id: 'carol', type: 'user' });
  writeFixture(root, { meta, agentLayers: { bob: { tools: ['run_command_async'] } } });
  const harness = await Harness.open({ rootDir: root, runtime: false, im: false });
  const group = harness.requireGroup('demo');
  const carol = new FakeTransport();
  group.attachTransport('carol', carol);

  group.store.insertTask(taskRecord('task-public', 'public'));
  group.completeTask('task-public', 'done', { stdout: 'public-ok' });
  assert.equal(carol.tasks.length, 1);
  assert.equal(carol.tasks[0]?.status, 'done');
  assert.equal(group.getTask('carol', 'task-public')?.status, 'done');
  assert.deepEqual(group.listTasks('carol').map((task) => task.taskId), ['task-public']);

  group.store.insertTask(taskRecord('task-private', 'private'));
  group.completeTask('task-private', 'done', { stdout: 'private-ok' });
  assert.equal(carol.tasks.length, 1, 'a private result is not pushed to non-listeners');
  assert.equal(group.getTask('carol', 'task-private'), undefined);
  assert.deepEqual(group.listTasks('carol').map((task) => task.taskId), ['task-public']);

  group.store.insertTask({ ...taskRecord('task-listened', 'private'), listeners: ['carol'] });
  group.completeTask('task-listened', 'failed', undefined, 'boom');
  assert.equal(carol.tasks.length, 2);
  assert.equal(carol.tasks[1]?.status, 'failed');
  assert.equal(carol.tasks[1]?.error, 'boom');
  assert.ok(group.listTasks('carol').some((task) => task.taskId === 'task-listened'));

  // Results never enter the chat stream.
  assert.equal(group.latestMessages(10).length, 0);
  await harness.close();
});
