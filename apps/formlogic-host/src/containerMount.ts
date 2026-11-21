/**
 * Dynamic-imported v2 Web Container mounter for `apps/formlogic-host`.
 *
 * Loaded only when an app's manifest declares a v2 Web Container (`engine: 2`,
 * `container: true`, `backend`, or zero-config HTML), leaving v1's startup graph
 * completely untouched.
 */
import { zippEngineForWorker, type PermissionConfig } from '@softn/core';
import {
  mountSoftNContainer,
  type ContainerPermissions,
  type ZippEngineSupplier,
  type ZippEngineTier,
} from '@softn/container';
import { hostedContainerOptions } from '@softn/runtime-shell/containerHost';
import type { Capability } from '@softn/bundle-format/capabilities';
import {
  buildContainerSource,
  createPortBackendTransport,
  grantedContainerCapabilities,
  type FrameBackendCall,
} from './containerBridge';

export interface MountHostedContainerOptions {
  files: ReadonlyMap<string, string>;
  assets: Record<string, unknown> | undefined;
  appId: string;
  dark: boolean;
  native: boolean;
  containerBackend?: unknown;
  containerEngines?: Record<string, unknown>;
  permissions: PermissionConfig;
  backendCall: FrameBackendCall;
  port: MessagePort | undefined;
  markShown: () => boolean;
  onError: (err: unknown) => void;
}

export async function mountHostedContainer(
  hostEl: HTMLElement,
  opts: MountHostedContainerOptions
): Promise<() => void> {
  const source = buildContainerSource(opts.files, opts.assets);
  const base = hostedContainerOptions();
  // FormLogic strips embedded `.wasm` engine copies from `hosted-runtime/` and
  // supplies the ZIPP engine over the initialization channel (`zippEngineForWorker`).
  // Supply it as the fallback for `lite` as well, and merge any additional
  // engine buffers (`php`, `typescript`, `rust`, `lite`) the parent supplied.
  const coreEngine = () => zippEngineForWorker();
  const engineWasm: Partial<Record<ZippEngineTier, ZippEngineSupplier>> = {
    ...base.engineWasm,
    lite: coreEngine,
  };
  if (opts.containerEngines && typeof opts.containerEngines === 'object') {
    for (const [tier, value] of Object.entries(opts.containerEngines)) {
      if (value instanceof ArrayBuffer) {
        engineWasm[tier as ZippEngineTier] = () => WebAssembly.compile(value);
      } else if (value instanceof WebAssembly.Module) {
        engineWasm[tier as ZippEngineTier] = () => Promise.resolve(value);
      }
    }
  }

  const useHostBackend = opts.native || opts.containerBackend === 'host';
  const granted = grantedContainerCapabilities(opts.permissions as unknown as { permissions?: Record<string, { enabled?: boolean } | undefined> });

  const handle = await mountSoftNContainer(hostEl, {
    source,
    runtimeUrl: base.runtimeUrl,
    engineWasm,
    hostThree: base.hostThree,
    appId: opts.appId || 'formlogic-container',
    theme: opts.dark ? 'dark' : 'light',
    persistStorage: false,
    permissionMode: 'deny',
    initialGrantedCapabilities: granted as Capability[],
    permissionsOverride: opts.permissions as unknown as ContainerPermissions,
    ...(useHostBackend ? { backendTransport: createPortBackendTransport(opts.backendCall) } : {}),
    onError: (err) => opts.onError(err),
  });

  if (opts.markShown()) {
    opts.port?.postMessage({ type: 'shown' });
  }
  return () => handle.dispose();
}
