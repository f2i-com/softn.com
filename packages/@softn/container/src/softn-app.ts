/**
 * `<softn-app>` Web Component & `mountSoftNContainer` Runtime Kernel.
 *
 * A complete, React-free Web App Container ("Docker for Web Apps"):
 * - Mounts a closed `ShadowRoot` viewport with strict HTML/CSS egress sanitization
 * - Runs all guest JS/TS/Python inside a Worker-isolated ZIPP WASM VM (`lite` by default)
 * - Supports unmodified compiled web apps (`dist/` zipped into `.softn`), zero-build
 *   HTML/JS/TS apps, hosted `/runtime/vendor/` libraries (`three`, `preact`, `htm`, `marked`),
 *   on-demand `<softn-*>` Custom Elements, and multi-page HTML navigation!
 */

import { inspectDeclaration, type Capability } from '@softn/bundle-format/capabilities';
import { base64ToBytes, bytesToBase64, ContainerArchive, VIRTUAL_ORIGIN } from './archive';
import { buildBackendRoutingConfig, matchBackendTarget, RemoteBackendTransport } from './backend-transport';
import { renderConsentBar, renderSaveBar, renderStoppedBar } from './consent-bar';
import type { ContainerDeviceBridge } from './device-bridge';
import { HostDomPatcher } from './dom-patcher';
import { databaseOfPart, holdByLease, indexedDbBacking, localStorageBacking, partBytes, partPrefixes, type IdbBacking, type LeaseFence } from './idb-backing';
import { hostFileName, hostLabel, slotsAreContained, type FontScopeContext } from './host-policy';
import type { LocalBackendTransport } from './local-backend-transport';
import { isSafeVirtualRoute, loadContainerSession, saveContainerSession, type PersistedContainerSession } from './session-store';
import { extractSanitizedFontFaces, prepareHtmlDocument } from './sanitize';
import { FRAME_BASE_CSS, PAGE_BASE_CSS } from './ui-css';
import { ensureUiExtension } from './ui-extensions/registry';
import type { VirtualNavBarController } from './virtual-nav-bar';
import { selectEngineTier } from './zipp-loader';
import {
  SoftNContainerError,
  type BackendTransport,
  type BackendWsHandle,
  type ContainerBootStatus,
  type ContainerLimits,
  type ContainerManifest,
  type DatabaseConfig,
  type HostToWorkerMsg,
  type SaveRequest,
  type SoftNContainerOptions,
  type ThreeSceneOp,
  type VirtualDirEntry,
  type WorkerToHostMsg,
  type ZippEngineSource,
  type ZippEngineTier,
} from './types';
import type { SplitRealmSceneHost } from './vendor/webgl-scene-host';
import { startModuleWorker } from './worker-start';

const DEFAULT_LIMITS: Required<ContainerLimits> = {
  instructionsPerTurn: 100_000_000,
  turnTimeoutMs: 15_000,
  // What an app may keep, of the roughly 10 MB a browser gives the embedding page for
  // everything it stores this way: its own keys and every other app's. The default was the
  // whole of it, so one app could leave the page, and the apps beside it, unable to save.
  storageQuotaBytes: 5 * 1024 * 1024,
  // Its IndexedDB databases, kept in the page's own IndexedDB, where a browser gives a site
  // far more (and, where there is none, counted in the localStorage quota above instead).
  idbQuotaBytes: 64 * 1024 * 1024,
};

