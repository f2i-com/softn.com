/**
 * useCollection with its options written in place.
 *
 * `useCollection('items', { sort: { field: 'n', order: 'asc' } })` hands the
 * hook new objects at every render. The hook keyed its query on those
 * objects, so every render made a new query, which re-subscribed, read the
 * collection again and set a new list of records, which rendered again: a
 * component that sorted or filtered this way rendered without end.
 */
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/** More renders than this is a loop: the test stops it rather than hang. */
const RENDER_CAP = 40;
let renders = 0;

function Sorted({ xdb, kind }: { xdb: XDBService; kind: string }): React.ReactElement {
  renders++;
  if (renders > RENDER_CAP) throw new Error('useCollection rendered without end');
  // Written in place, as a caller writes them: new objects at every render.
  const { records } = useCollection('items', { xdb, filter: { kind }, sort: { field: 'n', order: 'asc' } });
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
  renders = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function shown(): string[] {
  return Array.from(container.querySelectorAll('li')).map((li) => li.textContent ?? '');
}

describe('useCollection with options written in place', () => {
  it('renders a bounded number of times, and still follows the store and the options', async () => {
    const xdb = new XDBService(memoryStorage(), 'r3-hooks', undefined, { backend: 'storage' });
    xdb.create('items', { kind: 'a', n: 3 });
    xdb.create('items', { kind: 'b', n: 1 });
    xdb.create('items', { kind: 'a', n: 2 });
    // React reports the loop it detects; the cap above is what stops it.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await act(async () => {
        root.render(<Sorted xdb={xdb} kind="a" />);
      });
    } catch {
      // The cap threw: the loop is the failure asserted below.
    } finally {
      quiet.mockRestore();
    }
    expect(renders).toBeLessThan(10);
    expect(shown()).toEqual(['2', '3']);

    // A change in the store is still heard.
    await act(async () => {
      xdb.create('items', { kind: 'a', n: 1 });
    });
    expect(shown()).toEqual(['1', '2', '3']);

    // And a change of what the options say is still a new query.
    await act(async () => {
      root.render(<Sorted xdb={xdb} kind="b" />);
    });
    expect(shown()).toEqual(['1']);
    expect(renders).toBeLessThan(20);
  });
});
