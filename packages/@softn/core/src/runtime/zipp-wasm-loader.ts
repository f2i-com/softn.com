import initWasm, {
  addPythonPackage,
  pythonPackages,
  zipp_install_panic_hook,
  zippProfile,
  type InitOutput,
} from '../../wasm-zipp/zipp_wasm.js';
import { retryableSingleFlight } from './retryable-single-flight';

let suppliedSource: BufferSource | WebAssembly.Module | undefined;
let initializationStarted = false;

/**
 * Supply trusted engine bytes or compiled code before this realm starts ZIPP.
 * A host can fetch once and clone the bytes into separate workers/frames; each
 * realm still creates its own WASM instance, memory and guest engines.
 * Byte sources are copied so later caller mutations cannot change the engine.
 */
export function configureZippWasmSource(source: BufferSource | WebAssembly.Module): void {
  if (initializationStarted) {
    throw new Error('The ZIPP engine source must be configured before initialization starts');
  }
  if (source instanceof WebAssembly.Module) {
    suppliedSource = source;
    return;
  }
  const bytes = source instanceof ArrayBuffer
    ? new Uint8Array(source)
    : ArrayBuffer.isView(source)
      ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
      : null;
  if (!bytes || bytes.byteLength < 8) {
    throw new TypeError('The ZIPP engine source must be a WASM module or engine bytes');
  }
  suppliedSource = bytes.slice();
}

/** A copy for a new worker; never expose this realm's mutable engine memory. */
export function getConfiguredZippWasmSource(): BufferSource | WebAssembly.Module | undefined {
  if (suppliedSource === undefined || suppliedSource instanceof WebAssembly.Module) {
    return suppliedSource;
  }
  return suppliedSource instanceof ArrayBuffer
    ? suppliedSource.slice(0)
    : new Uint8Array(suppliedSource.buffer, suppliedSource.byteOffset, suppliedSource.byteLength).slice();
}

const initialize = retryableSingleFlight<InitOutput>(async () => {
  const exports = suppliedSource === undefined
    ? await initWasm()
    : await initWasm({ module_or_path: suppliedSource });
  zipp_install_panic_hook();
  return exports;
});

/** One retryable initialization per JS realm, shared by its runtime consumers. */
export function ensureZippWasm(): Promise<InitOutput> {
  // Freeze synchronously, including the gap before the single-flight microtask.
  // A failed load can retry, but cannot silently switch the configured engine.
  initializationStarted = true;
  return initialize();
}

/**
 * The languages the engine that actually loaded can run, e.g.
 * `['javascript', 'python']`.
 *
 * Read out of the engine's own profile rather than out of whatever the host
 * believes it supplied. ZIPP ships as more than one build — a JavaScript-only
 * one and a JavaScript-and-Python one — from the same glue, so a host handed
 * the wrong bytes cannot tell them apart by looking at its own records. It can
 * ask here, and refuse before a bundle runs instead of after a Python file
 * fails to compile.
 *
 * Initializes ZIPP, so a host that also supplies the source must call
 * {@link configureZippWasmSource} first. An engine whose profile cannot be read
 * answers an empty list, which a caller checking for a language will refuse.
 */
export async function zippLanguages(): Promise<string[]> {
  await ensureZippWasm();
  try {
    const profile = JSON.parse(zippProfile()) as { languages?: unknown };
    return Array.isArray(profile.languages)
      ? profile.languages.filter((name): name is string => typeof name === 'string')
      : [];
  } catch {
    return [];
  }
}

/**
 * The Python packages the loaded engine can provide: those built into it
 * (ZIPP's complete `web-python` build carries torch; the `web-python-base`
 * build Softn ships carries none) and those added to it since it loaded
 * ({@link ensureZippTorch}).
 *
 * Read from the engine, like {@link zippLanguages}, because the same glue
 * runs builds with and without torch. An engine that cannot say — the
 * JavaScript-only build has no Python packages at all — answers none.
 */
