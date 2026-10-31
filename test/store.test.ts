import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { GroupStore, type MessageContent, type TaskRecord } from '../src/storage';

function openStore(): GroupStore {
  return GroupStore.open(mkdtempSync(join(tmpdir(), 'gh-store-')));
}

function messageBody(text: string, sender = 'alice', at = '2026-01-01T00:00:00Z'): MessageContent {
  return {
    kind: 'user_message',
    sender_id: sender,
    source: 'test',
    task_id: null,
    timestamp: at,
    text,
  };
}

function insert(store: GroupStore, text: string, at = '2026-01-01T00:00:00Z', sender = 'alice'): number {
  const body = messageBody(text, sender, at);
  return store.insertMessage({
    sender_id: sender,
    kind: 'user_message',
    content: body,
    created_at: at,
  });
}

test('messages persist and search by trigram and short-keyword fallback', () => {
  const store = openStore();
  insert(store, '你好世界 hello world');
  insert(store, 'another hello');
  insert(store, '完全无关');

  assert.equal(store.searchMessages({ query: 'hello' }).messages.length, 2);
  assert.equal(store.searchMessages({ query: '世界' }).messages.length, 1);
  assert.equal(store.searchMessages({ query: '好世界' }).messages.length, 1);
  assert.equal(store.searchMessages({ query: '无关' }).messages.length, 1);
  assert.equal(store.searchMessages({ query: 'missing' }).messages.length, 0);
  store.close();
});

test('search paginates by id cursor and filters by date', () => {
  const store = openStore();
  const first = insert(store, 'alpha one', '2026-01-01T00:00:01Z');
  insert(store, 'alpha two', '2026-01-01T00:00:02Z');
  insert(store, 'beta', '2026-01-01T00:00:03Z');

  const page1 = store.searchMessages({ query: 'alpha', limit: 1 });
  assert.equal(page1.messages.length, 1);
  assert.equal(page1.messages[0]?.id, first);
  assert.equal(page1.nextCursor, first);

  const page2 = store.searchMessages({ query: 'alpha', limit: 1, cursor: page1.nextCursor ?? undefined });
  assert.equal(page2.messages.length, 1);
  assert.notEqual(page2.messages[0]?.id, first);
  assert.equal(page2.nextCursor, null);

  const early = store.searchMessages({ query: 'alpha', until: '2026-01-01T00:00:01Z' });
  assert.equal(early.messages.length, 1);
  store.close();
});

test('a message insert and its queue entry roll back together', () => {
  const store = openStore();
  assert.throws(() =>
    store.withTransaction(() => {
      insert(store, 'doomed');
      store.enqueue('bob', 'chat', { kind: 'chat' }, '2026-01-01T00:00:00Z');
      throw new Error('boom');
    }),
  );
  assert.equal(store.latestMessages(10).length, 0);
  assert.equal(store.countPending('bob'), 0);
  store.close();
});

test('queue take marks processing, reset recovers, and status transitions stick', () => {
  const store = openStore();
  store.enqueue('bob', 'chat', { kind: 'chat', n: 1 }, '2026-01-01T00:00:00Z');
  store.enqueue('bob', 'chat', { kind: 'chat', n: 2 }, '2026-01-01T00:00:01Z');
  const taken = store.takePending('bob');
  assert.equal(taken.length, 2);
  assert.deepEqual(taken.map((item) => item.payload), [
    { kind: 'chat', n: 1 },
    { kind: 'chat', n: 2 },
  ]);
  assert.equal(store.takePending('bob').length, 0);
  assert.equal(store.resetProcessing(), 2);
  const again = store.takePending('bob');
  assert.equal(again.length, 2);
  store.markQueueStatus(again.map((item) => item.id), 'done');
  assert.equal(store.countPending('bob'), 0);
  store.close();
});

test('task and queue tables live in their own database files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-store-'));
  const store = GroupStore.open(dir);
  store.close();
  const queueDb = new DatabaseSync(join(dir, 'queue.db'));
  assert.ok(queueDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='queue'").get() !== undefined);
  queueDb.close();
  const tasksDb = new DatabaseSync(join(dir, 'tasks.db'));
  assert.ok(tasksDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get() !== undefined);
  tasksDb.close();
  const messagesDb = new DatabaseSync(join(dir, 'messages.db'));
  assert.equal(messagesDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('queue','tasks')").get(), undefined);
  messagesDb.close();
});

test('version 1 databases migrate task and queue tables out of messages.db', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-store-'));
  const legacy = new DatabaseSync(join(dir, 'messages.db'));
  legacy.exec(`
    PRAGMA user_version = 1;
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE queue (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT);
    CREATE TABLE tasks (task_id TEXT PRIMARY KEY);
  `);
  legacy
    .prepare('INSERT INTO messages(sender_id, kind, content, created_at) VALUES (?, ?, ?, ?)')
    .run(
      'alice',
      'user_message',
      JSON.stringify(messageBody('legacy hello')),
      '2026-01-01T00:00:00Z',
    );
  legacy.close();

  const store = GroupStore.open(dir);
  assert.equal(store.searchMessages({ query: 'legacy' }).messages.length, 1);
  store.close();

  const main = new DatabaseSync(join(dir, 'messages.db'));
  assert.equal(
    main.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('queue','tasks')").get(),
    undefined,
  );
  assert.equal(Number(main.prepare('PRAGMA user_version').get()?.user_version), 2);
  main.close();
  const queueDb = new DatabaseSync(join(dir, 'queue.db'));
  assert.ok(queueDb.prepare("SELECT name FROM sqlite_master WHERE name='queue'").get() !== undefined);
  queueDb.close();
  const tasksDb = new DatabaseSync(join(dir, 'tasks.db'));
  assert.ok(tasksDb.prepare("SELECT name FROM sqlite_master WHERE name='tasks'").get() !== undefined);
  tasksDb.close();
});

test('tasks round-trip and update', () => {
  const store = openStore();
  const task: TaskRecord = {
    taskId: 'task-1',
    tooltype: 'run_command_async',
    args: { command: 'echo hi' },
    publisherId: 'bob',
    listeners: ['alice'],
    visibility: 'private',
    status: 'pending',
    result: null,
    error: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
  store.insertTask(task);
  assert.deepEqual(store.getTask('task-1'), task);
  store.updateTask('task-1', { status: 'done', result: { exit_code: 0 }, updatedAt: '2026-01-01T00:00:01Z' });
  const updated = store.getTask('task-1');
  assert.equal(updated?.status, 'done');
  assert.deepEqual(updated?.result, { exit_code: 0 });
  assert.equal(store.listTasks().length, 1);
  store.close();
});
