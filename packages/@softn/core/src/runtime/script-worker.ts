/**
 * Script Web Worker
 *
 * Runs the WASM script engine in a dedicated thread, using snapshot-based
 * bridges for DB and localStorage. The main thread sends fresh snapshots
 * before each function call, and the worker returns queued mutations.
 */

import {
  VmAdapter,
  VM_BRIDGE_PREAMBLE,
  type SymbolScope,
} from './vm-adapter';
import {
  SnapshotDBBridge,
  SnapshotLocalStorageBridge,
} from './script-worker-bridges';
import { SOFTN_BRIDGE_PREAMBLE } from './softn-preamble';
import { adoptZippWasmSource } from './zipp-wasm-loader';
import { TIMER_TRAILER, timerPreamble } from './logic-timers';
import { prologueIsStrict, STRICT_DIRECTIVE } from './directive-prologue';
import { deepEqual } from './vm-state';
import { moduleSyntaxAsScript } from './module-syntax';
import { inlineLogicImports } from './logic-imports';
import { endLine, logicOrigin, placeEngineSyntaxError } from './logic-origin';
import { BRIDGE_VARS } from './external-values';
import { setEngineFaultSink } from './engine-output';
import { readsOfDrawnFunctions } from './drawn-functions';

// Type-only import from script-runtime (no runtime dependency on DOM-heavy module)
import type { CodeBlock } from './script-runtime';
import type { AppPermissions } from '../bundle/types';

type ImportResolver = (path: string) => Promise<string | null>;

// ============================================================================
// State
// ============================================================================

let wasmAdapter: VmAdapter | null = null;
/** Settles when the page's engine has arrived; `init` waits for it. */
let engineArrived: () => void = () => {};
const engine = new Promise<void>((resolve) => { engineArrived = resolve; });
const dbBridge = new SnapshotDBBridge();
const lsBridge = new SnapshotLocalStorageBridge();
/** What the script copied during the entry; handed to the page by afterEntry. */
const clipboardWrites: string[] = [];

let symbolMap: Map<string, { index: number; scope: SymbolScope }> | null = null;
let stateVarNames: string[] = [];
let stateVarIndices: number[] = [];
let functionNames: string[] = [];
const workerState: Record<string, unknown> = {};

// Engine-provided bindings are not script state, and they are the main
// thread's list (external-values.ts): `host` is in the symbol map because the
// engine exposes it for two-way syncing, but syncing it as a state variable
// would round-trip its methods through the host and back, and the table the
// host's functions read their values from is the runtime's, not the app's.

/**
 * The runtime's own lines about a failed call ("[SoftN] ..."), which the
 * engine's output would otherwise print in this worker's console, where no
 * host is listening. Every entry hands them to the page; see afterEntry.
 */
const faults: string[] = [];
setEngineFaultSink((line) => faults.push(line));

/** What an entry that threw threw, as the page is to say it. */
function failureOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * afterEntry for an entry whose script code may have thrown. A failure is
 * handed back beside what the script changed before it threw, as the
 * main-thread runtime keeps that; only where the engine itself is gone and
 * nothing can be read is it sent as the entry's error.
 */
function afterFailedEntry(failure: string | undefined): Record<string, unknown> {
  try {
    const entry = afterEntry();
    return failure === undefined ? entry : { ...entry, failure };
  } catch (error) {
    throw failure === undefined ? error : new Error(failure);
  }
}

/** Engine steps one re-entry may spend in the worker; see where it is applied. */
const WORKER_INSTRUCTION_BUDGET = 1_000_000_000;

// ============================================================================
// Import resolution (RPC to main thread)
// ============================================================================

let importReqId = 1;
const IMPORT_TIMEOUT_MS = 15000;
const pendingImports = new Map<number, {
  resolve: (source: string | null) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}>();

const workerImportResolver: ImportResolver = (path: string) => {
  return new Promise((resolve, reject) => {
    // Note: we do NOT reject based on navigator.onLine, as it is unreliable
    // and would bypass service worker / PWA cache serving.
    const id = importReqId++;
    const timeoutId = setTimeout(() => {
      pendingImports.delete(id);
      reject(new Error(`Import request timed out for path: ${path}`));
    }, IMPORT_TIMEOUT_MS);
    pendingImports.set(id, { resolve, reject, timeoutId });
    self.postMessage({ type: 'import_request', id, path });
  });
};

// ============================================================================
// State sync helpers
// ============================================================================

