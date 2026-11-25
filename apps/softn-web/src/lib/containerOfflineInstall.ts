/**
 * Per-app offline install for a web container (an app of plain HTML, CSS and scripts that
 * @softn/container runs in a Worker).
 *
 * Such an app was never installed: its card at Home said "Needs connection" for good, and
 * offline it opened only if everything it needed had happened to pass through the service
 * worker before. What it needs is not what a SoftN app needs (lib/offlineInstall.ts): no
 * component chunks, but the container's own files, which the precache leaves out because
 * most apps are not containers. Read from the app's files, for every page it has:
 *
 *   - the container's Worker;
 *   - for each engine tier a page starts on, that engine and its bindings;
 *   - when a script imports `three`, the page's side of a 3D scene and Three.js, and the
 *     model loader when the app carries a model;
 *   - the code of a `<softn-chart>` or `<softn-datagrid>` it names.
 *
 * Each is fetched through the service worker, which keeps the folder's files by the digest
 * in their address and the chunks by their hashed names, and only when all of them are held
 * does the result say `ready`. The app's own files are in the app cache already.
 */
import type { ContainerRuntimeNeeds, ZippEngineTier } from '@softn/container';
import { hostedContainerFiles, hostedContainerOptions, usesHostEngine } from '@softn/runtime-shell/containerHost';
import { installFullEngine } from './installFullEngine';
import type { OfflineInstallResult } from './offlineInstall';
import { serviceWorkerControls } from './serviceWorkerControls';

export interface ContainerInstallApp {
  /** The cache record's id, which installs dedupe on. */
  id: string;
  /** The app's archive, or its files. */
  source: Uint8Array | Record<string, string | Uint8Array>;
}

/** The parts of @softn/container an install uses; the package itself outside tests. */
export interface ContainerInstallModule {
  containerRuntimeNeeds: (source: ContainerInstallApp['source']) => Promise<ContainerRuntimeNeeds>;
  preloadContainerFeatures: (
    needs: Pick<ContainerRuntimeNeeds, 'three' | 'models' | 'extensions'>,
    options?: { runtimeUrl?: string; hostThree?: () => Promise<unknown> }
  ) => Promise<string[]>;
  engineFileFor: (tier: ZippEngineTier) => string;
  glueFileFor: (tier: ZippEngineTier, meta: Record<string, unknown> | null) => string;
}

export interface ContainerInstallOptions {
  /** Closing the tab that started the install aborts it. */
  signal?: AbortSignal;
  /** Resolves true once something will keep what is fetched: a controlling service worker. */
  cacheHolder?: () => Promise<boolean>;
  fetch?: typeof globalThis.fetch;
  installFullEngine?: typeof installFullEngine;
  /** @softn/container, loaded when the first container app is installed. */
  container?: () => Promise<ContainerInstallModule>;
  /** Where the container's files are and which Three.js a scene is drawn with; this build's outside tests. */
  host?: () => { runtimeUrl: string; hostThree?: () => Promise<unknown> };
}

const inFlight = new Map<string, Promise<OfflineInstallResult>>();

/**
 * Install one container app for offline use. Resolves, never rejects, with what was
 * established; one run per record at a time, as installAppOffline has it.
 */
export function installContainerOffline(app: ContainerInstallApp, options: ContainerInstallOptions = {}): Promise<OfflineInstallResult> {
  const running = inFlight.get(app.id);
  if (running) return running;
  const run: Promise<OfflineInstallResult> = performInstall(app, options)
    .catch((err): OfflineInstallResult => ({
      ready: false,
      features: [],
      missing: [],
      workerAssets: 'not-needed',
      optionalOnline: [],
      error: `The app's files could not be read: ${err instanceof Error ? err.message : String(err)}`,
    }))
    .finally(() => {
      if (inFlight.get(app.id) === run) inFlight.delete(app.id);
    });
  inFlight.set(app.id, run);
  return run;
}

