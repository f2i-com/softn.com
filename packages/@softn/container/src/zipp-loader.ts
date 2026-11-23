/**
 * Tiered ZIPP WASM Engine Selector & Universal Module Loader.
 *
 * Selects the smallest ZIPP `.wasm` engine capable of running the container's scripts:
 * - `'lite'` (`zipp-javascript-lite.wasm`, ~778 KB Brotli) by default for JS apps
 * - `'javascript'` (`zipp-javascript.wasm`, ~1.25 MB Brotli) when `Intl` or `Temporal` is used
 * - `'typescript'` (`zipp-typescript.wasm`, ~1.32 MB Brotli) when `.ts` / `.tsx` scripts exist
 * - `'python'` / `'python-torch'` only when `.py` scripts exist
 *
 * Reads `zipp.glue` & `zipp.meta` directly from official ZIPP `.wasm` custom sections,
 * with automatic fallback to `@softn/core`'s `zipp_wasm.js` glue when loading stripped
 * modules during local Node/Vitest runs.
 */

import type { ExtractedScript, ZippEngineTier } from './types';

const GLUE_SECTION = 'zipp.glue';
const META_SECTION = 'zipp.meta';

const ENGINE_FILENAMES: Readonly<Record<ZippEngineTier, string>> = {
  lite: 'zipp-javascript-lite.wasm',
  javascript: 'zipp-javascript.wasm',
  typescript: 'zipp-typescript.wasm',
  python: 'zipp-python-base.wasm',
  'python-torch': 'zipp-python-base.wasm',
  php: 'zipp-php.wasm',
  rust: 'zipp-rust.wasm',
};

const GLUE_FILE_BY_VARIANT: Readonly<Record<string, string>> = {
  lite: 'zipp-javascript-lite.glue.js',
  javascript: 'zipp-javascript.glue.js',
  'javascript-typescript': 'zipp-typescript.glue.js',
  'javascript-python-base': 'zipp-python-base.glue.js',
  'javascript-php': 'zipp-php.glue.js',
  'javascript-rust': 'zipp-rust.glue.js',
};

/** A tier's engine file in `engines/`, where the host does not supply the tier's engine itself. */
export function engineFileFor(tier: ZippEngineTier): string {
  return ENGINE_FILENAMES[tier];
}

/** The bindings file in `engines/` for the engine that was compiled, whatever tier asked for it. */
export function glueFileFor(tier: ZippEngineTier, meta: Record<string, unknown> | null): string {
  const variant = typeof meta?.variant === 'string' ? meta.variant : '';
  return GLUE_FILE_BY_VARIANT[variant] ?? ENGINE_FILENAMES[tier].replace(/\.wasm$/, '.glue.js');
}

/**
 * What the lite engine answers differently from the full one, with no error to say so: it has
 * no `Intl` or `Temporal` (those throw), and its locale methods fall back to the plain ones
 * (`(1234.5).toLocaleString()` is "1234.5", a date's is its `toString()`, `localeCompare`
 * ignores its options, `toLocaleUpperCase('tr')` is `toUpperCase()`). A script that names any
 * of them runs on the full engine, wherever in the app it is.
 */
const NEEDS_FULL_JAVASCRIPT =
  /\b(?:Intl|Temporal)\b|\.(?:toLocale(?:String|DateString|TimeString|UpperCase|LowerCase)|localeCompare)\b/;

/** Inspect extracted scripts & manifest to pick the smallest sufficient ZIPP engine tier. */
export function selectEngineTier(
  scripts: readonly ExtractedScript[],
  textFiles: Readonly<Record<string, string>>,
  pythonPackages?: readonly string[]
): ZippEngineTier {
  let hasPython = false;
  let wantsTorch = Boolean(pythonPackages?.includes('torch'));
  let hasTypeScript = false;
  let wantsIntlOrTemporal = false;

  for (const s of scripts) {
    if (s.language === 'python') {
      hasPython = true;
      if (/\bimport\s+torch\b|\bfrom\s+torch\b/.test(s.code)) wantsTorch = true;
    } else if (s.language === 'typescript') {
      hasTypeScript = true;
    }
    if (NEEDS_FULL_JAVASCRIPT.test(s.code)) {
      wantsIntlOrTemporal = true;
    }
  }

  // Also scan any VFS module files referenced in the archive
  for (const [path, content] of Object.entries(textFiles)) {
    if (/\.py$/i.test(path)) {
      hasPython = true;
      if (/\bimport\s+torch\b|\bfrom\s+torch\b/.test(content)) wantsTorch = true;
    } else if (/\.(?:ts|tsx|mts)$/i.test(path)) {
      hasTypeScript = true;
    } else if (/\.(?:js|mjs|jsx)$/i.test(path) && !wantsIntlOrTemporal) {
      // The same test as an inline script's: a module the page imports is the app as well.
      // (Files were held only to `Intl` and `Temporal`, so a module that formatted a price
      // with toLocaleString ran on lite and printed it unformatted.)
      if (NEEDS_FULL_JAVASCRIPT.test(content)) wantsIntlOrTemporal = true;
    }
  }

  if (hasPython) return wantsTorch ? 'python-torch' : 'python';
  if (hasTypeScript) return 'typescript';
  if (wantsIntlOrTemporal) return 'javascript';
  return 'lite';
}

