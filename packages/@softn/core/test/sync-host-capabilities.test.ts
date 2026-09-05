/**
 * The regression this engine release class introduces.
 *
 * zipp v0.0.1 split a bridge handle from authority over it: `setDbBridge`
 * installs the object, `setSyncHostCapabilities` decides which of its methods a
 * guest may reach, and the allowlist freezes when `initScript` starts. A host
 * that wires a bridge and forgets the grant does not fail loudly at wiring
 * time — it fails inside the guest's first `db.query`, as
 * `SecurityError: synchronous host capability denied`.
 *
 * The defence is structural: every `register*Bridge` on the adapter declares
 * the operations it serves, and `initializeScript` flushes them in one call.
 * These tests hold that structure in place, so no present or future host can be
 * left denied. The first needs no maintenance when a bridge is added — it
 * enumerates them.
 */

import { describe, it, expect } from 'vitest';

import { ZippWasmAdapter } from '../src/runtime/zipp-wasm-adapter';
import { VmAdapter } from '../src/runtime/vm-adapter';

/** A minimum viable argument list for each registration method, by name. */
const DB_STUB = {
  query: () => [],
  get: () => null,
  create: () => ({}),
  update: () => ({}),
  delete: () => {},
  hardDelete: () => {},
  startSync: () => {},
  stopSync: () => {},
  getSyncStatus: () => ({ connected: false, peers: 0, room: '', peerId: '' }),
  getSavedSyncRoom: () => null,
};

const BRIDGE_STUBS: Record<string, unknown[]> = {
  registerDBBridge: [DB_STUB],
  registerLocalStorageBridge: ['CapabilityProbe'],
  registerLocalStorageBridgeCustom: [
    { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
  ],
  registerClipboardBridge: [],
  registerAccelBridge: [],
};

function registrarNames(): string[] {
  return Object.getOwnPropertyNames(ZippWasmAdapter.prototype).filter((name) =>
    /^register[A-Za-z]*Bridge/.test(name)
  );
}

describe('synchronous host capabilities', () => {
  it('grants an allowlist for every bridge the adapter can install', async () => {
    const names = registrarNames();
    // If this is ever zero the test has quietly stopped testing anything.
    expect(names.length).toBeGreaterThan(0);

    for (const name of names) {
      const args = BRIDGE_STUBS[name];
      expect(
        args,
        `${name} has no stub here. A new bridge was added: give it one, so this ` +
          'test keeps proving that installing a bridge also grants its operations.'
      ).toBeDefined();

      const adapter = await VmAdapter.create();
      try {
        (adapter as unknown as Record<string, (...a: unknown[]) => void>)[name](...args);
        expect(
          adapter.getPendingSyncCapabilities(),
          `${name} installs a bridge but declares no synchronous host ` +
            'capabilities, so every call through it is denied inside the guest.'
        ).not.toHaveLength(0);
      } finally {
        adapter.dispose();
      }
    }
  });

  it('grants nothing when nothing is wired', async () => {
    const adapter = await VmAdapter.create();
    try {
      expect(adapter.getPendingSyncCapabilities()).toEqual([]);
      await adapter.initializeScript('let ok = 1;');
      // No db bridge was installed, so the guest must be refused rather than
      // reaching an object it was never given.
      expect(() => adapter.evalSync('db.query("things")')).toThrow(/denied/);
    } finally {
      adapter.dispose();
    }
  });

  it('lets a wired db bridge through from the script top level', async () => {
    const created: Array<Record<string, unknown>> = [];
    const adapter = await VmAdapter.create();
    try {
      adapter.registerDBBridge({
        ...DB_STUB,
        create: (collection: string, data: Record<string, unknown>) => {
          created.push({ collection, ...data });
          return { id: 'r1', ...data };
        },
        query: () => created,
      } as never);
      await adapter.initializeScript(
        'db.create("runs", { at: "x" });\nlet n = db.query("runs").length;'
      );
      expect(created).toEqual([{ collection: 'runs', at: 'x' }]);
      expect(adapter.evalSync('n')).toBe(1);
    } finally {
      adapter.dispose();
    }
  });

  it('lets a wired localStorage bridge through, and denies it when unwired', async () => {
    const store = new Map<string, string>();
    const wired = await VmAdapter.create();
    try {
      wired.registerLocalStorageBridgeCustom({
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => void store.set(k, v),
        removeItem: (k) => void store.delete(k),
        clear: () => store.clear(),
      });
      await wired.initializeScript('localStorage.setItem("k", "v");');
      expect(store.get('k')).toBe('v');
    } finally {
      wired.dispose();
    }

    const unwired = await VmAdapter.create();
    try {
      unwired.registerDBBridge(DB_STUB as never);
      await unwired.initializeScript('let ok = 1;');
      expect(() => unwired.evalSync('localStorage.setItem("k", "v")')).toThrow(/denied/);
    } finally {
      unwired.dispose();
    }
  });

  it('serves navigator.clipboard from its own bridge, not the localStorage one', async () => {
    const written: string[] = [];
    const original = (globalThis.navigator as unknown as Record<string, unknown>).clipboard;
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (t: string) => void written.push(t) },
    });

    try {
      const lsOnly = await VmAdapter.create();
      try {
        // The old engine routed `nav.*` to the localStorage bridge. v0.0.1 never
        // does, so wiring localStorage alone must not reach the clipboard.
        lsOnly.registerLocalStorageBridge('ClipProbe');
        await lsOnly.initializeScript('let ok = 1;');
        expect(() => lsOnly.evalSync('navigator.clipboard.writeText("nope")')).toThrow(/denied/);
        expect(written).toEqual([]);
      } finally {
        lsOnly.dispose();
      }

      const withClipboard = await VmAdapter.create();
      try {
        withClipboard.registerClipboardBridge();
        await withClipboard.initializeScript('navigator.clipboard.writeText("copied");');
        expect(written).toEqual(['copied']);
        // The synchronous read can only ever answer empty, but it must answer
        // rather than throw: a script guarding on the result never had to
        // handle an exception there before.
        expect(withClipboard.evalSync('navigator.clipboard.readText()')).toBe('');
      } finally {
        withClipboard.dispose();
      }
    } finally {
      if (original) {
        Object.defineProperty(globalThis.navigator, 'clipboard', {
          configurable: true,
          value: original,
        });
      } else {
        delete (globalThis.navigator as unknown as Record<string, unknown>).clipboard;
      }
    }
  });

  it('reports an engine that terminated itself on a failed compile', async () => {
    const adapter = await VmAdapter.create();
    try {
      adapter.registerDBBridge(DB_STUB as never);
      await expect(adapter.initializeScript('let =;')).rejects.toThrow();
      // v0.0.1 kills the Engine on a failed initScript, taking its bridges and
      // its allowlist with it. A caller that retries must build a fresh one —
      // see the `$:` fallback in script-runtime's loadScript.
      expect(adapter.terminated).toBe(true);
    } finally {
      adapter.dispose();
    }
  });
});
