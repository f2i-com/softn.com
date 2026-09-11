/**
 * The one path contract for a project file.
 *
 * Studio had four opinions about what a project path was. Import checked
 * segments; the orchestrator and the export rejected any path containing
 * two adjacent dots and quietly stripped a leading slash; the validator
 * inspected raw VFS keys while the export wrote normalised ones. So a
 * legitimate asset such as assets/version..png imported fine, was shown to
 * the model, could not be written back, and was dropped from the archive
 * without a word — while two keys that were one path on a case-insensitive
 * disk overwrote each other at export. Every stage now asks here, and gets
 * the same answer.
 *
 * The contract, for a raw string:
 *   - backslashes are separators and become '/';
 *   - the path must be relative: no leading separator, no drive letter;
 *   - no NUL, no empty segment (so no '//' and no trailing '/'), and no '.'
 *     or '..' segment. Dots inside a name are just characters:
 *     assets/version..png and ui/..hidden.ui are files;
 *   - two paths are the same file when they are equal case-insensitively
 *     (`canonicalKey`), because the project may be unpacked on a disk that
 *     folds case. Such a pair is a collision, never a second file.
 *
 * Private editor state lives under builder/. A path is private when its
 * first segment is `builder` in any case, after separator normalisation, so
 * `Builder/x` and `builder\x` are private too. Private files are never
 * exported, never inspected as part of the bundle, never shown to the model
 * and never written by it; they cannot leak through an alternate spelling
 * because the spelling is settled before the question is asked.
 */

export const PRIVATE_PREFIX = 'builder/';

export type PathVerdict =
  | { ok: true; path: string; key: string; private: boolean }
  | { ok: false; reason: string };

/** A canonical bundle-relative path, or null for an escape or alias. */
export function normalizeProjectPath(value: string): string | null {
  const path = value.replace(/\\/g, '/');
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\0') ||
    path.includes('//') ||
    /^[a-zA-Z]:/.test(path)
  ) {
    return null;
  }

  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return null;
  }
  return segments.join('/');
}

/** Why `normalizeProjectPath` refused a value, in words for a report line. */
export function describePathProblem(value: string): string {
  const path = value.replace(/\\/g, '/');
  if (!path) return 'the path is empty';
  if (path.includes('\0')) return 'the path contains a NUL character';
  if (path.startsWith('/')) return 'the path is absolute; project paths are relative to the bundle root';
  if (/^[a-zA-Z]:/.test(path)) return 'the path starts with a drive letter; project paths are relative to the bundle root';
  if (path.includes('//')) return 'the path has an empty segment (two separators in a row)';
  const segments = path.split('/');
  if (segments.some((s) => s === '..')) return 'the path has a ".." segment, which would leave the bundle';
  if (segments.some((s) => s === '.')) return 'the path has a "." segment';
  if (segments.some((s) => !s)) return 'the path ends in a separator';
  return 'the path is not a valid project path';
}

/** The identity two spellings share when they are the same file on a case-folding disk. */
export function canonicalKey(path: string): string {
  return path.toLowerCase();
}

/** Whether a canonical path is Studio's private editor state. */
export function isPrivatePath(path: string): boolean {
  return canonicalKey(path).startsWith(PRIVATE_PREFIX);
}

/** Resolve a raw path to its canonical form and identity, or to why it cannot be one. */
export function resolveProjectPath(raw: string): PathVerdict {
  const path = normalizeProjectPath(raw);
  if (path === null) return { ok: false, reason: describePathProblem(raw) };
  return { ok: true, path, key: canonicalKey(path), private: isPrivatePath(path) };
}

/**
 * An existing path that is the same file as `path` under a different
 * spelling, if the collection holds one. An exact match is not a collision.
 */
export function findAlias(path: string, existing: Iterable<string>): string | null {
  const key = canonicalKey(path);
  for (const other of existing) {
    if (other !== path && canonicalKey(other) === key) return other;
  }
  return null;
}