export type ZippHostBridge =
  | { call: (kind: string, args: string[]) => unknown }
  | Record<string, (...args: unknown[]) => unknown>;

export interface ZippPhpAppInstance {
  readonly disposed: boolean;
  setBaseDir(dir: string): void;
  setEnv(env: Record<string, string>): void;
  setInstructionBudget(steps: number): boolean;
  setSyncHostCapabilities(ops: string[]): void;
  setAppBridge(bridge: ZippHostBridge): void;
  addAppBridge(namespace: string, bridge: ZippHostBridge): void;
  mountFiles(files: Record<string, string | { base64: string }>): void;
  mountFile(path: string, content: string): void;
  mountFileBase64(path: string, base64: string): void;
  handleRequest(scriptPath: string, reqJson: string): { metaJson: string; bodyBase64: string; error: string | null };
  exportOverlayJson(): string;
  importOverlayJson(json: string): void;
  dispose(): void;
  free?(): void;
}

export interface ZippEngineInstance {
  setSyncHostCapabilities(ops: string[]): void;
  setInstructionBudget(steps: number): boolean;
  renewInstructionBudget(): boolean;
  setScriptOrigin(name: string, lineOffset: number, colOffset: number): void;
  setAppBridge(bridge: ZippHostBridge): void;
  addAppBridge?(namespace: string, bridge: ZippHostBridge): void;
  setDbBridge(bridge: Record<string, (...args: unknown[]) => unknown>): void;
  setLocalStorageBridge(bridge: Record<string, (...args: unknown[]) => unknown>): void;
  initScript(source: string): unknown;
  initSource(source: string, language: string): unknown;
  initPythonProject?(files: Record<string, unknown>, entry: string, argv?: string[]): unknown;
  initRustProject?(
    files: Record<string, string | { base64: string }>,
    entry: string,
    options?: Record<string, unknown>
  ): unknown;
  rustDispatchRequest?(reqJson: string): string;
  takeRustOutput?(): string;
  takeRustStderr?(): string;
  exportRustOverlayJson?(): string;
  initPhpProject?(
    files: Record<string, string | { base64: string }>,
    entry: string,
    options?: Record<string, unknown>
  ): unknown;
  phpDispatchRequest?(reqJson: string): { metaJson: string; bodyBase64: string };
  phpTakeResponse?(): string;
  takePhpOutput?(): string;
  takePhpOutputBase64?(): string;
  evalInContext(expr: string): unknown;
  callFunction?(name: string, args: unknown[]): unknown;
  pythonCall?(name: string, args: unknown[]): unknown;
  drainPendingHostCalls(): Array<{ id: number; kind: string; args: string[] }>;
  resolveHostCallback(id: number, result: unknown): unknown;
  /** The lines printed so far, each with the stream it was written to (the engine's own form). */
  takeConsole(): Array<{ stream?: 'stdout' | 'stderr'; text: string }>;
  takeFailedConsole(): Array<{ stream?: 'stdout' | 'stderr'; text: string }>;
  takeOutput(): string[];
  pump(): void;
  dispose(): void;
  free?(): void;
  readonly disposed?: boolean;
  lastErrorKind(): string;
}

export interface LoadedZippBindings {
  Engine: new () => ZippEngineInstance;
  PhpApp?: new () => ZippPhpAppInstance;
  hostStepsRemaining?: () => number;
  hostChargeSteps?: (steps: number) => void;
  meta: Record<string, unknown> | null;
  profile: Record<string, unknown>;
  module: WebAssembly.Module;
}

let glueInstanceCounter = 0;
const compiledModuleCache = new Map<string, Promise<LoadedZippBindings>>();

