/**
 * SoftN Scripting Bridge
 *
 * Integrates the scripting VM with the SoftN runtime. The engine itself is
 * selected in `./vm-adapter` — currently zipp, a JavaScript engine written in
 * Rust and compiled to WASM. All .logic code executes inside the WASM VM, so
 * the sandbox holds: no `eval`, no `new Function`, and no host object the
 * engine preamble did not hand over.
 */

import {
  VmAdapter,
  VM_BRIDGE_PREAMBLE,
  type SymbolScope,
} from './vm-adapter';
import { deepEqual } from './vm-state';

import type { ScriptBlock, LogicBlock } from '../parser/ast';
import type { AppPermissions } from '../bundle/types';
import { getFileByRef, registerFileRef } from './file-registry';
import type {
  BundleFileProvider,
  AIPermissionConfig,
  GpuPermissionConfig,
  ModelSource,
  OnnxFeeds,
  OnnxRunOptions,
  PipelineTask,
  PipelineOptions,
  GenerateOptions,
  DirectModelOptions,
  ChatMessage,
} from './ai-manager';
export type { BundleFileProvider } from './ai-manager';

/**
 * Type alias for code blocks - either ScriptBlock or LogicBlock
 */
export type CodeBlock = ScriptBlock | LogicBlock;
import type { RuntimeState, XDBRecord } from '../types';

/**
 * Execution context handed to SoftN scripts.
 */
export interface ScriptContext {
  // State management
  state: RuntimeState;
  setState: (path: string, value: unknown) => void;
  /** Batch multiple state changes into a single React setState call (optional optimization) */
  batchSetState?: (changes: Record<string, unknown>) => void;

  // XDB data
  data: Record<string, XDBRecord[]>;

  // XDB operations
  xdb: XDBModule;

  // Navigation
  nav: NavModule;

  // Console (for debugging)
  console: ConsoleModule;
}

/**
 * XDB module for SoftN scripts
 */
export interface XDBModule {
  create: (collection: string, data: Record<string, unknown>) => Promise<XDBRecord>;
  update: (id: string, data: Record<string, unknown>) => Promise<XDBRecord>;
  delete: (id: string) => Promise<void>;
  query: (collection: string, filter?: Record<string, unknown>) => Promise<XDBRecord[]>;
  get: (collection: string, id: string) => Promise<XDBRecord | null>;
  sync: () => Promise<void>;
}

/**
 * Navigation module for SoftN scripts
 */
export interface NavModule {
  goto: (page: string) => void;
  back: () => void;
  params: Record<string, string>;
}

/**
 * Console module for SoftN scripts
 */
export interface ConsoleModule {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export type ScriptRuntimeMode = 'main' | 'worker';

export interface ScriptRuntimeOptions {
  mode?: ScriptRuntimeMode;
  /**
   * Logic files the host already concatenated into `script.code` itself.
   *
   * A host that assembles a bundle may inline manifest-listed `.logic` files
   * ahead of the entry file. Those files are then already part of this
   * compilation, so an `import` naming one must not inline it a second time —
   * every class and variable in it would be declared twice, which the VM
   * rejects. Paths are bundle-relative, matching what `importResolver` takes.
   */
  preIncludedLogicPaths?: readonly string[];
  /**
   * The bundle's parsed `permission.json`.
   *
   * Without it every capability check runs in "no config" mode, which is
   * permissive for most APIs but still refuses plain `http://` — so a bundle
   * that legitimately declares `net.allow_http` cannot reach its own server.
   */
  permissionConfig?: PermissionConfig;
}

export interface ScriptLoadResult {
  state: Record<string, unknown>;
  functions: Record<string, (...args: unknown[]) => Promise<unknown>>;
  syncFunctions: Record<string, (...args: unknown[]) => unknown>;
  computed: Record<string, () => unknown>;
}

export interface ScriptRuntimeHandle {
  loadScript: (script: CodeBlock) => Promise<ScriptLoadResult>;
  updateContext: (newState: Partial<RuntimeState>) => void;
  cleanup: () => void;
}

/**
 * Permission config from permission.json — describes what capabilities an app needs.
 */
export interface PermissionConfig {
  app?: { id?: string; name?: string; version?: string };
  permissions: {
    net?: { enabled?: boolean; allowed_hosts?: string[]; allow_http?: boolean };
    camera?: { enabled?: boolean; modes?: string[] };
    files?: { enabled?: boolean; scopes?: string[] };
    qr?: { enabled?: boolean };
    ai?: AIPermissionConfig;
    gpu?: GpuPermissionConfig;
    sync?: { enabled?: boolean };
  };
}

/** Pending host call from the VM (mirrors Rust PendingHostCall) */
interface PendingHostCall {
  id: number;
  kind: string;
  args: string[];
}

/**
 * Bridge preamble for the softn.* namespace.
 * Builds a JS object that delegates to host.call() for each capability.
 */
const SOFTN_BRIDGE_PREAMBLE = `
let softn = {
  net: {
    fetch: function(url, options, callback) {
      host.call("net.fetch", [url, typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
    }
  },
  qr: {
    encode: function(text, options, callback) {
      host.call("qr.encode", [text, typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
    },
    decode: function(imageDataUrl, callback) {
      host.call("qr.decode", [imageDataUrl], callback);
    }
  },
  camera: {
    capturePhoto: function(options, callback) {
      host.call("camera.capturePhoto", [typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
    },
    recordVideo: function(options, callback) {
      host.call("camera.recordVideo", [typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
    },
    startLive: function(options, callback) {
      host.call("camera.startLive", [typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
    },
    stopLive: function() {
      host.call("camera.stopLive", [], function(){});
    }
  },
  files: {
    pickFile: function(options, callback) {
      host.call("files.pickFile", [typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
    },
    readText: function(fileRef, callback) {
      host.call("files.readText", [fileRef], callback);
    },
    readBase64: function(fileRef, callback) {
      host.call("files.readBase64", [fileRef], callback);
    }
  },
  ai: {
    getCapabilities: function(callback) {
      host.call("ai.getCapabilities", [], callback);
    },
    onnx: {
      loadModel: function(source, options, callback) {
        if (typeof options === "function") { callback = options; options = {}; }
        host.call("ai.onnx.loadModel", [typeof source === "object" ? JSON.stringify(source) : source, typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
      },
      run: function(sessionId, feeds, options, callback) {
        if (typeof options === "function") { callback = options; options = {}; }
        host.call("ai.onnx.run", [sessionId, typeof feeds === "object" ? JSON.stringify(feeds) : feeds, typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
      },
      release: function(sessionId, callback) {
        host.call("ai.onnx.release", [sessionId], callback);
      }
    },
    pipeline: function(task, model, options, callback) {
      if (typeof model === "function") { callback = model; model = ""; options = {}; }
      if (typeof options === "function") { callback = options; options = {}; }
      host.call("ai.pipeline", [task, model || "", typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
    },
    generate: function(pipelineId, prompt, options, callback) {
      if (typeof options === "function") { callback = options; options = {}; }
      host.call("ai.generate", [pipelineId, prompt, typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
    },
    embed: function(pipelineId, texts, callback) {
      host.call("ai.embed", [pipelineId, typeof texts === "object" ? JSON.stringify(texts) : texts], callback);
    },
    classify: function(pipelineId, text, callback) {
      host.call("ai.classify", [pipelineId, text], callback);
    },
    run: function(pipelineId, input, options, callback) {
      if (typeof options === "function") { callback = options; options = {}; }
      host.call("ai.run", [pipelineId, typeof input === "object" ? JSON.stringify(input) : input, typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
    },
    releaseAll: function(callback) {
      host.call("ai.releaseAll", [], callback);
    },
    model: {
      load: function(modelId, options, callback) {
        if (typeof options === "function") { callback = options; options = {}; }
        host.call("ai.model.load", [modelId, typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
      },
      generate: function(modelHandle, messages, options, callback) {
        if (typeof options === "function") { callback = options; options = {}; }
        host.call("ai.model.generate", [modelHandle, typeof messages === "object" ? JSON.stringify(messages) : messages, typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
      },
      release: function(modelHandle, callback) {
        host.call("ai.model.release", [modelHandle], callback);
      }
    },
    gpu: {
      requestDevice: function(options, callback) {
        if (typeof options === "function") { callback = options; options = {}; }
        host.call("ai.gpu.requestDevice", [typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
      },
      createBuffer: function(source, usage, callback) {
        host.call("ai.gpu.createBuffer", [typeof source === "object" ? JSON.stringify(source) : source, usage], callback);
      },
      writeBuffer: function(bufferId, data, dtype, callback) {
        if (typeof dtype === "function") { callback = dtype; dtype = ""; }
        host.call("ai.gpu.writeBuffer", [bufferId, typeof data === "object" ? JSON.stringify(data) : data, dtype || ""], callback);
      },
      createShader: function(source, callback) {
        host.call("ai.gpu.createShader", [typeof source === "object" ? JSON.stringify(source) : source], callback);
      },
      createPipeline: function(options, callback) {
        host.call("ai.gpu.createPipeline", [typeof options === "object" ? JSON.stringify(options) : options], callback);
      },
      dispatch: function(pipelineId, bindings, workgroups, callback) {
        host.call("ai.gpu.dispatch", [pipelineId, JSON.stringify(bindings), JSON.stringify(workgroups)], callback);
      },
      readBuffer: function(bufferId, callback) {
        host.call("ai.gpu.readBuffer", [bufferId], callback);
      },
      release: function(resourceId, callback) {
        host.call("ai.gpu.release", [resourceId], callback);
      },
      releaseAll: function(callback) {
        host.call("ai.gpu.releaseAll", [], callback);
      }
    }
  }
};
`;

/**
 * Optional WASM-based host bridge detector. Set by the WASM adapter when loaded.
 * Uses the Rust lexer for proper lexical analysis instead of regex.
 */
let _wasmDetectHostBridges: ((code: string) => string[]) | null = null;

/** Register the WASM-based detectHostBridges function (called by WasmFormLogicAdapter). */
export function setWasmDetectHostBridges(fn: (code: string) => string[]): void {
  _wasmDetectHostBridges = fn;
}

/**
 * Fast compatibility check used for worker-mode migration gating.
 * Scripts that rely on synchronous host bridges are currently main-thread only.
 *
 * Uses the WASM lexer (detectHostBridges) when available for robust token-level
 * analysis that correctly handles comments, strings, template literals, and regex.
 * Falls back to regex-based stripping when WASM is not loaded.
 */
export function detectWorkerIncompatibilities(code: string): string[] {
  if (!code) return [];

  // Try WASM lexer first — proper lexical analysis, no false positives from
  // regex edge cases (regex literals, nested template strings, etc.)
  if (_wasmDetectHostBridges) {
    try {
      return _wasmDetectHostBridges(code);
    } catch {
      // WASM call failed — fall through to regex fallback
    }
  }

  // Regex fallback: strip comments and string literals to prevent false positives.
  const stripped = code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n\r]*/g, '')
    .replace(/`(?:[^`\\]|\\.)*`/g, '""')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, '""');

  const reasons: string[] = [];
  const checks: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /\bdb\./, reason: 'uses db bridge (synchronous host access)' },
    { pattern: /\bwindow\./, reason: 'uses window bridge/event APIs' },
    { pattern: /\bnavigator\./, reason: 'uses navigator bridge APIs' },
    { pattern: /\blocalStorage\./, reason: 'uses localStorage bridge' },
    { pattern: /\bhost\./, reason: 'uses host.call bridge (async host access)' },
  ];

  for (const check of checks) {
    if (check.pattern.test(stripped)) {
      reasons.push(check.reason);
    }
  }

  return reasons;
}

/**
 * Names of variables added by BRIDGE_PREAMBLE that should not be treated
 * as user state variables.
 */
const BRIDGE_VARS = new Set(['window', 'navigator', 'host', 'softn']);

/** Prefix for the functions generated from `$:` declarations. */
const COMPUTED_PREFIX = '__softnComputed_';

/** A name safe to paste into generated source as an identifier. */
const VALID_IDENTIFIER = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

/**
 * Extract safe, serializable properties from a browser Event for passing to the VM.
 * Only extracts primitive-valued properties — no DOM nodes, functions, or circular refs.
 */
function extractEventProps(event: Event): Record<string, unknown> {
  const props: Record<string, unknown> = { type: event.type };

  if (event instanceof KeyboardEvent) {
    props.key = event.key;
    props.code = event.code;
    props.altKey = event.altKey;
    props.ctrlKey = event.ctrlKey;
    props.shiftKey = event.shiftKey;
    props.metaKey = event.metaKey;
    props.repeat = event.repeat;
  } else if (event instanceof MouseEvent) {
    props.clientX = event.clientX;
    props.clientY = event.clientY;
    props.offsetX = event.offsetX;
    props.offsetY = event.offsetY;
    props.button = event.button;
    props.buttons = event.buttons;
    props.altKey = event.altKey;
    props.ctrlKey = event.ctrlKey;
    props.shiftKey = event.shiftKey;
    props.metaKey = event.metaKey;
  } else if (event instanceof TouchEvent) {
    props.touches = event.touches.length;
    props.changedTouches = event.changedTouches.length;
  }

  return props;
}

/**
 * Extract `$: name = expression;` reactive declarations from source code.
 * Uses a comment/string-aware scanner to avoid matching inside comments or strings,
 * and supports multi-line expressions by balancing brackets.
 */
function extractComputedDeclarations(
  code: string
): Array<{ name: string; expression: string }> {
  const results: Array<{ name: string; expression: string }> = [];
  const len = code.length;
  let i = 0;

  while (i < len) {
    const ch = code[i];

    // Skip single-line comments
    if (ch === '/' && i + 1 < len && code[i + 1] === '/') {
      i += 2;
      while (i < len && code[i] !== '\n') i++;
      continue;
    }

    // Skip multi-line comments
    if (ch === '/' && i + 1 < len && code[i + 1] === '*') {
      i += 2;
      while (i < len && !(code[i] === '*' && i + 1 < len && code[i + 1] === '/')) i++;
      if (i + 1 < len) i += 2; // skip */ (with bounds check)
      continue;
    }

    // Skip string literals
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < len && code[i] !== quote) {
        if (code[i] === '\\' && i + 1 < len) i++; // skip escaped char (with bounds check)
        i++;
      }
      if (i < len) i++; // skip closing quote (with bounds check)
      continue;
    }

    // Look for `$:` at a statement boundary (start of line or after whitespace/semicolon)
    if (ch === '$' && i + 1 < len && code[i + 1] === ':') {
      // Verify it's at a statement boundary (not part of an identifier like `a$:`)
      const prev = i > 0 ? code[i - 1] : '\n';
      if (prev === '\n' || prev === ';' || prev === '{' || prev === '}' || /\s/.test(prev)) {
        let j = i + 2; // skip "$:"
        // Skip whitespace
        while (j < len && (code[j] === ' ' || code[j] === '\t')) j++;

        // Extract variable name
        const nameStart = j;
        while (j < len && /\w/.test(code[j])) j++;
        const name = code.substring(nameStart, j);

        if (name) {
          // Skip whitespace and '='
          while (j < len && (code[j] === ' ' || code[j] === '\t')) j++;
          if (j < len && code[j] === '=') {
            j++; // skip '='
            while (j < len && (code[j] === ' ' || code[j] === '\t')) j++;

            // Extract expression — balance brackets until ';' at depth 0
            // Skips strings AND comments to avoid false termination
            const exprStart = j;
            let depth = 0;
            while (j < len) {
              const ec = code[j];
              // Skip single-line comments inside expression
              if (ec === '/' && j + 1 < len && code[j + 1] === '/') {
                j += 2;
                while (j < len && code[j] !== '\n') j++;
                continue;
              }
              // Skip multi-line comments inside expression
              if (ec === '/' && j + 1 < len && code[j + 1] === '*') {
                j += 2;
                while (j < len && !(code[j] === '*' && j + 1 < len && code[j + 1] === '/')) j++;
                if (j + 1 < len) j += 2;
                continue;
              }
              if (ec === '(' || ec === '[' || ec === '{') {
                depth++;
              } else if (ec === ')' || ec === ']' || ec === '}') {
                depth--;
              } else if (ec === '"' || ec === "'" || ec === '`') {
                // Skip string inside expression
                const q = ec;
                j++;
                while (j < len && code[j] !== q) {
                  if (code[j] === '\\' && j + 1 < len) j++;
                  j++;
                }
              } else if (ec === ';' && depth === 0) {
                break;
              } else if (ec === '\n' && depth === 0) {
                // Newline at depth 0 also ends the expression (ASI)
                break;
              }
              j++;
            }
            const expression = code.substring(exprStart, j).trim();
            if (expression) {
              results.push({ name, expression });
            }
          }
        }
        i = j + 1;
        continue;
      }
    }

    i++;
  }

  return results;
}