async function performInstall(app: ContainerInstallApp, options: ContainerInstallOptions): Promise<OfflineInstallResult> {
  const { signal } = options;
  const result: OfflineInstallResult = { ready: false, features: [], missing: [], workerAssets: 'not-needed', optionalOnline: [] };
  const cancelled = (): OfflineInstallResult => ({ ...result, ready: false, error: 'The install was cancelled.' });
  if (signal?.aborted) return cancelled();

  // Something has to keep what is fetched, or none of it outlasts the tab.
  const held = await (options.cacheHolder ?? serviceWorkerControls)();
  if (signal?.aborted) return cancelled();
  if (!held) {
    result.error =
      'No service worker controls this page yet, so nothing fetched now would be kept; the install runs again the next time the app opens.';
    return result;
  }

  const container = await (options.container ?? (() => import('@softn/container') as Promise<ContainerInstallModule>))();
  const needs = await container.containerRuntimeNeeds(app.source);
  if (signal?.aborted) return cancelled();
  const host = (options.host ?? hostedContainerOptions)();
  result.features = [
    ...needs.tiers.map((tier) => `engine:${tier}`),
    ...(needs.three ? ['three'] : []),
    ...needs.extensions,
  ].sort();

  // The folder's files, past the HTTP cache so that each reaches the service worker's route
  // (which answers from its own copy when it has one, and fetches and keeps it when not).
  const fetchFn = options.fetch ?? fetch;
  const files = hostedContainerFiles(needs.tiers, container, host.runtimeUrl, { backend: Boolean(needs.sqlite) });
  const fullEngine = usesHostEngine(needs.tiers)
    ? (options.installFullEngine ?? installFullEngine)(signal).then(() => true, () => false)
    : true;
  let workerScriptText = '';
  const fetched = await Promise.all(
    files.map(async (url) => {
      try {
        const response = await fetchFn(url, { cache: 'reload', credentials: 'same-origin', signal });
        // The body is read to its end: a response cut short is not a file held.
        if (response.ok) {
          const buf = await response.arrayBuffer();
          if (url.endsWith('/container-worker.js') && buf.byteLength > 32) {
            workerScriptText = new TextDecoder().decode(buf);
          }
        }
        return response.ok;
      } catch {
        return false;
      }
    })
  );
  if (!(await fullEngine)) result.missing.push('engine:full');
  if (signal?.aborted) return cancelled();
  files.forEach((url, index) => {
    if (!fetched[index]) result.missing.push(url.slice(host.runtimeUrl.length));
  });

  // Also cache static shared `worker-chunks/chunk-*.js` and any optional `worker-chunks/*.js`
  // or Worker-side `vendor/three.js` referenced by the built `container-worker.js`.
  if (workerScriptText) {
    const extraFiles = new Set<string>();
    const wantedChunkPrefixes: string[] = ['chunk-'];
    const wf = new Set(needs.workerFeatures ?? []);
    if (needs.three) wantedChunkPrefixes.push('three-worker-host-', 'guest-three-native-');
    if (needs.three || wf.has('webgl')) wantedChunkPrefixes.push('webgl-worker-host-', 'guest-webgl-');
    if (wf.has('indexeddb')) wantedChunkPrefixes.push('guest-indexeddb-');
    if (wf.has('react')) wantedChunkPrefixes.push('guest-react-vendor-');
    if (wf.has('jsx')) wantedChunkPrefixes.push('jsx-transform-');
    if (wf.has('worker')) wantedChunkPrefixes.push('guest-worker-scope-');
    if (wf.has('vendors')) wantedChunkPrefixes.push('guest-vendors-');
    for (const m of workerScriptText.matchAll(/["']\.\/(worker-chunks\/[A-Za-z0-9._-]+\.js)["']/g)) {
      const rel = m[1];
      const baseName = rel.slice('worker-chunks/'.length);
      if (wantedChunkPrefixes.some((p) => baseName.startsWith(p))) {
        extraFiles.add(rel);
      }
    }
    if (needs.three) {
      extraFiles.add('vendor/three.js');
      if (needs.models) extraFiles.add('vendor/gltf-loader.js');
    }
    if (extraFiles.size > 0) {
      const extraList = [...extraFiles];
      const extraOk = await Promise.all(
        extraList.map(async (rel) => {
          try {
            const response = await fetchFn(host.runtimeUrl + rel, { cache: 'reload', credentials: 'same-origin', signal });
            if (response.ok) await response.arrayBuffer();
            return response.ok;
          } catch {
            return false;
          }
        })
      );
      if (signal?.aborted) return cancelled();
      extraList.forEach((rel, index) => {
        if (!extraOk[index]) result.missing.push(rel);
      });
    }
  }

  // What the container loads the first time an app draws a scene or names one of its elements.
  const absent = await container.preloadContainerFeatures(needs, host);
  if (signal?.aborted) return cancelled();
  result.missing.push(...absent);

  result.ready = result.missing.length === 0;
  return result;
}
