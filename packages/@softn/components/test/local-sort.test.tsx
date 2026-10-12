/**
 * A Table or DataGrid column marked `sortable` sorts the rows itself when the
 * page gives no `onSort`.
 *
 * The header was a button that did nothing without a handler: the arrows
 * drew, the header said it could sort, and a press left the rows as they
 * were. With `onSort` the page still sorts, and the rows are drawn in the
 * order it gives them.
 */

import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ComponentRegistry, parse, renderDocument, type SoftNComponent, type SoftNRenderContext } from '@softn/core';
import { mount, click } from './dom';
import { builtinComponents } from '../src/registry';
import { DataGrid } from '../src/data/DataGrid';
import { Table } from '../src/data/Table';
import { compareCells, sortRows } from '../src/utils/sort';

const registry = new ComponentRegistry();
registry.registerAll(builtinComponents as unknown as Record<string, SoftNComponent>);

function page(source: string, state: Record<string, unknown>, functions: Record<string, (...args: unknown[]) => unknown> = {}) {
  const doc = parse(source);
  expect(doc.diagnostics ?? [], source).toEqual([]);
  const context = { state, setState: () => {}, data: {}, props: {}, computed: {}, functions, asyncFunctions: {} } as unknown as SoftNRenderContext;
  return mount(<>{renderDocument(doc, context, registry)}</>);
}

const PEOPLE = [
  { id: 1, name: 'bob', tasks: 10, joined: '2024-03-01' },
  { id: 2, name: 'Ada', tasks: 9, joined: '2023-11-20' },
  { id: 3, name: 'Émile', tasks: 100, joined: '2024-01-15' },
  { id: 4, name: 'carl', tasks: 9, joined: '' },
];

/** The first column's text, row by row. */
const firstColumn = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('tbody tr, [role="row"][aria-rowindex]:not([aria-rowindex="1"])')).map((row) => (row.querySelector('[role="cell"]')?.textContent ?? '').trim());

const header = (container: HTMLElement, name: string) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => (b.textContent ?? '').trim().startsWith(name))!;

