/**
 * Configuration model for Group Harness.
 *
 * Three TOML layers feed one resolved config per agent: global
 * (`.groupharness/config.toml`), group (`meta.toml`), then the agent's own
 * `agents/<id>/config.toml`. Empty values inherit from the layer above, so a
 * layer only states what it overrides. Resolution happens once per agent tool
 * loop, never mid-loop.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

export type ModelFormat = 'completion' | 'anthropic';

export interface ModelConfig {
  format: ModelFormat;
  baseurl: string;
  apikey: string;
  model: string;
  reasoning_effort: string;
  context_window: number;
  max_output_tokens: number;
}

/** `deny_all` or a list of allowed path prefixes. */
export type PathRule = 'deny_all' | string[];

export interface FilePermission {
  default: 'inherit' | 'deny_all';
  read?: PathRule;
  write?: PathRule;
  execute?: PathRule;
  deny?: string[];
}

/** One TOML config layer (global, group, or agent). */
export interface ConfigLayer {
  model?: Partial<ModelConfig>;
  file_permission?: Partial<FilePermission>;
  working_directory?: string;
}

export interface AgentConfigLayer extends ConfigLayer {
  tools?: string[];
}

export interface ResolvedConfig {
  model: ModelConfig;
  filePermission: FilePermission;
  workingDirectory: string;
}

export interface ImConfig {
  host: string;
  port: number;
}

export interface GlobalConfig {
  model: ModelConfig;
  filePermission: FilePermission;
  workingDirectory: string;
  im: ImConfig;
}

/** A configuration file failed to parse or validate. Carries the path. */
export class ConfigError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'ConfigError';
  }
}

const DEFAULT_MODEL: ModelConfig = {
  format: 'completion',
  baseurl: '',
  apikey: '',
  model: '',
  reasoning_effort: '',
  context_window: 128_000,
  max_output_tokens: 4_096,
};

const DEFAULT_FILE_PERMISSION: FilePermission = { default: 'inherit' };

/** Parse a TOML file; a missing file is an error so misconfiguration is loud. */
export function readTomlFile(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigError(path, 'config file not found');
    }
    throw new ConfigError(path, (error as Error).message);
  }
  try {
    return parseToml(text) as Record<string, unknown>;
  } catch (error) {
    throw new ConfigError(path, `invalid TOML: ${(error as Error).message}`);
  }
}

/** Serialize a plain object to TOML text. */
export function stringifyTomlSafe(value: Record<string, unknown>): string {
  return stringifyToml(value);
}

/** Write a TOML file, creating its directory. */
export function writeTomlFile(path: string, value: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileAtomic(path, stringifyToml(value));
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(path, `cannot write: ${(error as Error).message}`);
  }
}

/** Replace a file atomically so a crash cannot leave half a config behind. */
export function writeFileAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}

function fail(path: string, message: string): never {
  throw new ConfigError(path, message);
}

function asObject(path: string, value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, `${field} must be a table`);
  }
  return value as Record<string, unknown>;
}

/** Reject unknown keys so a typo fails at startup instead of being ignored. */
export function assertKnownKeys(
  path: string,
  table: Record<string, unknown>,
  allowed: readonly string[],
  prefix = '',
): void {
  for (const key of Object.keys(table)) {
    if (!allowed.includes(key)) {
      fail(path, `unknown key "${prefix}${key}"`);
    }
  }
}

function optionalString(path: string, value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail(path, `${field} must be a string`);
  return value;
}

function optionalPositiveInt(path: string, value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    fail(path, `${field} must be a positive integer`);
  }
  return value;
}

function parseModel(path: string, raw: unknown): Partial<ModelConfig> {
  const table = asObject(path, raw, 'model');
  assertKnownKeys(
    path,
    table,
    ['format', 'baseurl', 'apikey', 'model', 'reasoning_effort', 'context_window', 'max_output_tokens'],
    'model.',
  );
  const out: Partial<ModelConfig> = {};
  const format = optionalString(path, table.format, 'model.format');
  if (format !== undefined) {
    if (format !== 'completion' && format !== 'anthropic') {
      fail(path, 'model.format must be "completion" or "anthropic"');
    }
    out.format = format;
  }
  for (const key of ['baseurl', 'apikey', 'model', 'reasoning_effort'] as const) {
    const value = optionalString(path, table[key], `model.${key}`);
    if (value !== undefined) out[key] = value;
  }
  for (const key of ['context_window', 'max_output_tokens'] as const) {
    const value = optionalPositiveInt(path, table[key], `model.${key}`);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function parsePathRule(path: string, raw: unknown, field: string): PathRule | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'deny_all') return 'deny_all';
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string')) {
    fail(path, `${field} must be "deny_all" or an array of path prefixes`);
  }
  return raw as string[];
}

