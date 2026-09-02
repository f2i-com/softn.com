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
  execution: 'main' | 'worker';
  version: number;
  size: number;
  primary: string | null;
  thumbnail: string;
  thumbnailKind: 'image' | 'icon' | 'placeholder';
  icon: string | null;
  runs: number;
  remixes: number;
  rating: { average: number; count: number };
  comments: number;
  parent: { slug: string; name: string } | null;
  source: 'upload' | 'api' | 'seed' | 'remix';
  createdAt: string;
  updatedAt: string;
  urls: { page: string; run: string; bundle: string; download: string; studio: string; builder: string; remix: string };
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

export interface ListParams {
  q?: string;
  category?: string;
  tag?: string;
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
  const text = await res.text();
  let json: (Record<string, unknown> & { ok?: boolean; error?: string; retryAfter?: number }) | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!res.ok || !json || json.ok !== true) {
    const message = json?.error ?? (res.status === 503 ? 'The directory is not available on this host.' : `The directory answered ${res.status}.`);
    throw new ApiError(res.status, message, typeof json?.retryAfter === 'number' ? json.retryAfter : undefined);
  }
  return json as T;
}

function jsonBody(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export async function listApps(params: ListParams, signal?: AbortSignal): Promise<Page<AppCard> & { sort: string }> {
  const qs = new URLSearchParams();
  if (params.q) qs.set('q', params.q);
  if (params.category && params.category !== 'all') qs.set('category', params.category);
  if (params.tag) qs.set('tag', params.tag);
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
  return call<Published>('/apps', { method: 'POST', body: fd });
}

export async function recordRun(slug: string): Promise<void> {
  try {
    await fetch(`/api/apps/${encodeURIComponent(slug)}/runs`, { method: 'POST', credentials: 'same-origin' });
  } catch {
    // A count nobody is waiting on.
  }
}

export async function health(): Promise<{ ok: boolean; php?: string; sqlite?: string; fts5?: boolean; error?: string }> {
  const res = await fetch('/api/health', { credentials: 'same-origin' });
  try {
    return (await res.json()) as { ok: boolean };
  } catch {
    return { ok: false, error: `The directory answered ${res.status}.` };
  }
}
