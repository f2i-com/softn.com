/**
 * `softn.ai.model.*` on the page: where a model may come from, how much of one
 * an app may hold, and the Worker each loaded model lives in.
 *
 * The model itself never runs here. Each one is a Worker of its own
 * (model-worker.ts) holding ZIPP's engine, the weights and the device, so a
 * release is a terminate and so is a generation that will not stop. What
 * happens on the page is policy and plumbing:
 *
 *   - The source. A GGUF file from a Hugging Face repository (the hub and its
 *     file store, nothing else), from a URL the app's `net` entry allows, or
 *     from the app's own bundle, each only if `ai.allowedSources` names it.
 *   - The size. `ai.maxModelSizeMB` is checked against what the server says
 *     before anything is downloaded, and against what actually arrives while
 *     it does, so a server that lies is cut off at the limit.
 *   - The copy. A download is streamed into Cache Storage and read back as a
 *     Blob the browser keeps on disk; the Worker reads the ranges it needs. It
 *     is never one buffer in memory, and the next load is local.
 */
import type { AIPermissionConfig } from '../ai-manager';
import { describeNetDestination, type NetPermission } from '../egress-policy';
import type { ChatMessage } from './chat-template';
import type { WorkerReply, WorkerRequest } from './model-worker';
import type { GenerateOptions, GenerateResult, ModelBackend, ModelInfo } from './zipp-model-runner';

export type ModelSpec = string | { huggingface?: string; file?: string; revision?: string; url?: string; bundle?: string };

export interface ModelLoadOptions {
  file?: string;
  revision?: string;
  device?: string;
  context?: number;
}

export interface ModelHostConfig {
  ai?: AIPermissionConfig;
  net?: NetPermission;
  /** A file of the app's own bundle, or null when it has none by that name. */
  readBundleFile?: (path: string) => Promise<Blob | null>;
  /** Makes the Worker a model lives in; tests hand in their own. */
  createWorker?: () => Worker;
}

interface Resolved {
  kind: 'huggingface' | 'url' | 'bundle';
  label: string;
  url?: string;
  path?: string;
}

const MB = 1024 * 1024;
const DEFAULT_MAX_MB = 1024;
const MAX_LOADED = 2;
const CACHE_NAME = 'softn-models-v1';
const HUB = 'https://huggingface.co';
/** Opening includes compiling the architecture and uploading the weights. */
const OPEN_TIMEOUT = 5 * 60_000;
/** A reply of the longest length on the slowest backend, with room to spare. */
const GENERATE_TIMEOUT = 15 * 60_000;
/** Which of a repository's quantizations to take when the app names none: the ones ZIPP keeps resident as blocks. */
const PREFERRED_QUANTS = ['Q4_K_M', 'Q4_K_S', 'Q6_K'];

const REPO = /^[A-Za-z0-9][\w.-]{0,95}\/[A-Za-z0-9][\w.-]{0,95}$/;
const REVISION = /^[\w.-]{1,64}$/;

/** A relative path to a .gguf file, a few folders deep at most, with no `.` or `..` in it. */
function isGgufPath(path: string): boolean {
  const parts = path.split('/');
  return parts.length <= 5 && /\.gguf$/i.test(path) && parts.every((part) => /^[\w.-]{1,128}$/.test(part) && part !== '.' && part !== '..');
}

/** The hub and its file store, which `resolve` URLs redirect to. */
export function isHubHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'huggingface.co' || host.endsWith('.huggingface.co') || host === 'hf.co' || host.endsWith('.hf.co');
}

