/**
 * Direct publishing from AI Studio and Builder straight to the SoftN directory API
 * (`/api/apps`, `/api/apps/:slug/versions`, `/api/categories`) without leaving the editor.
 *
 * Shares the exact same `localStorage` edit-key store (`softn.site.editKeys`) and author
 * preference (`softn.site.author`) as the softn.com `/publish` page, so apps published
 * from inside Studio or Builder immediately appear under "Your apps" on `/publish` and
 * can be updated with one click from either editor or the site.
 */

export type HostingMode = 'browser' | 'server' | 'hybrid';

export interface DirectorySubcategory {
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

export interface DirectoryCategory {
  id: string;
  slug?: string;
  parent?: string | null;
  name: string;
  description: string;
  emoji: string;
  status: string;
  suggested: boolean;
  apps: number;
  subcategories?: DirectorySubcategory[];
}

export interface PublishedAppSummary {
  slug: string;
  name: string;
  category: string;
  subcategory?: string | null;
  version: number;
  urls: {
    page: string;
    run: string;
    play?: string | null;
    runtime?: string | null;
  };
}

export interface DirectPublishResult {
  app: PublishedAppSummary;
  editKey: string | null;
  page: string;
  warning?: string;
  keyKept: 'stored' | 'blocked' | 'unreadable';
}

export interface DirectVersionResult {
  app: PublishedAppSummary;
}

export class DirectPublishError extends Error {
  status: number;
  retryAfter?: number;
  constructor(status: number, message: string, retryAfter?: number) {
    super(message);
    this.name = 'DirectPublishError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export const EDIT_KEYS_STORAGE_KEY = 'softn.site.editKeys';
export const AUTHOR_STORAGE_KEY = 'softn.site.author';
const PROJECT_SLUGS_STORAGE_KEY = 'softn.editor.publishedSlugs';

function emptyMap(): Record<string, string> {
  return Object.assign(Object.create(null) as Record<string, string>);
}

function readEditKeyMap(): Record<string, string> | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(EDIT_KEYS_STORAGE_KEY);
  } catch {
    return emptyMap();
  }
  if (raw === null || raw === '') return emptyMap();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const out = emptyMap();
    for (const [slug, key] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof key === 'string' && key !== '') out[slug] = key;
    }
    return out;
  } catch {
    return null;
  }
}

export function savedEditorEditKeys(): Record<string, string> {
  return readEditKeyMap() ?? emptyMap();
}

export function rememberEditorEditKey(slug: string, editKey: string): 'stored' | 'blocked' | 'unreadable' {
  const existing = readEditKeyMap();
  if (existing === null) return 'unreadable';
  const next = Object.assign(emptyMap(), existing, { [slug]: editKey });
  try {
    const serialized = JSON.stringify(next);
    localStorage.setItem(EDIT_KEYS_STORAGE_KEY, serialized);
    return localStorage.getItem(EDIT_KEYS_STORAGE_KEY) === serialized ? 'stored' : 'blocked';
  } catch {
    return 'blocked';
  }
}

