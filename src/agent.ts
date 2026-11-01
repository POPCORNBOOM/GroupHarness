/**
 * Agent runtime: one persisted context, one queue consumer, one classic tool
 * loop. The runtime owns its context file; the group only enqueues events.
 *
 * Config is resolved once at the start of each wake-up (never mid-loop), so a
 * config edit takes effect after the current loop finishes.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ResolvedConfig } from './config';
import type { QueueItem, QueueStatus } from './storage';
import type { ChatMessage, LlmLike, ToolCall } from './llm';
import { systemPrompt, type PromptMember } from './prompts';
import { roundHash } from './render';
import {
  buildToolRegistry,
  ToolError,
  type ToolContext,
  type ToolGroupApi,
  type ToolRegistry,
} from './tools';

export const MAX_TOOL_ROUNDS = 16;
/** Context compaction keeps the newest N wake-ups (default from the design). */
export const CONTEXT_ROUNDS = 8;

export interface AgentHost {
  groupId: string;
  groupName(): string;
  contextPath: string;
  members(): PromptMember[];
  resolveConfig(): ResolvedConfig;
  /** Business tool names enabled for this agent. */
  businessTools(): string[];
  groupApi(): ToolGroupApi;
  renderQueue(items: QueueItem[], roundHash: string): ChatMessage[];
  takePending(): QueueItem[];
  countPending(): number;
  markQueue(ids: number[], status: QueueStatus, error?: string): void;
  markTaskRunning(taskId: string): void;
  completeTask(taskId: string, status: 'done' | 'failed', result?: unknown, error?: string): void;
  onAgentError?(error: unknown): void;
}

export interface AgentRuntimeOptions {
  agentId: string;
  host: AgentHost;
  llm: LlmLike;
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.role !== 'user' && record.role !== 'assistant' && record.role !== 'tool') return false;
  if (typeof record.content !== 'string') return false;
  if (record.role === 'assistant' && record.tool_calls !== undefined) {
    if (!Array.isArray(record.tool_calls)) return false;
  }
  if (record.role === 'tool' && typeof record.tool_call_id !== 'string') return false;
  return true;
}

function userRoundStarts(messages: ChatMessage[]): number[] {
  const starts: number[] = [];
  let lastKey: string | undefined;
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'user') continue;
    const firstLine = message.content.split('\n', 1)[0] ?? '';
    const key = firstLine.startsWith('Round #') ? firstLine : `legacy:${index}`;
    if (key !== lastKey) {
      starts.push(index);
      lastKey = key;
    }
  }
  return starts;
}

function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += message.content.length;
    for (const call of message.tool_calls ?? []) {
      chars += call.name.length + call.argumentsText.length;
    }
  }
  return Math.ceil(chars / 3);
}

export class AgentRuntime {
  private context: ChatMessage[] = [];
  private running = false;
  private again = false;
  private stopped = false;

  constructor(private readonly options: AgentRuntimeOptions) {}

  get agentId(): string {
    return this.options.agentId;
  }

  /** Restore the persisted context and start consuming the queue. */
  start(): void {
    this.loadContext();
    this.kick();
  }

  /** Ask the consumer to run; it serializes work per agent. */
  kick(): void {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    void this.drain();
  }

  isIdle(): boolean {
    return !this.running && this.options.host.countPending() === 0;
  }

  /** Stop accepting work and wait for the current loop to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    while (this.running) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private loadContext(): void {
    const path = this.options.host.contextPath;
    if (!existsSync(path)) return;
    const lines = readFileSync(path, 'utf8').split('\n');
    const restored: ChatMessage[] = [];
    for (const line of lines) {
      if (line.trim() === '') continue;
      try {
        const value = JSON.parse(line) as unknown;
        if (isChatMessage(value)) restored.push(value);
      } catch {
        // A torn line from a crash is skipped; the rest of the context survives.
      }
    }
    this.context = restored;
  }

  private record(message: ChatMessage): void {
    this.context.push(message);
    const path = this.options.host.contextPath;
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(message) + '\n', 'utf8');
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      for (;;) {
        const items = this.options.host.takePending();
        if (items.length === 0) break;
        const ids = items.map((item) => item.id);
        try {
          await this.wake(items);
          this.options.host.markQueue(ids, 'done');
        } catch (error) {
          this.options.host.markQueue(ids, 'failed', (error as Error).message);
          this.options.host.onAgentError?.(error);
        }
      }
    } finally {
      this.running = false;
      if (this.again && !this.stopped) {
        this.again = false;
        void this.drain();
      }
    }
  }

  /** One wake-up: render the merged events, then run the tool loop. */
  private async wake(items: QueueItem[]): Promise<void> {
    const config = this.options.host.resolveConfig();
    const registry = buildToolRegistry(this.options.host.businessTools());

    for (const message of this.options.host.renderQueue(items, roundHash(items))) {
      this.record(message);
    }

    const trimmed = this.trimmedContext(config);
    const system = systemPrompt({
      agentId: this.options.agentId,
      groupId: this.options.host.groupId,
      groupName: this.options.host.groupName(),
      members: this.options.host.members(),
      businessTools: this.options.host.businessTools(),
      workingDirectory: config.workingDirectory,
      filePermission: config.filePermission,
      maxToolRounds: MAX_TOOL_ROUNDS,
      truncated: trimmed.truncated,
    });

    const messages: ChatMessage[] = [...trimmed.messages];
    await this.runToolLoop(system, messages, registry, config);
  }

