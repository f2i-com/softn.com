/**
 * Prune unused optional runtime libraries and WASM engines from a concrete
 * standalone hosted SoftN app deployment (`template: false`).
 *
 * Template deployments (and the multi-app /play/ shell) keep every optional
 * library available for dynamic on-demand loading. When packaging one known
 * app into its own standalone deployment, we already have its full client
 * archive and manifest, so unused heavy assets (Three.js + 19 JSM loaders,
 * zxing QR decoder WASM, Torch WASM, AI/GGUF workers, unused ZIPP engine tiers,
 * unused worker-chunks, classic/container runtime halves) can be omitted
 * safely with zero risk to runtime behavior.
 */

import { threeAddonChunks } from './on-demand-chunks.mjs';

const TEXT_EXT_RE = /\.(?:html?|ui|logic|js|mjs|cjs|ts|tsx|mts|jsx|vue|py|json|css|svg)$/i;
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
  media: /<(?:Camera|Microphone|AudioStream|QRCode)\b/i,
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

const CONTAINER_ONLY_CHUNKS = [
  'worker-runtime',
  'mount',
  'local-backend-transport',
  'backend-runtime',
  'device-bridge',
  'virtual-nav-bar',
  'legacy-ui',
];

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

/** Extract inline `<script>` tags and their MIME types from an HTML document. */
function extractInlineScripts(html) {
  const scripts = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    const typeMatch = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const type = (typeMatch?.[1] ?? typeMatch?.[2] ?? typeMatch?.[3] ?? '').trim().toLowerCase();
    scripts.push({ type, code: m[2] || '' });
  }
  return scripts;
}

function isPythonScriptType(type) {
  return type === 'text/python' || type === 'python';
}

function isTsScriptType(type) {
  return (
    type === 'text/typescript' ||
    type === 'module/ts' ||
    type === 'text/tsx' ||
    type === 'module/tsx'
  );
}

function isJsxScriptType(type) {
  return (
    type === 'text/jsx' ||
    type === 'module/jsx' ||
    type === 'text/tsx' ||
    type === 'module/tsx' ||
    type === 'text/babel'
  );
}

/**
 * Conservatively analyze what optional libraries, component features, and WASM
 * engines a concrete `.softn` client archive needs. When uncertain, returns
 * `true` so nothing required is ever pruned.
 *
 * @param {Record<string, any>} manifest
 * @param {Record<string, Uint8Array | Buffer | string>} clientFiles
 * @param {{ remoteHostedBackend?: boolean }} [options]
 */
