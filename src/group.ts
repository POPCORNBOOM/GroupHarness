/**
 * A group owns chat history, the task flow, the persistent delivery queue, its
 * members, and its agent runtimes. The public surface is what IM adapters and
 * tools see; administrative writes live on {@link GroupAdmin}, which only the
 * console holds and which requires an explicit `bypass_permission` guard.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AuditLog } from './audit';
import {
  ensureWorkingDirectory,
  loadAgentConfig,
  maskKey,
  parseTomlText,
  resolveConfig,
  saveAgentConfigLayer,
  validateAgentConfigLayer,
  writeFileAtomic,
  type AgentConfigLayer,
  type FilePermission,
  type GlobalConfig,
  type ModelConfig,
  type ResolvedConfig,
} from './config';
import {
  groupConfigLayer,
  loadGroupMeta,
  parseGroupMeta,
  serializeGroupMeta,
  type GroupMeta,
  type ListenConfig,
  type MemberMeta,
  type ResponsePolicy,
} from './meta';
import {
  buildPermissionState,
  checkPermission,
  identityGroupsOf,
  SYSTEM_MEMBER,
  type PermissionId,
  type PermissionState,
} from './permissions';
import { injectableText, type PromptMember } from './prompts';
import {
  GroupStore,
  type MessageContent,
  type MessageKind,
  type SearchOptions,
  type SearchPage,
  type StoredMessage,
  type TaskRecord,
  type TaskVisibility,
} from './storage';
import { AgentRuntime, type AgentHost } from './agent';
import {
  buildToolRegistry,
  ToolError,
  type AttentionInput,
  type AttentionView,
  type TaskDetail,
  type TaskSummary,
  type ToolGroupApi,
} from './tools';
import type { LlmLike } from './llm';

export interface UserTransport {
  sendMessage(message: StoredMessage): void;
  sendTaskResult(task: TaskDetail): void;
}

export interface GroupOpenOptions {
  dir: string;
  id: string;
  rootDir: string;
  globalConfig: () => GlobalConfig;
  audit: AuditLog;
  llm: LlmLike;
  /** A control-plane process opens the store without running agents. */
  runtime: boolean;
}

export interface MemberView {
  id: string;
  type: 'user' | 'agent';
  admin: boolean;
  identityGroups: string[];
  listen?: ListenConfig;
}

export interface GroupView {
  id: string;
  name: string;
  admins: string[];
  members: MemberView[];
  identityGroups: Record<string, string[]>;
  permissions: Partial<Record<PermissionId, string[]>>;
  policies: ResponsePolicy[];
  model: ModelConfig;
  filePermission: FilePermission;
  workingDirectory: string;
}

export interface AgentView {
  id: string;
  model: ModelConfig;
  tools: string[];
  filePermission: FilePermission;
  workingDirectory: string;
}

function mention(text: string, memberId: string): boolean {
  const escaped = memberId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`@${escaped}(?![A-Za-z0-9_-])`).test(text);
}

function asHistory(messages: StoredMessage[]): { seq: number; sender_id: string; kind: string; text: string }[] {
  const out: { seq: number; sender_id: string; kind: string; text: string }[] = [];
  for (const message of messages) {
    const line = { seq: message.id, sender_id: message.sender_id, kind: message.kind, text: message.text };
    if (injectableText(line) !== undefined) out.push(line);
  }
  return out;
}