/**
 * Main-thread state the VM has not seen yet. `update_context` raises it; the
 * next entry pushes. Pushing every mirrored variable on every call was a
 * setGlobalsBatch a frame for values that had not moved.
 */
let mainStateDirty = false;

function syncStateToVM(): void {
  if (!wasmAdapter || stateVarIndices.length === 0 || !mainStateDirty) return;
  mainStateDirty = false;
  const values = stateVarNames.map(name => workerState[name]);
  wasmAdapter.setGlobalsBatch(stateVarIndices, values);
}

/**
 * What every entry into the VM hands back: the mirrored variables that
 * changed, the `host.call`s the script queued, the event types it has
 * listeners for, and the storage mutations. The main thread executes each
 * host call and returns its result as a `resolve_host_call`, which is another
 * entry and yields another one of these — the main-thread runtime's host-call
 * loop, cut across the RPC boundary.
 */
function afterEntry(): Record<string, unknown> {
  const adapter = wasmAdapter!;
  // Narrow to the globals the VM may have written, then diff them. The engine
  // reports conservatively when it has no dirty bits of its own, so the diff —
  // not the report — is what decides a value actually changed; posting
  // unchanged state back would re-render the tree on every call.
  const dirtyIndices = adapter.getDirtyGlobals(stateVarIndices);
  const changedState: Record<string, unknown> = {};
  if (dirtyIndices.length > 0) {
    const dirtyValues = adapter.getGlobalsBatch(dirtyIndices) as unknown[];
    for (let i = 0; i < dirtyIndices.length; i++) {
      const varIdx = stateVarIndices.indexOf(dirtyIndices[i]);
      if (varIdx === -1) continue;
      const varName = stateVarNames[varIdx];
      const value = dirtyValues[i];
      if (deepEqual(value, workerState[varName])) continue;
      workerState[varName] = value;
      changedState[varName] = value;
    }
  }
  return {
    state: changedState,
    hostCalls: adapter.drainPendingHostCalls(),
    eventTypes: adapter.getEventListenerTypes(),
    dbMutations: dbBridge.flushMutations(),
    lsMutations: lsBridge.flushMutations(),
    clipboardWrites: clipboardWrites.splice(0),
    faults: faults.splice(0),
  };
}

/** Bring the main thread's view of storage and state into the VM before an entry. */
function beforeEntry(payload: Record<string, unknown>): void {
  const dbSnapshot = payload.dbSnapshot as Record<string, unknown[]> | undefined;
  const lsSnapshot = payload.lsSnapshot as Record<string, string> | undefined;
  const syncStatus = payload.syncStatus as { connected: boolean; peers: number; room: string; peerId: string } | undefined;
  const savedSyncRoom = payload.savedSyncRoom as string | null | undefined;
  // Use mergeDelta for incremental updates when the main thread sends only
  // changed collections (dbDelta), else a full snapshot (dbSnapshot).
  const dbDelta = payload.dbDelta as Record<string, unknown[]> | undefined;
  if (dbDelta) {
    dbBridge.mergeDelta(dbDelta as Record<string, never>, syncStatus, savedSyncRoom);
  } else if (dbSnapshot) {
    dbBridge.updateSnapshot(dbSnapshot as Record<string, never>, syncStatus, savedSyncRoom);
  }
  if (lsSnapshot) lsBridge.updateSnapshot(lsSnapshot);
  syncStateToVM();
  wasmAdapter!.clearDirty();
}

// ============================================================================
// Message handler
// ============================================================================

