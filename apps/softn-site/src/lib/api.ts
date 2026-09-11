/**
 * The directory API as the site sees it. Same origin, under /api/ — see
 * apps/softn-api for the server side, which is also what a script or a model
 * talks to when it publishes without a browser.
 */

export interface AppCard {
  slug: string;
  name: string;
  description: string;
  author: string;
  category: string;
  tags: string[];
  capabilities: string[];
  /** Storage collection policies by name; `*` is the default for the rest. Empty when none are declared. */
  storagePolicies: Record<string, string>;
  execution: 'main' | 'worker';
  /**
   * The site owner has marked the app trusted (an `app.json` beside its
   * versions on the server): its play page grants what it declares from the
   * start, with no permission bar.
   */
  trusted: boolean;
  version: number;
  size: number;
  primary: string | null;
  thumbnail: string;
  thumbnailKind: 'image' | 'icon' | 'placeholder';
  icon: string | null;
  /** Times the runtime reported the app up. */
  runs: number;
  /** Presses of Play on this site, which need not all have become runs. */
  launches: number;
  remixes: number;
  rating: { average: number; count: number };
  comments: number;
  parent: { slug: string; name: string } | null;
  source: 'upload' | 'api' | 'seed' | 'remix' | 'folder';
  /**
   * Set when the app lives on its own site: Play opens this address in a new
   * tab, and there is no bundle here to run, download, read or remix, so the
   * bundle URLs below are null.
   */
  external: { url: string; host: string } | null;
  createdAt: string;
  updatedAt: string;
  urls: {
    page: string;
    /** Where the app plays: its play page, or the external address of a linked app. */
    run: string;
    /** The play page; null for a linked app, as are the rest below. */
    play: string | null;
    /** The full runtime, with its launcher and tabs. */
    runtime: string | null;
    bundle: string | null;
    download: string | null;
    studio: string | null;
    builder: string | null;
    remix: string | null;
  };
}

export interface AppVersion {
  version: number;
  manifestVersion: string;
  size: number;
  sha256: string;
  notes: string;
  createdAt: string;
  bundle: string;
}

export interface AppDetail extends AppCard {
  versions: AppVersion[];
  ratingBreakdown: Record<'1' | '2' | '3' | '4' | '5', number>;
  remixList: Array<{ slug: string; name: string; author: string; createdAt: string }>;
  lineage: Array<{ slug: string; name: string; author: string }>;
  storage: { collections: number; records: number; keys: number; bytes: number };
  manifest: { main: string | null; version: string | null; files: Record<string, number> } | null;
}

export interface Category {
  id: string;
  name: string;
  description: string;
  emoji: string;
  status: string;
  suggested: boolean;
  apps: number;
}

export interface Comment {
  id: number;
  name: string;
  body: string;
  createdAt: string;
}

export interface Page<T> {
  items: T[];
  page: number;
  perPage: number;
  total: number;
  pages: number;
}

/** The capability filters the directory offers; the server knows the same names. */
export type CapabilityFilter = 'nonet' | 'storage' | 'worker' | 'none';

export interface ListParams {
  q?: string;
  category?: string;
  tag?: string;
  author?: string;
  cap?: CapabilityFilter | '';
  sort?: string;
  page?: number;
  perPage?: number;
}

export interface SourceFile {
  path: string;
  size: number;
  text: string | null;
}

