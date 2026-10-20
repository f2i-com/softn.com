/**
 * Per-app offline install for the web shell.
 *
 * "The shell works offline" and "this app works offline" are two claims. The
 * service worker (vite.config.ts) makes the first: it precaches the entry,
 * its static closure and the modules every app needs, and keeps any feature
 * chunk it has served once (CacheFirst, `softn-feature-chunks`). It cannot
 * make the second, because a feature is fetched the first time a document
 * renders it — a Scene3D behind `#if (page === 'game')` is not fetched until
 * the game page is — so an app opened offline before every route had been
 * visited failed on the route that had not. Its bundle was in IndexedDB the
 * whole time; the code to render it was not.
 *
 * This module makes the second claim, one app at a time, while the network
 * is up. Every lazy component that any branch of the app's documents names
 * is loaded through the registry, so its chunk passes through the service
 * worker and stays in the runtime cache, and so is what such a component
 * fetches later still (`offlineExtras`: Scene3D's model loaders, controls
 * and effects, QRReader's decoder); the peer-sync runtime is fetched when
 * the app asked for `sync`; the workers' files are fetched through the
 * worker asset route — the script worker for an app whose manifest runs its
 * script in one, the sandbox worker for an app whose code reaches
 * `softn.sandbox`, the local-model worker for an app that asked for `ai`;
 * for such an app the AI runtime's own chunks too; and for an app that
 * declares the torch Python package, its loader chunk and zipp_torch.wasm.
 * Only when all of that is held does the result say `ready`.
 * Nothing here imports a feature itself — every load goes through the
 * registry's own loaders — so this file adds nothing to the entry closure,
 * which test/build-graph.test.ts holds.
 *
 * What stays a download: an AI model. The runtime that runs one is installed
 * with the app, and a model is kept in Cache Storage the first time the app
 * loads it, so an app reported ready with `optionalOnline: ['ai']` runs a
 * model it has loaded before offline, and needs the network for one it has not.
 */

import {
  collectAllComponentTags,
  getDefaultRegistry,
  parse,
  preloadAIRuntime,
  preloadSyncRuntime,
  preloadZippTorch,
  type ComponentRegistry,
} from '@softn/core';
import { offlineExtras } from '@softn/components/lazy';

export interface OfflineInstallApp {
  /** The cache record's id, which installs dedupe on. */
  id: string;
  /** The composed source the renderer parses: every page, every branch. */
  source: string;
  /** The manifest's `config.execution`: a worker needs its files held too. */
  execution?: 'worker' | 'main';
  /** What the bundle's permission.json asked for, as bundleProcessor reads it. */
  capabilities?: readonly string[];
  /**
   * The Python packages the app declares (`config.python.packages`, from the
   * composition's `python.packages`). torch is a separate engine module
   * fetched on demand, so an app that declares it needs it held as well.
   */
  pythonPackages?: readonly string[];
}

export type WorkerAssetsState = 'not-needed' | 'installed' | 'unavailable';

export interface OfflineInstallResult {
  /** Everything the app can reach is held locally: features, sync runtime, worker files. */
  ready: boolean;
  /**
   * Every lazy component the app's documents can reach, sorted, plus
   * SYNC_RUNTIME when the app asked for `sync`.
   */
  features: string[];
  /** The entries of `features` that could not be fetched. */
  missing: string[];
  workerAssets: WorkerAssetsState;
  /** Capabilities whose runtime stays online by design; the app runs offline without them. */
  optionalOnline: string[];
  /** Why the install did not run to the end, when it did not. */
  error?: string;
}

/** The name `features` and `missing` use for the peer-sync runtime chunk. */
export const SYNC_RUNTIME = 'sync-runtime';
/** The name `missing` uses for the torch package (its loader chunk and zipp_torch.wasm). */
export const TORCH_PACKAGE = 'torch';
/** The name `missing` uses for the AI runtime's own chunks. */
export const AI_RUNTIME = 'ai-runtime';

/**
 * What an install reaches the world through. Every member defaults to the
 * browser's; tests hand in doubles.
 */
export interface OfflineInstallHost {
  /** The registry the loads go through; the default registry outside tests. */
  registry?: ComponentRegistry;
  /** Fetches the sync runtime's chunk; core's preloadSyncRuntime outside tests. */
  preloadSync?: () => Promise<void>;
  /** Fetches the torch package's loader and module; core's preloadZippTorch outside tests. */
  preloadTorch?: (init: RequestInit) => Promise<void>;
  /** Fetches the AI runtime's chunks; core's preloadAIRuntime outside tests. */
  preloadAI?: () => Promise<void>;
  /** What a component fetches after its chunk, or undefined for none; @softn/components' offlineExtras outside tests. */
  componentExtras?: (name: string) => Promise<void> | undefined;
  /** Resolves true once something will keep what is fetched: a controlling service worker. */
  cacheHolder?: () => Promise<boolean>;
  /** For the worker's files. */
  fetch?: typeof globalThis.fetch;
  /** Where the shell is served from; `import.meta.env.BASE_URL` outside tests. */
  baseUrl?: string;
}

