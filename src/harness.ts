/**
 * Process-level wiring: global config, groups, the mock IM transport, and the
 * startup sequence. One process hosts every group.
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AuditLog } from './audit';
import {
  initConfigFile,
  loadGlobalConfig,
  type GlobalConfig,
} from './config';
import { Group } from './group';
import { GroupAdmin } from './group-admin';
import { ImServer } from './im';
import { LlmClient, type LlmLike } from './llm';
import { emptyGroupMeta, saveGroupMeta } from './meta';

export interface HarnessOptions {
  /** Project root; the harness directory is `<root>/.groupharness`. */
  rootDir?: string;
  /** Open agent runtimes and consume queues (false for one-shot console commands). */
  runtime?: boolean;
  /** Start the local mock IM server. */
  im?: boolean;
  /** Send the startup `system_restart` notification. */
  deliverRestart?: boolean;
  /** Test seam; production uses {@link LlmClient}. */
  llm?: LlmLike;
}

export interface InitSeed {
  apikey?: string;
  model?: string;
  baseurl?: string;
}

const GROUP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class Harness {
  private global: GlobalConfig;
  private readonly groups = new Map<string, Group>();
  private readonly admins = new Map<string, GroupAdmin>();
  private imServer?: ImServer;
  private closed = false;

  private constructor(
    readonly rootDir: string,
    readonly harnessDir: string,
    readonly configPath: string,
    global: GlobalConfig,
    readonly audit: AuditLog,
    private readonly llm: LlmLike,
    private readonly runtime: boolean,
  ) {
    this.global = global;
  }

  /** Create `.groupharness` and the starter config; never overwrites. */
  static init(rootDir = process.cwd(), seed: InitSeed = {}): { configPath: string; created: boolean } {
    const harnessDir = join(resolve(rootDir), '.groupharness');
    mkdirSync(join(harnessDir, 'groups'), { recursive: true });
    const configPath = join(harnessDir, 'config.toml');
    const created = initConfigFile(configPath, seed);
    return { configPath, created };
  }

  static async open(options: HarnessOptions = {}): Promise<Harness> {
    const rootDir = resolve(options.rootDir ?? process.cwd());
    const harnessDir = join(rootDir, '.groupharness');
    const configPath = join(harnessDir, 'config.toml');
    if (!existsSync(configPath)) {
      throw new Error(`no config at ${configPath}; run "npm run gh -- init"`);
    }
    const global = loadGlobalConfig(configPath, rootDir);
    const audit = new AuditLog(join(harnessDir, 'audit.jsonl'));
    const runtime = options.runtime ?? true;
    const llm = options.llm ?? new LlmClient();
    const harness = new Harness(rootDir, harnessDir, configPath, global, audit, llm, runtime);

    const groupsDir = join(harnessDir, 'groups');
    mkdirSync(groupsDir, { recursive: true });
    for (const entry of readdirSync(groupsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const metaPath = join(groupsDir, entry.name, 'meta.toml');
      if (!existsSync(metaPath)) continue;
      const group = Group.open({
        dir: join(groupsDir, entry.name),
        id: entry.name,
        rootDir,
        globalConfig: () => harness.global,
        audit,
        llm,
        runtime,
      });
      harness.groups.set(group.id, group);
      harness.admins.set(group.id, new GroupAdmin(group, audit));
    }

    if (options.im === true) {
      const server = new ImServer({
        host: global.im.host,
        port: global.im.port,
        groups: () => [...harness.groups.values()],
      });
      await server.start();
      harness.imServer = server;
    }

    if (runtime) {
      for (const group of harness.groups.values()) group.recoverInterruptedTasks();
    }
    if (options.deliverRestart === true) {
      for (const group of harness.groups.values()) group.deliverRestart();
    }
    if (runtime) {
      for (const group of harness.groups.values()) group.startAgents();
    }
    return harness;
  }

  get imPort(): number | undefined {
    return this.imServer?.port;
  }

  globalConfig(): GlobalConfig {
    return this.global;
  }

  listGroups(): Group[] {
    return [...this.groups.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  group(id: string): Group | undefined {
    return this.groups.get(id);
  }

  requireGroup(id: string): Group {
    const group = this.groups.get(id);
    if (group === undefined) throw new Error(`unknown group "${id}"`);
    return group;
  }

  admin(id: string): GroupAdmin {
    const admin = this.admins.get(id);
    if (admin === undefined) throw new Error(`unknown group "${id}"`);
    return admin;
  }

  /** Create a group directory + empty meta.toml and open it; failures are audited. */
  createGroup(id: string, name?: string): Group {
    try {
      return this.createGroupInternal(id, name);
    } catch (error) {
      this.audit.record({
        actor: 'tui',
        group_id: id,
        action: 'group_create',
        target: id,
        before: undefined,
        after: name === undefined ? undefined : { name },
        ok: false,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  private createGroupInternal(id: string, name?: string): Group {
    if (!GROUP_ID_PATTERN.test(id)) {
      throw new Error('group id must start with a letter or digit and contain only A-Z a-z 0-9 . _ -');
    }
    if (this.groups.has(id)) throw new Error(`group "${id}" already exists`);
    const dir = join(this.harnessDir, 'groups', id);
    if (existsSync(dir)) throw new Error(`directory already exists: ${dir}`);
    mkdirSync(dir, { recursive: true });
    const meta = emptyGroupMeta(name ?? id);
    saveGroupMeta(join(dir, 'meta.toml'), meta);
    const group = Group.open({
      dir,
      id,
      rootDir: this.rootDir,
      globalConfig: () => this.global,
      audit: this.audit,
      llm: this.llm,
      runtime: this.runtime,
    });
    this.groups.set(id, group);
    this.admins.set(id, new GroupAdmin(group, this.audit));
    this.audit.record({
      actor: 'tui',
      group_id: id,
      action: 'group_create',
      target: id,
      after: meta,
      ok: true,
    });
    return group;
  }

  /** Re-read global and group config files; takes effect on each next wake-up. */
  reload(): void {
    const next = loadGlobalConfig(this.configPath, this.rootDir);
    this.global = next;
    for (const group of this.groups.values()) group.reloadMeta();
  }

  /** Wait until every agent has drained its queue (tests and demos). */
  async waitIdle(timeoutMs = 10_000): Promise<void> {
    await Promise.all([...this.groups.values()].map((group) => group.waitIdle(timeoutMs)));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.runtime) {
      try {
        const stopped = await Promise.race([
          Promise.all([...this.groups.values()].map((group) => group.stopAgents())).then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
        ]);
        if (!stopped) console.error('harness: agent shutdown timed out; closing stores');
      } catch (error) {
        console.error(`harness: stopping agents failed: ${(error as Error).message}`);
      }
    }
    await this.imServer?.stop();
    for (const group of this.groups.values()) group.close();
    await this.audit.close();
  }
}
