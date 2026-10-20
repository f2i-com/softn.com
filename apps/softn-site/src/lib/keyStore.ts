// ── The edit keys this browser holds ──────────────────────────────────────
// Everything that changes a published app needs the edit key that publishing
// handed out. The site keeps the keys it has seen in this browser so the
// owner does not have to paste them back; anyone else pastes. The requests
// that use a key are in api.ts; this is only where the keys are kept.

const KEYS = 'softn.site.editKeys';

/**
 * How a key store call went. A key is the only proof an app is the owner's,
 * so the caller is told when it could not be kept rather than left to assume
 * it was: 'blocked' is storage refusing the write (private mode, quota, a
 * policy), 'unreadable' is a map already there that does not parse, which is
 * left exactly as it is rather than replaced by a map holding one key.
 */
export type KeyStoreResult = 'stored' | 'blocked' | 'unreadable';

/** Whether the key value is the shape publishing hands out. */
export function isEditKey(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
}

/**
 * A key map: slug to key, and nothing inherited. A slug is whatever the
 * directory made of an app's name, so `constructor` is one, and on a plain
 * object `keys['constructor']` is the `Object` function: the app called
 * "Constructor" was every visitor's to update, by its page's account, and
 * its update page threw reading a key that was not text. With no prototype
 * the map holds the slugs put in it and answers for no others.
 */
function keyMap(...from: Array<Record<string, string>>): Record<string, string> {
  return Object.assign(Object.create(null) as Record<string, string>, ...from);
}

/**
 * Read the key map. `null` means there is one and it cannot be read — as
 * distinct from there being none — so a writer can refuse to replace it.
 */
function readKeyMap(): Record<string, string> | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEYS);
  } catch {
    return keyMap();
  }
  if (raw === null || raw === '') return keyMap();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const keys = keyMap();
  for (const [slug, key] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof key === 'string' && key !== '') keys[slug] = key;
  }
  return keys;
}

export function savedKeys(): Record<string, string> {
  return readKeyMap() ?? keyMap();
}

/** Whether a key map is stored here but cannot be read. Nothing here will overwrite it. */
export function savedKeysUnreadable(): boolean {
  return readKeyMap() === null;
}

export function savedKey(slug: string): string | null {
  return savedKeys()[slug] ?? null;
}

function writeKeyMap(keys: Record<string, string>): KeyStoreResult {
  try {
    localStorage.setItem(KEYS, JSON.stringify(keys));
    // Some browsers accept the write and drop it; read it back to be sure.
    return localStorage.getItem(KEYS) === JSON.stringify(keys) ? 'stored' : 'blocked';
  } catch {
    return 'blocked';
  }
}

/**
 * Keep an app's edit key in this browser. Returns how that went: a caller
 * showing "kept in this browser" must not say so on 'blocked' or 'unreadable'.
 */
export function rememberKey(slug: string, key: string): KeyStoreResult {
  const keys = readKeyMap();
  if (keys === null) return 'unreadable';
  return writeKeyMap(keyMap(keys, { [slug]: key }));
}

/**
 * Drop one app's key, and only that one. Never called on the owner's behalf
 * by a listing or a lookup: an app that cannot be reached right now is not
 * an app that is gone, and a key deleted here is gone for good.
 */
export function forgetKey(slug: string): KeyStoreResult {
  const keys = readKeyMap();
  if (keys === null) return 'unreadable';
  if (!(slug in keys)) return 'stored';
  const rest = keyMap(keys);
  delete rest[slug];
  return writeKeyMap(rest);
}

/**
 * A backup of every key, as JSON to keep somewhere safer than one browser's
 * storage. Only the publishing keys: nothing else this origin stores. Plain
 * text — lib/keyBackup.ts seals it under a passphrase when the visitor
 * gives one.
 */
export function exportKeys(): string {
  return JSON.stringify({ format: 'softn-edit-keys', version: 1, keys: savedKeys() }, null, 2);
}

export interface KeyImportResult {
  /** Slugs whose key was added or changed. */
  added: string[];
  /** Slugs already holding the same key. */
  unchanged: string[];
  /** Slugs the file holds a different key for; left as they were unless `replace` was set. */
  conflicts: string[];
  /** Entries the file holds that are not an app slug with an edit key. */
  rejected: string[];
  stored: KeyStoreResult;
  /** The file is a sealed (version 2) backup: nothing was read from it. lib/keyBackup.ts opens those. */
  encrypted?: true;
}

/**
 * Merge a backup back in. Entries that are not a slug with a 40-hex key are
 * rejected one by one; a slug already holding a different key is reported
 * as a conflict and kept unless `replace` says otherwise. Never wipes the
 * map: a malformed file changes nothing.
 */
export function importKeys(text: string, replace = false): KeyImportResult {
  const result: KeyImportResult = { added: [], unchanged: [], conflicts: [], rejected: [], stored: 'stored' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    result.rejected.push('(the file is not JSON)');
    return result;
  }
  // A sealed backup is a key map only once it is opened; its fields are not
  // slugs, and reading them as such would report the file as junk.
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed as { encrypted?: unknown }).encrypted === true) {
    result.encrypted = true;
    result.rejected.push('(the file is encrypted: it needs its passphrase)');
    return result;
  }
  const source =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? 'keys' in parsed && (parsed as { keys?: unknown }).keys && typeof (parsed as { keys: unknown }).keys === 'object'
        ? ((parsed as { keys: Record<string, unknown> }).keys as Record<string, unknown>)
        : (parsed as Record<string, unknown>)
      : null;
  if (!source || Array.isArray(source)) {
    result.rejected.push('(the file does not hold a key map)');
    return result;
  }
  const current = readKeyMap();
  if (current === null) {
    result.stored = 'unreadable';
    return result;
  }
  const next = keyMap(current);
  for (const [slug, key] of Object.entries(source)) {
    if (slug === 'format' || slug === 'version') continue;
    if (!/^[a-z0-9][a-z0-9-]{0,80}$/i.test(slug) || !isEditKey(key)) {
      result.rejected.push(slug);
      continue;
    }
    const held = next[slug];
    if (held === key) result.unchanged.push(slug);
    else if (held && !replace) result.conflicts.push(slug);
    else {
      next[slug] = key;
      result.added.push(slug);
    }
  }
  if (result.added.length > 0) result.stored = writeKeyMap(next);
  return result;
}