export class ApiError extends Error {
  status: number;
  retryAfter?: number;
  constructor(status: number, message: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function call<T>(route: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${route}`, { credentials: 'same-origin', ...init });
  if (res.status === 204) return {} as T;
  const text = await res.text();
  let json: (Record<string, unknown> & { ok?: boolean; error?: string; retryAfter?: number }) | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!res.ok || !json || json.ok !== true) {
    const message = json?.error ?? (res.status === 503 || !json ? 'The directory is not available on this host.' : `The directory answered ${res.status}.`);
    throw new ApiError(res.status, message, typeof json?.retryAfter === 'number' ? json.retryAfter : undefined);
  }
  return json as T;
}

function jsonBody(body: unknown, method = 'POST', headers: Record<string, string> = {}): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) };
}

export async function listApps(params: ListParams, signal?: AbortSignal): Promise<Page<AppCard> & { sort: string }> {
  const qs = new URLSearchParams();
  if (params.q) qs.set('q', params.q);
  if (params.category && params.category !== 'all') qs.set('category', params.category);
  if (params.tag) qs.set('tag', params.tag);
  if (params.author) qs.set('author', params.author);
  if (params.cap) qs.set('cap', params.cap);
  if (params.sort) qs.set('sort', params.sort);
  if (params.page && params.page > 1) qs.set('page', String(params.page));
  if (params.perPage) qs.set('perPage', String(params.perPage));
  const r = await call<{ apps: AppCard[]; page: number; perPage: number; total: number; pages: number; sort: string }>(`/apps?${qs}`, { signal });
  return { items: r.apps, page: r.page, perPage: r.perPage, total: r.total, pages: r.pages, sort: r.sort };
}

export async function getApp(slug: string, signal?: AbortSignal): Promise<AppDetail> {
  return (await call<{ app: AppDetail }>(`/apps/${encodeURIComponent(slug)}`, { signal })).app;
}

export async function getCategories(signal?: AbortSignal): Promise<Category[]> {
  return (await call<{ categories: Category[] }>('/categories', { signal })).categories;
}

export async function suggestCategory(name: string, description: string, emoji: string): Promise<Category> {
  return (await call<{ category: Category }>('/categories', jsonBody({ name, description, emoji }))).category;
}

export async function getComments(slug: string, page = 1, signal?: AbortSignal): Promise<Page<Comment>> {
  const r = await call<{ comments: Comment[]; page: number; perPage: number; total: number; pages: number }>(`/apps/${encodeURIComponent(slug)}/comments?page=${page}`, { signal });
  return { items: r.comments, page: r.page, perPage: r.perPage, total: r.total, pages: r.pages };
}

export async function postComment(slug: string, name: string, body: string, website: string): Promise<Comment> {
  return (await call<{ comment: Comment }>(`/apps/${encodeURIComponent(slug)}/comments`, jsonBody({ name, body, website }))).comment;
}

export interface Rating {
  average: number;
  count: number;
  mine: number | null;
}

export async function getRating(slug: string, signal?: AbortSignal): Promise<Rating> {
  return (await call<{ rating: Rating }>(`/apps/${encodeURIComponent(slug)}/rating`, { signal })).rating;
}

export async function rate(slug: string, stars: number): Promise<Rating> {
  return (await call<{ rating: Rating }>(`/apps/${encodeURIComponent(slug)}/rating`, jsonBody({ stars }))).rating;
}

export async function getSource(slug: string, version?: number, signal?: AbortSignal): Promise<{ files: SourceFile[]; truncated: boolean; version: number }> {
  const v = version ? `?v=${version}` : '';
  return call(`/apps/${encodeURIComponent(slug)}/source${v}`, { signal });
}

export interface PublishFields {
  bundle: File;
  name?: string;
  description?: string;
  author?: string;
  category?: string;
  tags?: string;
  notes?: string;
  parent?: string;
  thumbnail?: Blob | null;
  website?: string;
  /** The site owner's key from data/config.json: not held to the hourly publish limit. */
  adminKey?: string;
}

export interface Published {
  app: AppCard;
  editKey: string | null;
  page: string;
}

export async function publish(fields: PublishFields): Promise<Published> {
  const fd = new FormData();
  fd.append('bundle', fields.bundle, fields.bundle.name || 'app.softn');
  for (const key of ['name', 'description', 'author', 'category', 'tags', 'notes', 'parent', 'website'] as const) {
    const v = fields[key];
    if (typeof v === 'string' && v !== '') fd.append(key, v);
  }
  if (fields.thumbnail) fd.append('thumbnail', fields.thumbnail, 'thumbnail.png');
  const headers: Record<string, string> = {};
  if (fields.adminKey && fields.adminKey.trim() !== '') headers['X-Admin-Key'] = fields.adminKey.trim();
  return call<Published>('/apps', { method: 'POST', body: fd, headers });
}

// ── Updating an app you published ─────────────────────────────────────────
// Everything below needs the edit key that publishing handed out. The site
// keeps the keys it has seen in this browser so the owner does not have to
// paste them back; anyone else pastes.

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
 * Read the key map. `null` means there is one and it cannot be read — as
 * distinct from there being none — so a writer can refuse to replace it.
 */
function readKeyMap(): Record<string, string> | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEYS);
  } catch {
    return {};
  }
  if (raw === null || raw === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const keys: Record<string, string> = {};
  for (const [slug, key] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof key === 'string' && key !== '') keys[slug] = key;
  }
  return keys;
}

export function savedKeys(): Record<string, string> {
  return readKeyMap() ?? {};
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
  return writeKeyMap({ ...keys, [slug]: key });
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
  const rest = { ...keys };
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
  const next = { ...current };
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

export interface ListingFields {
  name?: string;
  description?: string;
  author?: string;
  category?: string;
  tags?: string;
  primary?: string;
}

export async function updateListing(slug: string, editKey: string, fields: ListingFields): Promise<AppDetail> {
  return (await call<{ app: AppDetail }>(`/apps/${encodeURIComponent(slug)}`, jsonBody(fields, 'PATCH', { 'X-Edit-Key': editKey }))).app;
}

export async function addVersion(slug: string, editKey: string, bundle: File, notes: string): Promise<AppDetail> {
  const fd = new FormData();
  fd.append('bundle', bundle, bundle.name || 'app.softn');
  if (notes) fd.append('notes', notes);
  return (await call<{ app: AppDetail }>(`/apps/${encodeURIComponent(slug)}/versions`, { method: 'POST', body: fd, headers: { 'X-Edit-Key': editKey } })).app;
}

export async function setThumbnail(slug: string, editKey: string, image: Blob): Promise<AppCard> {
  const fd = new FormData();
  fd.append('thumbnail', image, 'thumbnail.png');
  return (await call<{ app: AppCard }>(`/apps/${encodeURIComponent(slug)}/thumbnail`, { method: 'POST', body: fd, headers: { 'X-Edit-Key': editKey } })).app;
}

export async function unpublish(slug: string, editKey: string): Promise<void> {
  await call<Record<string, never>>(`/apps/${encodeURIComponent(slug)}`, { method: 'DELETE', headers: { 'X-Edit-Key': editKey } });
}

/**
 * Count a play. Fire and forget: the caller is about to leave for the runtime,
 * and nothing about opening an app may wait on this. `keepalive` lets the
 * request outlive the page; the timeout keeps a counter endpoint that never
 * answers from holding a connection open for the rest of the runtime session.
 * Nothing is returned, so nothing can be awaited by mistake — Play once
 * navigated in this request's `.finally()`, and a slow `/runs` was a Play
 * button that appeared to do nothing.
 */
export function recordRun(slug: string): void {
  try {
    const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(10_000) : undefined;
    // A launch: the press of Play. The runtime counts the run itself, when
    // the app is up, so a bundle that failed to open is a launch and not a run.
    fetch(`/api/apps/${encodeURIComponent(slug)}/runs`, {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'launch' }),
    }).catch(() => {
      // A count nobody is waiting on.
    });
  } catch {
    // fetch itself threw (no network stack, a blocked request): same answer.
  }
}

export async function health(): Promise<{ ok: boolean; php?: string; sqlite?: string | null; fts5?: boolean; catalog?: string; cache?: string; error?: string }> {
  const res = await fetch('/api/health', { credentials: 'same-origin' });
  try {
    return (await res.json()) as { ok: boolean };
  } catch {
    return { ok: false, error: `The directory answered ${res.status}.` };
  }
}
