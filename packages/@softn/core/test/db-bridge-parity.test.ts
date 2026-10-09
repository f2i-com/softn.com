/**
 * One sequence of `db.*` calls, answered by the main thread's namespace and
 * by the worker's snapshot bridge.
 *
 * A bundle that sets `config.execution: "worker"` runs the same logic
 * against the second of these, and nothing compared them call for call:
 * script-worker-bridges.test.ts checks that the methods exist and what each
 * does to the snapshot. This runs the calls a script makes, in order, through
 * both, and holds every answer the two give to be the same.
 *
 * Every answer is the same, the refusals included: `db.update` of a record
 * that is not there, deleted or never created, throws `Record not found:
 * <id>` from both. It used to throw on the main thread and answer null in
 * the worker, so `try { db.update(...) } catch { db.create(...) }` never
 * created in the worker; the main thread is the default and what apps are
 * written against, and the worker now does as it does
 * (db-update-missing.test.ts runs that through the engine). The server
 * hosts answer null for it and offer `db.updateIf` to ask first: that is a
 * separate API with deployments of its own, and is not held to this.
 *
 * Two more differences exist between the objects and are not in the
 * sequence, because no script can reach them. `create` with no data at all
 * gives a record with no `data` on the main thread and `data: {}` in the
 * worker, but both script engines send `{}` for missing data before either
 * is called. And the worker hands back its own record where the main thread
 * hands back a copy, but a record crosses into either engine as a copy, so
 * a script cannot change the snapshot by changing what it was given.
 */

import { describe, expect, it } from 'vitest';
import { SnapshotDBBridge } from '../src/runtime/script-worker-bridges';
import { createDBNamespace } from '../src/runtime/script-runtime';

type Db = Record<string, (...args: never[]) => unknown>;
interface Row {
  id: string;
  data: Record<string, unknown>;
}

/** The calls, and each answer with ids and times named instead of spelled. */
function answers(db: Db): Record<string, string> {
  const out: Record<string, string> = {};
  const ids = new Map<string, string>();
  const call = (name: string, ...args: unknown[]) => (db[name] as (...a: unknown[]) => unknown)(...args);
  const text = (value: unknown): string => {
    let json = JSON.stringify(value, (key, v) => ((key === 'created_at' || key === 'updated_at') && typeof v === 'string' ? '<time>' : v)) ?? 'undefined';
    for (const [id, name] of ids) json = json.split(id).join(name);
    return json;
  };
  const step = (name: string, fn: () => unknown) => {
    try {
      out[name] = text(fn());
    } catch (error) {
      let message = (error as Error).message;
      for (const [id, label] of ids) message = message.split(id).join(label);
      out[name] = `throws: ${message}`;
    }
  };
  const titles = (rows: unknown) => (rows as Row[]).map((row) => row.data.title);

  let a = { id: '' } as Row;
  let b = { id: '' } as Row;
  step('create', () => {
    a = call('create', 'notes', { title: 'A', n: 1, tags: ['x'] }) as Row;
    ids.set(a.id, '<A>');
    return a;
  });
  step('get', () => call('get', 'notes', a.id));
  step('update merges the patch into the record', () => call('update', a.id, { n: 2, extra: 'x' }));
  step('get after update', () => call('get', 'notes', a.id));
  step('update with an undefined field', () => call('update', a.id, { extra: undefined }));
  step('create a second', () => {
    b = call('create', 'notes', { title: 'B', owner: 'ann', n: 2 }) as Row;
    ids.set(b.id, '<B>');
    return b;
  });
  step('query', () => titles(call('query', 'notes')));
  step('query by a field', () => titles(call('query', 'notes', { owner: 'ann' })));
  step('query by a number', () => titles(call('query', 'notes', { n: 2 })));
  step('query by the number as text', () => titles(call('query', 'notes', { n: '2' })));
  step('query by a field that is undefined', () => titles(call('query', 'notes', { owner: undefined })));
  step('query by a field that is null', () => titles(call('query', 'notes', { owner: null })));
  step('query by no fields', () => titles(call('query', 'notes', {})));
  step('query by a list', () => titles(call('query', 'notes', { tags: ['x'] })));
  step('query a collection that is not there', () => call('query', 'nope'));
  step('get from a collection that is not there', () => call('get', 'nope', 'x'));
  step('get through the wrong collection', () => call('get', 'other', a.id));
  step('delete', () => call('delete', a.id));
  step('get after delete', () => call('get', 'notes', a.id));
  step('update what was deleted', () => call('update', a.id, { n: 9 }));
  step('query after delete', () => titles(call('query', 'notes')));
  step('delete again', () => call('delete', a.id));
  step('delete what is not there', () => call('delete', 'missing-id'));
  step('hardDelete', () => call('hardDelete', 'notes', b.id));
  step('get after hardDelete', () => call('get', 'notes', b.id));
  step('hardDelete what is not there', () => call('hardDelete', 'notes', 'missing-id'));
  step('three more', () => {
    for (const n of [1, 2, 3]) ids.set((call('create', 'log', { n }) as Row).id, `<L${n}>`);
    return (call('query', 'log') as Row[]).length;
  });
  step('prune to more than there are', () => call('prune', 'log', 5));
  step('prune to one', () => call('prune', 'log', 1));
  step('query after prune', () => (call('query', 'log') as Row[]).length);
  step('prune to none', () => call('prune', 'log', 0));
  step('prune to fewer than none', () => call('prune', 'log', -1));
  step('clear', () => call('clearCollection', 'notes'));
  step('query after clear', () => call('query', 'notes'));
  step('clear a collection that is not there', () => call('clearCollection', 'nope'));
  step('update what is not there', () => call('update', 'missing-id', { n: 1 }));
  return out;
}

describe('the worker db bridge and the main thread db namespace', () => {
  it('give a script the same answers to the same calls', async () => {
    const main = createDBNamespace(() => null, `parity-${Date.now()}`);
    await main.ready();
    const bridge = new SnapshotDBBridge();
    bridge.updateSnapshot({});

    const onMain = answers(main as unknown as Db);
    const inWorker = answers(bridge as unknown as Db);

    expect(inWorker).toEqual(onMain);
    expect(Object.keys(onMain).length).toBe(36);
    const restOnMain = onMain;
    // Not a hollow agreement: the calls did what their names say.
    expect(restOnMain['query by a field']).toBe('["B"]');
    expect(restOnMain['prune to one']).toBe('2');
    expect(restOnMain['get after delete']).toBe('null');

    expect(onMain['update what is not there']).toBe('throws: Record not found: missing-id');
    expect(onMain['update what was deleted']).toBe('throws: Record not found: <A>');
  });
});
