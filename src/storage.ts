/**
 * Per-group persistence. One SQLite connection with `tasks` and `queue`
 * ATTACHed so a message insert and its dispatch entries commit in one
 * transaction (and a task update and its result deliveries do too).
 *
 * SQLite is synchronous here on purpose: the process is single-threaded, and
 * synchronous statements make transaction boundaries obvious.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';

export type MessageKind = 'user_message' | 'agent_message' | 'system_restart';

export interface MessageContent {
  kind: MessageKind;
  sender_id: string;
  source: string;
  task_id: string | null;
  timestamp: string;
  text: string;
}

export interface StoredMessage {
  id: number;
  sender_id: string;
  kind: string;
  text: string;
  source: string;
  created_at: string;
}

export type QueueStatus = 'pending' | 'processing' | 'done' | 'failed';

export interface QueueItem {
  id: number;
  targetAgentId: string;
  kind: string;
  payload: unknown;
  createdAt: string;
  status: QueueStatus;
}

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed';
export type TaskVisibility = 'private' | 'public';

export interface TaskRecord {
  taskId: string;
  tooltype: string;
  args: unknown;
  publisherId: string;
  listeners: string[];
  visibility: TaskVisibility;
  status: TaskStatus;
  result: unknown;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SearchOptions {
  query: string;
  since?: string;
  until?: string;
  cursor?: number;
  limit?: number;
}

export interface SearchPage {
  messages: StoredMessage[];
  nextCursor: number | null;
}

const SEARCH_DEFAULT = 50;
const SEARCH_MAX = 200;

const MESSAGES_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_created_at ON messages(created_at);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text)
  VALUES (new.id, coalesce(json_extract(new.content, '$.text'), ''));
END;
`;

const TASKS_SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks.tasks (
  task_id TEXT PRIMARY KEY,
  tooltype TEXT NOT NULL,
  args TEXT NOT NULL,
  publisher_id TEXT NOT NULL,
  listeners TEXT NOT NULL,
  visibility TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks.tasks_status ON tasks(status, created_at);
`;

const QUEUE_SCHEMA = `
CREATE TABLE IF NOT EXISTS queue.queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS queue.queue_target_status ON queue(target_agent_id, status, id);
`;

/** Version 2 moved task/queue tables out of messages.db into their own files. */
const MESSAGES_VERSION = 2;
const TASKS_VERSION = 1;
const QUEUE_VERSION = 1;

function asString(value: SQLOutputValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: SQLOutputValue | undefined): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function messageFromRow(row: Record<string, SQLOutputValue>): StoredMessage {
  const rawContent = asString(row.content);
  const content = parseJson(rawContent) as Partial<MessageContent> | null;
  return {
    id: asNumber(row.id),
    sender_id: asString(row.sender_id),
    kind: asString(row.kind),
    text: typeof content?.text === 'string' ? content.text : '',
    source: typeof content?.source === 'string' ? content.source : '',
    created_at: asString(row.created_at),
  };
}

function queueFromRow(row: Record<string, SQLOutputValue>): QueueItem {
  return {
    id: asNumber(row.id),
    targetAgentId: asString(row.target_agent_id),
    kind: asString(row.kind),
    payload: parseJson(asString(row.payload)),
    createdAt: asString(row.created_at),
    status: asString(row.status) as QueueStatus,
  };
}

