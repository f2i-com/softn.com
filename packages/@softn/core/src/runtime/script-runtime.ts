/**
 * SoftN Scripting Bridge
 *
 * Integrates the scripting VM with the SoftN runtime. The engine itself is
 * selected in `./vm-adapter` — by default zipp, a JavaScript engine written in
 * Rust and compiled to WASM. All .logic code executes inside the WASM VM, so
 * the sandbox holds: no `eval`, no `new Function`, and no host object the
 * engine preamble did not hand over.
 *
 * The engine is reached through `createLogicEngine()` rather than named here,
 * so a host can put a different one behind the same `LogicEngine` surface
 * without this file knowing. Nothing does today; the default is the same ZIPP
 * adapter this file used to construct directly.
 */

import {
  VM_BRIDGE_PREAMBLE,
  createLogicEngine,
  createPythonLogicEngine,
  logicEngineIsSandboxed,
  type LogicEngine,
  type PythonProject,
  type SymbolScope,
} from './vm-adapter';
import { SandboxHost } from './sandbox-host';
import { SOFTN_BRIDGE_PREAMBLE } from './softn-preamble';
import { LogicTimers, TIMER_TRAILER, timerPreamble } from './logic-timers';
import { prologueIsStrict, STRICT_DIRECTIVE } from './directive-prologue';
import { placeSyntaxError } from './logic-syntax';
import { moduleSyntaxAsScript } from './module-syntax';
import { inlineLogicImports } from './logic-imports';
import { sanitizeArgs } from './vm-args';
import type { DocumentShell, ShellOp } from '../document-shell/host';
import {
  SHELL_EVENT,
  SHELL_READY,
  SHELL_SYNC,
  SHELL_TAKE,
  holdsShellNode,
  isShellName,
  namesDeclaredBy,
  usesDocument,
} from '../document-shell/names';
import type { LocalSpeechHost } from './local-speech';
import { clearCapturedKeys, parseCapturedKeys, setAppElement, setCapturedKeys } from './key-capture';
import { deepEqual } from './vm-state';
import {
  COMPUTED_PREFIX,
  COMPUTED_SETTLE_FUNCTION,
  computedGlobalsSource,
  computedSource,
  extractComputedDeclarations,
  guardFirstValues,
  namesReadBy,
  planComputed,
  type ComputedDeclaration,
} from './computed-declarations';
import { readsOfDrawnFunctions } from './drawn-functions';

import type { SoftNDocument } from '../parser/ast';
import type { AppPermissions } from '../bundle/types';
import { buildSyncCacheKey } from './sync-cache-key';
import { createDBNamespace, type DBNamespace } from './script-modules';
import {
  BRIDGE_VARS,
  EXTERNAL_VALUES_VAR,
  UNSUPPORTED_EXTERNAL_VALUE,
  VALID_IDENTIFIER,
  collectExternalValues,
  externalValuesPreamble,
  readExternalValue,
  type ExternalPrimitive,
} from './external-values';
import { WindowBridge } from './window-bridge';
import { requireNetHost, requirePermission, type HostGate } from './host-calls/permissions';
import { AppNetwork } from './host-calls/network';
import { AppAudio } from './host-calls/audio';
import { AppMicrophone } from './host-calls/microphone';
import { QrReader } from './host-calls/qr';
import { pickFile, readBase64, readText, readZipText, saveFile } from './host-calls/files';
import { AppAI } from './host-calls/ai';
import type { BundleFileProvider } from './ai-manager';
import { debug } from './debug';
import type { RuntimeState } from '../types';
import type {
  CodeBlock,
  DocumentShellRequest,
  NetFetchHandler,
  PendingHostCall,
  PermissionConfig,
  PersistenceFailure,
  ScriptContext,
  ScriptLoadResult,
  ScriptRuntimeHandle,
  ScriptRuntimeMode,
  ScriptRuntimeOptions,
} from './script-runtime-types';

// The runtime's types are in script-runtime-types.ts, and exported from here as they always were.
export type {
  CodeBlock,
  ConsoleModule,
  DocumentShellRequest,
  NavModule,
  NetFetchHandler,
  NetFetchResult,
  PendingHostCall,
  PermissionConfig,
  PersistenceFailure,
  ScriptContext,
  ScriptLoadResult,
  ScriptRuntimeHandle,
  ScriptRuntimeMode,
  ScriptRuntimeOptions,
  XDBModule,
} from './script-runtime-types';
export type { BundleFileProvider } from './ai-manager';
// Beside `collectObservedStateNames`, which a host calls with it.
export { collectDrawnNames } from './drawn-functions';
export { buildExternalValuesPreamble } from './external-values';
export { downloadName } from './host-calls/files';

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

/**
 * Fast compatibility check used for worker-mode migration gating.
 * Scripts that rely on synchronous host bridges are currently main-thread only.
 *
 * Strips comments and string literals before matching, so a bridge name
 * inside a string or a comment is not mistaken for a use. (The retired
 * FormLogic VM once offered a lexer-based detector here; the ZIPP engine has
 * no such hook and this is the only implementation.)
 */
