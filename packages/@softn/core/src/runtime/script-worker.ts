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
import { deepEqual } from './vm-state';

// Type-only import from script-runtime (no runtime dependency on DOM-heavy module)
import type { CodeBlock } from './script-runtime';
import type { AppPermissions } from '../bundle/types';

type ImportResolver = (path: string) => Promise<string | null>;

// ============================================================================
// State
// ============================================================================

let wasmAdapter: VmAdapter | null = null;
const dbBridge = new SnapshotDBBridge();
const lsBridge = new SnapshotLocalStorageBridge();

let symbolMap: Map<string, { index: number; scope: SymbolScope }> | null = null;
let stateVarNames: string[] = [];
let stateVarIndices: number[] = [];
let functionNames: string[] = [];
const workerState: Record<string, unknown> = {};

// Engine-provided bindings, not script state. `host` is in the symbol map
// because the engine exposes it for two-way syncing, but syncing it as a state
// variable would round-trip its methods through the host and back.
const BRIDGE_VARS = new Set(['window', 'navigator', 'host', 'softn']);

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
// Import resolution utility (mirrors SoftNScriptRuntime.resolveImports)
// ============================================================================

/** Every path inlined so far in this script; reset per `init`. */
let includedPaths = new Set<string>();

async function resolveImports(
  code: string,
  visited: Set<string>,
  basePath?: string
): Promise<string> {
  const importRegex = /^import\s+["']([^"']+)["']\s*;?\s*$/gm;
  let result = code;
  const replacements: { full: string; source: string }[] = [];
  let match: RegExpExecArray | null;

  while ((match = importRegex.exec(code)) !== null) {
    replacements.push({ full: match[0], source: match[1] });
  }

  for (const { full, source } of replacements) {
    let resolvedPath = source;
    if (basePath && source.startsWith('./')) {
      const baseDir = basePath.replace(/\/[^/]+$/, '');
      resolvedPath = baseDir + '/' + source.slice(2);
    }
    if (visited.has(resolvedPath)) {
      throw new Error(
        `Circular import detected: "${resolvedPath}" is already in the import chain: ${[...visited].join(' → ')} → ${resolvedPath}`
      );
    }
    // Once only, wherever it is imported from — the second inclusion of a file
    // is a redeclaration of everything in it.
    if (includedPaths.has(resolvedPath)) {
      result = result.replace(full, () => `// [import already included: ${source}]`);
      continue;
    }
    includedPaths.add(resolvedPath);
    visited.add(resolvedPath);
    const importedSource = await workerImportResolver(resolvedPath);
    // The replacement is a function on purpose: a string replacement expands
    // `$&`, `$'` and friends, and a source file with a `$'` in a comment came
    // back spliced together with the code around the import — every
    // declaration after it twice.
    if (importedSource) {
      const nested = await resolveImports(importedSource, visited, resolvedPath);
      result = result.replace(full, () => nested);
    } else {
      result = result.replace(full, () => `// [import not found: ${source}]`);
    }
    visited.delete(resolvedPath);
  }
  return result;
}

// ============================================================================
// State sync helpers
// ============================================================================

function syncStateToVM(): void {
  if (!wasmAdapter || stateVarIndices.length === 0) return;
  const values = stateVarNames.map(name => workerState[name]);
  wasmAdapter.setGlobalsBatch(stateVarIndices, values);
}

// ============================================================================
// Message handler
// ============================================================================