/** A spec, as a source and where it lives, refused by name where it is not a model this host can fetch. */
export function parseModelSpec(spec: ModelSpec, options: ModelLoadOptions = {}): { kind: Resolved['kind']; repo?: string; file?: string; quant?: string; revision: string; url?: string; path?: string } {
  const revision = options.revision ?? (typeof spec === 'object' ? spec.revision : undefined) ?? 'main';
  if (!REVISION.test(revision)) throw new Error('A revision is a branch, tag or commit name');
  if (typeof spec === 'object' && spec) {
    if (spec.bundle !== undefined) {
      if (typeof spec.bundle !== 'string' || !isGgufPath(spec.bundle.replace(/^\.\//, ''))) throw new Error('A bundled model is a .gguf file in the bundle');
      return { kind: 'bundle', path: spec.bundle.replace(/^\.\//, ''), revision };
    }
    if (spec.url !== undefined) return { kind: 'url', url: String(spec.url), revision };
    if (spec.huggingface !== undefined) return parseModelSpec(String(spec.huggingface), { ...options, file: options.file ?? spec.file, revision });
    throw new Error('Name a model with huggingface, url or bundle');
  }
  if (typeof spec !== 'string' || !spec) throw new Error('Name a model to load');
  if (/^https?:\/\//i.test(spec)) return { kind: 'url', url: spec, revision };
  const [repo, quant] = spec.split(':');
  if (!REPO.test(repo)) throw new Error(`${JSON.stringify(spec).slice(0, 80)} is not a Hugging Face repository (owner/name)`);
  if (/-onnx$/i.test(repo) || /^onnx-community\//i.test(repo)) {
    throw new Error(`${repo} holds ONNX files; SoftN runs GGUF checkpoints, through ZIPP. Name a repository of .gguf files`);
  }
  const file = options.file;
  if (file !== undefined && !isGgufPath(file)) throw new Error('file is the name of a .gguf file in the repository');
  if (quant !== undefined && !/^[\w-]{1,24}$/.test(quant)) throw new Error('After the colon comes a quantization, such as Q4_K_M');
  return { kind: 'huggingface', repo, file, quant, revision };
}

/** The repository's GGUF file to take: the one named, else a quantization that stays resident. */
export function chooseGgufFile(paths: readonly string[], quant?: string): string {
  const files = paths.filter((p) => /\.gguf$/i.test(p) && !/mmproj/i.test(p) && !/-\d{5}-of-\d{5}\.gguf$/i.test(p));
  if (!files.length) throw new Error('The repository has no single-file GGUF checkpoint');
  const named = (q: string) => files.find((p) => p.toUpperCase().includes(q.toUpperCase()));
  const pick = quant ? named(quant) : PREFERRED_QUANTS.map(named).find(Boolean);
  if (!pick) {
    throw new Error(`No ${quant ? `${quant} ` : 'Q4_K or Q6_K '}file in the repository; it has ${files.slice(0, 8).join(', ')}${files.length > 8 ? ', …' : ''}`);
  }
  return pick;
}

/** A body that errors once it passes `max` bytes, saying so to `onOver` as well. */
function capped(body: ReadableStream<Uint8Array>, max: number, label: string, onOver: () => void = () => {}): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > max) {
        onOver();
        controller.error(new Error(`${label} passes the app's limit of ${Math.round(max / MB)} MB`));
      } else controller.enqueue(chunk);
    },
  }));
}

async function openCache(): Promise<Cache | null> {
  try {
    return typeof caches === 'undefined' ? null : await caches.open(CACHE_NAME);
  } catch {
    // An opaque origin, or storage the person turned off: the model is
    // fetched every time instead, which costs time and nothing else.
    return null;
  }
}

/** Whether the origin's storage has room for `bytes` more, with a margin; yes when the browser will not say. */
async function roomFor(bytes: number | null): Promise<boolean> {
  if (bytes === null) return true;
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (!estimate || typeof estimate.quota !== 'number') return true;
    return estimate.quota - (estimate.usage ?? 0) > bytes * 1.2;
  } catch {
    return true;
  }
}

