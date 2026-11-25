/**
 * Prune unused optional runtime libraries and WASM engines from a concrete
 * standalone hosted SoftN app deployment (`template: false`).
 *
 * Template deployments (and the multi-app /play/ shell) keep every optional
 * library available for dynamic on-demand loading. When packaging one known
 * app into its own standalone deployment, we already have its full client
 * archive and manifest, so unused heavy assets (Three.js + 19 JSM loaders,
 * zxing QR decoder WASM, Torch WASM, AI workers, unused ZIPP engine tiers,
 * unused worker-chunks, classic/container runtime halves) can be omitted
 * safely with zero risk to runtime behavior.
 */

import { threeAddonChunks } from './on-demand-chunks.mjs';

const TEXT_EXT_RE = /\.(?:html?|ui|logic|js|mjs|cjs|ts|tsx|mts|jsx|py|json|css|svg)$/i;
const PRIVATE_PREFIX_RE = /^(?:server|backend|private)\//i;

const NEEDS_FULL_JAVASCRIPT_RE =
  /\b(?:Intl|Temporal)\b|\.(?:toLocale(?:String|DateString|TimeString|UpperCase|LowerCase)|localeCompare)\b/;
const USES_THREE_RE =
  /\b(?:THREE\s*\.\s*[A-Z]|GLTFLoader|OrbitControls|OBJLoader|FBXLoader|STLLoader|WebGLRenderer|isWebGLRenderer|Scene3D|SceneAnchor)\b|['"](?:three(?:\/[^'"]*)?|softn-vendor:three)['"]|\.(?:glb|gltf)\b/;