/**
 * SoftN Script Runtime
 * Executes .logic code inside the WASM VM for true sandboxing.
 * No `new Function()` calls are used — all user code runs in the VM.
 */
export class SoftNScriptRuntime {
  private vmEngine: VmAdapter | null = null;
  private context: ScriptContext;
  private db: DBNamespace;
  private permissions?: AppPermissions;
  private appId?: string;
  private runtimeMode: ScriptRuntimeMode;
  /** Cached XDB service for notification batching */
  private xdbService: import('./xdb').XDBService | null = null;

  /** Symbol map from VM globals (set after initializeScript) */
  private symbolMap: Map<string, { index: number; scope: SymbolScope }> | null = null;
  /** Names of state variables (non-function, non-bridge globals) */
  private stateVarNames: string[] = [];
  /** Cached slot indices for state variables (parallel to stateVarNames) */
  private stateVarIndices: number[] = [];
  /** Guard: when true, sync functions must not overwrite VM state (async call in-flight) */
  private asyncCallInProgress = false;
  /** Mutex for async VM calls to prevent concurrent stack corruption.
   *  Uses a release-function pattern instead of .then() chaining to avoid
   *  unbounded promise chain growth that causes GC pressure over time. */
  private vmCallLock: Promise<void> = Promise.resolve();
  /** Current depth of queued async VM calls. If this exceeds the limit,
   *  new calls are dropped with a warning to prevent memory pressure and input lag. */
  private vmCallQueueDepth = 0;
  /**
   * Granular dirty tracking: tracks which specific state keys have changed since
   * the last syncReactStateToVM(). Only the dirty keys are synced to the VM,
   * avoiding redundant WASM boundary crossings for unchanged state.
   * Initialized to null to signal "sync all" on first call.
   */
  private dirtyStateKeys: Set<string> | null = null;

  /**
   * Per-render cache for sync function results.
   * Cleared when state changes (via syncReactStateToVM dirty detection)
   * and automatically expires between render frames (>2ms gap detection).
   */
  private syncCallCache = new Map<string, unknown>();
  /** Timestamp of last sync function call — for frame boundary detection. */
  private lastSyncCallTs = 0;

  /**
   * Active native event listeners for the window bridge.
   * Managed at the JS level since the WASM VM stores handler Values internally.
   */
  private nativeListeners: Map<string, EventListener[]> = new Map();

  /** Index of the `window` global in the VM */
  private windowGlobalIndex: number = -1;

  /** Set of __ window property keys to sync */
  private syncKeys: Set<string> = new Set();
  /** Cached: true when at least one syncKey is defined on the real window */
  private windowSyncActive = false;

  /** Event types already bridged from VM → browser (prevents duplicate listeners) */
  private bridgedEventTypes: Set<string> = new Set();

  /** Import resolver for .logic file imports (resolves path → source code) */
  private importResolver?: (path: string) => Promise<string | null>;
  /** Base path of the .logic file for resolving relative imports */
  private logicBasePath?: string;
  /**
   * Every `.logic` path already part of this compilation — whether the host
   * concatenated it or an earlier import pulled it in. The single registry
   * that makes inclusion idempotent no matter which path reached the file.
   */
  private includedLogicPaths = new Set<string>();

  /** Permission config from permission.json (set via setPermissionConfig) */
  private permissionConfig: PermissionConfig | null = null;

  /** Lazy-loaded ONNX manager (created on first softn.ai.onnx.* call) */
  private onnxManager: import('./ai-onnx-manager').OnnxManager | null = null;
  /** Lazy-loaded Transformers.js manager (created on first softn.ai.pipeline/generate/embed/classify call) */
  private transformersManager: import('./ai-transformers-manager').TransformersManager | null = null;
  /** Lazy-loaded GPU compute manager (created on first softn.ai.gpu.* call) */
  private gpuComputeManager: import('./ai-gpu-compute-manager').GpuComputeManager | null = null;
  /** Bundle file provider for loading models from .softn bundles */
  private bundleFileProvider: BundleFileProvider | null = null;
  /** External functions (e.g. wallet bridge) to inject into the VM as callable globals */
  private externalFunctions: Record<string, (...args: unknown[]) => unknown> | null = null;

  constructor(
    context: ScriptContext,
    permissions?: AppPermissions,
    appId?: string,
    importResolver?: unknown,
    logicBasePath?: string,
    options?: ScriptRuntimeOptions,
    bundleFileProvider?: BundleFileProvider,
    externalFunctions?: Record<string, (...args: unknown[]) => unknown>
  ) {
    this.context = context;
    this.permissions = permissions;
    this.appId = appId;
    this.runtimeMode = options?.mode || 'main';
    this.externalFunctions = externalFunctions ?? null;
    this.db = createDBNamespace(() => this.permissionConfig, appId);
    if (typeof importResolver === 'function') {
      this.importResolver = importResolver as (path: string) => Promise<string | null>;
    }
    this.logicBasePath = logicBasePath;
    this.bundleFileProvider = bundleFileProvider ?? null;
    if (options?.permissionConfig) {
      this.permissionConfig = options.permissionConfig;
    }
    for (const p of options?.preIncludedLogicPaths ?? []) {
      this.includedLogicPaths.add(p);
    }
  }