export function savedAuthorName(): string {
  try {
    return localStorage.getItem(AUTHOR_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function rememberAuthorName(author: string): void {
  const trimmed = author.trim();
  if (!trimmed) return;
  try {
    localStorage.setItem(AUTHOR_STORAGE_KEY, trimmed);
  } catch {
    /* storage unavailable */
  }
}

export function savedProjectPublishedSlug(projectKey: string | undefined): string | null {
  if (!projectKey) return null;
  try {
    const raw = localStorage.getItem(PROJECT_SLUGS_STORAGE_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, unknown>;
    const slug = map[projectKey];
    return typeof slug === 'string' && slug ? slug : null;
  } catch {
    return null;
  }
}

export function rememberProjectPublishedSlug(projectKey: string | undefined, slug: string): void {
  if (!projectKey || !slug) return;
  try {
    const raw = localStorage.getItem(PROJECT_SLUGS_STORAGE_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    map[projectKey] = slug;
    localStorage.setItem(PROJECT_SLUGS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* storage unavailable */
  }
}

async function apiJson<T>(route: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${route}`, { credentials: 'same-origin', ...init });
  } catch {
    throw new DirectPublishError(0, 'Could not reach the SoftN directory API from this host.');
  }
  const text = await res.text();
  let json: (Record<string, unknown> & { ok?: boolean; error?: string; retryAfter?: number }) | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown> & { ok?: boolean; error?: string; retryAfter?: number };
  } catch {
    json = null;
  }
  if (!res.ok || !json || json.ok !== true) {
    const message =
      json?.error ??
      (res.status === 404 || res.status === 503 || !json
        ? 'The SoftN directory API is not available on this host.'
        : `The directory answered ${res.status}.`);
    throw new DirectPublishError(res.status, message, typeof json?.retryAfter === 'number' ? json.retryAfter : undefined);
  }
  return json as T;
}

export interface DirectoryCategoriesResponse {
  categories: DirectoryCategory[];
  allowPublicServerHosting: boolean;
}

export async function fetchDirectoryCategoriesInfo(signal?: AbortSignal): Promise<DirectoryCategoriesResponse> {
  const r = await apiJson<{ categories: DirectoryCategory[]; allowPublicServerHosting?: boolean }>('/categories', { signal });
  return {
    categories: Array.isArray(r.categories) ? r.categories : [],
    allowPublicServerHosting: r.allowPublicServerHosting === true,
  };
}

export async function fetchDirectoryCategories(signal?: AbortSignal): Promise<DirectoryCategory[]> {
  return (await fetchDirectoryCategoriesInfo(signal)).categories;
}

export async function suggestDirectoryCategory(input: {
  name: string;
  description: string;
  emoji: string;
  parent?: string;
}): Promise<DirectoryCategory> {
  const r = await apiJson<{ category: DirectoryCategory }>('/categories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: input.name,
      description: input.description,
      emoji: input.emoji,
      ...(input.parent ? { parent: input.parent } : {}),
    }),
  });
  return r.category;
}

export interface DirectPublishInput {
  bytes: Uint8Array;
  fileName: string;
  name: string;
  description: string;
  author: string;
  category: string;
  subcategory?: string;
  tags?: string;
  notes?: string;
  hosting?: HostingMode;
  backendUrl?: string;
  withholdBackend?: boolean;
  thumbnail?: Blob | null;
  projectKey?: string;
}

export async function publishBundleDirect(input: DirectPublishInput): Promise<DirectPublishResult> {
  const fd = new FormData();
  const blob = new Blob([input.bytes as BlobPart], { type: 'application/zip' });
  fd.append('bundle', blob, input.fileName || 'app.softn');
  const fields: Record<string, string | undefined> = {
    name: input.name.trim(),
    description: input.description.trim(),
    author: input.author.trim(),
    category: input.category,
    subcategory: input.subcategory,
    tags: input.tags?.trim(),
    notes: input.notes?.trim(),
    hosting: input.hosting,
    backendUrl: input.backendUrl?.trim(),
  };
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string' && v !== '') fd.append(k, v);
  }
  if (input.hosting === 'server' && input.withholdBackend) fd.append('withholdBackend', '1');
  if (input.thumbnail) fd.append('thumbnail', input.thumbnail, 'thumbnail.png');

  const r = await apiJson<{ app: PublishedAppSummary; editKey: string | null; page: string; warning?: string }>('/apps', {
    method: 'POST',
    body: fd,
  });

  rememberAuthorName(input.author);
  const keyKept = r.editKey ? rememberEditorEditKey(r.app.slug, r.editKey) : 'stored';
  if (input.projectKey) rememberProjectPublishedSlug(input.projectKey, r.app.slug);
  return { ...r, keyKept };
}

export async function publishVersionDirect(input: {
  slug: string;
  editKey: string;
  bytes: Uint8Array;
  fileName: string;
  notes?: string;
  projectKey?: string;
}): Promise<DirectVersionResult> {
  const fd = new FormData();
  const blob = new Blob([input.bytes as BlobPart], { type: 'application/zip' });
  fd.append('bundle', blob, input.fileName || 'app.softn');
  if (input.notes?.trim()) fd.append('notes', input.notes.trim());

  const r = await apiJson<{ app: PublishedAppSummary }>(`/apps/${encodeURIComponent(input.slug)}/versions`, {
    method: 'POST',
    body: fd,
    headers: { 'X-Edit-Key': input.editKey },
  });
  if (input.projectKey) rememberProjectPublishedSlug(input.projectKey, r.app.slug);
  return r;
}

/** Suggest a sensible starting category & subcategory from manifest hints and project metadata. */
export function inferCategorySuggestion(
  categories: DirectoryCategory[],
  hints: {
    name?: string;
    description?: string;
    backendRuntime?: string | null;
    manifestCategory?: string;
    manifestSubcategory?: string;
  },
): { category: string; subcategory: string } {
  const hasCat = (id: string) => categories.some((c) => c.id === id);
  const hasSub = (catId: string, subSlug: string) =>
    categories.find((c) => c.id === catId)?.subcategories?.some((s) => s.slug === subSlug) ?? false;

  if (hints.manifestCategory) {
    const raw = hints.manifestCategory.trim().toLowerCase();
    if (raw.includes('/')) {
      const [c, s] = raw.split('/', 2);
      if (hasCat(c)) return { category: c, subcategory: hasSub(c, s) ? s : '' };
    }
    if (raw === 'story' && hasCat('games')) return { category: 'games', subcategory: hasSub('games', 'story') ? 'story' : '' };
    if (raw === 'strategy' && hasCat('games')) return { category: 'games', subcategory: hasSub('games', 'strategy') ? 'strategy' : '' };
    if (hasCat(raw)) {
      const sub = hints.manifestSubcategory?.trim().toLowerCase() ?? '';
      return { category: raw, subcategory: sub && hasSub(raw, sub) ? sub : '' };
    }
  }

  const hay = `${hints.name ?? ''} ${hints.description ?? ''}`.toLowerCase();
  if (hints.backendRuntime && hasCat('business') && /\b(ops|desk|pos|invoice|booking|clinic|salon|cafe|restaurant|inventory|crm|fleet|hr|finance|shop|client|appointment)\b/.test(hay)) {
    return { category: 'business', subcategory: '' };
  }
  if (/\b(game|arcade|puzzle|tetris|snake|maze|rpg|shooter|platformer|poker|chess|voxel|dungeon|racing)\b/.test(hay) && hasCat('games')) {
    const sub = /\b(3d|voxel|fps|first-person|maze)\b/.test(hay)
      ? '3d'
      : /\b(puzzle|2048|sudoku|word|trivia|riddle)\b/.test(hay)
        ? 'puzzle'
        : /\b(strategy|city|colony|tycoon|management|rts)\b/.test(hay)
          ? 'strategy'
          : /\b(story|narrative|novel|mystery|adventure)\b/.test(hay)
            ? 'story'
            : /\b(retro|card|poker|blackjack|tabletop)\b/.test(hay)
              ? 'retro'
              : 'arcade';
    return { category: 'games', subcategory: hasSub('games', sub) ? sub : '' };
  }
  if (/\b(simulat|ecosystem|physics|orbit|traffic|weather|planet)\b/.test(hay) && hasCat('simulations')) {
    return { category: 'simulations', subcategory: '' };
  }
  if (/\b(ai|llm|chatbot|assistant|prompt|model)\b/.test(hay) && hasCat('ai')) {
    return { category: 'ai', subcategory: '' };
  }
  if (/\b(draw|paint|music|synth|photo|design|canvas|art|studio)\b/.test(hay) && hasCat('creative')) {
    return { category: 'creative', subcategory: '' };
  }
  if (/\b(note|todo|task|planner|calendar|tracker|habit|journal|kanban)\b/.test(hay) && hasCat('productivity')) {
    return { category: 'productivity', subcategory: '' };
  }
  if (/\b(quiz|flashcard|learn|tutor|study|lesson)\b/.test(hay) && hasCat('education')) {
    return { category: 'education', subcategory: '' };
  }
  if (hasCat('tools')) return { category: 'tools', subcategory: '' };
  return { category: categories[0]?.id ?? 'other', subcategory: '' };
}