self.onmessage = async (evt: MessageEvent) => {
  const msg = evt.data as Record<string, unknown>;

  // The page's compiled engine: there is no copy beside this worker to fetch.
  if (msg?.type === 'engine') {
    adoptZippWasmSource(msg.engine as WebAssembly.Module);
    engineArrived();
    return;
  }

  // Handle import responses
  if (msg?.type === 'import_response') {
    const id = Number(msg.id || 0);
    const resolver = pendingImports.get(id);
    if (resolver) {
      pendingImports.delete(id);
      clearTimeout(resolver.timeoutId);
      resolver.resolve((msg.source as string | null) ?? null);
    }
    return;
  }

  const id = Number(msg?.id || 0);
  const type = String(msg?.type || '');
  const payload = (msg?.payload || {}) as Record<string, unknown>;

  try {
    if (type === 'init') {
      const script = payload.script as CodeBlock;
      const permissions = payload.permissions as AppPermissions | undefined;
      const logicBasePath = payload.logicBasePath as string | undefined;
      const dbSnapshot = payload.dbSnapshot as Record<string, unknown[]> | undefined;
      const lsSnapshot = payload.lsSnapshot as Record<string, string> | undefined;
      const syncStatus = payload.syncStatus as { connected: boolean; peers: number; room: string; peerId: string } | undefined;
      const savedSyncRoom = payload.savedSyncRoom as string | null | undefined;

      // Initialize snapshots
      if (dbSnapshot) dbBridge.updateSnapshot(dbSnapshot as Record<string, never>, syncStatus, savedSyncRoom);
      if (lsSnapshot) lsBridge.updateSnapshot(lsSnapshot);

      // Dispose previous adapter if reinitializing (prevents WASM memory leak)
      if (wasmAdapter) {
        wasmAdapter.dispose();
        wasmAdapter = null;
      }

      // Create WASM adapter, on the engine the page posts (above).
      await engine;
      wasmAdapter = await VmAdapter.create();
      // A call here blocks nothing the user can see, so one re-entry may spend
      // twenty times what it may on the main thread: a modem decoding a whole
      // recording needs ~100M steps in one call, which the main-thread fuse of
      // 50M — a bound on how long a page can freeze — refuses as a runaway.
      // This is still a bound: a genuine infinite loop is caught in seconds,
      // and the engine is spent afterwards exactly as before.
      wasmAdapter.setInstructionBudget(WORKER_INSTRUCTION_BUDGET);

      // Register snapshot-based bridges
      wasmAdapter.registerDBBridge(dbBridge as never);
      if (!permissions || permissions.storage !== false) {
        if (typeof payload.lsPrefix === 'string') lsBridge.setBudgetPrefix(payload.lsPrefix);
        wasmAdapter.registerLocalStorageBridgeCustom(lsBridge);
      }
      // A worker has no clipboard: what the script copies goes to the page
      // with the entry's other results, and the page writes it (applyClipboardWrites).
      if (!permissions || permissions.clipboard !== false) {
        wasmAdapter.registerClipboardBridge({ write: (text) => clipboardWrites.push(text) });
      }
      // The accelerator is a declared capability like the rest: a script that
      // did not ask for it gets a preamble whose `accel.*` throws.
      if (payload.accel === true) {
        await wasmAdapter.registerAccelBridge();
      }

      // Resolve imports, by the main-thread runtime's own rules (logic-imports.ts),
      // when the page has a resolver to ask. The shell may already have
      // inlined some of the logic files and left their `import` lines in
      // place; those paths arrive as pre-included and are skipped. A page from
      // before `resolveImports` was sent resolved when it named an entry file.
      let resolvedCode = moduleSyntaxAsScript(script.code);
      const resolves = typeof payload.resolveImports === 'boolean' ? payload.resolveImports : Boolean(logicBasePath);
      if (resolves) {
        const preIncluded = payload.preIncludedLogicPaths;
        const included = new Set<string>(Array.isArray(preIncluded) ? (preIncluded as string[]) : []);
        // The entry file is already in the code, so it counts as included as
        // well as being the root of the chain.
        if (logicBasePath) included.add(logicBasePath);
        resolvedCode = await inlineLogicImports(
          resolvedCode,
          { resolver: workerImportResolver, included },
          new Set(logicBasePath ? [logicBasePath] : []),
          logicBasePath
        );
      }

      // Compile and run. The `softn.*` namespace and the timers are the same
      // preambles the main-thread runtime prepends; their calls queue in the
      // engine and the main thread drains them from every entry's result.
      // The app's `"use strict"` goes first, as on the main thread.
      // The logic starts a line of its own, its positions count from there,
      // and a syntax error quotes its line, as on the main thread
      // (logic-origin.ts, without acorn).
      const externalPreamble = typeof payload.externalPreamble === 'string' ? payload.externalPreamble : '';
      const prefix = endLine(
        (prologueIsStrict(resolvedCode) ? STRICT_DIRECTIVE : '') +
          VM_BRIDGE_PREAMBLE +
          SOFTN_BRIDGE_PREAMBLE +
          timerPreamble(resolvedCode) +
          externalPreamble
      );
      const fullCode = prefix + resolvedCode + TIMER_TRAILER;
      mainStateDirty = false;
      try {
        symbolMap = await wasmAdapter.initializeScript(fullCode, logicOrigin(prefix));
      } catch (error) {
        throw placeEngineSyntaxError(error, resolvedCode);
      }

      // Extract state and functions. A variable the template cannot observe is
      // VM-owned: never read out, never written back — the main-thread
      // runtime's partition, and the difference between mirroring 21 numbers a
      // call and a 2 MB cartridge.
      const observedNames = payload.observedStateNames;
      let observed = Array.isArray(observedNames) ? new Set(observedNames as string[]) : null;
      functionNames = [];
      for (const [name, sym] of symbolMap.entries()) {
        if (!BRIDGE_VARS.has(name) && sym.scope === 'function') functionNames.push(name);
      }
      // What a function the page could call while it is drawn may read is
      // observed too, as on the main thread (see drawn-functions.ts): the
      // function is how the page reads that state. Unknown mirrors everything.
      if (observed) {
        const drawnNames = payload.drawnNames;
        const reads = readsOfDrawnFunctions({
          code: externalPreamble + resolvedCode,
          functionNames,
          drawn: Array.isArray(drawnNames) ? new Set(drawnNames as string[]) : observed,
        });
        if (!reads.known) observed = null;
        else for (const name of reads.names) observed.add(name);
      }
      stateVarNames = [];
      stateVarIndices = [];
      for (const [name, sym] of symbolMap.entries()) {
        if (BRIDGE_VARS.has(name) || sym.scope === 'function') continue;
        if (!observed || observed.has(name)) {
          stateVarNames.push(name);
          workerState[name] = wasmAdapter.getGlobal(sym.index);
        }
      }
      stateVarIndices = stateVarNames.map(name => symbolMap!.get(name)!.index);

      // Top-level code ran inside initializeScript: whatever it queued or
      // registered comes back with the initial state.
      const entry = afterEntry();

      self.postMessage({
        id,
        ok: true,
        result: {
          ...entry,
          state: { ...workerState },
          functionNames,
          syncFunctionNames: functionNames,
          computedNames: [],
        },
      });
      return;
    }

    if (type === 'call_fn') {
      if (!wasmAdapter || !symbolMap) throw new Error('runtime_not_initialized');
      const name = payload.name as string;
      const args = (payload.args || []) as unknown[];
      beforeEntry(payload);
      let result: unknown;
      let failure: string | undefined;
      try {
        result = wasmAdapter.callFunction(name, args);
      } catch (error) {
        failure = failureOf(error);
      }
      self.postMessage({ id, ok: true, result: { result, ...afterFailedEntry(failure) } });
      return;
    }

    // The main thread finished one of the `host.call`s a previous entry
    // reported: hand the script its result, in the callback it registered.
    if (type === 'resolve_host_call') {
      if (!wasmAdapter || !symbolMap) throw new Error('runtime_not_initialized');
      beforeEntry(payload);
      let failure: string | undefined;
      try {
        wasmAdapter.resolveHostCallback(Number(payload.callId), payload.result);
      } catch (error) {
        failure = failureOf(error);
      }
      self.postMessage({ id, ok: true, result: afterFailedEntry(failure) });
      return;
    }

    // A browser event for a listener the script registered through the
    // engine's `window.addEventListener`. The main thread owns the DOM and
    // forwards what the listener can use; the engine runs every handler for
    // the type, as it does on the main thread.
    if (type === 'dispatch_event') {
      if (!wasmAdapter || !symbolMap) throw new Error('runtime_not_initialized');
      beforeEntry(payload);
      let failure: string | undefined;
      try {
        wasmAdapter.dispatchEvent(
          String(payload.eventType),
          (payload.event || {}) as Record<string, unknown>
        );
      } catch (error) {
        failure = failureOf(error);
      }
      self.postMessage({ id, ok: true, result: afterFailedEntry(failure) });
      return;
    }

    if (type === 'update_context') {
      const state = (payload.state || {}) as Record<string, unknown>;
      // Merge diff into existing state (main thread sends only changed keys)
      Object.assign(workerState, state);
      mainStateDirty = true;
      syncStateToVM();
      self.postMessage({ id, ok: true, result: true });
      return;
    }

    if (type === 'dispose') {
      if (wasmAdapter) {
        wasmAdapter.dispose();
        wasmAdapter = null;
      }
      symbolMap = null;
      stateVarNames = [];
      stateVarIndices = [];
      functionNames = [];
      mainStateDirty = false;
      for (const key of Object.keys(workerState)) delete workerState[key];
      self.postMessage({ id, ok: true, result: true });
      return;
    }

    throw new Error(`unknown_worker_message:${type}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    self.postMessage({ id, ok: false, error: message });
  }
};
