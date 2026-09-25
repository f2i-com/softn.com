import type { LocalServerKind, ProviderConfig, ProviderType } from '../types/studio';

/**
 * Talking to a provider before any generation: where its endpoints are,
 * which models it offers, whether a key and an address work, and — when
 * they do not — a sentence a person can act on.
 *
 * Nothing here names a model. Model names change faster than Studio ships,
 * so the list always comes from the provider itself and the person picks
 * from it; a provider with no chosen model is refused, not guessed for.
 */

/** Where each local server listens out of the box. */
export const LOCAL_SERVERS: Record<LocalServerKind, { label: string; baseUrl: string; help: string }> = {
  ollama: {
    label: 'Ollama',
    baseUrl: 'http://localhost:11434',
    help: 'Start Ollama and pull at least one model. Ollama has to allow this page: set OLLAMA_ORIGINS to include this site before starting it.',
  },
  lmstudio: {
    label: 'LM Studio',
    baseUrl: 'http://localhost:1234',
    help: 'Load a model, then start the server in LM Studio’s Developer tab with “Enable CORS” switched on.',
  },
  other: {
    label: 'Another server',
    baseUrl: 'http://localhost:8080',
    help: 'Any server that speaks the OpenAI chat completions API. It has to allow requests from this page (CORS).',
  },
};

const CLOUD_BASE: Partial<Record<ProviderType, string>> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
};

/** The address a provider of this type uses when none is given. */
export function defaultBaseUrl(type: ProviderType, serverKind?: LocalServerKind): string {
  if (type === 'local') return LOCAL_SERVERS[serverKind ?? 'ollama'].baseUrl;
  if (type === 'custom') return LOCAL_SERVERS.ollama.baseUrl;
  return CLOUD_BASE[type] ?? '';
}

export interface ProviderEndpoints {
  /** Where replies are requested: chat completions, or Anthropic's messages. */
  chat: string;
  /** The OpenAI-style (or Anthropic) model list. */
  models: string;
  /** Ollama's own model list, tried when the OpenAI-style one fails. Local and custom servers only. */
  ollamaTags?: string;
}

/**
 * The endpoints for a provider, from whatever address it was saved with.
 *
 * Providers saved before this file existed stored the full completion URL
 * (`…/v1/chat/completions`, `…/v1/messages`); the setup now asks for the
 * server's address (`http://localhost:11434`) or an API base (`…/v1`).
 * All three shapes work, so nothing stored has to be migrated.
 */
export function providerEndpoints(provider: Pick<ProviderConfig, 'type' | 'baseUrl' | 'serverKind'>): ProviderEndpoints {
  const raw = provider.baseUrl?.trim() || defaultBaseUrl(provider.type, provider.serverKind);
  const isAnthropic = provider.type === 'anthropic';
  const tail = isAnthropic ? '/messages' : '/chat/completions';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // An unparseable address is reported by fetch; keep it recognisable.
    return { chat: raw, models: raw };
  }
  let path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith(tail)) path = path.slice(0, -tail.length);
  else if (path.endsWith('/models')) path = path.slice(0, -'/models'.length);
  if (path === '') path = '/v1';
  const base = `${url.origin}${path}`;
  const endpoints: ProviderEndpoints = {
    chat: `${base}${tail}${url.search}`,
    models: `${base}/models${url.search}`,
  };
  if (provider.type === 'local' || provider.type === 'custom') endpoints.ollamaTags = `${url.origin}/api/tags`;
  return endpoints;
}

/** Headers for a provider: its key in the form it expects, plus the fixed ones. */
export function providerHeaders(provider: Pick<ProviderConfig, 'type' | 'apiKey' | 'orgId'>, json = false): Record<string, string> {
  const headers: Record<string, string> = json ? { 'Content-Type': 'application/json' } : {};
  if (provider.type === 'anthropic') {
    headers['x-api-key'] = provider.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    // Anthropic refuses browser calls without this; Studio has no server of
    // its own, so the browser is the only place a request can come from.
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
    return headers;
  }
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  if (provider.type === 'openai' && provider.orgId?.trim()) headers['OpenAI-Organization'] = provider.orgId.trim();
  return headers;
}

// --- Errors a person can act on --------------------------------------------

