import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Completion, CompletionRequest, LlmLike } from '../src/llm';
import type { AgentConfigLayer } from '../src/config';
import { initConfigFile } from '../src/config';
import type { GroupMeta } from '../src/meta';
import { emptyGroupMeta, saveGroupMeta } from '../src/meta';
import type { StoredMessage } from '../src/storage';
import type { TaskDetail } from '../src/tools';
import type { UserTransport } from '../src/group';

export function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'gh-test-'));
}

export interface GroupFixtureOptions {
  meta: GroupMeta;
  baseurl?: string;
  agentLayers?: Record<string, AgentConfigLayer>;
  models?: { model?: string };
  imPort?: number;
}

/** Write .groupharness/config.toml plus one demo group on disk. */
export function writeFixture(root: string, options: GroupFixtureOptions): string {
  const harnessDir = join(root, '.groupharness');
  const groupsDir = join(harnessDir, 'groups', 'demo');
  mkdirSync(groupsDir, { recursive: true });
  initConfigFile(join(harnessDir, 'config.toml'), {
    baseurl: options.baseurl ?? 'http://fake.test/v1',
    model: options.models?.model ?? 'fake-model',
    apikey: 'sk-test-secret-value',
  });
  if (options.imPort !== undefined) {
    const configPath = join(harnessDir, 'config.toml');
    const configText = readFileSync(configPath, 'utf8');
    writeFileSync(configPath, configText.replace('port = 8787', 'port = ' + String(options.imPort)));
  }
  saveGroupMeta(join(groupsDir, 'meta.toml'), options.meta);
  for (const [agentId, layer] of Object.entries(options.agentLayers ?? {})) {
    const dir = join(groupsDir, 'agents', agentId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.toml'), tomlFromLayer(layer) + '\n', 'utf8');
  }
  return root;
}

function tomlFromLayer(layer: AgentConfigLayer): string {
  const lines: string[] = [];
  if (layer.working_directory !== undefined) lines.push(`working_directory = "${layer.working_directory}"`);
  if (layer.tools !== undefined) {
    lines.push('tools = [' + layer.tools.map((tool) => `"${tool}"`).join(', ') + ']');
  }
  if (layer.model !== undefined) {
    lines.push('[model]');
    for (const [key, value] of Object.entries(layer.model)) {
      lines.push(`${key} = ${JSON.stringify(value)}`);
    }
  }
  if (layer.file_permission !== undefined) {
    lines.push('[file_permission]');
    for (const [key, value] of Object.entries(layer.file_permission)) {
      lines.push(`${key} = ${JSON.stringify(value)}`);
    }
  }
  return lines.join('\n');
}

export function demoMeta(): GroupMeta {
  const meta = emptyGroupMeta('Demo');
  meta.admins = ['alice'];
  meta.members = [
    { id: 'alice', type: 'user' },
    { id: 'bob', type: 'agent' },
  ];
  meta.identity_groups = { core: ['alice'] };
  meta.permissions = { manage_group: ['core'] };
  meta.policies = [{ agent: 'bob', trigger_mode: 'mention', sender_type: 'user', context_before: 6 }];
  meta.working_directory = 'work';
  return meta;
}

export class ScriptedLlm implements LlmLike {
  readonly requests: CompletionRequest[] = [];

  constructor(private readonly responder: (request: CompletionRequest, index: number) => Completion) {}

  async complete(request: CompletionRequest): Promise<Completion> {
    const index = this.requests.length;
    this.requests.push({ ...request, messages: request.messages.map((message) => ({ ...message })) });
    return this.responder(request, index);
  }
}

export function textCompletion(text: string): Completion {
  return { text, toolCalls: [], finishReason: 'stop' };
}

export function toolCompletion(
  name: string,
  args: unknown,
  id = 'call_1',
): Completion {
  return {
    text: '',
    toolCalls: [{ id, name, arguments: args, argumentsText: JSON.stringify(args) }],
    finishReason: 'tool_calls',
  };
}

export class FakeTransport implements UserTransport {
  readonly messages: StoredMessage[] = [];
  readonly tasks: TaskDetail[] = [];

  sendMessage(message: StoredMessage): void {
    this.messages.push(message);
  }

  sendTaskResult(task: TaskDetail): void {
    this.tasks.push(task);
  }
}

export async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export function lastUserText(request: CompletionRequest): string {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (message?.role === 'user') return message.content;
  }
  return '';
}
