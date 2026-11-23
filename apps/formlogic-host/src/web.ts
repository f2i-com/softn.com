import { mountSoftNContainer, SoftNContainerError, type SoftNContainerHandle } from '@softn/container';
import { manifestRunsInContainer } from '@softn/bundle-format/engine';
import { containerRuntimeUrl } from '@softn/runtime-shell/containerHost';
import type { Capability } from '@softn/bundle-format/capabilities';
import { createBackendQueue, BACKEND_UNREADABLE } from './backendQueue';
import {
  createPortBackendTransport,
  grantedContainerCapabilities,
  isContainerBundle,
  isSafeClientPath,
  isSafeLocalContainerPath,
  type ContainerBackendTransport,
} from './containerBridge';
import { bytesOf } from './media';
import { outsideAddress } from './links';
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
    const allowLocalBackend = data.containerBackend !== 'host';
    const allowPath = allowLocalBackend
      ? isSafeLocalContainerPath
      : (path: string) => isSafeClientPath(path, parsedManifest);
    const source: Record<string, string | Uint8Array> = Object.create(null);
    for (const [path, content] of clientEntries.entries()) {
      if (allowPath(path)) source[path] = content;
    }
    for (const [path, content] of Object.entries(data.assets ?? {})) {
      const bytes = bytesOf(content);
      if (bytes && allowPath(path)) source[path] = bytes;
    }
    const lane = data.storageLane === true ? saves : calls;
    store = installAppStorage(data.storage ?? {}, (input, lifecycle) => lane.call('nativeStorage', input, lifecycle),
      { acknowledged: data.storageProtocol === STORAGE_PROTOCOL, limits: storageLimits(data.storageLimits) });
    const runtimeUrl = containerRuntimeUrl();
    let ownHost = '';
    try { ownHost = new URL(runtimeUrl).hostname; } catch { ownHost = ''; }
    let full: Promise<WebAssembly.Module> | undefined;
    const fullEngine = () => full ??= calls.call('containerEngine', { sha256: zippSource.sha256 }).then(async answer => {
      const reply = answer as { result?: ArrayBuffer; error?: string };
      if (!(reply?.result instanceof ArrayBuffer)) throw new Error(String(reply?.error || 'The full app engine is unavailable.'));
      return WebAssembly.compile(reply.result);
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
    container = await mountSoftNContainer(target, {
      source, appId: data.appId, runtimeUrl, storage: store.storage,
      ...(hostBackend ? { backendTransport: hostBackend } : {}),
      initialPage: initialPlace?.file ?? undefined,
      ...(initialPlace?.section
        ? {
            initialPath: `/${initialPlace.file ?? ''}${initialPlace.section ? `#${encodeURIComponent(initialPlace.section)}` : ''}`,
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
          if (ownHost && new URL(clean).hostname === ownHost) return;
        } catch {
          return;
        }
        post({ type: 'link', href: clean });
      },
      engineWasm: { javascript: fullEngine, python: pythonEngine, 'python-torch': pythonEngine },
      hostThree: () => import('three'), permissionMode: 'deny', permissionsOverride: permissions,
      initialGrantedCapabilities: grantedCaps, downloads: allowFiles ? 'ask' : 'deny',
      theme: data.dark === true ? 'dark' : 'light',
      backendCall: (action, input) => {
        if (action === 'formlogicUpload') {
          if (!input || typeof input !== 'object' || Array.isArray(input)) {
            return Promise.resolve({ error: 'Invalid upload request.' });
          }
          const op = input.op === undefined ? 'upload' : input.op;
          if (op !== 'upload' && op !== 'list' && op !== 'delete') {
            return Promise.resolve({ error: 'Unsupported upload operation.' });
          }
          if (op === 'delete') {
            if (typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{4,64}$/.test(input.id.trim())) {
              return Promise.resolve({ error: 'Invalid upload id.' });
            }
          } else if (op === 'upload') {
            if (
              typeof input.contentBase64 !== 'string' ||
              input.contentBase64.length === 0 ||
              input.contentBase64.length > 34 * 1024 * 1024 ||
              (input.filename !== undefined && typeof input.filename !== 'string') ||
              (input.mimeType !== undefined && typeof input.mimeType !== 'string') ||
              (input.folder !== undefined && typeof input.folder !== 'string')
            ) {
              return Promise.resolve({ error: 'Invalid upload payload.' });
            }
          } else if (input.folder !== undefined && typeof input.folder !== 'string') {
            return Promise.resolve({ error: 'Invalid upload folder.' });
          }
          return calls.call('formlogicUpload', input);
        }
        const pathOnly = typeof input.url === 'string' ? input.url.split('?')[0] : '';
        if (
          action !== 'nativeRequest' ||
          typeof input.url !== 'string' ||
          input.url.length > 2048 ||
          /[\r\n\0]/.test(input.url) ||
          !/^\/api\/[A-Za-z0-9_.%~/-]+(?:\?[^#]*)?$/.test(input.url) ||
          /(?:^|\/)\.\.(?:\/|$)/.test(pathOnly) ||
          /%(?:2e|2f|5c|00|25)/i.test(pathOnly)
        ) {
          return Promise.resolve({ error: 'Use an app-relative API route under /api/.' });
        }
        return calls.call('nativeRequest', input);
      },
      onConsole: (level, text) => {
        const safeText = String(text).slice(0, 1200);
        try {
          if (level === 'error') console.error('[SoftN App]', safeText);
          else if (level === 'warn') console.warn('[SoftN App]', safeText);
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

parent.postMessage({ type: 'formlogic:ready', nativeProtocol: 1, webContainer: 1, containerBackend: 1, places: 1, navigate: 1, links: 1, shown: 1, mediaBytes: 1, storageProtocol: STORAGE_PROTOCOL }, '*');