export type ConnectionErrorKind =
  | 'auth'
  | 'forbidden'
  | 'rate-limited'
  | 'not-found'
  | 'server'
  | 'http'
  | 'network'
  | 'mixed-content'
  | 'invalid-response'
  | 'timeout'
  | 'cancelled'
  | 'no-model';

export class ProviderConnectionError extends Error {
  readonly kind: ConnectionErrorKind;
  readonly status?: number;

  constructor(kind: ConnectionErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'ProviderConnectionError';
    this.kind = kind;
    this.status = status;
  }
}

export interface ErrorContext {
  type: ProviderType;
  serverKind?: LocalServerKind;
  /** The address that was called. */
  url: string;
  /** This page's origin, for the CORS advice. */
  pageOrigin?: string;
  /** The provider's own words, when it sent any. */
  detail?: string;
}

function isLocalType(type: ProviderType): boolean {
  return type === 'local' || type === 'custom';
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** Whether a hostname is this computer — the one plain-http target an https page may call. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * Whether the browser will block this call as mixed content: an https page
 * may not call plain http, except on this computer (localhost, 127.0.0.1,
 * [::1]), which browsers treat as secure.
 */
export function isBlockedMixedContent(target: string, pageProtocol: string): boolean {
  if (pageProtocol !== 'https:') return false;
  try {
    const url = new URL(target);
    return url.protocol === 'http:' && !isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

const PROVIDER_LABEL: Record<ProviderType, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  local: 'The local server',
  custom: 'The server',
};

/** What went wrong, in words, with what to do about it. */
export function describeConnectionError(kind: ConnectionErrorKind, context: ErrorContext, status?: number): string {
  const who = PROVIDER_LABEL[context.type];
  const detail = context.detail ? ` The provider said: “${context.detail}”` : '';
  const local = isLocalType(context.type);
  switch (kind) {
    case 'auth':
      return local
        ? `${who} asked for a key and did not accept the one given (401). Enter the key it expects, or leave the key empty if it does not use one.${detail}`
        : `${who} did not accept this API key (401). Check that the whole key was pasted and that it has not been revoked.${detail}`;
    case 'forbidden':
      return local
        ? `${who} refused the request (403). Check its access settings.${detail}`
        : `${who} accepted the key but will not let it do this (403). The key may be restricted, or the account may not have access yet — check the key’s permissions and the account’s billing in the ${who} console.${detail}`;
    case 'rate-limited':
      return local
        ? `${who} is too busy to answer (429). Wait a moment and test again.${detail}`
        : `${who} is refusing requests for now (429). On a new account this usually means no credit or billing is set up; otherwise it is a rate limit. Check billing and usage in the ${who} console, then test again.${detail}`;
    case 'not-found':
      return `Nothing answered at ${context.url} (404). Check the address: it should be the server’s base, such as ${local ? LOCAL_SERVERS[context.serverKind ?? 'ollama'].baseUrl : CLOUD_BASE[context.type] ?? 'https://…/v1'}, without /chat/completions at the end.${detail}`;
    case 'server':
      return `${who} had an error of its own (${status ?? 'server error'}). Try again in a moment.${detail}`;
    case 'http':
      return `${who} answered with an error (${status ?? 'unknown status'}).${detail}`;
    case 'mixed-content':
      return `This page is served over HTTPS, and browsers block it from calling a plain http:// address that is not on this computer (${hostOf(context.url)}). For a server on this computer use http://localhost or http://127.0.0.1; for one elsewhere, put it behind HTTPS.`;
    case 'network': {
      if (!local) return `Studio could not reach ${hostOf(context.url)}. Check the internet connection, and whether an extension, proxy or firewall is blocking it.`;
      const page = context.pageOrigin ?? 'this site';
      const fix = context.serverKind === 'lmstudio'
        ? 'In LM Studio, open the Developer tab, start the server, and switch on “Enable CORS”.'
        : context.serverKind === 'other'
          ? `Allow requests from ${page} in the server’s CORS settings.`
          : `For Ollama, quit it and start it again with OLLAMA_ORIGINS set to include ${page} (for example OLLAMA_ORIGINS="${page}" ollama serve). LM Studio has an “Enable CORS” switch in its server settings.`;
      return `Studio could not reach ${originOf(context.url)}. Either the server is not running there, or it is blocking requests from this page (CORS). ${fix}`;
    }
    case 'invalid-response':
      return `${who} answered, but not with a model list. Check that the address points at an OpenAI-compatible API${local ? ' (usually ending in /v1)' : ''}.`;
    case 'timeout':
      return `${who} did not answer in time. Check that it is running and reachable, then test again.`;
    case 'cancelled':
      return 'The check was cancelled.';
    case 'no-model':
      return 'Choose a model first.';
  }
}

/** The error kind for an HTTP status. */
export function kindForStatus(status: number): ConnectionErrorKind {
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 429 || status === 402) return 'rate-limited';
  if (status === 404) return 'not-found';
  if (status >= 500) return 'server';
  return 'http';
}

/** A short excerpt of the provider's error body, if it has a message. */
async function errorDetail(resp: Response): Promise<string | undefined> {
  try {
    const text = (await resp.text()).slice(0, 2000);
    try {
      const body: unknown = JSON.parse(text);
      const error = isRecord(body) ? body.error : undefined;
      const message = isRecord(error) ? error.message : typeof error === 'string' ? error : isRecord(body) ? body.message : undefined;
      if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 240);
    } catch {
      // Not JSON; a short plain-text body is still worth showing.
    }
    const plain = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return plain && plain.length <= 240 ? plain : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// --- Model lists ------------------------------------------------------------

export interface ModelInfo {
  id: string;
  /** A friendlier name, when the provider gives one. */
  label?: string;
  /** When the provider says the model was published or last changed, in ms. */
  created?: number;
}

export interface ListModelsOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** This page's protocol and origin; default the real page's. */
  page?: { protocol: string; origin: string };
}

const LIST_TIMEOUT_MS = 15_000;
/** A provider that keeps saying "more" is not followed forever. */
const MAX_PAGES = 20;

function currentPage(): { protocol: string; origin: string } {
  if (typeof window === 'undefined') return { protocol: 'http:', origin: 'this site' };
  return { protocol: window.location.protocol, origin: window.location.origin };
}

/** A time in ms from seconds, milliseconds or an ISO string, if it is one. */
function toMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') {
    const at = Date.parse(value);
    return Number.isFinite(at) ? at : undefined;
  }
  return undefined;
}