/** The response's body, capped at the app's limit, once its status, its final host and its declared size have passed. */
async function download(url: string, label: string, maxBytes: number, redirect: RequestRedirect, finalHost: (host: string) => boolean) {
  // No cookie of the page goes with it and no referrer, and the browser's own
  // cache keeps no second copy of a file this large.
  const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect, cache: 'no-store' });
  const cancel = () => response.body?.cancel().catch(() => {});
  if (!response.ok || !response.body) {
    void cancel();
    throw new Error(`${label} could not be downloaded (${response.status} ${response.statusText})`);
  }
  const host = new URL(response.url || url).hostname;
  if (!finalHost(host)) {
    void cancel();
    throw new Error(`${label} was redirected to ${host}, which this app may not download from`);
  }
  const header = response.headers.get('content-length');
  const declared = header !== null && /^\d+$/.test(header) ? Number(header) : null;
  if (declared !== null && declared > maxBytes) {
    void cancel();
    throw new Error(`${label} is ${Math.round(declared / MB)} MB, past the app's limit of ${Math.round(maxBytes / MB)} MB`);
  }
  let over = false;
  const body = capped(response.body, maxBytes, label, () => { over = true; });
  return { body, declared, over: () => over };
}

/**
 * Fetch a model file as a Blob, from Cache Storage when it is there.
 * `finalHost` judges where the bytes actually came from, after redirects.
 *
 * A copy is kept when the origin has room for it. When it has not, or the
 * cache refuses it anyway (a private window's small quota answers with an
 * "unexpected internal error"), the file is downloaded again and held for
 * this load only: the app's model still loads, and only the next load pays.
 */
export async function fetchModel(url: string, label: string, maxBytes: number, redirect: RequestRedirect, finalHost: (host: string) => boolean): Promise<Blob> {
  const cache = await openCache();
  const hit = await cache?.match(url).catch(() => undefined);
  if (hit) {
    const blob = await hit.blob();
    if (blob.size > 0 && blob.size <= maxBytes) return blob;
  }
  const first = await download(url, label, maxBytes, redirect, finalHost);
  if (!cache || !(await roomFor(first.declared))) return new Response(first.body).blob();
  try {
    await cache.put(url, new Response(first.body, { headers: { 'content-type': 'application/octet-stream' } }));
    const stored = await cache.match(url);
    if (stored) return stored.blob();
  } catch (error) {
    // Past the limit is the app's answer, whatever the cache made of it.
    if (first.over()) throw new Error(`${label} passes the app's limit of ${Math.round(maxBytes / MB)} MB`);
    await cache.delete(url).catch(() => false);
    if (!(error instanceof Error) || error.name === 'AbortError') throw error;
  }
  return new Response((await download(url, label, maxBytes, redirect, finalHost)).body).blob();
}

class ModelWorker {
  readonly worker: Worker;
  #next = 1;
  #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; onText?: (text: string) => void }>();
  #dead: Error | null = null;