  /** Set the permission config for this runtime (from permission.json). */
  setPermissionConfig(config: PermissionConfig): void {
    this.permissionConfig = config;
  }


  /**
   * Load and execute a script or logic block inside the WASM VM.
   */
  /**
   * Empty result for a load that was abandoned before it could run.
   */
  private static readonly ABANDONED: ScriptLoadResult = {
    state: {},
    functions: {},
    syncFunctions: {},
    computed: {},
  };

  /**
   * True once `cleanup()` has run.
   *
   * `loadScript` is a long async chain and `cleanup()` only disposes an engine
   * that already exists. A cleanup arriving while the first `await` is still
   * pending therefore disposed nothing, and the continuation went on to build a
   * fresh engine and execute the script in it — leaking one WASM engine per
   * mount and running the `.logic` top level a second time. Under
   * `React.StrictMode`, which all four apps use, that is every single mount:
   * measured with a bundle whose top level calls `db.create`, two records
   * appeared where the author wrote one.
   */
  private disposed = false;

  /** Stop and clean up if this runtime was disposed during an await. */
  private abandonIfDisposed(): boolean {
    if (!this.disposed) return false;
    if (this.vmEngine) {
      this.vmEngine.dispose();
      this.vmEngine = null;
    }
    return true;
  }

  async loadScript(script: CodeBlock): Promise<ScriptLoadResult> {
    const useHostBridges = this.runtimeMode === 'main';

    // 0. Create the WASM adapter
    this.vmEngine = await VmAdapter.create();
    if (this.abandonIfDisposed()) return SoftNScriptRuntime.ABANDONED;

    if (useHostBridges) {
      // 1. Ensure XDB is fully initialized before executing any .logic code
      await this.db.ready();
      if (this.abandonIfDisposed()) return SoftNScriptRuntime.ABANDONED;

      // Cache XDB service reference for notification batching
      try {
        const { getXDB } = await import('./xdb');
        this.xdbService = getXDB(this.appId);
      } catch { /* XDB not available — batching disabled */ }
      if (this.abandonIfDisposed()) return SoftNScriptRuntime.ABANDONED;

      // 2. Register bridges on the WASM engine BEFORE compilation/execution
      this.vmEngine.registerDBBridge(this.db);

      const perms = this.permissions || {};
      if (perms.storage !== false) {
        this.vmEngine.registerLocalStorageBridge(this.appId);
      }
    }

    // 3. Resolve imports (inline imported .logic files before passing to WASM)
    let resolvedCode = script.code;
    if (this.importResolver) {
      // The entry file is already in `script.code`, so it counts as included
      // for dedupe as well as being the root of the cycle-detection chain.
      if (this.logicBasePath) this.includedLogicPaths.add(this.logicBasePath);
      resolvedCode = await this.resolveImports(
        resolvedCode,
        new Set(this.logicBasePath ? [this.logicBasePath] : []),
        this.logicBasePath
      );
      // Import resolution fetches files, so this is the longest await of the
      // three and the one most likely to still be pending at cleanup.
      if (this.abandonIfDisposed()) return SoftNScriptRuntime.ABANDONED;
    }

    // 4. Generate preamble for external functions (e.g. wallet bridge)
    // Calls each function with no args; if it returns a primitive synchronously,
    // injects a function declaration so .logic code can call it.
    let extFnPreamble = '';
    if (this.externalFunctions) {
      for (const [name, fn] of Object.entries(this.externalFunctions)) {
        // Skip names that aren't valid JS identifiers or XDB helpers
        if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) continue;
        if (name.startsWith('xdb_') || name === 'asset') continue;
        try {
          const result = fn();
          // Skip async results (Promises) — swallow their rejections
          if (result != null && typeof (result as { then?: unknown }).then === 'function') {
            (result as Promise<unknown>).catch(() => {});
            continue;
          }
          // Only inject primitives + null
          if (typeof result === 'string' || typeof result === 'number' ||
              typeof result === 'boolean' || result === null || result === undefined) {
            const serialized = result === undefined ? 'undefined' : JSON.stringify(result);
            extFnPreamble += `function ${name}() { return ${serialized}; }\n`;
          }
        } catch {
          // Function needs args or threw — skip
        }
      }
    }

    // 4b. Compile each `$:` declaration into a real function.
    //
    // These are re-read on every render, and evaluating an expression *string*
    // costs a fresh parse each time — the engine interns the result for the VM's
    // lifetime, so a per-frame expression grows the heap until the tab dies.
    // Compiled once alongside the script, each becomes an ordinary call.
    // The expression is raw source and keeps whatever trailed it, including a
    // `// comment`. Each piece therefore gets its own line: on one line a
    // trailing comment would swallow the closing `);` and take the whole
    // script's compilation down with it, not just this one value.
    const computedDecls = extractComputedDeclarations(script.code)
      .filter(d => VALID_IDENTIFIER.test(d.name) && d.expression.trim() !== '');
    const computedPreamble = computedDecls
      .map(d => `function ${COMPUTED_PREFIX}${d.name}() {\nreturn (\n${d.expression}\n);\n}`)
      .join('\n');

    // 5. Prepend the engine's bridge preamble (empty on zipp, which declares
    // window/navigator/db/localStorage/host itself) then SoftN's own.
    const scriptCode = VM_BRIDGE_PREAMBLE + SOFTN_BRIDGE_PREAMBLE + extFnPreamble + resolvedCode;
    const fullCode = computedPreamble ? scriptCode + '\n' + computedPreamble : scriptCode;

    // 5. Compile + run the full .logic code in the WASM VM.
    //
    // The generated `$:` bodies share the script's compilation unit, so a
    // declaration the scanner mis-extracts — an expression broken across lines
    // in a way it cannot follow, say — would fail the whole script rather than
    // the one value it belongs to. On that failure, compile the script without
    // them and evaluate those expressions one at a time instead.
    let computedCompiled = computedPreamble !== '';
    let symbolMap: Map<string, { index: number; scope: SymbolScope }>;
    try {
      symbolMap = await this.vmEngine.initializeScript(fullCode);
    } catch (compileError) {
      if (!computedCompiled) throw compileError;
      console.warn(
        '[SoftN] A `$:` declaration could not be compiled, so all of them fall back ' +
          'to per-render evaluation. The script itself is unaffected. Cause:',
        compileError
      );
      computedCompiled = false;
      symbolMap = await this.vmEngine.initializeScript(scriptCode);
    }
    this.symbolMap = symbolMap;

    // 6. Set up window global index (sync keys are discovered dynamically)
    if (useHostBridges) {
      const windowSym = symbolMap.get('window');
      if (windowSym) {
        this.windowGlobalIndex = windowSym.index;
      }
    }

    // 6. Read initial state from VM globals and classify symbols
    const initialState: Record<string, unknown> = {};
    const functionNames: string[] = [];
    const stateVarNames: string[] = [];

    for (const [name, sym] of symbolMap.entries()) {
      // Skip bridge-injected variables
      if (BRIDGE_VARS.has(name)) continue;

      // Generated `$:` bodies are engine plumbing, not script API.
      if (name.startsWith(COMPUTED_PREFIX)) continue;

      if (sym.scope === 'function') {
        functionNames.push(name);
      } else {
        stateVarNames.push(name);
        // WASM returns plain JS values — no formLogicToJS conversion needed
        initialState[name] = this.vmEngine.getGlobal(sym.index);
      }
    }
    this.stateVarNames = stateVarNames;
    this.stateVarIndices = stateVarNames.map(name => symbolMap.get(name)!.index);
    console.log(`[SoftN] Script loaded: ${functionNames.length} functions, ${stateVarNames.length} state vars`);

    // 7. Create async function wrappers (propagate state changes to React)
    // Rapid-fire event handlers (mousemove, scroll, etc.) are marked droppable —
    // safe to skip under queue saturation since they'll be superseded by the next
    // event. All other functions (clicks, submits, etc.) are critical and will
    // queue up to a hard limit to guarantee execution.
    const DROPPABLE_PATTERN = /^on_?(mouse_?move|pointer_?move|scroll|touch_?move|wheel)|^(tick|update|animate|render)/i;
    const functions: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    for (const name of functionNames) {
      functions[name] = this.createVMFunction(name, { droppable: DROPPABLE_PATTERN.test(name) });
    }

    // 8. Create sync function wrappers (for template expressions, no state propagation)
    const syncFunctions: Record<string, (...args: unknown[]) => unknown> = {};
    for (const name of functionNames) {
      syncFunctions[name] = this.createVMSyncFunction(name);
    }

    // 9. Computed values, each bound to the function compiled for it in 4b.
    const computed: Record<string, () => unknown> = {};
    for (const { name, expression } of computedDecls) {
      if (computedCompiled) {
        const fn = `${COMPUTED_PREFIX}${name}`;
        computed[name] = () => this.callComputed(fn, name);
      } else {
        computed[name] = () => this.evaluateExpression(expression);
      }
    }