/** Newest first when the provider says when; otherwise, and on ties, by name. */
export function sortModels(models: ModelInfo[]): ModelInfo[] {
  return [...models].sort((a, b) => {
    if (a.created !== undefined && b.created !== undefined && a.created !== b.created) return b.created - a.created;
    if (a.created !== undefined && b.created === undefined) return -1;
    if (b.created !== undefined && a.created === undefined) return 1;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Words in a model id that mean it does something other than chat: turn
 * text into vectors, speech or pictures, or check content. The list is of
 * capabilities, not of models, so a new chat model is never hidden by it.
 */
const NON_CHAT_WORDS = ['embed', 'tts', 'whisper', 'transcribe', 'speech', 'audio', 'realtime', 'dall-e', 'image', 'video', 'moderation', 'rerank'];

/** Whether an id looks like a model that can hold a conversation. */
export function isLikelyChatModel(id: string): boolean {
  const lower = id.toLowerCase();
  return !NON_CHAT_WORDS.some((word) => lower.includes(word));
}

/** The models worth offering for chat, and how many were left out. */
export function chatModels(models: ModelInfo[]): { models: ModelInfo[]; hidden: number } {
  const kept = models.filter((model) => isLikelyChatModel(model.id));
  return { models: kept, hidden: models.length - kept.length };
}

function readModelList(body: unknown): ModelInfo[] | null {
  if (!isRecord(body) || !Array.isArray(body.data)) return null;
  const models: ModelInfo[] = [];
  for (const item of body.data) {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id.trim()) continue;
    models.push({
      id: item.id,
      label: typeof item.display_name === 'string' && item.display_name !== item.id ? item.display_name : undefined,
      created: toMs(item.created_at ?? item.created),
    });
  }
  return models;
}

function readOllamaTags(body: unknown): ModelInfo[] | null {
  if (!isRecord(body) || !Array.isArray(body.models)) return null;
  const models: ModelInfo[] = [];
  for (const item of body.models) {
    if (!isRecord(item)) continue;
    const id = typeof item.model === 'string' ? item.model : typeof item.name === 'string' ? item.name : '';
    if (id.trim()) models.push({ id, created: toMs(item.modified_at) });
  }
  return models;
}

/**
 * One GET, with the failures turned into `ProviderConnectionError`s that
 * say what to do. `read` turns the JSON into a list, or null when the JSON
 * is not a list.
 */
async function getJson(
  url: string,
  headers: Record<string, string>,
  context: Omit<ErrorContext, 'url'>,
  options: ListModelsOptions,
): Promise<unknown> {
  const page = options.page ?? currentPage();
  if (isBlockedMixedContent(url, page.protocol)) {
    throw new ProviderConnectionError('mixed-content', describeConnectionError('mixed-content', { ...context, url, pageOrigin: page.origin }));
  }
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? LIST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (options.signal?.aborted) controller.abort();
    controller.signal.throwIfAborted();
    const resp = await doFetch(url, { method: 'GET', headers, signal: controller.signal });
    if (!resp.ok) {
      const kind = kindForStatus(resp.status);
      const detail = await errorDetail(resp);
      throw new ProviderConnectionError(kind, describeConnectionError(kind, { ...context, url, pageOrigin: page.origin, detail }, resp.status), resp.status);
    }
    const text = await resp.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new ProviderConnectionError('invalid-response', describeConnectionError('invalid-response', { ...context, url }));
    }
  } catch (err) {
    if (err instanceof ProviderConnectionError) throw err;
    if (options.signal?.aborted) throw new ProviderConnectionError('cancelled', describeConnectionError('cancelled', { ...context, url }));
    if (timedOut) throw new ProviderConnectionError('timeout', describeConnectionError('timeout', { ...context, url }));
    // fetch says only "Failed to fetch" for a server that is down and for a
    // CORS refusal alike; the message covers both.
    throw new ProviderConnectionError('network', describeConnectionError('network', { ...context, url, pageOrigin: page.origin }));
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Every model the provider offers, newest first where it says when.
 *
 * - OpenAI and OpenAI-compatible servers: `GET {base}/models`.
 * - Anthropic: `GET {base}/models`, following `has_more`/`last_id` pages.
 * - Local and custom servers: when `/models` fails, Ollama's `/api/tags`
 *   is tried before giving up, and the first error is the one reported.
 *
 * The list is returned whole; `chatModels` decides what to offer.
 */
export async function listModels(
  provider: Pick<ProviderConfig, 'type' | 'apiKey' | 'baseUrl' | 'orgId' | 'serverKind'>,
  options: ListModelsOptions = {},
): Promise<ModelInfo[]> {
  const endpoints = providerEndpoints(provider);
  const headers = providerHeaders(provider);
  const context = { type: provider.type, serverKind: provider.serverKind };

  if (provider.type === 'anthropic') {
    const all: ModelInfo[] = [];
    const seen = new Set<string>();
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(endpoints.models);
      url.searchParams.set('limit', '1000');
      if (after) url.searchParams.set('after_id', after);
      const body = await getJson(url.toString(), headers, context, options);
      const models = readModelList(body);
      if (!models) throw new ProviderConnectionError('invalid-response', describeConnectionError('invalid-response', { ...context, url: endpoints.models }));
      for (const model of models) {
        if (!seen.has(model.id)) {
          seen.add(model.id);
          all.push(model);
        }
      }
      const record = body as Record<string, unknown>;
      const next = typeof record.last_id === 'string' ? record.last_id : null;
      if (record.has_more !== true || !next || next === after) break;
      after = next;
    }
    return sortModels(all);
  }

  try {
    const body = await getJson(endpoints.models, headers, context, options);
    const models = readModelList(body) ?? readOllamaTags(body);
    if (!models) throw new ProviderConnectionError('invalid-response', describeConnectionError('invalid-response', { ...context, url: endpoints.models }));
    return sortModels(models);
  } catch (err) {
    const first = err instanceof ProviderConnectionError ? err : null;
    const retryable = first && !['cancelled', 'mixed-content', 'auth'].includes(first.kind);
    if (!endpoints.ollamaTags || !retryable) throw err;
    try {
      const body = await getJson(endpoints.ollamaTags, headers, context, options);
      const models = readOllamaTags(body);
      if (!models) throw first;
      return sortModels(models);
    } catch {
      throw first;
    }
  }
}