export interface OfflineInstallOptions extends OfflineInstallHost {
  /** Closing the tab that started the install aborts it. */
  signal?: AbortSignal;
}

/**
 * The lazy component names a source can reach, on any route.
 *
 * Every branch counts (collectAllComponentTags), unlike the renderer's own
 * first-screen prefetch: a route the user has not visited is exactly what
 * has to be there when the network is not. HTML tags and names the host
 * never registered have no chunk; eager names are in the shell already.
 * Only a name with a loader is a fetch.
 */
export function requiredFeatures(
  source: string,
  registry: ComponentRegistry = getDefaultRegistry()
): string[] {
  const names: string[] = [];
  for (const tag of collectAllComponentTags(parse(source))) {
    const state = registry.getLoadState(tag);
    if (state !== undefined && state !== 'eager') names.push(tag);
  }
  return names.sort();
}

const inFlight = new Map<string, Promise<OfflineInstallResult>>();

/**
 * Install one app for offline use. Resolves — never rejects — with what was
 * established, and reports `ready` only when nothing is missing.
 *
 * One run per record at a time: a second call for the same id while the
 * first is running joins it and gets its result, so two opens of one app
 * do not fetch everything twice. The joined run keeps the first caller's
 * signal, so it stops when the first tab closes; the second tab's open, the
 * next time round, starts its own.
 */
export function installAppOffline(
  app: OfflineInstallApp,
  options: OfflineInstallOptions = {}
): Promise<OfflineInstallResult> {
  const running = inFlight.get(app.id);
  if (running) return running;
  const run: Promise<OfflineInstallResult> = performInstall(app, options).finally(() => {
    // Only clear the slot if it is still this run's; a later call owns it by then.
    if (inFlight.get(app.id) === run) inFlight.delete(app.id);
  });
  inFlight.set(app.id, run);
  return run;
}

/** What an awaited step resolves to when the signal fired first. */
const ABORTED = Symbol('aborted');

async function performInstall(
  app: OfflineInstallApp,
  options: OfflineInstallOptions
): Promise<OfflineInstallResult> {
  const { signal } = options;
  const registry = options.registry ?? getDefaultRegistry();
  const capabilities = app.capabilities ?? [];
  const result: OfflineInstallResult = {
    ready: false,
    features: [],
    missing: [],
    // A worker's files are unavailable until they are seen to be there.
    workerAssets: workerEntries(app).length > 0 ? 'unavailable' : 'not-needed',
    optionalOnline: capabilities.includes('ai') ? ['ai'] : [],
  };

  mark('softn:offline-install:start');
  try {
    if (signal?.aborted) return cancelled(result);

    try {
      result.features = requiredFeatures(app.source, registry);
    } catch (err) {
      result.error = `The app's documents could not be read: ${describe(err)}`;
      return result;
    }
    const wantsSync = capabilities.includes('sync');
    if (wantsSync) result.features.push(SYNC_RUNTIME);

    // Something has to keep what is fetched, or none of this outlasts the
    // tab. Checked before any fetch: a fetch nothing keeps is not an install,
    // and reporting it as one is the lie this module exists to stop.
    const held = await abortable((options.cacheHolder ?? serviceWorkerControls)(), signal);
    if (held === ABORTED) return cancelled(result);
    if (!held) {
      result.error =
        'No service worker controls this page yet, so nothing fetched now would be kept; the install runs again the next time the app opens.';
      return result;
    }

    // Components, through the registry. load() shares the entry's one
    // promise with every wrapper, so a chunk already in flight for the first
    // screen is awaited rather than fetched twice. A rejection cached from an
    // earlier attempt is retried: a network that has since come back is the
    // usual reason to be here at all.
    const componentNames = result.features.filter((name) => name !== SYNC_RUNTIME);
    const loads = componentNames.map((name) => {
      const attempt =
        registry.getLoadState(name) === 'error' ? registry.retry(name) : registry.load(name);
      return attempt.then(
        () => undefined,
        () => undefined
      );
    });
    if ((await abortable(Promise.all(loads), signal)) === ABORTED) return cancelled(result);
    for (const name of componentNames) {
      if (registry.getLoadState(name) !== 'loaded') result.missing.push(name);
    }

    // What a loaded component fetches later still: a Scene3D's loaders for
    // models it has not named yet, a QRReader's decoder before its first scan.
    const extras = options.componentExtras ?? ((name: string) => offlineExtras[name]?.());
    const pending = componentNames
      .filter((name) => !result.missing.includes(name))
      .map((name) => ({ name, run: extras(name) }))
      .filter((entry): entry is { name: string; run: Promise<void> } => entry.run !== undefined)
      .map(({ name, run }) => run.then(() => null, () => name));
    const extrasMissing = await abortable(Promise.all(pending), signal);
    if (extrasMissing === ABORTED) return cancelled(result);
    for (const name of extrasMissing) if (name) result.missing.push(name);

    if (wantsSync) {
      const fetched = await abortable(
        (options.preloadSync ?? preloadSyncRuntime)().then(
          () => true,
          () => false
        ),
        signal
      );
      if (fetched === ABORTED) return cancelled(result);
      if (!fetched) result.missing.push(SYNC_RUNTIME);
    }

    const entries = workerEntries(app);
    if (entries.length > 0) {
      const installed = await abortable(installWorkerAssets(options, entries), signal);
      if (installed === ABORTED) return cancelled(result);
      result.workerAssets = installed ? 'installed' : 'unavailable';
    }

    // The page's side of the AI runtime: the model host, the capability
    // report and the GPU compute manager, each a chunk of its own.
    if (capabilities.includes('ai')) {
      const ok = await abortable(
        (options.preloadAI ?? preloadAIRuntime)().then(
          () => true,
          () => false
        ),
        signal
      );
      if (ok === ABORTED) return cancelled(result);
      if (!ok) result.missing.push(AI_RUNTIME);
    }

    // torch is not in the engine the shell loads; the first `import torch`
    // fetches its loader chunk and zipp_torch.wasm. core's preloadZippTorch
    // fetches both past the HTTP cache, so the worker-assets route keeps them.
    if (app.pythonPackages?.includes(TORCH_PACKAGE)) {
      const preload = options.preloadTorch ?? preloadZippTorch;
      const ok = await abortable(
        preload({ signal }).then(
          () => true,
          () => false
        ),
        signal
      );
      if (ok === ABORTED) return cancelled(result);
      if (!ok) result.missing.push(TORCH_PACKAGE);
    }

    result.ready = result.missing.length === 0 && result.workerAssets !== 'unavailable';
    return result;
  } finally {
    mark('softn:offline-install:end');
  }
}