function taskSummary(task: TaskRecord): TaskSummary {
  return {
    taskId: task.taskId,
    tooltype: task.tooltype,
    status: task.status,
    visibility: task.visibility,
    publisherId: task.publisherId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

const DEFAULT_ATTENTION_TTL_MS = 2 * 60_000;
const MIN_ATTENTION_TTL_MS = 1_000;
const MAX_ATTENTION_TTL_MS = 10 * 60_000;

interface AttentionGrant {
  members: string[];
  groups: string[];
  ttlMs: number;
  deadline: number;
}

function taskDetail(task: TaskRecord): TaskDetail {
  return {
    ...taskSummary(task),
    listeners: [...task.listeners],
    args: task.args,
    result: task.result,
    error: task.error,
  };
}

export class Group {
  private meta: GroupMeta;
  private readonly members = new Map<string, MemberMeta>();
  private permissionState: PermissionState;
  private readonly agents = new Map<string, AgentRuntime>();
  private readonly transports = new Map<string, UserTransport>();
  private readonly attention = new Map<string, AttentionGrant>();
  private readonly metaPath: string;
  private started = false;
  private closed = false;

  private constructor(
    readonly id: string,
    readonly dir: string,
    readonly rootDir: string,
    readonly store: GroupStore,
    private readonly options: GroupOpenOptions,
    meta: GroupMeta,
  ) {
    this.meta = meta;
    this.metaPath = join(dir, 'meta.toml');
    this.permissionState = buildPermissionState(meta.admins, meta.identity_groups, meta.permissions);
    this.indexMembers();
  }

  static open(options: GroupOpenOptions): Group {
    const meta = loadGroupMeta(join(options.dir, 'meta.toml'), options.id);
    const store = GroupStore.open(options.dir);
    const group = new Group(options.id, options.dir, options.rootDir, store, options, meta);
    try {
      group.validateStartup();
      if (options.runtime) store.resetProcessing();
      group.syncRuntimes();
    } catch (error) {
      store.close();
      throw error;
    }
    return group;
  }

  // ---------------------------------------------------------------- reads

  get name(): string {
    return this.meta.name;
  }

  memberType(memberId: string): 'user' | 'agent' | undefined {
    return this.members.get(memberId)?.type;
  }

  checkPermission(memberId: string, permission: PermissionId): boolean {
    return checkPermission(this.permissionState, memberId, permission);
  }

  isAdmin(memberId: string): boolean {
    return this.meta.admins.includes(memberId);
  }

  view(): GroupView {
    const config = this.resolveGroupConfig();
    return {
      id: this.id,
      name: this.meta.name,
      admins: [...this.meta.admins],
      members: this.meta.members.map((member) => ({
        id: member.id,
        type: member.type,
        admin: this.meta.admins.includes(member.id),
        identityGroups: identityGroupsOf(this.permissionState, member.id),
        ...(member.listen === undefined ? {} : { listen: member.listen }),
      })),
      identityGroups: Object.fromEntries(
        Object.entries(this.meta.identity_groups).map(([key, ids]) => [key, [...ids]]),
      ),
      permissions: Object.fromEntries(
        Object.entries(this.meta.permissions).map(([key, groups]) => [key, [...groups]]),
      ) as Partial<Record<PermissionId, string[]>>,
      policies: this.meta.policies.map((policy) => ({ ...policy })),
      model: { ...config.model, apikey: maskKey(config.model.apikey) },
      filePermission: config.filePermission,
      workingDirectory: config.workingDirectory,
    };
  }

  agentView(agentId: string): AgentView | undefined {
    if (this.members.get(agentId)?.type !== 'agent') return undefined;
    const config = this.resolveAgentConfig(agentId);
    return {
      id: agentId,
      model: { ...config.model, apikey: maskKey(config.model.apikey) },
      tools: this.businessToolsFor(agentId),
      filePermission: config.filePermission,
      workingDirectory: config.workingDirectory,
    };
  }

  latestMessages(limit: number): StoredMessage[] {
    return this.store.latestMessages(limit);
  }

  searchMessages(readerId: string, options: SearchOptions): SearchPage {
    this.requireMember(readerId);
    return this.store.searchMessages(options);
  }

  /** Console search: no member identity, no visibility filter (group chat is group-wide). */
  consoleSearch(options: SearchOptions): SearchPage {
    return this.store.searchMessages(options);
  }

  /** Tasks visible to a member, with results omitted (the result channel is separate). */
  listTasks(readerId: string, limit = 100): TaskSummary[] {
    this.requireMember(readerId);
    return this.store
      .listTasks(limit)
      .filter((task) => this.canSeeTask(readerId, task))
      .map(taskSummary);
  }

  getTask(readerId: string, taskId: string): TaskDetail | undefined {
    this.requireMember(readerId);
    const task = this.store.getTask(taskId);
    if (task === undefined || !this.canSeeTask(readerId, task)) return undefined;
    if (this.isAdmin(readerId) && task.visibility === 'private' && !this.ownsTask(readerId, task)) {
      this.options.audit.record({
        actor: readerId,
        group_id: this.id,
        action: 'read_private_task',
        target: taskId,
        ok: true,
      });
    }
    return taskDetail(task);
  }

  /** Everything a console may list; results are omitted. */
  adminTasks(limit = 100): TaskSummary[] {
    return this.store.listTasks(limit).map(taskSummary);
  }

  /** A console detail read; reading a private task is audited as a system action. */
  adminTaskDetail(taskId: string): TaskDetail | undefined {
    const task = this.store.getTask(taskId);
    if (task === undefined) return undefined;
    if (task.visibility === 'private') {
      this.options.audit.record({
        actor: 'system',
        group_id: this.id,
        action: 'read_private_task',
        target: taskId,
        ok: true,
      });
    }
    return taskDetail(task);
  }

  // ----------------------------------------------------------- message flow

  /**
   * Send a chat message. Task events never pass through here; they use the
   * task channel via {@link completeTask}.
   */
  send(senderId: string, text: string, kind: MessageKind, source: string): number {
    if (this.closed) throw new Error('group store is closed');
    if (senderId === SYSTEM_MEMBER) throw new Error('system messages use the internal restart path');
    const member = this.members.get(senderId);
    if (member === undefined) throw new Error(`unknown member "${senderId}"`);
    if (text.trim() === '') throw new Error('message text must not be empty');
    const expected: MessageKind = member.type === 'user' ? 'user_message' : 'agent_message';
    if (kind !== expected) throw new Error(`member "${senderId}" cannot send kind "${kind}"`);

    const now = new Date().toISOString();
    const content: MessageContent = {
      kind,
      sender_id: senderId,
      source,
      task_id: null,
      timestamp: now,
      text,
    };
    let affected: string[] = [];
    const messageId = this.store.withTransaction(() => {
      const id = this.store.insertMessage({ sender_id: senderId, kind, content, created_at: now });
      affected = this.enqueueDispatch(id, senderId, member.type, kind, text, now);
      return id;
    });
    const stored = this.store.getMessage(messageId);
    if (stored !== undefined) this.deliverToUsers(stored, senderId);
    for (const agentId of affected) this.kick(agentId);
    return messageId;
  }

  /** Send as an agent and optionally set a temporary extra wake scope. */
  sendWithAttention(
    agentId: string,
    text: string,
    input: AttentionInput,
  ): { message_id: number; attention?: AttentionView } {
    const grant = this.buildAttention(agentId, input);
    const id = this.send(agentId, text, 'agent_message', `agent:${agentId}`);
    if (grant === null) {
      this.attention.delete(agentId);
      return { message_id: id };
    }
    this.attention.set(agentId, grant);
    return {
      message_id: id,
      attention: {
        members: [...grant.members],
        groups: [...grant.groups],
        expires_at: new Date(grant.deadline).toISOString(),
        ttl_ms: grant.ttlMs,
      },
    };
  }

  /** Internal system notification used on startup; bypasses listen filters. */
  deliverRestart(): void {
    if (this.closed) return;
    const now = new Date().toISOString();
    const text = 'Group Harness restarted.';
    const content: MessageContent = {
      kind: 'system_restart',
      sender_id: SYSTEM_MEMBER,
      source: 'system',
      task_id: null,
      timestamp: now,
      text,
    };
    const agents: string[] = [];
    const messageId = this.store.withTransaction(() => {
      const id = this.store.insertMessage({
        sender_id: SYSTEM_MEMBER,
        kind: 'system_restart',
        content,
        created_at: now,
      });
      for (const member of this.members.values()) {
        if (member.type !== 'agent') continue;
        this.store.enqueue(member.id, 'system_restart', { kind: 'system_restart' }, now);
        agents.push(member.id);
      }
      return id;
    });
    const stored = this.store.getMessage(messageId);
    if (stored !== undefined) {
      for (const member of this.members.values()) {
        if (member.type !== 'user') continue;
        try {
          this.transports.get(member.id)?.sendMessage(stored);
        } catch (error) {
          console.error(`[${this.id}] restart delivery to ${member.id} failed: ${(error as Error).message}`);
        }
      }
    }
    for (const agentId of agents) this.kick(agentId);
  }

  private buildAttention(agentId: string, input: AttentionInput): AttentionGrant | null {
    const members = [...new Set(input.members ?? [])];
    const groups = [...new Set(input.groups ?? [])];
    for (const member of members) {
      if (member === agentId) throw new ToolError('failed', 'cannot expect messages from yourself');
      if (!this.members.has(member)) throw new ToolError('failed', `unknown member "${member}"`);
    }
    for (const key of groups) {
      if (!(key in this.meta.identity_groups)) throw new ToolError('failed', `unknown identity group "${key}"`);
    }
    if (members.length === 0 && groups.length === 0) return null;
    const requested = input.ttl_ms ?? DEFAULT_ATTENTION_TTL_MS;
    if (typeof requested !== 'number' || !Number.isFinite(requested)) {
      throw new ToolError('failed', 'expect.ttl_ms must be a finite number');
    }
    const ttlMs = Math.min(Math.max(Math.floor(requested), MIN_ATTENTION_TTL_MS), MAX_ATTENTION_TTL_MS);
    return { members, groups, ttlMs, deadline: Date.now() + ttlMs };
  }

  attachTransport(userId: string, transport: UserTransport): void {
    if (this.members.get(userId)?.type !== 'user') throw new Error(`member "${userId}" is not a user`);
    this.transports.set(userId, transport);
  }

  detachTransport(userId: string): void {
    this.transports.delete(userId);
  }

  // ------------------------------------------------------------- task flow

  startTask(
    publisherId: string,
    tooltype: string,
    args: Record<string, unknown>,
    listeners: string[] | undefined,
    visibility: TaskVisibility,
  ): string {
    if (this.closed) throw new ToolError('failed', 'group store is closed');
    const publisher = this.members.get(publisherId);
    if (publisher === undefined || publisher.type !== 'agent') {
      throw new ToolError('failed', 'only agents can publish background tasks');
    }
    const uniqueListeners: string[] = [];
    for (const listener of listeners ?? []) {
      if (!this.members.has(listener)) throw new ToolError('failed', `unknown listener "${listener}"`);
      if (!uniqueListeners.includes(listener)) uniqueListeners.push(listener);
    }
    const runtime = this.agents.get(publisherId);
    if (runtime === undefined) throw new ToolError('failed', 'agent runtime is not running in this process');
    let definition;
    try {
      definition = buildToolRegistry(this.businessToolsFor(publisherId)).get(tooltype);
    } catch (error) {
      throw new ToolError('failed', (error as Error).message);
    }
    if (definition === undefined || definition.async !== true) {
      throw new ToolError('failed', `tool "${tooltype}" is not an async tool`);
    }
    const now = new Date().toISOString();
    const taskId = randomUUID();
    this.store.insertTask({
      taskId,
      tooltype,
      args,
      publisherId,
      listeners: uniqueListeners,
      visibility,
      status: 'pending',
      result: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    });
    setImmediate(() => {
      void runtime.runTask(taskId, tooltype, args);
    });
    return taskId;
  }

  markTaskRunning(taskId: string): void {
    if (this.closed) return;
    this.store.updateTask(taskId, { status: 'running', updatedAt: new Date().toISOString() });
  }

  /** Finish a task and push its result through the independent channel. */
  completeTask(taskId: string, status: 'done' | 'failed', result?: unknown, error?: string): void {
    if (this.closed) return;
    const task = this.store.getTask(taskId);
    if (task === undefined) return;
    const now = new Date().toISOString();
    const recipients = new Set<string>([task.publisherId, ...task.listeners]);
    if (task.visibility === 'public') {
      for (const member of this.members.values()) recipients.add(member.id);
    }
    const agentRecipients = [...recipients].filter((id) => this.members.get(id)?.type === 'agent');
    const userRecipients = [...recipients].filter((id) => this.members.get(id)?.type === 'user');
    const payload = {
      kind: 'task_result',
      task_id: taskId,
      tooltype: task.tooltype,
      status,
      publisher_id: task.publisherId,
      visibility: task.visibility,
      result: status === 'done' ? (result ?? null) : null,
      error: status === 'failed' ? (error ?? 'unknown error') : null,
    };
    this.store.withTransaction(() => {
      this.store.updateTask(taskId, {
        status,
        result: status === 'done' ? (result ?? null) : null,
        error: status === 'failed' ? (error ?? 'unknown error') : null,
        updatedAt: now,
      });
      for (const agentId of agentRecipients) {
        this.store.enqueue(agentId, 'task_result', payload, now);
      }
    });
    const updated = this.store.getTask(taskId);
    const detail = updated === undefined ? undefined : taskDetail(updated);
    if (detail !== undefined) {
      for (const userId of userRecipients) {
        try {
          this.transports.get(userId)?.sendTaskResult(detail);
        } catch (transportError) {
          console.error(`[${this.id}] task result delivery to ${userId} failed: ${(transportError as Error).message}`);
        }
      }
    }
    for (const agentId of agentRecipients) this.kick(agentId);
  }

  /** A crash leaves tasks pending/running; fail them and deliver the result. */
  recoverInterruptedTasks(): void {
    for (const task of this.store.listTasks(1_000)) {
      if (task.status === 'pending' || task.status === 'running') {
        this.completeTask(task.taskId, 'failed', undefined, 'interrupted by restart');
      }
    }
  }

  // ------------------------------------------------------------- lifecycle

  /** Start every agent runtime (called after the restart notification is queued). */
  startAgents(): void {
    if (!this.options.runtime) return;
    this.started = true;
    for (const runtime of this.agents.values()) runtime.start();
  }

  async stopAgents(): Promise<void> {
    this.started = false;
    await Promise.all([...this.agents.values()].map((runtime) => runtime.stop()));
  }

  async waitIdle(timeoutMs = 10_000): Promise<void> {
    await Promise.all([...this.agents.values()].map((runtime) => runtime.awaitIdle(timeoutMs)));
  }

  /** Stop accepting writes and close the attached databases. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.store.close();
  }

  // --------------------------------------------------------- config/internals

  resolveGroupConfig(): ResolvedConfig {
    return resolveConfig(this.options.globalConfig(), this.rootDir, groupConfigLayer(this.meta), {});
  }

  resolveAgentConfig(agentId: string): ResolvedConfig {
    if (this.members.get(agentId)?.type !== 'agent') throw new Error(`"${agentId}" is not an agent`);
    return resolveConfig(
      this.options.globalConfig(),
      this.rootDir,
      groupConfigLayer(this.meta),
      loadAgentConfig(this.agentConfigPath(agentId)),
    );
  }

  businessToolsFor(agentId: string): string[] {
    return loadAgentConfig(this.agentConfigPath(agentId)).tools ?? [];
  }

  agentConfigPath(agentId: string): string {
    return join(this.dir, 'agents', agentId, 'config.toml');
  }

  contextPath(agentId: string): string {
    return join(this.dir, 'agents', agentId, 'context.jsonl');
  }

  /** The only group surface tools may touch; the caller id is bound here. */
  agentApi(agentId: string): ToolGroupApi {
    return {
      send: (text) => this.send(agentId, text, 'agent_message', `agent:${agentId}`),
      sendWithAttention: (text, input) => this.sendWithAttention(agentId, text, input),
      searchMessages: (options) => this.searchMessages(agentId, options),
      listTasks: () => this.listTasks(agentId).slice(0, 100),
      getTask: (taskId) => this.getTask(agentId, taskId),
      startTask: (tooltype, args, listeners, visibility) =>
        this.startTask(agentId, tooltype, args, listeners, visibility),
    };
  }

  private requireMember(memberId: string): MemberMeta {
    const member = this.members.get(memberId);
    if (member === undefined) throw new Error(`unknown member "${memberId}"`);
    return member;
  }

  private ownsTask(readerId: string, task: TaskRecord): boolean {
    return task.publisherId === readerId || task.listeners.includes(readerId);
  }

  private canSeeTask(readerId: string, task: TaskRecord): boolean {
    if (readerId === SYSTEM_MEMBER || this.isAdmin(readerId)) return true;
    if (this.ownsTask(readerId, task)) return true;
    if (task.visibility === 'public') return true;
    return this.checkPermission(readerId, 'read_private_task');
  }

  private indexMembers(): void {
    this.members.clear();
    for (const member of this.meta.members) this.members.set(member.id, member);
    this.permissionState = buildPermissionState(this.meta.admins, this.meta.identity_groups, this.meta.permissions);
  }

  private validateStartup(): void {
    ensureWorkingDirectory(this.resolveGroupConfig().workingDirectory);
    for (const member of this.meta.members) {
      if (member.type !== 'agent') continue;
      const config = this.resolveAgentConfig(member.id);
      ensureWorkingDirectory(config.workingDirectory);
      const tools = this.businessToolsFor(member.id);
      buildToolRegistry(tools);
    }
  }

  private syncRuntimes(): void {
    if (!this.options.runtime) return;
    for (const member of this.meta.members) {
      if (member.type !== 'agent') continue;
      if (this.agents.has(member.id)) continue;
      const runtime = this.createRuntime(member.id);
      this.agents.set(member.id, runtime);
      if (this.started) runtime.start();
    }
  }

  private createRuntime(agentId: string): AgentRuntime {
    const api = this.agentApi(agentId);
    const host: AgentHost = {
      groupId: this.id,
      groupName: () => this.meta.name,
      contextPath: this.contextPath(agentId),
      members: () => this.promptMembers(),
      resolveConfig: () => this.resolveAgentConfig(agentId),
      businessTools: () => this.businessToolsFor(agentId),
      groupApi: () => api,
      takePending: () => (this.closed ? [] : this.store.takePending(agentId)),
      countPending: () => (this.closed ? 0 : this.store.countPending(agentId)),
      markQueue: (ids, status, error) => {
        if (!this.closed) this.store.markQueueStatus(ids, status, error);
      },
      markTaskRunning: (taskId) => this.markTaskRunning(taskId),
      completeTask: (taskId, status, result, error) => this.completeTask(taskId, status, result, error),
      onAgentError: (error) => {
        console.error(`[${this.id}/${agentId}] wake failed: ${(error as Error).message}`);
      },
    };
    return new AgentRuntime({ agentId, host, llm: this.options.llm });
  }

  private promptMembers(): PromptMember[] {
    return this.meta.members.map((member) => ({
      id: member.id,
      type: member.type,
      admin: this.meta.admins.includes(member.id),
    }));
  }

  private kick(agentId: string): void {
    if (!this.started) return;
    this.agents.get(agentId)?.kick();
  }

  private deliverToUsers(message: StoredMessage, senderId: string): void {
    for (const member of this.meta.members) {
      if (member.type !== 'user' || member.id === senderId) continue;
      const transport = this.transports.get(member.id);
      if (transport === undefined) continue;
      if (!this.listenMatches(member, message)) continue;
      try {
        transport.sendMessage(message);
      } catch (error) {
        console.error(`[${this.id}] message delivery to ${member.id} failed: ${(error as Error).message}`);
      }
    }
  }

  private listenMatches(member: MemberMeta, message: StoredMessage): boolean {
    if (message.sender_id === member.id) return false;
    if (message.sender_id === SYSTEM_MEMBER) return false;
    if (message.kind === 'system_restart') return false;
    const listen = member.listen;
    if (listen === undefined || listen.mode === 'all') return true;
    const senderHit = listen.senders.includes(message.sender_id);
    const kindHit = listen.kinds.includes(message.kind as MessageKind);
    if (listen.mode === 'blacklist') return !senderHit && !kindHit;
    const senderOk = listen.senders.length === 0 || senderHit;
    const kindOk = listen.kinds.length === 0 || kindHit;
    return senderOk && kindOk;
  }

  private enqueueDispatch(
    messageId: number,
    senderId: string,
    senderType: 'user' | 'agent',
    kind: MessageKind,
    text: string,
    now: string,
  ): string[] {
    const matches = new Map<string, number>();
    for (const policy of this.meta.policies) {
      if (policy.agent === senderId) continue;
      if (this.members.get(policy.agent)?.type !== 'agent') continue;
      if (policy.sender_type !== 'all' && policy.sender_type !== senderType) continue;
      if (policy.trigger_mode === 'mention' && !mention(text, policy.agent)) continue;
      matches.set(policy.agent, Math.max(matches.get(policy.agent) ?? 0, policy.context_before));
    }
    const nowMs = Date.now();
    for (const [agentId, grant] of this.attention) {
      if (grant.deadline <= nowMs) {
        this.attention.delete(agentId);
        continue;
      }
      if (agentId === senderId) continue;
      if (this.members.get(agentId)?.type !== 'agent') {
        this.attention.delete(agentId);
        continue;
      }
      const memberHit = grant.members.includes(senderId);
      const groupHit =
        grant.groups.length > 0 &&
        identityGroupsOf(this.permissionState, senderId).some((key) => grant.groups.includes(key));
      if (memberHit || groupHit) {
        if (!matches.has(agentId)) matches.set(agentId, 0);
      }
    }
    for (const [agentId, contextBefore] of matches) {
      const limit = Math.min(Math.max(contextBefore, 0), 200);
      const history = limit === 0 ? [] : asHistory(this.store.messagesBefore(messageId, limit));
      this.store.enqueue(
        agentId,
        'chat',
        {
          kind: 'chat',
          trigger: { seq: messageId, sender_id: senderId, kind, text },
          history,
          context_before: limit,
        },
        now,
      );
    }
    return [...matches.keys()];
  }

  // ---------------------------------------------------------- admin support

  /** Validate and persist a whole meta object, then rebuild derived state. */
  replaceMeta(candidate: GroupMeta): GroupMeta {
    const text = serializeGroupMeta(candidate);
    const validated = parseGroupMeta(this.metaPath, parseTomlText(this.metaPath, text), this.id);
    ensureWorkingDirectory(
      resolveConfig(this.options.globalConfig(), this.rootDir, groupConfigLayer(validated), {}).workingDirectory,
    );
    for (const member of validated.members) {
      if (member.type !== 'agent') continue;
      const config = resolveConfig(
        this.options.globalConfig(),
        this.rootDir,
        groupConfigLayer(validated),
        loadAgentConfig(this.agentConfigPath(member.id)),
      );
      ensureWorkingDirectory(config.workingDirectory);
      buildToolRegistry(loadAgentConfig(this.agentConfigPath(member.id)).tools ?? []);
    }
    writeFileAtomic(this.metaPath, text);
    this.meta = validated;
    this.indexMembers();
    this.syncRuntimes();
    if (this.started) {
      for (const member of this.meta.members) {
        if (member.type === 'agent') this.kick(member.id);
      }
    }
    return validated;
  }

  metaSnapshot(): GroupMeta {
    return structuredClone(this.meta);
  }

  readAgentLayer(agentId: string): AgentConfigLayer {
    return loadAgentConfig(this.agentConfigPath(agentId));
  }

  writeAgentLayer(agentId: string, layer: AgentConfigLayer): void {
    validateAgentConfigLayer(this.agentConfigPath(agentId), layer);
    const config = resolveConfig(
      this.options.globalConfig(),
      this.rootDir,
      groupConfigLayer(this.meta),
      layer,
    );
    ensureWorkingDirectory(config.workingDirectory);
    buildToolRegistry(layer.tools ?? []);
    saveAgentConfigLayer(this.agentConfigPath(agentId), layer);
  }

  reloadMeta(): void {
    this.meta = loadGroupMeta(this.metaPath, this.id);
    this.indexMembers();
    this.validateStartup();
    this.syncRuntimes();
  }
}
