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
 * worker and stays in the runtime cache; the peer-sync runtime is fetched
 * when the app asked for `sync`; and for an app whose manifest runs its
 * script in a worker, the worker's files are fetched through the worker
 * asset route. Only when all of that is held does the result say `ready`.
 * Nothing here imports a feature itself — every load goes through the
 * registry's own loaders — so this file adds nothing to the entry closure,
 * which test/build-graph.test.ts holds.
 *
 * What is deliberately left online: models. An app that asked for `ai`
 * downloads them from the network by design, and the AI runtime (the
 * transformers and ORT bundles) is not precached either, so such an app is
 * reported ready with `optionalOnline: ['ai']` — the app opens and runs
 * offline; its AI features do not.
 */

import {
  collectAllComponentTags,
  getDefaultRegistry,
  parse,
  preloadSyncRuntime,
  type ComponentRegistry,
} from '@softn/core';

export interface OfflineInstallApp {
  /** The cache record's id, which installs dedupe on. */
  id: string;
  /** The composed source the renderer parses: every page, every branch. */
  source: string;
  /** The manifest's `config.execution`: a worker needs its files held too. */
  execution?: 'worker' | 'main';
  /** What the bundle's permission.json asked for, as bundleProcessor reads it. */
  capabilities?: readonly string[];
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

/**
 * What an install reaches the world through. Every member defaults to the
 * browser's; tests hand in doubles.
 */
export interface OfflineInstallHost {
  /** The registry the loads go through; the default registry outside tests. */
  registry?: ComponentRegistry;
  /** Fetches the sync runtime's chunk; core's preloadSyncRuntime outside tests. */
  preloadSync?: () => Promise<void>;
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
    workerAssets: app.execution === 'worker' ? 'unavailable' : 'not-needed',
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

    if (app.execution === 'worker') {
      const installed = await abortable(installWorkerAssets(options), signal);
      if (installed === ABORTED) return cancelled(result);
      result.workerAssets = installed ? 'installed' : 'unavailable';
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
// An app whose manifest asks for `config.execution: "worker"` runs its
// script in core's script worker, which the shell ships as a copy of core's
// dist under assets/core-runtime/ (scripts/core-worker-assets.mjs; the
// worker resolves `./core-runtime/runtime/script-worker.js` against its own
// chunk). Those files are outside the precache on purpose — the copy is
// 5+ MiB and most apps never start a worker — and outside the hashed-chunk
// route too, so they have their own runtime route (`softn-worker-assets`,
// NetworkFirst, since the worker's entry keeps a stable name across builds).
// Installing the app means fetching the worker's files through it: the
// entry, every module it imports statically, and the engine's .wasm, which
// the glue names with `new URL('…', import.meta.url)`. Which files those are
// changes with every core build, so rather than a list kept by hand the
// served entry is read and its imports followed, the way the browser will.

/** The copied core dist, relative to the shell's base. */
const WORKER_ASSET_ROOT = 'assets/core-runtime/';
/** The worker's entry, relative to that root. */
const WORKER_ENTRY = 'runtime/script-worker.js';
/** A bound on the walk: the worker is three modules and one .wasm today. */
const WORKER_ASSET_LIMIT = 32;

const FROM_SPECIFIER = /\bfrom\s*["']([^"']+)["']/g;
const BARE_IMPORT = /\bimport\s*["']([^"']+)["']/g;
const META_URL = /new\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g;

/**
 * The files a module names statically: `import … from '…'`, `export … from
 * '…'`, a bare `import '…'`, and `new URL('…', import.meta.url)`. Dynamic
 * `import()`s are on demand by definition and are not followed. Import
 * specifiers must be relative — a bare `react` would resolve to a file under
 * the root that does not exist — where a URL() argument may be a bare file
 * name, which is how the engine glue spells its .wasm.
 */
export function moduleReferences(text: string): string[] {
  const refs: string[] = [];
  for (const pattern of [FROM_SPECIFIER, BARE_IMPORT]) {
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
 * Fetch the worker's files so the service worker holds them. `cache:
 * 'reload'` so the request reaches the worker's route rather than being
 * answered from the HTTP cache, which survives no reload. True only when
 * every file in the graph came back 200.
 */
async function installWorkerAssets(options: OfflineInstallOptions): Promise<boolean> {
  const fetchFn = options.fetch ?? (typeof fetch === 'function' ? fetch : undefined);
  if (!fetchFn) return false;
  const base = options.baseUrl ?? import.meta.env.BASE_URL ?? '/';
  const page = typeof location !== 'undefined' ? location.href : 'http://localhost/';
  const root = new URL(base.replace(/\/?$/, '/') + WORKER_ASSET_ROOT, page);
  const queue = [new URL(WORKER_ENTRY, root)];
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
      // the worker's to need, and not this install's to fetch.
      if (target.href.startsWith(root.href)) queue.push(target);
    }
  }
  return true;
}
