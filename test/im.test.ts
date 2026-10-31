import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocket } from 'ws';
import { Harness } from '../src/harness';
import { ScriptedLlm, demoMeta, makeRoot, textCompletion, toolCompletion, waitFor, writeFixture } from './helpers';

interface Frame {
  type: string;
  message?: { sender_id: string; text: string };
  task?: { status: string };
  user_id?: string;
}

test('mock IM routes hello, user messages, and agent replies over one port', async () => {
  const root = makeRoot();
  writeFixture(root, { meta: demoMeta(), agentLayers: { bob: { tools: [] } }, imPort: 0 });
  const llm = new ScriptedLlm((_request, index) => {
    if (index === 0) return toolCompletion('send_message', { text: 'pong from bob' }, 'call_1');
    return textCompletion('done');
  });
  const harness = await Harness.open({ rootDir: root, runtime: true, im: true, llm });
  const port = harness.imPort;
  assert.ok(port !== undefined && port > 0);
  const socket = new WebSocket('ws://127.0.0.1:' + String(port));
  const frames: Frame[] = [];
  socket.on('message', (data) => frames.push(JSON.parse(data.toString()) as Frame));
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({ type: 'hello', group_id: 'demo', user_id: 'alice' }));
    await waitFor(() => frames.some((frame) => frame.type === 'hello_ok'), 5_000);
    assert.equal(frames.find((frame) => frame.type === 'hello_ok')?.user_id, 'alice');

    socket.send(JSON.stringify({ type: 'send', text: '@bob ping' }));
    await waitFor(
      () => frames.some((frame) => frame.type === 'message' && frame.message?.sender_id === 'bob'),
      10_000,
    );
    assert.equal(
      frames.find((frame) => frame.type === 'message' && frame.message?.sender_id === 'bob')?.message?.text,
      'pong from bob',
    );
    assert.ok(frames.some((frame) => frame.type === 'sent'));
  } finally {
    socket.close();
    await harness.close();
  }
});
