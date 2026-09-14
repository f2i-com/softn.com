/**
 * The worker's snapshot db bridge offers what the main-thread db namespace
 * offers, so a bundle that opts into `config.execution: "worker"` keeps the
 * surface it had on the main thread (core audit 2.7).
 */

import { describe, expect, it } from 'vitest';
import { SnapshotDBBridge, type DBMutation } from '../src/runtime/script-worker-bridges';
import { createDBNamespace } from '../src/runtime/script-runtime';

function rec(id: string, collection: string, created_at: string) {
  return { id, collection, data: { n: id }, created_at, updated_at: created_at, deleted: false };
}

describe('SnapshotDBBridge', () => {
  it('has every method of the db namespace', () => {
    const namespace = createDBNamespace(() => null, 'parity');
    const bridge = new SnapshotDBBridge();
    const missing = Object.keys(namespace).filter((name) => typeof (bridge as unknown as Record<string, unknown>)[name] !== 'function');
    expect(missing).toEqual([]);
  });

  it('prunes the oldest records from its snapshot and queues one mutation for the main thread', () => {
    const bridge = new SnapshotDBBridge();
    bridge.updateSnapshot({
      log: [rec('c', 'log', '2026-01-03'), rec('a', 'log', '2026-01-01'), rec('b', 'log', '2026-01-02')],
    });
    expect(bridge.prune('log', 5)).toBe(0);
    expect(bridge.prune('log', 1)).toBe(2);
    expect(bridge.query('log').map((r) => r.id)).toEqual(['c']);
    expect(bridge.get('log', 'a')).toBeNull();
    expect(bridge.update('a', { n: 'x' })).toBeNull();
    expect(bridge.flushMutations()).toEqual<DBMutation[]>([{ type: 'prune', collection: 'log', maxRecords: 1 }]);
  });

  it('clears a collection from its snapshot and queues one mutation for the main thread', () => {
    const bridge = new SnapshotDBBridge();
    bridge.updateSnapshot({ log: [rec('a', 'log', '2026-01-01')], keep: [rec('k', 'keep', '2026-01-01')] });
    bridge.clearCollection('log');
    expect(bridge.query('log')).toEqual([]);
    expect(bridge.get('log', 'a')).toBeNull();
    expect(bridge.query('keep')).toHaveLength(1);
    expect(bridge.flushMutations()).toEqual<DBMutation[]>([{ type: 'clearCollection', collection: 'log' }]);
    // Flushed once; a fresh snapshot starts a fresh queue.
    expect(bridge.flushMutations()).toEqual([]);
  });
});
