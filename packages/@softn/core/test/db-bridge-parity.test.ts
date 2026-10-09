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
 * One answer is not the same, and is written down here as it is rather than
 * changed: `db.update` of a record that is not there throws on the main
 * thread (`Record not found: <id>`) and answers null in the worker, as it
 * does on the server hosts. A script written against one is wrong on the
 * other (`try { db.update(...) } catch { db.create(...) }` never creates in
 * the worker; `if (!db.update(...)) db.create(...)` throws on the main
 * thread). Which of the two it should be is a decision about every app
 * already written, so this pins both until it is made; a change to either
 * has to come through here.
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
      out[name] = `throws: ${(error as Error).message}`;
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
  // The one the two answer differently; see the note at the top.
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

    const { 'update what is not there': missingOnMain, ...restOnMain } = onMain;
    const { 'update what is not there': missingInWorker, ...restInWorker } = inWorker;
    expect(restInWorker).toEqual(restOnMain);
    // Not a hollow agreement: the calls did what their names say.
    expect(restOnMain['query by a field']).toBe('["B"]');
    expect(restOnMain['prune to one']).toBe('2');
    expect(restOnMain['get after delete']).toBe('null');

    expect(missingOnMain).toBe('throws: Record not found: missing-id');
    expect(missingInWorker).toBe('null');
  });
});
