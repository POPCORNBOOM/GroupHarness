/**
 * Process-level wiring: global config, groups, the mock IM transport, and the
 * startup sequence. One process hosts every group.
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AuditLog } from './audit';
import {
  ConfigError,
  ensureWorkingDirectory,
  initConfigFile,
  loadGlobalConfig,
  maskSecrets,
  resolveWorkingDirectory,
  saveGlobalConfig,
  type FilePermission,
  type GlobalConfig,
  type ImConfig,
  type ModelConfig,
  type WebUiTheme,
} from './config';
import { AdminWeb } from './admin-web';
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
  /** Serve the web administration console on the mock IM port. */
  webAdmin?: boolean;
  /** Test seam; production uses {@link LlmClient}. */
  llm?: LlmLike;
}

export interface InitSeed {
  apikey?: string;
  model?: string;
  baseurl?: string;
}

export interface SettingsPatch {
  model?: Partial<ModelConfig>;
  filePermission?: Partial<FilePermission>;
  workingDirectory?: string;
  im?: Partial<ImConfig>;
  webui?: Partial<WebUiTheme>;
}

const GROUP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SETTINGS_KEYS = new Set(['model', 'filePermission', 'workingDirectory', 'im', 'webui']);
const MODEL_KEYS = new Set(['format', 'baseurl', 'apikey', 'model', 'reasoning_effort', 'context_window', 'max_output_tokens']);
const PERMISSION_KEYS = new Set(['default', 'read', 'write', 'execute', 'deny']);
const IM_KEYS = new Set(['host', 'port']);
const THEME_KEYS = new Set(['accent', 'background', 'foreground']);

function settingsObject(path: string, value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(path, `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function pathList(path: string, value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry === '')) {
    throw new ConfigError(path, `${label} must be an array of non-empty path prefixes`);
  }
  return [...value] as string[];
}

function applyModelPatch(path: string, current: ModelConfig, patch: Partial<ModelConfig> | undefined): ModelConfig {
  if (patch === undefined) return { ...current };
  const table = settingsObject(path, patch, 'model');
  const next = { ...current };
  for (const [key, value] of Object.entries(table)) {
    if (!MODEL_KEYS.has(key)) throw new ConfigError(path, `unknown model setting "${key}"`);
    if (value === undefined) continue;
    if (key === 'format') {
      if (value !== 'completion' && value !== 'anthropic') {
        throw new ConfigError(path, 'model.format must be "completion" or "anthropic"');
      }
      next.format = value;
    } else if (key === 'context_window' || key === 'max_output_tokens') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        throw new ConfigError(path, `model.${key} must be a positive integer`);
      }
      next[key] = value;
    } else {
      if (typeof value !== 'string') throw new ConfigError(path, `model.${key} must be a string`);
      next[key as 'baseurl' | 'apikey' | 'model' | 'reasoning_effort'] = value;
    }
  }
  return next;
}

function clonePermission(current: FilePermission): FilePermission {
  return {
    default: current.default,
    ...(current.read === undefined ? {} : { read: Array.isArray(current.read) ? [...current.read] : current.read }),
    ...(current.write === undefined ? {} : { write: Array.isArray(current.write) ? [...current.write] : current.write }),
    ...(current.execute === undefined ? {} : { execute: Array.isArray(current.execute) ? [...current.execute] : current.execute }),
    ...(current.deny === undefined ? {} : { deny: [...current.deny] }),
  };
}

function applyPermissionPatch(
  path: string,
  current: FilePermission,
  patch: Partial<FilePermission> | undefined,
): FilePermission {
  if (patch === undefined) return clonePermission(current);
  const table = settingsObject(path, patch, 'filePermission');
  const next = clonePermission(current);
  for (const [key, value] of Object.entries(table)) {
    if (!PERMISSION_KEYS.has(key)) throw new ConfigError(path, `unknown filePermission setting "${key}"`);
    if (value === undefined) continue;
    if (key === 'default') {
      if (value !== 'inherit' && value !== 'deny_all') {
        throw new ConfigError(path, 'filePermission.default must be "inherit" or "deny_all"');
      }
      next.default = value;
    } else if (key === 'deny') {
      next.deny = pathList(path, value, 'filePermission.deny');
    } else if (value === 'deny_all') {
      next[key as 'read' | 'write' | 'execute'] = 'deny_all';
    } else {
      next[key as 'read' | 'write' | 'execute'] = pathList(path, value, `filePermission.${key}`);
    }
  }
  return next;
}

function applyImPatch(path: string, current: ImConfig, patch: Partial<ImConfig> | undefined): ImConfig {
  if (patch === undefined) return { ...current };
  const table = settingsObject(path, patch, 'im');
  const next = { ...current };
  for (const [key, value] of Object.entries(table)) {
    if (!IM_KEYS.has(key)) throw new ConfigError(path, `unknown im setting "${key}"`);
    if (value === undefined) continue;
    if (key === 'host') {
      if (typeof value !== 'string' || value.trim() === '') throw new ConfigError(path, 'im.host must be a non-empty string');
      next.host = value;
    } else {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 65_535) {
        throw new ConfigError(path, 'im.port must be an integer between 0 and 65535');
      }
      next.port = value;
    }
  }
  return next;
}

function applyThemePatch(path: string, current: WebUiTheme, patch: Partial<WebUiTheme> | undefined): WebUiTheme {
  if (patch === undefined) return { ...current };
  const table = settingsObject(path, patch, 'webui');
  const next = { ...current };
  for (const [key, value] of Object.entries(table)) {
    if (!THEME_KEYS.has(key)) throw new ConfigError(path, `unknown webui setting "${key}"`);
    if (value === undefined) continue;
    if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) {
      throw new ConfigError(path, `webui.${key} must be a #rrggbb color`);
    }
    next[key as keyof WebUiTheme] = value;
  }
  return next;
}