function isNodeRuntime(): boolean {
  return typeof process !== 'undefined' && typeof process.versions?.node === 'string';
}

function isWasmMagic(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d;
}

function readCustomSection(mod: WebAssembly.Module, name: string): string | null {
  const sections = WebAssembly.Module.customSections(mod, name);
  if (sections.length === 0) return null;
  return new TextDecoder().decode(sections[0]);
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

async function importGlueText(glueSource: string): Promise<Record<string, unknown>> {
  const tagged = `${glueSource}\n// softn-container-zipp-${++glueInstanceCounter}\n`;
  if (!isNodeRuntime() && typeof Blob === 'function' && typeof URL.createObjectURL === 'function') {
    const blobUrl = URL.createObjectURL(new Blob([tagged], { type: 'text/javascript' }));
    try {
      return (await import(/* @vite-ignore */ blobUrl)) as Record<string, unknown>;
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }
  const dataUrl = `data:text/javascript;base64,${utf8ToBase64(tagged)}`;
  return (await import(/* @vite-ignore */ dataUrl)) as Record<string, unknown>;
}

async function compileWasmSource(source: BufferSource | WebAssembly.Module | string): Promise<WebAssembly.Module> {
  if (source instanceof WebAssembly.Module) return source;
  if (typeof source === 'string') {
    if (isNodeRuntime() && (/^[a-zA-Z]:[\\/]/.test(source) || source.startsWith('/') || source.startsWith('.'))) {
      const fs = await import('node:fs/promises');
      const raw = new Uint8Array(await fs.readFile(source));
      if (!isWasmMagic(raw)) {
        const zlib = await import('node:zlib');
        return WebAssembly.compile(new Uint8Array(zlib.brotliDecompressSync(raw)));
      }
      return WebAssembly.compile(raw);
    }
    const base =
      typeof document !== 'undefined'
        ? document.baseURI
        : typeof self !== 'undefined' && self.location
          ? self.location.href
          : undefined;
    const url = base ? new URL(source, base) : new URL(source);
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`Failed to fetch ZIPP engine (${url.pathname}): HTTP ${resp.status}`);
    }
    const ct = (resp.headers.get('content-type') ?? '').split(';')[0].trim();
    if (ct === 'application/wasm' && typeof WebAssembly.compileStreaming === 'function') {
      try {
        return await WebAssembly.compileStreaming(resp.clone());
      } catch {
        // Fallback to buffered compile
      }
    }
    return WebAssembly.compile(new Uint8Array(await resp.arrayBuffer()));
  }
  const view =
    source instanceof ArrayBuffer
      ? new Uint8Array(source)
      : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  return WebAssembly.compile(view);
}

