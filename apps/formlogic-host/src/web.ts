import { mountSoftNContainer, type SoftNContainerHandle } from '@softn/container';
import { manifestRunsInContainer } from '@softn/bundle-format/engine';
import { containerRuntimeUrl } from '@softn/runtime-shell/containerHost';
import type { Capability } from '@softn/bundle-format/capabilities';
import { createBackendQueue, BACKEND_UNREADABLE } from './backendQueue';
import {
  createPortBackendTransport,
  grantedContainerCapabilities,
  isContainerBundle,
  isSafeClientPath,
  type ContainerBackendTransport,
} from './containerBridge';
import { bytesOf } from './media';
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
  port.onmessage = ({ data }) => {
    if (data?.type === 'formlogic:dispose') { close(); return; }
    if (!calls.settle(data?.id, data?.result)) saves.settle(data?.id, data?.result);
  };
  port.onmessageerror = () => { calls.failInFlight(BACKEND_UNREADABLE); saves.failInFlight(BACKEND_UNREADABLE); };
  let shown = false;
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
    const source: Record<string, string | Uint8Array> = Object.create(null);
    for (const [path, content] of clientEntries.entries()) {
      if (isSafeClientPath(path)) source[path] = content;
    }
    for (const [path, content] of Object.entries(data.assets ?? {})) {
      const bytes = bytesOf(content);
      if (bytes && isSafeClientPath(path)) source[path] = bytes;
    }
    const lane = data.storageLane === true ? saves : calls;
    store = installAppStorage(data.storage ?? {}, (input, lifecycle) => lane.call('nativeStorage', input, lifecycle),
      { acknowledged: data.storageProtocol === STORAGE_PROTOCOL, limits: storageLimits(data.storageLimits) });
    const runtimeUrl = containerRuntimeUrl();
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
    container = await mountSoftNContainer(target, {
      source, appId: data.appId, runtimeUrl, storage: store.storage,
      ...(hostBackend ? { backendTransport: hostBackend } : {}),
      initialPage: readPlace(data.place)?.file ?? undefined,
      onPageChange: (page, manifest) => {
        if (!closed) post({ type: 'place', place: writePlace({ file: page === manifest.main ? null : page, section: null }) });
      },
      onExternalLink: href => { if (!closed) post({ type: 'link', href }); },
      engineWasm: { javascript: fullEngine, python: pythonEngine, 'python-torch': pythonEngine },
      hostThree: () => import('three'), permissionMode: 'deny', permissionsOverride: permissions,
      initialGrantedCapabilities: grantedCaps, downloads: allowFiles ? 'ask' : 'deny',
      theme: data.dark === true ? 'dark' : 'light',
      backendCall: (action, input) => {
        if (action !== 'nativeRequest' || typeof input.url !== 'string' || !/^\/api\/[A-Za-z0-9_/-]+(?:\?[^#]*)?$/.test(input.url)) {
          return Promise.resolve({ error: 'Use an app-relative API route under /api/.' });
        }
        return calls.call('nativeRequest', input);
      },
      onError: error => { if (shown) post({ type: 'error', phase: 'runtime', reason: error.message.slice(0, 300) }); },
    });
    if (closed) { container.dispose(); return; }
    shown = true;
    post({ type: 'shown' });
  } catch (error) {
    if (closed) return;
    const reason = error instanceof Error ? error.message.slice(0, 300) : 'The web app could not be opened.';
    target.textContent = reason;
    post({ type: 'error', phase: 'load', reason });
  }
});

parent.postMessage({ type: 'formlogic:ready', nativeProtocol: 1, webContainer: 1, containerBackend: 1, places: 1, links: 1, shown: 1, mediaBytes: 1, storageProtocol: STORAGE_PROTOCOL }, '*');
