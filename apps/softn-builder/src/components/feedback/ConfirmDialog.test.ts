// @vitest-environment jsdom
/**
 * The Builder's yes-or-no question (utils/confirm.ts) answers what it was
 * asked, once, and only by the person.
 *
 * It replaces `window.confirm`, which in the desktop app Tauri's dialog
 * plugin makes async: it returned a Promise at once, every caller read the
 * Promise as a yes, and Open over unsaved work, New, deleting a file or a
 * collection and re-identifying records went ahead without asking.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ConfirmDialog } from './ConfirmDialog';
import { askConfirm, currentConfirm, useConfirmStore } from '../../utils/confirm';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let host: HTMLDivElement;
let root: Root | null = null;

function mount(): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(React.createElement(ConfirmDialog)));
}

const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
const button = (which: 'ok' | 'cancel') => document.querySelector<HTMLButtonElement>(`[data-confirm="${which}"]`)!;

/** Ask inside act, so the dialog renders before the test looks. */
function ask(message: string, options: Parameters<typeof askConfirm>[1] = {}): Promise<boolean> {
  let pending!: Promise<boolean>;
  act(() => {
    pending = askConfirm(message, options);
  });
  return pending;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  useConfirmStore.setState({ queue: [] });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  useConfirmStore.setState({ queue: [] });
});

