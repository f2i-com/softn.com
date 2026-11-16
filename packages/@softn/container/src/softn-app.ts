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
import { renderConsentBar } from './consent-bar';
import { HostDomPatcher } from './dom-patcher';
import { prepareHtmlDocument } from './sanitize';
import { SHADOW_HOST_BASE_CSS } from './ui-css';
import { ensureUiExtension } from './ui-extensions/registry';
import { selectEngineTier } from './zipp-loader';
import type {
  ContainerLimits,
  ContainerManifest,
  HostToWorkerMsg,
  SoftNContainerOptions,
  ThreeSceneOp,
  WorkerToHostMsg,
  ZippEngineTier,
} from './types';
import type { SplitRealmSceneHost } from './vendor/webgl-scene-host';

const DEFAULT_LIMITS: Required<ContainerLimits> = {
  instructionsPerTurn: 100_000_000,
  turnTimeoutMs: 15_000,
  storageQuotaBytes: 10 * 1024 * 1024,
};

export interface SoftNContainerHandle {
  readonly manifest: ContainerManifest;
  readonly engineTier: ZippEngineTier;
  readonly appId: string;
  /** Controlled access to the container's ShadowRoot for host tooling & tests. */
  readonly shadowRoot: ShadowRoot;
  /** Navigate to another HTML page inside the same `.softn` container. */
  navigate(path: string): Promise<void>;
  /** Grant or revoke capabilities dynamically. */
  setGrantedCapabilities(caps: Capability[]): void;
  /** Tear down the Worker, revoke `blob:` URLs, and clean up DOM listeners. */
  dispose(): void;
}

interface WorkerTransport {
  post(msg: HostToWorkerMsg): void;
  terminate(): void;
}

const shadowRootRegistry = new WeakMap<HTMLElement, ShadowRoot>();

const ENGINE_FILES: Readonly<Record<ZippEngineTier, string>> = {
  lite: 'zipp-javascript-lite.wasm',
  javascript: 'zipp-javascript.wasm',
  typescript: 'zipp-typescript.wasm',
  python: 'zipp-python-base.wasm',
  'python-torch': 'zipp-python-base.wasm',
};

/** Shared page-level compiled WebAssembly.Module cache so multiple Workers share 1 download & 1 compile! */
const sharedEngineModuleCache = new Map<string, Promise<WebAssembly.Module>>();

function getSharedCompiledEngine(runtimeUrl: string, tier: ZippEngineTier): Promise<WebAssembly.Module> {
  const url = `${runtimeUrl}engines/${ENGINE_FILES[tier]}`;
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
  const root = hostEl.attachShadow({ mode: 'closed' });
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

function loadPersistedStorage(appId: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof localStorage === 'undefined') return out;
  const prefix = `softn-v2:${appId}:ls:`;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) {
        const val = localStorage.getItem(k);
        if (val !== null) out[k.slice(prefix.length)] = val;
      }
    }
  } catch {
    // Ignore storage access errors in restricted frames
  }
  return out;
}

function applyPersistedStorageOp(
  appId: string,
  op: 'set' | 'remove' | 'clear',
  key?: string,
  value?: string
): void {
  if (typeof localStorage === 'undefined') return;
  const prefix = `softn-v2:${appId}:ls:`;
  try {
    if (op === 'set' && key !== undefined && value !== undefined) {
      localStorage.setItem(prefix + key, value);
    } else if (op === 'remove' && key !== undefined) {
      localStorage.removeItem(prefix + key);
    } else if (op === 'clear') {
      const toRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) toRemove.push(k);
      }
      for (const k of toRemove) localStorage.removeItem(k);
    }
  } catch {
    // Ignore storage quota / security errors on host
  }
}

function loadPersistedDb(appId: string): Record<string, unknown[]> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(`softn-v2:${appId}:db`);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown[]>)
      : {};
  } catch {
    return {};
  }
}

function savePersistedDbCollection(appId: string, collection: string, records: unknown[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const current = loadPersistedDb(appId);
    current[collection] = records;
    localStorage.setItem(`softn-v2:${appId}:db`, JSON.stringify(current));
  } catch {
    // Ignore host storage errors
  }
}

/**
 * Mount a `.softn` container inside `hostEl`.
 */
