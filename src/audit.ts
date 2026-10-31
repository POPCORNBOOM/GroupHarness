/**
 * Append-only JSONL audit log.
 *
 * All writes go through one promise chain: JSONL lines never interleave, and a
 * failed append cannot take down the harness. Credentials are masked here so
 * no caller can leak one by forgetting.
 */
import { appendFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { maskSecrets } from './config';

export interface AuditEntry {
  ts?: string;
  actor: string;
  group_id: string;
  action: string;
  target?: string;
  before?: unknown;
  after?: unknown;
  ok?: boolean;
  error?: string;
}

export class AuditLog {
  private tail: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  /** Queue one entry. Never throws; failures go to stderr. */
  record(entry: AuditEntry): void {
    const line = JSON.stringify(maskSecrets({ ts: new Date().toISOString(), ok: true, ...entry }));
    this.tail = this.tail.then(
      () => appendFile(this.path, line + '\n', 'utf8'),
      () => appendFile(this.path, line + '\n', 'utf8'),
    );
    this.tail = this.tail.catch((error: unknown) => {
      console.error(`audit: cannot append to ${this.path}: ${(error as Error).message}`);
    });
  }

  /** Wait for every queued append to finish. */
  async close(): Promise<void> {
    await this.tail;
  }
}
