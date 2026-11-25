/**
 * What a host that carries @softn/core hands @softn/container: where the container's own
 * files are, and the engine the host already has.
 *
 * The container runs an app on the smallest ZIPP engine that can run it. Two of its engines
 * do something core's cannot: `lite` starts a plain web app on 2.8 MB instead of 6.6, and
 * `typescript` runs TypeScript. The other tiers ask for nothing more than the
 * JavaScript-and-Python engine, which is the engine every SoftN host runs its v1 apps on and
 * hosts download when an app needs it: the Python tiers
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
import type { SoftNContainerOptions, ZippEngineTier } from '@softn/container';

interface HostEnv {
  BASE_URL?: string;
  /** Written by containerRuntimeAssetPlugin: the folder of this build, or the site's one shared folder. */
  VITE_SOFTN_CONTAINER_RUNTIME?: string;
  /** A shared deployment keeps a tiny worker entry in each host's own service-worker scope. */
  VITE_SOFTN_CONTAINER_WORKER?: string;
}

/**
 * Where this build keeps the container's Worker and engine files, ending in `/`. A build names its folder by the digest of what is in it, so a file of one release is
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
const coreEngine = (): Promise<WebAssembly.Module> =>
  import('@softn/core/web-host').then((m) => m.zippEngineForWorker());

/**
 * The app's own Three.js, which every SoftN host bundles for its 3D components: the chunk
 * a `<Scene3D>` loads, fetched when a container first draws a scene. The folder's copy
 * (`vendor/three.js`) was the same library again, and the model loader the container is
 * compiled with is bound to this one.
 */
const ownThree = (): Promise<unknown> => import('three');

/**
 * The options every SoftN host mounts a container with: its files' folder, core's engine
 * for every tier the folder holds no engine for, and the host's own Three.js. The container
 * loads the bindings that go with the engine it is handed, so core's runs under its own
 * whichever tier asked.
 */
export function hostedContainerOptions(
  env: HostEnv | undefined = (import.meta as unknown as { env?: HostEnv }).env
): Required<Pick<SoftNContainerOptions, 'runtimeUrl' | 'engineWasm' | 'hostThree'>> & Pick<SoftNContainerOptions, 'workerUrl'> {
  return {
    runtimeUrl: containerRuntimeUrl(env),
    ...(env?.VITE_SOFTN_CONTAINER_WORKER ? { workerUrl: `${(env.BASE_URL ?? './').replace(/\/?$/, '/')}${env.VITE_SOFTN_CONTAINER_WORKER}` } : {}),
    engineWasm: { javascript: coreEngine, python: coreEngine, 'python-torch': coreEngine },
    hostThree: ownThree,
  };
}

/** The tiers given core's engine above, and what that engine says it is (the container picks its bindings by it). */
const CORE_ENGINE_TIERS: ReadonlySet<ZippEngineTier> = new Set(['javascript', 'python', 'python-torch']);
const CORE_ENGINE_META = { variant: 'javascript-python-base' };

export function usesHostEngine(tiers: readonly ZippEngineTier[]): boolean {
  // Python tiers always need core's JS+Python engine. Full JS (`javascript`) is already
  // covered natively by `zipp-php.wasm`, `zipp-rust.wasm`, or `zipp-typescript.wasm` when
  // one of those backend/frontend tiers is present (reused via `sharedLocalBackendEngine`).
  if (tiers.includes('python') || tiers.includes('python-torch')) return true;
  if (!tiers.includes('javascript')) return false;
  return !tiers.includes('php') && !tiers.includes('rust') && !tiers.includes('typescript');
}

/**
 * The files of the container's folder an app on `tiers` is run with, as whole addresses: the
 * Worker, each tier's bindings, and the engine of a tier whose engine is the folder's. A tier
 * that runs on core's engine fetches it at the host's own URL and
 * runs under that engine's bindings.
 *
 * For a host that installs an app before the network goes (the runtime's offline install).
 * The two functions are the container's own, handed in so that this module, which the shell
 * loads at once, does not bring the container with it.
 */
export function hostedContainerFiles(
  tiers: readonly ZippEngineTier[],
  container: {
    engineFileFor: (tier: ZippEngineTier) => string;
    glueFileFor: (tier: ZippEngineTier, meta: Record<string, unknown> | null) => string;
  },
  runtimeUrl: string = containerRuntimeUrl(),
  options?: { backend?: boolean }
): string[] {
  const files = new Set<string>(['container-worker.js']);
  const needsBackend = Boolean(options?.backend) || tiers.includes('php') || tiers.includes('rust');
  if (needsBackend) {
    files.add('backend-worker.js');
    files.add('engines/xdb-wasm.wasm');
    files.add('engines/xdb-wasm.glue.js');
  }
  for (const tier of tiers) {
    if (CORE_ENGINE_TIERS.has(tier)) {
      files.add(`engines/${container.glueFileFor(tier, CORE_ENGINE_META)}`);
    } else {
      files.add(`engines/${container.engineFileFor(tier)}`);
      files.add(`engines/${container.glueFileFor(tier, null)}`);
    }
  }
  return [...files].map((file) => runtimeUrl + file);
}