  private trimmedContext(config: ResolvedConfig): { messages: ChatMessage[]; truncated: boolean } {
    const userIndexes = userRoundStarts(this.context);
    let start = 0;
    if (userIndexes.length > CONTEXT_ROUNDS) {
      start = userIndexes[userIndexes.length - CONTEXT_ROUNDS] ?? 0;
    }
    const budget = Math.max(
      1_000,
      config.model.context_window - config.model.max_output_tokens - 2_000,
    );
    while (start > 0) {
      const slice = this.context.slice(start);
      if (estimateTokens(slice) <= budget) break;
      const next = userIndexes.find((index) => index > start);
      if (next === undefined) break;
      start = next;
    }
    return { messages: this.context.slice(start), truncated: start > 0 };
  }

  private async runToolLoop(
    system: string,
    messages: ChatMessage[],
    registry: ToolRegistry,
    config: ResolvedConfig,
  ): Promise<void> {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const completion = await this.options.llm.complete({
        config: config.model,
        system,
        messages,
        tools: registry.schemas(),
      });
      const assistant: ChatMessage = {
        role: 'assistant',
        content: completion.text,
        ...(completion.toolCalls.length === 0 ? {} : { tool_calls: completion.toolCalls }),
      };
      this.record(assistant);
      messages.push(assistant);
      if (completion.toolCalls.length === 0) return;
      for (const call of completion.toolCalls) {
        let result: { content: string; isError: boolean };
        try {
          // The design resolves file policy per tool execution; the model config
          // above stays frozen for the whole loop (hot updates apply next wake).
          const toolConfig = this.options.host.resolveConfig();
          result = await this.executeToolCall(call, registry, toolConfig);
        } catch (error) {
          result = {
            content: JSON.stringify({ error: 'failed', message: (error as Error).message }),
            isError: true,
          };
        }
        const toolMessage: ChatMessage = {
          role: 'tool',
          tool_call_id: call.id,
          content: result.content,
          is_error: result.isError,
        };
        this.record(toolMessage);
        messages.push(toolMessage);
      }
    }
  }

  private toolContext(config: ResolvedConfig): ToolContext {
    return {
      callerId: this.options.agentId,
      group: this.options.host.groupApi(),
      config,
      workingDirectory: config.workingDirectory,
      filePermission: config.filePermission,
    };
  }

  private async executeToolCall(
    call: ToolCall,
    registry: ToolRegistry,
    config: ResolvedConfig,
  ): Promise<{ content: string; isError: boolean }> {
    if (call.argumentsError !== undefined) {
      return {
        content: JSON.stringify({ error: 'failed', message: call.argumentsError }),
        isError: true,
      };
    }
    const args = call.arguments;
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      return {
        content: JSON.stringify({ error: 'failed', message: 'tool arguments must be an object' }),
        isError: true,
      };
    }
    const record = args as Record<string, unknown>;
    const definition = registry.get(call.name);
    if (definition === undefined) {
      return {
        content: JSON.stringify({ error: 'failed', message: `unknown tool "${call.name}"` }),
        isError: true,
      };
    }
    const ctx = this.toolContext(config);
    if (definition.async === true) {
      try {
        if (
          record.listeners !== undefined &&
          (!Array.isArray(record.listeners) ||
            record.listeners.some((entry) => typeof entry !== 'string' || entry === ''))
        ) {
          throw new ToolError('failed', 'argument "listeners" must be an array of member ids');
        }
        if (
          record.visibility !== undefined &&
          record.visibility !== 'private' &&
          record.visibility !== 'public'
        ) {
          throw new ToolError('failed', 'argument "visibility" must be "private" or "public"');
        }
        const listeners = record.listeners as string[] | undefined;
        const visibility = record.visibility === 'public' ? 'public' : 'private';
        const executionArgs = { ...record };
        delete executionArgs.listeners;
        delete executionArgs.visibility;
        const taskId = ctx.group.startTask(call.name, executionArgs, listeners, visibility);
        return { content: JSON.stringify({ task_id: taskId, status: 'pending' }), isError: false };
      } catch (error) {
        const code = error instanceof ToolError ? error.code : 'failed';
        return { content: JSON.stringify({ error: code, message: (error as Error).message }), isError: true };
      }
    }
    return registry.run(definition, record, ctx);
  }

  /** Execute one background task created by this agent's async tool. */
  async runTask(taskId: string, tooltype: string, args: Record<string, unknown>): Promise<void> {
    try {
      this.options.host.markTaskRunning(taskId);
      const config = this.options.host.resolveConfig();
      const registry = buildToolRegistry(this.options.host.businessTools());
      const definition = registry.get(tooltype);
      if (definition === undefined || definition.async !== true) {
        this.options.host.completeTask(taskId, 'failed', undefined, `unknown async tool "${tooltype}"`);
        return;
      }
      const result = await registry.run(definition, args, this.toolContext(config));
      if (result.isError) {
        let message = result.content;
        try {
          const parsed = JSON.parse(result.content) as { message?: unknown };
          if (typeof parsed.message === 'string') message = parsed.message;
        } catch {
          // Keep the raw content.
        }
        this.options.host.completeTask(taskId, 'failed', undefined, message);
        return;
      }
      let parsedResult: unknown = result.content;
      try {
        parsedResult = JSON.parse(result.content) as unknown;
      } catch {
        // Keep the raw content.
      }
      this.options.host.completeTask(taskId, 'done', parsedResult);
    } catch (error) {
      this.options.host.completeTask(taskId, 'failed', undefined, (error as Error).message);
    }
  }

  /** Resolve once the agent has no running loop and nothing pending. */
  async awaitIdle(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.isIdle()) {
      if (Date.now() > deadline) throw new Error(`agent ${this.options.agentId} did not become idle`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}