  constructor(worker: Worker) {
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const reply = event.data;
      if (!reply || typeof reply !== 'object' || reply.type === 'progress') return;
      const pending = this.#pending.get(reply.id);
      if (!pending) return;
      if (reply.type === 'text') { pending.onText?.(String(reply.text)); return; }
      this.#pending.delete(reply.id);
      clearTimeout(pending.timer);
      if (reply.type === 'error') pending.reject(new Error(String(reply.message)));
      else pending.resolve(reply.value);
    };
    worker.onerror = (event) => {
      event.preventDefault?.();
      this.fail(new Error(`The model worker failed${event.message ? `: ${event.message}` : ''}`));
    };
  }

  request(message: WorkerRequest extends infer R ? (R extends unknown ? Omit<R, 'id'> : never) : never, timeout: number, onText?: (text: string) => void): { id: number; done: Promise<unknown> } {
    const id = this.#next++;
    const done = new Promise<unknown>((resolve, reject) => {
      if (this.#dead) { reject(this.#dead); return; }
      const timer = setTimeout(() => this.fail(new Error('The model stopped answering and was released')), timeout);
      this.#pending.set(id, { resolve, reject, timer, onText });
      this.worker.postMessage({ ...message, id } as WorkerRequest);
    });
    return { id, done };
  }

  cancel(id: number): void {
    if (!this.#dead) this.worker.postMessage({ type: 'cancel', id } satisfies WorkerRequest);
  }

  fail(error: Error): void {
    if (this.#dead) return;
    this.#dead = error;
    this.worker.terminate();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  get dead(): boolean {
    return this.#dead !== null;
  }
}

interface LoadedModel {
  worker: ModelWorker;
  info: ModelInfo;
  label: string;
  generating: number | null;
}

function defaultWorker(): Worker {
  // A variable, as the speech and script workers have it: a literal would be
  // rewritten by Vite into a hashed copy without the modules beside it.
  const path = './core-runtime/runtime/model-worker.js';
  return new Worker(new URL(path, import.meta.url), { type: 'module' });
}

const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** The generation options apps pass, in transformers.js's names or SoftN's. */
export function generationOptions(raw: Record<string, unknown>): GenerateOptions {
  const sample = raw.do_sample ?? raw.doSample;
  return {
    maxNewTokens: num(raw.max_new_tokens ?? raw.maxNewTokens),
    temperature: sample === false ? 0 : num(raw.temperature),
    topK: num(raw.top_k ?? raw.topK),
    topP: num(raw.top_p ?? raw.topP),
    repetitionPenalty: num(raw.repetition_penalty ?? raw.repetitionPenalty),
    thinking: (raw.enable_thinking ?? raw.thinking) === true,
    seed: num(raw.seed),
  };
}

export class ModelHost {
  #models = new Map<string, LoadedModel>();
  #loading = 0;
  #next = 1;
  #closed = false;

  constructor(private readonly config: ModelHostConfig) {}

  private maxBytes(): number {
    const mb = num(this.config.ai?.maxModelSizeMB) ?? DEFAULT_MAX_MB;
    return Math.max(1, mb) * MB;
  }

  private allow(kind: Resolved['kind']): void {
    const allowed = this.config.ai?.allowedSources;
    if (allowed && !allowed.includes(kind)) {
      throw new Error(`This app's ai permission does not allow models from ${kind === 'huggingface' ? 'Hugging Face' : kind === 'url' ? 'a URL' : 'its bundle'}`);
    }
  }

  /** The checkpoint as a Blob, from wherever the spec names, held to the app's permission. */
  async fetchCheckpoint(spec: ModelSpec, options: ModelLoadOptions): Promise<{ blob: Blob; label: string }> {
    const parsed = parseModelSpec(spec, options);
    this.allow(parsed.kind);
    const maxBytes = this.maxBytes();
    if (parsed.kind === 'bundle') {
      const blob = await this.config.readBundleFile?.(parsed.path!);
      if (!blob) throw new Error(`The bundle has no ${parsed.path}`);
      if (blob.size > maxBytes) throw new Error(`${parsed.path} passes the app's limit of ${Math.round(maxBytes / MB)} MB`);
      return { blob, label: parsed.path! };
    }
    if (parsed.kind === 'url') {
      // The network, so `ai` alone does not reach it: the same `net` verdict
      // `softn.net.fetch` gets, and no redirect to anywhere it was not given.
      const net = this.config.net;
      if (net?.enabled !== true) throw new Error('Downloading a model from a URL needs net in permission.json');
      const verdict = describeNetDestination(parsed.url!, net);
      if (!verdict.allowed) throw new Error(`Model URL not allowed: ${verdict.reason}`);
      if (!/\.gguf(?:[?#]|$)/i.test(parsed.url!)) throw new Error('A model URL names a .gguf file');
      return { blob: await fetchModel(parsed.url!, parsed.url!, maxBytes, 'error', () => true), label: parsed.url! };
    }
    // The hub: its API lists the repository, and the file comes from its
    // resolve URL, which redirects to its file store and nowhere else.
    const repoPath = parsed.repo!.split('/').map(encodeURIComponent).join('/');
    let file = parsed.file;
    if (!file) {
      const listing = await fetch(`${HUB}/api/models/${repoPath}/tree/${encodeURIComponent(parsed.revision)}`, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
      if (!listing.ok) throw new Error(`Hugging Face has no repository ${parsed.repo} (${listing.status})`);
      const entries = (await listing.json()) as Array<{ type?: string; path?: string; size?: number; lfs?: { size?: number } }>;
      file = chooseGgufFile(Array.isArray(entries) ? entries.filter((e) => e.type === 'file' && typeof e.path === 'string').map((e) => e.path!) : [], parsed.quant);
      const size = entries.find((e) => e.path === file);
      const bytes = num(size?.lfs?.size) ?? num(size?.size);
      if (bytes !== undefined && bytes > maxBytes) {
        throw new Error(`${file} is ${Math.round(bytes / MB)} MB, past the app's limit of ${Math.round(maxBytes / MB)} MB`);
      }
    }
    const url = `${HUB}/${repoPath}/resolve/${encodeURIComponent(parsed.revision)}/${file.split('/').map(encodeURIComponent).join('/')}`;
    const label = `${parsed.repo}/${file}`;
    return { blob: await fetchModel(url, label, maxBytes, 'follow', isHubHost), label };
  }

  async load(spec: ModelSpec, options: ModelLoadOptions = {}): Promise<{ modelHandle: string; modelId: string } & ModelInfo> {
    if (this.#closed) throw new Error('The app has closed');
    if (this.#models.size + this.#loading >= MAX_LOADED) throw new Error(`An app holds at most ${MAX_LOADED} models; release one first`);
    this.#loading++;
    try {
      const { blob, label } = await this.fetchCheckpoint(spec, options);
      const device = options.device === 'webgpu' || options.device === 'wasm' ? options.device : 'auto';
      const worker = new ModelWorker((this.config.createWorker ?? defaultWorker)());
      let info: ModelInfo;
      try {
        info = (await worker.request({ type: 'open', blob, backend: device as ModelBackend, context: num(options.context) }, OPEN_TIMEOUT).done) as ModelInfo;
      } catch (error) {
        worker.fail(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
      if (this.#closed) { worker.fail(new Error('The app has closed')); throw new Error('The app has closed'); }
      const handle = `model-${this.#next++}`;
      this.#models.set(handle, { worker, info, label, generating: null });
      return { modelHandle: handle, modelId: label, ...info };
    } finally {
      this.#loading--;
    }
  }

  private model(handle: string): LoadedModel {
    const model = this.#models.get(handle);
    if (!model) throw new Error(`No model ${String(handle).slice(0, 40)} is loaded`);
    if (model.worker.dead) {
      this.#models.delete(handle);
      throw new Error('That model was released after it stopped answering; load it again');
    }
    return model;
  }

  async generate(handle: string, messages: ChatMessage[], options: Record<string, unknown> = {}, onText?: (text: string) => void): Promise<GenerateResult> {
    const model = this.model(handle);
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > 400) throw new Error('Give between 1 and 400 messages');
    if (JSON.stringify(messages).length > 400_000) throw new Error('The messages are too long');
    if (model.generating !== null) throw new Error('The model is still answering the previous message');
    const { id, done } = model.worker.request({ type: 'generate', messages, options: generationOptions(options) }, GENERATE_TIMEOUT, onText);
    model.generating = id;
    try {
      return (await done) as GenerateResult;
    } finally {
      model.generating = null;
    }
  }

  /** Stop the reply in progress; it answers with what it had. */
  cancel(handle: string): boolean {
    const model = this.#models.get(handle);
    if (!model || model.generating === null) return false;
    model.worker.cancel(model.generating);
    return true;
  }

  release(handle: string): boolean {
    const model = this.#models.get(handle);
    if (!model) return false;
    this.#models.delete(handle);
    model.worker.fail(new Error('The model was released'));
    return true;
  }

  releaseAll(): void {
    for (const handle of [...this.#models.keys()]) this.release(handle);
  }

  dispose(): void {
    this.#closed = true;
    this.releaseAll();
  }
}
