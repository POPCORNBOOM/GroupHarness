import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ConfigError,
  defaultConfigText,
  initConfigFile,
  loadGlobalConfig,
  maskKey,
  maskSecrets,
  mergeFilePermission,
  mergeModel,
  resolveConfig,
} from '../src/config';
import { canonicalPath, checkPathAccess, PermissionDenied } from '../src/file-permission';

test('initConfigFile creates the parent directory and never overwrites', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-init-'));
  const path = join(dir, 'nested', '.groupharness', 'config.toml');
  assert.equal(initConfigFile(path, { model: 'm' }), true);
  assert.match(readFileSync(path, 'utf8'), /model = "m"/);
  assert.equal(initConfigFile(path, { model: 'other' }), false);
});

test('model merge inherits empty values and overrides set ones', () => {
  const base = {
    format: 'completion' as const,
    baseurl: 'http://base',
    apikey: 'key',
    model: 'model-a',
    reasoning_effort: '',
    context_window: 128_000,
    max_output_tokens: 4_096,
  };
  const merged = mergeModel(base, { model: 'model-b', baseurl: '', max_output_tokens: 1_024 });
  assert.equal(merged.model, 'model-b');
  assert.equal(merged.baseurl, 'http://base');
  assert.equal(merged.max_output_tokens, 1_024);
});

test('file permission merge inherits empty rules and replaces non-empty rules', () => {
  const base = { default: 'inherit' as const, read: ['/a'], deny: ['/secret'] };
  const merged = mergeFilePermission(base, { read: [], write: ['/b'], deny: ['/other'] });
  assert.deepEqual(merged.read, ['/a']);
  assert.deepEqual(merged.write, ['/b']);
  assert.deepEqual(merged.deny, ['/other']);
  assert.equal(mergeFilePermission(base, { default: 'deny_all' }).default, 'deny_all');
});

test('global config loads defaults and rejects unknown keys with the path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-config-'));
  mkdirSync(join(dir, '.groupharness'));
  const path = join(dir, '.groupharness', 'config.toml');
  writeFileSync(path, defaultConfigText({ baseurl: 'http://x', model: 'm', apikey: 'k' }));
  const config = loadGlobalConfig(path, dir);
  assert.equal(config.model.context_window, 128_000);
  assert.equal(config.model.max_output_tokens, 4_096);
  assert.equal(config.im.port, 8_787);
  assert.equal(config.workingDirectory, dir);

  writeFileSync(
    path,
    `[model]
typo = 1
`,
  );
  assert.throws(() => loadGlobalConfig(path, dir), (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /unknown key "model\.typo"/);
    assert.match(error.message, /config\.toml/);
    return true;
  });
});

test('agent layer resolves over group over global', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-config-'));
  const global = {
    model: {
      format: 'completion' as const,
      baseurl: 'http://global',
      apikey: 'g',
      model: 'global',
      reasoning_effort: '',
      context_window: 1_000,
      max_output_tokens: 100,
    },
    filePermission: { default: 'inherit' as const, read: ['/global'] },
    workingDirectory: dir,
    im: { host: '127.0.0.1', port: 1 },
  };
  const resolved = resolveConfig(
    global,
    dir,
    { model: { model: 'group' }, file_permission: { write: ['/group'] }, working_directory: 'group-dir' },
    { model: { model: 'agent' }, tools: ['read_file'], working_directory: 'agent-dir' },
  );
  assert.equal(resolved.model.model, 'agent');
  assert.equal(resolved.model.baseurl, 'http://global');
  assert.deepEqual(resolved.filePermission.read, ['/global']);
  assert.deepEqual(resolved.filePermission.write, ['/group']);
  assert.equal(resolved.workingDirectory, join(dir, 'agent-dir'));
});

test('credentials are masked, never echoed', () => {
  assert.equal(maskKey(''), '');
  assert.equal(maskKey('short'), '***');
  assert.equal(maskKey('sk-1234567890abcdef'), 'sk-…cdef');
  assert.deepEqual(maskSecrets({ apikey: 'sk-1234567890abcdef', nested: { token: 'abcdefghijk' }, keep: 'value' }), {
    apikey: 'sk-…cdef',
    nested: { token: 'abc…hijk' },
    keep: 'value',
  });
});

test('path permission canonicalizes, denies first, and blocks symlink escapes', () => {
  const root = mkdtempSync(join(tmpdir(), 'gh-perm-'));
  const inside = join(root, 'work');
  const outside = join(root, 'outside');
  mkdirSync(join(inside, 'sub'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.txt'), 'x');
  symlinkSync(outside, join(inside, 'link'));

  const permission = { default: 'inherit' as const, read: [inside], deny: [join(inside, 'sub')] };
  assert.equal(
    checkPathAccess(permission, 'read', join(inside, 'sub', '..', 'a.txt'), inside),
    join(canonicalPath(inside), 'a.txt'),
  );
  assert.throws(
    () => checkPathAccess(permission, 'read', join(inside, 'sub', 'x.txt'), inside),
    (error: unknown) => error instanceof PermissionDenied && /deny list/.test(error.message),
  );
  assert.throws(
    () => checkPathAccess(permission, 'read', join(outside, 'secret.txt'), inside),
    (error: unknown) => error instanceof PermissionDenied && /outside the file permission/.test(error.message),
  );
  assert.throws(
    () => checkPathAccess(permission, 'read', join(inside, 'link', 'secret.txt'), inside),
    (error: unknown) => error instanceof PermissionDenied,
  );
  assert.throws(
    () => checkPathAccess({ default: 'deny_all' }, 'read', 'anything', inside),
    (error: unknown) => error instanceof PermissionDenied,
  );
  assert.equal(
    checkPathAccess({ default: 'inherit' }, 'read', 'anything', inside).endsWith('anything'),
    true,
  );
});
