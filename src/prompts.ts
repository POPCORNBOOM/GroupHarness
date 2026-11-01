/**
 * Every prompt string the harness sends to a model lives here, so the wording
 * can be reviewed in one place. Context blocks intentionally use the markup
 * from the design doc: they are group chat history, never agent memory.
 */
import type { FilePermission } from './config';

export interface PromptMember {
  id: string;
  type: 'user' | 'agent';
  admin: boolean;
}

export interface HistoryLine {
  seq: number;
  sender_id: string;
  kind: string;
  text: string;
}

export interface SystemPromptInput {
  agentId: string;
  groupId: string;
  groupName: string;
  members: PromptMember[];
  businessTools: string[];
  workingDirectory: string;
  filePermission: FilePermission;
  maxToolRounds: number;
  truncated: boolean;
}

export interface ChatBlockInput {
  history: HistoryLine[];
  trigger: HistoryLine;
  index?: number;
  total?: number;
}

export interface TaskResultPromptInput {
  taskId: string;
  tooltype: string;
  status: string;
  result?: unknown;
  error?: string;
  publisherId: string;
}

const renderPermission = (permission: FilePermission): string => {
  const rule = (value: FilePermission['read']): string => {
    if (value === 'deny_all') return 'deny all';
    if (value === undefined) return permission.default === 'deny_all' ? 'deny all' : 'allow all';
    return value.length === 0 ? 'allow all' : value.join(', ');
  };
  const parts = [
    `read: ${rule(permission.read)}`,
    `write: ${rule(permission.write)}`,
    `execute: ${rule(permission.execute)}`,
  ];
  if (permission.deny !== undefined && permission.deny.length > 0) {
    parts.push(`deny (wins): ${permission.deny.join(', ')}`);
  }
  return parts.join('; ');
};

const bulletMembers = (members: PromptMember[]): string =>
  members
    .map((member) => `- ${member.id} (${member.type}${member.admin ? ', admin' : ''})`)
    .join('\n');

const renderJson = (value: unknown): string => {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
};

/** Named prompt fragments; functions keep values next to their wording. */
export const PROMPTS = {
  historyHeader: '[群聊历史记录]',
  triggerHeader: '[当前触发消息]',
  triggerSection: (index: number, total: number): string =>
    total > 1 ? `[触发消息 ${index}/${total}]` : '',

  historyLine: (line: HistoryLine): string => `${line.seq} ${line.sender_id}: ${line.text}`,

  system: (input: SystemPromptInput): string => `You are "${input.agentId}", an agent member of the group "${input.groupName}" (group_id: ${input.groupId}).

## Members
${bulletMembers(input.members)}

## How to act
You are woken by group events. A block labelled [群聊历史记录] is reference material from the group, not your private memory.
- To speak in the group you MUST call send_message. Text you produce without that tool call is never delivered.
- Mention a member as @<member_id>.
- A turn may use several tool calls; the harness stops the loop after ${input.maxToolRounds} rounds.
- When a task_result answers something you asked for, act on it rather than starting the same task again.
- Be brief unless the conversation asks for detail.

## Background tasks
run_command_async starts a task and returns immediately. Its result later arrives as a [任务结果] event. list_tasks and get_task read task state; a private task is visible only to its publisher, its listeners, and admins.

## Files and commands
Your working directory is: ${input.workingDirectory}
File permission enforced by the harness: ${renderPermission(input.filePermission)}
Relative paths resolve against the working directory. Operations outside the policy are denied; report the limitation instead of retrying.
${input.businessTools.length > 0 ? `Business tools enabled for you: ${input.businessTools.join(', ')}.` : 'No business tools are enabled for you.'}
${input.truncated ? '\nEarlier turns were truncated to keep the context within its window.' : ''}`,

  chatBlock: (input: ChatBlockInput): string => {
    const section = PROMPTS.triggerSection(input.index ?? 1, input.total ?? 1);
    const lines = input.history.map((line) => PROMPTS.historyLine(line)).join('\n');
    return [
      section,
      PROMPTS.historyHeader,
      lines,
      PROMPTS.triggerHeader,
      PROMPTS.historyLine(input.trigger),
    ]
      .filter((part) => part !== '')
      .join('\n');
  },

  taskResult: (input: TaskResultPromptInput): string => {
    const body =
      input.status === 'done'
        ? `result:\n${renderJson(input.result)}`
        : `error: ${input.error ?? 'unknown'}`;
    return [
      '[任务结果]',
      `task_id: ${input.taskId}`,
      `tooltype: ${input.tooltype}`,
      `status: ${input.status}`,
      `publisher: ${input.publisherId}`,
      body,
    ].join('\n');
  },

};

/** Render a message for the history section; unknown kinds are never injected. */
export function injectableText(line: HistoryLine): string | undefined {
  if (line.kind === 'user_message' || line.kind === 'agent_message') {
    return line.text;
  }
  return undefined;
}