export async function zippPythonPackages(): Promise<string[]> {
  await ensureZippWasm();
  try {
    if (typeof pythonPackages !== 'function') return [];
    const report = JSON.parse(pythonPackages()) as { torchBuiltIn?: unknown; installed?: unknown };
    const names = new Set<string>();
    if (report.torchBuiltIn === true) names.add('torch');
    if (Array.isArray(report.installed)) {
      for (const entry of report.installed) {
        const name = typeof entry === 'string' ? entry : (entry as { name?: unknown } | null)?.name;
        if (typeof name === 'string') names.add(name);
      }
    }
    return [...names];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// The torch package, added on demand
// ---------------------------------------------------------------------------

let suppliedTorchSource: Uint8Array | WebAssembly.Module | undefined;
let torchLoadStarted = false;

/**
 * Supply the torch package's bytes (`zipp_torch.wasm`) or its compiled module
 * before this realm first needs torch, instead of fetching it from next to
 * core's chunk. For a host that already holds the bytes, and for tests, which
 * have no server to fetch from. Byte sources are copied; like the engine's
 * source, it cannot be changed once a load has started.
 */
export function configureZippTorchSource(source: BufferSource | WebAssembly.Module): void {
  if (torchLoadStarted) {
    throw new Error('The torch package source must be configured before it is first loaded');
  }
  if (source instanceof WebAssembly.Module) {
    suppliedTorchSource = source;
    return;
  }
  const bytes = source instanceof ArrayBuffer
    ? new Uint8Array(source)
    : ArrayBuffer.isView(source)
      ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
      : null;
  if (!bytes || bytes.byteLength < 8) {
    throw new TypeError('The torch package source must be a WASM module or its bytes');
  }
  suppliedTorchSource = bytes.slice();
}

// Beside the chunk in core's dist/core-runtime/ mirror, which every app that
// ships core copies to assets/core-runtime/ (scripts/core-worker-assets.mjs).
// A variable, not a literal, like the script worker's path: a literal would be
// rewritten by Vite into a hashed copy under assets/ that every PWA's glob
// would then precache for every visitor, where this file is for the apps that
// declare torch. assets/core-runtime/ is outside every precache.
const TORCH_WASM_PATH = './core-runtime/zipp_torch.wasm';

/**
 * Where this realm fetches the torch package from, when no source was
 * configured: `core-runtime/zipp_torch.wasm` beside core's chunk. Starts
 * nothing; an offline install can fetch it for an app that declares torch.
 */
export function zippTorchWasmUrl(): URL {
  return new URL(TORCH_WASM_PATH, import.meta.url);
}

async function torchPackageSource(): Promise<Uint8Array | WebAssembly.Module> {
  if (suppliedTorchSource !== undefined) {
    return suppliedTorchSource instanceof WebAssembly.Module ? suppliedTorchSource : suppliedTorchSource.slice();
  }
  const url = zippTorchWasmUrl();
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(`${url.pathname} could not be fetched: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`${url.pathname} answered ${response.status}`);
  // Bytes rather than compileStreaming: a server that labels the file with
  // another MIME type still serves the right bytes.
  return new Uint8Array(await response.arrayBuffer());
}

const loadTorch = retryableSingleFlight<void>(async () => {
  await ensureZippWasm();
  if ((await zippPythonPackages()).includes('torch')) return;
  const [{ addTorch }, source] = await Promise.all([import('../../wasm-zipp-torch/zipp_torch.js'), torchPackageSource()]);
  // ZIPP's own loader: it instantiates the package module and hands its
  // archive to the engine, which checks the format, the engine ABI and every
  // file's SHA-256 before registering anything, and throws with the reason.
  await addTorch({ addPythonPackage }, source);
  if (!(await zippPythonPackages()).includes('torch')) {
    throw new Error('the engine did not register the torch package');
  }
});

/**
 * Add ZIPP's torch package to this realm's engine, once: concurrent callers
 * share one load, a success stays for the life of the page, and a failed load
 * (offline for a moment) can be tried again. The package is process-wide for
 * the WASM instance, so every Python engine in the realm then imports torch.
 * A realm whose engine already provides torch loads nothing.
 */
export function ensureZippTorch(): Promise<void> {
  torchLoadStarted = true;
  return loadTorch();
}

/**
 * Fetch the torch package's loader chunk and its module without adding them
 * to the engine, so a service worker that holds this page's fetches keeps
 * both: an offline install calls it for an app that declares torch. The
 * module is fetched past the HTTP cache (`cache: 'reload'`) so the request
 * reaches the worker's route. Rejects when either cannot be fetched; starts
 * nothing, and fixes no source.
 */
export async function preloadZippTorch(init: RequestInit = {}): Promise<void> {
  await import('../../wasm-zipp-torch/zipp_torch.js');
  const url = zippTorchWasmUrl();
  const response = await fetch(url, { cache: 'reload', credentials: 'same-origin', ...init });
  if (!response.ok) throw new Error(`${url.pathname} answered ${response.status}`);
  await response.arrayBuffer();
}