    return {
      state: initialState,
      functions,
      syncFunctions,
      computed,
    };
  }

  /**
   * Create an async function wrapper that:
   * 1. Syncs React state → VM globals
   * 2. Calls the VM function
   * 3. Syncs VM globals → React state
   */
  // Performance instrumentation for async VM calls
  private _perfCallCount = 0;
  private _perfTotalMs = 0;
  private _perfLastReport = 0;
  private _perfWasmMs = 0;
  private _perfSyncToReactMs = 0;
  private _perfSyncToVMMs = 0;
  private _perfChangedVars = 0;

  private createVMFunction(name: string, options?: { droppable?: boolean }): (...args: unknown[]) => Promise<unknown> {
    const droppable = options?.droppable ?? false;
    // Droppable calls (rapid-fire events) are dropped at the soft limit.
    // Critical calls (user interactions) are only dropped at the hard limit.
    const QUEUE_SOFT_LIMIT = 32;
    const QUEUE_HARD_LIMIT = 128;

    return async (...args: unknown[]): Promise<unknown> => {
      // Guard against unbounded queue growth from rapid async events.
      if (droppable && this.vmCallQueueDepth >= QUEUE_SOFT_LIMIT) {
        // Safe to drop: rapid-fire events are superseded by the next one
        return undefined;
      }
      if (this.vmCallQueueDepth >= QUEUE_HARD_LIMIT) {
        console.error(`[SoftN] Dropping VM call to ${name}: hard queue limit reached (${this.vmCallQueueDepth})`);
        return undefined;
      }
      this.vmCallQueueDepth++;

      // Acquire the lock — serializes async VM calls to prevent concurrent
      // stack corruption. Uses a release-function pattern (not .then() chaining)
      // to avoid unbounded promise chain growth.
      await this.vmCallLock;
      let release: (() => void) | undefined;
      this.vmCallLock = new Promise<void>((r) => { release = r; });

      const t0 = performance.now();
      try {
        this.asyncCallInProgress = true;
        // Async call may change state — invalidate sync cache preemptively.
        this.syncCallCache.clear();

        const tSyncStart = performance.now();
        this.syncReactStateToVM();
        // Sync real browser window → VM window
        this.syncWindowToVM();
        this._perfSyncToVMMs += performance.now() - tSyncStart;

        // Suppress XDB notifications during the WASM call — all db mutations
        // within the function are batched into a single notification per collection
        // at the end, instead of firing on every individual create/update/delete.
        // This eliminates O(n) re-queries when functions like startHand() do 20+ mutations.
        this.xdbService?.suppressNotifications();

        // WASM engine takes plain JS args directly — no conversion needed
        const tWasm = performance.now();
        const result = this.vmEngine!.callFunction(name, args);
        this._perfWasmMs += performance.now() - tWasm;

        return result;
      } catch (error) {
        console.error(`[SoftN] Error executing function ${name}:`, error);
        return undefined;
      } finally {
        // Resume XDB notifications — fires one 'refresh' per affected collection.
        this.xdbService?.resumeNotifications();

        // Always sync state back, even if the VM function threw mid-execution.
        // Partial state mutations before the error should be reflected in the UI.
        // Drain pending host calls while we still hold the lock, but DON'T await
        // their execution — that would block other VM calls (e.g. movement ticks)
        // for the entire duration of async operations like AI generation.
        let pendingCalls: unknown[] | null = null;
        try {
          const tSyncReact = performance.now();
          this.syncVMStateToReact();
          this.syncWindowFromVM();
          this._perfSyncToReactMs += performance.now() - tSyncReact;

          // Drain pending host calls while holding the lock
          if (this.vmEngine) {
            const pending = this.vmEngine.drainPendingHostCalls();
            if (pending.length > 0) {
              pendingCalls = pending;
            }
          }

          // After each async call, discover any new VM event listeners and
          // window.__ properties — this bridges keyboard/mouse handlers
          // registered in _init() or other functions to real browser events.
          this.bridgeEventListeners();
          this.discoverWindowSyncKeys();
        } catch (syncError) {
          console.error(`[SoftN] Error syncing state after ${name}:`, syncError);
        }
        this.asyncCallInProgress = false;
        this.vmCallQueueDepth--;
        release!();

        // Process pending host calls OUTSIDE the lock so other VM calls
        // (e.g. movementTick) can execute while async host operations
        // (e.g. AI model generation) are in progress.
        if (pendingCalls) {
          await this.processPendingHostCallsUnlocked(pendingCalls as PendingHostCall[]);
        }

        // Performance reporting
        const elapsed = performance.now() - t0;
        this._perfCallCount++;
        this._perfTotalMs += elapsed;
        const now = performance.now();
        if (now - this._perfLastReport > 5000) {
          const n = this._perfCallCount;
          console.log(
            `[SoftN Perf] ${n} calls in 5s | avg=${(this._perfTotalMs / n).toFixed(1)}ms` +
            ` | wasm=${(this._perfWasmMs / n).toFixed(1)}ms` +
            ` | syncToVM=${(this._perfSyncToVMMs / n).toFixed(1)}ms` +
            ` | syncToReact=${(this._perfSyncToReactMs / n).toFixed(1)}ms` +
            ` | changedVars=${(this._perfChangedVars / n).toFixed(1)}/tick` +
            ` | stateVars=${this.stateVarNames.length}`
          );
          this._perfCallCount = 0;
          this._perfTotalMs = 0;
          this._perfWasmMs = 0;
          this._perfSyncToVMMs = 0;
          this._perfSyncToReactMs = 0;
          this._perfChangedVars = 0;
          this._perfLastReport = now;
        }
      }
    };
  }

  /**
   * Create a sync function wrapper for template expressions.
   * Does NOT propagate state changes (used during React render).
   * Stripped to bare minimum for performance — window sync is only done
   * in async wrappers (needed for Scene3D mouse-look, not template expressions).
   */
  /**
   * Key for the per-render sync-call cache, or null when the arguments cannot
   * be described by one.
   *
   * Returning null means "call through and do not cache" — the alternative was
   * letting `JSON.stringify` throw on a cyclic argument, which the catch below
   * turned into a rendered `undefined`.
   */
  private syncCacheKey(name: string, args: unknown[]): string | null {
    if (args.length === 0) return name;

    // Primitives are keyed by type *and* value, so `1` and `"1"` stay distinct.
    if (args.length === 1) {
      const a = args[0];
      const t = typeof a;
      if (a === null) return `${name}|null`;
      if (t === 'string' || t === 'number' || t === 'boolean' || t === 'undefined' || t === 'bigint') {
        return `${name}|${t}:${String(a)}`;
      }
    }

    try {
      return `${name}|json:${JSON.stringify(args)}`;
    } catch {
      // Cyclic, or something JSON cannot describe.
      return null;
    }
  }

  private createVMSyncFunction(name: string): (...args: unknown[]) => unknown {
    return (...args: unknown[]): unknown => {
      try {
        // Skip React→VM sync if an async function is in-flight — the VM has
        // the latest state and overwriting it would clobber the async function's changes.
        if (!this.asyncCallInProgress) {
          this.syncReactStateToVM();
        }

        // Per-render frame cache: if >2ms since the last sync call, we've crossed
        // a render frame boundary — clear the cache so results reflect current state.
        // Within a single render, all sync calls happen synchronously (< 1ms apart),
        // so the cache stays valid and avoids redundant WASM boundary crossings.
        const now = performance.now();
        if (now - this.lastSyncCallTs > 2) {
          this.syncCallCache.clear();
        }
        this.lastSyncCallTs = now;

        // Build cache key — optimized for the common single-primitive-arg case.
        //
        // The type has to be part of the key. Interpolating the value alone
        // collapsed `f(1)` and `f("1")` — and `f(true)` and `f("true")`, and
        // `f(null)` and `f("null")` — onto one entry, so within a single render
        // the second call silently returned the first one's answer. A helper
        // that branches on `typeof` then rendered the wrong thing with nothing
        // to suggest it had.
        const cacheKey = this.syncCacheKey(name, args);
        if (cacheKey !== null && this.syncCallCache.has(cacheKey)) {
          return this.syncCallCache.get(cacheKey);
        }

        if (!this.vmEngine) return undefined;
        const result = this.vmEngine.callFunctionSync(name, args);
        if (cacheKey !== null) this.syncCallCache.set(cacheKey, result);
        return result;
      } catch (error) {
        console.error(`[SoftN] Error executing sync function ${name}:`, error);
        return undefined;
      }
    };
  }

  /**
   * Sync React component state → VM globals.
   * Uses batch API: single WASM boundary crossing for all state variables.
   */
  private syncReactStateToVM(): void {
    if (!this.symbolMap || !this.vmEngine) return;
    // _vmDirty is set by the worker runtime when state comes back from the worker thread,
    // ensuring the main-thread WASM VM globals stay in sync with worker-reported state.
    const vmDirty = (this.context as unknown as Record<string, unknown>)._vmDirty;
    // null = initial sync (all keys), empty set = nothing dirty
    const dirty = this.dirtyStateKeys;
    if (dirty !== null && dirty.size === 0 && !vmDirty) return;
    // State is changing — invalidate sync function cache so the next calls
    // execute against fresh VM globals instead of returning stale results.
    this.syncCallCache.clear();
    if (dirty === null || vmDirty) {
      // Full sync: first call or worker pushed new state
      const values = this.stateVarNames.map(name => this.context.state[name]);
      this.vmEngine.setGlobalsBatch(this.stateVarIndices, values);
    } else {
      // Granular sync: only push keys that actually changed
      const indices: number[] = [];
      const values: unknown[] = [];
      for (const key of dirty) {
        const sym = this.symbolMap!.get(key);
        if (sym) {
          indices.push(sym.index);
          values.push(this.context.state[key]);
        }
      }
      if (indices.length > 0) {
        this.vmEngine.setGlobalsBatch(indices, values);
      }
    }
    this.dirtyStateKeys = new Set();
    if (vmDirty) (this.context as unknown as Record<string, unknown>)._vmDirty = false;
  }

  /**
   * Sync VM globals → React component state.
   * Uses VM-side dirty tracking to only deepEqual globals that were actually
   * written during execution, eliminating O(N) deepEqual scans on unchanged state.
   */
  private syncVMStateToReact(): void {
    if (!this.symbolMap || !this.vmEngine) return;

    // Use VM dirty tracking if available (WASM engine only).
    // Only fetch and compare values for globals the VM actually wrote to.
    const hasDirtyTracking = typeof (this.vmEngine as unknown as Record<string, unknown>).getDirtyGlobals === 'function';
    let indicesToCheck: number[];
    let namesToCheck: string[];

    if (hasDirtyTracking) {
      const dirtyIndices = (this.vmEngine as unknown as { getDirtyGlobals(indices: number[]): number[] })
        .getDirtyGlobals(this.stateVarIndices);
      if (dirtyIndices.length === 0) {
        (this.vmEngine as unknown as { clearDirty(): void }).clearDirty();
        return;
      }
      // Build parallel arrays of only the dirty indices/names
      const dirtySet = new Set(dirtyIndices);
      indicesToCheck = [];
      namesToCheck = [];
      for (let i = 0; i < this.stateVarIndices.length; i++) {
        if (dirtySet.has(this.stateVarIndices[i])) {
          indicesToCheck.push(this.stateVarIndices[i]);
          namesToCheck.push(this.stateVarNames[i]);
        }
      }
    } else {
      // Fallback: check all state variables
      indicesToCheck = this.stateVarIndices;
      namesToCheck = this.stateVarNames;
    }

    const allValues = this.vmEngine.getGlobalsBatch(indicesToCheck) as unknown[];
    const changes: Record<string, unknown> = {};
    for (let i = 0; i < namesToCheck.length; i++) {
      const name = namesToCheck[i];
      const newVal = allValues[i];
      const oldVal = this.context.state[name];
      if (!deepEqual(newVal, oldVal)) {
        this.context.state[name] = newVal;
        changes[name] = newVal;
      }
    }

    if (hasDirtyTracking) {
      (this.vmEngine as unknown as { clearDirty(): void }).clearDirty();
    }

    const changedKeys = Object.keys(changes);
    this._perfChangedVars += changedKeys.length;
    if (changedKeys.length === 0) return;
    // Use batch setter if available (single React setState call for all changes)
    if (this.context.batchSetState) {
      this.context.batchSetState(changes);
    } else {
      // Fallback: individual setState calls
      for (const name of changedKeys) {
        this.context.setState(name, changes[name]);
      }
    }
  }

  /**
   * Evaluate an expression synchronously using the VM.
   */
  /**
   * Evaluate one `$:` declaration by calling the function compiled for it.
   *
   * The same work as {@link evaluateExpression}, minus the per-call parse — and
   * these run on every render, which is where that parse would have been paid.
   */
  private callComputed(fnName: string, declName: string): unknown {
    try {
      if (!this.vmEngine) return undefined;
      // Skip React→VM sync if an async function is in-flight
      if (!this.asyncCallInProgress) {
        this.syncReactStateToVM();
      }
      return this.vmEngine.callFunctionSync(fnName, []);
    } catch (error) {
      console.error(`[SoftN] Error evaluating computed "${declName}":`, error);
      return undefined;
    }
  }

  evaluateExpression(expression: string): unknown {
    try {
      if (!this.vmEngine) return undefined;

      // Skip React→VM sync if an async function is in-flight
      if (!this.asyncCallInProgress) {
        this.syncReactStateToVM();
      }
      // WASM returns plain JS values — no conversion needed
      return this.vmEngine.evalSync(expression);
    } catch (error) {
      console.error(`[SoftN] Error evaluating expression "${expression}":`, error);
      return undefined;
    }
  }

  /**
   * Update the context with new state (called by SoftNRenderer when React state changes)
   */
  updateContext(newState: Partial<RuntimeState>): void {
    // Track which specific keys changed (e.g., from :bind input updates).
    // After syncVMStateToReact(), context.state and React componentState have
    // the same object references, so !== correctly detects external changes.
    for (const key of Object.keys(newState)) {
      if ((newState as Record<string, unknown>)[key] !== (this.context.state as Record<string, unknown>)[key]) {
        if (!this.dirtyStateKeys) this.dirtyStateKeys = new Set();
        this.dirtyStateKeys.add(key);
      }
    }
    Object.assign(this.context.state, newState);
  }

  /**
   * Discover and bridge VM event listeners to real browser event listeners.
   * Called after every async VM function call so listeners registered in _init()
   * or any other function are automatically bridged.
   *
   * The mapping is fully dynamic — the runtime does not hardcode any key bindings.
   * The .logic code registers handlers (e.g. window.addEventListener("keydown", fn)),
   * and this method bridges those to real browser events.
   */
  private bridgeEventListeners(): void {
    if (!this.vmEngine || typeof window === 'undefined') return;

    // High-frequency events that should be throttled to ~60fps before
    // crossing the WASM bridge. Prevents GC pressure and frame drops from
    // serializing event objects 100+ times/sec.
    const THROTTLED_EVENTS = new Set([
      'mousemove', 'pointermove', 'scroll', 'resize', 'touchmove', 'wheel',
    ]);
    const THROTTLE_MS = 16; // ~60fps

    const types = this.vmEngine.getEventListenerTypes();
    for (const eventType of types) {
      if (this.bridgedEventTypes.has(eventType)) continue;
      this.bridgedEventTypes.add(eventType);

      const isThrottled = THROTTLED_EVENTS.has(eventType);

      const handler = (event: Event) => {
        if (!this.vmEngine) return;

        // Extract safe, serializable properties from the browser event
        const eventObj = extractEventProps(event);

        // Sync React state → VM before dispatch
        this.syncReactStateToVM();
        // Skip window sync for throttled events — mouse/scroll handlers
        // rarely need window properties, and this saves ~2 WASM crossings/frame.
        if (!isThrottled) {
          this.syncWindowToVM();
        }

        // Dispatch to VM handlers (runs synchronously in WASM)
        this.vmEngine.dispatchEvent(eventType, eventObj);

        // Sync VM state → React after dispatch
        this.syncVMStateToReact();
        if (!isThrottled) {
          this.syncWindowFromVM();
          // Discover new __ window properties set by the handler.
          // Deferred for throttled events since they rarely add new sync keys.
          this.discoverWindowSyncKeys();
        }
      };

      // Wrap high-frequency events with a throttle to limit WASM bridge crossings
      let listener: (event: Event) => void;
      if (THROTTLED_EVENTS.has(eventType)) {
        let lastCall = 0;
        let pending: ReturnType<typeof requestAnimationFrame> | null = null;
        listener = (event: Event) => {
          const now = performance.now();
          if (now - lastCall >= THROTTLE_MS) {
            lastCall = now;
            handler(event);
          } else if (!pending) {
            pending = requestAnimationFrame(() => {
              pending = null;
              lastCall = performance.now();
              handler(event);
            });
          }
        };
      } else {
        listener = handler;
      }

      window.addEventListener(eventType, listener);
      if (!this.nativeListeners.has(eventType)) {
        this.nativeListeners.set(eventType, []);
      }
      this.nativeListeners.get(eventType)!.push(listener);
    }
  }

  /**
   * Discover __ prefixed properties on the VM's window object and register
   * them as sync keys. This makes window property sync fully dynamic — the
   * .logic code sets any window.__xxx property and it gets synced automatically.
   */
  private discoverWindowSyncKeys(): void {
    if (this.windowGlobalIndex < 0 || !this.vmEngine) return;

    const vmWindow = this.vmEngine.getGlobal(this.windowGlobalIndex);
    if (!vmWindow || typeof vmWindow !== 'object') return;

    for (const key of Object.keys(vmWindow as Record<string, unknown>)) {
      if (key.startsWith('__') && !this.syncKeys.has(key)) {
        this.syncKeys.add(key);
        this.windowSyncActive = true;
      }
    }
  }

  /**
   * Clean up resources (event listeners, WASM engine, etc.)
   */
  cleanup(): void {
    // Set before anything else: an in-flight `loadScript` checks this after
    // each of its awaits, so a cleanup that lands mid-load stops the script
    // from being executed into an engine nobody will ever dispose.
    this.disposed = true;

    // Clean up native event listeners
    if (typeof window !== 'undefined') {
      for (const [eventName, listeners] of this.nativeListeners.entries()) {
        for (const listener of listeners) {
          window.removeEventListener(eventName, listener);
        }
      }
    }
    this.nativeListeners.clear();
    this.bridgedEventTypes.clear();
    this.syncCallCache.clear();
    this.syncKeys.clear();
    this.windowSyncActive = false;

    // Release AI resources
    if (this.onnxManager) {
      this.onnxManager.releaseAll().catch(() => {});
      this.onnxManager = null;
    }
    if (this.transformersManager) {
      this.transformersManager.releaseAll().catch(() => {});
      this.transformersManager = null;
    }
    if (this.gpuComputeManager) {
      this.gpuComputeManager.releaseAll().catch(() => {});
      this.gpuComputeManager = null;
    }

    // Dispose WASM engine
    if (this.vmEngine) {
      this.vmEngine.dispose();
      this.vmEngine = null;
    }
  }

  // ========================================================================
  // Import resolution
  // ========================================================================

  /**
   * Resolve import statements in .logic code by inlining imported files.
   * Handles `import "./path.logic"` statements by fetching the imported code
   * via the importResolver and recursively resolving nested imports.
   */
  private async resolveImports(
    code: string,
    expanding: Set<string>,
    currentPath?: string
  ): Promise<string> {
    if (!this.importResolver) return code;

    // Match import statements: import "./path.logic" or import './path.logic'
    const importRegex = /^\s*import\s+["']([^"']+)["']\s*;?\s*$/gm;
    const parts: string[] = [];
    let lastIndex = 0;
    let match;

    while ((match = importRegex.exec(code)) !== null) {
      // Add code before this import
      parts.push(code.slice(lastIndex, match.index));

      const importPath = match[1];
      const resolvedPath = this.resolveImportPath(importPath, currentPath);

      // A file already in this compilation is included once, not twice: the
      // result is a single translation unit, and re-inlining a file would
      // redeclare every class and variable in it — a SyntaxError to the VM.
      // Two files importing a common third is normal, so this is a skip.
      if (this.includedLogicPaths.has(resolvedPath)) {
        parts.push(`/* already included: ${importPath} */`);
      } else if (expanding.has(resolvedPath)) {
        // Still being expanded further up the chain, so it genuinely cycles.
        throw new Error(
          `Circular import detected: "${resolvedPath}" is already in the import chain: ${[...expanding].join(' → ')} → ${resolvedPath}`
        );
      } else {
        expanding.add(resolvedPath);
        this.includedLogicPaths.add(resolvedPath);
        try {
          const source = await this.importResolver(resolvedPath);
          if (source != null) {
            // Recursively resolve imports in the imported code
            const resolved = await this.resolveImports(source, expanding, resolvedPath);
            parts.push(resolved);
          } else {
            parts.push(`/* import not found: ${importPath} */`);
          }
        } catch (e) {
          console.error(`[SoftN] Error resolving import "${importPath}":`, e);
          parts.push(`/* import error: ${importPath} */`);
        } finally {
          // Off the ancestor chain — it stays in includedLogicPaths, so a
          // later sibling import of the same file skips rather than throws.
          expanding.delete(resolvedPath);
        }
      }

      lastIndex = match.index + match[0].length;
    }

    // Add remaining code after last import
    parts.push(code.slice(lastIndex));
    return parts.join('\n');
  }

  /**
   * Resolve a relative import path against the current file's directory.
   */
  private resolveImportPath(importPath: string, currentPath?: string): string {
    // Absolute paths, URLs — return as-is
    if (
      importPath.startsWith('http://') ||
      importPath.startsWith('https://') ||
      importPath.startsWith('/')
    ) {
      return importPath;
    }
    // Not relative — return as-is
    if (!importPath.startsWith('./') && !importPath.startsWith('../')) {
      return importPath;
    }
    // No base path — return as-is
    if (!currentPath) {
      return importPath;
    }
    // Resolve relative to current file's directory
    const baseParts = currentPath.split('/');
    baseParts.pop(); // remove filename to get directory
    const importParts = importPath.split('/');
    for (const part of importParts) {
      if (part === '.') continue;
      if (part === '..') {
        baseParts.pop();
      } else {
        baseParts.push(part);
      }
    }
    return baseParts.join('/');
  }

  // ========================================================================
  // Window/Navigator sync (simplified for WASM)
  // ========================================================================

  /**
   * Register a __ window property key for syncing from real window → VM.
   */
  registerSyncKey(key: string): void {
    if (key.startsWith('__')) {
      this.syncKeys.add(key);
    }
  }

  /**
   * Sync properties from the real browser `window` into the VM's `window` global.
   * Only syncs __ prefixed keys registered via registerSyncKey().
   * Short-circuits when no sync keys have values on the real window.
   */
  private syncWindowToVM(): void {
    if (this.windowGlobalIndex < 0 || !this.vmEngine) return;
    if (typeof window === 'undefined' || this.syncKeys.size === 0) return;

    // Quick check: are any syncKeys actually set on the real window?
    const realWin = window as unknown as Record<string, unknown>;
    if (!this.windowSyncActive) {
      // Periodically recheck (cheap: just test 2 keys)
      for (const key of this.syncKeys) {
        if (realWin[key] !== undefined) {
          this.windowSyncActive = true;
          break;
        }
      }
      if (!this.windowSyncActive) return;
    }

    const vmWindow = this.vmEngine.getGlobal(this.windowGlobalIndex);
    if (!vmWindow || typeof vmWindow !== 'object') return;

    const updated: Record<string, unknown> = { ...(vmWindow as Record<string, unknown>) };
    let changed = false;

    for (const key of this.syncKeys) {
      const value = realWin[key];
      if (value !== undefined && typeof value !== 'function') {
        updated[key] = value;
        changed = true;
      }
    }

    if (changed) {
      this.vmEngine.setGlobal(this.windowGlobalIndex, updated);
    }
  }

  /**
   * Sync properties from the VM's `window` global back to the real browser `window`.
   * Only syncs keys registered via registerSyncKey().
   */
  private syncWindowFromVM(): void {
    if (!this.windowSyncActive) return;
    if (this.windowGlobalIndex < 0 || !this.vmEngine) return;
    if (typeof window === 'undefined' || this.syncKeys.size === 0) return;

    const vmWindow = this.vmEngine.getGlobal(this.windowGlobalIndex);
    if (!vmWindow || typeof vmWindow !== 'object') return;

    const realWin = window as unknown as Record<string, unknown>;
    const vmWinObj = vmWindow as Record<string, unknown>;

    for (const key of this.syncKeys) {
      const value = vmWinObj[key];
      if (value !== undefined) {
        realWin[key] = value;
      }
    }
  }

  // ── Host call processing (softn.* bridge) ───────────────────────────

  /**
   * Process pending host calls WITHOUT holding the VM lock during async operations.
   * The lock is released before this method is called, so other VM calls (like
   * movement ticks) can execute while slow host operations (AI generation) run.
   * The lock is re-acquired only briefly to resolve each callback in the VM.
   */
  /** Max total host calls resolved per processPendingHostCalls invocation.
   *  Prevents runaway callback chains from consuming unbounded memory/CPU. */
  private static readonly MAX_HOST_CALL_ROUNDS = 256;

  private async processPendingHostCallsUnlocked(initialPending: PendingHostCall[]): Promise<void> {
    if (!this.vmEngine) return;

    let pending = initialPending;
    let totalResolved = 0;
    while (pending.length > 0) {
      for (const call of pending) {
        if (++totalResolved > SoftNScriptRuntime.MAX_HOST_CALL_ROUNDS) {
          console.error(
            `[SoftN] Host call limit exceeded (${SoftNScriptRuntime.MAX_HOST_CALL_ROUNDS}) — ` +
            'aborting to prevent runaway callback chains'
          );
          return;
        }
        // Execute the async host call OUTSIDE the lock
        let result: unknown;
        try {
          result = await this.executeHostCall(call);
        } catch (err) {
          result = { error: String(err) };
        }

        // The engine may have been disposed while the host call was in flight.
        //
        // The guard at the top of this method ran before that await, and the
        // non-null assertions below are only true of the engine that was alive
        // then. A `softn.net.fetch` from a click handler, followed by an
        // unmount before it resolves, hit `drainPendingHostCalls()` on null in
        // a try/finally with no catch — an uncaught TypeError propagating out
        // through `createVMFunction`, which callers invoke without `.catch`.
        if (!this.vmEngine) return;

        // Re-acquire the lock to resolve the callback in the VM
        await this.vmCallLock;
        if (!this.vmEngine) return;
        let release: (() => void) | undefined;
        this.vmCallLock = new Promise<void>((r) => { release = r; });

        try {
          this.syncCallCache.clear();
          this.syncReactStateToVM();
          this.vmEngine!.resolveHostCallback(call.id, result);
          this.syncVMStateToReact();
        } catch (err) {
          console.error(`[SoftN] Error resolving host callback:`, err);
        } finally {
          release!();
        }
      }

      // Check for newly queued host calls (callback may have queued more)
      // Need the lock briefly to drain
      await this.vmCallLock;
      if (!this.vmEngine) return;
      let release2: (() => void) | undefined;
      this.vmCallLock = new Promise<void>((r) => { release2 = r; });
      try {
        pending = this.vmEngine.drainPendingHostCalls();
      } finally {
        release2!();
      }
    }
  }

  private async executeHostCall(call: PendingHostCall): Promise<unknown> {
    switch (call.kind) {
      case 'net.fetch': return this.handleNetFetch(call);
      case 'qr.encode': return this.handleQrEncode(call);
      case 'qr.decode': return this.handleQrDecode(call);
      case 'camera.capturePhoto': return this.handleCameraCapture(call);
      case 'camera.recordVideo': return this.handleCameraRecord(call);
      case 'camera.startLive': return this.handleCameraStartLive(call);
      case 'camera.stopLive': return this.handleCameraStopLive();
      case 'files.pickFile': return this.handleFilesPickFile(call);
      case 'files.readText': return this.handleFilesReadText(call);
      case 'files.readBase64': return this.handleFilesReadBase64(call);
      case 'ai.getCapabilities': return this.handleAIGetCapabilities();
      case 'ai.onnx.loadModel': return this.handleAIOnnxLoadModel(call);
      case 'ai.onnx.run': return this.handleAIOnnxRun(call);
      case 'ai.onnx.release': return this.handleAIOnnxRelease(call);
      case 'ai.pipeline': return this.handleAIPipeline(call);
      case 'ai.generate': return this.handleAIGenerate(call);
      case 'ai.embed': return this.handleAIEmbed(call);
      case 'ai.classify': return this.handleAIClassify(call);
      case 'ai.run': return this.handleAIRun(call);
      case 'ai.releaseAll': return this.handleAIReleaseAll();
      case 'ai.model.load': return this.handleAIModelLoad(call);
      case 'ai.model.generate': return this.handleAIModelGenerate(call);
      case 'ai.model.release': return this.handleAIModelRelease(call);
      case 'ai.gpu.requestDevice': return this.handleGpuRequestDevice(call);
      case 'ai.gpu.createBuffer': return this.handleGpuCreateBuffer(call);
      case 'ai.gpu.writeBuffer': return this.handleGpuWriteBuffer(call);
      case 'ai.gpu.createShader': return this.handleGpuCreateShader(call);
      case 'ai.gpu.createPipeline': return this.handleGpuCreatePipeline(call);
      case 'ai.gpu.dispatch': return this.handleGpuDispatch(call);
      case 'ai.gpu.readBuffer': return this.handleGpuReadBuffer(call);
      case 'ai.gpu.release': return this.handleGpuRelease(call);
      case 'ai.gpu.releaseAll': return this.handleGpuReleaseAll();
      default: throw new Error(`Unknown host call: ${call.kind}`);
    }
  }

  // ── Permission checks ──

  /** Whether we've already warned about missing permissionConfig (log once) */
  private static _warnedNoPermConfig = false;

  private checkPermission(capability: string): void {
    if (!this.permissionConfig) {
      // No permission config loaded — allow for backward compatibility but warn once.
      // Authors should provide permission.json in production bundles; without it
      // all host APIs are available (equivalent to a dev-mode grant).
      if (!SoftNScriptRuntime._warnedNoPermConfig) {
        SoftNScriptRuntime._warnedNoPermConfig = true;
        console.warn(
          '[SoftN] No permission.json loaded — all host APIs are allowed. ' +
          'Add a permission.json to your bundle for production use.'
        );
      }
      return;
    }
    // Permission config IS set — deny by default for any capability not explicitly enabled.
    const perms = this.permissionConfig.permissions;
    switch (capability) {
      case 'net':
        if (!perms.net?.enabled) throw new Error('Network access not permitted. Add net.enabled to permission.json');
        break;
      case 'camera':
        if (!perms.camera?.enabled) throw new Error('Camera access not permitted. Add camera.enabled to permission.json');
        break;
      case 'files':
        if (!perms.files?.enabled) throw new Error('File access not permitted. Add files.enabled to permission.json');
        break;
      case 'qr':
        if (!perms.qr?.enabled) throw new Error('QR access not permitted. Add qr.enabled to permission.json');
        break;
      case 'ai':
        if (!perms.ai?.enabled) throw new Error('AI access not permitted. Add ai.enabled to permission.json');
        break;
      case 'gpu':
        if (!perms.gpu?.enabled) throw new Error('GPU compute access not permitted. Add gpu.enabled to permission.json');
        break;
      case 'sync':
        if (!perms.sync?.enabled) throw new Error('Sync not permitted. Add sync.enabled to permission.json');
        break;
      default:
        throw new Error(`Unknown capability: ${capability}. Add it to permission.json`);
    }
  }

  private checkNetHost(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }

    // Always enforce scheme allowlist — even without permission config, reject
    // non-HTTP(S) schemes (e.g. file://, javascript:, data:) to prevent abuse.
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`Scheme not allowed: ${parsed.protocol}`);
    }

    const netPerms = this.permissionConfig?.permissions.net;
    // Default: HTTPS only unless allow_http is explicitly true
    if (!netPerms?.allow_http && parsed.protocol === 'http:') {
      throw new Error(`HTTP not allowed (only HTTPS). Set net.allow_http in permission.json to allow: ${url}`);
    }
    if (netPerms?.allowed_hosts && netPerms.allowed_hosts.length > 0) {
      if (!netPerms.allowed_hosts.includes(parsed.hostname)) {
        throw new Error(`Host not allowed: ${parsed.hostname}`);
      }
    }
  }

  // ── Host call handlers ──

  private async handleNetFetch(call: PendingHostCall): Promise<unknown> {
    this.checkPermission('net');
    const [url, optionsJson] = call.args;
    this.checkNetHost(url);
    const options = optionsJson ? JSON.parse(optionsJson) : {};

    // Disable redirects to prevent allowlist bypass: a redirect from an
    // allowed host to an internal/disallowed host would skip checkNetHost.
    const resp = await fetch(url, {
      method: options.method || 'GET',
      headers: options.headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(options.timeout || 15000),
      redirect: 'error',
    });

    const body = await resp.text();
    return {
      ok: resp.ok,
      status: resp.status,
      statusText: resp.statusText,
      body,
      headers: Object.fromEntries(resp.headers),
    };
  }

  private async handleQrEncode(call: PendingHostCall): Promise<unknown> {
    this.checkPermission('qr');
    const [text] = call.args;
    // Return the text — actual QR rendering is done by the QRCode component
    return { text, encoded: true };
  }

  private async handleQrDecode(call: PendingHostCall): Promise<unknown> {
    this.checkPermission('qr');
    const [imageDataUrl] = call.args;
    // Use BarcodeDetector API if available
    if ('BarcodeDetector' in globalThis) {
      try {
        const detector = new (globalThis as unknown as { BarcodeDetector: new (opts: { formats: string[] }) => { detect: (img: HTMLImageElement) => Promise<Array<{ rawValue: string }>> } }).BarcodeDetector({ formats: ['qr_code'] });
        const img = new Image();
        img.src = imageDataUrl;
        await new Promise((resolve) => { img.onload = resolve; });
        const results = await detector.detect(img);
        if (results.length > 0) {
          return { data: results[0].rawValue };
        }
      } catch { /* fallthrough */ }
    }
    return { data: null, error: 'QR detection not available' };
  }

  private async handleCameraCapture(_call: PendingHostCall): Promise<unknown> {
    this.checkPermission('camera');
    // Camera capture is handled by the Camera component — this is a no-op
    // that tells the host to trigger the Camera component's capture
    return { pending: true, message: 'Use Camera component for capture' };
  }

  private async handleCameraRecord(_call: PendingHostCall): Promise<unknown> {
    this.checkPermission('camera');
    return { pending: true, message: 'Use Camera component for recording' };
  }

  private async handleCameraStartLive(_call: PendingHostCall): Promise<unknown> {
    this.checkPermission('camera');
    return { pending: true, message: 'Use Camera component for live mode' };
  }

  private async handleCameraStopLive(): Promise<unknown> {
    return { stopped: true };
  }

  private async handleFilesPickFile(call: PendingHostCall): Promise<unknown> {
    this.checkPermission('files');
    const options = call.args[0] ? JSON.parse(call.args[0]) : {};
    return new Promise<unknown>((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      if (options.accept) input.accept = options.accept;
      if (options.multiple) input.multiple = true;
      input.onchange = () => {
        const files = Array.from(input.files || []);
        const result = files.map(f => ({
          name: f.name,
          size: f.size,
          type: f.type,
          ref: registerFileRef(f),
        }));
        resolve(result);
      };
      input.oncancel = () => resolve([]);
      input.click();
    });
  }

  private async handleFilesReadText(call: PendingHostCall): Promise<unknown> {
    this.checkPermission('files');
    const [fileRef] = call.args;
    const file = getFileByRef(fileRef);
    if (!file) throw new Error(`File not found: ${fileRef}`);
    return await file.text();
  }

  private async handleFilesReadBase64(call: PendingHostCall): Promise<unknown> {
    this.checkPermission('files');
    const [fileRef] = call.args;
    const file = getFileByRef(fileRef);
    if (!file) throw new Error(`File not found: ${fileRef}`);
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  }

  // ── AI host call handlers ──

  private async getOnnxManager(): Promise<import('./ai-onnx-manager').OnnxManager> {
    if (!this.onnxManager) {
      const { OnnxManager } = await import('./ai-onnx-manager');
      this.onnxManager = new OnnxManager();
      if (this.bundleFileProvider) {
        this.onnxManager.setBundleFileProvider(this.bundleFileProvider);
      }
      if (this.permissionConfig?.permissions.ai) {
        this.onnxManager.setPermissionConfig(this.permissionConfig.permissions.ai);
      }
    }
    return this.onnxManager;
  }

  private async getTransformersManager(): Promise<import('./ai-transformers-manager').TransformersManager> {
    if (!this.transformersManager) {
      const { TransformersManager } = await import('./ai-transformers-manager');
      this.transformersManager = new TransformersManager();
      if (this.permissionConfig?.permissions.ai) {
        this.transformersManager.setPermissionConfig(this.permissionConfig.permissions.ai);
      }
    }
    return this.transformersManager;
  }

  private async handleAIGetCapabilities(): Promise<unknown> {
    const { detectCapabilities } = await import('./ai-manager');
    return detectCapabilities();
  }

  private async handleAIOnnxLoadModel(call: PendingHostCall): Promise<unknown> {
    this.checkPermission('ai');
    const [sourceJson, optionsJson] = call.args;
    const source: ModelSource = JSON.parse(sourceJson);
    const options = optionsJson ? JSON.parse(optionsJson) : {};
    const mgr = await this.getOnnxManager();
    return mgr.loadModel(source, options);
  }

  private async handleAIOnnxRun(call: PendingHostCall): Promise<unknown> {
    this.checkPermission('ai');
    const [sessionId, feedsJson, optionsJson] = call.args;
    const feeds: OnnxFeeds = JSON.parse(feedsJson);
    const options: OnnxRunOptions = optionsJson ? JSON.parse(optionsJson) : {};
    const mgr = await this.getOnnxManager();
    return mgr.run(sessionId, feeds, options);
  }

  private async handleAIOnnxRelease(call: PendingHostCall): Promise<unknown> {
    this.checkPermission('ai');
    const [sessionId] = call.args;
    const mgr = await this.getOnnxManager();
    await mgr.release(sessionId);
    return { released: true };
  }

  private async handleAIPipeline(call: PendingHostCall): Promise<unknown> {
    this.checkPermission('ai');
    const [task, model, optionsJson] = call.args;
    const options: PipelineOptions = optionsJson ? JSON.parse(optionsJson) : {};
    const mgr = await this.getTransformersManager();
    return mgr.createPipeline(task as PipelineTask, model || undefined, options);
  }

  private async handleAIGenerate(call: PendingHostCall): Promise<unknown> {
    this.checkPermission('ai');
    const [pipelineId, prompt, optionsJson] = call.args;
    const options: GenerateOptions = optionsJson ? JSON.parse(optionsJson) : {};
    const mgr = await this.getTransformersManager();
    return mgr.generate(pipelineId, prompt, options);
  }

  private async handleAIEmbed(call: PendingHostCall): Promise<unknown> {
    this.checkPermission('ai');
    const [pipelineId, textsJson] = call.args;
    let texts: string | string[];
    try { texts = JSON.parse(textsJson); } catch { texts = textsJson; }
    const mgr = await this.getTransformersManager();
    return mgr.embed(pipelineId, texts);
  }

  private async handleAIClassify(call: PendingHostCall): Promise<unknown> {
    this.checkPermission('ai');
    const [pipelineId, text] = call.args;
    const mgr = await this.getTransformersManager();
    return mgr.classify(pipelineId, text);
  }

  private async handleAIRun(call: PendingHostCall): Promise<unknown> {
    this.checkPermission('ai');
    const [pipelineId, inputJson, optionsJson] = call.args;
    let input: unknown;
    try { input = JSON.parse(inputJson); } catch { input = inputJson; }
    const options = optionsJson ? JSON.parse(optionsJson) : undefined;
    const mgr = await this.getTransformersManager();
    return mgr.run(pipelineId, input, options);
  }

  private async handleAIReleaseAll(): Promise<unknown> {
    const promises: Promise<void | { released: boolean }>[] = [];
    if (this.onnxManager) promises.push(this.onnxManager.releaseAll());
    if (this.transformersManager) promises.push(this.transformersManager.releaseAll());
    if (this.gpuComputeManager) promises.push(this.gpuComputeManager.releaseAll());
    await Promise.all(promises);
    return { released: true };
  }

  private async handleAIModelLoad(call: PendingHostCall): Promise<unknown> {
    this.checkPermission('ai');
    const [modelId, optionsJson] = call.args;
    const options: DirectModelOptions & { modelClass?: string } = optionsJson ? JSON.parse(optionsJson) : {};
    const mgr = await this.getTransformersManager();
    return mgr.loadModel(modelId, options);
  }

  private async handleAIModelGenerate(call: PendingHostCall): Promise<unknown> {
    this.checkPermission('ai');
    const [modelHandle, messagesJson, optionsJson] = call.args;
    const messages: ChatMessage[] = JSON.parse(messagesJson);
    const options: GenerateOptions = optionsJson ? JSON.parse(optionsJson) : {};
    const mgr = await this.getTransformersManager();
    return mgr.generateFromModel(modelHandle, messages, options);
  }

  private async handleAIModelRelease(call: PendingHostCall): Promise<unknown> {
    this.checkPermission('ai');
    const [modelHandle] = call.args;
    const mgr = await this.getTransformersManager();
    await mgr.releaseModel(modelHandle);
    return { released: true };
  }

  // ── GPU compute host call handlers ──

  private async getGpuComputeManager(): Promise<import('./ai-gpu-compute-manager').GpuComputeManager> {
    if (!this.gpuComputeManager) {
      const { GpuComputeManager } = await import('./ai-gpu-compute-manager');
      this.gpuComputeManager = new GpuComputeManager();
      if (this.bundleFileProvider) {
        this.gpuComputeManager.setBundleFileProvider(this.bundleFileProvider);
      }
      if (this.permissionConfig?.permissions.gpu) {
        this.gpuComputeManager.setPermissionConfig(this.permissionConfig.permissions.gpu);
      }
    }
    return this.gpuComputeManager;
  }

  private async handleGpuRequestDevice(call: PendingHostCall): Promise<unknown> {
    this.checkPermission('gpu');
    const options = call.args[0] ? JSON.parse(call.args[0]) : {};
    const mgr = await this.getGpuComputeManager();
    return mgr.requestDevice(options);
  }

  private async handleGpuCreateBuffer(call: PendingHostCall): Promise<unknown> {
    this.checkPermission('gpu');
    const [sourceJson, usage] = call.args;
    const source = JSON.parse(sourceJson);
    const mgr = await this.getGpuComputeManager();
    return mgr.createBuffer(source, usage);
  }

  private async handleGpuWriteBuffer(call: PendingHostCall): Promise<unknown> {
    this.checkPermission('gpu');
    const [bufferId, dataJson, dtype] = call.args;
    const data = JSON.parse(dataJson);
    const mgr = await this.getGpuComputeManager();
    return mgr.writeBuffer(bufferId, data, (dtype || undefined) as any);
  }

  private async handleGpuCreateShader(call: PendingHostCall): Promise<unknown> {
    this.checkPermission('gpu');
    const [sourceJson] = call.args;
    const source = JSON.parse(sourceJson);
    const mgr = await this.getGpuComputeManager();
    return mgr.createShader(source);
  }

  private async handleGpuCreatePipeline(call: PendingHostCall): Promise<unknown> {
    this.checkPermission('gpu');
    const [optionsJson] = call.args;
    const options = JSON.parse(optionsJson);
    const mgr = await this.getGpuComputeManager();
    return mgr.createPipeline(options);
  }

  private async handleGpuDispatch(call: PendingHostCall): Promise<unknown> {
    this.checkPermission('gpu');
    const [pipelineId, bindingsJson, workgroupsJson] = call.args;
    const bindings = JSON.parse(bindingsJson);
    const workgroups = JSON.parse(workgroupsJson);
    const mgr = await this.getGpuComputeManager();
    return mgr.dispatch(pipelineId, bindings, workgroups);
  }

  private async handleGpuReadBuffer(call: PendingHostCall): Promise<unknown> {
    this.checkPermission('gpu');
    const [bufferId] = call.args;
    const mgr = await this.getGpuComputeManager();
    return mgr.readBuffer(bufferId);
  }

  private async handleGpuRelease(call: PendingHostCall): Promise<unknown> {
    this.checkPermission('gpu');
    const [resourceId] = call.args;
    const mgr = await this.getGpuComputeManager();
    return mgr.release(resourceId);
  }

  private async handleGpuReleaseAll(): Promise<unknown> {
    const mgr = await this.getGpuComputeManager();
    return mgr.releaseAll();
  }
}