function cancelled(result: OfflineInstallResult): OfflineInstallResult {
  result.ready = false;
  result.error = 'The install was cancelled.';
  return result;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Wait for `promise`, or for the signal, whichever is first. The work behind
 * the promise is not stopped — an import() cannot be — but nothing here
 * waits on it any longer, and its result is not reported.
 */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | typeof ABORTED> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise<T | typeof ABORTED>((resolve, reject) => {
    const onAbort = (): void => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

/** Phase boundaries for scripts/bench/measure.mjs; guarded like the shell's other marks. */
function mark(name: string): void {
  if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
    performance.mark(name);
  }
}

// ── The service worker ───────────────────────────────────────────────

/** How long to wait for a worker that is installing to take the page. */
const SERVICE_WORKER_WAIT_MS = 10_000;

/**
 * Whether a service worker holds this page's fetches.
 *
 * `ready` resolves once a worker is active for the scope, and the runtime's
 * worker claims open pages as it activates (`clientsClaim`), so on a first
 * visit the controller can arrive a moment after the app has opened; it is
 * waited for, briefly. A page with no worker at all — a dev server, a
 * browser without them, a private window that refuses registration —
 * resolves false, and the install says so rather than counting a fetch
 * nothing kept.
 */
async function serviceWorkerControls(): Promise<boolean> {
  const container = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
  if (!container) return false;
  if (container.controller) return true;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      container.removeEventListener('controllerchange', onChange);
      resolve(value);
    };
    const onChange = (): void => finish(Boolean(container.controller));
    const timer = setTimeout(() => finish(Boolean(container.controller)), SERVICE_WORKER_WAIT_MS);
    container.addEventListener('controllerchange', onChange);
    container.ready.then(
      () => {
        // Active, and either already in control or about to say so.
        if (container.controller) finish(true);
      },
      () => finish(false)
    );
  });
}

