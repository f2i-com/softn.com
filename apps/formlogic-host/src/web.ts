import { mountSoftNContainer, SoftNContainerError, type SoftNContainerHandle } from '@softn/container';
import { manifestRunsInContainer } from '@softn/bundle-format/engine';
import { containerRuntimeUrl } from '@softn/runtime-shell/containerHost';
import type { Capability } from '@softn/bundle-format/capabilities';
import { createBackendQueue, BACKEND_UNREADABLE } from './backendQueue';
import {
  buildContainerSource,
  createBinaryAppOfferHandler,
  createPortBackendTransport,
  FRAME_EMBEDS,
  frameBackendCall,
  grantedContainerCapabilities,
  isContainerBundle,
  type ContainerBackendTransport,
} from './containerBridge';
import { normalizeHost, outsideAddress } from './links';
import { readPlace, writePlace } from './place';
import { grantedPermissions } from './permissions';
import { installAppStorage, STORAGE_LIMITS, STORAGE_PROTOCOL, storageLimits } from './storage';
import zippSource from '../../../packages/@softn/core/wasm-zipp/SOURCE.json';

const target = document.getElementById('root')!;
let port: MessagePort | undefined;
let container: SoftNContainerHandle | undefined;
let hostBackend: ContainerBackendTransport | undefined;
let store: ReturnType<typeof installAppStorage> | undefined;
let closed = false;
const post = (message: unknown) => port?.postMessage(message);
const calls = createBackendQueue({ post, maxInFlight: 4, maxQueued: 32, timeoutMs: 35_000 });
const saves = createBackendQueue({ post, maxInFlight: 1, maxQueued: STORAGE_LIMITS.outstanding,
  timeoutMs: STORAGE_LIMITS.deadline, firstId: 1_000_000_000 });

function close() {
  if (closed) return;
  closed = true;
  container?.dispose();
  hostBackend?.dispose();
  hostBackend = undefined;
  store?.dispose();
  calls.dispose(BACKEND_UNREADABLE);
  saves.dispose(BACKEND_UNREADABLE);
  port?.close();
}
window.addEventListener('pagehide', event => { if (!event.persisted) close(); });