export interface SoftNContainerHandle {
  readonly manifest: ContainerManifest;
  readonly engineTier: ZippEngineTier;
  readonly appId: string;
  /**
   * The root the app's page is drawn in, for host tooling and tests: the app's elements and
   * its stylesheets, and nothing of the container's own. It is the same root for every page
   * the app shows.
   */
  readonly shadowRoot: ShadowRoot;
  /**
   * The root the container's own frame is in: the bars it draws above the app (what the app
   * asks to be allowed, a file it asks to save) and the box the app's page is in. No
   * stylesheet of the app's is in this root or reaches it.
   */
  readonly frameRoot: ShadowRoot;
  /** Current virtual URL path shown inside the container (e.g. `'/'`, `'/signin'`, `'/modules/sign.php'`). */
  readonly currentPath: string;
  /** Active backend transport (local WASM Backend Worker or host-injected FormLogic remote transport). */
  readonly backendTransport?: BackendTransport;
  /** Navigate to another HTML page, SSR route, or virtual folder script inside the same container. */
  navigate(path: string): Promise<void>;
  /** List virtual folders & files inside the container `.zip` archive. */
  listVirtualDirectory(virtualPath?: string): VirtualDirEntry[];
  /** Apply declarative JSON seed data to a named XDB SQLite database inside this container. */
  seedDatabase(dbName: string, seedJson: string | Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Export a named XDB SQLite database as standalone `.db` binary bytes. */
  exportDatabase(dbName: string): Promise<Uint8Array | null>;
  /** Grant or revoke capabilities dynamically. */
  setGrantedCapabilities(caps: Capability[]): void;
  /**
   * Whether the app is on screen. While it is not (a tab behind another, a preview that is
   * covered) it is asked for no frames and its timers wait, so an animation or a poll that
   * nobody is looking at costs nothing; what came due runs when it is shown again. A request
   * already under way finishes. An app is active until told otherwise.
   */
  setActive(active: boolean): void;
  /** Tear down the Worker, revoke `blob:` URLs, and clean up DOM listeners. */
  dispose(): void;
}

interface WorkerTransport {
  post(msg: HostToWorkerMsg): void;
  terminate(): void;
}

const shadowRootRegistry = new WeakMap<HTMLElement, ShadowRoot>();
let fontScopeSeq = 0;
const MAX_BACKEND_SOCKETS = 8;
const MAX_BACKEND_FETCH_BODY_B64 = 64 * 1024 * 1024;
const MAX_BACKEND_WS_TEXT_CHARS = 16 * 1024 * 1024;
const MAX_BACKEND_WS_B64_CHARS = Math.ceil((16 * 1024 * 1024 * 4) / 3) + 4;
const BLOCKED_SESSION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function safeStorageAppId(id: string): string {
  // Preserve canonical `sha256:<64-hex>` keys while escaping `%` and `:` in arbitrary
  // host/URL appIds so an appId containing `:ls:` / `:db` / `:idb:` can never collide
  // with another app's `softn-v2:<appId>:` storage prefix.
  if (/^sha256:[0-9a-f]{64}$/.test(id)) return id;
  return id.replace(/%/g, '%25').replace(/:/g, '%3A');
}

function recordBytes(map: Record<string, string>): number {
  let total = 0;
  for (const [k, v] of Object.entries(map)) {
    total += (k.length + v.length) * 2;
  }
  return total;
}

/**
 * Which mount an element's shadow root belongs to: the latest. An element is mounted into
 * again whenever its host re-renders (a preview on every keystroke), and the mount before is
 * disposed afterwards, or is still starting. Only the owner writes to the root or empties it:
 * a superseded mount that emptied "its" root on dispose blanked the live one.
 */
const rootOwners = new WeakMap<ShadowRoot, object>();

/**
 * Inline, important, and after `all: initial`: what no stylesheet can change. The frame and
 * the bars are in a root no sheet of the app's is in; the app's page is in a root of its own
 * inside the box (attachPageRoot), and of the container's elements only the page's scroller
 * is in there with it. A declaration on the element itself outranks any in a sheet of the
 * same importance, and `all` leaves it no property to reach for.
 */
const PINNED = 'all:initial!important;box-sizing:border-box!important;font:inherit!important;color:inherit!important;';

/** The column the consent bar and the app's box are laid out in. */
const FRAME_STYLE = `${PINNED}display:flex!important;flex-direction:column!important;position:relative!important;width:100%!important;height:100%!important;`;

/**
 * The app's box: everything the app draws is inside it. It is the containing block of the
 * app's `position: fixed` elements and clips what they draw, and is a stacking context of
 * its own below the consent bar: whatever `z-index` the app picks, it draws under the bar
 * and never over the embedding page.
 *
 * It does not scroll: the app's page does, inside it (DOCROOT_STYLE). One element was both,
 * and what an app fixed in place then scrolled away with its page: a dialog opened further
 * down was drawn at the top of the page, out of sight, and a bar fixed to the top left with
 * the first scroll.
 */
const BOX_STYLE = `${PINNED}display:block!important;flex:1 1 auto!important;min-height:0!important;width:100%!important;position:relative!important;overflow:hidden!important;contain:layout paint!important;isolation:isolate!important;z-index:0!important;`;

/**
 * The app's page, which scrolls inside the box. It is where the app's absolutely placed
 * elements are placed from (they scroll with it), and nothing here makes it the containing
 * block of a fixed one (no containment, no transform): that is the box around it.
 */
const DOCROOT_STYLE =
  'box-sizing:border-box!important;display:block!important;position:relative!important;inset:auto!important;width:100%!important;height:100%!important;min-width:0!important;min-height:0!important;max-width:none!important;max-height:none!important;margin:0!important;padding:0!important;border:0!important;overflow:auto!important;transform:none!important;filter:none!important;contain:none!important;perspective:none!important;clip-path:none!important;';

/**
 * The root the app's page is drawn in, on the box. The app's stylesheets are in it with the
 * page, and a stylesheet matches only what is in its own root: not the frame, not the bars
 * above the box, not anything of theirs that only a stylesheet can make (`::before`,
 * `::after`). They were all in one root, where the app's sheet drew over the bar that asks
 * the person something, with words of its own. Whatever the app's sheet does make is drawn
 * inside the box, which clips it. The box has no children of its own, so a `<slot>` in the
 * app's page has nothing to show.
 */
function attachPageRoot(boxEl: HTMLElement): ShadowRoot {
  try {
    return boxEl.attachShadow({ mode: 'closed', slotAssignment: 'manual' });
  } catch {
    return boxEl.attachShadow({ mode: 'closed' });
  }
}

/** The consent bar's place: above the app's box, in a shadow root of its own. */
const CONSENT_STYLE = `${PINNED}display:block!important;flex:none!important;position:relative!important;z-index:1!important;`;

const ENGINE_FILES: Readonly<Record<ZippEngineTier, string>> = {
  lite: 'zipp-javascript-lite.wasm',
  javascript: 'zipp-javascript.wasm',
  typescript: 'zipp-typescript.wasm',
  python: 'zipp-python-base.wasm',
  'python-torch': 'zipp-python-base.wasm',
  php: 'zipp-php.wasm',
  rust: 'zipp-rust.wasm',
};

/**
 * Save a file an app made to the person's disk, at their word: as a download of the
 * embedding page, under the name given and as bytes of no kind (never as a document the
 * browser would open instead).
 */
function saveToDisk(file: SaveRequest): void {
  if (typeof URL.createObjectURL !== 'function') return;
  const copy = new Uint8Array(file.bytes.byteLength);
  copy.set(file.bytes);
  const url = URL.createObjectURL(new Blob([copy], { type: 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Let go once the browser has had time to start reading it.
  setTimeout(() => {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // Already gone
    }
  }, 60_000);
}

/** Shared page-level compiled WebAssembly.Module cache so multiple Workers share 1 download & 1 compile! */
const sharedEngineModuleCache = new Map<string, Promise<WebAssembly.Module>>();

/** The engine at `url`, fetched and compiled once for this page however many containers ask for it. */
function getSharedCompiledEngine(url: string): Promise<WebAssembly.Module> {
  let existing = sharedEngineModuleCache.get(url);
  if (!existing) {
    existing = (async () => {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Failed to fetch ${url}: HTTP ${resp.status}`);
      const ct = (resp.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (ct === 'application/wasm' && typeof WebAssembly.compileStreaming === 'function') {
        try {
          const compiled = await WebAssembly.compileStreaming(resp.clone());
          void resp.body?.cancel().catch(() => undefined);
          return compiled;
        } catch {
          // Fallback to arrayBuffer compile
        }
      }
      return WebAssembly.compile(new Uint8Array(await resp.arrayBuffer()));
    })();
    existing.catch(() => sharedEngineModuleCache.delete(url));
    sharedEngineModuleCache.set(url, existing);
  }
  return existing;
}

function getOrAttachClosedShadow(hostEl: HTMLElement): ShadowRoot {
  const existing = shadowRootRegistry.get(hostEl);
  if (existing) return existing;
  // Slots assigned by hand, and none assigned: a <slot> in the app's page shows nothing of
  // the embedding page's children of this element (host-policy.ts, slotsAreContained).
  const root = hostEl.attachShadow(slotsAreContained() ? { mode: 'closed', slotAssignment: 'manual' } : { mode: 'closed' });
  shadowRootRegistry.set(hostEl, root);
  return root;
}

async function loadArchiveSource(
  source: SoftNContainerOptions['source']
): Promise<Uint8Array | Record<string, string | Uint8Array>> {
  if (typeof source === 'string') {
    const resp = await fetch(source);
    if (!resp.ok) {
      throw new Error(`Failed to fetch .softn container (${source}): HTTP ${resp.status}`);
    }
    return new Uint8Array(await resp.arrayBuffer());
  }
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  return source;
}

function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Where an app's kept data goes in the embedding page's localStorage: `<base>ls:<key>` for
 * what its script keeps through localStorage, `<base>db` for its records. The base is the
 * host's (`storagePrefix`), or `softn-v2:<appId>:`.
 */
function loadPersistedStorage(base: string, storage: Storage | undefined = browserStorage()): Record<string, string> {
  // No prototype: a key of the app's may be `__proto__`, which a plain object does not keep
  // as its own, so it was not counted against the quota and the app could keep it twice over.
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  if (!storage) return out;
  const prefix = `${base}ls:`;
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && k.startsWith(prefix)) {
        const val = storage.getItem(k);
        if (val !== null) out[k.slice(prefix.length)] = val;
      }
    }
  } catch {
    // Ignore storage access errors in restricted frames
  }
  return out;
}

/** The most databases one session of an app holds, or asks to hold, across tabs at once. */
const MAX_IDB_HOLDS = 64;

/**
 * The apps mounted in this page, by where each keeps what it stores. The browser tells a
 * write to the page's storage to the site's other pages (another tab), never to the page
 * that made it: two of the same app in one page did not hear each other, and each wrote
 * the other's records away. A write is told to the others here, by the key it changed.
 */
const mountedByStorage = new Map<string, Set<(key: string) => void>>();

function tellNeighbours(base: string, self: (key: string) => void, keys: readonly string[]): void {
  const mounted = mountedByStorage.get(base);
  if (!mounted || mounted.size < 2 || keys.length === 0) return;
  for (const heard of [...mounted]) if (heard !== self) for (const key of keys) heard(key);
}

/** The keys the app's localStorage holds in the page's, as they are named there. */
function persistedStorageKeys(base: string, storage: Storage | undefined = browserStorage()): string[] {
  const keys: string[] = [];
  if (!storage) return keys;
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && k.startsWith(`${base}ls:`)) keys.push(k);
    }
  } catch {
    // Storage closed to this page: nothing to tell.
  }
  return keys;
}

/** Keep, drop or clear what the app's script kept. False when the page's storage refused. */
function applyPersistedStorageOp(
  base: string,
  op: 'set' | 'remove' | 'clear',
  key: string | undefined,
  value: string | undefined,
  storage: Storage | undefined
): boolean {
  if (!storage) return false;
  const prefix = `${base}ls:`;
  try {
    if (op === 'set' && key !== undefined && value !== undefined) {
      storage.setItem(prefix + key, value);
    } else if (op === 'remove' && key !== undefined) {
      storage.removeItem(prefix + key);
    } else if (op === 'clear') {
      const toRemove: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k && k.startsWith(prefix)) toRemove.push(k);
      }
      for (const k of toRemove) storage.removeItem(k);
    }
    return true;
  } catch {
    // The page's storage is full or closed to this page: the caller says so.
    return false;
  }
}

function loadPersistedDb(base: string, storage: Storage | undefined): Record<string, unknown[]> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(`${base}db`);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown[]>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Keep a collection of the app's records. Refused past `quotaBytes` for all of them together:
 * the Worker counts too, but what is written to the embedding page's storage is decided
 * here, where the app's script has no say.
 */
export function savePersistedDbCollection(base: string, collection: string, records: unknown[], quotaBytes: number, storage = browserStorage()): boolean {
  if (!storage) return false;
  // The name is the app's word, and a key of an object here: not one that is the object's own
  // machinery (`__proto__` would replace what the records are kept in).
  if (typeof collection !== 'string' || !collection || collection === '__proto__' || collection === 'constructor' || collection === 'prototype') return true;
  if (!Array.isArray(records)) return true;
  try {
    const current = loadPersistedDb(base, storage);
    current[collection] = records;
    const text = JSON.stringify(current);
    if (text.length * 2 > quotaBytes) return false;
    storage.setItem(`${base}db`, text);
    return true;
  } catch {
    // The page's storage is full or closed to this page: the caller says so.
    return false;
  }
}

/** Total UTF-16 bytes kept for `base` across localStorage, DB, and IDB fallback in one zero-alloc scan. */
function persistedTotalBytes(base: string, storage: Storage | undefined): number {
  if (!storage) return 0;
  const lsPrefix = `${base}ls:`;
  const idbPrefix = `${base}idb:`;
  const dbKey = `${base}db`;
  let bytes = 0;
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (!k || !k.startsWith(base)) continue;
      const v = storage.getItem(k);
      if (v === null) continue;
      if (k.startsWith(lsPrefix)) {
        bytes += (k.length - lsPrefix.length + v.length) * 2;
      } else if (k.startsWith(idbPrefix)) {
        bytes += (k.length - idbPrefix.length + v.length) * 2;
      } else if (k === dbKey) {
        bytes += v.length * 2;
      }
    }
  } catch {
    return 0;
  }
  return bytes;
}

/** The bytes they take, as the Worker counts them. */
function persistedIdbBytes(base: string, storage: Storage | undefined = browserStorage()): number {
  if (!storage) return 0;
  const prefix = `${base}idb:`;
  let bytes = 0;
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (!k || !k.startsWith(prefix)) continue;
      const v = storage.getItem(k);
      if (v !== null) bytes += (k.length - prefix.length + v.length) * 2;
    }
  } catch {
    return 0;
  }
  return bytes;
}

/**
 * Keep a part of one of the app's IndexedDB databases, or let go of it. Refused past
 * `quotaBytes` for everything the app keeps: the Worker counts too, but what is written to
 * the embedding page's storage is decided here.
 */
export function savePersistedIdb(base: string, name: string, value: string | null, quotaBytes: number, storage: Storage | undefined = browserStorage()): boolean {
  if (!storage) return false;
  if (typeof name !== 'string' || name.length > 1024) return true;
  const key = `${base}idb:${name}`;
  try {
    if (value === null) {
      storage.removeItem(key);
      return true;
    }
    if (typeof value !== 'string') return true;
    const old = storage.getItem(key);
    const others = persistedTotalBytes(base, storage) - (old === null ? 0 : (name.length + old.length) * 2);
    if (others + (name.length + value.length) * 2 > quotaBytes) return false;
    storage.setItem(key, value);
    return true;
  } catch {
    // The page's storage is full or closed to this page: the caller says so.
    return false;
  }
}

/** The bytes the app's kept localStorage takes in the embedding page's, as the Worker counts them. */
function persistedStorageBytes(base: string, storage: Storage | undefined): number {
  if (!storage) return 0;
  const prefix = `${base}ls:`;
  let bytes = 0;
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (!k || !k.startsWith(prefix)) continue;
      const v = storage.getItem(k);
      if (v !== null) bytes += (k.length - prefix.length + v.length) * 2;
    }
  } catch {
    return 0;
  }
  return bytes;
}

/**
 * Whether keeping `value` under `key` leaves the app within its quota: what it keeps through
 * localStorage and its records together, since both are kept in the embedding page's one
 * storage. The two were each held to the whole quota and never added up, so an app kept twice
 * its quota; and a value written over was counted as if the old one stayed.
 */
export function storageWriteFits(base: string, key: string, value: string, quotaBytes: number, storage = browserStorage()): boolean {
  let replaced = 0;
  try {
    const old = !storage ? null : storage.getItem(`${base}ls:${key}`);
    if (old !== null) replaced = (key.length + old.length) * 2;
  } catch {
    replaced = 0;
  }
  return persistedTotalBytes(base, storage) - replaced + (key.length + value.length) * 2 <= quotaBytes;
}

/**
 * Mount a `.softn` container inside `hostEl`.
 */
export async function mountSoftNContainer(
  hostEl: HTMLElement,
  options: SoftNContainerOptions
): Promise<SoftNContainerHandle> {
  const shadowRoot = getOrAttachClosedShadow(hostEl);
  const owner = {};
  rootOwners.set(shadowRoot, owner);
  /** Whether this mount is still the one the element shows. */
  const owns = (): boolean => rootOwners.get(shadowRoot) === owner;
  shadowRoot.replaceChildren();

  // The folder's whole address, made once against the page: it is read from the page, from
  // the Worker and from this module's own chunks, and a relative folder is a different place
  // to each (`runtime-url="./runtime/"` had the Worker look beneath its own script). Under
  // Node, where a test names a folder on disk, it is left as given.
  const givenRuntimeUrl = (options.runtimeUrl ?? '/runtime/').replace(/\/?$/, '/');
  const underNode = typeof process !== 'undefined' && typeof process.versions?.node === 'string';
  let runtimeUrl = givenRuntimeUrl;
  if (!underNode && typeof document !== 'undefined') {
    try {
      runtimeUrl = new URL(givenRuntimeUrl, document.baseURI).href;
    } catch {
      runtimeUrl = givenRuntimeUrl;
    }
  }
  const limits: Required<ContainerLimits> = {
    ...DEFAULT_LIMITS,
    ...(options.limits ?? {}),
  };

  const emitStatus = (status: ContainerBootStatus) => {
    options.onStatus?.(status);
  };
  emitStatus({
    phase: 'opening',
    message: 'Opening application archive…',
    percent: 10,
  });

  const rawSource = await loadArchiveSource(options.source);
  const archive = await ContainerArchive.open(rawSource);
  emitStatus({
    phase: 'opening',
    message: `Preparing ${archive.manifest.name}…`,
    percent: 18,
    detail: archive.manifest.backend ? `${archive.manifest.backend.runtime.toUpperCase()} backend + web app` : undefined,
  });
  // Where the app's saved data is kept in the embedding page's storage. The host's word when
  // it gives one; otherwise the address the archive was loaded from, or the digest of its
  // bytes. Never the `id` the app's own manifest claims: an app that claimed another's id
  // was handed the other's saved data, and wrote over it.
  const appId =
    options.appId ??
    (typeof options.source === 'string'
      ? `src:${typeof document !== 'undefined' ? new URL(options.source, document.baseURI).href : options.source}`
      : `sha256:${archive.digest}`);
  // The keys the app's kept data goes under: the host's own place for it, when it has one
  // (a host that lists, moves and removes each app's data keeps the container's with it).
  // Always terminate with a delimiter so prefix "app1" can never collide with "app10".
  const rawStorageBase =
    typeof options.storagePrefix === 'string' && options.storagePrefix.length > 0
      ? options.storagePrefix
      : `softn-v2:${safeStorageAppId(appId)}:`;
  const storageBase = rawStorageBase.endsWith(':') || rawStorageBase.endsWith('/') ? rawStorageBase : `${rawStorageBase}:`;
  // Said once: the page's storage refused (it is full, or a private window keeps none).
  let storageRefused = false;
  const storageKept = (kept: boolean): void => {
    if (kept || storageRefused) return;
    storageRefused = true;
    options.onError?.(new Error('This app’s data could not be kept: the browser’s storage for this page is full or unavailable.'));
  };
  const permissions = options.permissionsOverride ?? archive.permissions;
  const requestedCaps = options.permissionsOverride
    ? inspectDeclaration(permissions).requested
    : archive.requestedCapabilities;
  const allowedCaps = new Set<Capability>(requestedCaps);
  let deviceBridge: ContainerDeviceBridge | null = options.deviceBridge ?? null;
  let deviceBridgeModPromise: Promise<typeof import('./device-bridge')> | null = null;
  const loadDeviceBridge = () => {
    if (!deviceBridgeModPromise) {
      deviceBridgeModPromise = import('./device-bridge').catch((err) => {
        deviceBridgeModPromise = null;
        throw err;
      });
    }
    return deviceBridgeModPromise;
  };

  // What is granted before the first script runs: everything the archive (or host override)
  // permits when preapproved, else only declared capabilities from initialGrantedCapabilities.
  let grantedCaps = new Set<Capability>(
    options.permissionMode === 'preapproved'
      ? requestedCaps
      : (options.initialGrantedCapabilities ?? []).filter((cap) => allowedCaps.has(cap))
  );
  let consentDenied = false;

  // Legacy v1 `.ui` fallback path (0 bytes loaded unless `.ui` entry detected)
  if (archive.manifest.mode === 'legacy-ui') {
    const mountDiv = document.createElement('div');
    mountDiv.style.cssText = 'width:100%;height:100%';
    if (owns()) shadowRoot.appendChild(mountDiv);
    const { mountLegacyUiBundle } = await import('./compat/legacy-ui');
    const legacyHandle = await mountLegacyUiBundle(mountDiv, archive, runtimeUrl, options.legacyUiBridge);
    options.onReady?.({
      manifest: archive.manifest,
      engineTier: 'lite',
      capabilitiesRequested: requestedCaps,
    });
    return {
      manifest: archive.manifest,
      engineTier: 'lite',
      appId,
      shadowRoot,
      frameRoot: shadowRoot,
      currentPath: `/${archive.manifest.main}`,
      navigate: async () => undefined,
      listVirtualDirectory: (dir) => archive.listVirtualDirectory(dir),
      seedDatabase: async () => { throw new Error('SQLite is unavailable in legacy-ui mode'); },
      exportDatabase: async () => null,
      setGrantedCapabilities: () => undefined,
      setActive: () => undefined,
      dispose() {
        legacyHandle.dispose();
        archive.dispose();
        if (owns()) shadowRoot.replaceChildren();
      },
    };
  }

  // The frame, once for the mount: the bars above, the app's box below, and in the box the
  // root every page of the app is drawn in.
  const frameStyle = document.createElement('style');
  frameStyle.textContent = FRAME_BASE_CSS;
  const frameEl = document.createElement('div');
  frameEl.setAttribute('data-softn-frame', '');
  frameEl.style.cssText = FRAME_STYLE;
  const boxEl = document.createElement('div');
  boxEl.setAttribute('data-softn-box', '');
  boxEl.style.cssText = BOX_STYLE;
  const pageRoot = attachPageRoot(boxEl);
  frameEl.appendChild(boxEl);
  /** The bar asking whether to save a file the app made, while one is unanswered. */
  let saveEl: HTMLElement | null = null;

  let disposed = false;
  let currentPatcher: HostDomPatcher | null = null;
  let currentTransport: WorkerTransport | null = null;
  let threeHost: SplitRealmSceneHost | null = null;
  let threeHostPromise: Promise<SplitRealmSceneHost | null> | null = null;
  const persistStorage = options.persistStorage !== false;
  const storage = persistStorage ? options.storage ?? browserStorage() : undefined;
  let cachedPersistedBytes: number | null = null;
  // What another tab keeps for the same app, told to its Worker as it happens: each tab reads
  // what the other kept before it writes over it. (Each kept the stores it had read when it
  // started, so the same app open in two tabs wrote the other's records away.)
  // A key of the app's that another tab, or another of the same app in this page, changed.
  const heard = (key: string) => {
    if (disposed || !key.startsWith(storageBase) || !storage) return;
    cachedPersistedBytes = null;
    const rest = key.slice(storageBase.length);
    // What is kept there now: the event's own value may be older than what this tab kept
    // since, and handed on, this tab's view went back to it.
    let value: string | null;
    try {
      value = storage.getItem(key);
    } catch {
      return;
    }
    if (rest.startsWith('ls:')) {
      const k = rest.slice(3);
      const prevVal = Object.prototype.hasOwnProperty.call(liveSession.localStorage, k) ? liveSession.localStorage[k] : null;
      if (prevVal !== null) liveLocalStorageBytes -= (k.length + prevVal.length) * 2;
      if (value === null) delete liveSession.localStorage[k];
      else {
        liveSession.localStorage[k] = value;
        liveLocalStorageBytes += (k.length + value.length) * 2;
      }
      currentTransport?.post({ type: 'storage-changed', area: 'ls', key: k, value });
    } else if (rest.startsWith('idb:')) {
      currentTransport?.post({ type: 'storage-changed', area: 'idb', key: rest.slice(4), value });
    }
  };
  const onStorage = (event: StorageEvent) => {
    if (disposed || typeof event.key !== 'string' || !storage) return;
    try {
      if (event.storageArea !== storage) return;
    } catch {
      return;
    }
    heard(event.key);
  };
  if (persistStorage && typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  if (persistStorage) {
    const mounted = mountedByStorage.get(storageBase) ?? new Set<(key: string) => void>();
    mounted.add(heard);
    mountedByStorage.set(storageBase, mounted);
  }
  // The app's IndexedDB databases (idb-backing.ts): kept in the page's IndexedDB, or without
  // one in its localStorage; read when a session starts.
  let idbBacking: IdbBacking | null = null;
  /** What is kept of them, as this page last read or wrote it. */
  const idbParts = new Map<string, string>();
  /** Incremental UTF-16 byte count of `idbParts` so quota checks stay O(changes.size). */
  let idbPartsBytes = 0;
  /** How often each part was written here or read again: a part told by another tab is not taken in over a newer one of this tab's. */
  const idbPartTurns = new Map<string, number>();
  const turnOfPart = (name: string) => idbPartTurns.get(name) ?? 0;
  const setIdbPart = (name: string, value: string | null) => {
    const prev = idbParts.get(name);
    if (prev !== undefined) idbPartsBytes -= partBytes(name, prev);
    if (value === null) idbParts.delete(name);
    else {
      idbParts.set(name, value);
      idbPartsBytes += partBytes(name, value);
    }
    idbPartTurns.set(name, turnOfPart(name) + 1);
  };
  /** The databases this tab holds for the app's side (a lock across the site's tabs), each let go of by its function. */
  const idbHolds = new Map<string, () => void>();
  /** Those held by a lease (no locks in this browser): what a write under it checks is still this tab's. */
  const idbFences = new Map<string, LeaseFence>();
  /** Holds asked for and not given yet (scoped per page session via `idbHoldEpoch`). */
  let idbHoldsAsked = 0;
  let idbHoldEpoch = 0;
  /** What is being kept, in order: a database is let go of once what was written while it was held is kept. */
  let idbWriting: Promise<unknown> = Promise.resolve();
  /** Tells the same app in other tabs, and elsewhere in this page, which parts were kept. */
  let idbChannel: BroadcastChannel | null = null;
  /** Keep a batch of parts; true once kept, false when the page's storage refused (its answers come in the batches' order). */
  const keepIdbParts = (parts: Record<string, string | null>): Promise<boolean> => {
    const backing = idbBacking;
    if (!backing || !parts || typeof parts !== 'object') return Promise.resolve(true);
    const changes = new Map<string, string | null>();
    for (const [name, value] of Object.entries(parts)) {
      if (name.length > 1024 || (value !== null && typeof value !== 'string')) continue;
      changes.set(name, value);
    }
    if (changes.size === 0) return Promise.resolve(true);
    if (backing.kind === 'localStorage') {
      cachedPersistedBytes = null;
      // Held to the one quota with the rest the app keeps, all of it or none: a part refused
      // puts back what the others were (kept a part at a time, half a transaction could be).
      // Told to the same app elsewhere in this page.
      const before = new Map<string, string | null>();
      for (const name of changes.keys()) {
        try {
          before.set(name, storage ? storage.getItem(`${storageBase}idb:${name}`) : null);
        } catch {
          before.set(name, null);
        }
      }
      let refused = false;
      for (const [name, value] of changes) {
        if (!savePersistedIdb(storageBase, name, value, limits.storageQuotaBytes, storage)) {
          refused = true;
          break;
        }
      }
      if (refused) {
        for (const [name, value] of before) {
          try {
            if (!storage) break;
            if (value === null) storage.removeItem(`${storageBase}idb:${name}`);
            else storage.setItem(`${storageBase}idb:${name}`, value);
          } catch {
            // What was there fitted before; nothing more to do.
          }
        }
        storageKept(false);
        return Promise.resolve(false);
      }
      for (const [name, value] of changes) setIdbPart(name, value);
      tellNeighbours(storageBase, heard, [...changes.keys()].map((name) => `${storageBase}idb:${name}`));
      return Promise.resolve(true);
    }
    // Held to the app's IndexedDB quota as a whole, and kept together (a transaction whole or
    // not at all), after what is being kept before it.
    const done = idbWriting.then(async () => {
      let bytes = idbPartsBytes;
      for (const [name, value] of changes) {
        const prev = idbParts.get(name);
        if (prev !== undefined) bytes -= partBytes(name, prev);
        if (value !== null) bytes += partBytes(name, value);
      }
      if (bytes > limits.idbQuotaBytes) return false;
      const previous = new Map<string, string | null>();
      for (const name of changes.keys()) previous.set(name, idbParts.get(name) ?? null);
      for (const [name, value] of changes) setIdbPart(name, value);
      // Under a lease, the write checks the lease is this tab's still, in its own transaction.
      const fences: LeaseFence[] = [];
      for (const database of new Set([...changes.keys()].map((name) => databaseOfPart(name) ?? ''))) {
        const fence = idbFences.get(database);
        if (fence) fences.push(fence);
      }
      const kept = await backing.write(changes, fences);
      if (!kept) for (const [name, value] of previous) setIdbPart(name, value);
      return kept;
    }).then((kept) => {
      storageKept(kept);
      if (kept) idbChannel?.postMessage({ names: [...changes.keys()] });
      return kept;
    });
    idbWriting = done.catch(() => false);
    return done.catch(() => false);
  };
  // The app's side is to write to a database: this tab holds it (across the site's tabs, where
  // the browser can say so), and tells the app's side what other tabs kept in it first.
  const holdIdb = (id: number, name: string) => {
    const backing = idbBacking;
    // The session that asked: a session started again since asks with ids of its own.
    const asker = currentTransport;
    const give = async (): Promise<boolean> => {
      const parts: Record<string, string | null> = {};
      if (backing && typeof name === 'string') {
        try {
          // What this page wrote is kept first: read before, a part would be read as it was.
          await idbWriting.catch(() => undefined);
          const prefixes = partPrefixes(name);
          const fresh = await backing.read(prefixes);
          for (const [part, value] of fresh) if (idbParts.get(part) !== value) parts[part] = value;
          for (const part of idbParts.keys()) if (prefixes.some((p) => part.startsWith(p)) && !fresh.has(part)) parts[part] = null;
          for (const [part, value] of Object.entries(parts)) setIdbPart(part, value);
        } catch {
          // Not read: the app's side goes on from what it has.
        }
      }
      if (disposed || !asker || currentTransport !== asker) return false;
      asker.post({ type: 'idb-held', id, parts });
      return true;
    };
    const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
    // A name of a database's length, and as many as an app has use for: past either (the app's
    // code may ask for anything), given without holding anything across tabs.
    if (!backing || backing.kind !== 'indexeddb' || typeof name !== 'string' || name.length > 1024 || idbHolds.size + idbHoldsAsked >= MAX_IDB_HOLDS) {
      void give();
      return;
    }
    const holdEpoch = idbHoldEpoch;
    idbHoldsAsked++;
    let asking = true;
    const answered = () => {
      if (!asking) return;
      asking = false;
      if (idbHoldEpoch === holdEpoch && idbHoldsAsked > 0) idbHoldsAsked--;
    };
    const registerHold = (release: () => void) => {
      const existing = idbHolds.get(name);
      if (existing && existing !== release) {
        idbHolds.delete(name);
        void idbWriting.then(existing, existing);
      }
      idbHolds.set(name, release);
    };
    if (!locks || typeof locks.request !== 'function') {
      // No locks in this browser: a lease in the page's IndexedDB holds it instead.
      void holdByLease(storageBase, name, () => disposed || currentTransport !== asker)
        .then((lease) => {
          answered();
          if (!lease) return;
          const release = () => {
            if (idbFences.get(name) === lease.fence) idbFences.delete(name);
            lease.release();
          };
          registerHold(release);
          idbFences.set(name, lease.fence);
          return give().then((told) => {
            if (!told && idbHolds.get(name) === release) releaseIdb(name);
          });
        })
        .catch(() => {
          answered();
          void give();
        });
      return;
    }
    let given = false;
    locks
      .request(
        `softn-idb:${JSON.stringify([storageBase, name])}`,
        () =>
          new Promise<void>((release) => {
            given = true;
            answered();
            if (disposed || currentTransport !== asker) {
              release();
              return;
            }
            registerHold(release);
            void give().then((told) => {
              // Asked for by a session that is gone: let go of at once.
              if (!told && idbHolds.get(name) === release) releaseIdb(name);
            });
          })
      )
      .catch(() => {
        answered();
        // The browser would not hold it: the app's side goes on without.
        if (!given) void give();
      });
  };
  const releaseIdb = (name: string) => {
    const release = idbHolds.get(name);
    if (!release) return;
    idbHolds.delete(name);
    // Once what was written while it was held is kept.
    void idbWriting.then(release, release);
  };
  // Parts another tab (or the same app elsewhere in this page) kept: read, and told to the
  // app's side. Not those of a database this tab holds, which it read when it was given it.
  const idbToldElsewhere = (names: unknown) => {
    const backing = idbBacking;
    if (!backing || disposed || !Array.isArray(names)) return;
    const overCap = names.length > 4096;
    const asked = overCap
      ? []
      : names.filter((n): n is string => typeof n === 'string' && n.length <= 1024 && !idbHolds.has(databaseOfPart(n) ?? ''));
    if (!overCap && asked.length === 0) return;
    const turns = overCap
      ? new Map(Array.from(idbParts.keys(), (n) => [n, turnOfPart(n)]))
      : new Map(asked.map((n) => [n, turnOfPart(n)]));
    // After what this page is writing: read before, a part it wrote would be read as it was.
    void idbWriting
      .catch(() => undefined)
      .then(() => (overCap ? backing.loadAll() : backing.read(asked)))
      .then((fresh) => {
        if (disposed) return;
        // Told together, taken in together: a commit of the other tab's is never seen half done
        // (one part a turn, a read between two of them read a page with a list of pages before it).
        const parts: Record<string, string | null> = {};
        let any = false;
        const keysToCheck = overCap
          ? new Set<string>([...idbParts.keys(), ...fresh.keys()])
          : asked;
        for (const name of keysToCheck) {
          // Written or read again here since it was asked for: what is here is newer.
          const expectedTurn = turns.get(name) ?? 0;
          if (turnOfPart(name) !== expectedTurn || idbHolds.has(databaseOfPart(name) ?? '')) continue;
          const value = fresh.get(name) ?? null;
          if ((idbParts.get(name) ?? null) === value) continue;
          setIdbPart(name, value);
          parts[name] = value;
          any = true;
        }
        if (any) currentTransport?.post({ type: 'idb-changed', parts });
      })
      .catch(() => {
        // Not read: told again by the next write.
      });
  };
  let rafHandle: number | ReturnType<typeof setTimeout> | null = null;
  let rafInFlight = false;
  let rafWantedWhileInFlight = false;
  const COALESCE_MOVE_EVENTS = new Set([
    'pointermove', 'mousemove', 'touchmove',
    'pointerover', 'pointerout', 'mouseover', 'mouseout',
    'pointerleave', 'pointerenter', 'mouseleave', 'mouseenter',
  ]);
  const DISCRETE_POINTER_EVENTS = new Set([
    'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu',
  ]);
  interface PendingCoalescedEvent {
    nodeId: number;
    eventType: string;
    props: Record<string, unknown>;
    syncChanges: unknown[];
  }
  const inFlightCoalesced = new Map<string, number>();
  const pendingCoalesced = new Map<string, PendingCoalescedEvent>();
  let wheelInFlightTurnId: number | null = null;
  let pendingWheel: PendingCoalescedEvent | null = null;
  let activeTier: ZippEngineTier = 'lite';
  let turnSeq = 1;
  const pendingWatchdogs = new Map<number, ReturnType<typeof setTimeout>>();
  let rafWatchdog: ReturnType<typeof setTimeout> | null = null;
  let initWatchdog: ReturnType<typeof setTimeout> | null = null;
  let onSessionStopped: ((reason: string) => void) | null = null;
  /** What waits for the script's answer to an event it was handed, by the event's turn. */
  const pendingAnswers = new Map<number, (eventBits: number) => void>();

  const clearRafWatchdog = () => {
    if (rafWatchdog !== null) {
      clearTimeout(rafWatchdog);
      rafWatchdog = null;
    }
  };
  const clearInitWatchdog = () => {
    if (initWatchdog !== null) {
      clearTimeout(initWatchdog);
      initWatchdog = null;
    }
  };

  const clearRaf = () => {
    rafInFlight = false;
    rafWantedWhileInFlight = false;
    clearRafWatchdog();
    if (rafHandle !== null) {
      if (typeof cancelAnimationFrame === 'function' && typeof rafHandle === 'number') {
        cancelAnimationFrame(rafHandle);
      } else {
        clearTimeout(rafHandle as ReturnType<typeof setTimeout>);
      }
      rafHandle = null;
    }
  };

  // The host says the app is not on screen (`setActive(false)`: a tab behind another): no
  // frame is asked for and the Worker holds the app's timers until it is shown again. A
  // frame the app wanted meanwhile is remembered and asked for then.
  let paused = false;
  let frameOwed = false;

  const scheduleNextRaf = () => {
    if (paused) {
      frameOwed = true;
      return;
    }
    if (rafInFlight) {
      rafWantedWhileInFlight = true;
      return;
    }
    if (rafHandle !== null || disposed) return;
    const step = (ts: number) => {
      rafHandle = null;
      if (!disposed) {
        rafInFlight = true;
        rafWantedWhileInFlight = false;
        clearRafWatchdog();
        if (useWorkerIsolation) {
          rafWatchdog = setTimeout(() => {
            rafWatchdog = null;
            currentTransport?.terminate();
            options.onError?.(
              new Error(`Container terminated: animation frame exceeded ${limits.turnTimeoutMs}ms time limit`)
            );
            onSessionStopped?.(
              `its script took more than ${Math.round(limits.turnTimeoutMs / 1000)} seconds to finish an animation frame.`
            );
          }, limits.turnTimeoutMs);
        }
        currentTransport?.post({ type: 'raf', timestamp: ts });
      }
    };
    if (typeof requestAnimationFrame === 'function') {
      rafHandle = requestAnimationFrame(step);
    } else {
      rafHandle = setTimeout(() => step(performance.now()), 16);
    }
  };

  const backendSockets = new Map<string, BackendWsHandle>();
  let viewportResizeObserver: ResizeObserver | null = null;
  let hostFontStyleEl: HTMLStyleElement | null = null;
  const dynamicFontSheets = new Map<Element, string>();

  const teardownPage = () => {
    clearRaf();
    clearInitWatchdog();
    onSessionStopped = null;
    // Databases the session held are let go of, once what it wrote is kept: started again, it holds none.
    idbHoldEpoch++;
    idbHoldsAsked = 0;
    for (const release of idbHolds.values()) void idbWriting.then(release, release);
    idbHolds.clear();
    for (const wd of pendingWatchdogs.values()) clearTimeout(wd);
    pendingWatchdogs.clear();
    pendingAnswers.clear();
    inFlightCoalesced.clear();
    pendingCoalesced.clear();
    wheelInFlightTurnId = null;
    pendingWheel = null;
    for (const ws of backendSockets.values()) {
      try { ws.close(1001, 'page navigated'); } catch { /* ignore */ }
    }
    backendSockets.clear();
    currentTransport?.terminate();
    currentTransport = null;
    currentPatcher?.dispose();
    currentPatcher = null;
    threeHost?.dispose();
    threeHost = null;
    threeHostPromise = null;
    archive.clearRuntimeBlobs();
    viewportResizeObserver?.disconnect();
    viewportResizeObserver = null;
    hostFontStyleEl?.remove();
    hostFontStyleEl = null;
    dynamicFontSheets.clear();
  };

  const useWorkerIsolation =
    options.isolation === 'worker' ||
    (options.isolation !== 'inline' && typeof Worker === 'function');

  // Build effective SQLite database configs (manifest + auto-discovered + host-provided JSON seed overrides)
  const effectiveDatabases: DatabaseConfig[] = (archive.manifest.databases ?? []).map((d) => ({ ...d }));
  if (options.databaseSeeds) {
    for (const [dbName, seedJson] of Object.entries(options.databaseSeeds)) {
      const existing = effectiveDatabases.find((d) => d.name === dbName || d.file === dbName);
      if (existing) {
        existing.seedJson = seedJson;
      } else {
        effectiveDatabases.push({
          name: dbName,
          engine: 'sqlite',
          file: dbName.endsWith('.db') ? dbName : `${dbName}.db`,
          seedJson,
          persist: true,
        });
      }
    }
  }

  let localBackendTransport: LocalBackendTransport | null = null;
  let ownedRemoteTransport: RemoteBackendTransport | null = null;
  let backendTransport: BackendTransport | undefined = options.backendTransport;
  if (!backendTransport && options.backendUrl) {
    ownedRemoteTransport = new RemoteBackendTransport({
      baseUrl: options.backendUrl,
      headers: options.backendHeaders,
    });
    backendTransport = ownedRemoteTransport;
  }

  const backendRouting =
    buildBackendRoutingConfig(archive.manifest.backend) ??
    (backendTransport
      ? { enabled: true, mode: 'api' as const, routes: ['/api/', '/ws'], interceptOrigins: [] }
      : undefined);

  const resolveXdbSource = async (): Promise<ZippEngineSource | undefined> => {
    if (options.xdbWasm) {
      const resolvedXdb = typeof options.xdbWasm === 'function' ? await options.xdbWasm() : options.xdbWasm;
      if (resolvedXdb instanceof WebAssembly.Module) return resolvedXdb;
      if (typeof resolvedXdb === 'string') {
        return useWorkerIsolation ? await getSharedCompiledEngine(resolvedXdb) : resolvedXdb;
      }
      if (resolvedXdb) {
        return resolvedXdb instanceof ArrayBuffer
          ? new Uint8Array(resolvedXdb)
          : new Uint8Array(resolvedXdb.buffer, resolvedXdb.byteOffset, resolvedXdb.byteLength);
      }
      return undefined;
    }
    return useWorkerIsolation ? await getSharedCompiledEngine(`${runtimeUrl}engines/xdb-wasm.wasm`) : undefined;
  };

  let lazySqliteBoot: Promise<LocalBackendTransport> | null = null;
  const ensureLocalSqliteTransport = async (): Promise<LocalBackendTransport> => {
    if (localBackendTransport) return localBackendTransport;
    if (lazySqliteBoot) return lazySqliteBoot;
    lazySqliteBoot = (async () => {
      const [{ LocalBackendTransport: LocalTransportCtor }, xdbSource] = await Promise.all([
        import('./local-backend-transport'),
        resolveXdbSource(),
      ]);
      const backendVfs = archive.exportBackendVfs();
      const transport = new LocalTransportCtor({
        appId,
        storagePrefix: storageBase,
        persistStorage,
        storage: options.storage,
        databases: effectiveDatabases,
        textFiles: backendVfs.textFiles,
        binaryFiles: backendVfs.binaryFiles,
        runtimeUrl,
        isolation: useWorkerIsolation ? 'worker' : 'inline',
        xdbModule: xdbSource,
        xdbGlueUrl: options.xdbGlueUrl,
        instructionBudget: limits.instructionsPerTurn,
        maxTotalSqliteBytes: limits.idbQuotaBytes,
        onConsole: options.onConsole,
        onStatus: emitStatus,
      });
      try {
        await transport.ready;
      } catch (err) {
        transport.dispose();
        throw err;
      }
      if (disposed || !owns()) {
        transport.dispose();
        throw new Error('Container disposed while initializing SQLite');
      }
      localBackendTransport = transport;
      return transport;
    })();
    try {
      return await lazySqliteBoot;
    } catch (err) {
      lazySqliteBoot = null;
      throw err;
    }
  };

  let cleanupSessionListeners: (() => void) | null = null;
  const cleanupBootFailure = () => {
    if (disposed) return;
    disposed = true;
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorage);
    }
    cleanupSessionListeners?.();
    const mounted = mountedByStorage.get(storageBase);
    if (mounted) {
      mounted.delete(heard);
      if (mounted.size === 0) mountedByStorage.delete(storageBase);
    }
    for (const release of idbHolds.values()) void idbWriting.then(release, release);
    idbHolds.clear();
    idbChannel?.close();
    idbChannel = null;
    teardownPage();
    if (deviceBridge && !options.deviceBridge) {
      try { deviceBridge.dispose?.(); } catch { /* ignore */ }
      deviceBridge = null;
    }
    localBackendTransport?.dispose();
    localBackendTransport = null;
    ownedRemoteTransport?.dispose();
    ownedRemoteTransport = null;
    archive.dispose();
    pageRoot.replaceChildren();
    if (owns()) shadowRoot.replaceChildren();
  };

  // When a local backend engine is loaded (e.g. zipp-php.wasm or zipp-rust.wasm), reuse that
  // already-compiled WebAssembly.Module for the frontend worker whenever it satisfies the frontend
  // JS tier (saves ~7.6 MB download + a second full WASM compile on every full-stack app!).
  let sharedLocalBackendEngine: { tier: ZippEngineTier; source: ZippEngineSource } | null = null;

  const savedSessionPromise: Promise<PersistedContainerSession | null> = persistStorage
    ? loadContainerSession(storageBase).catch(() => null)
    : Promise.resolve(null);

  try {
    if (!backendTransport && (archive.manifest.backend || effectiveDatabases.length > 0)) {
      const backendVfs = archive.exportBackendVfs();
      const bTier: ZippEngineTier | null = archive.manifest.backend
        ? (() => {
            const bRt = archive.manifest.backend.runtime;
            return bRt === 'rust'
              ? 'rust'
              : bRt === 'php'
                ? 'php'
                : bRt === 'typescript'
                  ? 'typescript'
                  : bRt === 'python'
                    ? 'python'
                    : 'javascript';
          })()
        : null;

      const resolveBackendEngine = async (): Promise<ZippEngineSource | undefined> => {
        if (!bTier) return undefined;
        const suppliedBackend = options.engineWasm?.[bTier];
        const resolvedBackend = typeof suppliedBackend === 'function' ? await suppliedBackend() : suppliedBackend;
        if (resolvedBackend instanceof WebAssembly.Module) return resolvedBackend;
        if (typeof resolvedBackend === 'string') {
          return useWorkerIsolation ? await getSharedCompiledEngine(resolvedBackend) : resolvedBackend;
        }
        if (resolvedBackend) {
          return resolvedBackend instanceof ArrayBuffer
            ? new Uint8Array(resolvedBackend)
            : new Uint8Array(resolvedBackend.buffer, resolvedBackend.byteOffset, resolvedBackend.byteLength);
        }
        if (useWorkerIsolation) {
          return await getSharedCompiledEngine(`${runtimeUrl}engines/${ENGINE_FILES[bTier]}`);
        }
        return undefined;
      };

      // Fetch/compile backend WASM, XDB SQLite WASM, and local-backend-transport in parallel!
      const [backendEngineSource, { LocalBackendTransport: LocalTransportCtor }, xdbSource] = await Promise.all([
        resolveBackendEngine(),
        import('./local-backend-transport'),
        resolveXdbSource(),
      ]);

      if (bTier && backendEngineSource) {
        sharedLocalBackendEngine = { tier: bTier, source: backendEngineSource };
      }

      localBackendTransport = new LocalTransportCtor({
        appId,
        storagePrefix: storageBase,
        persistStorage,
        storage: options.storage,
        backend: archive.manifest.backend,
        databases: effectiveDatabases,
        textFiles: backendVfs.textFiles,
        binaryFiles: backendVfs.binaryFiles,
        runtimeUrl,
        isolation: useWorkerIsolation ? 'worker' : 'inline',
        engineModule: backendEngineSource,
        xdbModule: xdbSource,
        xdbGlueUrl: options.xdbGlueUrl,
        instructionBudget: limits.instructionsPerTurn,
        maxTotalSqliteBytes: limits.idbQuotaBytes,
        onConsole: options.onConsole,
        onStatus: emitStatus,
      });
      backendTransport = localBackendTransport;
      // SSR apps need the backend ready to render the initial HTML document; API-only apps
      // boot the backend in parallel with the frontend worker (`fetch()` awaits `this.ready`).
      if (archive.manifest.ssrEntry || archive.manifest.backend?.mode === 'ssr') {
        await backendTransport.ready;
      } else {
        void backendTransport.ready.catch((err) => {
          if (!disposed) options.onError?.(err instanceof Error ? err : new Error(String(err)));
        });
      }
    } else if (backendTransport) {
      emitStatus({
        phase: 'booting-backend',
        message: 'Connecting to backend…',
        percent: 60,
      });
      await backendTransport.ready;
      emitStatus({
        phase: 'backend-ready',
        message: 'Backend ready',
        percent: 82,
      });
    }
  } catch (err) {
    cleanupBootFailure();
    throw err;
  }

  let currentUrlPath = options.initialPath ?? (archive.manifest.ssrEntry ? '/' : `/${archive.manifest.main}`);
  const savedSession: PersistedContainerSession | null = await savedSessionPromise;
  const initialPersistedLs = persistStorage && storage ? loadPersistedStorage(storageBase, storage) : null;
  const liveSession: PersistedContainerSession = {
    urlPath: savedSession?.urlPath,
    sessionStorage: Object.assign(Object.create(null) as Record<string, string>, savedSession?.sessionStorage ?? {}),
    localStorage: Object.assign(
      Object.create(null) as Record<string, string>,
      // When `storage` is available, it is the source of truth so deleted keys are never resurrected
      // from an older IndexedDB session mirror; fall back to `savedSession.localStorage` only in
      // opaque/storage-less frames.
      initialPersistedLs ?? (savedSession?.localStorage ?? {})
    ),
    updatedAt: Date.now(),
  };
  let liveSessionStorageBytes = recordBytes(liveSession.sessionStorage);
  let liveLocalStorageBytes = recordBytes(liveSession.localStorage);
  let sessionSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let sessionDirty = false;
  const flushSessionNow = () => {
    if (!persistStorage) return;
    if (sessionSaveTimer !== null) {
      clearTimeout(sessionSaveTimer);
      sessionSaveTimer = null;
    }
    if (!sessionDirty) return;
    sessionDirty = false;
    liveSession.updatedAt = Date.now();
    void saveContainerSession(storageBase, liveSession);
  };
  const persistSessionSoon = () => {
    if (!persistStorage || disposed) return;
    sessionDirty = true;
    if (sessionSaveTimer !== null) return;
    sessionSaveTimer = setTimeout(() => {
      sessionSaveTimer = null;
      flushSessionNow();
    }, 60);
  };
  const onPageHideFlush = () => {
    flushSessionNow();
    localBackendTransport?.flush();
  };
  const onVisibilityFlush = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      flushSessionNow();
      localBackendTransport?.flush();
    }
  };
  if (persistStorage && typeof window !== 'undefined') {
    window.addEventListener('pagehide', onPageHideFlush);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityFlush);
    }
  }
  cleanupSessionListeners = () => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', onPageHideFlush);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityFlush);
    }
    flushSessionNow();
  };
  const navHistory: string[] = [];
  let navHistoryIndex = -1;
  let navEl: HTMLElement | null = null;
  let navController: VirtualNavBarController | null = null;

  const updateNavUi = () => {
    if (!navController) return;
    navController.setPath(currentUrlPath);
    navController.setHistoryState(navHistoryIndex > 0, navHistoryIndex >= 0 && navHistoryIndex < navHistory.length - 1);
  };

  if (options.virtualNav && typeof document !== 'undefined') {
    const { renderVirtualNavBar } = await import('./virtual-nav-bar');
    navEl = document.createElement('div');
    navEl.setAttribute('data-softn-virtual-nav', '');
    navEl.style.cssText = CONSENT_STYLE;
    navController = renderVirtualNavBar({
      appName: hostLabel(archive.manifest.name) || 'SoftN App',
      initialPath: currentUrlPath,
      listDirectory: (dir) => archive.listVirtualDirectory(dir, { includePrivate: false }),
      onNavigate: (target) => {
        void navigateTo(target, true).catch((err) => options.onError?.(err instanceof Error ? err : new Error(String(err))));
      },
      onBack: () => {
        if (navHistoryIndex > 0) {
          navHistoryIndex--;
          void navigateTo(navHistory[navHistoryIndex], false).catch((err) => options.onError?.(err instanceof Error ? err : new Error(String(err))));
        }
      },
      onForward: () => {
        if (navHistoryIndex + 1 < navHistory.length) {
          navHistoryIndex++;
          void navigateTo(navHistory[navHistoryIndex], false).catch((err) => options.onError?.(err instanceof Error ? err : new Error(String(err))));
        }
      },
      onReload: () => {
        void navigateTo(currentUrlPath, false).catch((err) => options.onError?.(err instanceof Error ? err : new Error(String(err))));
      },
    });
    navEl.attachShadow({ mode: 'closed' }).appendChild(navController.element);
    frameEl.insertBefore(navEl, boxEl);
  }

  const fetchSsrDocument = async (
    method: string,
    rawUrlPath: string,
    encodedBody?: string
  ): Promise<{ finalUrlPath: string; html: string }> => {
    if (!backendTransport) {
      throw new Error(`No backend available to handle ${rawUrlPath}`);
    }
    let curMethod = method.toUpperCase();
    let curUrl = new URL(rawUrlPath, `${VIRTUAL_ORIGIN}${currentUrlPath.startsWith('/') ? currentUrlPath : `/${currentUrlPath}`}`);
    let curBody = curMethod !== 'GET' && curMethod !== 'HEAD' ? encodedBody : undefined;

    for (let hops = 0; hops < 10; hops++) {
      const path = curUrl.pathname || '/';
      const query = curUrl.search.startsWith('?') ? curUrl.search.slice(1) : curUrl.search;
      const headers: Record<string, string> = { accept: 'text/html,application/xhtml+xml,*/*' };
      if (curBody !== undefined) {
        headers['content-type'] = 'application/x-www-form-urlencoded';
      }
      const resp = await backendTransport.fetch({
        method: curMethod,
        path,
        query,
        headers,
        body: curBody,
      });

      if ([301, 302, 303, 307, 308].includes(resp.status)) {
        const locPair = resp.headers.find(([k]) => k.toLowerCase() === 'location');
        if (locPair && locPair[1]) {
          let nextUrl: URL;
          try {
            nextUrl = new URL(locPair[1], curUrl);
          } catch {
            throw new Error('Invalid redirect location from backend');
          }
          if (nextUrl.origin !== VIRTUAL_ORIGIN) {
            throw new Error('Blocked cross-origin redirect from backend');
          }
          curUrl = nextUrl;
          if (resp.status === 301 || resp.status === 302 || resp.status === 303) {
            curMethod = 'GET';
            curBody = undefined;
          }
          continue;
        }
      }

      const ctPair = resp.headers.find(([k]) => k.toLowerCase() === 'content-type');
      const ct = (ctPair?.[1] ?? 'text/html').toLowerCase();
      const decoded = new TextDecoder().decode(resp.body);
      const escapeHtmlText = (s: string) =>
        s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const html = ct.includes('html')
        ? decoded
        : `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtmlText(path)}</title></head><body><pre>${escapeHtmlText(decoded)}</pre></body></html>`;
      return {
        finalUrlPath: `${curUrl.pathname}${curUrl.search}`,
        html,
      };
    }
    throw new Error('Too many redirects from backend');
  };

  const recordHistory = (urlPath: string, pushHistory: boolean) => {
    currentUrlPath = urlPath;
    if (pushHistory) {
      if (navHistoryIndex + 1 < navHistory.length) {
        navHistory.splice(navHistoryIndex + 1);
      }
      if (navHistory[navHistoryIndex] !== urlPath) {
        navHistory.push(urlPath);
        navHistoryIndex = navHistory.length - 1;
      }
    }
    updateNavUi();
    if (urlPath.startsWith('/')) {
      liveSession.urlPath = urlPath;
      persistSessionSoon();
    }
  };

  let navSeq = 0;

  const navigateTo = async (rawTarget: string, pushHistory = true, fromRoot = false): Promise<void> => {
    const seq = ++navSeq;
    const base = fromRoot
      ? `${VIRTUAL_ORIGIN}/`
      : `${VIRTUAL_ORIGIN}${currentUrlPath.startsWith('/') ? currentUrlPath : `/${currentUrlPath}`}`;
    const parsed = new URL(rawTarget || '/', base);
    if (parsed.origin !== VIRTUAL_ORIGIN) {
      return;
    }
    const urlPath = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    const pathname = parsed.pathname;

    // 1. If a backend is present and this route belongs to SSR/PHP/virtual folder scripts, render via BackendTransport
    const isStaticFrontendHtml = (() => {
      const candidate = archive.resolveFrontendPath(pathname, archive.manifest.main);
      return Boolean(candidate && /\.html?$/i.test(candidate) && archive.has(candidate));
    })();

    const wantsBackend =
      Boolean(backendTransport) &&
      (Boolean(archive.manifest.ssrEntry) ||
        /\.(?:php|phtml)$/i.test(pathname) ||
        (!isStaticFrontendHtml &&
          Boolean(
            matchBackendTarget(parsed.href, backendRouting, {
              baseUrl: base,
              method: 'GET',
              isStaticVfsFile: (p) => archive.has(p),
            })
          )));

    if (wantsBackend && backendTransport) {
      const { finalUrlPath, html } = await fetchSsrDocument('GET', `${parsed.pathname}${parsed.search}`);
      if (disposed || !owns() || seq !== navSeq) return;
      const fullFinalUrl = parsed.hash && !finalUrlPath.includes('#') ? `${finalUrlPath}${parsed.hash}` : finalUrlPath;
      recordHistory(fullFinalUrl, pushHistory);
      const basePathForAssets = fullFinalUrl.split(/[?#]/)[0].replace(/^\/+/, '') || 'index.html';
      await mountPage(basePathForAssets, html, fullFinalUrl);
      return;
    }

    // 2. Static HTML page inside the archive (strictly frontend HTML, never backend/config/JS)
    const resolved = archive.resolveFrontendPath(pathname, archive.manifest.main);
    if (!resolved || !/\.html?$/i.test(resolved) || !archive.isFrontendPath(resolved) || !archive.has(resolved)) {
      throw new Error(`Cannot navigate to missing container page: ${rawTarget}`);
    }
    if (disposed || !owns() || seq !== navSeq) return;
    recordHistory(urlPath, pushHistory);
    await mountPage(resolved, undefined, urlPath);
  };

  const submitForm = async (req: { action: string; method: string; encoded: string }): Promise<void> => {
    if (!backendTransport) return;
    const seq = ++navSeq;
    const base = `${VIRTUAL_ORIGIN}${currentUrlPath.startsWith('/') ? currentUrlPath : `/${currentUrlPath}`}`;
    const actionUrl = new URL(req.action || currentUrlPath, base);
    if (actionUrl.origin !== VIRTUAL_ORIGIN) return;
    if (req.method === 'GET') {
      if (req.encoded) {
        actionUrl.search = actionUrl.search ? `${actionUrl.search}&${req.encoded}` : `?${req.encoded}`;
      }
      await navigateTo(`${actionUrl.pathname}${actionUrl.search}`, true);
      return;
    }
    const { finalUrlPath, html } = await fetchSsrDocument(req.method, `${actionUrl.pathname}${actionUrl.search}`, req.encoded);
    if (disposed || !owns() || seq !== navSeq) return;
    recordHistory(finalUrlPath, true);
    const basePathForAssets = finalUrlPath.split(/[?#]/)[0].replace(/^\/+/, '') || 'index.html';
    await mountPage(basePathForAssets, html, finalUrlPath);
  };

  // An app can follow a link while its first worker is still starting. Its caller
  // should wait for the replacement page, even when the original worker never replies.
  let pendingPage: ((replacement?: Promise<void>) => void) | undefined;
  const mountPage = (pagePath: string, overrideHtml?: string, virtualUrlPath?: string): Promise<void> => {
    const previous = pendingPage;
    pendingPage = undefined;
    const next = loadPage(pagePath, overrideHtml, virtualUrlPath);
    previous?.(next);
    return next;
  };

  const loadPage = async (pagePath: string, overrideHtml?: string, virtualUrlPath?: string): Promise<void> => {
    // A mount the element no longer shows draws nothing: the root is the newer mount's.
    if (disposed || !owns()) return;
    teardownPage();
    // The page before, and the bars that were about it (preserving persistent virtual-nav bar).
    pageRoot.replaceChildren();
    for (const bar of Array.from(frameEl.children)) if (bar !== boxEl && bar !== navEl) bar.remove();
    saveEl = null;
    if (frameEl.parentNode !== shadowRoot) shadowRoot.replaceChildren(frameStyle, frameEl);

    if (overrideHtml === undefined && !archive.isFrontendPath(pagePath)) {
      throw new Error(`Page "${pagePath}" is outside the frontend sandbox`);
    }
    const html = overrideHtml !== undefined ? overrideHtml : archive.readText(pagePath);
    if (html === null) {
      throw new Error(`Page "${pagePath}" not found in .softn container`);
    }

    /**
     * The app stopped after it had started: said on the page, above its box, with a way to
     * start this page of it again. Once, however many ways the stop is heard of.
     */
    const showStopped = (reason: string) => {
      // The session is over: what it held across tabs is let go of (once what it wrote is
      // kept), and what comes for it goes nowhere. (A stopped app kept its databases held, and
      // the same app in every other tab waited for them for good.)
      clearRaf();
      clearInitWatchdog();
      idbHoldEpoch++;
      idbHoldsAsked = 0;
      for (const release of idbHolds.values()) void idbWriting.then(release, release);
      idbHolds.clear();
      for (const wd of pendingWatchdogs.values()) clearTimeout(wd);
      pendingWatchdogs.clear();
      pendingAnswers.clear();
      inFlightCoalesced.clear();
      pendingCoalesced.clear();
      wheelInFlightTurnId = null;
      pendingWheel = null;
      for (const ws of backendSockets.values()) {
        try { ws.close(1001, 'container stopped'); } catch { /* ignore */ }
      }
      backendSockets.clear();
      currentTransport?.terminate();
      currentTransport = null;
      if (disposed || !owns() || Array.from(frameEl.children).some((el) => el.hasAttribute('data-softn-container-stopped'))) return;
      const holder = document.createElement('div');
      holder.setAttribute('data-softn-container-stopped', '');
      holder.style.cssText = CONSENT_STYLE;
      holder.attachShadow({ mode: 'closed' }).appendChild(
        renderStoppedBar(hostLabel(archive.manifest.name) || 'This app', reason, () => {
          holder.remove();
          const restart = overrideHtml !== undefined
            ? navigateTo(currentUrlPath, false)
            : mountPage(pagePath, undefined, virtualUrlPath);
          void restart.catch((err) => options.onError?.(err instanceof Error ? err : new Error(String(err))));
        })
      );
      frameEl.insertBefore(holder, boxEl);
    };
    onSessionStopped = showStopped;

    const fontScope: FontScopeContext = {
      prefix: `softn-f-${++fontScopeSeq}-`,
      families: new Set<string>(),
    };
    const prepared = prepareHtmlDocument(
      html,
      pagePath,
      archive,
      permissions,
      grantedCaps.has('net'),
      fontScope
    );
    if (virtualUrlPath !== undefined) {
      const cleanVirtual = virtualUrlPath.startsWith('/') ? virtualUrlPath : `/${virtualUrlPath}`;
      prepared.seed.url = `${VIRTUAL_ORIGIN}${cleanVirtual}`;
    }

    const { textFiles, binaryFiles } = archive.exportWorkerVfs();
    activeTier = selectEngineTier(prepared.scripts, textFiles, archive.manifest.pythonPackages);

    // Resolve theme (`options.theme` -> `manifest.theme` -> system)
    const effectiveTheme =
      options.theme && options.theme !== 'auto'
        ? options.theme
        : archive.manifest.theme && archive.manifest.theme !== 'auto'
          ? archive.manifest.theme
          : typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
            ? 'dark'
            : 'light';

    // The page's styles, in the page's root.
    const styleEl = document.createElement('style');
    styleEl.textContent = [PAGE_BASE_CSS, ...prepared.styles].join('\n');
    pageRoot.appendChild(styleEl);

    // Non-blocking consent bar when capabilities are requested in `'prompt'` mode. It is
    // above the app's box, in the frame's root and in a shadow root of its own.
    const permissionMode = options.permissionMode ?? 'prompt';
    if (permissionMode === 'prompt' && !consentDenied && requestedCaps.some((cap) => !grantedCaps.has(cap))) {
      const bar = renderConsentBar(requestedCaps, hostLabel(archive.manifest.name) || 'This app', (allowed) => {
        if (allowed) {
          grantedCaps = new Set(requestedCaps);
          currentPatcher?.updatePermissions(permissions, grantedCaps.has('net'), grantedCaps.has('files'));
          currentTransport?.post({
            type: 'permissions-updated',
            grantedCapabilities: [...grantedCaps],
          });
        } else {
          consentDenied = true;
        }
      }, (permissions.permissions?.net?.allowed_hosts ?? []).filter((host): host is string => typeof host === 'string'));
      const consentEl = document.createElement('div');
      consentEl.setAttribute('data-softn-container-consent', '');
      consentEl.style.cssText = CONSENT_STYLE;
      consentEl.attachShadow({ mode: 'closed' }).appendChild(bar);
      frameEl.insertBefore(consentEl, boxEl);
    }

    const docRootEl = document.createElement('div');
    docRootEl.setAttribute('data-softn-docroot', '');
    docRootEl.style.cssText = DOCROOT_STYLE;

    // What the app's script puts in its <head>: its stylesheets apply from here, and nothing
    // in it is drawn, as nothing in a document's head is.
    const headEl = document.createElement('div');
    headEl.setAttribute('data-softn-head', '');
    headEl.hidden = true;
    headEl.style.cssText = 'display:none !important';
    docRootEl.appendChild(headEl);

    const viewportEl = document.createElement('div');
    viewportEl.setAttribute('data-softn-viewport', '');
    if (prepared.usesSoftnUiCss) {
      viewportEl.setAttribute('data-theme', effectiveTheme);
    }
    docRootEl.appendChild(viewportEl);
    pageRoot.appendChild(docRootEl);

    let lastBoxW = -1;
    let lastBoxH = -1;
    const syncViewportCssVars = () => {
      const w = boxEl.clientWidth;
      const h = boxEl.clientHeight;
      if (Math.abs(w - lastBoxW) < 0.5 && Math.abs(h - lastBoxH) < 0.5) return;
      lastBoxW = w;
      lastBoxH = h;
      if (w > 0) docRootEl.style.setProperty('--softn-vw', `${w / 100}px`);
      else docRootEl.style.removeProperty('--softn-vw');
      if (h > 0) docRootEl.style.setProperty('--softn-vh', `${h / 100}px`);
      else docRootEl.style.removeProperty('--softn-vh');
    };
    syncViewportCssVars();
    if (typeof ResizeObserver === 'function') {
      viewportResizeObserver = new ResizeObserver(syncViewportCssVars);
      viewportResizeObserver.observe(boxEl);
    }
    if (prepared.seed.v) {
      if (boxEl.clientWidth > 0) prepared.seed.v[0] = boxEl.clientWidth;
      if (boxEl.clientHeight > 0) prepared.seed.v[1] = boxEl.clientHeight;
    }

    const staticFontFaces = prepared.styles.map((s) => extractSanitizedFontFaces(s, fontScope.prefix)).filter(Boolean).join('\n');
    const syncHostFonts = () => {
      if (disposed || typeof document === 'undefined' || !document.head) return;
      const parts: string[] = [];
      if (staticFontFaces) parts.push(staticFontFaces);
      for (const css of dynamicFontSheets.values()) {
        if (css) parts.push(css);
      }
      const combined = parts.join('\n');
      if (!combined) {
        hostFontStyleEl?.remove();
        hostFontStyleEl = null;
        return;
      }
      if (!hostFontStyleEl) {
        hostFontStyleEl = document.createElement('style');
        hostFontStyleEl.setAttribute('data-softn-fonts', appId);
        document.head.appendChild(hostFontStyleEl);
      }
      if (hostFontStyleEl.textContent !== combined) {
        hostFontStyleEl.textContent = combined;
      }
    };
    syncHostFonts();

    const handleThreeOps = async (
      canvas: HTMLCanvasElement,
      canvasId: number,
      ops: ThreeSceneOp[]
    ) => {
      let host = threeHost;
      if (!host) {
        if (!threeHostPromise) {
          threeHostPromise = import('./vendor/webgl-scene-host')
            .then(({ SplitRealmSceneHost: HostCtor }) => {
              if (disposed || !owns() || currentPatcher !== patcher) return null;
              threeHost = new HostCtor(archive, runtimeUrl, options.hostThree);
              return threeHost;
            })
            .catch((err) => {
              threeHostPromise = null;
              throw err;
            });
        }
        host = await threeHostPromise;
      }
      if (!host || disposed || !owns() || currentPatcher !== patcher) return;
      host.enqueue(canvas, canvasId, ops);
    };

    /** A file the app asked to save is before the person (or the host), unanswered. */
    let saveAsked = false;
    const patcher = new HostDomPatcher({
      viewportEl,
      docRootEl,
      headEl,
      archive,
      entryPath: pagePath,
      permissions,
      netGranted: grantedCaps.has('net'),
      filesGranted: grantedCaps.has('files'),
      fontScope,
      callbacks: {
        onStyleFonts: (sheet, fontFacesCss) => {
          const MAX_DYNAMIC_FONT_BYTES = 512 * 1024;
          if (fontFacesCss && fontFacesCss.length <= MAX_DYNAMIC_FONT_BYTES) {
            let totalFontBytes = 0;
            for (const [k, css] of dynamicFontSheets) {
              if (k !== sheet) totalFontBytes += css.length;
            }
            while (
              (dynamicFontSheets.size >= 64 && !dynamicFontSheets.has(sheet)) ||
              (dynamicFontSheets.size > 0 && totalFontBytes + fontFacesCss.length > MAX_DYNAMIC_FONT_BYTES)
            ) {
              const oldest = dynamicFontSheets.keys().next().value;
              if (oldest === undefined || oldest === sheet) break;
              totalFontBytes -= dynamicFontSheets.get(oldest)?.length ?? 0;
              dynamicFontSheets.delete(oldest);
            }
            if (totalFontBytes + fontFacesCss.length <= MAX_DYNAMIC_FONT_BYTES) {
              dynamicFontSheets.set(sheet, fontFacesCss);
            }
          } else {
            dynamicFontSheets.delete(sheet);
          }
          syncHostFonts();
        },
        onSaveRequest: (file) => {
          // One question at a time: a file asked for while another is unanswered is not
          // saved and takes no one's place. (The later one took the place of the earlier, so
          // the bar a person was about to answer could change its file under their pointer.)
          if (disposed || options.downloads === 'deny' || saveAsked) return;
          const request: SaveRequest = { name: hostFileName(file.name), type: file.type, size: file.bytes.byteLength, bytes: file.bytes };
          saveAsked = true;
          // A host that asks the person itself is asked; the file is saved at its yes.
          if (options.onSaveRequest) {
            const ask = options.onSaveRequest;
            void Promise.resolve()
              .then(() => ask(request))
              .then(
                (yes) => {
                  saveAsked = false;
                  if (yes === true && !disposed) saveToDisk(request);
                },
                () => {
                  saveAsked = false;
                }
              );
            return;
          }
          // The container's own bar, above the app's box and out of its stylesheet's reach: it
          // names the app and the file.
          const holder = document.createElement('div');
          holder.setAttribute('data-softn-container-save', '');
          holder.style.cssText = CONSENT_STYLE;
          holder.attachShadow({ mode: 'closed' }).appendChild(
            renderSaveBar(hostLabel(archive.manifest.name) || 'This app', request.name, request.size, (save) => {
              holder.remove();
              if (saveEl === holder) saveEl = null;
              saveAsked = false;
              if (save && !disposed) saveToDisk(request);
            })
          );
          frameEl.insertBefore(holder, boxEl);
          saveEl = holder;
        },
        onEvent: (nodeId, eventType, props, syncChanges, answered) => {
          const dispatchEventNow = (
            nid: number,
            etype: string,
            eprops: Record<string, unknown>,
            esync: unknown[],
            eans?: (eventBits: number) => void
          ): number => {
            const tid = turnSeq++;
            if (eans) pendingAnswers.set(tid, eans);
            if (useWorkerIsolation) {
              const wd = setTimeout(() => {
                pendingWatchdogs.delete(tid);
                currentTransport?.terminate();
                options.onError?.(
                  new Error(`Container terminated: event "${etype}" exceeded ${limits.turnTimeoutMs}ms time limit`)
                );
                showStopped(`its script took more than ${Math.round(limits.turnTimeoutMs / 1000)} seconds to answer a ${etype} and did not finish.`);
              }, limits.turnTimeoutMs);
              pendingWatchdogs.set(tid, wd);
            }
            currentTransport?.post({
              type: 'event',
              turnId: tid,
              nodeId: nid,
              eventType: etype,
              props: eprops,
              syncChanges: esync,
            });
            return tid;
          };

          if (useWorkerIsolation && !answered) {
            if (eventType === 'wheel') {
              if (wheelInFlightTurnId !== null) {
                if (pendingWheel) {
                  pendingWheel.nodeId = nodeId;
                  pendingWheel.syncChanges = syncChanges;
                  const nextProps = { ...props };
                  nextProps.deltaX = (Number(pendingWheel.props.deltaX) || 0) + (Number(props.deltaX) || 0);
                  nextProps.deltaY = (Number(pendingWheel.props.deltaY) || 0) + (Number(props.deltaY) || 0);
                  nextProps.deltaZ = (Number(pendingWheel.props.deltaZ) || 0) + (Number(props.deltaZ) || 0);
                  pendingWheel.props = nextProps;
                } else {
                  pendingWheel = { nodeId, eventType, props: { ...props }, syncChanges };
                }
                return;
              }
              wheelInFlightTurnId = dispatchEventNow(nodeId, eventType, props, syncChanges);
              return;
            }
            if (COALESCE_MOVE_EVENTS.has(eventType)) {
              if (inFlightCoalesced.has(eventType)) {
                pendingCoalesced.set(eventType, { nodeId, eventType, props, syncChanges });
                return;
              }
              const tid = dispatchEventNow(nodeId, eventType, props, syncChanges);
              inFlightCoalesced.set(eventType, tid);
              return;
            }
            if (DISCRETE_POINTER_EVENTS.has(eventType)) {
              const pm = pendingCoalesced.get('pointermove');
              if (pm) {
                pendingCoalesced.delete('pointermove');
                const pmTid = dispatchEventNow(pm.nodeId, pm.eventType, pm.props, pm.syncChanges);
                inFlightCoalesced.set('pointermove', pmTid);
              }
            }
          }
          dispatchEventNow(nodeId, eventType, props, syncChanges, answered);
        },
        onSync: (changes) => {
          currentTransport?.post({ type: 'sync', changes });
        },
        onTitleChange: (title) => {
          options.onTitleChange?.(title);
        },
        onExternalLink: options.onExternalLink,
        onNavigate: (href) => {
          void navigateTo(href, true).catch((err) => options.onError?.(err instanceof Error ? err : new Error(String(err))));
        },
        onFormSubmit: backendTransport
          ? (req) => {
              void submitForm(req).catch((err) => options.onError?.(err instanceof Error ? err : new Error(String(err))));
            }
          : undefined,
        onCustomTag: (tag) => {
          void ensureUiExtension(tag, runtimeUrl);
        },
        onThreeOps: (canvas, canvasId, ops) => {
          void handleThreeOps(canvas, canvasId, ops);
        },
        // What the page could not do for the app, in its console with what it prints.
        onWarning: (text) => {
          if (owns()) options.onConsole?.('warn', text);
        },
      },
    });
    currentPatcher = patcher;

    const initialTags = prepared.mountInitialDom(viewportEl, patcher.nodes, docRootEl);
    patcher.adoptReadableImages(viewportEl);
    for (const tag of initialTags) {
      void ensureUiExtension(tag, runtimeUrl);
    }

    // Boot Worker (or inline session when `isolation: 'inline'` or `Worker` is absent in JSDOM)
    await new Promise<void>((resolveReady, rejectReady) => {
      let settledReady = false;
      pendingPage = resolveReady;

      const replyToRequest = async (msg: Extract<WorkerToHostMsg, { type: 'host-request' }>) => {
        const transport = currentTransport;
        if (!transport || currentPatcher !== patcher || !owns()) return;
        const { action, input } = msg.payload;
        let result: unknown;
        try {
          if (msg.kind !== 'backend.call' || !options.backendCall) throw new Error('This app has no connected backend.');
          // FormLogic's native JSON route accepts up to 6 MiB; sandboxed file uploads accept up to 25 MiB binary (~34 MiB base64).
          const limit =
            action === 'formlogicUpload'
              ? 35 * 1024 * 1024
              : action === 'nativeRequest'
                ? 6 * 1024 * 1024
                : 32768;
          if (typeof action !== 'string' || !/^[a-z][a-zA-Z0-9_-]{0,63}$/.test(action) || typeof input !== 'string' || input.length > limit) {
            throw new Error('Invalid backend request.');
          }
          const args: unknown = JSON.parse(input);
          if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Backend input must be an object.');
          result = await options.backendCall(action, args as Record<string, unknown>);
        } catch (error) {
          result = { error: error instanceof Error ? error.message : 'Backend request failed.' };
        }
        if (!disposed && owns() && currentTransport === transport) {
          transport.post({ type: 'host-reply', requestId: msg.requestId, ok: true, result });
        }
      };

      const onWorkerMessage = (msg: WorkerToHostMsg) => {
        if (disposed || !owns() || currentPatcher !== patcher) {
          if (msg.type === 'webgl-frame') {
            try { msg.bitmap.close(); } catch { /* ignore */ }
          }
          resolveReady();
          return;
        }
        switch (msg.type) {
          case 'ready':
            clearInitWatchdog();
            if (!settledReady) {
              settledReady = true;
              pendingPage = undefined;
              emitStatus({
                phase: 'ready',
                message: 'Ready',
                percent: 100,
              });
              resolveReady();
            }
            break;

          case 'ops':
            if (msg.rafReply) {
              rafInFlight = false;
              clearRafWatchdog();
            }
            if (msg.turnId !== undefined) {
              const wd = pendingWatchdogs.get(msg.turnId);
              if (wd) {
                clearTimeout(wd);
                pendingWatchdogs.delete(msg.turnId);
              }
              if (msg.turnId === wheelInFlightTurnId) {
                wheelInFlightTurnId = null;
                if (pendingWheel && !disposed) {
                  const nextW = pendingWheel;
                  pendingWheel = null;
                  const nextTid = turnSeq++;
                  if (useWorkerIsolation) {
                    const nwd = setTimeout(() => {
                      pendingWatchdogs.delete(nextTid);
                      currentTransport?.terminate();
                      options.onError?.(new Error(`Container terminated: event "wheel" exceeded ${limits.turnTimeoutMs}ms time limit`));
                      showStopped(`its script took more than ${Math.round(limits.turnTimeoutMs / 1000)} seconds to answer a wheel and did not finish.`);
                    }, limits.turnTimeoutMs);
                    pendingWatchdogs.set(nextTid, nwd);
                  }
                  wheelInFlightTurnId = nextTid;
                  currentTransport?.post({
                    type: 'event',
                    turnId: nextTid,
                    nodeId: nextW.nodeId,
                    eventType: nextW.eventType,
                    props: nextW.props,
                    syncChanges: nextW.syncChanges,
                  });
                }
              } else {
                for (const [evKey, inflightTid] of inFlightCoalesced) {
                  if (inflightTid === msg.turnId) {
                    inFlightCoalesced.delete(evKey);
                    const nextEv = pendingCoalesced.get(evKey);
                    if (nextEv && !disposed) {
                      pendingCoalesced.delete(evKey);
                      const nextTid = turnSeq++;
                      if (useWorkerIsolation) {
                        const nwd = setTimeout(() => {
                          pendingWatchdogs.delete(nextTid);
                          currentTransport?.terminate();
                          options.onError?.(new Error(`Container terminated: event "${nextEv.eventType}" exceeded ${limits.turnTimeoutMs}ms time limit`));
                          showStopped(`its script took more than ${Math.round(limits.turnTimeoutMs / 1000)} seconds to answer a ${nextEv.eventType} and did not finish.`);
                        }, limits.turnTimeoutMs);
                        pendingWatchdogs.set(nextTid, nwd);
                      }
                      inFlightCoalesced.set(evKey, nextTid);
                      currentTransport?.post({
                        type: 'event',
                        turnId: nextTid,
                        nodeId: nextEv.nodeId,
                        eventType: nextEv.eventType,
                        props: nextEv.props,
                        syncChanges: nextEv.syncChanges,
                      });
                    }
                    break;
                  }
                }
              }
            }
            if (msg.ops.length > 0) {
              patcher.applyOps(msg.ops);
            }
            if (msg.wantsRaf || (!rafInFlight && rafWantedWhileInFlight)) {
              rafWantedWhileInFlight = false;
              scheduleNextRaf();
            }
            // Whoever waited for the script's answer to this event has it now, after what
            // the script drew in answering.
            if (msg.turnId !== undefined) {
              const answered = pendingAnswers.get(msg.turnId);
              if (answered) {
                pendingAnswers.delete(msg.turnId);
                answered(typeof msg.eventBits === 'number' ? msg.eventBits : 0);
              }
            }
            break;

          case 'webgl-frame':
            patcher.presentWebGLFrame(msg.canvasId, msg.bitmap, msg.width, msg.height);
            break;

          case 'session-route':
            if (isSafeVirtualRoute(msg.urlPath)) {
              currentUrlPath = msg.urlPath;
              updateNavUi();
              liveSession.urlPath = msg.urlPath;
              persistSessionSoon();
            }
            break;

          case 'session-storage-write':
            if (!persistStorage) break;
            if (msg.op === 'set' && typeof msg.key === 'string' && typeof msg.value === 'string' && !BLOCKED_SESSION_KEYS.has(msg.key)) {
              const oldVal = Object.prototype.hasOwnProperty.call(liveSession.sessionStorage, msg.key)
                ? liveSession.sessionStorage[msg.key]
                : null;
              const replaced = oldVal !== null ? (msg.key.length + oldVal.length) * 2 : 0;
              const nextTotal = liveSessionStorageBytes - replaced + (msg.key.length + msg.value.length) * 2;
              if (nextTotal <= limits.storageQuotaBytes) {
                liveSession.sessionStorage[msg.key] = msg.value;
                liveSessionStorageBytes = nextTotal;
                persistSessionSoon();
              }
            } else if (msg.op === 'remove' && typeof msg.key === 'string' && !BLOCKED_SESSION_KEYS.has(msg.key)) {
              const oldVal = Object.prototype.hasOwnProperty.call(liveSession.sessionStorage, msg.key)
                ? liveSession.sessionStorage[msg.key]
                : null;
              if (oldVal !== null) {
                liveSessionStorageBytes = Math.max(0, liveSessionStorageBytes - (msg.key.length + oldVal.length) * 2);
              }
              delete liveSession.sessionStorage[msg.key];
              persistSessionSoon();
            } else if (msg.op === 'clear') {
              liveSession.sessionStorage = Object.create(null) as Record<string, string>;
              liveSessionStorageBytes = 0;
              persistSessionSoon();
            }
            break;

          case 'console':
            if (options.onConsole) {
              options.onConsole(msg.level, msg.text);
            } else if (msg.level === 'error') {
              console.error(`[${archive.manifest.name}]`, msg.text);
            } else {
              console.warn(`[${archive.manifest.name}]`, msg.text);
            }
            break;

          case 'storage-write':
            if (!persistStorage || !owns() || currentPatcher !== patcher) break;
            // A value that would take what the app keeps past its quota is not kept: the
            // Worker refuses it first, and this holds whatever the Worker sends.
            {
              let oldStorageBytes = 0;
              if (msg.op === 'set') {
                if (typeof msg.key !== 'string' || typeof msg.value !== 'string') break;
                if (storage) {
                  try {
                    const prev = storage.getItem(`${storageBase}ls:${msg.key}`);
                    if (prev !== null) oldStorageBytes = (msg.key.length + prev.length) * 2;
                  } catch {
                    oldStorageBytes = 0;
                  }
                  if (cachedPersistedBytes === null) {
                    cachedPersistedBytes = persistedTotalBytes(storageBase, storage);
                  }
                  const nextTotal = cachedPersistedBytes - oldStorageBytes + (msg.key.length + msg.value.length) * 2;
                  if (nextTotal > limits.storageQuotaBytes) break;
                }
              } else if (msg.op === 'remove' && typeof msg.key === 'string' && storage && cachedPersistedBytes !== null) {
                try {
                  const prev = storage.getItem(`${storageBase}ls:${msg.key}`);
                  if (prev !== null) oldStorageBytes = (msg.key.length + prev.length) * 2;
                } catch {
                  cachedPersistedBytes = null;
                }
              }
              const changed = msg.op === 'clear' ? persistedStorageKeys(storageBase, storage) : typeof msg.key === 'string' ? [`${storageBase}ls:${msg.key}`] : [];
              const kept = applyPersistedStorageOp(storageBase, msg.op, msg.key, msg.value, storage);
              storageKept(kept);
              if (kept && storage) {
                if (msg.op === 'set' && typeof msg.key === 'string' && typeof msg.value === 'string' && cachedPersistedBytes !== null) {
                  cachedPersistedBytes = Math.max(0, cachedPersistedBytes - oldStorageBytes + (msg.key.length + msg.value.length) * 2);
                } else if (msg.op === 'remove' && cachedPersistedBytes !== null) {
                  cachedPersistedBytes = Math.max(0, cachedPersistedBytes - oldStorageBytes);
                } else if (msg.op === 'clear') {
                  cachedPersistedBytes = null;
                }
              } else if (!kept) {
                cachedPersistedBytes = null;
              }
              if (kept || !storage) {
                if (msg.op === 'set' && typeof msg.key === 'string' && typeof msg.value === 'string') {
                  const oldVal = Object.prototype.hasOwnProperty.call(liveSession.localStorage, msg.key)
                    ? liveSession.localStorage[msg.key]
                    : null;
                  const replaced = oldVal !== null ? (msg.key.length + oldVal.length) * 2 : 0;
                  const nextLiveBytes = liveLocalStorageBytes - replaced + (msg.key.length + msg.value.length) * 2;
                  if (!storage && nextLiveBytes > limits.storageQuotaBytes) break;
                  // liveSession.localStorage uses Object.create(null), so keys like '__proto__' are safe data properties.
                  liveSession.localStorage[msg.key] = msg.value;
                  liveLocalStorageBytes = nextLiveBytes;
                  persistSessionSoon();
                } else if (msg.op === 'remove' && typeof msg.key === 'string') {
                  const oldVal = Object.prototype.hasOwnProperty.call(liveSession.localStorage, msg.key)
                    ? liveSession.localStorage[msg.key]
                    : null;
                  if (oldVal !== null) {
                    liveLocalStorageBytes = Math.max(0, liveLocalStorageBytes - (msg.key.length + oldVal.length) * 2);
                  }
                  delete liveSession.localStorage[msg.key];
                  persistSessionSoon();
                } else if (msg.op === 'clear') {
                  liveSession.localStorage = Object.create(null) as Record<string, string>;
                  liveLocalStorageBytes = 0;
                  persistSessionSoon();
                }
              }
              if (kept) tellNeighbours(storageBase, heard, changed);
            }
            break;

          case 'db-write':
            // Its records take what its localStorage has left of the one quota.
            if (persistStorage && owns() && currentPatcher === patcher) {
              cachedPersistedBytes = null;
              storageKept(savePersistedDbCollection(storageBase, msg.collection, msg.records, limits.storageQuotaBytes - persistedStorageBytes(storageBase, storage) - persistedIdbBytes(storageBase, storage), storage));
            }
            break;

          case 'idb-writes': {
            // Answered to the session that sent them: a transaction is complete once they are kept.
            const sender = currentTransport;
            const batch = msg.id;
            void (persistStorage ? keepIdbParts(msg.parts) : Promise.resolve(true)).then((ok) => {
              if (!disposed && sender && currentTransport === sender) sender.post({ type: 'idb-kept', id: batch, ok });
            });
            break;
          }

          case 'idb-hold':
            holdIdb(msg.id, msg.name);
            break;

          case 'idb-release':
            releaseIdb(msg.name);
            break;

          case 'host-request': {
            if (msg.kind === 'backend.call') {
              void replyToRequest(msg);
              break;
            }
            const sender = currentTransport;
            const requestId = msg.requestId;
            const reply = (ok: boolean, result?: unknown, error?: string) => {
              if (!disposed && sender && currentTransport === sender) {
                sender.post({ type: 'host-reply', requestId, ok, ...(ok ? { result } : { error }) });
              }
            };
            if (msg.kind === 'backend.fetch') {
              if (!backendTransport) {
                reply(false, undefined, 'No backend transport is configured for this container');
                break;
              }
              const payload = msg.payload ?? {};
              if (typeof payload.bodyBase64 === 'string' && payload.bodyBase64.length > MAX_BACKEND_FETCH_BODY_B64) {
                reply(false, undefined, 'Backend request body exceeds maximum size limit');
                break;
              }
              let bodyBytes: Uint8Array | undefined;
              try {
                bodyBytes =
                  typeof payload.bodyBase64 === 'string' && payload.bodyBase64.length > 0
                    ? base64ToBytes(payload.bodyBase64)
                    : undefined;
              } catch {
                reply(false, undefined, 'Invalid base64 request body');
                break;
              }
              const rawHeaders: Record<string, string> = {};
              if (payload.headers && typeof payload.headers === 'object') {
                for (const [k, v] of Object.entries(payload.headers as Record<string, unknown>)) {
                  rawHeaders[k] = String(v);
                }
              }
              void backendTransport
                .fetch({
                  method: String(payload.method ?? 'GET'),
                  path: String(payload.path ?? '/'),
                  query: String(payload.query ?? ''),
                  headers: rawHeaders,
                  body: bodyBytes,
                })
                .then(
                  (resp) => {
                    const hdrObj: Record<string, string> = {};
                    for (const [k, v] of resp.headers) {
                      const lower = k.toLowerCase();
                      // Fetch spec hides Set-Cookie from JS-visible Response.headers;
                      // VirtualCookieJar already captured it on BackendTransport.
                      if (lower === 'set-cookie') continue;
                      hdrObj[lower] = lower in hdrObj ? `${hdrObj[lower]}, ${v}` : v;
                    }
                    reply(true, {
                      ok: resp.status >= 200 && resp.status < 300,
                      status: resp.status,
                      statusText: resp.statusText,
                      headers: hdrObj,
                      base64: resp.body.byteLength > 0 ? bytesToBase64(resp.body) : '',
                    });
                  },
                  (err) => reply(false, undefined, err instanceof Error ? err.message : String(err))
                );
              break;
            }
            if (msg.kind === 'backend.ws.open') {
              const id = String(msg.payload?.id ?? '');
              const wsPath = String(msg.payload?.path ?? '/ws');
              const protocols = Array.isArray(msg.payload?.protocols)
                ? (msg.payload.protocols as unknown[]).map((p) => String(p))
                : [];
              if (!id || backendSockets.has(id) || backendSockets.size >= MAX_BACKEND_SOCKETS) {
                const errMsg = !id
                  ? 'Missing WebSocket id'
                  : backendSockets.has(id)
                    ? 'Duplicate backend WebSocket id'
                    : 'Too many open backend WebSockets';
                if (!disposed && sender && currentTransport === sender) {
                  sender.post({ type: 'ws-event', id, event: { type: 'error', message: errMsg } });
                  sender.post({ type: 'ws-event', id, event: { type: 'close', code: 1008, reason: errMsg, wasClean: false } });
                }
                reply(false, undefined, errMsg);
                break;
              }
              if (backendTransport?.openWebSocket) {
                let closedSync = false;
                try {
                  const handle = backendTransport.openWebSocket(wsPath, protocols, (event) => {
                    if (event.type === 'close') {
                      closedSync = true;
                      backendSockets.delete(id);
                    }
                    if (!disposed && sender && currentTransport === sender) {
                      sender.post({ type: 'ws-event', id, event });
                    }
                  });
                  if (!closedSync) {
                    backendSockets.set(id, handle);
                  }
                } catch (err) {
                  const errMsg = err instanceof Error ? err.message : String(err);
                  if (!disposed && sender && currentTransport === sender) {
                    sender.post({ type: 'ws-event', id, event: { type: 'error', message: errMsg } });
                    sender.post({ type: 'ws-event', id, event: { type: 'close', code: 1006, reason: errMsg, wasClean: false } });
                  }
                  reply(false, undefined, errMsg);
                  break;
                }
              } else if (!disposed && sender && currentTransport === sender) {
                sender.post({ type: 'ws-event', id, event: { type: 'error', message: 'Backend transport does not support WebSockets' } });
                sender.post({ type: 'ws-event', id, event: { type: 'close', code: 1006, reason: 'WebSockets unsupported by backend transport', wasClean: false } });
              }
              reply(true, { ok: true });
              break;
            }
            if (msg.kind === 'backend.ws.send') {
              const id = String(msg.payload?.id ?? '');
              const handle = backendSockets.get(id);
              if (handle) {
                const isBin = Boolean(msg.payload?.binary);
                const data = String(msg.payload?.data ?? '');
                const maxLen = isBin ? MAX_BACKEND_WS_B64_CHARS : MAX_BACKEND_WS_TEXT_CHARS;
                if (data.length > maxLen) {
                  reply(false, undefined, 'WebSocket message exceeds maximum size limit');
                  break;
                }
                try {
                  handle.send(isBin ? base64ToBytes(data) : data);
                } catch (err) {
                  reply(false, undefined, err instanceof Error ? err.message : String(err));
                  break;
                }
              }
              reply(true, { ok: true });
              break;
            }
            if (msg.kind === 'backend.ws.close') {
              const id = String(msg.payload?.id ?? '');
              const handle = backendSockets.get(id);
              if (handle) {
                backendSockets.delete(id);
                try {
                  handle.close(
                    typeof msg.payload?.code === 'number' ? msg.payload.code : 1000,
                    typeof msg.payload?.reason === 'string' ? msg.payload.reason : ''
                  );
                } catch {
                  // Ignore close error on already-closed transport
                }
              }
              reply(true, { ok: true });
              break;
            }
            if (msg.kind === 'sqlite.op') {
              // Frontend direct SQLite access (`softn:sqlite`) is only permitted when no backend
              // owns the database; otherwise untrusted frontend JS would bypass backend isolation.
              const allowFrontendSqlite = !archive.manifest.backend && !options.backendTransport && !options.backendUrl;
              if (!allowFrontendSqlite) {
                reply(false, undefined, 'Direct frontend SQLite access is disabled when a backend is configured');
                break;
              }
              const op = String(msg.payload?.op ?? '') as 'open' | 'query' | 'execute' | 'close' | 'seed_json';
              const opArgs = Array.isArray(msg.payload?.args) ? msg.payload.args : [];
              void ensureLocalSqliteTransport()
                .then((transport) => transport.sqliteOp(op, opArgs))
                .then(
                  (res) => reply(true, res),
                  (err) => reply(false, undefined, err instanceof Error ? err.message : String(err))
                );
              break;
            }
            if (msg.kind === 'device.call') {
              const namespace = String(msg.payload?.namespace ?? '');
              const method = String(msg.payload?.method ?? '');
              const params =
                msg.payload?.params && typeof msg.payload.params === 'object' && !Array.isArray(msg.payload.params)
                  ? (msg.payload.params as Record<string, unknown>)
                  : {};
              if (namespace === 'device' && (method === 'clipboardWrite' || method === 'share')) {
                const pendingConsent =
                  permissionMode === 'prompt' &&
                  !consentDenied &&
                  requestedCaps.some((cap) => !grantedCaps.has(cap));
                if (pendingConsent || !currentPatcher?.consumeActivation()) {
                  reply(
                    false,
                    undefined,
                    'Clipboard write and share require a direct user click or key press inside the app'
                  );
                  break;
                }
              }
              void loadDeviceBridge()
                .then((mod) => {
                  if (!deviceBridge) deviceBridge = mod.createWebDeviceBridge();
                  return mod.dispatchDeviceBridgeCall(deviceBridge, namespace, method, params, grantedCaps, permissions);
                })
                .then(
                  (res) => reply(true, res),
                  (err) => reply(false, undefined, err instanceof Error ? err.message : String(err))
                );
              break;
            }
            reply(false, undefined, `Unknown host-request kind: ${msg.kind}`);
            break;
          }

          case 'error': {
            const loc = msg.file
              ? `${msg.file}${msg.line !== undefined ? `:${msg.line}` : ''}${msg.column !== undefined ? `:${msg.column}` : ''}`
              : '';
            const formattedMessage = loc && !msg.message.includes(loc)
              ? `[SoftN ${msg.phase}] ${loc} — ${msg.message}`
              : `[SoftN ${msg.phase}] ${msg.message}`;
            const err = new SoftNContainerError(formattedMessage, {
              phase: msg.phase,
              file: msg.file,
              line: msg.line,
              column: msg.column,
              snippet: msg.snippet,
              stack: msg.stack,
            });
            // Always emit structured debug diagnostics to browser console with file/line/snippet.
            try {
              const title = `[SoftN Container · ${archive.manifest.name}] ${msg.phase} error${loc ? ` at ${loc}` : ''}`;
              /* eslint-disable no-console */
              if (typeof console.groupCollapsed === 'function' && (msg.snippet || msg.stack)) {
                console.groupCollapsed(`%c${title}`, 'color:#dc2626;font-weight:bold', msg.message);
                if (loc) console.log('Location:', loc);
                if (msg.snippet) console.log(`Source:\n${msg.snippet}`);
                if (msg.stack) console.log(`Stack:\n${msg.stack}`);
                console.groupEnd();
              } else {
                console.error(formattedMessage);
              }
              /* eslint-enable no-console */
            } catch {
              // Console unavailable
            }
            options.onError?.(err);
            if (!settledReady && msg.fatal) {
              clearInitWatchdog();
              settledReady = true;
              pendingPage = undefined;
              rejectReady(err);
            } else if (msg.fatal) {
              clearInitWatchdog();
              // Stopped after it started: the host's own error page is for an app that never did.
              showStopped(msg.message);
            }
            break;
          }
        }
      };

      const startSession = async () => {
        emitStatus({
          phase: 'starting-frontend',
          message: 'Starting web interface…',
          percent: 88,
          detail: activeTier === 'typescript' ? 'Compiling TypeScript / JSX' : undefined,
        });

        // Spawn container-worker.js immediately so its script downloads and parses in parallel
        // with WASM engine resolution and IndexedDB hydration.
        const workerUrl = options.workerUrl ?? `${runtimeUrl}container-worker.js`;
        const worker = useWorkerIsolation ? startModuleWorker(workerUrl, { name: `softn:${appId}` }) : null;

        const resolveFrontendEngine = async (): Promise<WebAssembly.Module | Uint8Array | string | undefined> => {
          // Reuse an already-loaded local backend engine (e.g. zipp-php.wasm / zipp-rust.wasm)
          // whenever it natively includes full JS (Intl/Temporal) for the active frontend tier.
          if (sharedLocalBackendEngine) {
            const bTier = sharedLocalBackendEngine.tier;
            const coversFrontend =
              bTier === activeTier ||
              ((bTier === 'php' ||
                bTier === 'rust' ||
                bTier === 'python' ||
                bTier === 'typescript' ||
                bTier === 'javascript') &&
                (activeTier === 'lite' || activeTier === 'javascript'));
            if (coversFrontend) {
              return sharedLocalBackendEngine.source;
            }
          }
          const supplied = options.engineWasm?.[activeTier];
          const explicitWasm = typeof supplied === 'function' ? await supplied() : supplied;
          if (explicitWasm instanceof WebAssembly.Module) return explicitWasm;
          if (typeof explicitWasm === 'string') {
            return useWorkerIsolation ? await getSharedCompiledEngine(explicitWasm) : explicitWasm;
          }
          if (explicitWasm) {
            return explicitWasm instanceof ArrayBuffer
              ? new Uint8Array(explicitWasm)
              : new Uint8Array(explicitWasm.buffer, explicitWasm.byteOffset, explicitWasm.byteLength);
          }
          if (useWorkerIsolation) {
            return await getSharedCompiledEngine(`${runtimeUrl}engines/${ENGINE_FILES[activeTier]}`);
          }
          return undefined;
        };

        const loadInitialIdb = async (): Promise<Record<string, string>> => {
          if (!persistStorage) return {};
          idbBacking ??= (await indexedDbBacking(storageBase)) ?? localStorageBacking(storageBase, storage);
          let out: Record<string, string> = {};
          try {
            const kept = await idbBacking.loadAll();
            idbParts.clear();
            idbPartsBytes = 0;
            for (const [name, value] of kept) setIdbPart(name, value);
            out = Object.fromEntries(kept);
          } catch {
            // Not read: the app starts with no databases.
          }
          if (idbBacking.kind === 'indexeddb' && !idbChannel && typeof BroadcastChannel === 'function') {
            idbChannel = new BroadcastChannel(`softn-idb:${storageBase}`);
            idbChannel.onmessage = (event: MessageEvent) => idbToldElsewhere((event.data as { names?: unknown } | null)?.names);
          }
          return out;
        };

        let engineSource: WebAssembly.Module | Uint8Array | string | undefined;
        let initialIdb: Record<string, string>;
        try {
          [engineSource, initialIdb] = await Promise.all([resolveFrontendEngine(), loadInitialIdb()]);
        } catch (err) {
          worker?.terminate();
          throw err;
        }
        if (disposed || !owns() || currentPatcher !== patcher) {
          worker?.terminate();
          resolveReady();
          return;
        }
        const initMsg: HostToWorkerMsg = {
          type: 'init',
          appId,
          manifest: archive.manifest,
          seed: prepared.seed,
          scripts: prepared.scripts,
          placed: prepared.placed,
          textFiles,
          binaryFiles,
          // Always the runtime folder: the tier's bindings and the hosted vendor modules are
          // read from it whichever engine runs. (An engine named by address used to be sent
          // here in its place, and the Worker then looked for `engines/` beneath a .wasm.)
          runtimeUrl,
          engineTier: activeTier,
          ...(engineSource ? { engineModule: engineSource } : {}),
          ...(options.vendorModules ? { vendorModules: options.vendorModules } : {}),
          grantedCapabilities: [...grantedCaps],
          permissions,
          initialStorage: persistStorage
            ? (storage
                ? loadPersistedStorage(storageBase, storage)
                : Object.assign(Object.create(null) as Record<string, string>, liveSession.localStorage))
            : {},
          initialSessionStorage: persistStorage ? { ...liveSession.sessionStorage } : {},
          initialDbRecords: persistStorage ? loadPersistedDb(storageBase, storage) : {},
          initialIdb,
          idbApart: idbBacking?.kind === 'indexeddb',
          ...(backendRouting ? { backendRouting } : {}),
          hasSqlite: !archive.manifest.backend && !options.backendTransport && !options.backendUrl,
          limits,
        };

        if (useWorkerIsolation && worker) {
          worker.addEventListener('message', (ev: MessageEvent<WorkerToHostMsg>) => {
            onWorkerMessage(ev.data);
          });
          worker.addEventListener('error', (ev) => {
            if (disposed || !owns() || currentPatcher !== patcher) return;
            const err = new Error(ev.message || 'Container Worker crashed');
            options.onError?.(err);
            if (settledReady) showStopped(`what runs it stopped (${err.message}).`);
            if (!settledReady) {
              settledReady = true;
              rejectReady(err);
            }
          });
          currentTransport = {
            post: (m) => worker.postMessage(m),
            terminate: () => {
              try {
                worker.postMessage({ type: 'dispose' });
              } catch {
                // Ignore
              }
              worker.terminate();
            },
          };
          clearInitWatchdog();
          const initTimeoutMs = Math.max(limits.turnTimeoutMs * 2, 15_000);
          initWatchdog = setTimeout(() => {
            initWatchdog = null;
            if (settledReady || disposed || !owns() || currentPatcher !== patcher) return;
            const err = new Error(`Container terminated: initialization exceeded ${initTimeoutMs}ms time limit`);
            currentTransport?.terminate();
            currentTransport = null;
            options.onError?.(err);
            settledReady = true;
            pendingPage = undefined;
            rejectReady(err);
          }, initTimeoutMs);
          worker.postMessage(initMsg);
          // A page the app moved to while it was not on screen starts as the last one was left.
          if (paused) worker.postMessage({ type: 'pause' } satisfies HostToWorkerMsg);
        } else {
          const { ContainerWorkerSession } = await import('./worker-runtime');
          if (disposed || !owns() || currentPatcher !== patcher) { resolveReady(); return; }
          const inlineSession = new ContainerWorkerSession(
            (m) => onWorkerMessage(m),
            async () =>
              (await import('../../core/wasm-zipp/zipp_wasm.js')) as unknown as Record<string, unknown>
          );
          currentTransport = {
            post: (m) => {
              void inlineSession.handleMessage(m);
            },
            terminate: () => inlineSession.dispose(),
          };
          await inlineSession.handleMessage(initMsg);
          if (paused) void inlineSession.handleMessage({ type: 'pause' });
        }
      };

      void startSession().catch((err) => {
        if (!settledReady) {
          settledReady = true;
          rejectReady(err);
        }
      });
    });
    if (!disposed && owns() && currentPatcher === patcher) options.onPageChange?.(pagePath, archive.manifest);
  };

  const initialPage = options.initialPage;
  const resolvedInitialPage =
    initialPage && /\.html?$/i.test(initialPage) && archive.names().includes(initialPage)
      ? initialPage
      : undefined;
  const restoredUrlPath =
    !options.initialPath && !resolvedInitialPage && persistStorage && isSafeVirtualRoute(savedSession?.urlPath)
      ? savedSession.urlPath
      : undefined;

  const disposeContainer = () => {
    if (disposed) return;
    pendingPage?.();
    pendingPage = undefined;
    navController = null;
    navEl = null;
    cleanupBootFailure();
  };

  try {
    if (options.initialPath) {
      await navigateTo(options.initialPath, true);
    } else if (resolvedInitialPage) {
      const initialFrontendPath = archive.toFrontendVfsPath(resolvedInitialPage);
      const initialUrl = /(^|\/)index\.html?$/i.test(initialFrontendPath)
        ? '/' + initialFrontendPath.replace(/(^|\/)index\.html?$/i, '$1')
        : `/${initialFrontendPath}`;
      recordHistory(initialUrl, true);
      await mountPage(resolvedInitialPage);
    } else if (restoredUrlPath) {
      let restoredPathname: string | null = null;
      try {
        const parsedRestored = new URL(restoredUrlPath, `${VIRTUAL_ORIGIN}/`);
        if (parsedRestored.origin === VIRTUAL_ORIGIN) {
          restoredPathname = parsedRestored.pathname;
        }
      } catch {
        restoredPathname = null;
      }
      if (!restoredPathname) {
        const initialFrontendPath = archive.toFrontendVfsPath(archive.manifest.main);
        const initialUrl = /(^|\/)index\.html?$/i.test(initialFrontendPath)
          ? '/' + initialFrontendPath.replace(/(^|\/)index\.html?$/i, '$1')
          : `/${initialFrontendPath}`;
        recordHistory(initialUrl, true);
        await mountPage(archive.manifest.main);
      } else {
        const resolvedHtml = archive.resolveFrontendPath(restoredPathname, archive.manifest.main);
        const hasExactStaticHtml = Boolean(
          resolvedHtml &&
            /\.html?$/i.test(resolvedHtml) &&
            archive.has(resolvedHtml) &&
            resolvedHtml !== archive.manifest.main
        );
        const wantsBackendRestore =
          Boolean(backendTransport) &&
          (Boolean(archive.manifest.ssrEntry) ||
            /\.(?:php|phtml)$/i.test(restoredPathname) ||
            (!hasExactStaticHtml &&
              Boolean(
                matchBackendTarget(`${VIRTUAL_ORIGIN}${restoredUrlPath}`, backendRouting, {
                  baseUrl: `${VIRTUAL_ORIGIN}/`,
                  method: 'GET',
                  isStaticVfsFile: (p) => archive.has(p),
                })
              )));
        if (wantsBackendRestore || hasExactStaticHtml) {
          await navigateTo(restoredUrlPath, true).catch(async () => {
            recordHistory(restoredUrlPath, true);
            await mountPage(archive.manifest.main, undefined, restoredUrlPath);
          });
        } else {
          recordHistory(restoredUrlPath, true);
          await mountPage(archive.manifest.main, undefined, restoredUrlPath);
        }
      }
    } else if (archive.manifest.ssrEntry && backendTransport) {
      await navigateTo('/', true);
    } else {
      const initialFrontendPath = archive.toFrontendVfsPath(archive.manifest.main);
      const initialUrl = /(^|\/)index\.html?$/i.test(initialFrontendPath)
        ? '/' + initialFrontendPath.replace(/(^|\/)index\.html?$/i, '$1')
        : `/${initialFrontendPath}`;
      recordHistory(initialUrl, true);
      await mountPage(archive.manifest.main);
    }
    // Backend booted in parallel with the frontend; ensure it has settled before resolving mountSoftNContainer().
    if (localBackendTransport && !disposed) {
      await localBackendTransport.ready;
    }
  } catch (err) {
    disposeContainer();
    throw err;
  }

  if (owns()) {
    options.onReady?.({
      manifest: archive.manifest,
      engineTier: activeTier,
      capabilitiesRequested: requestedCaps,
    });
  }

  return {
    manifest: archive.manifest,
    get engineTier() {
      return activeTier;
    },
    get currentPath() {
      return currentUrlPath;
    },
    appId,
    shadowRoot: pageRoot,
    frameRoot: shadowRoot,
    backendTransport,
    async navigate(path: string) {
      await navigateTo(path, true, true);
    },
    listVirtualDirectory(dirPath = ''): VirtualDirEntry[] {
      return archive.listVirtualDirectory(dirPath);
    },
    async seedDatabase(dbName: string, seedJson: string | Record<string, unknown>): Promise<Record<string, unknown>> {
      if (!localBackendTransport) {
        throw new Error('Cannot seed database: no local SQLite engine is running in this container');
      }
      return localBackendTransport.seedDatabase(dbName, seedJson);
    },
    async exportDatabase(dbName: string): Promise<Uint8Array | null> {
      if (!localBackendTransport) return null;
      return localBackendTransport.exportDatabase(dbName);
    },
    setGrantedCapabilities(caps: Capability[]) {
      grantedCaps = new Set(caps.filter((cap) => allowedCaps.has(cap)));
      for (const bar of Array.from(frameEl.children)) {
        if (bar.hasAttribute('data-softn-container-consent')) bar.remove();
      }
      currentPatcher?.updatePermissions(permissions, grantedCaps.has('net'), grantedCaps.has('files'));
      currentTransport?.post({
        type: 'permissions-updated',
        grantedCapabilities: [...grantedCaps],
      });
    },
    setActive(active: boolean) {
      if (disposed || paused === !active) return;
      paused = !active;
      if (paused) {
        // A frame already asked of the browser is taken back, and owed.
        if (rafHandle !== null) frameOwed = true;
        clearRaf();
        currentTransport?.post({ type: 'pause' });
      } else {
        currentTransport?.post({ type: 'resume' });
        if (frameOwed) {
          frameOwed = false;
          scheduleNextRaf();
        }
      }
    },
    dispose: disposeContainer,
  };
}

/**
 * Define the `<softn-app>` Custom Element (`<softn-app src="./my-app.softn" runtime-url="/runtime/"></softn-app>`).
 */
export function defineSoftNAppElement(): void {
  if (typeof customElements === 'undefined' || customElements.get('softn-app')) return;

  class SoftNAppElement extends HTMLElement {
    static get observedAttributes(): string[] {
      return ['src', 'runtime-url', 'backend-url', 'theme', 'permission-mode', 'virtual-nav', 'initial-path'];
    }

    private handle: SoftNContainerHandle | null = null;
    private mountGeneration = 0;
    private remountQueued = false;

    connectedCallback(): void {
      this.scheduleRemount();
    }

    disconnectedCallback(): void {
      this.mountGeneration++;
      this.remountQueued = false;
      this.handle?.dispose();
      this.handle = null;
    }

    attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
      if (oldValue === newValue || !this.isConnected) return;
      if (
        name === 'src' ||
        name === 'runtime-url' ||
        name === 'backend-url' ||
        name === 'theme' ||
        name === 'permission-mode' ||
        name === 'virtual-nav' ||
        name === 'initial-path'
      ) {
        this.scheduleRemount();
      }
    }

    private scheduleRemount(): void {
      if (this.remountQueued) return;
      this.remountQueued = true;
      queueMicrotask(() => {
        this.remountQueued = false;
        if (this.isConnected) void this.remount();
      });
    }

    private async remount(): Promise<void> {
      const gen = ++this.mountGeneration;
      this.handle?.dispose();
      this.handle = null;

      // Never allow untrusted guest content inside a container's shadow root to mount a nested
      // `<softn-app>` container inside the embedding host page's realm.
      if (this.getRootNode() instanceof ShadowRoot) return;

      const src = this.getAttribute('src');
      if (!src) return;

      const runtimeUrl = this.getAttribute('runtime-url') ?? '/runtime/';
      const backendUrl = this.getAttribute('backend-url') ?? undefined;
      const themeAttr = this.getAttribute('theme');
      const theme = themeAttr === 'dark' || themeAttr === 'light' ? themeAttr : 'auto';
      const permAttr = this.getAttribute('permission-mode');
      const permissionMode =
        permAttr === 'preapproved' || permAttr === 'deny' ? permAttr : 'prompt';
      const virtualNav = this.hasAttribute('virtual-nav') && this.getAttribute('virtual-nav') !== 'false';
      const initialPath = this.getAttribute('initial-path') ?? undefined;

      try {
        const mounted = await mountSoftNContainer(this, {
          source: src,
          runtimeUrl,
          backendUrl,
          theme,
          permissionMode,
          virtualNav,
          initialPath,
          onTitleChange: (title) => {
            this.dispatchEvent(new CustomEvent('softn-title', { detail: { title }, bubbles: true }));
          },
          onReady: (info) => {
            this.dispatchEvent(new CustomEvent('softn-ready', { detail: info, bubbles: true }));
          },
          onError: (error) => {
            this.dispatchEvent(new CustomEvent('softn-error', { detail: { error }, bubbles: true }));
          },
        });
        if (gen !== this.mountGeneration) {
          mounted.dispose();
          return;
        }
        this.handle = mounted;
      } catch (error) {
        this.dispatchEvent(new CustomEvent('softn-error', { detail: { error }, bubbles: true }));
      }
    }
  }

  customElements.define('softn-app', SoftNAppElement);
}
