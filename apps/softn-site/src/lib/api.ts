/**
 * The directory API as the site sees it. Same origin, under /api/ — see
 * apps/softn-api for the server side, which is also what a script or a model
 * talks to when it publishes without a browser.
 */

import { isEditKey } from './keyStore';

export type HostingMode = 'browser' | 'server' | 'hybrid';
export type HostingFilter = 'browser' | 'server' | 'hybrid' | 'backend';

export interface AppHosting {
  mode: HostingMode;
  serverHosted: boolean;
  browserSupported: boolean;
  backendUrl: string | null;
  customBackendUrl: string | null;
  withholdBackend: boolean;
  sandbox: 'zipp-safe-sandbox' | 'browser-wasm-sandbox' | null;
}

export interface AppCard {
  slug: string;
  name: string;
  description: string;
  author: string;
  category: string;
  subcategory?: string | null;
  categoryPath?: string;
  tags: string[];
  capabilities: string[];
  /** Storage collection policies by name; `*` is the default for the rest. Empty when none are declared. */
  storagePolicies: Record<string, string>;
  execution: 'main' | 'worker';
  engine?: 1 | 2;
  backendRuntime?: string | null;
  hosting?: AppHosting;
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
    /** Play locally in the user's browser sandbox (null when backend is server-only). */
    playLocal?: string | null;
    /** The full runtime, with its launcher and tabs. */
    runtime: string | null;
    /** Full runtime forced into local browser sandbox mode (`?mode=local`). */
    runtimeLocal?: string | null;
    /** Hosted ZIPP safe-sandbox backend base URL when server-hosted. */
    backend?: string | null;
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
  /** The remixes the owner took off this page (and out of `remixes`). Absent from an older directory. */
  hiddenRemixes?: string[];
  lineage: Array<{ slug: string; name: string; author: string }>;
  storage: { collections: number; records: number; keys: number; bytes: number };
  manifest: { main: string | null; version: string | null; files: Record<string, number> } | null;
  /** On the answer to a new version: the versions that went to make room for it. Absent from an older directory. */
  droppedVersions?: number[];
}

export interface Subcategory {
  id: string;
  slug: string;
  parent: string;
  name: string;
  description: string;
  emoji: string;
  status: string;
  suggested: boolean;
  apps: number;
}

export interface Category {
  id: string;
  slug?: string;
  parent?: string | null;
  name: string;
  description: string;
  emoji: string;
  status: string;
  suggested: boolean;
  apps: number;
  directApps?: number;
  subcategories?: Subcategory[];
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
export type CapabilityFilter = 'nonet' | 'storage' | 'worker' | 'none' | 'backend';

export interface ListParams {
  q?: string;
  category?: string;
  subcategory?: string;
  tag?: string;
  author?: string;
  cap?: CapabilityFilter | '';
  hosting?: HostingFilter | '';
  sort?: string;
  page?: number;
  perPage?: number;
}

export type SourceFileKind = 'text' | 'image' | 'audio' | 'video' | 'binary';

export interface SourceFile {
  path: string;
  size: number;
  text: string | null;
  kind?: SourceFileKind;
  mime?: string;
}

/** Whether the directory allows public publishers to choose server/hybrid hosting (configured in data/config.json; off by default). */
let publicServerHostingAllowed = false;

export function isPublicServerHostingAllowed(): boolean {
  return publicServerHostingAllowed;
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
  if (params.subcategory && params.subcategory !== 'all') qs.set('subcategory', params.subcategory);
  if (params.tag) qs.set('tag', params.tag);
  if (params.author) qs.set('author', params.author);
  if (params.cap) qs.set('cap', params.cap);
  if (params.hosting) qs.set('hosting', params.hosting);
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
  const r = await call<{ categories: Category[]; allowPublicServerHosting?: boolean }>('/categories', { signal });
  publicServerHostingAllowed = r.allowPublicServerHosting === true;
  return r.categories;
}

export async function suggestCategory(name: string, description: string, emoji: string, parent?: string): Promise<Category> {
  return (await call<{ category: Category }>('/categories', jsonBody({ name, description, emoji, ...(parent ? { parent } : {}) }))).category;
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

export function sourceFileUrl(slug: string, filePath: string, version?: number, download = false): string {
  const qs = new URLSearchParams({ path: filePath });
  if (version) qs.set('v', String(version));
  if (download) qs.set('download', '1');
  return `/api/apps/${encodeURIComponent(slug)}/source/file?${qs}`;
}

export interface PublishFields {
  bundle: File;
  name?: string;
  description?: string;
  author?: string;
  category?: string;
  subcategory?: string;
  tags?: string;
  notes?: string;
  parent?: string;
  thumbnail?: Blob | null;
  website?: string;
  hosting?: HostingMode;
  backendUrl?: string;
  withholdBackend?: boolean;
  /** The site owner's key from data/config.json: not held to the hourly publish limit. */
  adminKey?: string;
}

export interface Published {
  app: AppCard;
  editKey: string | null;
  page: string;
  /** Something that did not go with the app, though it is published (its picture). */
  warning?: string;
}

export async function publish(fields: PublishFields): Promise<Published> {
  const fd = new FormData();
  fd.append('bundle', fields.bundle, fields.bundle.name || 'app.softn');
  for (const key of ['name', 'description', 'author', 'category', 'subcategory', 'tags', 'notes', 'parent', 'website', 'hosting', 'backendUrl'] as const) {
    const v = fields[key];
    if (typeof v === 'string' && v !== '') fd.append(key, v);
  }
  if (fields.withholdBackend) fd.append('withholdBackend', '1');
  if (fields.thumbnail) fd.append('thumbnail', fields.thumbnail, 'thumbnail.png');
  const headers: Record<string, string> = {};
  if (fields.adminKey && fields.adminKey.trim() !== '') headers['X-Admin-Key'] = fields.adminKey.trim();
  return call<Published>('/apps', { method: 'POST', body: fd, headers });
}

// ── Updating an app you published ─────────────────────────────────────────
// Everything below needs the edit key that publishing handed out. The keys
// this browser holds are kept by lib/keyStore.ts.

export interface ListingFields {
  name?: string;
  description?: string;
  author?: string;
  category?: string;
  subcategory?: string | null;
  tags?: string;
  primary?: string;
  hosting?: HostingMode;
  backendUrl?: string | null;
  withholdBackend?: boolean;
  /** The whole list of remixes to keep off the app's page. */
  hiddenRemixes?: string[];
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
 * Give the app a new edit key in place of `editKey`. From this answer on the
 * old key opens nothing, wherever it is kept: another browser, a script, a
 * backup. Keeping the new one is the caller's to do.
 */
export async function replaceKey(slug: string, editKey: string): Promise<{ editKey: string; app: AppCard }> {
  const r = await call<{ editKey: unknown; app: AppCard }>(`/apps/${encodeURIComponent(slug)}/key`, { method: 'POST', headers: { 'X-Edit-Key': editKey } });
  if (!isEditKey(r.editKey)) throw new ApiError(502, "The directory's answer held no new key. If the old key is refused from now on, the site owner can issue a new one.");
  return { editKey: r.editKey, app: r.app };
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