export async function mountSoftNContainer(
  hostEl: HTMLElement,
  options: SoftNContainerOptions
): Promise<SoftNContainerHandle> {
  const shadowRoot = getOrAttachClosedShadow(hostEl);
  shadowRoot.replaceChildren();

  const runtimeUrl = (options.runtimeUrl ?? '/runtime/').replace(/\/?$/, '/');
  const limits: Required<ContainerLimits> = {
    ...DEFAULT_LIMITS,
    ...(options.limits ?? {}),
  };

  const rawSource = await loadArchiveSource(options.source);
  const archive = await ContainerArchive.open(rawSource);
  const appId = options.appId ?? archive.manifest.id;
  const permissions = options.permissionsOverride ?? archive.permissions;
  const requestedCaps = archive.requestedCapabilities;

  let grantedCaps = new Set<Capability>(
    options.permissionMode === 'preapproved' ? requestedCaps : []
  );

  // Legacy v1 `.ui` fallback path (0 bytes loaded unless `.ui` entry detected)
  if (archive.manifest.mode === 'legacy-ui') {
    const mountDiv = document.createElement('div');
    mountDiv.style.cssText = 'width:100%;height:100%';
    shadowRoot.appendChild(mountDiv);
    const { mountLegacyUiBundle } = await import('./compat/legacy-ui');
    const legacyHandle = await mountLegacyUiBundle(mountDiv, archive, runtimeUrl);
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
      navigate: async () => undefined,
      setGrantedCapabilities: () => undefined,
      dispose() {
        legacyHandle.dispose();
        archive.dispose();
        shadowRoot.replaceChildren();
      },
    };
  }

  let disposed = false;
  let currentPatcher: HostDomPatcher | null = null;
  let currentTransport: WorkerTransport | null = null;
  let threeHost: SplitRealmSceneHost | null = null;
  const persistStorage = options.persistStorage !== false;
  let rafHandle: number | ReturnType<typeof setTimeout> | null = null;
  let activeTier: ZippEngineTier = 'lite';
  let turnSeq = 1;
  const pendingWatchdogs = new Map<number, ReturnType<typeof setTimeout>>();

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

  const scheduleNextRaf = () => {
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
    currentTransport?.terminate();
    currentTransport = null;
    currentPatcher?.dispose();
    currentPatcher = null;
    threeHost?.dispose();
    threeHost = null;
  };

  const mountPage = async (pagePath: string): Promise<void> => {
    if (disposed) return;
    teardownPage();
    shadowRoot.replaceChildren();

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

    const { textFiles, binaryFilesBase64 } = archive.exportWorkerVfs();
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

    // Base + page styles inside closed ShadowRoot
    const styleEl = document.createElement('style');
    styleEl.textContent = [SHADOW_HOST_BASE_CSS, ...prepared.styles].join('\n');
    shadowRoot.appendChild(styleEl);

    // Non-blocking consent bar when capabilities are requested in `'prompt'` mode
    const permissionMode = options.permissionMode ?? 'prompt';
    if (permissionMode === 'prompt' && requestedCaps.length > 0 && grantedCaps.size === 0) {
      const bar = renderConsentBar(requestedCaps, archive.manifest.name, (allowed) => {
        if (allowed) {
          grantedCaps = new Set(requestedCaps);
          currentPatcher?.updatePermissions(permissions, grantedCaps.has('net'));
          currentTransport?.post({
            type: 'permissions-updated',
            grantedCapabilities: [...grantedCaps],
          });
        }
      });
      shadowRoot.appendChild(bar);
    }

    const docRootEl = document.createElement('div');
    docRootEl.setAttribute('data-softn-docroot', '');
    docRootEl.style.cssText = 'width:100%;height:100%';

    const viewportEl = document.createElement('div');
    viewportEl.setAttribute('data-softn-viewport', '');
    viewportEl.setAttribute('data-theme', effectiveTheme);
    docRootEl.appendChild(viewportEl);
    shadowRoot.appendChild(docRootEl);

    const handleThreeOps = async (
      canvas: HTMLCanvasElement,
      canvasId: number,
      ops: ThreeSceneOp[]
    ) => {
      if (!threeHost) {
        const { SplitRealmSceneHost: HostCtor } = await import('./vendor/webgl-scene-host');
        if (disposed) return;
        threeHost = new HostCtor(archive, runtimeUrl);
      }
      threeHost.enqueue(canvas, canvasId, ops);
    };

    const patcher = new HostDomPatcher({
      viewportEl,
      docRootEl,
      archive,
      entryPath: pagePath,
      permissions,
      netGranted: grantedCaps.has('net'),
      callbacks: {
        onEvent: (nodeId, eventType, props, syncChanges) => {
          const tid = turnSeq++;
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
        onNavigate: (href) => {
          const next = resolveVfsPath(href, pagePath);
          if (next && archive.has(next)) {
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

      const onWorkerMessage = (msg: WorkerToHostMsg) => {
        if (disposed) return;
        switch (msg.type) {
          case 'ready':
            if (!settledReady) {
              settledReady = true;
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
            if (persistStorage) applyPersistedStorageOp(appId, msg.op, msg.key, msg.value);
            break;

          case 'db-write':
            if (persistStorage) savePersistedDbCollection(appId, msg.collection, msg.records);
            break;

          case 'error': {
            const err = new Error(`[SoftN ${msg.phase}] ${msg.message}`);
            options.onError?.(err);
            if (!settledReady && msg.fatal) {
              settledReady = true;
              rejectReady(err);
            }
            break;
          }
        }
      };

      const startSession = async () => {
        // Pre-resolve explicit engine source if given as string path/URL or BufferSource
        const explicitWasm = options.engineWasm?.[activeTier];
        let transferableEngine: WebAssembly.Module | Uint8Array | undefined;
        if (explicitWasm instanceof WebAssembly.Module) {
          transferableEngine = explicitWasm;
        } else if (explicitWasm && typeof explicitWasm !== 'string') {
          transferableEngine =
            explicitWasm instanceof ArrayBuffer
              ? new Uint8Array(explicitWasm)
              : new Uint8Array(explicitWasm.buffer, explicitWasm.byteOffset, explicitWasm.byteLength);
        } else if (useWorkerIsolation && !explicitWasm) {
          transferableEngine = await getSharedCompiledEngine(runtimeUrl, activeTier);
        }

        const initMsg: HostToWorkerMsg = {
          type: 'init',
          appId,
          manifest: archive.manifest,
          seed: prepared.seed,
          scripts: prepared.scripts,
          textFiles,
          binaryFilesBase64,
          runtimeUrl: typeof explicitWasm === 'string' ? explicitWasm : runtimeUrl,
          engineTier: activeTier,
          ...(transferableEngine ? { engineModule: transferableEngine } : {}),
          ...(options.vendorModules ? { vendorModules: options.vendorModules } : {}),
          grantedCapabilities: [...grantedCaps],
          permissions,
          initialStorage: persistStorage ? loadPersistedStorage(appId) : {},
          initialDbRecords: persistStorage ? loadPersistedDb(appId) : {},
          limits,
        };

        if (useWorkerIsolation) {
          const workerUrl = `${runtimeUrl}container-worker.js`;
          const worker = new Worker(workerUrl, { type: 'module', name: `softn:${appId}` });
          worker.addEventListener('message', (ev: MessageEvent<WorkerToHostMsg>) => {
            onWorkerMessage(ev.data);
          });
          worker.addEventListener('error', (ev) => {
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
        } else {
          const { ContainerWorkerSession } = await import('./worker-runtime');
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
          if (typeof explicitWasm === 'string') {
            (initMsg as { engineModule?: unknown }).engineModule = explicitWasm as unknown as Uint8Array;
            initMsg.runtimeUrl = runtimeUrl;
          }
          await inlineSession.handleMessage(initMsg);
        }
      };

      void startSession().catch((err) => {
        if (!settledReady) {
          settledReady = true;
          rejectReady(err);
        }
      });
    });
  };

  await mountPage(archive.manifest.main);

  options.onReady?.({
    manifest: archive.manifest,
    engineTier: activeTier,
    capabilitiesRequested: requestedCaps,
  });

  return {
    manifest: archive.manifest,
    get engineTier() {
      return activeTier;
    },
    appId,
    shadowRoot,
    async navigate(path: string) {
      const resolved = resolveVfsPath(path, archive.manifest.main);
      if (!resolved || !archive.has(resolved)) {
        throw new Error(`Cannot navigate to missing container page: ${path}`);
      }
      await mountPage(resolved);
    },
    setGrantedCapabilities(caps: Capability[]) {
      grantedCaps = new Set(caps);
      currentPatcher?.updatePermissions(permissions, grantedCaps.has('net'));
      currentTransport?.post({
        type: 'permissions-updated',
        grantedCapabilities: [...grantedCaps],
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      teardownPage();
      archive.dispose();
      shadowRoot.replaceChildren();
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