function parseFilePermission(path: string, raw: unknown): Partial<FilePermission> {
  const table = asObject(path, raw, 'file_permission');
  assertKnownKeys(path, table, ['default', 'read', 'write', 'execute', 'deny'], 'file_permission.');
  const out: Partial<FilePermission> = {};
  const def = optionalString(path, table.default, 'file_permission.default');
  if (def !== undefined) {
    if (def !== 'inherit' && def !== 'deny_all') {
      fail(path, 'file_permission.default must be "inherit" or "deny_all"');
    }
    out.default = def;
  }
  for (const key of ['read', 'write', 'execute'] as const) {
    const rule = parsePathRule(path, table[key], `file_permission.${key}`);
    if (rule !== undefined) out[key] = rule;
  }
  const deny = table.deny;
  if (deny !== undefined) {
    if (!Array.isArray(deny) || deny.some((entry) => typeof entry !== 'string')) {
      fail(path, 'file_permission.deny must be an array of path prefixes');
    }
    out.deny = deny as string[];
  }
  return out;
}

/** Normalize one config layer from parsed TOML. */
export function parseConfigLayer(
  path: string,
  raw: Record<string, unknown>,
  extraKeys: readonly string[] = [],
): AgentConfigLayer {
  assertKnownKeys(path, raw, ['model', 'file_permission', 'working_directory', 'tools', ...extraKeys]);
  const out: AgentConfigLayer = {};
  if (raw.model !== undefined) out.model = parseModel(path, raw.model);
  if (raw.file_permission !== undefined) {
    out.file_permission = parseFilePermission(path, raw.file_permission);
  }
  const working = optionalString(path, raw.working_directory, 'working_directory');
  if (working !== undefined) out.working_directory = working;
  if (raw.tools !== undefined) {
    if (!Array.isArray(raw.tools) || raw.tools.some((entry) => typeof entry !== 'string')) {
      fail(path, 'tools must be an array of tool names');
    }
    out.tools = raw.tools as string[];
  }
  return out;
}

function parseIm(path: string, raw: unknown): ImConfig {
  const table = asObject(path, raw, 'im');
  assertKnownKeys(path, table, ['host', 'port'], 'im.');
  const host = optionalString(path, table.host, 'im.host') ?? '127.0.0.1';
  const rawPort = table.port;
  let port = 8787;
  if (rawPort !== undefined) {
    // 0 means "pick an ephemeral port"; tests and multiple local harnesses use it.
    if (typeof rawPort !== 'number' || !Number.isSafeInteger(rawPort) || rawPort < 0 || rawPort > 65_535) {
      fail(path, 'im.port must be an integer between 0 and 65535');
    }
    port = rawPort;
  }
  return { host, port };
}

/** Load `.groupharness/config.toml`. */
export function loadGlobalConfig(path: string, rootDir: string): GlobalConfig {
  const raw = readTomlFile(path);
  assertKnownKeys(path, raw, ['model', 'file_permission', 'working_directory', 'im']);
  const layer = parseConfigLayer(path, raw, ['im']);
  const model = mergeModel(DEFAULT_MODEL, layer.model);
  const filePermission = mergeFilePermission(DEFAULT_FILE_PERMISSION, layer.file_permission);
  const workingDirectory = resolveWorkingDirectory(rootDir, undefined, layer.working_directory);
  return { model, filePermission, workingDirectory, im: parseIm(path, raw.im) };
}

/** Merge a child model layer over its parent; empty values inherit. */
export function mergeModel(parent: ModelConfig, child: Partial<ModelConfig> | undefined): ModelConfig {
  if (child === undefined) return { ...parent };
  const pick = <K extends keyof ModelConfig>(key: K): ModelConfig[K] => {
    const value = child[key];
    if (value === undefined || value === '') return parent[key];
    return value;
  };
  return {
    format: pick('format'),
    baseurl: pick('baseurl'),
    apikey: pick('apikey'),
    model: pick('model'),
    reasoning_effort: pick('reasoning_effort'),
    context_window: child.context_window === undefined ? parent.context_window : child.context_window,
    max_output_tokens:
      child.max_output_tokens === undefined ? parent.max_output_tokens : child.max_output_tokens,
  };
}

/** Merge file rules field-by-field; empty lists inherit. Deny lists replace. */
export function mergeFilePermission(
  parent: FilePermission,
  child: Partial<FilePermission> | undefined,
): FilePermission {
  if (child === undefined) return cloneFilePermission(parent);
  const out = cloneFilePermission(parent);
  if (child.default !== undefined) out.default = child.default;
  for (const key of ['read', 'write', 'execute'] as const) {
    const rule = child[key];
    if (rule !== undefined && !(Array.isArray(rule) && rule.length === 0)) out[key] = cloneRule(rule);
  }
  if (child.deny !== undefined && child.deny.length > 0) out.deny = [...child.deny];
  return out;
}

