/**
 * What a host that carries @softn/core hands @softn/container: where the container's own
 * files are, and the engine the host already has.
 *
 * The container runs an app on the smallest ZIPP engine that can run it. Two of its engines
 * do something core's cannot: `lite` starts a plain web app on 2.8 MB instead of 6.6, and
 * `typescript` runs TypeScript. The other tiers ask for nothing more than the
 * JavaScript-and-Python engine, which is the engine every SoftN host runs its v1 apps on and
 * most have on the device already (the runtime and the editors install it): the Python tiers
 * are that engine, and the `javascript` tier is its JavaScript, `Intl` and `Temporal`
 * included. A host that also kept those engines in the container's folder shipped the first
 * twice and a 4.9 MB subset of it once more (v0.0.43 did, in each of four apps). So the
 * container's folder in a SoftN host holds only `lite` and `typescript`
 * (scripts/build/container-runtime-assets.mjs), and the other tiers are given core's: the
 * one module the page compiles for itself and for every worker it starts.
 *
 * Every host mounts with these options (the web runtime and the single-app shell through
 * WebContainerView, Studio and Builder through their previews), so none of them can name a
 * folder the build did not write or ask the folder for an engine it does not hold.
 */
import { zippEngineForWorker } from '@softn/core';
import type { SoftNContainerOptions } from '@softn/container';

interface HostEnv {
  BASE_URL?: string;
  /** Written by containerRuntimeAssetPlugin: the folder of this build, or the site's one shared folder. */
  VITE_SOFTN_CONTAINER_RUNTIME?: string;
}

/**
 * Where this build keeps the container's Worker, engine files and vendor modules, ending in
 * `/`. A build names its folder by the digest of what is in it, so a file of one release is
 * never answered from a cache for another; the site names one folder for all its apps. The
 * dev server, which serves the files straight from the package, has no digest to name.
 */
export function containerRuntimeUrl(
  env: HostEnv | undefined = (import.meta as unknown as { env?: HostEnv }).env,
  pageUrl: string | undefined = typeof document !== 'undefined' ? document.baseURI : undefined
): string {
  const base = (env?.BASE_URL ?? './').replace(/\/?$/, '/');
  const named = env?.VITE_SOFTN_CONTAINER_RUNTIME;
  const folder = !named ? `${base}assets/container-runtime/` : named.startsWith('/') ? named : `${base}${named}`;
  // A whole address, made once against the page. The folder is read from three places: the
  // page (the engine), the Worker (the engine's bindings) and the app's own chunks (a hosted
  // module), and a relative folder means a different place to each. In a build whose base is
  // `./` (the single-app shell, the desktop Builder) the Worker asked for its bindings at
  // `…/assets/container-runtime/assets/container-runtime/…` and found nothing there.
  if (!pageUrl) return folder;
  try {
    return new URL(folder, pageUrl).href;
  } catch {
    return folder;
  }
}

/** Core's engine, compiled once for the page: asked for only when an app needs one of its tiers. */
const coreEngine = (): Promise<WebAssembly.Module> => zippEngineForWorker();

/**
 * The options every SoftN host mounts a container with: its files' folder, and core's engine
 * for every tier the folder holds no engine for. The container loads the bindings that go
 * with the engine it is handed, so core's runs under its own whichever tier asked.
 */
export function hostedContainerOptions(): Required<Pick<SoftNContainerOptions, 'runtimeUrl' | 'engineWasm'>> {
  return {
    runtimeUrl: containerRuntimeUrl(),
    engineWasm: { javascript: coreEngine, python: coreEngine, 'python-torch': coreEngine },
  };
}