/**
 * Create a SoftN script runtime
 * @param context - Script execution context
 * @param permissions - Optional permissions manifest from bundle for capability enforcement
 * @param appId - Optional app identifier for localStorage namespace isolation
 */
export function createScriptRuntime(
  context: ScriptContext,
  permissions?: AppPermissions,
  appId?: string,
  importResolver?: unknown,
  logicBasePath?: string,
  options?: ScriptRuntimeOptions,
  bundleFileProvider?: BundleFileProvider,
  externalFunctions?: Record<string, (...args: unknown[]) => unknown>
): ScriptRuntimeHandle {
  return new SoftNScriptRuntime(
    context,
    permissions,
    appId,
    importResolver,
    logicBasePath,
    options,
    bundleFileProvider,
    externalFunctions
  );
}

/**
 * Create an XDB module that uses the real XDB service with localStorage persistence
 * This replaces the old mock implementation with actual persistence.
 */
export function createPersistentXDBModule(appId?: string): XDBModule {
  // Import dynamically to avoid circular dependency
  // The XDB service is created lazily when needed
  let xdbService: import('./xdb').XDBService | null = null;

  const getXDB = async () => {
    if (!xdbService) {
      const { getXDB: getXDBInstance } = await import('./xdb');
      xdbService = getXDBInstance(appId);
    }
    return xdbService;
  };

  return {
    create: async (collection: string, data: Record<string, unknown>) => {
      const xdb = await getXDB();
      return xdb.isP2PAvailable()
        ? xdb.createAsync(collection, data)
        : xdb.create(collection, data);
    },

    update: async (id: string, data: Record<string, unknown>) => {
      const xdb = await getXDB();
      const record = xdb.isP2PAvailable()
        ? await xdb.updateAsync(id, data)
        : xdb.update(id, data);
      if (!record) {
        throw new Error(`Record not found: ${id}`);
      }
      return record;
    },

    delete: async (id: string) => {
      const xdb = await getXDB();
      if (xdb.isP2PAvailable()) {
        await xdb.deleteAsync(id);
      } else {
        xdb.delete(id);
      }
    },

    query: async (collection: string, filter?: Record<string, unknown>) => {
      const xdb = await getXDB();
      if (xdb.isP2PAvailable()) {
        return xdb.queryAsync(collection, filter ? { filter } : undefined);
      }
      return xdb.query(collection, filter ? { filter } : undefined);
    },

    get: async (collection: string, id: string) => {
      const xdb = await getXDB();
      if (xdb.isP2PAvailable()) {
        return xdb.getAsync(collection, id);
      }
      return xdb.get(collection, id);
    },

    sync: async () => {
      const xdb = await getXDB();
      return xdb.sync();
    },
  };
}

