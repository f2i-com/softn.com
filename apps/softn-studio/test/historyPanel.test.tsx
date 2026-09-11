/** @vitest-environment jsdom */
/**
 * The History panel shows undo units, not events.
 *
 * It listed one row per VFS event, so an AI turn that touched three files
 * was three rows, and an import of forty files was forty — while "Undo
 * Last" undid the whole unit, which the list did not say. Pinned here: one
 * AI turn touching three files is one row that names the turn and its
 * files; Undo Last takes the whole unit back; each unit with a transaction
 * id has its own Revert, which puts that unit back where nothing later
 * touched its files and is disabled, with the reason, where something did.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HistoryPanel, describeUnit, groupHistory } from '../src/components/panels/HistoryPanel';
import { useVFSStore } from '../src/stores/vfsStore';

const store = () => useVFSStore.getState();

describe('HistoryPanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    store().reset();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function mount(): void {
    root = createRoot(container);
    act(() => root.render(<HistoryPanel />));
  }

  const rows = () => Array.from(container.querySelectorAll<HTMLLIElement>('li[data-history-unit]'));

  it('renders one AI turn touching three files as one row', () => {
    store().createFile('ui/main.ui', '<App/>');
    act(() => {
      store().applyTransaction(
        [
          { op: 'update', path: 'ui/main.ui', content: '<App theme="dark"/>' },
          { op: 'create', path: 'ui/pages/home.ui', content: '<Text>Home</Text>' },
          { op: 'create', path: 'logic/main.logic', content: 'let x = 1' },
        ],
        'ai',
        'turn-1',
      );
    });
    mount();
    expect(store().history).toHaveLength(4);
    expect(rows()).toHaveLength(2);
    const turn = rows()[0];
    expect(turn.getAttribute('data-history-unit')).toBe('turn-1');
    expect(turn.textContent).toMatch(/AI turn · 3 files/);
    expect(turn.textContent).toContain('ui/main.ui');
    expect(turn.textContent).toContain('logic/main.logic');
  });

  it('Undo Last takes the whole unit back', () => {
    store().createFile('ui/main.ui', '<App/>');
    store().applyTransaction(
      [
        { op: 'update', path: 'ui/main.ui', content: '<App theme="dark"/>' },
        { op: 'create', path: 'ui/pages/home.ui', content: '<Text>Home</Text>' },
        { op: 'create', path: 'logic/main.logic', content: 'let x = 1' },
      ],
      'ai',
      'turn-1',
    );
    mount();
    const undo = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Undo Last'))!;
    act(() => undo.click());
    expect(store().readFile('ui/main.ui')).toBe('<App/>');
    expect(store().files.has('ui/pages/home.ui')).toBe(false);
    expect(store().files.has('logic/main.logic')).toBe(false);
    expect(rows()).toHaveLength(1);
  });

  it('a unit reverts on its own where nothing later touched its files, and says why where something did', () => {
    store().createFile('ui/main.ui', '<App/>');
    store().createFile('ui/other.ui', '<Text/>');
    store().applyTransaction([{ op: 'update', path: 'ui/main.ui', content: '<App theme="dark"/>' }], 'ai', 'turn-1');
    store().applyTransaction([{ op: 'update', path: 'ui/other.ui', content: '<Text>edited</Text>' }], 'ai', 'turn-2');
    // A later user edit on turn-2's file makes turn-2 unrevertible; turn-1 is untouched.
    store().updateFile('ui/other.ui', '<Text>user</Text>', 'user');
    mount();
    const units = groupHistory(store().history);
    // The two creates were edited later, so they are not revertible either.
    expect(units.map((u) => [u.transactionId, u.revertible])).toEqual([
      [expect.any(String), false],
      [expect.any(String), false],
      ['turn-1', true],
      ['turn-2', false],
      [expect.any(String), true],
    ]);

    const revert1 = container.querySelector<HTMLButtonElement>('li[data-history-unit="turn-1"] button')!;
    const revert2 = container.querySelector<HTMLButtonElement>('li[data-history-unit="turn-2"] button')!;
    expect(revert1.disabled).toBe(false);
    expect(revert2.disabled).toBe(true);
    expect(revert2.title).toMatch(/later change/);

    act(() => revert1.click());
    expect(store().readFile('ui/main.ui')).toBe('<App/>');
    expect(store().readFile('ui/other.ui')).toBe('<Text>user</Text>');
    expect(container.querySelector('[role="status"]')?.textContent).toMatch(/Reverted 1 file/);
    expect(container.querySelector('li[data-history-unit="turn-1"]')).toBeNull();
  });

  it('describes an import of many files as one import', () => {
    store().batchCreateFiles([
      { path: 'a.ui', content: 'a' },
      { path: 'b.ui', content: 'b' },
      { path: 'c.ui', content: 'c' },
      { path: 'd.ui', content: 'd' },
    ]);
    const [unit] = groupHistory(store().history);
    expect(describeUnit(unit)).toEqual({ title: 'Import · 4 files', detail: 'a.ui, b.ui, c.ui, +1 more' });
  });
});