async function resolveNodeContainerPkgRoot(): Promise<string | null> {
  const pathMod = await import('node:path');
  const fsMod = await import('node:fs');
  try {
    const moduleMod = await import('node:module');
    const req = moduleMod.createRequire(pathMod.join(process.cwd(), 'package.json'));
    return pathMod.dirname(req.resolve('@softn/container/package.json'));
  } catch {
    let dir = process.cwd();
    for (let i = 0; i < 6; i++) {
      const direct = pathMod.join(dir, 'packages', '@softn', 'container');
      if (fsMod.existsSync(pathMod.join(direct, 'package.json'))) return direct;
      if (fsMod.existsSync(pathMod.join(dir, 'package.json')) && pathMod.basename(dir) === 'container') return dir;
      const parent = pathMod.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  }
}

/**
 * Load and instantiate a ZIPP WASM engine for `tier`.
 */
export async function loadZippEngine(options: {
  tier: ZippEngineTier;
  runtimeUrl?: string;
  explicitSource?: BufferSource | WebAssembly.Module | string;
  fallbackGlueFactory?: () => Promise<Record<string, unknown>>;
}): Promise<LoadedZippBindings> {
  const { tier, explicitSource, fallbackGlueFactory } = options;
  let runtimeUrl = options.runtimeUrl;
  if (
    !runtimeUrl ||
    (isNodeRuntime() && (runtimeUrl === '/runtime/' || runtimeUrl.endsWith('/assets/container-runtime/')))
  ) {
    if (isNodeRuntime()) {
      const pathMod = await import('node:path');
      const pkgRoot = await resolveNodeContainerPkgRoot();
      runtimeUrl = pkgRoot ? pathMod.join(pkgRoot, 'dist', 'runtime') : '/runtime/';
    } else {
      runtimeUrl = '/runtime/';
    }
  }

  const cacheKey = typeof explicitSource === 'string' ? `src:${explicitSource}` : explicitSource ? '' : `tier:${runtimeUrl}:${tier}`;
  if (cacheKey && compiledModuleCache.has(cacheKey)) {
    return compiledModuleCache.get(cacheKey)!;
  }

  const loadPromise = (async (): Promise<LoadedZippBindings> => {
    const normalizedBase = runtimeUrl.replace(/[\\/]?$/, '/');
    let targetSource: BufferSource | WebAssembly.Module | string =
      explicitSource ?? `${normalizedBase}engines/${ENGINE_FILENAMES[tier]}`;
    if (!explicitSource && isNodeRuntime() && typeof targetSource === 'string') {
      const fsMod = await import('node:fs');
      if (!fsMod.existsSync(targetSource)) {
        const pathMod = await import('node:path');
        if (tier === 'php' || tier === 'rust') {
          const devRepo = process.env.ZIPP_DEV_REPO;
          if (devRepo) {
            const embeddedDir = pathMod.join(devRepo, 'crates', 'zipp-wasm', 'dist', 'embedded');
            if (fsMod.existsSync(embeddedDir)) {
              const suffix = `-javascript-${tier}.wasm`;
              const match = fsMod.readdirSync(embeddedDir).find((f) => f.endsWith(suffix));
              if (match) targetSource = pathMod.join(embeddedDir, match);
            }
          }
        } else {
          const pkgRoot = await resolveNodeContainerPkgRoot();
          if (pkgRoot) {
            const fallbackPath = pathMod.resolve(pkgRoot, '..', 'core', 'wasm-zipp', 'zipp_wasm_bg.wasm');
            if (fsMod.existsSync(fallbackPath)) {
              targetSource = fallbackPath;
            }
          }
        }
      }
    }
    const module = await compileWasmSource(targetSource);
    const metaJson = readCustomSection(module, META_SECTION);
    const meta = metaJson ? (JSON.parse(metaJson) as Record<string, unknown>) : null;
    const glueText = readCustomSection(module, GLUE_SECTION);

    let bindings: Record<string, unknown> | null = null;
    // Prefer same-origin `.glue.js` in browser/Worker contexts so strict `script-src 'self'` CSPs succeed without `blob:` or `data:`
    if (!isNodeRuntime()) {
      const glueFile = glueFileFor(tier, meta);
      const baseHref =
        typeof document !== 'undefined'
          ? document.baseURI
          : typeof self !== 'undefined' && self.location
            ? self.location.href
            : undefined;
      try {
        const glueUrl = baseHref
          ? new URL(`${normalizedBase}engines/${glueFile}`, baseHref).href
          : `${normalizedBase}engines/${glueFile}`;
        bindings = (await import(/* @vite-ignore */ glueUrl)) as Record<string, unknown>;
      } catch {
        bindings = null;
      }
    }
    if (!bindings) {
      if (glueText) {
        bindings = await importGlueText(glueText);
      } else if (fallbackGlueFactory) {
        bindings = await fallbackGlueFactory();
      } else {
        throw new Error('ZIPP .wasm module contains no zipp.glue section and no fallback glue was provided');
      }
    }

    const initFn = bindings.default as (arg: { module_or_path: WebAssembly.Module }) => Promise<unknown>;
    await initFn({ module_or_path: module });
    if (typeof bindings.zipp_install_panic_hook === 'function') {
      (bindings.zipp_install_panic_hook as () => void)();
    }

    const profile =
      typeof bindings.zippProfile === 'function'
        ? (JSON.parse((bindings.zippProfile as () => string)()) as Record<string, unknown>)
        : {};

    return {
      Engine: bindings.Engine as new () => ZippEngineInstance,
      PhpApp: typeof bindings.PhpApp === 'function' ? (bindings.PhpApp as new () => ZippPhpAppInstance) : undefined,
      hostStepsRemaining: typeof bindings.hostStepsRemaining === 'function' ? (bindings.hostStepsRemaining as () => number) : undefined,
      hostChargeSteps: typeof bindings.hostChargeSteps === 'function' ? (bindings.hostChargeSteps as (steps: number) => void) : undefined,
      meta,
      profile,
      module,
    };
  })();

  if (cacheKey) {
    compiledModuleCache.set(cacheKey, loadPromise);
    loadPromise.catch(() => compiledModuleCache.delete(cacheKey));
  }
  return loadPromise;
}