window.addEventListener('message', async event => {
  if (closed || port || event.source !== parent || event.data?.type !== 'formlogic:init' || !event.ports[0]) return;
  const data = event.data;
  port = event.ports[0];
  let shown = false;
  let pendingNavigate: string | null = null;
  let pendingPlace: string | null = null;
  let lastPostedPlace: string | null = null;
  const emitPlace = (place: string) => {
    if (closed) return;
    if (!shown) {
      pendingPlace = place;
      return;
    }
    if (place === lastPostedPlace) return;
    lastPostedPlace = place;
    post({ type: 'place', place });
  };
  const navigateToPlace = (raw: string) => {
    const parsed = readPlace(raw);
    if (!parsed || !container) return;
    const basePage = parsed.file ?? container.manifest.main;
    const targetUrl = parsed.section
      ? `${basePage.startsWith('/') ? basePage : `/${basePage}`}#${encodeURIComponent(parsed.section)}`
      : basePage;
    void container.navigate(targetUrl).catch(() => {});
  };
  port.onmessage = ({ data }) => {
    if (data?.type === 'formlogic:dispose') { close(); return; }
    if (data?.type === 'formlogic:update') {
      if (!closed) post({ type: 'updated', id: data.id, outcome: 'reopen' });
      return;
    }
    if (data?.type === 'formlogic:navigate' && typeof (data.to ?? data.place) === 'string') {
      const targetStr = String(data.to ?? data.place);
      if (container) navigateToPlace(targetStr);
      else pendingNavigate = targetStr;
      return;
    }
    // Only settle in-flight backend/storage calls for untyped reply packets (never for typed
    // parent control messages that happen to carry a numeric `id`).
    if (data?.type !== undefined) return;
    if (!calls.settle(data?.id, data?.result)) saves.settle(data?.id, data?.result);
  };
  port.onmessageerror = () => { calls.failInFlight(BACKEND_UNREADABLE); saves.failInFlight(BACKEND_UNREADABLE); };
  try {
    if (self.origin !== 'null' || parent === window || !data.native || data.engine !== 'web-container') {
      throw new Error('Open this app from its sandboxed FormLogic frame.');
    }
    const clientEntries = new Map<string, string>();
    for (const [path, content] of Object.entries(data.client ?? {})) {
      if (typeof content === 'string') clientEntries.set(path, content);
    }
    const manifestJson = clientEntries.get('manifest.json');
    const parsedManifest = manifestJson ? JSON.parse(manifestJson) : null;
    const runsInContainer = parsedManifest
      ? manifestRunsInContainer(parsedManifest) || isContainerBundle(parsedManifest, clientEntries)
      : isContainerBundle(null, clientEntries);
    if (!runsInContainer) throw new Error('This project requires the classic SoftN renderer.');
    // Every file under its own path: the media and the archives the app's page nests among them.
    const source = buildContainerSource(clientEntries, data.assets, {
      allowLocalBackend: data.containerBackend !== 'host',
      manifest: parsedManifest,
    });
    const lane = data.storageLane === true ? saves : calls;
    store = installAppStorage(data.storage ?? {}, (input, lifecycle) => lane.call('nativeStorage', input, lifecycle),
      { acknowledged: data.storageProtocol === STORAGE_PROTOCOL, limits: storageLimits(data.storageLimits) });
    const runtimeUrl = containerRuntimeUrl();
    let ownHost = '';
    try { ownHost = normalizeHost(new URL(runtimeUrl).hostname); } catch { ownHost = ''; }
    let full: Promise<WebAssembly.Module> | undefined;
    const fullEngine = () => full ??= calls.call('containerEngine', { sha256: zippSource.sha256 }).then(async answer => {
      const reply = answer as { result?: ArrayBuffer; error?: string };
      if (!(reply?.result instanceof ArrayBuffer)) throw new Error(String(reply?.error || 'The full app engine is unavailable.'));
      return WebAssembly.compile(reply.result);
    }).catch(err => {
      full = undefined;
      throw err;
    });
    const pythonEngine = () => {
      if (data.python !== true) throw new Error('Python is unavailable under the host’s selected engine.');
      return fullEngine();
    };
    const permissions = grantedPermissions(data.permissions);
    const grantedCaps = grantedContainerCapabilities(permissions) as Capability[];
    const allowFiles = permissions.permissions.files?.enabled === true;
    // When FormLogic hosts the container's embedded backend (PHP/Rust/Python/JS/TS + SQLite)
    // multi-user on its server, route all backend HTTP traffic over the authenticated MessagePort.
    hostBackend = data.containerBackend === 'host'
      ? createPortBackendTransport((action, input) => calls.call(action, input))
      : undefined;
    type ErrorPacket = {
      phase: 'load' | 'runtime';
      reason: string;
      file?: string;
      line?: number;
      column?: number;
      snippet?: string;
      stack?: string;
    };
    const bootErrors: ErrorPacket[] = [];
    const buildErrorPacket = (error: unknown, phase: 'load' | 'runtime'): ErrorPacket => {
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 600);
      if (error instanceof SoftNContainerError) {
        return {
          phase,
          reason,
          ...(error.file ? { file: error.file } : {}),
          ...(error.line !== undefined ? { line: error.line } : {}),
          ...(error.column !== undefined ? { column: error.column } : {}),
          ...(error.snippet ? { snippet: error.snippet.slice(0, 1200) } : {}),
          ...(error.guestStack ? { stack: error.guestStack.slice(0, 2000) } : {}),
        };
      }
      const stack = error instanceof Error && typeof error.stack === 'string' ? error.stack.slice(0, 2000) : undefined;
      return { phase, reason, ...(stack ? { stack } : {}) };
    };
    const initialPlace = readPlace(data.place);
    const validPlaceFile =
      initialPlace?.file && Object.prototype.hasOwnProperty.call(source, initialPlace.file)
        ? initialPlace.file
        : null;
    container = await mountSoftNContainer(target, {
      source, appId: data.appId, runtimeUrl, storage: store.storage,
      hostName: 'formlogic',
      // No frames of other sites here, and the app's own nested apps & dynamic previews as anywhere (containerBridge.ts).
      ...FRAME_EMBEDS,
      ...(hostBackend ? { backendTransport: hostBackend } : {}),
      onOfferApp: createBinaryAppOfferHandler((action, input) => calls.call(action, input)),
      initialPage: validPlaceFile ?? undefined,
      ...(initialPlace?.section && (initialPlace.file === null || validPlaceFile !== null)
        ? {
            initialPath: `/${validPlaceFile ?? ''}${initialPlace.section ? `#${encodeURIComponent(initialPlace.section)}` : ''}`,
          }
        : {}),
      onPageChange: (page, manifest) => {
        emitPlace(writePlace({ file: page === manifest.main ? null : page, section: null }));
      },
      onExternalLink: href => {
        if (closed || !shown) return;
        const clean = outsideAddress(href);
        if (!clean) return;
        try {
          if (ownHost && normalizeHost(new URL(clean).hostname) === ownHost) return;
        } catch {
          return;
        }
        post({ type: 'link', href: clean });
      },
      engineWasm: { javascript: fullEngine, python: pythonEngine, 'python-torch': pythonEngine },
      hostThree: () => import('three'), permissionMode: 'deny', permissionsOverride: permissions,
      initialGrantedCapabilities: grantedCaps, downloads: allowFiles ? 'ask' : 'deny',
      theme: data.dark === true ? 'dark' : 'light',
      // Uploads, the app's own routes and FormLogic's page calls (wallet, listening, offers).
      backendCall: frameBackendCall((action, input) => calls.call(action, input)),
      onConsole: (level, text) => {
        const safeText = String(text).slice(0, 1200);
        try {
          if (level === 'error') console.error('[SoftN App]', safeText);
          else if (level === 'warn') console.warn('[SoftN App]', safeText);
          // eslint-disable-next-line no-console
          else console.debug('[SoftN App]', safeText);
        } catch { /* ignore */ }
        if (!closed) {
          post({ type: 'console', level, text: safeText });
          if (level === 'error' && safeText.startsWith('[backend]')) {
            const packet: ErrorPacket = { phase: 'runtime', reason: safeText.slice(0, 600) };
            if (shown) post({ type: 'error', ...packet });
            else if (bootErrors.length < 8) bootErrors.push(packet);
          }
        }
      },
      onError: error => {
        const packet = buildErrorPacket(error, 'runtime');
        if (shown) post({ type: 'error', ...packet });
        else if (bootErrors.length < 8) bootErrors.push(packet);
      },
    });
    if (closed) { container.dispose(); return; }
    shown = true;
    post({ type: 'shown' });
    if (pendingPlace !== null) {
      const queuedPlace = pendingPlace;
      pendingPlace = null;
      emitPlace(queuedPlace);
    }
    if (pendingNavigate !== null) {
      const queuedNav = pendingNavigate;
      pendingNavigate = null;
      navigateToPlace(queuedNav);
    }
    for (const packet of bootErrors) {
      post({ type: 'error', ...packet });
    }
  } catch (error) {
    if (closed) return;
    const reason = error instanceof Error ? error.message.slice(0, 600) : 'The web app could not be opened.';
    target.textContent = reason;
    const extra = error instanceof SoftNContainerError
      ? {
          ...(error.file ? { file: error.file } : {}),
          ...(error.line !== undefined ? { line: error.line } : {}),
          ...(error.column !== undefined ? { column: error.column } : {}),
          ...(error.snippet ? { snippet: error.snippet.slice(0, 1200) } : {}),
          ...(error.guestStack ? { stack: error.guestStack.slice(0, 2000) } : {}),
        }
      : {};
    post({ type: 'error', phase: 'load', reason, ...extra });
  }
});

parent.postMessage({ type: 'formlogic:ready', nativeProtocol: 1, webContainer: 1, containerBackend: 1, places: 1, navigate: 1, links: 1, shown: 1, mediaBytes: 1, binaryAppOffer: 1, dynamicPreview: 1, storageProtocol: STORAGE_PROTOCOL }, '*');