export class Harness {
  private global: GlobalConfig;
  private readonly groups = new Map<string, Group>();
  private readonly admins = new Map<string, GroupAdmin>();
  private imServer?: ImServer;
  private web?: AdminWeb;
  private adminUrlValue?: string;
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
    if (runtime && (global.model.baseurl === '' || global.model.model === '')) {
      console.warn('warning: model.baseurl/model is empty; agent calls will fail until configured');
    }
    const llm = options.llm ?? new LlmClient();
    const harness = new Harness(rootDir, harnessDir, configPath, global, audit, llm, runtime);

    try {
      return await this.load(harness, global, options);
    } catch (error) {
      await harness.close();
      throw error;
    }
  }

  private static async load(
    harness: Harness,
    global: GlobalConfig,
    options: HarnessOptions,
  ): Promise<Harness> {
    const runtime = harness.runtime;
    const groupsDir = join(harness.harnessDir, 'groups');
    mkdirSync(groupsDir, { recursive: true });
    for (const entry of readdirSync(groupsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const metaPath = join(groupsDir, entry.name, 'meta.toml');
      if (!existsSync(metaPath)) continue;
      const group = Group.open({
        dir: join(groupsDir, entry.name),
        id: entry.name,
        rootDir: harness.rootDir,
        globalConfig: () => harness.global,
        audit: harness.audit,
        llm: harness.llm,
        runtime,
      });
      harness.groups.set(group.id, group);
      harness.admins.set(group.id, new GroupAdmin(group, harness.audit));
    }

    if (options.webAdmin === true) harness.web = new AdminWeb(harness);
    const needsServer = options.im === true || harness.web !== undefined;
    if (needsServer) {
      const web = harness.web;
      const server = new ImServer({
        host: global.im.host,
        port: global.im.port,
        groups: () => [...harness.groups.values()],
        ...(web === undefined ? {} : { httpHandler: (request, response) => web.handle(request, response) }),
      });
      await server.start();
      harness.imServer = server;
      if (web !== undefined) harness.adminUrlValue = web.url(server.port);
    }

    if (runtime) {
      for (const group of harness.groups.values()) group.recoverInterruptedTasks();
    }
    if (runtime) {
      for (const group of harness.groups.values()) group.startAgents();
    }
    return harness;
  }

  get imPort(): number | undefined {
    return this.imServer?.port;
  }

  /** Tokenized local admin URL; undefined unless `webAdmin` was requested. */
  get adminUrl(): string | undefined {
    return this.adminUrlValue;
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
  createGroup(id: string, name?: string, actor = 'tui'): Group {
    try {
      return this.createGroupInternal(id, name, actor);
    } catch (error) {
      this.audit.record({
        actor,
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

  private createGroupInternal(id: string, name?: string, actor = 'tui'): Group {
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
      actor,
      group_id: id,
      action: 'group_create',
      target: id,
      after: meta,
      ok: true,
    });
    return group;
  }

  /**
   * Merge a settings patch into the global config and save it atomically.
   * Model/permission changes apply on the next agent wake; IM host/port changes
   * take effect on the next process start. Every attempt is audited.
   */
  updateSettings(patch: SettingsPatch, actor = 'tui'): void {
    const before = maskSecrets(this.global);
    let next: GlobalConfig;
    try {
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new ConfigError(this.configPath, 'settings patch must be an object');
      }
      for (const key of Object.keys(patch)) {
        if (!SETTINGS_KEYS.has(key)) throw new ConfigError(this.configPath, `unknown setting "${key}"`);
      }
      if (patch.workingDirectory !== undefined && typeof patch.workingDirectory !== 'string') {
        throw new ConfigError(this.configPath, 'workingDirectory must be a string');
      }
      next = {
        model: applyModelPatch(this.configPath, this.global.model, patch.model),
        filePermission: applyPermissionPatch(this.configPath, this.global.filePermission, patch.filePermission),
        workingDirectory:
          patch.workingDirectory === undefined
            ? this.global.workingDirectory
            : resolveWorkingDirectory(this.rootDir, undefined, patch.workingDirectory),
        im: applyImPatch(this.configPath, this.global.im, patch.im),
        webui: applyThemePatch(this.configPath, this.global.webui, patch.webui),
      };
      ensureWorkingDirectory(next.workingDirectory);
      saveGlobalConfig(this.configPath, next, this.rootDir);
    } catch (error) {
      this.audit.record({
        actor,
        group_id: 'global',
        action: 'set_settings',
        target: 'global',
        before,
        after: maskSecrets(patch),
        ok: false,
        error: (error as Error).message,
      });
      throw error;
    }
    this.global = next;
    this.audit.record({
      actor,
      group_id: 'global',
      action: 'set_settings',
      target: 'global',
      before,
      after: maskSecrets(next),
      ok: true,
    });
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
