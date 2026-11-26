/**
 * `<collection sort="field:order">` in a page's `<data>` block orders a field
 * that holds values of more than one type, as the store's own query does
 * (xdb-service.ts, test/xdb-r3-query.test.ts): numbers, then text, then
 * records, lists, and yes or no, each in its own order, and a record without
 * the field last whichever way the list runs. `a < b` between a number and a
 * word is false both ways, so the comparison said each record was after the
 * other, and a price typed in one form and imported as text from another
 * left the whole list in the order it was stored.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { useDataBlock } from '../src/loader/xdb-bindings';
import { parse } from '../src/parser';
import { getXDB } from '../src/runtime/xdb';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let apps = 0;

/** The values of `p` the data block hands the page, for records made in this order. */
async function sortedBy(values: unknown[], order: 'asc' | 'desc'): Promise<unknown[]> {
  const appId = `render-data-block-sort-${++apps}`;
  const xdb = getXDB(appId);
  await xdb.isReady;
  for (const p of values) xdb.create('items', p === undefined ? {} : { p });
  const document = parse(`<data><collection name="items" as="items" sort="p:${order}" /></data>\n<div>list</div>`);
  let read: unknown[] = [];
  function Probe() {
    const { data } = useDataBlock(document, appId);
    read = (data.items ?? []).map((record) => (record.data as { p?: unknown }).p);
    return null;
  }
  const root = createRoot(window.document.createElement('div'));
  await act(async () => root.render(<Probe />));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  act(() => root.unmount());
  return read;
}

describe('a data block sorted by a field of more than one type', () => {
  it('orders numbers, then text, whatever order the records were made in', async () => {
    for (const values of [
      [3, 'b', 1, 'a', 2, 'c'],
      ['c', 2, 'a', 1, 'b', 3],
      ['a', 'b', 'c', 3, 2, 1],
    ]) {
      expect(await sortedBy(values, 'asc')).toEqual([1, 2, 3, 'a', 'b', 'c']);
      expect(await sortedBy(values, 'desc')).toEqual(['c', 'b', 'a', 3, 2, 1]);
    }
  });

  it('keeps records without the field last, in either order', async () => {
    expect(await sortedBy([true, 'x', undefined, [2], 5, null, false, { k: 1 }, [1]], 'asc')).toEqual([
      5, 'x', { k: 1 }, [1], [2], false, true, undefined, null,
    ]);
    expect(await sortedBy([3, undefined, 1, 2], 'desc')).toEqual([3, 2, 1, undefined]);
  });

  it('sorts a field of one type as it did', async () => {
    expect(await sortedBy([10, 9, 100, -1], 'asc')).toEqual([-1, 9, 10, 100]);
    expect(await sortedBy(['b', 'B', 'a'], 'desc')).toEqual(['b', 'a', 'B']);
  });
});
