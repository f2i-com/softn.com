/**
 * What an app will ask the runtime for, read from its files without running it.
 *
 * A host that installs an app for use without a network has to hold, before the network goes,
 * everything the container fetches the first time an app needs it: the engine of each tier a
 * page of the app starts on (a page with TypeScript and a page without are two tiers), the
 * page's side of a 3D scene, the model loader, a `<softn-*>` element's code. The container
 * decides each of those when the page that needs it is shown; this decides them for every
 * page at once, by the same rules.
 */
import { ContainerArchive } from './archive';
import { prepareHtmlDocument } from './sanitize';
import { selectEngineTier } from './zipp-loader';
import type { ZippEngineTier } from './types';

export interface ContainerRuntimeNeeds {
  /** Every engine tier one of the app's pages or embedded backend starts on, each once. */
  tiers: ZippEngineTier[];
  /** A script imports `three`: the page's side of a 3D scene is loaded when one is drawn. */
  three: boolean;
  /** The app carries a glTF model, which a scene loads with the model loader. */
  models: boolean;
  /** The built-in `<softn-*>` elements its pages or scripts name (`softn-chart`, `softn-datagrid`). */
  extensions: string[];
  /** Whether the app embeds a backend or SQLite database (requires `xdb-wasm.wasm` and `backend-worker.js`). */
  sqlite?: boolean;
}

/** The `<softn-*>` elements whose code the container carries itself (ui-extensions/registry.ts). */
const BUILT_IN_EXTENSIONS = ['softn-chart', 'softn-datagrid'] as const;

const TEXT_FILE = /\.(?:html?|m?js|jsx|ts|tsx|mts|py|css|json|svg|txt|md)$/i;
const SCRIPT_FILE = /\.(?:html?|m?js|jsx|ts|tsx|mts)$/i;
const IMPORTS_THREE = /\bfrom\s*['"]three(?:\/[^'"]*)?['"]|\bimport\s*\(\s*['"]three(?:\/[^'"]*)?['"]\s*\)|\bimport\s*['"]three(?:\/[^'"]*)?['"]/;
const MODEL_FILE = /\.(?:glb|gltf)$/i;

export async function containerRuntimeNeeds(
  source: Uint8Array | ArrayBuffer | Record<string, string | Uint8Array>
): Promise<ContainerRuntimeNeeds> {
  const archive = await ContainerArchive.open(source instanceof ArrayBuffer ? new Uint8Array(source) : source);
  try {
    const needs: ContainerRuntimeNeeds = { tiers: [], three: false, models: false, extensions: [] };
    // A SoftN `.ui` bundle the element was handed is not the container's to run.
    if (archive.manifest.mode === 'legacy-ui') return needs;

    const names = archive.names();
    // Text only, and only what is read as text: a picture is not inflated to be looked through.
    const textFiles: Record<string, string> = Object.create(null);
    for (const name of names) {
      if (!TEXT_FILE.test(name)) continue;
      const text = archive.readText(name);
      if (text !== null) textFiles[name] = text;
    }

    const tiers = new Set<ZippEngineTier>();
    const pages = names.filter((name) => /\.html?$/i.test(name));
    for (const page of pages.length > 0 ? pages : [archive.manifest.main]) {
      const html = textFiles[page] ?? archive.readText(page);
      if (html === null || html === undefined) continue;
      const prepared = prepareHtmlDocument(html, page, archive, archive.permissions, false);
      tiers.add(selectEngineTier(prepared.scripts, textFiles, archive.manifest.pythonPackages));
    }
    if (archive.manifest.backend) {
      const rt = archive.manifest.backend.runtime;
      tiers.add(
        rt === 'rust' ? 'rust' : rt === 'php' ? 'php' : rt === 'typescript' ? 'typescript' : rt === 'python' ? 'python' : 'javascript'
      );
      if (tiers.size === 1) tiers.add('lite');
    }
    if (archive.manifest.backend || (archive.manifest.databases && archive.manifest.databases.length > 0)) {
      needs.sqlite = true;
    }
    needs.tiers = [...tiers];

    const scripts = Object.entries(textFiles).filter(([name]) => SCRIPT_FILE.test(name));
    needs.three = scripts.some(([, text]) => IMPORTS_THREE.test(text));
    needs.models = names.some((name) => MODEL_FILE.test(name));
    needs.extensions = BUILT_IN_EXTENSIONS.filter((tag) => scripts.some(([, text]) => text.includes(tag)));
    return needs;
  } finally {
    archive.dispose();
  }
}

/**
 * Load, and so let a service worker keep, the parts of the container that are fetched when an
 * app first needs them. Resolves with the names of the ones that did not arrive.
 *
 * `hostThree` is the embedding app's own Three.js, as given to `mountSoftNContainer`; without
 * it the copy in the runtime folder (`vendor/three.js`) is the one a scene would load.
 */
export async function preloadContainerFeatures(
  needs: Pick<ContainerRuntimeNeeds, 'three' | 'models' | 'extensions'>,
  options: { runtimeUrl?: string; hostThree?: () => Promise<unknown> } = {}
): Promise<string[]> {
  const wanted: Array<[string, () => Promise<unknown>]> = [];
  if (needs.three) {
    wanted.push(['3D scenes', () => import('./vendor/webgl-scene-host')]);
    const base = (options.runtimeUrl ?? '/runtime/').replace(/\/?$/, '/');
    wanted.push(['Three.js', options.hostThree ?? (() => import(/* @vite-ignore */ `${base}vendor/three.js`))]);
    if (needs.models) wanted.push(['the model loader', () => import('three/examples/jsm/loaders/GLTFLoader.js')]);
  }
  for (const tag of needs.extensions) {
    if (tag === 'softn-chart') wanted.push([tag, () => import('./ui-extensions/chart')]);
    else if (tag === 'softn-datagrid') wanted.push([tag, () => import('./ui-extensions/datagrid')]);
  }
  const missing: string[] = [];
  await Promise.all(
    wanted.map(([name, load]) =>
      load().then(
        () => undefined,
        () => {
          missing.push(name);
        }
      )
    )
  );
  return missing.sort();
}