describe('ConfirmDialog', () => {
  it('asks in the page, and the button that goes ahead is a yes', async () => {
    mount();
    expect(dialog()).toBeNull();
    const answer = ask('Open a new project? Unsaved changes will be lost.', { title: 'Unsaved changes', confirmLabel: 'Discard and open', danger: true });
    const shown = dialog()!;
    expect(shown.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(shown.getAttribute('aria-labelledby')!)!.textContent).toBe('Unsaved changes');
    expect(document.getElementById(shown.getAttribute('aria-describedby')!)!.textContent).toBe('Open a new project? Unsaved changes will be lost.');
    expect(button('ok').textContent).toBe('Discard and open');
    act(() => button('ok').click());
    await expect(answer).resolves.toBe(true);
    expect(dialog()).toBeNull();
    expect(useConfirmStore.getState().queue).toEqual([]);
  });

  it('Cancel, Escape and a click on the overlay are each a no', async () => {
    mount();
    const cancelled = ask('Delete file "a.ui"?');
    act(() => button('cancel').click());
    await expect(cancelled).resolves.toBe(false);

    const escaped = ask('Delete file "b.ui"?');
    act(() => {
      dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await expect(escaped).resolves.toBe(false);

    const outside = ask('Delete file "c.ui"?');
    act(() => {
      (dialog()!.parentElement as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await expect(outside).resolves.toBe(false);
    expect(dialog()).toBeNull();
  });

  it('starts on the way back when going on loses something, and on going on otherwise', () => {
    mount();
    void ask('Delete the collection "Tasks" and its records?', { danger: true });
    expect(document.activeElement).toBe(button('cancel'));
    act(() => button('cancel').click());
    void ask('Restore your work?');
    expect(document.activeElement).toBe(button('ok'));
  });

  it('a question asked before the dialog is there waits for it, and two are asked one after the other', async () => {
    // At startup the restore offer can be asked before the dialog mounts.
    const early = askConfirm('Restore the last locally saved builder session?');
    const second = askConfirm('Delete file "x.ui"?');
    expect(currentConfirm()?.message).toBe('Restore the last locally saved builder session?');
    mount();
    expect(dialog()!.textContent).toContain('Restore the last locally saved builder session?');
    act(() => button('ok').click());
    await expect(early).resolves.toBe(true);
    expect(dialog()!.textContent).toContain('Delete file "x.ui"?');
    act(() => button('cancel').click());
    await expect(second).resolves.toBe(false);
    expect(dialog()).toBeNull();
  });

  // The dialog gives the focus back to what had it. When that has gone (the file the
  // question was about, deleted on a yes), the focus fell to the page's body.
  describe('where the keyboard goes when what asked the question has gone', () => {
    const settle = () => act(async () => { await new Promise((done) => setTimeout(done, 5)); });
    let page: HTMLDivElement;

    beforeEach(() => {
      page = document.createElement('div');
      // A panel with a tree of rows in it, and the toolbar's view switch, as the workspace has them.
      page.innerHTML = `
        <div data-tool="views"><button aria-pressed="true" data-view>Design</button><button aria-pressed="false">Data</button></div>
        <div data-panel tabindex="-1">
          <div role="tree" aria-label="Project files">
            <div data-file-row="a" tabindex="0">a.ui</div>
            <div data-file-row="b" tabindex="-1">b.ui</div>
          </div>
          <button data-loose>Remove</button>
        </div>`;
      document.body.appendChild(page);
    });
    afterEach(() => page.remove());

    it('goes back to what asked, when that is still there', async () => {
      mount();
      const row = page.querySelector<HTMLElement>('[data-file-row="b"]')!;
      row.focus();
      void ask('Delete file "b.ui"?', { danger: true });
      act(() => button('cancel').click());
      await settle();
      expect(document.activeElement).toBe(row);
    });

    it('goes to the row that holds the tree’s stop when the row that asked is gone', async () => {
      mount();
      const row = page.querySelector<HTMLElement>('[data-file-row="b"]')!;
      row.focus();
      void ask('Delete file "b.ui"?', { danger: true });
      act(() => button('ok').click());
      row.remove();
      await settle();
      expect(document.activeElement).toBe(page.querySelector('[data-file-row="a"]'));
    });

    it('finds the tree again by its role and its name when it was drawn anew', async () => {
      mount();
      const tree = page.querySelector<HTMLElement>('[role="tree"]')!;
      page.querySelector<HTMLElement>('[data-file-row="b"]')!.focus();
      void ask('Delete file "b.ui"?', { danger: true });
      act(() => button('ok').click());
      // The Files tree is keyed by how many files there are: one fewer is a new tree.
      const again = document.createElement('div');
      again.setAttribute('role', 'tree');
      again.setAttribute('aria-label', 'Project files');
      again.innerHTML = '<div data-file-row="a" tabindex="0">a.ui</div>';
      tree.replaceWith(again);
      await settle();
      expect(document.activeElement).toBe(again.querySelector('[data-file-row="a"]'));
    });

    it('goes to the panel around a button that is gone, and to the view switch when nothing around it is left', async () => {
      mount();
      const loose = page.querySelector<HTMLElement>('[data-loose]')!;
      loose.focus();
      void ask('Remove it?');
      act(() => button('ok').click());
      loose.remove();
      await settle();
      expect(document.activeElement).toBe(page.querySelector('[data-panel]'));

      // Asked with the focus nowhere (a menu that closed before the question was put).
      (document.activeElement as HTMLElement).blur();
      expect(document.activeElement).toBe(document.body);
      void ask('Restore your work?');
      act(() => button('ok').click());
      await settle();
      expect(document.activeElement).toBe(page.querySelector('[data-view]'));
    });

    it('leaves the focus where a person or the next dialog has put it', async () => {
      mount();
      const loose = page.querySelector<HTMLElement>('[data-loose]')!;
      loose.focus();
      void ask('Remove it?');
      act(() => button('ok').click());
      loose.remove();
      const chosen = page.querySelector<HTMLElement>('[data-file-row="a"]')!;
      chosen.focus();
      await settle();
      expect(document.activeElement).toBe(chosen);
    });
  });

  it('an answer counts once', async () => {
    mount();
    const answer = ask('Delete folder "ui" and all its contents?');
    const ok = button('ok');
    act(() => {
      ok.click();
      ok.click();
    });
    await expect(answer).resolves.toBe(true);
    expect(useConfirmStore.getState().queue).toEqual([]);
  });
});