/**
 * DB namespace interface for direct use in <logic> blocks
 * Provides a clean, synchronous API for database operations
 */
export interface DBNamespace {
  query: (collection: string, filter?: Record<string, unknown>) => XDBRecord[];
  create: (collection: string, data: Record<string, unknown>) => XDBRecord;
  update: (id: string, data: Record<string, unknown>) => XDBRecord;
  delete: (id: string) => void;
  hardDelete: (collection: string, id: string) => void;
  get: (collection: string, id: string) => XDBRecord | null;
  /**
   * Prune a collection to keep at most `maxRecords` records.
   * Removes oldest records first (by created_at). Returns number of records removed.
   */
  prune: (collection: string, maxRecords: number) => number;
  /** Remove all records from a collection */
  clearCollection: (collection: string) => void;
  startSync: (room: string, options?: Record<string, unknown>) => void;
  stopSync: (room?: string) => void;
  getSyncStatus: (room?: string) => { connected: boolean; peers: number; room: string; peerId: string };
  getSavedSyncRoom: () => string | null;
  /** Wait for the XDB service to finish initializing */
  ready: () => Promise<void>;
}

/**
 * Create a synchronous db namespace for use in <logic> blocks
 * This uses the XDB service synchronously for immediate data access
 */
export function createDBNamespace(getPermissionConfig?: () => PermissionConfig | null, appId?: string, syncEncryptionKeyHex?: string): DBNamespace {
  // Import XDB directly - this module uses a singleton pattern
  // We use a wrapper that will lazily initialize
  let xdbService: import('./xdb').XDBService | null = null;
  let xdbPromise: Promise<import('./xdb').XDBService> | null = null;

  // Start loading XDB immediately but don't block
  const initXDB = async () => {
    if (!xdbPromise) {
      xdbPromise = import('./xdb').then((m) => {
        xdbService = m.getXDB(appId);
        return xdbService;
      });
    }
    return xdbPromise;
  };

  const getXDBSync = (): import('./xdb').XDBService => {
    if (!xdbService) {
      // If not yet loaded, trigger load and throw a meaningful error
      // In practice, by the time user actions happen, XDB should be loaded
      initXDB();
      throw new Error('XDB is still initializing. This should not happen in normal use.');
    }
    return xdbService;
  };

  return {
    query: (collection: string, filter?: Record<string, unknown>) => {
      const xdb = getXDBSync();
      return xdb.query(collection, filter ? { filter } : undefined);
    },

    create: (collection: string, data: Record<string, unknown>) => {
      const xdb = getXDBSync();
      return xdb.create(collection, data);
    },

    update: (id: string, data: Record<string, unknown>) => {
      const xdb = getXDBSync();
      const record = xdb.update(id, data);
      if (!record) {
        throw new Error(`Record not found: ${id}`);
      }
      return record;
    },

    delete: (id: string) => {
      const xdb = getXDBSync();
      xdb.delete(id);
    },

    hardDelete: (collection: string, id: string) => {
      const xdb = getXDBSync();
      xdb.hardDelete(collection, id);
    },

    get: (collection: string, id: string) => {
      const xdb = getXDBSync();
      return xdb.get(collection, id);
    },

    startSync: (room: string, options?: Record<string, unknown>) => {
      const permissionConfig = getPermissionConfig?.();
      if (permissionConfig?.permissions && !permissionConfig.permissions.sync?.enabled) {
        console.error('[XDB Sync] Sync not permitted. Add sync.enabled to permission.json');
        return;
      }
      const syncOpts: Record<string, unknown> = { room, ...(options || {}) };
      const sharedKey = appId ? `xdb-sync-shared:${appId}` : null;
      // Shared room: sharedRoom flag, legacy noEncrypt, or persisted from prior session
      let isShared = !!syncOpts.sharedRoom || !!syncOpts.noEncrypt;
      if (!isShared && sharedKey) {
        try { isShared = localStorage.getItem(sharedKey) === 'true'; } catch { /* noop */ }
      }
      if (isShared) {
        // Derive encryption key from room name — all peers use the same key.
        // y-webrtc runs PBKDF2(password, roomName) to produce AES-256-GCM.
        syncOpts.password = 'softn-shared:' + room;
        delete syncOpts.encryptionKey;
      } else if (syncEncryptionKeyHex && !syncOpts.encryptionKey) {
        syncOpts.encryptionKey = syncEncryptionKeyHex;
      }
      // Persist shared flag so auto-resume also uses room-key encryption
      if (isShared && sharedKey) {
        try { localStorage.setItem(sharedKey, 'true'); } catch { /* noop */ }
      }
      delete syncOpts.noEncrypt;
      delete syncOpts.sharedRoom;
      if (appId && !syncOpts.appId) {
        syncOpts.appId = appId;
      }
      import('./xdb-sync').then((mod) => {
        _syncModuleCache = mod;
        mod.startSync(syncOpts as unknown as import('./xdb-sync').XDBSyncOptions);
      }).catch((err) => {
        console.error('[XDB Sync] Failed to start sync:', err);
      });
    },

    stopSync: (room?: string) => {
      import('./xdb-sync').then(({ stopSync }) => {
        stopSync(room, appId);
      }).catch((err) => {
        console.error('[XDB Sync] Failed to stop sync:', err);
      });
    },

    getSyncStatus: (room?: string) => {
      if (_syncModuleCache) {
        const adapter = _syncModuleCache.getSyncAdapter(room);
        return adapter ? adapter.getStatus() : { connected: false, peers: 0, room: '', peerId: '' };
      }
      return { connected: false, peers: 0, room: '', peerId: '' };
    },

    getSavedSyncRoom: () => {
      const key = appId ? `xdb-sync-active-room:${appId}` : 'xdb-sync-active-room';
      try { return localStorage.getItem(key); } catch { return null; }
    },

    prune: (collection: string, maxRecords: number) => {
      const xdb = getXDBSync();
      const records = xdb.query(collection);
      if (records.length <= maxRecords) return 0;
      // Sort by created_at ascending (oldest first)
      const sorted = [...records].sort((a, b) =>
        (a.created_at || '').localeCompare(b.created_at || '')
      );
      const toRemove = sorted.slice(0, records.length - maxRecords);
      for (const rec of toRemove) {
        xdb.hardDelete(collection, rec.id);
      }
      return toRemove.length;
    },

    clearCollection: (collection: string) => {
      const xdb = getXDBSync();
      const records = xdb.query(collection);
      for (const rec of records) {
        xdb.hardDelete(collection, rec.id);
      }
    },

    ready: () => initXDB().then(() => {}),
  };
}