// ── Worker assets ────────────────────────────────────────────────────
//
// Core's workers ship in a copy of what they reach of its dist under
// assets/core-runtime/ (scripts/core-worker-assets.mjs; a worker resolves
// `./core-runtime/runtime/script-worker.js` against its own chunk): the
// script worker, which runs an app whose manifest asks for
// `config.execution: "worker"`; the sandbox worker behind
// `softn.sandbox.run`; and the local-model worker behind `softn.ai.model`.
// Those files are outside the precache on purpose — most apps never start a
// worker — and outside the hashed-chunk route too, so they have their own
// runtime route (`softn-worker-assets`, NetworkFirst, since an entry keeps a
// stable name across builds). Installing the app means fetching its workers'
// files through it: each entry, every module it imports, statically or by a
// literal import(), and every file it names with URL() (the model worker's
// modules). Which files those are changes with every core build, so rather
// than a list kept by hand the served entry is read and its imports
// followed, the way the browser will. Not the engine: the glue still names
// `zipp_wasm_bg.wasm` beside itself, but the page posts its own compiled
// engine to the worker, the shell's one precached copy, and there is no copy
// under core-runtime/ to fetch.

/** The copied core dist, relative to the shell's base. */
const WORKER_ASSET_ROOT = 'assets/core-runtime/';
/** A bound on the walk: the three workers reach about twenty files today. */
const WORKER_ASSET_LIMIT = 48;

/** Code that may reach `softn.sandbox`, read from the app's composed source. */
const SANDBOX_USE = /\bsandbox\b/;

/** The workers an app can start, by their entries under the copied dist. */
export function workerEntries(app: Pick<OfflineInstallApp, 'execution' | 'source' | 'capabilities'>): string[] {
  const entries: string[] = [];
  if (app.execution === 'worker') entries.push('runtime/script-worker.js');
  if (SANDBOX_USE.test(app.source)) entries.push('runtime/sandbox-worker.js');
  if (app.capabilities?.includes('ai')) entries.push('runtime/model-worker.js');
  return entries;
}
/** The ZIPP engine, which a worker takes from the page rather than fetching. */
const ENGINE_FILE = /\/zipp_wasm_bg\.wasm$/;

const FROM_SPECIFIER = /\bfrom\s*["']([^"']+)["']/g;
const BARE_IMPORT = /\bimport\s*["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
const META_URL = /new\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g;

/**
 * The files a module names: `import … from '…'`, `export … from '…'`, a
 * bare `import '…'`, a literal `import('…')` (a worker's on-demand module is
 * still one it may need offline, the Python adapter among them), and
 * `new URL('…', import.meta.url)`. Import specifiers must be relative — a
 * bare `react` would resolve to a file under the root that does not exist —
 * where a URL() argument may be a bare file name, which is how the engine
 * glue spells its .wasm.
 */
export function moduleReferences(text: string): string[] {
  const refs: string[] = [];
  for (const pattern of [FROM_SPECIFIER, BARE_IMPORT, DYNAMIC_IMPORT]) {
    for (const match of text.matchAll(pattern)) {
      if (/^\.{1,2}\//.test(match[1])) refs.push(match[1]);
    }
  }
  for (const match of text.matchAll(META_URL)) {
    if (!/^[a-z][a-z0-9+.-]*:|^\/\//i.test(match[1])) refs.push(match[1]);
  }
  return refs;
}

/**
 * Fetch the workers' files so the service worker holds them. `cache:
 * 'reload'` so the request reaches the worker's route rather than being
 * answered from the HTTP cache, which survives no reload. True only when
 * every file in the graph came back 200.
 */
async function installWorkerAssets(options: OfflineInstallOptions, entries: readonly string[]): Promise<boolean> {
  const fetchFn = options.fetch ?? (typeof fetch === 'function' ? fetch : undefined);
  if (!fetchFn) return false;
  const base = options.baseUrl ?? import.meta.env.BASE_URL ?? '/';
  const page = typeof location !== 'undefined' ? location.href : 'http://localhost/';
  const root = new URL(base.replace(/\/?$/, '/') + WORKER_ASSET_ROOT, page);
  const queue = entries.map((entry) => new URL(entry, root));
  const seen = new Set<string>();
  while (queue.length) {
    const url = queue.shift()!;
    if (seen.has(url.href)) continue;
    if (seen.size >= WORKER_ASSET_LIMIT) return false;
    seen.add(url.href);
    let response: Response;
    try {
      response = await fetchFn(url.href, {
        cache: 'reload',
        credentials: 'same-origin',
        signal: options.signal,
      });
    } catch {
      return false;
    }
    if (!response.ok) return false;
    // A .wasm is held as fetched; only a module names further files.
    if (!url.pathname.endsWith('.js')) continue;
    let text: string;
    try {
      text = await response.text();
    } catch {
      return false;
    }
    for (const ref of moduleReferences(text)) {
      const target = new URL(ref, url);
      // The copied dist and nothing else: a reference that leaves it is not
      // the worker's to need, and not this install's to fetch. Nor the
      // engine, which the worker is handed (above).
      if (target.href.startsWith(root.href) && !ENGINE_FILE.test(target.pathname)) queue.push(target);
    }
  }
  return true;
}
