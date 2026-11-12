// @vitest-environment jsdom
/**
 * A toast can carry its particulars. "Opened with 39 warning(s)" put the
 * warnings in the console alone, where nobody using the Builder looks; they
 * are behind a control of the message now, which stays until it is dismissed.
 * The control opens the panel above the status bar (components/StatusBar.tsx
 * draws this in its row, and StatusBar.test.ts has the rest of it).
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast, useNotificationStore } from '../../stores/notificationStore';
import { ToastContainer } from './ToastContainer';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  useNotificationStore.getState().clearAll();
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  act(() => root.render(React.createElement(ToastContainer)));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const lines = () => [...host.querySelectorAll('.bl-status-details li')].map((item) => item.textContent);

describe('a toast with particulars', () => {
  it('lists them behind a control, and stays until it is dismissed', () => {
    act(() => toast.warning('Opened with 2 warnings', ['ui/main.ui: an unknown prop', 'logic/main.logic: a stray brace']));
    const control = host.querySelector<HTMLButtonElement>('[data-toast-details]')!;
    expect(control.tagName).toBe('BUTTON');
    expect(control.textContent).toBe('Show all 2');
    expect(lines()).toEqual([]);
    act(() => control.click());
    expect(lines()).toEqual(['ui/main.ui: an unknown prop', 'logic/main.logic: a stray brace']);

    act(() => void vi.advanceTimersByTime(60_000));
    expect(host.querySelector('[data-toast-details]')).not.toBeNull();
    expect(lines()).toHaveLength(2);
    act(() => host.querySelector<HTMLButtonElement>('.bl-status-msg > button[aria-label^="Dismiss"]')!.click());
    expect(host.querySelector('[data-toast-details]')).toBeNull();
    expect(host.textContent).toBe('');
  });

  it('says "Show it" where there is one', () => {
    act(() => toast.warning('Opened with 1 warning', ['ui/main.ui: an unknown prop']));
    expect(host.querySelector('[data-toast-details]')!.textContent).toBe('Show it');
  });

  it('leaves a plain warning as it was: words alone, gone after a while', () => {
    act(() => toast.warning('Something to know'));
    expect(host.querySelector('[data-toast-details]')).toBeNull();
    expect(host.textContent).toContain('Something to know');
    act(() => void vi.advanceTimersByTime(5_000));
    expect(host.textContent).not.toContain('Something to know');
  });
});
