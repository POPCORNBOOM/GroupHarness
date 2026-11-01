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

export interface TaskResultPromptInput {
  taskId: string;
  tooltype: string;
  status: string;
  result?: unknown;
  error?: string;
  publisherId: string;
}

const permissionRule = (permission: FilePermission, value: FilePermission['read']): string => {
  if (value === 'deny_all') return 'deny all';
  if (value === undefined) return permission.default === 'deny_all' ? 'deny all' : 'allow all';
  return value.length === 0 ? 'allow all' : value.join(', ');
};

const renderPermission = (permission: FilePermission): string => {
  const parts = [
    `read: ${permissionRule(permission, permission.read)}`,
    `write: ${permissionRule(permission, permission.write)}`,
    `execute: ${permissionRule(permission, permission.execute)}`,
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

const BACKGROUND_TASKS = `run_command_async starts a task and returns immediately. Its result later arrives as a task result event. list_tasks and get_task read task state; a private task is visible only to its publisher, its listeners, and admins.`;

const howToAct = (maxToolRounds: number): string => `You are woken by group events. A user message starting with "New messages. Review the chat history." is group history, not your private memory.
- To speak in the group you MUST call send_message. Text you produce without that tool call is never delivered.
- Mention a member as @<member_id>.
- A turn may use several tool calls; the harness stops the loop after ${maxToolRounds} rounds.
- A wake may append several user messages sharing the same Round #; treat them as one batch and reply once.
- When a task_result answers something you asked for, act on it rather than starting the same task again.
- Be brief unless the conversation asks for detail.`;

const filesAndCommands = (input: SystemPromptInput): string => `Your working directory is: ${input.workingDirectory}
File permission enforced by the harness: ${renderPermission(input.filePermission)}
Relative paths resolve against the working directory. Operations outside the policy are denied; report the limitation instead of retrying.
${input.businessTools.length > 0 ? `Business tools enabled for you: ${input.businessTools.join(', ')}.` : 'No business tools are enabled for you.'}
${input.truncated ? '\nEarlier turns were truncated to keep the context within its window.' : ''}`;

export function systemPrompt(input: SystemPromptInput): string {
  return [
    `You are "${input.agentId}", an agent member of the group "${input.groupName}" (group_id: ${input.groupId}).`,
    `## Members\n${bulletMembers(input.members)}`,
    `## How to act\n${howToAct(input.maxToolRounds)}`,
    `## Background tasks\n${BACKGROUND_TASKS}`,
    `## Files and commands\n${filesAndCommands(input)}`,
  ].join('\n\n');
}

export function taskResultPrompt(input: TaskResultPromptInput): string {
  const intro =
    `A background task of type ${input.tooltype}, published by ${input.publisherId} (task id: ${input.taskId}), ` +
    'named you as one of its result recipients. ' +
    `The task status is ${input.status}.`;
  if (input.status !== 'done') {
    return `${intro} Error: ${input.error ?? 'unknown'}`;
  }
  return `${intro} The result is:\n${renderJson(input.result)}`;
}

export const RESTART_PROMPT = `The harness restarted. Your context was restored; events that were pending before the restart are delivered with this wake-up.`;

/** Render a message for the history section; unknown kinds are never injected. */
export function injectableText(line: HistoryLine): string | undefined {
  if (line.kind === 'user_message' || line.kind === 'agent_message' || line.kind === 'system_restart') {
    return line.text;
  }
  return undefined;
}