export function detectWorkerIncompatibilities(code: string): string[] {
  if (!code) return [];

  // Strip comments and string literals to prevent false positives.
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
 * Cross-check every "unchanged" digest against a full value comparison.
 *
 * Set `globalThis.__SOFTN_FP_AUDIT__ = true` before a bundle loads. Costs
 * exactly what the digests save, so it is for verifying them, not for use.
 */
function FINGERPRINT_AUDIT(): boolean {
  return (globalThis as unknown as Record<string, unknown>).__SOFTN_FP_AUDIT__ === true;
}

/**
 * How many times the `$:` values of a script are worked out, at most, to
 * find them still. Only a script where one reads another through a function
 * is passed over more than once: each pass carries a change one such step
 * further, so this is the longest chain of them that settles — and what a
 * pair that never will is allowed to cost.
 */
const COMPUTED_SETTLE_PASSES = 8;

/**
 * SoftN Script Runtime
 * Executes .logic code inside the WASM VM for true sandboxing.
 * No `new Function()` calls are used — all user code runs in the VM.
 */
export class SoftNScriptRuntime {
  private vmEngine: LogicEngine | null = null;
  private readonly onPersistenceFailure: ((failure: PersistenceFailure) => void) | null;
  private readonly onAlert: ((message: string) => void) | null;
  /** How many of the page's alerts have been shown (see `dialog.alert`). */
  private alertsShown = 0;
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
  /** Names the document could call while it is drawn; null means "any observed name". */
  private drawnNames: ReadonlySet<string> | null = null;
  private backendCall?: ScriptRuntimeOptions['backendCall'];
  /** The host's stand-in for the browser's fetch, if it supplied one. */
  private netFetchHandler?: NetFetchHandler;
  /** The Python modules to compile, when the app's logic is Python. */
  private pythonProject?: PythonProject;
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
   * The loaded script's top-level `$:` declarations in the order they are
   * worked out, or null when it has none — every app that shipped before
   * this existed, for which none of what follows runs.
   *
   * `untilStill` is for a script where one `$:` reads another through a
   * function: its values are worked out again until a pass changes nothing.
   */
  private computedSettle: { names: string[]; untilStill: boolean } | null = null;
  /** Whether the `$:` globals may be behind the state they are worked out from. */
  private computedStale = true;
  /** The values handed to the page for the draw in progress. */
  private computedBatch: Map<string, unknown> | null = null;
  /** The failure last said for each `$:` value, so it is said when it changes and not at every draw. */
  private computedFailures = new Map<string, string>();
  /** Whether the values have been said not to settle. */
  private computedUnsettledSaid = false;

  /** The page's window as the script meets it: its listeners and its `window.__…` values. */
  private readonly windowBridge: WindowBridge;

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
  /** External functions (e.g. wallet bridge) to inject into the VM as callable globals */
  private externalFunctions: Record<string, (...args: unknown[]) => unknown> | null = null;
  /** No-argument external bridge names compiled into the current VM. */
  private externalFunctionNames: string[] = [];
  /** Last primitive snapshot written to the VM, parallel to externalFunctionNames. */
  private externalFunctionValues: ExternalPrimitive[] = [];
  /** Slot holding the mutable external bridge value table inside the VM. */
  private externalValuesGlobalIndex = -1;

  // What the script's `softn.*` calls reach, each in host-calls/ with what it
  // keeps, and each closed with the app (see cleanup).
  /** What every one of them asks of this runtime: its permission checks, read live. */
  private readonly gate: HostGate;
  /** `softn.net.fetch`, the app's own files, and its server storage. */
  private readonly network: AppNetwork;
  private readonly audio: AppAudio;
  private readonly microphone: AppMicrophone;
  private readonly qr: QrReader;
  /** Local models and GPU compute. */
  private readonly ai: AppAI;
  /** The device's voices, loaded at the app's first speech call (local-speech.ts). */
  private localSpeech: LocalSpeechHost | null = null;
  /** The worker `softn.sandbox.run` runs code in, made at its first call. */
  private sandboxHost: SandboxHost | null = null;
  /** A page that has said this much with `alert()` has stopped telling the person anything. */
  private static readonly MAX_ALERTS = 50;

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
    // Made now, before the app's document mounts: the `__` globals already on
    // the window are the host's (see WindowBridge.hostWindowKeys).
    this.windowBridge = new WindowBridge(
      this,
      () => this.vmEngine,
      (eventType, eventObj, throttled) => this.dispatchWindowEvent(eventType, eventObj, throttled)
    );
    this.runtimeMode = options?.mode || 'main';
    this.documentShellRequest = options?.documentShell ?? null;
    this.browserHandlers = options?.browserHandlers === true;
    this.observedStateNames = options?.observedStateNames ?? null;
    this.drawnNames = options?.drawnNames ?? null;
    this.backendCall = options?.backendCall;
    this.netFetchHandler = options?.netFetchHandler;
    this.pythonProject = options?.pythonProject;
    this.onPersistenceFailure = options?.onPersistenceFailure ?? null;
    this.onAlert = options?.onAlert ?? null;
    this.externalFunctions = externalFunctions ?? null;
    this.db = createDBNamespace(() => this.permissionConfig, appId);
    if (typeof importResolver === 'function') {
      this.importResolver = importResolver as (path: string) => Promise<string | null>;
    }
    this.logicBasePath = logicBasePath;
    if (options?.permissionConfig) {
      this.permissionConfig = options.permissionConfig;
    }
    for (const p of options?.preIncludedLogicPaths ?? []) {
      this.includedLogicPaths.add(p);
    }

    // Read when asked, never kept: a grant replaces the permission config
    // after the app starts, and the app can close while a call waits.
    const gate: HostGate = {
      checkPermission: (capability) => this.checkPermission(capability),
      checkNetHost: (url) => this.checkNetHost(url),
      permissionConfig: () => this.permissionConfig,
      disposed: () => this.disposed,
    };
    this.gate = gate;
    this.network = new AppNetwork(gate, {
      assetResolver: options?.assetResolver ?? null,
      bundleFileProvider: bundleFileProvider ?? null,
      storageEndpoint: options?.storageEndpoint ?? null,
      visitorToken: options?.storageVisitorToken,
    });
    this.audio = new AppAudio(gate, () => this.externalFunctions?.asset);
    this.microphone = new AppMicrophone(gate);
    this.qr = new QrReader(gate);
    this.ai = new AppAI(gate, (path) => this.network.readBlob(path), bundleFileProvider ?? null);
  }

  /** Set the permission config for this runtime (from permission.json). */
  setPermissionConfig(config: PermissionConfig): void {
    this.permissionConfig = config;
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
      const value = readExternalValue(this.externalFunctions, name);
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
    this.computedMayHaveMoved();
  }

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
      // The script gets the failure as an exception; the host gets it here,
      // with the browser's own reason, to put in front of the person.
      this.vmEngine.onStorageFailure = (failure) => this.onPersistenceFailure?.(failure);
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

  /**
   * Load and execute a script or logic block inside the WASM VM.
   */
  async loadScript(script: CodeBlock): Promise<ScriptLoadResult> {
    const useHostBridges = this.runtimeMode === 'main';
    // A wait a previous script asked for holds a call id this one will reuse.
    this.timers.clear();

    // 0. Create the logic engine (the ZIPP adapter unless a host configured
    // one). A Python app asks for one that can run Python, and an engine that
    // cannot says so here — before any bridge is wired and before a line of
    // the author's code is compiled.
    this.vmEngine = this.pythonProject ? await createPythonLogicEngine() : await createLogicEngine();
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

    let symbolMap: Map<string, { index: number; scope: SymbolScope }>;
    let computedDecls: ComputedDeclaration[] = [];
    let computedCompiled = false;
    // The top-level `$:` declarations, each after the ones it reads.
    let computedPlan = planComputed([]);
    // The logic as its author and the host wrote it, for reading what a
    // function names. Empty for Python, which is not read that way.
    let writtenCode = '';
    this.computedSettle = null;
    this.computedBatch = null;
    this.computedStale = true;

    if (this.pythonProject) {
      // A Python app's logic is a set of modules, not one source string. There
      // are no imports to inline (Python imports by module name), no `$:`
      // declarations, and no preamble to prepend — a Python state has no
      // globals for one to declare. The engine compiles the project and
      // answers the same symbol map the JavaScript path builds below.
      const engine = this.vmEngine;
      if (typeof engine.initializePythonProject !== 'function') {
        throw new Error(
          'This app’s logic is written in Python, and this app runtime runs only JavaScript'
        );
      }
      symbolMap = await engine.initializePythonProject(this.pythonProject);
      if (this.abandonIfDisposed()) return SoftNScriptRuntime.ABANDONED;
    } else {
      // 3. Resolve imports (inline imported .logic files before passing to WASM),
      // after reading what was written as a module as the script it is.
      let resolvedCode = moduleSyntaxAsScript(script.code);
      if (this.importResolver) {
        // The entry file is already in `script.code`, so it counts as included
        // for dedupe as well as being the root of the cycle-detection chain.
        if (this.logicBasePath) this.includedLogicPaths.add(this.logicBasePath);
        resolvedCode = await inlineLogicImports(
          resolvedCode,
          { resolver: this.importResolver, included: this.includedLogicPaths },
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
      const external = collectExternalValues(this.externalFunctions);
      this.externalFunctionNames = external.names;
      this.externalFunctionValues = external.values;
      this.externalValuesGlobalIndex = -1;
      const extFnPreamble = externalValuesPreamble(external.names, external.values);

      // 4b. Compile each `$:` declaration into a real function.
      //
      // These are re-read on every render, and evaluating an expression *string*
      // costs a fresh parse each time — the engine interns the result for the VM's
      // lifetime, so a per-frame expression grows the heap until the tab dies.
      // Compiled once alongside the script, each becomes an ordinary call.
      //
      // Read from the code as it will be compiled, imports inlined, because
      // the top-level ones are also rewritten in it: each is worked out
      // through its function as the script loads, and one more generated
      // function works them all out again, in the order they read each other,
      // whenever the runtime asks (see computed-declarations.ts for why).
      computedDecls = extractComputedDeclarations(resolvedCode).filter(
        (d) => VALID_IDENTIFIER.test(d.name) && d.expression.trim() !== ''
      );
      computedPlan = planComputed(computedDecls);
      const computedPreamble = computedSource(computedDecls, computedPlan);
      writtenCode = extFnPreamble + resolvedCode;

      // 5. Prepend the engine's bridge preamble (empty on zipp, which declares
      // window/navigator/db/localStorage/host itself) then SoftN's own, and
      // the timers (logic-timers.ts).
      // 5a. Code written for a browser is given its document: the page's
      // HTML, seeded before the code's first line runs, so the code finds
      // what is written above it as a browser's code does.
      let shellCode = '';
      // Code that declares a `document` of its own is not given another; a
      // name of the shell's it declares itself (`class Comment`) stays its own.
      const asks =
        this.documentShellRequest !== null && logicEngineIsSandboxed() && (usesDocument(resolvedCode) || this.browserHandlers);
      const ownNames = asks ? namesDeclaredBy(resolvedCode) : new Set<string>();
      if (asks && useHostBridges && !ownNames.has('document')) {
        const [{ shellPrelude }, shell] = await Promise.all([
          import('../document-shell/shell-source'),
          this.documentShellRequest!.create(),
        ]);
        if (this.abandonIfDisposed()) return SoftNScriptRuntime.ABANDONED;
        this.documentShell = shell;
        shellCode = shellPrelude(shell.seedJson());
        this.documentShellOn = true;
      } else if (asks && !useHostBridges) {
        console.warn('[SoftN] This page\u2019s code uses the document, which is given to code on the main thread only; in a worker, document is not defined.');
      }

      // The app's `"use strict"` goes first: after the bridges it is an
      // ordinary string, and the engine reads the directive off the start.
      // Its `$:` names are then given globals to assign (computedGlobalsSource).
      const strict = prologueIsStrict(resolvedCode)
        ? STRICT_DIRECTIVE + computedGlobalsSource(computedDecls.map((declaration) => declaration.name))
        : '';
      const bridges =
        strict + VM_BRIDGE_PREAMBLE + SOFTN_BRIDGE_PREAMBLE + timerPreamble(resolvedCode) + extFnPreamble + shellCode;
      const scriptCode = bridges + resolvedCode + TIMER_TRAILER;
      const fullCode = computedPreamble
        ? bridges + guardFirstValues(resolvedCode, computedPlan) + '\n' + computedPreamble + TIMER_TRAILER
        : scriptCode;

      // 5. Compile + run the full .logic code in the WASM VM.
      //
      // The generated `$:` bodies share the script's compilation unit, so a
      // declaration the scanner mis-extracts — an expression broken across lines
      // in a way it cannot follow, say — would fail the whole script rather than
      // the one value it belongs to. On that failure, compile the script without
      // them and evaluate those expressions one at a time instead.
      computedCompiled = computedPreamble !== '';
      try {
        symbolMap = await this.vmEngine.initializeScript(fullCode);
      } catch (compileError) {
        if (!computedCompiled) throw await placeSyntaxError(compileError, resolvedCode);
        console.warn(
          '[SoftN] A `$:` declaration could not be compiled, so all of them fall back ' +
            'to per-render evaluation. The script itself is unaffected. Cause:',
          compileError
        );
        computedCompiled = false;
        // And the script is compiled as its author wrote it: nothing is
        // generated, so there is nothing to keep the `$:` globals true with.
        computedPlan = planComputed([]);
        // The failed compile took the engine with it — v0.0.1 terminates an
        // Engine whose `initScript` throws, wiping its bridges and its capability
        // allowlist — so the retry cannot reuse it. Rebuilding also re-wires and
        // re-grants; retrying in place would compile into a VM that denies every
        // `db.*` call the fallback was supposed to rescue.
        this.vmEngine.dispose();
        this.vmEngine = await createLogicEngine();
        if (this.abandonIfDisposed()) return SoftNScriptRuntime.ABANDONED;
        if (useHostBridges) this.installHostBridges();
        try {
          symbolMap = await this.vmEngine.initializeScript(scriptCode);
        } catch (error) {
          throw await placeSyntaxError(error, resolvedCode);
        }
      }
    }
    this.symbolMap = symbolMap;

    // The document is set up and the code's first run has changed it: the
    // page's events can come in, and what the code did goes out to be drawn.
    if (this.documentShellOn) {
      this.documentShell!.attach(
        (id, type, props, path) => this.dispatchDocumentEvent(id, type, props, path),
        () => this.documentReady()
      );
      this.takeDocumentChanges();
    }
    this.externalValuesGlobalIndex = symbolMap.get(EXTERNAL_VALUES_VAR)?.index ?? -1;

    // 6. Set up window global index (sync keys are discovered dynamically)
    if (useHostBridges) {
      const windowSym = symbolMap.get('window');
      if (windowSym) {
        this.windowBridge.windowGlobalIndex = windowSym.index;
      }
    }

    // 6. Read initial state from VM globals and classify symbols
    const initialState: Record<string, unknown> = {};
    const functionNames: string[] = [];
    const stateVarNames: string[] = [];
    const settledNames = new Set(computedPlan.order.map((declaration) => declaration.name));

    for (const [name, sym] of symbolMap.entries()) {
      // Skip bridge-injected variables
      if (BRIDGE_VARS.has(name)) continue;

      // The shell's own names, when the page is given one, are not the
      // page's state or its functions.
      if (this.documentShellOn && isShellName(name)) continue;

      // Generated `$:` bodies are engine plumbing, not script API.
      if (name.startsWith(COMPUTED_PREFIX)) continue;

      // A `$:` value the script also declares (`let double = 0`) is still a
      // computed value and not state. As state it was mirrored to the page
      // once and read from there ever after — a page looks in state first —
      // so the page showed its first value while logic moved on.
      if (settledNames.has(name) && sym.scope !== 'function') continue;

      if (sym.scope === 'function') {
        functionNames.push(name);
      } else {
        stateVarNames.push(name);
        // WASM returns plain JS values — no formLogicToJS conversion needed
        initialState[name] = this.vmEngine.getGlobal(sym.index);
      }
    }

    // A value that reads another through a function says nothing of it in
    // its own words, so the order they are worked out in cannot know.
    const calls = new Set(functionNames);
    const readsThroughAFunction = computedDecls.some((declaration) =>
      [...namesReadBy(declaration.expression)].some((name) => calls.has(name))
    );

    // State the markup never names is kept in the engine and not mirrored to
    // the page. But a `$:` value is how a page reads state: `$: label =
    // "step " + step` puts `step` on the screen though no markup names it.
    // Left unmirrored, a change to `step` told the page nothing, the page
    // was not redrawn, and `label` stood at its first value. So what a `$:`
    // expression names is observed too — and where one reaches further,
    // through a function, there is no telling what it reads, and everything
    // is mirrored, as it is for a host that never asked for less.
    if (this.observedStateNames && computedDecls.length > 0) {
      if (readsThroughAFunction) {
        this.observedStateNames = null;
      } else {
        const observed = new Set(this.observedStateNames);
        for (const declaration of computedDecls) {
          for (const name of namesReadBy(declaration.expression)) observed.add(name);
        }
        this.observedStateNames = observed;
      }
    }

    // A function the page calls while it is drawn is the other way a page
    // reads state: `<p>{label()}</p>` over `function label() { return "n is "
    // + n }` puts `n` on the screen, and no markup names it. `n` was kept in
    // the engine, a change to it told the page nothing, and the paragraph
    // stood at "n is 1" whatever was clicked. So what such a function may
    // read is observed as well: every name in its body and in what its body
    // names, followed through the logic (see drawn-functions.ts). A function
    // only an event runs is not followed, which is what keeps a game's large
    // state in the engine: `tick` reads all of it, and is never drawn. Where
    // a drawn function cannot be followed, everything is mirrored.
    //
    // What only such a function reads is watched rather than copied (see
    // partitionStateVars): the page reads it through the function, from the
    // engine, and needs to know only that it moved.
    let readOnlyWhenDrawn: ReadonlySet<string> = new Set();
    if (this.observedStateNames) {
      const reads = readsOfDrawnFunctions({
        code: writtenCode,
        functionNames,
        drawn: this.drawnNames ?? this.observedStateNames,
        python: this.pythonProject !== undefined,
      });
      if (!reads.known) {
        debug(
          `[SoftN] All state is mirrored: the page calls ${reads.functions.join(', ')} while it is drawn, and ${reads.why}.`
        );
        this.observedStateNames = null;
      } else if (reads.names.size > 0) {
        const observed = new Set(this.observedStateNames);
        const added = new Set<string>();
        for (const name of reads.names) {
          if (!observed.has(name)) added.add(name);
          observed.add(name);
        }
        this.observedStateNames = observed;
        readOnlyWhenDrawn = added;
      }
    }
    this.partitionStateVars(stateVarNames, symbolMap, readOnlyWhenDrawn);
    debug(
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

    // 9. Computed values. A top-level one is read from the values the settle
    // function hands back, so a page sees exactly what logic sees; one written
    // inside a function is bound to the function compiled for it in 4b, as
    // before; and where nothing could be compiled each is evaluated by itself.
    if (computedPlan.order.length > 0) {
      // A script where one reads another through a function is settled by
      // working everything out again until nothing changes.
      this.computedSettle = {
        names: computedPlan.order.map((declaration) => declaration.name),
        untilStill: readsThroughAFunction && computedPlan.circles.length === 0,
      };
      for (const circle of computedPlan.circles) {
        console.error(
          `[SoftN] These $: values read each other in a circle: ${circle.join(' → ')}. None of them can be worked out before the others, so each is worked out once, in the order written, from what the others were.`
        );
      }
    }
    const computed: Record<string, () => unknown> = {};
    for (const { name, expression } of computedDecls) {
      if (!computedCompiled) {
        computed[name] = () => this.evaluateExpression(expression);
      } else if (settledNames.has(name)) {
        computed[name] = () => this.readSettledComputed(name);
      } else {
        const fn = `${COMPUTED_PREFIX}${name}`;
        computed[name] = () => this.callComputed(fn, name);
      }
    }

    // What the top level queued (a timer, a `softn.*` call) or put on the
    // window (a listener) waited for the first call into the script, which
    // for an app without `_init` was the first click; the worker runtime
    // takes it as the script loads. Take it once the host has had the
    // result: a macrotask, so an `_init` the renderer calls straight away
    // still goes first and takes it as it always has, and this finds nothing
    // left to do.
    this.loadEntry = setTimeout(() => {
      this.loadEntry = null;
      void this.runWhatTheTopLevelQueued();
    }, 0);

    return {
      state: initialState,
      functions,
      syncFunctions,
      computed,
    };
  }

  /** The look made after `loadScript`, until it runs; see the end of `loadScript`. */
  private loadEntry: ReturnType<typeof setTimeout> | null = null;

  /**
   * Run the host calls the script's top level queued, timers among them, and
   * hear the listeners it put on the window, if nothing has done so yet, as
   * the worker runtime does at load. No script code runs here.
   */
  private async runWhatTheTopLevelQueued(): Promise<void> {
    await this.vmCallLock;
    if (this.disposed || !this.vmEngine || this.vmEngine.terminated) return;
    let release: (() => void) | undefined;
    this.vmCallLock = new Promise<void>((r) => {
      release = r;
    });
    let pending: PendingHostCall[] = [];
    try {
      pending = this.vmEngine.drainPendingHostCalls();
      this.windowBridge.listen();
      this.windowBridge.discoverSyncKeys();
    } catch (error) {
      console.error('[SoftN] Error taking what the script queued as it loaded:', error);
    } finally {
      release!();
    }
    if (pending.length > 0) await this.processPendingHostCallsUnlocked(pending);
  }

  /** The script's timers, on the host's clock; see logic-timers.ts. */
  private readonly timers = new LogicTimers((callId) => this.timerDue(callId));
  /** Timers that came due and wait for one entry to answer them all. */
  private dueTimers: number[] = [];
  private timerEntryQueued = false;

  private timerDue(callId: number): void {
    this.dueTimers.push(callId);
    this.answerDueTimers();
  }

  /**
   * Answer every timer that is due in one entry into the engine, as a handler
   * is run: the callbacks' writes reach the page together and the page is
   * drawn once. Timers that come due while that entry waits for the engine
   * join it, so a page with many timers cannot fill the call queue.
   */
  private answerDueTimers(): void {
    if (this.timerEntryQueued || this.dueTimers.length === 0) return;
    this.timerEntryQueued = true;
    let entered = false;
    void this.enterVM('timer callbacks', false, () => {
      entered = true;
      const due = this.dueTimers;
      this.dueTimers = [];
      for (const callId of due) {
        try {
          this.vmEngine!.resolveHostCallback(callId, null);
        } catch (error) {
          // One callback failing does not stop the others, and an interval
          // has already asked for its next wait.
          console.error('[SoftN] A timer callback in the logic failed:', error);
        }
      }
    }).finally(() => {
      this.timerEntryQueued = false;
      if (this.disposed || this.vmEngine?.terminated) {
        this.timers.dispose();
        this.dueTimers = [];
        return;
      }
      if (entered) this.answerDueTimers();
      // Not let in because the call queue is full: try again shortly rather
      // than lose a callback, or an interval, for good.
      else setTimeout(() => this.answerDueTimers(), 16);
    });
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
    return (...args: unknown[]): Promise<unknown> => {
      // What the script is given is read now, while the event is the one it
      // was: after the wait for the engine React has cleared the event's
      // `currentTarget`, and `@click={save}` was given no `target` and no
      // `currentTarget` on the main thread where the worker gave both. The
      // engine reads these records as they are.
      const crossing = sanitizeArgs(args);
      return this.enterVM(name, droppable, () => this.vmEngine!.callFunction(name, crossing));
    };
  }

  /**
   * Enter the engine the way a handler does, with `run` as what happens
   * inside: the page's state goes in first, what the script changed comes
   * back to the page after, and the host calls it queued are run. A function
   * the page calls and a timer that comes due both enter this way.
   */
  private async enterVM(name: string, droppable: boolean, run: () => unknown): Promise<unknown> {
    // Droppable calls (rapid-fire events) are dropped at the soft limit.
    // Critical calls (user interactions) are only dropped at the hard limit.
    const QUEUE_SOFT_LIMIT = 32;
    const QUEUE_HARD_LIMIT = 128;
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
      this.windowBridge.toVM();
      // The function reads `$:` values as they are for the state it is
      // called with, not as they were when the script loaded.
      this.settleComputedIfStale();
      this._perfSyncToVMMs += performance.now() - tSyncStart;

      // Suppress XDB notifications during the WASM call — all db mutations
      // within the function are batched into a single notification per collection
      // at the end, instead of firing on every individual create/update/delete.
      // This eliminates O(n) re-queries when functions like startHand() do 20+ mutations.
      this.xdbService?.suppressNotifications();

      // WASM engine takes plain JS args directly — no conversion needed
      const tWasm = performance.now();
      const result = run();
      this._perfWasmMs += performance.now() - tWasm;

      return result;
    } catch (error) {
      console.error(`[SoftN] Error executing function ${name}:`, error);
      return undefined;
    } finally {
      // Resume XDB notifications — fires one 'refresh' per affected collection.
      this.xdbService?.resumeNotifications();

      // Whatever it changed, the `$:` values are worked out from.
      this.computedMayHaveMoved();

      // Always sync state back, even if the VM function threw mid-execution.
      // Partial state mutations before the error should be reflected in the UI.
      // Drain pending host calls while we still hold the lock, but DON'T await
      // their execution — that would block other VM calls (e.g. movement ticks)
      // for the entire duration of async operations like AI generation.
      let pendingCalls: unknown[] | null = null;
      try {
        // Disposed during the call: there is no engine left to read back from.
        if (!this.disposed) {
          const tSyncReact = performance.now();
          this.syncVMStateToReact();
          this.windowBridge.fromVM();
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
          this.windowBridge.listen();
          this.windowBridge.discoverSyncKeys();
        }
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
        debug(
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
   *
   * Among the synced, state that only a function the page calls while it is
   * drawn reads (`readOnlyWhenDrawn`) is watched rather than copied. The page
   * reads it through that function, which reads the engine's own, so what the
   * page needs is to be drawn again when it moves: its digest is compared like
   * the others' and the page is drawn again, and its value is neither read out
   * nor written back. Copied, a list of 4,000 records that one such function
   * counts was about 35 ms of every tick of a game loop. This needs a host
   * that can be asked to draw the page ({@link ScriptContext.redraw}) and an
   * engine that digests in place; without both it is copied as before.
   */
  private partitionStateVars(
    names: string[],
    symbolMap: Map<string, { index: number; scope: SymbolScope }>,
    readOnlyWhenDrawn: ReadonlySet<string> = new Set()
  ): void {
    const observed = this.observedStateNames;
    this.watchedStateSet = new Set();
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
    if (readOnlyWhenDrawn.size > 0 && this.context.redraw && this.engineDigests()) {
      this.watchedStateSet = new Set(synced.filter((name) => readOnlyWhenDrawn.has(name)));
    }
  }

  /** Synced state the page is drawn again for when it moves, and never holds a copy of. */
  private watchedStateSet: ReadonlySet<string> = new Set();

  /** Whether the engine can digest globals in place; an empty ask is enough to tell. */
  private engineDigests(): boolean {
    const engine = this.vmEngine as unknown as {
      getGlobalsFingerprint?: (indices: number[]) => number[] | null;
    } | null;
    try {
      return Array.isArray(engine?.getGlobalsFingerprint?.([]));
    } catch {
      return false;
    }
  }

  /**
   * Key for the per-render sync-call cache, or null when the arguments cannot
   * be described by one.
   *
   * Returning null means "call through and do not cache". Reference arguments
   * always answer null: there is no cheap, lossless description of an object
   * graph, and the `JSON.stringify` this replaced folded distinct values onto
   * one key and visited the whole of every object handed to it — see
   * sync-cache-key.ts. A helper called twice with the same array in one render
   * now runs twice; a helper called with an argument the key cannot tell from
   * another no longer returns the other one's answer.
   */
  private syncCacheKey(name: string, args: unknown[]): string | null {
    return buildSyncCacheKey(name, args);
  }

  /**
   * Create a sync function wrapper for template expressions.
   * Does NOT propagate state changes (used during React render).
   * Stripped to bare minimum for performance — window sync is only done
   * in async wrappers (needed for Scene3D mouse-look, not template expressions).
   */
  private createVMSyncFunction(name: string): (...args: unknown[]) => unknown {
    return (...args: unknown[]): unknown => {
      try {
        // Skip React→VM sync if an async function is in-flight — the VM has
        // the latest state and overwriting it would clobber the async function's changes.
        if (!this.asyncCallInProgress) {
          this.syncReactStateToVM();
        }
        this.syncExternalFunctionsToVM();
        // A helper that reads a `$:` value reads it as it is now. Nothing is
        // marked afterwards: a helper asked from a page does not change state.
        this.settleComputedIfStale();

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

  /** The document the page's code is given, when it uses one; see ScriptRuntimeOptions.documentShell. */
  private readonly documentShellRequest: DocumentShellRequest | null;
  /** The page has handlers written for a browser: see ScriptRuntimeOptions.browserHandlers. */
  private readonly browserHandlers: boolean;
  private documentShell: DocumentShell | null = null;
  private documentShellOn = false;

  /** What the person did to the page (typed, ticked, focused), into the document before the code runs. */
  private syncDocumentIn(): void {
    if (!this.documentShellOn || !this.vmEngine) return;
    const changes = this.documentShell!.takeSync();
    if (changes) this.vmEngine.callFunctionSync(SHELL_SYNC, [changes]);
  }

  /**
   * What the code did to the document, out to the page, after it ran. The
   * shell hands it over a page at a time, each kept until the next is asked
   * for: a page the engine could not hand across is asked for again (the
   * shell sends it in halves), so nothing the code did is lost. All of it is
   * applied at once, as one turn's changes.
   */
  private takeDocumentChanges(): void {
    if (!this.documentShellOn || !this.vmEngine) return;
    const ops: ShellOp[] = [];
    let failed = false;
    let failures = 0;
    for (;;) {
      let page: ShellOp[] | null;
      try {
        page = this.vmEngine.callFunctionSync(SHELL_TAKE, [failed]) as ShellOp[] | null;
        failed = false;
      } catch (error) {
        failed = true;
        if (this.vmEngine.terminated || ++failures > 40) {
          console.error('[SoftN] What the page\u2019s code did to the document could not be read:', error);
          break;
        }
        continue;
      }
      if (!page) break;
      for (const op of page) ops.push(op);
    }
    if (ops.length > 0) this.documentShell!.apply(ops);
  }

  /**
   * Run the engine for something that happened on the page, the way a
   * listener the logic put on the window is run (dispatchWindowEvent): the
   * page's state in, the call, then what changed back out to the page. Said
   * and returned as nothing when it fails, as a listener's failure is.
   */
  private enterForDocument(name: string, args: unknown[]): unknown {
    if (!this.vmEngine || this.disposed || this.vmEngine.terminated) return 0;
    this.syncReactStateToVM();
    this.windowBridge.toVM();
    this.settleComputedIfStale();
    let result: unknown = 0;
    try {
      result = this.vmEngine.callFunctionSync(name, args);
    } catch (error) {
      console.error('[SoftN] The page\u2019s code failed while handling the page:', error);
    }
    this.computedMayHaveMoved();
    this.syncCallCache.clear();
    this.syncVMStateToReact();
    this.windowBridge.fromVM();
    this.windowBridge.discoverSyncKeys();
    this.windowBridge.listen();
    const pending = this.vmEngine.drainPendingHostCalls();
    if (pending.length > 0) void this.processPendingHostCallsUnlocked(pending);
    return result;
  }

  /** An event on an element of the document, dispatched there: 1 when cancelled, 2 when stopped. */
  dispatchDocumentEvent(id: number, type: string, props: Record<string, unknown>, path: unknown[] = []): number {
    const flags = this.enterForDocument(SHELL_EVENT, [id, type, props, path]);
    return typeof flags === 'number' ? flags : 0;
  }

  /** The page has been drawn: DOMContentLoaded and load, to the code that waits for them. */
  documentReady(): void {
    this.enterForDocument(SHELL_READY, []);
  }

  /**
   * Sync React component state → VM globals.
   * Uses batch API: single WASM boundary crossing for all state variables.
   */
  private syncReactStateToVM(): void {
    if (!this.symbolMap || !this.vmEngine) return;
    this.syncDocumentIn();
    // _vmDirty is set by the worker runtime when state comes back from the worker thread,
    // ensuring the main-thread WASM VM globals stay in sync with worker-reported state.
    const vmDirty = (this.context as unknown as Record<string, unknown>)._vmDirty;
    // null = initial sync (all keys), empty set = nothing dirty
    const dirty = this.dirtyStateKeys;
    if (dirty !== null && dirty.size === 0 && !vmDirty) return;
    // State is changing — invalidate sync function cache so the next calls
    // execute against fresh VM globals instead of returning stale results.
    this.syncCallCache.clear();
    this.computedMayHaveMoved();
    if (dirty === null || vmDirty) {
      // Full sync: first call or worker pushed new state. Watched state is
      // left out: the page's copy of it is the one from when the script
      // loaded, and pushing it would put that back over the live value.
      const watched = this.watchedStateSet;
      const indices: number[] = [];
      const values: unknown[] = [];
      for (let i = 0; i < this.stateVarNames.length; i++) {
        if (watched.has(this.stateVarNames[i])) continue;
        const value = this.context.state[this.stateVarNames[i]];
        // The page's copy of a node of the document is a record standing
        // for it, and never the node: the engine's own is left alone.
        if (this.documentShellOn && holdsShellNode(value)) continue;
        indices.push(this.stateVarIndices[i]);
        values.push(value);
      }
      this.vmEngine.setGlobalsBatch(indices, values);
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
        if (this.vmOwnedStateSet.has(key) || this.watchedStateSet.has(key)) continue;
        const sym = this.symbolMap!.get(key);
        if (sym) {
          const value = this.context.state[key];
          if (this.documentShellOn && holdsShellNode(value)) continue;
          indices.push(sym.index);
          values.push(value);
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

  /**
   * Sync VM globals → React component state.
   * Uses VM-side dirty tracking to only deepEqual globals that were actually
   * written during execution, eliminating O(N) deepEqual scans on unchanged state.
   */
  private syncVMStateToReact(): void {
    if (!this.symbolMap || !this.vmEngine) return;
    this.takeDocumentChanges();

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

    // Watched state is never read (see partitionStateVars). A digest of it
    // that moved draws the page again, and so does any doubt, the same doubt
    // that reads everything else.
    const watched = this.watchedStateSet;
    let watchedMoved = watched.size > 0;

    const fingerprints = this.readFingerprints();
    if (fingerprints) {
      nextFingerprints = fingerprints;
      const previous = this.stateVarFingerprints;
      if (previous && previous.length === fingerprints.length) {
        indicesToCheck = [];
        namesToCheck = [];
        watchedMoved = false;
        for (let i = 0; i < fingerprints.length; i++) {
          // NaN never equals itself, so an "unknown" digest reads. That is the
          // behaviour we want and the reason this is not written as !==.
          if (fingerprints[i] !== previous[i]) {
            if (watched.has(this.stateVarNames[i])) {
              watchedMoved = true;
              continue;
            }
            indicesToCheck.push(this.stateVarIndices[i]);
            namesToCheck.push(this.stateVarNames[i]);
          }
        }
        if (indicesToCheck.length === 0 && !FINGERPRINT_AUDIT()) {
          this.stateVarFingerprints = nextFingerprints;
          if (watchedMoved) this.context.redraw?.();
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
    if (watched.size > 0 && namesToCheck === this.stateVarNames) {
      indicesToCheck = this.stateVarIndices.filter((_, i) => !watched.has(this.stateVarNames[i]));
      namesToCheck = this.stateVarNames.filter((name) => !watched.has(name));
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
        const wasSkipped = !skipped.has(indicesToCheck[i]);
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
    if (changedKeys.length === 0) {
      if (watchedMoved) this.context.redraw?.();
      return;
    }
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
      this.settleComputedIfStale();
      return this.vmEngine.callFunctionSync(fnName, []);
    } catch (error) {
      console.error(`[SoftN] Error evaluating computed "${declName}":`, error);
      return undefined;
    }
  }

  /**
   * Work every top-level `$:` value out again inside the VM and assign it,
   * so that guest code reading one — another `$:`, a function — reads what
   * its expression is worth now. Answers the values, in the order of
   * `computedSettle.names`, when they are wanted.
   *
   * One pass does it for a script whose `$:` expressions name what they
   * read: the generated function goes through them in that order. A script
   * where one reads another through a function is passed over again until a
   * pass changes nothing, within a bound, so that a pair that will never
   * stop changing costs a fixed amount and is said once.
   */
  private settleComputed(wanted: boolean): unknown[] | null {
    const plan = this.computedSettle;
    if (!plan || !this.vmEngine) return null;

    const compare = plan.untilStill;
    let values: unknown[] | null = null;
    for (let pass = 1; ; pass++) {
      const [next, failures] = this.vmEngine.callFunctionSync(COMPUTED_SETTLE_FUNCTION, [wanted || compare]) as [
        unknown[] | null,
        Array<[number, string]>,
      ];
      const still = !compare || (values !== null && deepEqual(values, next));
      values = next;
      if (still || pass === COMPUTED_SETTLE_PASSES) {
        this.sayComputedFailures(plan.names, failures);
        if (!still && !this.computedUnsettledSaid) {
          this.computedUnsettledSaid = true;
          console.error(
            `[SoftN] The $: values were still changing after being worked out ${COMPUTED_SETTLE_PASSES} times, and are left as they stood. One of them reads another through a function, and each time round gives a different answer.`
          );
        }
        break;
      }
    }
    this.computedStale = false;
    // A helper asked from the page may have answered from the values as they
    // were; its answer must not outlive them.
    this.syncCallCache.clear();
    return values;
  }

  /** Say why a `$:` value could not be worked out, when the reason is new. */
  private sayComputedFailures(names: readonly string[], failures: ReadonlyArray<[number, string]>): void {
    const failed = new Map(failures.map(([index, reason]) => [names[index], reason]));
    for (const name of names) {
      const reason = failed.get(name);
      if (reason === undefined) {
        this.computedFailures.delete(name);
      } else if (this.computedFailures.get(name) !== reason) {
        this.computedFailures.set(name, reason);
        console.error(`[SoftN] Error evaluating computed "${name}":`, reason);
      }
    }
  }

  /** Bring the `$:` globals up to date before guest code that may read them runs. */
  private settleComputedIfStale(): void {
    if (!this.computedSettle || !this.computedStale) return;
    try {
      this.settleComputed(false);
    } catch (error) {
      console.error('[SoftN] Error working out the $: values:', error);
    }
  }

  /** Something the `$:` values are worked out from may have changed. */
  private computedMayHaveMoved(): void {
    if (!this.computedSettle) return;
    this.computedStale = true;
    this.computedBatch = null;
  }

  /**
   * A top-level `$:` value, as a page reads it.
   *
   * A draw reads every value one after another, with nothing between. The
   * first read works them all out — the same pass that assigns the globals
   * logic reads, so the page and the logic cannot disagree — and the rest of
   * that draw is answered from it. The answers are dropped as soon as the
   * draw is over, so the next one works them out again whatever changed in
   * between: a record written by another tab moves nothing this runtime
   * could have noticed.
   */
  private readSettledComputed(name: string): unknown {
    try {
      if (!this.vmEngine || !this.computedSettle) return undefined;
      if (!this.computedBatch) {
        // Skip React→VM sync if an async function is in-flight
        if (!this.asyncCallInProgress) {
          this.syncReactStateToVM();
        }
        this.syncExternalFunctionsToVM();
        const values = this.settleComputed(true) ?? [];
        const batch = new Map<string, unknown>();
        this.computedSettle.names.forEach((settled, index) => batch.set(settled, values[index]));
        this.computedBatch = batch;
        queueMicrotask(() => {
          if (this.computedBatch === batch) this.computedBatch = null;
        });
      }
      return this.computedBatch.get(name);
    } catch (error) {
      console.error(`[SoftN] Error evaluating computed "${name}":`, error);
      return undefined;
    }
  }

  /**
   * Evaluate an expression synchronously using the VM.
   */
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
        // The page's state moved: values handed out for a draw are over.
        this.computedBatch = null;
      }
    }
    Object.assign(this.context.state, newState);
  }

  /**
   * Run an event the page's window heard into the listeners the logic put
   * on its window (see WindowBridge.listen): the page's state in, the
   * listeners, then what they changed back out to the page.
   */
  private dispatchWindowEvent(eventType: string, eventObj: Record<string, unknown>, isThrottled: boolean): void {
    if (!this.vmEngine) return;

    // Sync React state → VM before dispatch
    this.syncReactStateToVM();
    // Skip window sync for throttled events — mouse/scroll handlers
    // rarely need window properties, and this saves ~2 WASM crossings/frame.
    if (!isThrottled) {
      this.windowBridge.toVM();
    }

    // Dispatch to VM handlers (runs synchronously in WASM)
    this.settleComputedIfStale();
    try {
      this.vmEngine.dispatchEvent(eventType, eventObj);
    } catch (error) {
      // Said as a handler's failure is, and the app goes on, with what
      // the listener changed before it threw. It used to leave the
      // browser's own listener as an uncaught error that named no part of
      // the app, and skip the drawing below.
      console.error(`[SoftN] Error in a ${eventType} listener the logic put on the window:`, error);
    }
    this.computedMayHaveMoved();
    // And what a function answered the page from. An answer is kept for
    // the rest of a drawing, and let go by a call of the script's or by
    // two milliseconds passing; a listener is neither, so a page drawn
    // again straight after a key was answered from before the key.
    this.syncCallCache.clear();

    // Sync VM state → React after dispatch
    this.syncVMStateToReact();
    if (!isThrottled) {
      this.windowBridge.fromVM();
      // Discover new __ window properties set by the handler.
      // Deferred for throttled events since they rarely add new sync keys.
      this.windowBridge.discoverSyncKeys();
    }

    // A handler that called `softn.*` queued a host call the engine is
    // holding until someone drains it. `callFunction` drains after every
    // call and the worker runtime drains after every dispatch, but this
    // path drained nothing, so a `softn.audio.play` from a keydown
    // handler sat in the queue until the next function call happened to
    // release it. Not awaited: the handler has returned and the browser
    // event is over; the calls resolve into the VM as they complete.
    const pending = this.vmEngine.drainPendingHostCalls();
    if (pending.length > 0) void this.processPendingHostCallsUnlocked(pending);
  }

  /**
   * Clean up resources (event listeners, WASM engine, etc.)
   */
  cleanup(): void {
    this.sandboxHost?.dispose();
    this.sandboxHost=null;
    // Set before anything else: an in-flight `loadScript` checks this after
    // each of its awaits, so a cleanup that lands mid-load stops the script
    // from being executed into an engine nobody will ever dispose.
    this.disposed = true;

    // The window's listeners, and the app's own `window.__…` values.
    this.windowBridge.dispose();
    // Nor may a timer the script set fire into a disposed engine.
    this.timers.dispose();
    this.dueTimers = [];
    if (this.loadEntry !== null) {
      clearTimeout(this.loadEntry);
      this.loadEntry = null;
    }
    clearCapturedKeys(this);
    setAppElement(this, null);
    this.syncCallCache.clear();
    this.externalFunctionNames = [];
    this.externalFunctionValues = [];
    this.externalValuesGlobalIndex = -1;

    // Silence. A looping track has no reason to stop on its own, so closing
    // the tab on an app playing music would otherwise leave it playing for
    // the rest of the session with nothing on screen to stop it.
    this.audio.silence();
    this.localSpeech?.dispose();
    this.localSpeech = null;

    // And stop listening. A microphone left open outlives the app that opened
    // it: the tracks stay live, the OS recording indicator stays lit, and
    // nothing on screen explains why.
    this.microphone.close();

    // Image decoding has no native AbortSignal. Explicitly settle any pending
    // load so a malformed image cannot keep an orphaned host call alive.
    this.qr.dispose();

    // An app that has been closed no longer owns background network work.
    // Abort pending fetches so they cannot continue downloading into an
    // orphaned host-call continuation.
    this.network.dispose();

    // Release AI resources: each loaded model's Worker is terminated.
    this.ai.dispose();

    // Dispose WASM engine
    if (this.vmEngine) {
      this.vmEngine.dispose();
      this.vmEngine = null;
    }
  }

  /**
   * Register a __ window property key for syncing from real window → VM.
   */
  registerSyncKey(key: string): void {
    this.windowBridge.registerSyncKey(key);
  }

  // ── Host call processing (softn.* bridge) ───────────────────────────

  /** Max total host calls resolved per processPendingHostCalls invocation.
   *  Prevents runaway callback chains from consuming unbounded memory/CPU. */
  private static readonly MAX_HOST_CALL_ROUNDS = 256;

  /**
   * Process pending host calls WITHOUT holding the VM lock during async operations.
   * The lock is released before this method is called, so other VM calls (like
   * movement ticks) can execute while slow host operations (AI generation) run.
   * The lock is re-acquired only briefly to resolve each callback in the VM.
   */
  private async processPendingHostCallsUnlocked(initialPending: PendingHostCall[]): Promise<void> {
    if (!this.vmEngine) return;

    // Timers keep their own clock and are not run one after another with the
    // rest: see LogicTimers.
    let pending = this.timers.take(initialPending);
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
          this.settleComputedIfStale();
          this.vmEngine!.resolveHostCallback(call.id, result);
          this.computedMayHaveMoved();
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
        pending = this.timers.take(this.vmEngine.drainPendingHostCalls());
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

  /** The element the app is drawn in (see key-capture.ts `appHears`). */
  setAppRoot(element: Element | null): void {
    setAppElement(this, element);
  }

  private async executeHostCall(call: PendingHostCall): Promise<unknown> {
    switch (call.kind) {
      case 'backend.call': {
        if (!this.backendCall) return { error: 'This app has no connected backend.' };
        const [action, raw] = call.args;
        if (!/^[a-z][a-zA-Z0-9_-]{0,63}$/.test(action) || (raw?.length ?? 0) > 32768) {
          return { error: 'Invalid backend request.' };
        }
        try {
          const input: unknown = JSON.parse(raw || '{}');
          if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Backend input must be an object.' };
          return await this.backendCall(action, input as Record<string, unknown>);
        } catch (error) {
          return { error: error instanceof Error ? error.message : 'Backend request failed.' };
        }
      }
      case 'net.fetch': {
        // A host that supplied a handler has taken this capability over: the
        // request is its to make or refuse, and the permission check and host
        // allowlist in `AppNetwork.fetch` belong to the browser `fetch` the
        // handler is standing in for. The script's options object is parsed
        // here rather than passed on as text so the handler sees what the
        // browser path sees.
        if (!this.netFetchHandler) return this.network.fetch(call);
        const [url, optionsJson] = call.args;
        let options: Record<string, unknown> = {};
        try {
          options = optionsJson ? JSON.parse(optionsJson) : {};
        } catch {
          return { error: 'The request options are not JSON.' };
        }
        return this.netFetchHandler(url, options);
      }
      case 'qr.encode':
        return this.qr.encode(call);
      case 'qr.decode':
        return this.qr.decode(call);
      case 'camera.capturePhoto':
        return this.handleCameraCapture(call);
      case 'camera.recordVideo':
        return this.handleCameraRecord(call);
      case 'camera.startLive':
        return this.handleCameraStartLive(call);
      case 'camera.stopLive':
        return this.handleCameraStopLive();
      case 'mic.record':
        return this.microphone.record(call);
      case 'mic.stop':
        return this.microphone.stop();
      case 'mic.isRecording':
        return this.microphone.isRecording();
      case 'audio.play':
        return this.audio.play(call);
      case 'audio.stop':
        return this.audio.stop(call);
      case 'audio.stopAll':
        return this.audio.stopAll();
      case 'audio.setVolume':
        return this.audio.setVolume(call);
      case 'audio.whenEnded':
        return this.audio.whenEnded(call);
      case 'audio.speechCapabilities':
      case 'audio.loadSpeechModel':
      case 'audio.releaseSpeechModel':
      case 'audio.speak':
      case 'audio.speechState':
      case 'audio.whenSpeechEnded':
      case 'audio.stopSpeech':
        return this.handleLocalSpeech(call);
      case 'sandbox.run':
        this.sandboxHost ??= new SandboxHost();
        return this.sandboxHost.run(call.args[0],call.args[1]);
      case 'files.readZipText':
        return readZipText(this.gate, call);
      case 'files.pickFile':
        return pickFile(this.gate, call);
      case 'files.readText':
        return readText(this.gate, call);
      case 'files.readBase64':
        return readBase64(this.gate, call);
      case 'files.saveFile':
        return saveFile(this.gate, call);
      case 'input.captureKeys':
        return this.handleInputCaptureKeys(call);
      case 'ai.getCapabilities':
        return this.ai.capabilities();
      case 'ai.onnx.loadModel':
      case 'ai.onnx.run':
      case 'ai.onnx.release':
      case 'ai.pipeline':
      case 'ai.generate':
      case 'ai.embed':
      case 'ai.classify':
      case 'ai.run':
        // The ONNX and transformers.js engines behind these are gone, and
        // with them about 80 MB of WebAssembly. Said by name, so an app
        // written for them fails with a reason rather than a missing function.
        this.checkPermission('ai');
        throw new Error(`softn.${call.kind} was removed: local models now run on ZIPP, as GGUF chat models through softn.ai.model.load and softn.ai.model.generate`);
      case 'ai.releaseAll':
        return this.ai.releaseAll();
      case 'ai.model.load':
        return this.ai.load(call);
      case 'ai.model.generate':
        return this.ai.generate(call);
      case 'ai.model.cancel':
        return this.ai.cancel(call);
      case 'ai.model.release':
        return this.ai.release(call);
      case 'ai.gpu.requestDevice':
        return this.ai.gpuRequestDevice(call);
      case 'ai.gpu.createBuffer':
        return this.ai.gpuCreateBuffer(call);
      case 'ai.gpu.writeBuffer':
        return this.ai.gpuWriteBuffer(call);
      case 'ai.gpu.createShader':
        return this.ai.gpuCreateShader(call);
      case 'ai.gpu.createPipeline':
        return this.ai.gpuCreatePipeline(call);
      case 'ai.gpu.dispatch':
        return this.ai.gpuDispatch(call);
      case 'ai.gpu.readBuffer':
        return this.ai.gpuReadBuffer(call);
      case 'ai.gpu.release':
        return this.ai.gpuRelease(call);
      case 'ai.gpu.releaseAll':
        return this.ai.gpuReleaseAll();
      case 'storage.op':
        return this.network.storage(call);
      case 'bundle.read':
        return this.network.readFile(call);
      case 'dialog.alert': {
        // A page's alert(), shown when its turn is over: nothing waits on it.
        //
        // Never the browser's own dialog. That one says it is the host
        // speaking ("softn.com says…"), and holds the whole tab until it is
        // answered: an app could word a host's request for a password, or
        // raise one from a timer each time the last was closed, so nobody
        // could reach the permission bar or leave. It is shown in the app,
        // as the app's; not while the permission bar is asking, so nothing
        // the app says sits beside that question; and not past a limit.
        const [message] = call.args;
        if (this.permissionConfig?.consentPending) return null;
        if (++this.alertsShown > SoftNScriptRuntime.MAX_ALERTS) return null;
        const text = String(message ?? '').slice(0, 2000);
        if (this.onAlert) this.onAlert(text);
        else console.warn(`[SoftN] The app says: ${text}`);
        return null;
      }
      default:
        throw new Error(`Unknown host call: ${call.kind}`);
    }
  }

  // ── Permission checks (host-calls/permissions.ts), on the config as it is now ──

  private checkPermission(capability: string): void {
    requirePermission(this.permissionConfig, capability);
  }

  private checkNetHost(url: string): void {
    requireNetHost(this.permissionConfig, url);
  }

  private async handleLocalSpeech(call: PendingHostCall): Promise<unknown> {
    // The device's own voices only: nothing is downloaded, so speech asks for
    // no permission (local-speech.ts). Loaded at an app's first speech call.
    if (!this.localSpeech) {
      const { LocalSpeechHost } = await import('./local-speech');
      this.localSpeech ??= new LocalSpeechHost();
      // The app may have closed while the module loaded, when cleanup() had no
      // host to stop: this one stops at once, so it answers as a closed app's
      // host does and speaks for nobody (nor holds the device's voice from
      // the apps still open).
      if (this.disposed) this.localSpeech.dispose();
    }
    return this.localSpeech.handle(call.kind,call.args);
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

  /**
   * `softn.input.captureKeys(keys)`: the keys whose browser default the
   * window bridge cancels before the script's handler sees them. Not a
   * gated capability: it changes nothing but the page the app already
   * owns, and never touches a text field or a browser chord.
   */
  private async handleInputCaptureKeys(call: PendingHostCall): Promise<unknown> {
    const keys = parseCapturedKeys(call.args[0]);
    setCapturedKeys(this, keys);
    return { captured: keys.length };
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

/** What the Web Worker runtime asks of the main thread; see `createHostCallExecutor`. */
export interface HostCallExecutor {
  executeHostCall(call: PendingHostCall): Promise<unknown>;
  cleanup(): void;
  /** Whose captured keys and app element these are (key-capture.ts). */
  readonly owner: object;
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
    owner: runtime,
  };
}

// The modules a script is given (script-modules.ts), from here as they always were.
export { createPersistentXDBModule, createDBNamespace, createMockXDBModule, createMockNavModule, createConsoleModule } from './script-modules';
export type { DBNamespace } from './script-modules';

// The sync module cache lives with the shared sync controls; re-exported here
// because the renderer and the worker runtime import it from this module.
export { getSyncModuleCache, setSyncModuleCache } from './db-sync-controls';
