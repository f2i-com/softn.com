/** @vitest-environment jsdom */
/**
 * Recent-project rows are real buttons, with removal and deletion apart.
 *
 * Each row was a click-handled div: no role, no tab stop, no Enter. Its
 * remove control was invisible until hovered and, through the persistence
 * layer, deleted the saved snapshot when the names matched. Pinned here: the
 * row that opens is a `button` that takes focus and activates (Enter and
 * Space on a button are the browser's own activation, which jsdom does not
 * synthesise, so activation is exercised through the click a real Enter
 * produces); remove is a separate labelled button that only calls remove;
 * delete asks first and offers an export; an entry with no saved copy says
 * so and does not open; a failed open lands in a live region.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dashboard, type RecentEntry } from '../src/components/layout/Dashboard';

const entries: RecentEntry[] = [
  { id: 'a', name: 'Alpha', target: 'web', lastModified: 'today', saved: true, active: false },
  { id: 'ghost', name: 'Ghost', target: 'web', lastModified: 'long ago', saved: false, active: false },
];

describe('Dashboard recent projects', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function mount(props: Partial<React.ComponentProps<typeof Dashboard>> = {}): void {
    root = createRoot(container);
    act(() => root.render(<Dashboard onNewProject={() => {}} recentProjects={entries} {...props} />));
  }

  async function flush(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('opens a project from a focused row button', async () => {
    const onOpenRecent = vi.fn(async () => ({ ok: true as const }));
    mount({ onOpenRecent });
    const row = container.querySelector<HTMLButtonElement>('button[aria-label="Open Alpha"]')!;
    expect(row.tagName).toBe('BUTTON');
    expect(row.closest('li')).not.toBeNull();
    row.focus();
    expect(document.activeElement).toBe(row);
    // Enter on a focused button: the browser turns it into a click.
    act(() => {
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      row.click();
    });
    await flush();
    expect(onOpenRecent).toHaveBeenCalledWith('a');
  });

  it('remove is its own labelled button and removes only from the list', () => {
    const onRemoveRecent = vi.fn();
    const onDeleteProject = vi.fn(async () => ({ ok: true as const }));
    mount({ onRemoveRecent, onDeleteProject });
    const remove = container.querySelector<HTMLButtonElement>('button[aria-label="Remove Alpha from the recent list"]')!;
    expect(remove).not.toBeNull();
    act(() => remove.click());
    expect(onRemoveRecent).toHaveBeenCalledWith('a');
    expect(onDeleteProject).not.toHaveBeenCalled();
  });

  it('delete asks first, offers an export, and only then deletes that project', async () => {
    const onDeleteProject = vi.fn(async () => ({ ok: true as const }));
    const onExportProject = vi.fn(async () => ({ ok: true as const }));
    mount({ onDeleteProject, onExportProject });
    const del = container.querySelector<HTMLButtonElement>('button[aria-label="Delete Alpha from this browser"]')!;
    act(() => del.click());
    expect(onDeleteProject).not.toHaveBeenCalled();
    const group = container.querySelector('[role="group"][aria-label="Delete Alpha"]')!;
    expect(group.textContent).toMatch(/Export a bundle first/);
    const buttons = Array.from(group.querySelectorAll('button'));
    act(() => buttons.find((b) => b.textContent === 'Export bundle first')!.click());
    await flush();
    expect(onExportProject).toHaveBeenCalledWith('a');
    act(() => buttons.find((b) => b.textContent === 'Delete project')!.click());
    await flush();
    expect(onDeleteProject).toHaveBeenCalledWith('a');
    expect(container.querySelector('[role="status"]')?.textContent).toMatch(/Deleted Alpha/);
  });

  it('an entry with no saved copy says so and does not open', async () => {
    const onOpenRecent = vi.fn(async () => ({ ok: true as const }));
    mount({ onOpenRecent });
    const row = container.querySelector<HTMLButtonElement>('button[aria-label="Open Ghost"]')!;
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.textContent).toMatch(/No saved copy/);
    act(() => row.click());
    await flush();
    expect(onOpenRecent).not.toHaveBeenCalled();
    expect(container.querySelector('button[aria-label="Delete Ghost from this browser"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Remove Ghost from the recent list"]')).not.toBeNull();
  });

  it('announces a failed open', async () => {
    const onOpenRecent = vi.fn(async () => ({ ok: false as const, message: 'the store is gone' }));
    mount({ onOpenRecent });
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Open Alpha"]')!.click());
    await flush();
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toMatch(/Could not open Alpha: the store is gone/);
  });
});