describe('the comparison', () => {
  it('reads numbers as numbers, dates as dates, and text in the reader’s order', () => {
    expect([10, 9, 100].sort(compareCells)).toEqual([9, 10, 100]);
    expect(['10', '9', '100'].sort(compareCells)).toEqual(['9', '10', '100']);
    expect(['2024-03-01', '2023-11-20', '2024-01-15'].sort(compareCells)).toEqual(['2023-11-20', '2024-01-15', '2024-03-01']);
    expect([new Date(2024, 2, 1), new Date(2023, 10, 20)].sort(compareCells).map((d) => d.getFullYear())).toEqual([2023, 2024]);
    expect(['bob', 'Ada', 'Émile', 'carl'].sort(compareCells)).toEqual(['Ada', 'bob', 'carl', 'Émile']);
    expect(['item 10', 'item 9'].sort(compareCells)).toEqual(['item 9', 'item 10']);
    expect([true, false].sort(compareCells)).toEqual([false, true]);
  });

  it('keeps the order of rows that tie, and puts empty cells last either way', () => {
    const rows = [{ k: 'a', v: 2 }, { k: 'b', v: 1 }, { k: 'c', v: 2 }, { k: 'd', v: null }, { k: 'e', v: 1 }];
    const value = (row: { v: number | null }) => row.v;
    expect(sortRows(rows, value, 'asc').map((r) => r.k)).toEqual(['b', 'e', 'a', 'c', 'd']);
    expect(sortRows(rows, value, 'desc').map((r) => r.k)).toEqual(['a', 'c', 'b', 'e', 'd']);
    expect(rows.map((r) => r.k)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe.each([
  ['Table', 'columns={[{ key: "name", header: "Name", sortable: true }, { key: "tasks", header: "Tasks", sortable: true }, { key: "joined", header: "Joined", sortable: true }]}'],
  ['DataGrid', 'virtualized={false} columns={[{ key: "name", header: "Name", sortable: true }, { key: "tasks", header: "Tasks", sortable: true }, { key: "joined", header: "Joined", sortable: true }]}'],
])('a %s with sortable columns and no onSort', (tag, columns) => {
  it('sorts by a column when its header is pressed, and the other way when pressed again', () => {
    const { container, unmount } = page(`<${tag} data={people} ${columns} />`, { people: PEOPLE });
    expect(firstColumn(container)).toEqual(['bob', 'Ada', 'Émile', 'carl']);
    click(header(container, 'Name'));
    expect(firstColumn(container)).toEqual(['Ada', 'bob', 'carl', 'Émile']);
    expect(header(container, 'Name').closest('[aria-sort]')?.getAttribute('aria-sort')).toBe('ascending');
    click(header(container, 'Name'));
    expect(firstColumn(container)).toEqual(['Émile', 'carl', 'bob', 'Ada']);
    expect(header(container, 'Name').closest('[aria-sort]')?.getAttribute('aria-sort')).toBe('descending');
    unmount();
  });

  it('sorts numbers as numbers, keeping ties in their order, and dates as dates with empty ones last', () => {
    const { container, unmount } = page(`<${tag} data={people} ${columns} />`, { people: PEOPLE });
    click(header(container, 'Tasks'));
    expect(firstColumn(container)).toEqual(['Ada', 'carl', 'bob', 'Émile']);
    click(header(container, 'Joined'));
    expect(firstColumn(container)).toEqual(['Ada', 'Émile', 'bob', 'carl']);
    click(header(container, 'Joined'));
    expect(firstColumn(container)).toEqual(['bob', 'Émile', 'Ada', 'carl']);
    unmount();
  });

  it('starts sorted by the column the page names', () => {
    const sortProp = tag === 'Table' ? 'sortColumn' : 'sortKey';
    const { container, unmount } = page(`<${tag} data={people} ${columns} ${sortProp}="tasks" sortDirection="desc" />`, { people: PEOPLE });
    expect(firstColumn(container)).toEqual(['Émile', 'bob', 'Ada', 'carl']);
    unmount();
  });

  it('leaves the order to the page when it sorts the rows itself', () => {
    const sorted = vi.fn();
    const { container, unmount } = page(`<${tag} data={people} ${columns} @sort={sorted} />`, { people: PEOPLE }, { sorted });
    click(header(container, 'Name'));
    expect(sorted).toHaveBeenCalledWith('name', 'asc');
    expect(firstColumn(container)).toEqual(['bob', 'Ada', 'Émile', 'carl']);
    unmount();
  });
});

/**
 * Sorted by the component, the rows are drawn in an order the page never
 * sees. What the component tells the page about a row has to be in the page's
 * terms: an index into the list it gave, and for a grid row with no key
 * field, a key that is that index. Told the row's place on screen instead, a
 * page that wrote `rows[index]` opened, edited or removed another record.
 */
describe('a row sorted by the component is still the page’s row', () => {
  const ROWS = [{ name: 'bob' }, { name: 'Ada' }, { name: 'carl' }];
  const gridRows = (container: HTMLElement) =>
    Array.from(container.querySelectorAll<HTMLElement>('[role="row"][aria-rowindex]:not([aria-rowindex="1"])'));
  const selectedNames = (container: HTMLElement) =>
    gridRows(container).filter((row) => row.getAttribute('aria-selected') === 'true').map((row) => (row.textContent ?? '').trim());

  it('a Table tells a row click the row’s place in the list it was given', () => {
    const picked = vi.fn();
    const { container, unmount } = mount(
      <Table data={ROWS} columns={[{ key: 'name', header: 'Name', sortable: true }]} onRowClick={picked} />
    );
    click(header(container, 'Name'));
    expect(firstColumn(container)).toEqual(['Ada', 'bob', 'carl']);
    click(container.querySelector('tbody tr'));
    expect(picked).toHaveBeenLastCalledWith(ROWS[1], 1);
    click(header(container, 'Name'));
    expect(firstColumn(container)).toEqual(['carl', 'bob', 'Ada']);
    click(container.querySelector('tbody tr'));
    expect(picked).toHaveBeenLastCalledWith(ROWS[2], 2);
    unmount();
  });

  it('a Table hands a column’s render that place too', () => {
    const { container, unmount } = mount(
      <Table
        data={ROWS}
        columns={[
          { key: 'name', header: 'Name', sortable: true },
          { key: 'at', header: 'At', render: (_value, row, index) => `${row.name} is rows[${index}]` },
        ]}
      />
    );
    click(header(container, 'Name'));
    expect(Array.from(container.querySelectorAll('tbody tr td:last-child')).map((cell) => cell.textContent)).toEqual([
      'Ada is rows[1]',
      'bob is rows[0]',
      'carl is rows[2]',
    ]);
    unmount();
  });

  it('a DataGrid whose rows have no key field keeps a selection on the row it was made on', () => {
    const selections: Array<Set<string | number>> = [];
    const { container, unmount } = mount(
      <DataGrid
        virtualized={false}
        data={ROWS}
        columns={[{ key: 'name', header: 'Name', sortable: true }]}
        selectionMode="single"
        onSelectionChange={(keys) => selections.push(keys)}
      />
    );
    click(gridRows(container)[0]);
    expect(selectedNames(container)).toEqual(['bob']);
    click(header(container, 'Name'));
    expect(firstColumn(container)).toEqual(['Ada', 'bob', 'carl']);
    expect(selectedNames(container)).toEqual(['bob']);
    // The key the page is told is the row's place in the page's list.
    click(gridRows(container)[0]);
    expect(Array.from(selections[selections.length - 1])).toEqual([1]);
    unmount();
  });

  it('a DataGrid edit names the row that was edited', () => {
    const edited = vi.fn();
    const { container, unmount } = mount(
      <DataGrid
        virtualized={false}
        data={ROWS}
        columns={[
          {
            key: 'name',
            header: 'Name',
            sortable: true,
            editable: true,
            editor: ({ onSave }) => (
              <button type="button" data-save onClick={() => onSave('changed')}>
                save
              </button>
            ),
          },
        ]}
        onCellEdit={edited}
      />
    );
    click(header(container, 'Name'));
    const cell = gridRows(container)[0].querySelector('[role="cell"]')!;
    expect(cell.textContent).toBe('Ada');
    act(() => {
      cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    click(container.querySelector('[data-save]'));
    expect(edited).toHaveBeenCalledWith(1, 'name', 'changed');
    unmount();
  });

  it('follows the sort the page names when the page changes it, over a header pressed before', () => {
    const columns = [
      { key: 'name', header: 'Name', sortable: true },
      { key: 'n', header: 'N', sortable: true },
    ];
    const rows = [
      { name: 'bob', n: 1 },
      { name: 'Ada', n: 3 },
      { name: 'carl', n: 2 },
    ];
    const table = mount(<Table data={rows} columns={columns} sortColumn="n" />);
    expect(firstColumn(table.container)).toEqual(['bob', 'carl', 'Ada']);
    click(header(table.container, 'Name'));
    expect(firstColumn(table.container)).toEqual(['Ada', 'bob', 'carl']);
    // The same props again leave the person's own sort alone.
    table.rerender(<Table data={rows} columns={columns} sortColumn="n" />);
    expect(firstColumn(table.container)).toEqual(['Ada', 'bob', 'carl']);
    table.rerender(<Table data={rows} columns={columns} sortColumn="n" sortDirection="desc" />);
    expect(firstColumn(table.container)).toEqual(['Ada', 'carl', 'bob']);
    table.unmount();
  });

  it('does not sort the page’s own list', () => {
    const rows = [{ name: 'bob' }, { name: 'Ada' }];
    const { container, unmount } = mount(<Table data={rows} columns={[{ key: 'name', header: 'Name', sortable: true }]} />);
    click(header(container, 'Name'));
    expect(firstColumn(container)).toEqual(['Ada', 'bob']);
    expect(rows.map((row) => row.name)).toEqual(['bob', 'Ada']);
    unmount();
  });
});
