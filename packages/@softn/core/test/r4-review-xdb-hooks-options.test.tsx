/**
 * useCollection's options told apart by what they say (audit round 4).
 *
 * Round 3 keyed the query on the options' JSON, so that options written in
 * place (new objects at every render) no longer made a new query each time.
 * JSON leaves out a field whose value is undefined, and writes NaN as null:
 * `{ filter: { kind: undefined } }`, which matches no record (none has the
 * field), and `{ filter: {} }`, which matches every one, had one key, so a
 * caller that went from one to the other kept the first query, and showed
 * nothing where every record belonged.
 */
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { XDBService, useCollection } from '../src/runtime/xdb';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
}

function Listed({ xdb, filter }: { xdb: XDBService; filter: Record<string, unknown> }): React.ReactElement {
  const { records } = useCollection('items', { xdb, filter: { ...filter } });
  return (
    <ul>
      {records.map((r) => (
        <li key={r.id}>{String(r.data.n)}</li>
      ))}
    </ul>
  );
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const shown = () => Array.from(container.querySelectorAll('li')).map((li) => li.textContent ?? '');

describe('useCollection given options JSON writes alike', () => {
  it('queries again when a filter field goes from undefined to not there', async () => {
    const xdb = new XDBService(memoryStorage(), 'r4-hooks', undefined, { backend: 'storage' });
    xdb.create('items', { n: 1 });
    xdb.create('items', { n: 2, kind: null });
    await act(async () => root.render(<Listed xdb={xdb} filter={{ kind: undefined }} />));
    expect(shown()).toEqual([]);
    await act(async () => root.render(<Listed xdb={xdb} filter={{}} />));
    expect(shown()).toEqual(['1', '2']);
  });

  it('queries again when a filter value goes from NaN to null', async () => {
    const xdb = new XDBService(memoryStorage(), 'r4-hooks-nan', undefined, { backend: 'storage' });
    xdb.create('items', { n: 1, kind: null });
    await act(async () => root.render(<Listed xdb={xdb} filter={{ kind: Number.NaN }} />));
    expect(shown()).toEqual([]);
    await act(async () => root.render(<Listed xdb={xdb} filter={{ kind: null }} />));
    expect(shown()).toEqual(['1']);
  });

  it('still keeps one query for options that say the same at every render', async () => {
    const xdb = new XDBService(memoryStorage(), 'r4-hooks-same', undefined, { backend: 'storage' });
    xdb.create('items', { n: 1, kind: 'a' });
    let reads = 0;
    const query = xdb.query.bind(xdb);
    xdb.query = ((...args: Parameters<XDBService['query']>) => {
      reads++;
      return query(...args);
    }) as XDBService['query'];
    await act(async () => root.render(<Listed xdb={xdb} filter={{ kind: 'a', extra: undefined }} />));
    const after = reads;
    await act(async () => root.render(<Listed xdb={xdb} filter={{ kind: 'a', extra: undefined }} />));
    expect(reads).toBe(after);
    // `extra: undefined` asks for records that hold the field as undefined: none here.
    expect(shown()).toEqual([]);
  });
});
