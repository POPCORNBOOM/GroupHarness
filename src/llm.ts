/**
 * Model protocol adapters. Only the two protocols in the v1 scope are
 * implemented: OpenAI chat completions and Anthropic messages. Both expose the
 * harness's thin `complete(messages, config)` shape and never stream.
 */
import type { ModelConfig } from './config';

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed arguments; `null` when the model emitted invalid JSON. */
  arguments: unknown;
  /** Original argument text, kept for exact replay. */
  argumentsText: string;
  argumentsError?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  is_error?: boolean;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface CompletionRequest {
  config: ModelConfig;
  system: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
  timeoutMs?: number;
}

export interface Completion {
  text: string;
  toolCalls: ToolCall[];
  finishReason: string;
}

export interface LlmLike {
  complete(request: CompletionRequest): Promise<Completion>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;

function endpoint(baseurl: string, path: string): string {
  const trimmed = baseurl.replace(/\/+$/, '');
  return trimmed.endsWith(path) ? trimmed : trimmed + path;
}

function truncate(text: string, max = 800): string {
  return text.length <= max ? text : text.slice(0, max) + '…';
}

function abortMessage(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return 'LLM request timed out';
  return `LLM request failed: ${(error as Error).message}`;
}

function parseArguments(raw: string): Pick<ToolCall, 'arguments' | 'argumentsText' | 'argumentsError'> {
  const text = raw === '' ? '{}' : raw;
  try {
    return { arguments: JSON.parse(text) as unknown, argumentsText: raw };
  } catch (error) {
    return {
      arguments: null,
      argumentsText: raw,
      argumentsError: `invalid tool arguments: ${(error as Error).message}`,
    };
  }
}

function replayArguments(call: ToolCall): string {
  return call.argumentsText === '' ? '{}' : call.argumentsText;
}

function mapOpenAiMessages(system: string, messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [{ role: 'system', content: system }];
  for (const message of messages) {
    if (message.role === 'assistant') {
      const assistant: Record<string, unknown> = {
        role: 'assistant',
        content: message.content.length > 0 ? message.content : null,
      };
      if (message.tool_calls !== undefined && message.tool_calls.length > 0) {
        assistant.tool_calls = message.tool_calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: replayArguments(call) },
        }));
      }
      out.push(assistant);
    } else if (message.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: message.tool_call_id, content: message.content });
    } else {
      out.push({ role: 'user', content: message.content });
    }
  }
  return out;
}

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

function mapAnthropicMessages(messages: ChatMessage[]): unknown[] {
  const out: { role: 'user' | 'assistant'; content: AnthropicBlock[] }[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      const content: AnthropicBlock[] = [];
      if (message.content.length > 0) content.push({ type: 'text', text: message.content });
      for (const call of message.tool_calls ?? []) {
        content.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: call.arguments ?? {},
        });
      }
      if (content.length === 0) content.push({ type: 'text', text: '' });
      out.push({ role: 'assistant', content });
      continue;
    }
    if (message.role === 'tool') {
      const block: AnthropicBlock = {
        type: 'tool_result',
        tool_use_id: message.tool_call_id ?? '',
        content: message.content,
        ...(message.is_error === true ? { is_error: true } : {}),
      };
      const previous = out.at(-1);
      if (previous !== undefined && previous.role === 'user' && previous.content.every((entry) => entry.type === 'tool_result')) {
        previous.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }
    out.push({ role: 'user', content: [{ type: 'text', text: message.content }] });
  }
  return out;
}

export class LlmClient implements LlmLike {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async complete(request: CompletionRequest): Promise<Completion> {
    const { config } = request;
    if (config.baseurl.trim() === '') throw new LlmError('model.baseurl is empty');
    if (config.model.trim() === '') throw new LlmError('model.model is empty');
    return config.format === 'anthropic' ? this.anthropic(request) : this.openai(request);
  }

  private async openai(request: CompletionRequest): Promise<Completion> {
    const { config } = request;
    const body: Record<string, unknown> = {
      model: config.model,
      messages: mapOpenAiMessages(request.system, request.messages),
      max_tokens: config.max_output_tokens,
    };
    if (request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }));
      body.tool_choice = 'auto';
    }
    if (config.reasoning_effort !== '') body.reasoning_effort = config.reasoning_effort;
    const payload = await this.post(
      endpoint(config.baseurl, '/chat/completions'),
      { Authorization: `Bearer ${config.apikey}` },
      body,
      request.timeoutMs,
    );
    const choice = (payload as { choices?: unknown }).choices;
    const first = Array.isArray(choice) ? (choice[0] as Record<string, unknown> | undefined) : undefined;
    if (first === undefined) throw new LlmError('LLM response has no choices');
    const message = (first.message ?? {}) as Record<string, unknown>;
    const text = this.openAiText(message.content);
    const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const toolCalls: ToolCall[] = [];
    for (const rawCall of rawCalls as Record<string, unknown>[]) {
      const fn = (rawCall.function ?? {}) as Record<string, unknown>;
      const id = typeof rawCall.id === 'string' ? rawCall.id : '';
      const name = typeof fn.name === 'string' ? fn.name : '';
      const rawArguments = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {});
      if (id === '' || name === '') continue;
      toolCalls.push({ id, name, ...parseArguments(rawArguments) });
    }
    const finish = typeof first.finish_reason === 'string' ? first.finish_reason : '';
    return { text, toolCalls, finishReason: finish };
  }

  private openAiText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (part !== null && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
            const text = (part as { text?: unknown }).text;
            return typeof text === 'string' ? text : '';
          }
          return '';
        })
        .join('');
    }
    return '';
  }

  private async anthropic(request: CompletionRequest): Promise<Completion> {
    const { config } = request;
    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens: config.max_output_tokens,
      system: request.system,
      messages: mapAnthropicMessages(request.messages),
    };
    if (request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
    }
    const payload = await this.post(
      endpoint(config.baseurl, '/messages'),
      { 'x-api-key': config.apikey, 'anthropic-version': '2023-06-01' },
      body,
      request.timeoutMs,
    );
    const content = (payload as { content?: unknown }).content;
    if (!Array.isArray(content)) throw new LlmError('LLM response has no content');
    let text = '';
    const toolCalls: ToolCall[] = [];
    for (const block of content as AnthropicBlock[]) {
      if (block.type === 'text' && typeof block.text === 'string') {
        text += block.text;
      } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        const argumentsText = JSON.stringify(block.input ?? {});
        toolCalls.push({ id: block.id, name: block.name, arguments: block.input ?? {}, argumentsText });
      }
    }
    const finish = (payload as { stop_reason?: unknown }).stop_reason;
    return { text, toolCalls, finishReason: typeof finish === 'string' ? finish : '' };
  }

  private async post(
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new LlmError(abortMessage(error));
    }
    const text = await response.text();
    if (!response.ok) {
      throw new LlmError(`LLM request failed (${response.status}): ${truncate(text)}`, response.status, text);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new LlmError(`LLM returned invalid JSON: ${truncate(text)}`);
    }
  }
}