function cloneRule(rule: PathRule): PathRule {
  return Array.isArray(rule) ? [...rule] : rule;
}

function cloneFilePermission(permission: FilePermission): FilePermission {
  return {
    default: permission.default,
    ...(permission.read === undefined ? {} : { read: cloneRule(permission.read) }),
    ...(permission.write === undefined ? {} : { write: cloneRule(permission.write) }),
    ...(permission.execute === undefined ? {} : { execute: cloneRule(permission.execute) }),
    ...(permission.deny === undefined ? {} : { deny: [...permission.deny] }),
  };
}

/** Resolve the working directory for one layer; empty inherits `parent`. */
export function resolveWorkingDirectory(
  rootDir: string,
  parent: string | undefined,
  own: string | undefined,
): string {
  const value = own === undefined || own === '' ? parent : own;
  if (value === undefined || value === '') return resolve(rootDir);
  return isAbsolute(value) ? resolve(value) : resolve(rootDir, value);
}

/** Validate that a working directory exists or can be created. */
export function ensureWorkingDirectory(path: string): void {
  try {
    if (statSync(path).isDirectory()) return;
  } catch {
    // Fall through to creation.
  }
  try {
    mkdirSync(path, { recursive: true });
  } catch (error) {
    throw new ConfigError(path, `cannot create working directory: ${(error as Error).message}`);
  }
  if (!statSync(path).isDirectory()) {
    throw new ConfigError(path, 'working directory is not a directory');
  }
}

/** Compose the final agent config from global -> group -> agent layers. */
export function resolveConfig(
  global: GlobalConfig,
  rootDir: string,
  group: ConfigLayer,
  agent: AgentConfigLayer,
): ResolvedConfig {
  const model = mergeModel(mergeModel(global.model, group.model), agent.model);
  const filePermission = mergeFilePermission(
    mergeFilePermission(global.filePermission, group.file_permission),
    agent.file_permission,
  );
  const workingDirectory = resolveWorkingDirectory(
    rootDir,
    resolveWorkingDirectory(rootDir, global.workingDirectory, group.working_directory),
    agent.working_directory,
  );
  return { model, filePermission, workingDirectory };
}

/** The default config file written by `init`. */
export function defaultConfigText(seed: { apikey?: string; model?: string; baseurl?: string } = {}): string {
  const apikey = seed.apikey ?? '';
  const model = seed.model ?? '';
  const baseurl = seed.baseurl ?? '';
  return `# Group Harness global configuration.
# Model fields fall back from agent -> group -> here.

# Relative paths resolve against the project root; "" means the project root.
working_directory = ""

[model]
format = "completion"
baseurl = "${baseurl}"
apikey = "${apikey}"
model = "${model}"
reasoning_effort = ""
context_window = 128000
max_output_tokens = 4096

[file_permission]
default = "inherit"

[im]
host = "127.0.0.1"
port = 8787
`;
}

/** Load an optional agent config file; missing means no overrides. */
export function loadAgentConfig(path: string): AgentConfigLayer {
  if (!existsSync(path)) return {};
  return parseConfigLayer(path, readTomlFile(path));
}

/** Parse TOML text with the same error shape as file loads. */
export function parseTomlText(path: string, text: string): Record<string, unknown> {
  try {
    return parseToml(text) as Record<string, unknown>;
  } catch (error) {
    throw new ConfigError(path, `invalid TOML: ${(error as Error).message}`);
  }
}

function stripUndefined<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Validate an agent config layer without writing it. */
export function validateAgentConfigLayer(path: string, layer: AgentConfigLayer): void {
  parseConfigLayer(path, stripUndefined(layer) as Record<string, unknown>);
}

/** Validate and atomically write an agent config layer. */
export function saveAgentConfigLayer(path: string, layer: AgentConfigLayer): void {
  const clean = stripUndefined(layer) as Record<string, unknown>;
  parseConfigLayer(path, clean);
  writeTomlFile(path, clean);
}

/** Create the config file if the directory is empty. */
export function initConfigFile(path: string, seed?: Parameters<typeof defaultConfigText>[0]): boolean {
  if (existsSync(path)) return false;
  writeFileAtomic(path, defaultConfigText(seed));
  return true;
}

/** Mask a credential for display. Never returns the original. */
export function maskKey(key: string): string {
  if (key.length === 0) return '';
  if (key.length <= 8) return '***';
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

/** Deep-copy a value with credential-looking fields masked. */
export function maskSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => maskSecrets(entry)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (/^(apikey|api_key|key|token|secret)$/i.test(key) && typeof entry === 'string') {
        out[key] = maskKey(entry);
      } else {
        out[key] = maskSecrets(entry);
      }
    }
    return out as T;
  }
  return value;
}
