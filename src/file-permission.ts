/**
 * Path-based file permission enforcement.
 *
 * Paths are canonicalized (symlinks resolved, `..` folded) before prefix
 * matching. Deny rules win; an operation with no rule inherits the layer's
 * `default`, and only an explicit `deny_all` (or a non-matching allow list)
 * rejects every path.
 */
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import type { FilePermission, PathRule } from './config';

export type FileOperation = 'read' | 'write' | 'execute';

export class PermissionDenied extends Error {
  readonly code = 'denied';

  constructor(message: string) {
    super(message);
    this.name = 'PermissionDenied';
  }
}

/** Resolve the real path, walking up through the nearest existing ancestor. */
export function canonicalPath(path: string): string {
  let current = resolve(path);
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return resolve(real, ...[...suffix].reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      suffix.push(basename(current));
      current = parent;
    }
  }
}

function isWithin(candidate: string, prefix: string): boolean {
  const normalized = resolve(prefix);
  const boundary = normalized.endsWith(sep) ? normalized : normalized + sep;
  return candidate === normalized || candidate.startsWith(boundary);
}

function resolveRulePath(path: string, workingDirectory: string): string {
  const absolute = isAbsolute(path) ? path : resolve(workingDirectory, path);
  return canonicalPath(absolute);
}

function matchesAny(candidate: string, prefixes: readonly string[], workingDirectory: string): boolean {
  return prefixes.some((prefix) => isWithin(candidate, resolveRulePath(prefix, workingDirectory)));
}

function deniedByRule(rule: PathRule | undefined, candidate: string, workingDirectory: string, fallback: 'inherit' | 'deny_all'): boolean {
  if (rule === 'deny_all') return true;
  if (rule === undefined || rule.length === 0) return fallback === 'deny_all';
  return !matchesAny(candidate, rule, workingDirectory);
}

/**
 * Throw unless the operation is permitted; return the canonical target path.
 * Call this before touching the filesystem.
 */
export function checkPathAccess(
  permission: FilePermission,
  operation: FileOperation,
  targetPath: string,
  workingDirectory: string,
): string {
  const absolute = isAbsolute(targetPath) ? targetPath : resolve(workingDirectory, targetPath);
  const canonical = canonicalPath(absolute);

  if (permission.deny !== undefined && permission.deny.length > 0) {
    if (matchesAny(canonical, permission.deny, workingDirectory)) {
      throw new PermissionDenied(`denied ${operation}: ${canonical} is in the deny list`);
    }
  }

  if (deniedByRule(permission[operation], canonical, workingDirectory, permission.default)) {
    throw new PermissionDenied(`denied ${operation}: ${canonical} is outside the file permission`);
  }
  return canonical;
}
