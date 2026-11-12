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
import { openExampleInStores } from '../src/examples';
import { openImportedInStores } from '../src/lib/importedProject';

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
    const undo = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Undo last'))!;
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

  // Undo last and Revert AI changes had no way back: the store could redo, and nothing in
  // Studio asked it to. One press too many took an import, or everything a run had built,
  // and with the last unit gone the panel said "No changes yet".
  it('puts back with Redo what Undo last took, also when the undo left nothing to list', () => {
    store().applyTransaction(
      [
        { op: 'create', path: 'ui/main.ui', content: '<App/>' },
        { op: 'create', path: 'logic/main.logic', content: 'let x = 1' },
      ],
      'ai',
      'turn-1',
    );
    mount();
    const named = (name: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === name);
    expect(named('Redo')).toBeUndefined();

    act(() => named('Undo last')!.click());
    expect(store().files.size).toBe(0);
    expect(rows()).toHaveLength(0);

    act(() => named('Redo')!.click());
    expect(store().readFile('ui/main.ui')).toBe('<App/>');
    expect(store().readFile('logic/main.logic')).toBe('let x = 1');
    expect(rows()).toHaveLength(1);
    // Nothing more was undone, so there is nothing more to redo.
    expect(named('Redo')).toBeUndefined();
  });

  it('puts back with Redo, one turn at a time, what Revert AI changes took', () => {
    store().createFile('ui/main.ui', '<App/>');
    store().applyTransaction([{ op: 'update', path: 'ui/main.ui', content: '<App theme="dark"/>' }], 'ai', 'turn-1');
    store().applyTransaction([{ op: 'create', path: 'logic/main.logic', content: 'let x = 1' }], 'ai', 'turn-2');
    mount();
    const named = (name: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === name);
    act(() => named('Revert AI changes')!.click());
    expect(store().readFile('ui/main.ui')).toBe('<App/>');
    expect(store().files.has('logic/main.logic')).toBe(false);

    act(() => named('Redo')!.click());
    expect(store().readFile('ui/main.ui')).toBe('<App theme="dark"/>');
    expect(store().files.has('logic/main.logic')).toBe(false);
    act(() => named('Redo')!.click());
    expect(store().readFile('logic/main.logic')).toBe('let x = 1');
  });

  it('describes many files added in one step as one unit', () => {
    store().batchCreateFiles([
      { path: 'a.ui', content: 'a' },
      { path: 'b.ui', content: 'b' },
      { path: 'c.ui', content: 'c' },
      { path: 'd.ui', content: 'd' },
    ]);
    const [unit] = groupHistory(store().history);
    expect(describeUnit(unit)).toEqual({ title: 'Added · 4 files', detail: 'a.ui, b.ui, c.ui, +1 more' });
  });

  // What a person does in the Files panel is named in their words. A rename is a delete and
  // a create under one id, and was listed as "Edit · 2 files".
  it('shows a unit that says what it was under that name, with the files it touched', () => {
    store().createFile('assets/logo.png', new Uint8Array([1]));
    act(() => {
      store().applyTransaction(
        [{ op: 'delete', path: 'assets/logo.png' }, { op: 'create', path: 'assets/brand.png', content: new Uint8Array([1]) }],
        'user',
        'rename-1',
        'Renamed logo.png to brand.png',
      );
    });
    mount();
    const renamed = rows()[0];
    expect(renamed.querySelector('.st-history-title')!.textContent).toBe('Renamed logo.png to brand.png');
    expect(renamed.querySelector('.st-history-detail')!.textContent).toBe('assets/logo.png, assets/brand.png');
    expect(renamed.querySelector('button')!.getAttribute('aria-label')).toMatch(/^Revert Renamed logo\.png to brand\.png: /);
    // And it is one unit to Undo last.
    const undo = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Undo last')!;
    act(() => undo.click());
    expect(store().files.has('assets/logo.png')).toBe(true);
    expect(store().files.has('assets/brand.png')).toBe(false);
  });

  // Opening a project is not something a person did to it. An example and an import were
  // placed as one unit of the person's own creates, so on a project opened a moment ago
  // "Undo last" removed every file, and the canvas said "No app yet".
  describe('a project that was just opened', () => {
    const named = (name: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === name);

    it('an example has nothing to undo, and its first edit is the only unit', () => {
      const example = openExampleInStores();
      expect(example).toBeTruthy();
      const opened = store().files.size;
      expect(opened).toBeGreaterThan(0);
      expect(store().history).toEqual([]);
      expect(store().undoStack).toEqual([]);
      mount();
      expect(named('Undo last')).toBeUndefined();
      expect(named('Redo')).toBeUndefined();
      expect(container.textContent).toContain('No changes yet');
      expect(container.textContent).not.toMatch(/import/i);

      act(() => store().updateFile('manifest.json', '{"name":"Changed"}'));
      expect(rows()).toHaveLength(1);
      act(() => named('Undo last')!.click());
      // The edit is taken back; the project that was opened is all still there.
      expect(store().files.size).toBe(opened);
      expect(store().readFile('manifest.json')).not.toBe('{"name":"Changed"}');
      expect(named('Undo last')).toBeUndefined();
    });

    it('an import has nothing to undo either', () => {
      openImportedInStores('club.softn', [
        { path: 'manifest.json', content: '{"name":"Club","version":"1.0.0","main":"ui/main.ui"}' },
        { path: 'ui/main.ui', content: '<App><Text>Club</Text></App>' },
      ]);
      expect(store().files.has('ui/main.ui')).toBe(true);
      expect(store().history).toEqual([]);
      mount();
      expect(named('Undo last')).toBeUndefined();
      store().undoLast();
      expect(store().files.has('ui/main.ui')).toBe(true);
    });

    it('still refuses a path that is not a project path, and places nothing', () => {
      expect(() => store().openFiles([{ path: 'ui/main.ui', content: '<App/>' }, { path: '../outside.txt', content: 'x' }])).toThrow(/not a project path/);
      expect(() => store().openFiles([{ path: 'a/b.ui', content: '1' }, { path: 'A/B.ui', content: '2' }])).toThrow(/same file/);
      expect(store().files.size).toBe(0);
    });
  });
});