self.onmessage = async (evt: MessageEvent) => {
  const msg = evt.data as Record<string, unknown>;

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

      // Create WASM adapter
      wasmAdapter = await VmAdapter.create();

      // Register snapshot-based bridges
      wasmAdapter.registerDBBridge(dbBridge as never);
      if (!permissions || permissions.storage !== false) {
        wasmAdapter.registerLocalStorageBridgeCustom(lsBridge);
      }

      // Resolve imports. The shell may already have inlined some of the logic
      // files and left their `import` lines in place; those paths arrive as
      // pre-included and are skipped, as the main-thread runtime skips them.
      let resolvedCode = script.code;
      const preIncluded = payload.preIncludedLogicPaths;
      includedPaths = new Set<string>(Array.isArray(preIncluded) ? (preIncluded as string[]) : []);
      if (logicBasePath) {
        resolvedCode = await resolveImports(
          resolvedCode,
          new Set([logicBasePath]),
          logicBasePath
        );
      }

      // Compile and run
      const fullCode = VM_BRIDGE_PREAMBLE + resolvedCode;
      symbolMap = await wasmAdapter.initializeScript(fullCode);

      // Extract state and functions. A variable the template cannot observe is
      // VM-owned: never read out, never written back — the main-thread
      // runtime's partition, and the difference between mirroring 21 numbers a
      // call and a 2 MB cartridge.
      const observedNames = payload.observedStateNames;
      const observed = Array.isArray(observedNames) ? new Set(observedNames as string[]) : null;
      stateVarNames = [];
      stateVarIndices = [];
      functionNames = [];
      for (const [name, sym] of symbolMap.entries()) {
        if (BRIDGE_VARS.has(name)) continue;
        if (sym.scope === 'function') {
          functionNames.push(name);
        } else if (!observed || observed.has(name)) {
          stateVarNames.push(name);
          workerState[name] = wasmAdapter.getGlobal(sym.index);
        }
      }
      stateVarIndices = stateVarNames.map(name => symbolMap!.get(name)!.index);

      const dbMutations = dbBridge.flushMutations();
      const lsMutations = lsBridge.flushMutations();

      self.postMessage({
        id,
        ok: true,
        result: {
          state: { ...workerState },
          functionNames,
          syncFunctionNames: functionNames,
          computedNames: [],
          dbMutations,
          lsMutations,
        },
      });
      return;
    }

    if (type === 'call_fn') {
      if (!wasmAdapter || !symbolMap) throw new Error('runtime_not_initialized');
      const name = payload.name as string;
      const args = (payload.args || []) as unknown[];
      const dbSnapshot = payload.dbSnapshot as Record<string, unknown[]> | undefined;
      const lsSnapshot = payload.lsSnapshot as Record<string, string> | undefined;
      const syncStatus = payload.syncStatus as { connected: boolean; peers: number; room: string; peerId: string } | undefined;
      const savedSyncRoom = payload.savedSyncRoom as string | null | undefined;

      // Update snapshots — use mergeDelta for incremental updates when
      // the main thread sends only changed collections (dbDelta), or
      // fall back to full updateSnapshot for full snapshots (dbSnapshot).
      const dbDelta = payload.dbDelta as Record<string, unknown[]> | undefined;
      if (dbDelta) {
        dbBridge.mergeDelta(dbDelta as Record<string, never>, syncStatus, savedSyncRoom);
      } else if (dbSnapshot) {
        dbBridge.updateSnapshot(dbSnapshot as Record<string, never>, syncStatus, savedSyncRoom);
      }
      if (lsSnapshot) lsBridge.updateSnapshot(lsSnapshot);

      // Sync state from main thread → VM
      syncStateToVM();
      wasmAdapter.clearDirty();

      // Call the function
      const result = wasmAdapter.callFunction(name, args);

      // Narrow to the globals the VM may have written, then diff them. The
      // engine reports conservatively when it has no dirty bits of its own, so
      // the diff — not the report — is what decides a value actually changed;
      // posting unchanged state back would re-render the tree on every call.
      const dirtyIndices = wasmAdapter.getDirtyGlobals(stateVarIndices);
      const changedState: Record<string, unknown> = {};
      if (dirtyIndices.length > 0) {
        const dirtyValues = wasmAdapter.getGlobalsBatch(dirtyIndices) as unknown[];
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

      // Collect mutations
      const dbMutations = dbBridge.flushMutations();
      const lsMutations = lsBridge.flushMutations();

      self.postMessage({
        id,
        ok: true,
        result: {
          result,
          state: changedState,
          dbMutations,
          lsMutations,
        },
      });
      return;
    }

    if (type === 'update_context') {
      const state = (payload.state || {}) as Record<string, unknown>;
      // Merge diff into existing state (main thread sends only changed keys)
      Object.assign(workerState, state);
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
