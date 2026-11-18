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

import type { Capability } from '@softn/bundle-format/capabilities';
import { ContainerArchive, resolveVfsPath } from './archive';
import { renderConsentBar, renderSaveBar } from './consent-bar';
import { HostDomPatcher } from './dom-patcher';
import { hostFileName, hostLabel, slotsAreContained } from './host-policy';
import { prepareHtmlDocument } from './sanitize';
import { FRAME_BASE_CSS, PAGE_BASE_CSS } from './ui-css';
import { ensureUiExtension } from './ui-extensions/registry';
import { selectEngineTier } from './zipp-loader';
import type {
  ContainerLimits,
  ContainerManifest,
  HostToWorkerMsg,
  SaveRequest,
  SoftNContainerOptions,
  ThreeSceneOp,
  WorkerToHostMsg,
  ZippEngineTier,
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
  /** Navigate to another HTML page inside the same `.softn` container. */
  navigate(path: string): Promise<void>;
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
const DOCROOT_STYLE = `${PINNED}display:block!important;width:100%!important;height:100%!important;position:relative!important;overflow:auto!important;`;

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
      const ct = (resp.headers.get('content-type') ?? '').split(';')[0].trim();
      if (ct === 'application/wasm' && typeof WebAssembly.compileStreaming === 'function') {
        try {
          return await WebAssembly.compileStreaming(resp.clone());
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
function loadPersistedStorage(base: string, storage: Storage | undefined): Record<string, string> {
  const out: Record<string, string> = {};
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

/** The bytes the app's kept localStorage takes in the embedding page's, as the Worker counts them. */
function persistedStorageBytes(base: string, storage: Storage | undefined): number {
  let bytes = 0;
  for (const [key, value] of Object.entries(loadPersistedStorage(base, storage))) bytes += (key.length + value.length) * 2;
  return bytes;
}

/** The bytes the app's kept records take there. */
function persistedDbBytes(base: string, storage: Storage | undefined): number {
  if (!storage) return 0;
  try {
    return (storage.getItem(`${base}db`)?.length ?? 0) * 2;
  } catch {
    return 0;
  }
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
  return persistedStorageBytes(base, storage) + persistedDbBytes(base, storage) - replaced + (key.length + value.length) * 2 <= quotaBytes;
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

  const rawSource = await loadArchiveSource(options.source);
  const archive = await ContainerArchive.open(rawSource);
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
  const storageBase = options.storagePrefix ?? `softn-v2:${appId}:`;
  // Said once: the page's storage refused (it is full, or a private window keeps none).
  let storageRefused = false;
  const storageKept = (kept: boolean): void => {
    if (kept || storageRefused) return;
    storageRefused = true;
    options.onError?.(new Error('This app’s data could not be kept: the browser’s storage for this page is full or unavailable.'));
  };
  const permissions = options.permissionsOverride ?? archive.permissions;
  const requestedCaps = archive.requestedCapabilities;

  // What is granted before the first script runs: everything the archive asks for when the
  // deployment preapproved it, else what the host says the person already allowed.
  let grantedCaps = new Set<Capability>(
    options.permissionMode === 'preapproved' ? requestedCaps : (options.initialGrantedCapabilities ?? [])
  );

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
      navigate: async () => undefined,
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
  const persistStorage = options.persistStorage !== false;
  const storage = persistStorage ? options.storage ?? browserStorage() : undefined;
  let rafHandle: number | ReturnType<typeof setTimeout> | null = null;
  let activeTier: ZippEngineTier = 'lite';
  let turnSeq = 1;
  const pendingWatchdogs = new Map<number, ReturnType<typeof setTimeout>>();
  /** What waits for the script's answer to an event it was handed, by the event's turn. */
  const pendingAnswers = new Map<number, (eventBits: number) => void>();

  const clearRaf = () => {
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
    if (rafHandle !== null || disposed) return;
    const step = (ts: number) => {
      rafHandle = null;
      if (!disposed) currentTransport?.post({ type: 'raf', timestamp: ts });
    };
    if (typeof requestAnimationFrame === 'function') {
      rafHandle = requestAnimationFrame(step);
    } else {
      rafHandle = setTimeout(() => step(performance.now()), 16);
    }
  };

  const teardownPage = () => {
    clearRaf();
    for (const wd of pendingWatchdogs.values()) clearTimeout(wd);
    pendingWatchdogs.clear();
    pendingAnswers.clear();
    currentTransport?.terminate();
    currentTransport = null;
    currentPatcher?.dispose();
    currentPatcher = null;
    threeHost?.dispose();
    threeHost = null;
  };

  // An app can follow a link while its first worker is still starting. Its caller
  // should wait for the replacement page, even when the original worker never replies.
  let pendingPage: ((replacement?: Promise<void>) => void) | undefined;
  const mountPage = (path: string): Promise<void> => {
    const previous = pendingPage;
    pendingPage = undefined;
    const next = loadPage(path);
    previous?.(next);
    return next;
  };

  const loadPage = async (pagePath: string): Promise<void> => {
    // A mount the element no longer shows draws nothing: the root is the newer mount's.
    if (disposed || !owns()) return;
    teardownPage();
    // The page before, and the bars that were about it.
    pageRoot.replaceChildren();
    for (const bar of Array.from(frameEl.children)) if (bar !== boxEl) bar.remove();
    saveEl = null;
    if (frameEl.parentNode !== shadowRoot) shadowRoot.replaceChildren(frameStyle, frameEl);

    const html = archive.readText(pagePath);
    if (html === null) {
      throw new Error(`Page "${pagePath}" not found in .softn container`);
    }

    const prepared = prepareHtmlDocument(
      html,
      pagePath,
      archive,
      permissions,
      grantedCaps.has('net')
    );

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
    if (permissionMode === 'prompt' && requestedCaps.length > 0 && grantedCaps.size === 0) {
      const bar = renderConsentBar(requestedCaps, hostLabel(archive.manifest.name) || 'This app', (allowed) => {
        if (allowed) {
          grantedCaps = new Set(requestedCaps);
          currentPatcher?.updatePermissions(permissions, grantedCaps.has('net'), grantedCaps.has('files'));
          currentTransport?.post({
            type: 'permissions-updated',
            grantedCapabilities: [...grantedCaps],
          });
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
    viewportEl.setAttribute('data-theme', effectiveTheme);
    docRootEl.appendChild(viewportEl);
    pageRoot.appendChild(docRootEl);

    const handleThreeOps = async (
      canvas: HTMLCanvasElement,
      canvasId: number,
      ops: ThreeSceneOp[]
    ) => {
      if (!threeHost) {
        const { SplitRealmSceneHost: HostCtor } = await import('./vendor/webgl-scene-host');
        if (disposed) return;
        threeHost = new HostCtor(archive, runtimeUrl, options.hostThree);
      }
      threeHost.enqueue(canvas, canvasId, ops);
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
      callbacks: {
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
          const tid = turnSeq++;
          if (answered) pendingAnswers.set(tid, answered);
          if (useWorkerIsolation) {
            const wd = setTimeout(() => {
              pendingWatchdogs.delete(tid);
              currentTransport?.terminate();
              options.onError?.(
                new Error(`Container terminated: event "${eventType}" exceeded ${limits.turnTimeoutMs}ms time limit`)
              );
            }, limits.turnTimeoutMs);
            pendingWatchdogs.set(tid, wd);
          }
          currentTransport?.post({
            type: 'event',
            turnId: tid,
            nodeId,
            eventType,
            props,
            syncChanges,
          });
        },
        onSync: (changes) => {
          currentTransport?.post({ type: 'sync', changes });
        },
        onTitleChange: (title) => {
          options.onTitleChange?.(title);
        },
        onExternalLink: options.onExternalLink,
        onNavigate: (href) => {
          // A page of the app's, and only a page: a link to any other file of the app's is
          // not something to show as a document.
          const next = resolveVfsPath(href, pagePath);
          if (next && /\.html?$/i.test(next) && archive.has(next)) {
            void mountPage(next).catch((err) => options.onError?.(err instanceof Error ? err : new Error(String(err))));
          }
        },
        onCustomTag: (tag) => {
          void ensureUiExtension(tag, runtimeUrl);
        },
        onThreeOps: (canvas, canvasId, ops) => {
          void handleThreeOps(canvas, canvasId, ops);
        },
      },
    });
    currentPatcher = patcher;

    const initialTags = prepared.mountInitialDom(viewportEl, patcher.nodes, docRootEl);
    for (const tag of initialTags) {
      void ensureUiExtension(tag, runtimeUrl);
    }

    // Boot Worker (or inline session when `isolation: 'inline'` or `Worker` is absent in JSDOM)
    const useWorkerIsolation =
      options.isolation === 'worker' ||
      (options.isolation !== 'inline' && typeof Worker === 'function');

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
          // FormLogic's native JSON route accepts uploads up to its six-MiB transport limit.
          const limit = action === 'nativeRequest' ? 6 * 1024 * 1024 : 32768;
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
          resolveReady();
          return;
        }
        switch (msg.type) {
          case 'host-request':
            void replyToRequest(msg);
            break;

          case 'ready':
            if (!settledReady) {
              settledReady = true;
              pendingPage = undefined;
              resolveReady();
            }
            break;

          case 'ops':
            if (msg.turnId !== undefined) {
              const wd = pendingWatchdogs.get(msg.turnId);
              if (wd) {
                clearTimeout(wd);
                pendingWatchdogs.delete(msg.turnId);
              }
            }
            if (msg.ops.length > 0) {
              patcher.applyOps(msg.ops);
            }
            if (msg.wantsRaf) {
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
            if (msg.op === 'set' && (typeof msg.key !== 'string' || typeof msg.value !== 'string' || !storageWriteFits(storageBase, msg.key, msg.value, limits.storageQuotaBytes, storage))) {
              break;
            }
            storageKept(applyPersistedStorageOp(storageBase, msg.op, msg.key, msg.value, storage));
            break;

          case 'db-write':
            // Its records take what its localStorage has left of the one quota.
            if (persistStorage && owns() && currentPatcher === patcher) {
              storageKept(savePersistedDbCollection(storageBase, msg.collection, msg.records, limits.storageQuotaBytes - persistedStorageBytes(storageBase, storage), storage));
            }
            break;

          case 'error': {
            const err = new Error(`[SoftN ${msg.phase}] ${msg.message}`);
            options.onError?.(err);
            if (!settledReady && msg.fatal) {
              settledReady = true;
              pendingPage = undefined;
              rejectReady(err);
            }
            break;
          }
        }
      };

      const startSession = async () => {
        // The tier's engine: the host's own when it names one for this tier (bytes, a compiled
        // module, an address, or a function asked only now, so a host that offers the engine
        // its page already runs compiles nothing for an app on another tier), else the file
        // in the runtime folder. An address is fetched and compiled once per page here, and
        // the module handed to the Worker; without a Worker the session loads it itself.
        const supplied = options.engineWasm?.[activeTier];
        const explicitWasm = typeof supplied === 'function' ? await supplied() : supplied;
        let engineSource: WebAssembly.Module | Uint8Array | string | undefined;
        if (explicitWasm instanceof WebAssembly.Module) {
          engineSource = explicitWasm;
        } else if (typeof explicitWasm === 'string') {
          engineSource = useWorkerIsolation ? await getSharedCompiledEngine(explicitWasm) : explicitWasm;
        } else if (explicitWasm) {
          engineSource =
            explicitWasm instanceof ArrayBuffer
              ? new Uint8Array(explicitWasm)
              : new Uint8Array(explicitWasm.buffer, explicitWasm.byteOffset, explicitWasm.byteLength);
        } else if (useWorkerIsolation) {
          engineSource = await getSharedCompiledEngine(`${runtimeUrl}engines/${ENGINE_FILES[activeTier]}`);
        }

        if (disposed || !owns() || currentPatcher !== patcher) { resolveReady(); return; }
        const initMsg: HostToWorkerMsg = {
          type: 'init',
          appId,
          manifest: archive.manifest,
          seed: prepared.seed,
          scripts: prepared.scripts,
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
          initialStorage: persistStorage ? loadPersistedStorage(storageBase, storage) : {},
          initialDbRecords: persistStorage ? loadPersistedDb(storageBase, storage) : {},
          limits,
        };

        if (useWorkerIsolation) {
          const workerUrl = options.workerUrl ?? `${runtimeUrl}container-worker.js`;
          // Behind the embedding page's service worker wherever the folder is (worker-start.ts).
          const worker = startModuleWorker(workerUrl, { name: `softn:${appId}` });
          worker.addEventListener('message', (ev: MessageEvent<WorkerToHostMsg>) => {
            onWorkerMessage(ev.data);
          });
          worker.addEventListener('error', (ev) => {
            if (disposed || !owns() || currentPatcher !== patcher) return;
            const err = new Error(ev.message || 'Container Worker crashed');
            options.onError?.(err);
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
  await mountPage(initialPage && /\.html?$/i.test(initialPage) && archive.names().includes(initialPage)
    ? initialPage : archive.manifest.main);

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
    appId,
    shadowRoot: pageRoot,
    frameRoot: shadowRoot,
    async navigate(path: string) {
      const resolved = resolveVfsPath(path, archive.manifest.main);
      if (!resolved || !archive.has(resolved)) {
        throw new Error(`Cannot navigate to missing container page: ${path}`);
      }
      await mountPage(resolved);
    },
    setGrantedCapabilities(caps: Capability[]) {
      grantedCaps = new Set(caps);
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
    dispose() {
      if (disposed) return;
      disposed = true;
      pendingPage?.();
      pendingPage = undefined;
      teardownPage();
      archive.dispose();
      // Only what this mount drew: a newer mount into the same element owns the root now.
      pageRoot.replaceChildren();
      if (owns()) shadowRoot.replaceChildren();
    },
  };
}

/**
 * Define the `<softn-app>` Custom Element (`<softn-app src="./my-app.softn" runtime-url="/runtime/"></softn-app>`).
 */
export function defineSoftNAppElement(): void {
  if (typeof customElements === 'undefined' || customElements.get('softn-app')) return;

  class SoftNAppElement extends HTMLElement {
    static get observedAttributes(): string[] {
      return ['src', 'runtime-url', 'theme', 'permission-mode'];
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
      if (name === 'src' || name === 'runtime-url' || name === 'theme' || name === 'permission-mode') {
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

      const src = this.getAttribute('src');
      if (!src) return;

      const runtimeUrl = this.getAttribute('runtime-url') ?? '/runtime/';
      const themeAttr = this.getAttribute('theme');
      const theme = themeAttr === 'dark' || themeAttr === 'light' ? themeAttr : 'auto';
      const permAttr = this.getAttribute('permission-mode');
      const permissionMode =
        permAttr === 'preapproved' || permAttr === 'deny' ? permAttr : 'prompt';

      try {
        const mounted = await mountSoftNContainer(this, {
          source: src,
          runtimeUrl,
          theme,
          permissionMode,
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
