/**
 * `db.update` of a record that is not there, as a script meets it.
 *
 * On the page's own thread it throws `Record not found: <id>`. In a worker
 * (`config.execution: "worker"`) the same call answered null, so the same
 * bundle did two different things depending on a line in its manifest: the
 * usual upsert, `try { db.update(...) } catch { db.create(...) }`, created
 * on one and silently did nothing on the other, and a script that ignores
 * what update answers carried on as though its write had landed.
 *
 * A write that cannot be made says so, on both. The page's thread is the
 * default and is unchanged; the worker now throws the same error.
 *
 * Run through the real engine, not against the bridge object alone: what a
 * script can catch is what crosses the engine's boundary. The engine hands a
 * script its own words for any failed host call, not the host's, so a script
 * learns that the update failed and not why; the reason is the host's to log.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZippWasmAdapter } from '../src/runtime/zipp-wasm-adapter';
import { SnapshotDBBridge } from '../src/runtime/script-worker-bridges';
import { createDBNamespace } from '../src/runtime/script-runtime';

const SCRIPT = `
function tryUpdate(id) {
  try {
    var record = db.update(id, { n: 2 });
    return record === null ? "answered null" : "updated " + record.data.n;
  } catch (e) {
    return "threw: " + String((e && e.message) || e);
  }
}
function upsert(id) {
  try {
    db.update(id, { title: "kept" });
    return "updated";
  } catch (e) {
    db.create("notes", { title: "kept" });
    return "created";
  }
}
function make() { return db.create("notes", { n: 1 }).id; }
function remove(id) { db.delete(id); return true; }
function count() { return db.query("notes").length; }
`;

type Bridge = Parameters<ZippWasmAdapter['registerDBBridge']>[0];

async function engineOver(bridge: unknown): Promise<ZippWasmAdapter> {
  const adapter = await ZippWasmAdapter.create();
  adapter.registerDBBridge(bridge as Bridge);
  await adapter.initializeScript(SCRIPT);
  return adapter;
}

/** What the engine tells a script whose host call threw. */
const REFUSED = 'threw: host bridge call failed';

const hosts: Array<[string, () => Promise<unknown>]> = [
  [
    "the page's own thread",
    async () => {
      const db = createDBNamespace(() => null, `update-missing-${Date.now()}-${Math.random()}`);
      await db.ready();
      return db;
    },
  ],
  [
    'a worker',
    async () => {
      const bridge = new SnapshotDBBridge();
      bridge.updateSnapshot({});
      return bridge;
    },
  ],
];

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe.each(hosts)('a script on %s', (_name, makeBridge) => {
  it('is told that a record that was never there was not found', async () => {
    const engine = await engineOver(await makeBridge());
    try {
      expect(engine.callFunction('tryUpdate', ['never-there'])).toBe(REFUSED);
    } finally {
      engine.dispose();
    }
  });

  it('is told the same of a record it has deleted', async () => {
    const engine = await engineOver(await makeBridge());
    try {
      const id = engine.callFunction('make', []) as string;
      expect(engine.callFunction('tryUpdate', [id])).toBe('updated 2');
      engine.callFunction('remove', [id]);
      expect(engine.callFunction('tryUpdate', [id])).toBe(REFUSED);
    } finally {
      engine.dispose();
    }
  });

  it('creates with the usual upsert, where the worker used to do nothing', async () => {
    const engine = await engineOver(await makeBridge());
    try {
      expect(engine.callFunction('upsert', ['never-there'])).toBe('created');
      expect(engine.callFunction('count', [])).toBe(1);
    } finally {
      engine.dispose();
    }
  });
});

describe('the two, side by side', () => {
  it('give a script the same words', async () => {
    const said: string[] = [];
    for (const [, makeBridge] of hosts) {
      const engine = await engineOver(await makeBridge());
      try {
        said.push(String(engine.callFunction('tryUpdate', ['never-there'])));
      } finally {
        engine.dispose();
      }
    }
    expect(said).toEqual([REFUSED, REFUSED]);
  });

  it('and the worker queues nothing for a write it refused', () => {
    const bridge = new SnapshotDBBridge();
    bridge.updateSnapshot({});
    expect(() => bridge.update('never-there', { n: 1 })).toThrow('Record not found: never-there');
    expect(bridge.flushMutations()).toEqual([]);
  });
});