export function analyzeHostedAppNeeds(manifest, clientFiles, options = {}) {
  const remoteHostedBackend = Boolean(options.remoteHostedBackend);
  const allClientNames = Object.keys(clientFiles || {});
  const names = allClientNames.filter((n) => !PRIVATE_PREFIX_RE.test(n));
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
  let hasHtmlPages =
    /\.html?$/i.test(mainEntry) ||
    manifest?.format === 'web' ||
    manifest?.format === 'container' ||
    manifest?.engine === 2 ||
    Boolean(manifest?.ssrEntry) ||
    String(manifest?.backend?.mode ?? '').toLowerCase() === 'ssr';
  let hasPythonVfs = manifest?.runtime === 'python';
  let hasTypeScriptVfs = false;
  let hasJsx = false;
  let hasWasmFile = false;
  let hasGlbOrGltf = false;
  let hasZeroConfigSqlite = false;
  let hasZeroConfigPhp = false;
  let hasZeroConfigRust = false;
  let vfsNeedsFullJs = false;

  const uiTexts = [];
  const htmlPages = [];
  const scriptTexts = [];
  const allTexts = [];

  for (const name of names) {
    const lower = name.toLowerCase();
    if (lower.endsWith('.ui')) hasUiPages = true;
    if (lower.endsWith('.html') || lower.endsWith('.htm')) hasHtmlPages = true;
    if (lower.endsWith('.py')) hasPythonVfs = true;
    if (/\.(?:ts|tsx|mts)$/i.test(lower)) hasTypeScriptVfs = true;
    if (/\.(?:jsx|tsx)$/i.test(lower)) hasJsx = true;
    if (lower.endsWith('.wasm')) hasWasmFile = true;
    if (lower.endsWith('.glb') || lower.endsWith('.gltf')) hasGlbOrGltf = true;
    if (/\.(?:db|sqlite|sqlite3)$/i.test(lower) || lower === 'schema.sql' || lower.endsWith('/schema.sql')) {
      hasZeroConfigSqlite = true;
    }
    // Match `archive.ts` zero-config backend discovery: only root or `server/`/`backend/`
    // PHP/Rust files activate a local backend, never example/doc files nested elsewhere.
    if ((lower.endsWith('.php') || lower.endsWith('.phtml')) && (!lower.includes('/') || /^(?:server|backend)\//.test(lower))) {
      hasZeroConfigPhp = true;
    }
    if (
      lower === 'cargo.toml' ||
      lower === 'main.rs' ||
      lower === 'src/main.rs' ||
      /^(?:server|backend)\/(?:cargo\.toml|.*\.rs)$/.test(lower)
    ) {
      hasZeroConfigRust = true;
    }

    if (TEXT_EXT_RE.test(lower)) {
      const txt = readClientText(clientFiles[name]);
      allTexts.push(txt);
      if (lower.endsWith('.ui')) uiTexts.push(txt);
      if (lower.endsWith('.html') || lower.endsWith('.htm')) {
        htmlPages.push(txt);
      } else if (/\.(?:js|mjs|cjs|jsx|ts|tsx|mts|vue|py|logic)$/i.test(lower)) {
        scriptTexts.push(txt);
        if (/\.(?:js|mjs|jsx|vue)$/i.test(lower) && NEEDS_FULL_JAVASCRIPT_RE.test(txt)) {
          vfsNeedsFullJs = true;
        }
      }
    }
  }

  // Compute Container v2 engine tiers PER HTML page (matching zipp-loader.ts selectEngineTier),
  // inspecting only inline <script> blocks + VFS script modules so prose words like "Intl"
  // in HTML/JSON/CSS never drop the lite engine!
  const containerTiers = new Set();
  let anyPagePython = hasPythonVfs;
  let anyPageTs = hasTypeScriptVfs;

  const pythonPackages = [
    ...(Array.isArray(manifest?.python?.packages) ? manifest.python.packages : []),
    ...(Array.isArray(manifest?.config?.python?.packages) ? manifest.config.python.packages : []),
    ...(Array.isArray(manifest?.packages) ? manifest.packages : []),
  ];

  if (hasHtmlPages) {
    const pagesToCheck = htmlPages.length > 0 ? htmlPages : [''];
    for (const html of pagesToCheck) {
      let pagePython = hasPythonVfs;
      let pageTs = hasTypeScriptVfs;
      let pageFullJs = vfsNeedsFullJs;
      for (const s of extractInlineScripts(html)) {
        scriptTexts.push(s.code);
        if (isPythonScriptType(s.type)) pagePython = true;
        else if (isTsScriptType(s.type)) pageTs = true;
        if (isJsxScriptType(s.type)) hasJsx = true;
        if (NEEDS_FULL_JAVASCRIPT_RE.test(s.code)) pageFullJs = true;
      }
      if (pagePython) anyPagePython = true;
      if (pageTs) anyPageTs = true;
      if (pagePython) containerTiers.add('python');
      else if (pageTs) containerTiers.add('typescript');
      else if (pageFullJs) containerTiers.add('javascript');
      else containerTiers.add('lite');
    }
  }

  const combinedText = allTexts.join('\n');
  const combinedScripts = scriptTexts.join('\n');
  const combinedUi = uiTexts.join('\n');
  const classicMarkup = [combinedUi, ...htmlPages].join('\n');

  const backendRuntime = String(manifest?.backend?.runtime ?? manifest?.server?.runtime ?? '').toLowerCase();
  const hasEmbeddedBackend = !remoteHostedBackend && (Boolean(manifest?.backend) || Boolean(manifest?.server) || hasZeroConfigPhp || hasZeroConfigRust);
  const usesBrowserPhpBackend =
    !remoteHostedBackend && (backendRuntime === 'php' || hasZeroConfigPhp);
  const usesBrowserRustBackend =
    !remoteHostedBackend && (backendRuntime === 'rust' || hasZeroConfigRust);
  const usesContainerSqlite =
    hasEmbeddedBackend ||
    (!remoteHostedBackend && (
      (Array.isArray(manifest?.databases) && manifest.databases.length > 0) ||
      hasZeroConfigSqlite ||
      /\bsoftn:sqlite\b/i.test(combinedText) ||
      hasCapability(manifest, permissionsJson, 'sqlite')
    ));

  const usesThree = hasGlbOrGltf || USES_THREE_RE.test(combinedText);
  const usesWebgl = usesThree || USES_WEBGL_RE.test(combinedScripts) || USES_WEBGL_RE.test(combinedUi);
  const usesQrScanner =
    /<QRReader\b/i.test(classicMarkup) ||
    hasCapability(manifest, permissionsJson, 'qr');
  const usesTorch = pythonPackages.includes('torch') || USES_TORCH_RE.test(combinedScripts);
  const usesAi = hasCapability(manifest, permissionsJson, 'ai') || USES_AI_RE.test(combinedText);
  const usesSync = hasCapability(manifest, permissionsJson, 'sync') || USES_SYNC_RE.test(combinedText);
  const usesWasm = hasWasmFile || USES_WASM_RE.test(combinedText);
  const usesWorkerScope = USES_WORKER_SCOPE_RE.test(combinedScripts);
  const usesIndexedDb = usesWorkerScope || USES_IDB_RE.test(combinedScripts);
  const usesReactVendor = hasJsx || USES_REACT_VENDOR_RE.test(combinedScripts);
  const usesContainerChart = /\bsoftn-chart\b/i.test(combinedText);
  const usesContainerDatagrid = /\bsoftn-datagrid\b/i.test(combinedText);
  const usesContainerVendors =
    usesThree ||
    /['"](?:preact(?:\/[^'"]*)?|htm|marked|softn-vendor:(?:preact|htm|marked|three)[^'"]*)['"]/.test(combinedScripts);

  // Classic .ui optional component features (QRReader is in its own `qr-reader` chunk)
  const classicFeatures = {};
  for (const [feature, re] of Object.entries(CLASSIC_FEATURE_TAG_PATTERNS)) {
    classicFeatures[feature] = hasUiPages && re.test(combinedUi);
  }

  // When a browser-local PHP or Rust backend engine is loaded, softn-app.ts reuses that
  // already-compiled module for frontend `lite`/`javascript` tiers too!
  // Local JS, Python, or default-runtime backends rely on core's full engine (`hostedContainerOptions`).
  const browserBackendUsesCoreWasm =
    !remoteHostedBackend &&
    hasEmbeddedBackend &&
    !usesBrowserPhpBackend &&
    !usesBrowserRustBackend &&
    backendRuntime !== 'typescript';
  const browserBackendReusesFrontendJs = usesBrowserPhpBackend || usesBrowserRustBackend;
  const containerNeedsLiteEngine =
    hasHtmlPages && containerTiers.has('lite') && !browserBackendReusesFrontendJs;
  const containerNeedsTypescriptEngine =
    hasHtmlPages && (containerTiers.has('typescript') || (!remoteHostedBackend && backendRuntime === 'typescript'));
  const needsFullCoreWasm =
    hasUiPages ||
    browserBackendUsesCoreWasm ||
    (hasHtmlPages &&
      (containerTiers.has('python') ||
        (containerTiers.has('javascript') && !browserBackendReusesFrontendJs)));

  return {
    hasUiPages,
    hasHtmlPages,
    hasPython: anyPagePython,
    hasTypeScript: anyPageTs,
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
    usesFullJs: containerTiers.has('javascript'),
    usesContainerChart,
    usesContainerDatagrid,
    usesContainerSqlite,
    usesBrowserPhpBackend,
    usesBrowserRustBackend,
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
    if (
      norm === 'assets/core-runtime/zipp_torch.wasm' ||
      /^assets\/core-runtime\/zipp_torch-[^/]+\.js$/.test(norm) ||
      norm.startsWith('assets/core-runtime/wasm-zipp-torch/')
    ) {
      return true;
    }
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
      norm.startsWith('assets/core-runtime/runtime/models/') ||
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
    if (norm.startsWith('assets/core-runtime/')) {
      const keepTorch =
        needs.usesTorch &&
        (norm === 'assets/core-runtime/zipp_torch.wasm' ||
          /^assets\/core-runtime\/zipp_torch-[^/]+\.js$/.test(norm) ||
          norm.startsWith('assets/core-runtime/wasm-zipp-torch/'));
      const keepAi =
        needs.usesAi &&
        (norm === 'assets/core-runtime/runtime/model-worker.js' ||
          norm.startsWith('assets/core-runtime/runtime/models/') ||
          norm.startsWith('assets/core-runtime/wasm-gguf/'));
      if (!keepTorch && !keepAi) return true;
    }
  }

  // 9. Pure Classic .ui app (no Container v2 HTML pages)
  if (needs.hasUiPages && !needs.hasHtmlPages) {
    if (norm.startsWith('assets/container-runtime/')) return true;
    if (CONTAINER_ONLY_CHUNKS.some((name) => matchesChunk(norm, name))) return true;
    for (const [feature, needed] of Object.entries(needs.classicFeatures)) {
      if (!needed && matchesChunk(norm, feature)) return true;
    }
  }

  // 10. Core full ZIPP WASM engine (~7.4 MB) when Container v2 runs on lite, typescript, or reused PHP/Rust engine
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
    if (/\/engines\/zipp-php\.(?:wasm|glue\.js)$/.test(norm) && !needs.usesBrowserPhpBackend) {
      return true;
    }
    if (/\/engines\/zipp-rust\.(?:wasm|glue\.js)$/.test(norm) && !needs.usesBrowserRustBackend) {
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
 * @param {{ webrootPrefix?: string; remoteHostedBackend?: boolean }} [options]
 */
export function pruneHostedRuntimeEntries(entries, manifest, clientFiles, options = {}) {
  const prefix = options.webrootPrefix ?? 'webroot/';
  const needs = analyzeHostedAppNeeds(manifest, clientFiles, options);
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