function taskFromRow(row: Record<string, SQLOutputValue>): TaskRecord {
  const listeners = parseJson(asString(row.listeners));
  return {
    taskId: asString(row.task_id),
    tooltype: asString(row.tooltype),
    args: parseJson(asString(row.args)),
    publisherId: asString(row.publisher_id),
    listeners: Array.isArray(listeners) ? listeners.filter((id): id is string => typeof id === 'string') : [],
    visibility: asString(row.visibility) === 'public' ? 'public' : 'private',
    status: asString(row.status) as TaskStatus,
    result: row.result === null || row.result === undefined ? null : parseJson(asString(row.result)),
    error: row.error === null || row.error === undefined ? null : asString(row.error),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

/** Escape a user keyword for an FTS5 phrase query. */
function ftsPhrase(query: string): string {
  return '"' + query.replaceAll('"', '""') + '"';
}

function likePattern(query: string): string {
  return '%' + query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_') + '%';
}

export class GroupStore {
  readonly db: DatabaseSync;
  readonly messagesPath: string;
  readonly tasksPath: string;
  readonly queuePath: string;

  private constructor(db: DatabaseSync, dir: string) {
    this.db = db;
    this.messagesPath = join(dir, 'messages.db');
    this.tasksPath = join(dir, 'tasks.db');
    this.queuePath = join(dir, 'queue.db');
  }

  static open(dir: string): GroupStore {
    mkdirSync(dir, { recursive: true });
    const messagesPath = join(dir, 'messages.db');
    const db = new DatabaseSync(messagesPath);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;');
    db.prepare('ATTACH DATABASE ? AS tasks').run(join(dir, 'tasks.db'));
    db.prepare('ATTACH DATABASE ? AS queue').run(join(dir, 'queue.db'));
    db.exec('PRAGMA tasks.journal_mode=WAL; PRAGMA queue.journal_mode=WAL;');
    const store = new GroupStore(db, dir);
    store.migrate();
    return store;
  }

  private migrate(): void {
    const messagesVersion = this.versionOf('main');
    if (messagesVersion > MESSAGES_VERSION) {
      throw new Error(
        `${this.messagesPath}: schema version ${messagesVersion} is newer than this harness (${MESSAGES_VERSION})`,
      );
    }
    this.db.exec(MESSAGES_SCHEMA);
    if (messagesVersion < MESSAGES_VERSION) {
      // Version 1 created the task/queue tables unqualified, so they landed in
      // messages.db. They are rebuilt in their own files below.
      this.db.exec('DROP TABLE IF EXISTS main.queue; DROP TABLE IF EXISTS main.tasks;');
      this.db.exec(
        `INSERT INTO messages_fts(rowid, text)
         SELECT id, coalesce(json_extract(content, '$.text'), '') FROM messages
         WHERE id NOT IN (SELECT rowid FROM messages_fts)`,
      );
      this.db.exec(`PRAGMA main.user_version = ${MESSAGES_VERSION}`);
    }
    this.ensureAttached('tasks', TASKS_VERSION, TASKS_SCHEMA);
    this.ensureAttached('queue', QUEUE_VERSION, QUEUE_SCHEMA);
  }

  private versionOf(schema: 'main' | 'tasks' | 'queue'): number {
    const row = this.db.prepare(`PRAGMA ${schema}.user_version`).get();
    return row === undefined ? 0 : Number(row.user_version ?? 0);
  }

  private ensureAttached(schema: 'tasks' | 'queue', version: number, ddl: string): void {
    const current = this.versionOf(schema);
    if (current > version) {
      throw new Error(`${this.messagesPath}: ${schema} schema version ${current} is newer than ${version}`);
    }
    this.db.exec(ddl);
    if (current < version) this.db.exec(`PRAGMA ${schema}.user_version = ${version}`);
  }

  close(): void {
    this.db.close();
  }

  /** Run a synchronous function inside one IMMEDIATE transaction. */
  withTransaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // The connection may already be out of a transaction; keep the original error.
      }
      throw error;
    }
  }

  insertMessage(input: {
    sender_id: string;
    kind: MessageKind;
    content: MessageContent;
    created_at: string;
  }): number {
    const result = this.db
      .prepare('INSERT INTO messages(sender_id, kind, content, created_at) VALUES (?, ?, ?, ?)')
      .run(input.sender_id, input.kind, JSON.stringify(input.content), input.created_at);
    return Number(result.lastInsertRowid);
  }

  getMessage(id: number): StoredMessage | undefined {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    return row === undefined ? undefined : messageFromRow(row);
  }

  /** The `limit` newest messages, oldest first. */
  latestMessages(limit: number): StoredMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM (SELECT * FROM messages ORDER BY id DESC LIMIT ?) ORDER BY id ASC')
      .all(limit);
    return rows.map(messageFromRow);
  }

  /** Up to `limit` messages immediately before `id`, oldest first. */
  messagesBefore(id: number, limit: number): StoredMessage[] {
    if (limit <= 0) return [];
    const rows = this.db
      .prepare('SELECT * FROM (SELECT * FROM messages WHERE id < ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC')
      .all(id, limit);
    return rows.map(messageFromRow);
  }

  searchMessages(options: SearchOptions): SearchPage {
    const limit = Math.min(Math.max(options.limit ?? SEARCH_DEFAULT, 1), SEARCH_MAX);
    const query = options.query;
    if (query.length === 0) return { messages: [], nextCursor: null };

    const clauses: string[] = [];
    const params: (string | number)[] = [];
    const useFts = Array.from(query).length >= 3;
    if (useFts) {
      clauses.push('m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)');
      params.push(ftsPhrase(query));
    } else {
      clauses.push("json_extract(m.content, '$.text') LIKE ? ESCAPE '\\'");
      params.push(likePattern(query));
    }
    if (options.cursor !== undefined) {
      clauses.push('m.id > ?');
      params.push(options.cursor);
    }
    if (options.since !== undefined && options.since !== '') {
      clauses.push('m.created_at >= ?');
      params.push(options.since);
    }
    if (options.until !== undefined && options.until !== '') {
      clauses.push('m.created_at <= ?');
      params.push(options.until);
    }
    const sql = `SELECT m.* FROM messages m WHERE ${clauses.join(' AND ')} ORDER BY m.id ASC LIMIT ?`;
    let rows: Record<string, SQLOutputValue>[];
    try {
      rows = this.db.prepare(sql).all(...params, limit + 1);
    } catch (error) {
      if (!useFts) throw error;
      const fallback = sql.replace(clauses[0] ?? '', "json_extract(m.content, '$.text') LIKE ? ESCAPE '\\'");
      rows = this.db.prepare(fallback).all(likePattern(query), ...params.slice(1), limit + 1);
    }
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map(messageFromRow);
    return { messages: page, nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null };
  }

  enqueue(targetAgentId: string, kind: string, payload: unknown, createdAt: string): number {
    const result = this.db
      .prepare('INSERT INTO queue.queue(target_agent_id, kind, payload, created_at, status) VALUES (?, ?, ?, ?, ?)')
      .run(targetAgentId, kind, JSON.stringify(payload), createdAt, 'pending');
    return Number(result.lastInsertRowid);
  }

  /** Take every pending item for one agent, marking them processing in one transaction. */
  takePending(targetAgentId: string): QueueItem[] {
    return this.withTransaction(() => {
      const rows = this.db
        .prepare("SELECT * FROM queue.queue WHERE target_agent_id = ? AND status = 'pending' ORDER BY id ASC")
        .all(targetAgentId);
      const items = rows.map(queueFromRow);
      for (const item of items) {
        this.db.prepare("UPDATE queue.queue SET status = 'processing' WHERE id = ?").run(item.id);
      }
      return items;
    });
  }

  markQueueStatus(ids: number[], status: QueueStatus, error?: string): void {
    if (ids.length === 0) return;
    this.withTransaction(() => {
      const statement = this.db.prepare('UPDATE queue.queue SET status = ?, error = ? WHERE id = ?');
      for (const id of ids) statement.run(status, error ?? null, id);
    });
  }

  resetProcessing(): number {
    const result = this.db
      .prepare("UPDATE queue.queue SET status = 'pending' WHERE status = 'processing'")
      .run();
    return Number(result.changes);
  }

  countPending(targetAgentId: string): number {
    const row = this.db
      .prepare("SELECT count(*) AS n FROM queue.queue WHERE target_agent_id = ? AND status = 'pending'")
      .get(targetAgentId);
    return row === undefined ? 0 : asNumber(row.n);
  }

  insertTask(task: TaskRecord): void {
    this.db
      .prepare(
        `INSERT INTO tasks.tasks(task_id, tooltype, args, publisher_id, listeners, visibility, status, result, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.taskId,
        task.tooltype,
        JSON.stringify(task.args),
        task.publisherId,
        JSON.stringify(task.listeners),
        task.visibility,
        task.status,
        task.result === null ? null : JSON.stringify(task.result),
        task.error,
        task.createdAt,
        task.updatedAt,
      );
  }

  updateTask(
    taskId: string,
    patch: { status: TaskStatus; result?: unknown; error?: string | null; updatedAt: string },
  ): void {
    this.db
      .prepare('UPDATE tasks.tasks SET status = ?, result = ?, error = ?, updated_at = ? WHERE task_id = ?')
      .run(
        patch.status,
        patch.result === undefined || patch.result === null ? null : JSON.stringify(patch.result),
        patch.error ?? null,
        patch.updatedAt,
        taskId,
      );
  }

  getTask(taskId: string): TaskRecord | undefined {
    const row = this.db.prepare('SELECT * FROM tasks.tasks WHERE task_id = ?').get(taskId);
    return row === undefined ? undefined : taskFromRow(row);
  }

  listTasks(limit = 100): TaskRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks.tasks ORDER BY created_at DESC LIMIT ?')
      .all(limit);
    return rows.map(taskFromRow);
  }
}
