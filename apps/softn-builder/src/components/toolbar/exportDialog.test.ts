// @vitest-environment jsdom
/**
 * The export dialog is a dialog.
 *
 * Its overlay was a div with a click handler: no role, no name, no
 * aria-modal, Tab walked out of it into the toolbar behind, Escape was
 * handled by a window listener in App.tsx, and closing left focus on the
 * body rather than on the button that opened it. Pinned here in jsdom:
 * the semantics, Tab wrapping from the last control to the first (and
 * Shift+Tab the other way), Escape closing exactly once, and focus going
 * back to the trigger on close.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ExportDialog } from './ExportDialog';
import { useProjectStore } from '../../stores/projectStore';
import { useSchemaStore } from '../../stores/schemaStore';
import * as bundle from '../../utils/buildProjectBundle';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let trigger: HTMLButtonElement;
let root: Root;

function render(isOpen: boolean, onClose: () => void): void {
  act(() => {
    root.render(React.createElement(ExportDialog, { isOpen, onClose }));
  });
}

function key(target: Element, key: string, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  useProjectStore.getState().reset();
  useSchemaStore.getState().reset();
  trigger = document.createElement('button');
  trigger.textContent = 'Export';
  document.body.appendChild(trigger);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  trigger.focus();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  trigger.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the export dialog', () => {
  it('has dialog semantics and a name', () => {
    render(true, () => {});
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelledBy = dialog.getAttribute('aria-labelledby')!;
    expect(document.getElementById(labelledBy)?.textContent).toBe('Export Bundle');
    for (const id of ['export-app-name', 'export-app-version', 'export-app-description']) {
      expect(container.querySelector(`label[for="${id}"]`), id).not.toBeNull();
      expect(document.getElementById(id), id).not.toBeNull();
    }
  });

  it('moves focus in on open, wraps Tab at both ends, and never lets it leave', () => {
    render(true, () => {});
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.contains(document.activeElement)).toBe(true);

    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])')).filter(
      (el) => el.style.display !== 'none'
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    expect(first).not.toBe(last);

    last.focus();
    const tab = key(last, 'Tab');
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    const shiftTab = key(first, 'Tab', true);
    expect(shiftTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);

    // Trigger stays out of reach behind the dialog.
    expect(document.activeElement).not.toBe(trigger);
  });

  it('closes once on Escape, before any window-level handler sees it', () => {
    const onClose = vi.fn();
    const windowSaw = vi.fn();
    window.addEventListener('keydown', windowSaw);
    try {
      render(true, onClose);
      const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
      key(dialog, 'Escape');
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(windowSaw).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', windowSaw);
    }
  });

  it('gives focus back to the trigger when it closes', () => {
    render(true, () => {});
    expect(document.activeElement).not.toBe(trigger);
    render(false, () => {});
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('shows invalid collection data without crashing or offering a broken export', () => {
    vi.spyOn(bundle, 'gatherCollections').mockImplementation(() => {
      throw new Error('Collection "tasks" contains duplicate field "title".');
    });
    render(true, () => {});
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('duplicate field "title"');
    for (const label of ['Open in runtime…', 'Publish…', 'Export .softn']) {
      expect(Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.trim() === label)?.disabled).toBe(true);
    }
    expect(container.textContent).not.toContain('Checking…');
  });

  it('reports failed preflight checks and retries when the project details change', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const build = vi.spyOn(bundle, 'buildProjectBundle').mockRejectedValueOnce(new Error('The entry file is missing.'));
    render(true, () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('The entry file is missing.');
    expect(container.textContent).not.toContain('Checking…');

    act(() => useProjectStore.getState().setName('Recovered app'));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('Checking…');
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(build).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain('Checking…');
  });
});
