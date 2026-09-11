/** @vitest-environment jsdom */
/**
 * The phone's project menu exposes Run, Publish and Export bundle, and
 * Export stays open when Run is shut.
 *
 * The mobile editor never rendered the desktop TopBar, so on a phone there
 * was no way to run, publish or — the one that matters after a storage
 * failure — export the project. Pinned here: the trigger says it opens a
 * menu; the menu holds the three actions as menu items; with a
 * bundle-refused validator error Run and Publish are marked disabled and
 * Export is not; Escape closes the menu and returns focus to the trigger;
 * the status line carries the save state and the file/problem count.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MobileProjectMenu } from '../src/components/mobile/MobileProjectMenu';
import { useAIStore, useVFSStore, useWorkspaceStore } from '../src/stores';

describe('MobileProjectMenu', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    useWorkspaceStore.getState().reset();
    useVFSStore.getState().reset();
    useAIStore.getState().resetSession();
    useWorkspaceStore.setState({ projectName: 'Notes', projectId: 'p1' });
    useVFSStore.getState().createFile('ui/main.ui', '<Text>Hi</Text>');
    useVFSStore.getState().createFile('manifest.json', '{"name":"Notes"}');
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function mount(): void {
    root = createRoot(container);
    act(() => root.render(<MobileProjectMenu />));
  }

  function trigger(): HTMLButtonElement {
    return container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
  }

  it('offers Run, Publish and Export bundle as menu items', () => {
    mount();
    const button = trigger();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    act(() => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const menu = container.querySelector('[role="menu"]')!;
    expect(menu).not.toBeNull();
    expect(button.getAttribute('aria-controls')).toBe(menu.id);
    const labels = Array.from(menu.querySelectorAll('[role="menuitem"]')).map((el) => el.textContent?.trim());
    expect(labels).toEqual(['Run', 'Publish', 'Export bundle']);
    expect(menu.textContent).toMatch(/2 files · 0 problems/);
    expect(menu.querySelector('[data-save-state]')).not.toBeNull();
  });

  it('keeps Export bundle enabled while a bundle-refused error disables Run and Publish', () => {
    useWorkspaceStore.getState().addError({ file: 'manifest.json', level: 'error', type: 'bundle-refused', message: 'No main' });
    mount();
    act(() => trigger().click());
    const items = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    const byLabel = (label: string) => items.find((el) => el.textContent?.trim().startsWith(label))!;
    expect(byLabel('Run').getAttribute('aria-disabled')).toBe('true');
    expect(byLabel('Publish').getAttribute('aria-disabled')).toBe('true');
    expect(byLabel('Export bundle').getAttribute('aria-disabled')).toBeNull();
    expect(byLabel('Export bundle').hasAttribute('disabled')).toBe(false);
    expect(container.textContent).toMatch(/1 problem/);
  });

  it('focuses the first item when opened, and Escape closes it and returns focus to the trigger', () => {
    mount();
    const button = trigger();
    act(() => button.click());
    const first = container.querySelector<HTMLElement>('[role="menuitem"]')!;
    expect(document.activeElement).toBe(first);
    act(() => {
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    });
    expect(document.activeElement?.textContent?.trim()).toBe('Publish');
    act(() => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);
  });
});