const USES_WEBGL_RE =
  /\b(?:webgl2?|experimental-webgl|WebGLRenderingContext|WebGL2RenderingContext|WebGLRenderer)\b|['"](?:three(?:\/[^'"]*)?|softn-vendor:three|babylonjs|@babylonjs\/core|pixi\.js|regl|twgl\.js|playcanvas)['"]|getContext\s*\(\s*(?!['"]2d['"])/;
const USES_IDB_RE =
  /\b(?:indexedDB|webkitIndexedDB|mozIndexedDB|IDBKeyRange|IDBDatabase|IDBRequest|IDBTransaction|IDBObjectStore|IDBIndex|IDBCursor|Dexie|localforage|openDB)\b|['"](?:idb|dexie|localforage)['"]/;
const USES_REACT_VENDOR_RE =
  /['"](?:react|react-dom(?:\/client)?|react\/jsx(?:-dev)?-runtime|softn-vendor:react[^'"]*)['"]/;
const USES_WORKER_SCOPE_RE = /\b(?:new\s+Worker|SharedWorker)\s*\(/;
const USES_TORCH_RE = /\b(?:import\s+torch|from\s+torch)\b/;
const USES_AI_RE = /\b(?:softn\.ai|window\.ai|gguf|model-worker|webgpu)\b/i;
const USES_SYNC_RE = /\b(?:softn\.sync|xdb-sync|serverSync|syncServer|Y\.Doc)\b/;
const USES_WASM_RE = /\b(?:softn\.wasm|WasmApp|WebAssembly)\b/i;

const CLASSIC_FEATURE_TAG_PATTERNS = {
  charts: /<(?:LineChart|BarChart|PieChart|AreaChart|RadarChart|GaugeChart)\b/i,
  editors: /<(?:CodeEditor|MarkdownEditor|RichTextEditor)\b/i,
  smart: /<(?:SmartGrid|SmartView|SmartForm|SmartStats|SmartCards|SmartList|SmartTimeline)\b/i,
  media: /<(?:Camera|Microphone|AudioStream|QRCode|QRReader)\b/i,
  animation: /<(?:AnimatedBox|AnimatedNumber|Marquee|Typewriter|Draggable|SortableList|PanView|Sprite|TileMap)\b/i,
  pickers: /<(?:DatePicker|ColorPicker)\b/i,
  games: /<(?:PixelGrid|PixelCanvas|DPad|Controls)\b/i,
  wasm: /<WasmApp\b/i,
};

const CLASSIC_ONLY_CHUNKS = [
  'UiApplicationSurface',
  'charts',
  'editors',
  'smart',
  'media',
  'qr-reader',
  'animation',
  'pickers',
  'games',
  'controls',
  'feedback',
  'data',
  'display',
  'navigation',
];

// Three.js addon prefixes are matched directly via `threeAddonChunks`.

function readClientText(bytes) {
  if (typeof bytes === 'string') return bytes;
  return Buffer.from(bytes).toString('utf8');
}

function hasCapability(manifest, permissionsJson, cap) {
  if (Array.isArray(manifest?.capabilities) && manifest.capabilities.includes(cap)) return true;
  const perms = permissionsJson?.permissions ?? manifest?.permissions;
  if (perms && typeof perms === 'object' && perms[cap]) {
    if (perms[cap] === true) return true;
    if (typeof perms[cap] === 'object' && perms[cap].enabled !== false) return true;
  }
  return false;
}

/**
 * Conservatively analyze what optional libraries, component features, and WASM
 * engines a concrete `.softn` client archive needs. When uncertain, returns
 * `true` so nothing required is ever pruned.
 *
 * @param {Record<string, any>} manifest
 * @param {Record<string, Uint8Array | Buffer | string>} clientFiles
 */
export function analyzeHostedAppNeeds(manifest, clientFiles) {
  const names = Object.keys(clientFiles || {}).filter((n) => !PRIVATE_PREFIX_RE.test(n));
  const mainEntry = typeof manifest?.main === 'string' ? manifest.main.replace(/^\/+/, '') : '';

  let permissionsJson = null;
  if (clientFiles?.['permission.json']) {
    try {
      permissionsJson = JSON.parse(readClientText(clientFiles['permission.json']));
    } catch {
      permissionsJson = null;
    }
  }

  let hasUiPages = /\.ui$/i.test(mainEntry);
  let hasHtmlPages = /\.html?$/i.test(mainEntry) || manifest?.format === 'web' || manifest?.format === 'container';
  let hasPython = manifest?.runtime === 'python';
  let hasTypeScript = false;
  let hasJsx = false;
  let hasWasmFile = false;
  let hasGlbOrGltf = false;

  const uiTexts = [];
  const allTexts = [];

  for (const name of names) {
    const lower = name.toLowerCase();
    if (lower.endsWith('.ui')) hasUiPages = true;
    if (lower.endsWith('.html') || lower.endsWith('.htm')) hasHtmlPages = true;
    if (lower.endsWith('.py')) hasPython = true;
    if (/\.(?:ts|tsx|mts)$/i.test(lower)) hasTypeScript = true;
    if (/\.(?:jsx|tsx)$/i.test(lower)) hasJsx = true;
    if (lower.endsWith('.wasm')) hasWasmFile = true;
    if (lower.endsWith('.glb') || lower.endsWith('.gltf')) hasGlbOrGltf = true;
    if (TEXT_EXT_RE.test(lower)) {
      const txt = readClientText(clientFiles[name]);
      allTexts.push(txt);
      if (lower.endsWith('.ui')) uiTexts.push(txt);
    }
  }

  const combinedText = allTexts.join('\n');
  const combinedUi = uiTexts.join('\n');

  if (/<script\b[^>]*type=["']text\/python["']/i.test(combinedText)) hasPython = true;
  if (/<script\b[^>]*type=["']text\/typescript["']/i.test(combinedText)) hasTypeScript = true;
  if (/<script\b[^>]*type=["']text\/(?:jsx|babel)["']/i.test(combinedText)) hasJsx = true;

  const pythonPackages = Array.isArray(manifest?.python?.packages)
    ? manifest.python.packages
    : Array.isArray(manifest?.packages)
      ? manifest.packages
      : [];

  const usesThree = hasGlbOrGltf || USES_THREE_RE.test(combinedText);
  const usesWebgl = usesThree || USES_WEBGL_RE.test(combinedText);
  const usesQrScanner =
    /<QRReader\b/i.test(combinedUi) ||
    hasCapability(manifest, permissionsJson, 'qr');
  const usesTorch = pythonPackages.includes('torch') || USES_TORCH_RE.test(combinedText);
  const usesAi = hasCapability(manifest, permissionsJson, 'ai') || USES_AI_RE.test(combinedText);
  const usesSync = hasCapability(manifest, permissionsJson, 'sync') || USES_SYNC_RE.test(combinedText);
  const usesWasm = hasWasmFile || USES_WASM_RE.test(combinedText);
  const usesWorkerScope = USES_WORKER_SCOPE_RE.test(combinedText);
  const usesIndexedDb = usesWorkerScope || USES_IDB_RE.test(combinedText);
  const usesReactVendor = hasJsx || USES_REACT_VENDOR_RE.test(combinedText);
  const usesFullJs = NEEDS_FULL_JAVASCRIPT_RE.test(combinedText);
  const usesContainerChart = /<softn-chart\b/i.test(combinedText);
  const usesContainerDatagrid = /<softn-datagrid\b/i.test(combinedText);
  const usesContainerSqlite =
    Boolean(manifest?.backend) ||
    Boolean(manifest?.server) ||
    /\bsoftn:sqlite\b/i.test(combinedText) ||
    hasCapability(manifest, permissionsJson, 'sqlite');
  const usesContainerVendors =
    usesThree ||
    /\b(?:preact|htm|marked)\b/i.test(combinedText) ||
    /softn-vendor:(?:preact|htm|marked|three)/i.test(combinedText);

  // Classic .ui optional component features
  const classicFeatures = {};
  for (const [feature, re] of Object.entries(CLASSIC_FEATURE_TAG_PATTERNS)) {
    classicFeatures[feature] = hasUiPages && re.test(combinedUi);
  }
  if (usesQrScanner && hasUiPages) classicFeatures.media = true;

  // Container v2 engine tier selection (mirrors packages/@softn/container/src/zipp-loader.ts)
  const containerNeedsLiteEngine = hasHtmlPages && !hasPython && !hasTypeScript && !usesFullJs;
  const containerNeedsTypescriptEngine = hasHtmlPages && !hasPython && hasTypeScript;
  const needsFullCoreWasm = hasUiPages || (hasHtmlPages && (hasPython || (!hasTypeScript && usesFullJs)));

  return {
    hasUiPages,
    hasHtmlPages,
    hasPython,
    hasTypeScript,
    hasJsx,
    usesThree,
    usesWebgl,
    usesQrScanner,
    usesTorch,
    usesAi,
    usesSync,
    usesWasm,
    usesIndexedDb,
    usesReactVendor,
    usesWorkerScope,
    usesFullJs,
    usesContainerChart,
    usesContainerDatagrid,
    usesContainerSqlite,
    usesContainerVendors,
    classicFeatures,
    containerNeedsLiteEngine,
    containerNeedsTypescriptEngine,
    needsFullCoreWasm,
  };
}

function matchesChunk(norm, prefix) {
  if (!norm.startsWith(`assets/${prefix}-`)) return false;
  const rest = norm.slice(7);
  if (rest.includes('/')) return false;
  return /\.(?:js|wasm)$/.test(rest);
}

/**
 * Determine whether a single `webroot/`-relative asset path can be safely
 * removed for an app with the given `needs`.
 *
 * @param {string} relPath - Path relative to webroot (forward slashes), e.g. `assets/vendor-three-abc.js`
 * @param {ReturnType<typeof analyzeHostedAppNeeds>} needs
 */
export function shouldPruneWebrootAsset(relPath, needs) {
  const norm = relPath.replace(/\\/g, '/').replace(/^\/+/, '');

  // 1. Three.js, Scene3D, and 19 Three JSM addons
  if (!needs.usesThree) {
    if (
      matchesChunk(norm, 'vendor-three') ||
      matchesChunk(norm, 'scene3d') ||
      matchesChunk(norm, 'webgl-scene-host') ||
      matchesChunk(norm, 'three-worker-host') ||
      matchesChunk(norm, 'guest-three-native') ||
      threeAddonChunks.some((addon) => matchesChunk(norm, addon))
    ) {
      return true;
    }
    if (/^assets\/container-runtime\/[^/]+\/vendor\/(?:three|gltf-loader)\.js$/.test(norm)) {
      return true;
    }
    if (/^assets\/container-runtime\/[^/]+\/worker-chunks\/(?:three-worker-host|guest-three-native)-[^/]+\.js$/.test(norm)) {
      return true;
    }
  }

  // 2. WebGL worker proxy
  if (!needs.usesWebgl) {
    if (matchesChunk(norm, 'webgl-worker-host') || matchesChunk(norm, 'guest-webgl')) return true;
    if (/^assets\/container-runtime\/[^/]+\/worker-chunks\/(?:webgl-worker-host|guest-webgl)-[^/]+\.js$/.test(norm)) {
      return true;
    }
  }

  // 3. QR Scanner (@yudiel/react-qr-scanner + 919 KB zxing_reader.wasm)
  if (!needs.usesQrScanner) {
    if (matchesChunk(norm, 'qr-reader') || matchesChunk(norm, 'zxing_reader')) return true;
  }

  // 4. Python Torch WASM (2.1 MB)
  if (!needs.usesTorch) {
    if (matchesChunk(norm, 'zipp_torch')) return true;
    if (norm.startsWith('assets/core-runtime/wasm-zipp-torch/')) return true;
  }

  // 5. Local AI / GGUF runtime
  if (!needs.usesAi) {
    if (
      matchesChunk(norm, 'ai-manager') ||
      matchesChunk(norm, 'model-host') ||
      matchesChunk(norm, 'ai-gpu-compute-manager')
    ) {
      return true;
    }
    if (
      norm === 'assets/core-runtime/runtime/model-worker.js' ||
      norm.startsWith('assets/core-runtime/wasm-gguf/')
    ) {
      return true;
    }
  }

  // 6. Peer / server XDB sync
  if (!needs.usesSync) {
    if (matchesChunk(norm, 'xdb-sync') || matchesChunk(norm, 'xdb-server-sync')) return true;
  }

  // 7. Guest WASM host
  if (!needs.usesWasm) {
    if (matchesChunk(norm, 'wasm') || matchesChunk(norm, 'wasm-host')) return true;
  }

  // 8. Pure Container v2 app (no Classic .ui pages)
  if (!needs.hasUiPages && needs.hasHtmlPages) {
    if (CLASSIC_ONLY_CHUNKS.some((name) => matchesChunk(norm, name))) return true;
    if (norm.startsWith('assets/core-runtime/')) return true;
  }

  // 9. Pure Classic .ui app (no Container v2 HTML pages)
  if (needs.hasUiPages && !needs.hasHtmlPages) {
    if (norm.startsWith('assets/container-runtime/')) return true;
    for (const [feature, needed] of Object.entries(needs.classicFeatures)) {
      if (!needed && matchesChunk(norm, feature)) return true;
    }
  }

  // 10. Core full ZIPP WASM engine (~7.4 MB) when Container v2 runs solely on lite or typescript engine
  if (!needs.needsFullCoreWasm && matchesChunk(norm, 'zipp_wasm_bg')) {
    return true;
  }

  // 11. Container runtime engines & optional worker-chunks
  if (norm.startsWith('assets/container-runtime/')) {
    if (/\/engines\/zipp-javascript-lite\.(?:wasm|glue\.js)$/.test(norm) && !needs.containerNeedsLiteEngine) {
      return true;
    }
    if (/\/engines\/zipp-typescript\.(?:wasm|glue\.js)$/.test(norm) && !needs.containerNeedsTypescriptEngine) {
      return true;
    }
    if (/\/engines\/zipp-python-base\.glue\.js$/.test(norm) && !needs.needsFullCoreWasm) {
      return true;
    }
    if (/\/(?:backend-worker\.js|engines\/xdb-wasm\.(?:wasm|glue\.js))$/.test(norm) && !needs.usesContainerSqlite) {
      return true;
    }
    if (/\/engines\/zipp-(?:php|rust)\.(?:wasm|glue\.js)$/.test(norm) && !needs.usesContainerSqlite) {
      return true;
    }
    if (/\/worker-chunks\/guest-indexeddb-[^/]+\.js$/.test(norm) && !needs.usesIndexedDb) return true;
    if (/\/worker-chunks\/guest-react-vendor-[^/]+\.js$/.test(norm) && !needs.usesReactVendor) return true;
    if (/\/worker-chunks\/jsx-transform-[^/]+\.js$/.test(norm) && !needs.hasJsx) return true;
    if (/\/worker-chunks\/guest-worker-scope-[^/]+\.js$/.test(norm) && !needs.usesWorkerScope) return true;
    if (/\/worker-chunks\/guest-vendors-[^/]+\.js$/.test(norm) && !needs.usesContainerVendors) return true;
    if (/\/worker-chunks\/chart-[^/]+\.js$/.test(norm) && !needs.usesContainerChart) return true;
    if (/\/worker-chunks\/datagrid-[^/]+\.js$/.test(norm) && !needs.usesContainerDatagrid) return true;
  }

  // 12. Inline fallback copies of container optional chunks in assets/
  if (!needs.usesIndexedDb && matchesChunk(norm, 'guest-indexeddb')) return true;
  if (!needs.usesReactVendor && matchesChunk(norm, 'guest-react-vendor')) return true;
  if (!needs.hasJsx && matchesChunk(norm, 'jsx-transform')) return true;
  if (!needs.usesWorkerScope && matchesChunk(norm, 'guest-worker-scope')) return true;
  if (!needs.usesContainerVendors && matchesChunk(norm, 'guest-vendors')) return true;

  return false;
}

/**
 * Prune unused runtime assets from an archive `entries` map in place.
 * Returns summary stats (`removed`, `savedBytes`, `needs`).
 *
 * @param {Record<string, Buffer | Uint8Array>} entries
 * @param {Record<string, any>} manifest
 * @param {Record<string, Uint8Array | Buffer | string>} clientFiles
 * @param {{ webrootPrefix?: string }} [options]
 */
export function pruneHostedRuntimeEntries(entries, manifest, clientFiles, options = {}) {
  const prefix = options.webrootPrefix ?? 'webroot/';
  const needs = analyzeHostedAppNeeds(manifest, clientFiles);
  const removed = [];
  let savedBytes = 0;

  for (const key of Object.keys(entries)) {
    if (!key.startsWith(prefix)) continue;
    const rel = key.slice(prefix.length);
    if (shouldPruneWebrootAsset(rel, needs)) {
      savedBytes += entries[key]?.length ?? 0;
      delete entries[key];
      removed.push(key);
    }
  }

  return { removed, savedBytes, needs };
}
