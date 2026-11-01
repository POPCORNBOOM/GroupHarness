import assert from 'node:assert/strict';
import test from 'node:test';
import { QueueRenderer, roundHash } from '../src/render';
import type { QueueItem } from '../src/storage';

function item(id: number, kind: string, payload: unknown): QueueItem {
  return {
    id,
    targetAgentId: 'bob',
    kind,
    payload,
    createdAt: '2026-11-01T00:00:00.000Z',
    status: 'pending',
  };
}

function chat(
  id: number,
  trigger: { seq: number; sender_id: string; text: string },
  history: { seq: number; sender_id: string; text: string }[] = [],
): QueueItem {
  return item(id, 'chat', {
    trigger: { ...trigger, kind: 'user_message' },
    history: history.map((line) => ({ ...line, kind: 'user_message' })),
    context_before: history.length,
  });
}

test('chat blocks merge adjacent histories, split gaps, and mark triggers', () => {
  const items = [
    chat(41, { seq: 24, sender_id: 'alice', text: '@bob 你看下这个报错' }, [
      { seq: 20, sender_id: 'alice', text: '服务又挂了' },
      { seq: 21, sender_id: 'bob', text: '我看看日志' },
      { seq: 22, sender_id: 'alice', text: '@bob 日志在 /tmp/app.log' },
      { seq: 23, sender_id: 'dave', text: '我也看下' },
    ]),
    chat(42, { seq: 25, sender_id: 'carol', text: '@bob 顺便看下磁盘' }),
    chat(47, { seq: 29, sender_id: 'carol', text: '@bob 另一个话题' }),
  ];
  const messages = new QueueRenderer().render(items);
  assert.equal(messages.length, 2);
  assert.equal(messages[0]!.content, [
    `Round #${roundHash(items)}`,
    'New messages. Review the chat history.',
    '<msg20 sender="alice">服务又挂了</msg20>',
    '<msg21 sender="bob">我看看日志</msg21>',
    '<msg22 sender="alice">@bob 日志在 /tmp/app.log</msg22>',
    '<msg23 sender="dave">我也看下</msg23>',
    '<msg24 important sender="alice">@bob 你看下这个报错</msg24>',
    '<msg25 important sender="carol">@bob 顺便看下磁盘</msg25>',
  ].join('\n'));
  assert.equal(messages[1]!.content, [
    `Round #${roundHash(items)}`,
    'New messages. Review the chat history.',
    '<msg29 important sender="carol">@bob 另一个话题</msg29>',
  ].join('\n'));
});

test('mixed kinds keep id order and share one round hash', () => {
  const items = [
    chat(41, { seq: 24, sender_id: 'alice', text: '@bob 看这个' }, [
      { seq: 20, sender_id: 'alice', text: '历史' },
    ]),
    item(43, 'task_result', {
      task_id: 'task-8d1',
      tooltype: 'run_command_async',
      status: 'done',
      publisher_id: 'bob',
      visibility: 'private',
      result: { exit_code: 0, stdout: 'ok' },
      error: null,
    }),
    item(45, 'system_restart', {}),
    item(46, 'unknown_kind', { probe: true }),
    chat(47, { seq: 29, sender_id: 'carol', text: '@bob 另一个' }),
  ];
  const messages = new QueueRenderer().render(items);
  const hash = `Round #${roundHash(items)}`;
  assert.deepEqual(messages.map((message) => message.role), Array(5).fill('user'));
  assert.ok(messages.every((message) => message.content.startsWith(hash + '\n')));
  assert.match(messages[0]!.content, /<msg24 important sender="alice">@bob 看这个<\/msg24>/);
  assert.match(messages[1]!.content, /A background task of type run_command_async, published by bob \(task id: task-8d1\), named you as one of its result recipients\. The task status is done\. The result is:/);
  assert.match(messages[2]!.content, /The harness restarted\./);
  assert.match(messages[3]!.content, /Unknown event: \{"probe":true\}/);
  assert.match(messages[4]!.content, /<msg29 important sender="carol">@bob 另一个<\/msg29>/);
});

test('chat XML escapes text and sender attributes', () => {
  const items = [chat(1, { seq: 1, sender_id: 'a"&', text: '<x> & "y"' })];
  const content = new QueueRenderer().render(items)[0]!.content;
  assert.match(content, /<msg1 important sender="a&quot;&amp;">&lt;x&gt; &amp; "y"<\/msg1>/);
});

test('translator output ids must come from the batch', () => {
  const renderer = new QueueRenderer();
  renderer.register({ kind: 'bad', translate: () => [{ id: 999, content: 'x' }] });
  assert.throws(() => renderer.render([item(1, 'bad', {})]), /not present in the batch/);
});
