import assert from 'node:assert/strict';
import test from 'node:test';
import { LlmClient, LlmError, type ChatMessage } from '../src/llm';

type ModelConfigLike = Parameters<LlmClient['complete']>[0]['config'];

function config(format: 'completion' | 'anthropic'): ModelConfigLike {
  return {
    format,
    baseurl: 'http://fake.test/v1',
    apikey: 'sk-test',
    model: 'fake-model',
    reasoning_effort: 'low',
    context_window: 128_000,
    max_output_tokens: 512,
  };
}

interface Captured {
  url: string;
  init: RequestInit;
}

function fakeFetch(calls: Captured[], payload: unknown, status = 200): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

const tools = [
  {
    name: 'echo',
    description: 'Echo',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
];

test('openai adapter maps messages, tools, arguments, and headers', async () => {
  const calls: Captured[] = [];
  const client = new LlmClient(
    fakeFetch(calls, {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'echo', arguments: '{"text":"hi"}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }),
  );
  const messages: ChatMessage[] = [
    { role: 'user', content: 'hello' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', name: 'echo', arguments: { text: 'x' }, argumentsText: '{"text":"x"}' }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
  ];
  const completion = await client.complete({ config: config('completion'), system: 'sys', messages, tools });
  assert.equal(completion.text, '');
  assert.equal(completion.toolCalls.length, 1);
  assert.deepEqual(completion.toolCalls[0]?.arguments, { text: 'hi' });

  assert.equal(calls[0]?.url, 'http://fake.test/v1/chat/completions');
  assert.equal((calls[0]?.init.headers as Record<string, string>).Authorization, 'Bearer sk-test');
  const body = JSON.parse(String(calls[0]?.init.body)) as {
    messages: Record<string, unknown>[];
    tools: { function: { name: string } }[];
    max_tokens: number;
    reasoning_effort: string;
  };
  assert.deepEqual(body.messages[0], { role: 'system', content: 'sys' });
  assert.deepEqual(body.messages[1], { role: 'user', content: 'hello' });
  assert.equal((body.messages[2]?.tool_calls as { function: { arguments: string } }[])[0]?.function.arguments, '{"text":"x"}');
  assert.deepEqual(body.messages[3], { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' });
  assert.equal(body.tools[0]?.function.name, 'echo');
  assert.equal(body.max_tokens, 512);
  assert.equal(body.reasoning_effort, 'low');
});

test('invalid tool arguments become a structured error instead of throwing', async () => {
  const calls: Captured[] = [];
  const client = new LlmClient(
    fakeFetch(calls, {
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call_bad', type: 'function', function: { name: 'echo', arguments: '{oops' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }),
  );
  const completion = await client.complete({
    config: config('completion'),
    system: 'sys',
    messages: [{ role: 'user', content: 'x' }],
    tools,
  });
  assert.equal(completion.toolCalls[0]?.arguments, null);
  assert.match(completion.toolCalls[0]?.argumentsError ?? '', /invalid tool arguments/);
});

test('anthropic adapter separates system, groups tool results, and parses blocks', async () => {
  const calls: Captured[] = [];
  const client = new LlmClient(
    fakeFetch(calls, {
      content: [
        { type: 'text', text: 'hello ' },
        { type: 'tool_use', id: 'toolu_1', name: 'echo', input: { text: 'hi' } },
      ],
      stop_reason: 'tool_use',
    }),
  );
  const messages: ChatMessage[] = [
    { role: 'user', content: 'question' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 't1', name: 'echo', arguments: { text: 'a' }, argumentsText: '{"text":"a"}' }],
    },
    { role: 'tool', tool_call_id: 't1', content: 'first', is_error: false },
    { role: 'tool', tool_call_id: 't1', content: 'second', is_error: true },
  ];
  const completion = await client.complete({ config: config('anthropic'), system: 'sys', messages, tools });
  assert.equal(completion.text, 'hello ');
  assert.deepEqual(completion.toolCalls[0]?.arguments, { text: 'hi' });

  assert.equal(calls[0]?.url, 'http://fake.test/v1/messages');
  assert.equal((calls[0]?.init.headers as Record<string, string>)['x-api-key'], 'sk-test');
  assert.equal((calls[0]?.init.headers as Record<string, string>)['anthropic-version'], '2023-06-01');
  const body = JSON.parse(String(calls[0]?.init.body)) as {
    system: string;
    messages: { role: string; content: { type: string; tool_use_id?: string; is_error?: boolean }[] }[];
    tools: { input_schema: unknown }[];
  };
  assert.equal(body.system, 'sys');
  assert.equal(body.messages[0]?.role, 'user');
  assert.deepEqual(body.messages[0]?.content, [{ type: 'text', text: 'question' }]);
  const assistantBlocks = body.messages[1]?.content ?? [];
  assert.equal(assistantBlocks.length, 1);
  assert.equal(assistantBlocks[0]?.type, 'tool_use');
  const resultBlocks = body.messages[2]?.content ?? [];
  assert.equal(body.messages[2]?.role, 'user');
  assert.equal(resultBlocks.length, 2);
  assert.equal(resultBlocks[1]?.is_error, true);
  assert.equal(body.tools[0]?.input_schema !== undefined, true);
});

test('http failures raise LlmError with status and body', async () => {
  const calls: Captured[] = [];
  const client = new LlmClient(fakeFetch(calls, 'boom', 500));
  await assert.rejects(
    () =>
      client.complete({
        config: config('completion'),
        system: 'sys',
        messages: [{ role: 'user', content: 'x' }],
        tools: [],
      }),
    (error: unknown) => error instanceof LlmError && error.status === 500 && /boom/.test(error.message),
  );
});