// Shared sync module cache — used by both createDBNamespace (script-runtime) and
// createXDBHelpers (SoftNRenderer) so getSyncStatus works regardless of which
// code path started the sync.
let _syncModuleCache: typeof import('./xdb-sync') | null = null;

export function getSyncModuleCache() {
  return _syncModuleCache;
}

export function setSyncModuleCache(mod: typeof import('./xdb-sync')) {
  _syncModuleCache = mod;
}

/**
 * Create a mock XDB module (for testing without persistence)
 * @deprecated Use createPersistentXDBModule() instead for real applications
 */
export function createMockXDBModule(): XDBModule {
  // For backwards compatibility, use the in-memory mock
  const collections = new Map<string, XDBRecord[]>();

  return {
    create: async (collection: string, data: Record<string, unknown>) => {
      const record: XDBRecord = {
        id:
          typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : `mock-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        collection,
        data,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        deleted: false,
      };

      if (!collections.has(collection)) {
        collections.set(collection, []);
      }
      collections.get(collection)!.push(record);

      return record;
    },

    update: async (id: string, data: Record<string, unknown>) => {
      for (const records of collections.values()) {
        const record = records.find((r) => r.id === id);
        if (record) {
          record.data = { ...record.data, ...data };
          record.updated_at = new Date().toISOString();
          return record;
        }
      }
      throw new Error(`Record not found: ${id}`);
    },

    delete: async (id: string) => {
      for (const records of collections.values()) {
        const record = records.find((r) => r.id === id);
        if (record) {
          record.deleted = true;
          record.updated_at = new Date().toISOString();
          return;
        }
      }
    },

    query: async (collection: string, filter?: Record<string, unknown>) => {
      const records = collections.get(collection) || [];
      return records.filter((r) => {
        if (r.deleted) return false;
        if (!filter) return true;

        for (const [key, value] of Object.entries(filter)) {
          if (r.data[key] !== value) return false;
        }
        return true;
      });
    },

    get: async (collection: string, id: string) => {
      const records = collections.get(collection) || [];
      return records.find((r) => r.id === id && !r.deleted) || null;
    },

    sync: async () => {
      console.log('Mock XDB sync (no-op)');
    },
  };
}

/**
 * Create a mock nav module
 */
export function createMockNavModule(onNavigate?: (page: string) => void): NavModule {
  return {
    goto: (page: string) => {
      console.log('[SoftN Nav] goto:', page);
      onNavigate?.(page);
    },
    back: () => {
      console.log('[SoftN Nav] back');
      if (typeof window !== 'undefined') {
        window.history.back();
      }
    },
    params: {},
  };
}

/**
 * Create a console module that forwards to the browser console
 */
export function createConsoleModule(): ConsoleModule {
  return {
    log: (...args: unknown[]) => console.log('[SoftN]', ...args),
    error: (...args: unknown[]) => console.error('[SoftN]', ...args),
    warn: (...args: unknown[]) => console.warn('[SoftN]', ...args),
  };
}
