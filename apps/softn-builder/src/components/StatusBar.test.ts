// @vitest-environment jsdom
/**
 * The messages are in the status bar. They floated over the bottom right of
 * the page, on top of the panels' controls; the bar shows the newest in its
 * own row now, and the rest, a long message's whole text and a message's
 * particulars are in a panel the person opens above it.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast, useNotificationStore } from '../stores/notificationStore';
import { showLabel } from './feedback/ToastContainer';
import { StatusBar } from './StatusBar';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let host: HTMLDivElement;
let root: Root;
const onShortcuts = vi.fn();

function draw(modalOpen = false) {
  act(() => root.render(React.createElement(StatusBar, { onShortcuts, modalOpen })));
}

/** The message the bar shows: the others are in the live region, not drawn. */
const shown = () => host.querySelector('.bl-status-said:not([data-older])');
const panel = () => host.querySelector<HTMLElement>('.bl-status-panel');
const hint = () => host.querySelector<HTMLButtonElement>('.bl-status-hint')!;
/** A button of the bar's own row, by what it says or is called. */
const inBar = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('.bl-status-msg > button')]
  .find((button) => button.textContent === name || button.getAttribute('aria-label') === name);
const press = (button: HTMLElement | null | undefined) => act(() => {
  button!.focus();
  button!.click();
});
const key = (name: string, init: KeyboardEventInit = {}) => act(() => {
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }));
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  onShortcuts.mockClear();
  useNotificationStore.getState().clearAll();
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  draw();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('a message in the status bar', () => {
  it('is in the bar itself, whose live region is in the page before any message is', () => {
    const live = host.querySelector('.bl-status [aria-live]')!;
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.children).toHaveLength(0);
    expect(host.querySelectorAll('.bl-status-msg > button')).toHaveLength(0);

    act(() => toast.success('Saved Field Notes'));
    expect(host.querySelector('.bl-status [aria-live]')).toBe(live);
    expect(shown()!.textContent).toBe('Saved Field Notes');
    expect(shown()!.parentElement).toBe(live);
    expect(shown()!.getAttribute('data-kind')).toBe('success');
    expect(shown()!.getAttribute('aria-atomic')).toBe('true');
  });

  it('is an alert when it is an error, and a status otherwise', () => {
    act(() => toast.info('Restored the previous ids of Task'));
    expect(shown()!.getAttribute('role')).toBe('status');
    act(() => toast.error('Could not read the icon'));
    expect(shown()!.textContent).toBe('Could not read the icon');
    expect(shown()!.getAttribute('role')).toBe('alert');
  });

  it('goes when its seconds are up, as it always did', () => {
    act(() => toast.success('Saved Field Notes'));
    act(() => void vi.advanceTimersByTime(3_100));
    expect(shown()).toBeNull();
    expect(host.querySelectorAll('.bl-status-msg > button')).toHaveLength(0);
  });

  it('is dismissed by its own button', () => {
    act(() => toast.error('Could not read the icon'));
    press(inBar('Dismiss error notification'));
    expect(shown()).toBeNull();
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });

  it('carries its action, which runs once and takes the message with it', () => {
    const reload = vi.fn();
    act(() => useNotificationStore.getState().addNotification({ type: 'info', message: 'Update ready', duration: 0, action: { label: 'Reload', onClick: reload } }));
    act(() => void vi.advanceTimersByTime(60_000));
    expect(shown()!.textContent).toBe('Update ready');
    press(inBar('Reload'));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(shown()).toBeNull();
  });
});

describe('several messages at once', () => {
  it('shows the newest and says how many more there are', () => {
    act(() => {
      toast.success('Exported field-notes.softn');
      toast.info('The local recovery copy could not be stored');
      toast.error('Could not save the recovery file');
    });
    expect(shown()!.textContent).toBe('Could not save the recovery file');
    // "+2" is what is drawn of it; the rest of its name is for a screen reader.
    const more = inBar('+2 more messages')!;
    expect(more.querySelector(':scope > :not(.bl-status-unseen)')!.textContent).toBe('+2');
    // Every one of them was said: all three are in the live region.
    expect([...host.querySelectorAll('[aria-live] > [role]')].map((said) => said.textContent)).toEqual([
      'Exported field-notes.softn', 'The local recovery copy could not be stored', 'Could not save the recovery file',
    ]);

    press(inBar('Dismiss error notification'));
    expect(shown()!.textContent).toBe('The local recovery copy could not be stored');
    expect(inBar('+1 more message')).toBeDefined();
    press(inBar('Dismiss info notification'));
    expect(shown()!.textContent).toBe('Exported field-notes.softn');
    expect(host.querySelector('[data-toast-others]')).toBeNull();
  });

  it('opens a panel with all of them, the newest first, each with its own dismiss and action', () => {
    const reload = vi.fn();
    act(() => {
      toast.warning('Opened with 2 warnings', ['ui/main.ui: an unknown prop', 'logic/main.logic: a stray brace']);
      useNotificationStore.getState().addNotification({ type: 'info', message: 'Update ready', duration: 0, action: { label: 'Reload', onClick: reload } });
      toast.error('Could not read the icon');
    });
    expect(panel()).toBeNull();
    const more = inBar('+2 more messages')!;
    expect(more.getAttribute('aria-expanded')).toBe('false');
    press(more);

    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(more.getAttribute('aria-controls')).toBe(panel()!.id);
    expect(document.activeElement).toBe(panel());
    const items = () => [...panel()!.querySelectorAll<HTMLElement>('.bl-status-item')];
    expect(items().map((item) => item.querySelector('.bl-status-item-text')!.firstChild!.textContent)).toEqual([
      'Could not read the icon', 'Update ready', 'Opened with 2 warnings',
    ]);
    expect([...items()[2].querySelectorAll('.bl-status-details li')].map((line) => line.textContent)).toEqual([
      'ui/main.ui: an unknown prop', 'logic/main.logic: a stray brace',
    ]);
    expect(panel()!.querySelector('.bl-eyebrow')!.textContent).toBe('3 messages');

    press(items()[1].querySelector<HTMLButtonElement>('.bl-status-btn'));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(items()).toHaveLength(2);
    press(items()[1].querySelector<HTMLButtonElement>('button[aria-label="Dismiss warning notification"]'));
    expect(items()).toHaveLength(1);
    expect(panel()!.querySelector('.bl-eyebrow')!.textContent).toBe('1 message');
    // The focus stayed in the panel, so the panel did not close under the person.
    expect(panel()!.contains(document.activeElement)).toBe(true);
    expect(useNotificationStore.getState().notifications.map((notif) => notif.message)).toEqual(['Could not read the icon']);

    // With the last one dismissed there is nothing to show, and no panel.
    press(items()[0].querySelector<HTMLButtonElement>('button[aria-label^="Dismiss"]'));
    expect(panel()).toBeNull();
    expect(shown()).toBeNull();
  });

  it('keeps in the open panel a message whose seconds run out while it is being read', () => {
    act(() => {
      toast.error('Could not save the recovery file. It is still stored here.');
      toast.info('Restored the previous ids of Task');
    });
    press(inBar('+1 more message'));
    act(() => void vi.advanceTimersByTime(10_000));
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
    expect([...panel()!.querySelectorAll('.bl-status-item-text')].map((item) => item.textContent)).toEqual([
      'Restored the previous ids of Task', 'Could not save the recovery file. It is still stored here.',
    ]);
    // A message that arrives meanwhile joins them.
    act(() => toast.success('Saved Field Notes'));
    expect(panel()!.querySelectorAll('.bl-status-item')).toHaveLength(3);
    expect(shown()!.textContent).toBe('Saved Field Notes');

    press(panel()!.querySelector<HTMLButtonElement>('.bl-mini'));
    expect(panel()).toBeNull();
    expect(shown()!.textContent).toBe('Saved Field Notes');
    expect(host.querySelector('[data-toast-others]')).toBeNull();
  });
});

describe('the panel above the bar', () => {
  beforeEach(() => {
    act(() => toast.warning('Opened with 2 warnings', ['ui/main.ui: an unknown prop', 'logic/main.logic: a stray brace']));
  });

  it('is opened by the person, and closed by the same control', () => {
    expect(panel()).toBeNull();
    press(inBar('Show all 2'));
    expect(panel()!.getAttribute('aria-label')).toBe('Messages');
    press(inBar('Show all 2'));
    expect(panel()).toBeNull();
  });

  it('closes on Escape, which goes no further, and the focus is back on what opened it', () => {
    const beyond = vi.fn();
    document.addEventListener('keydown', beyond, true);
    try {
      press(inBar('Show all 2'));
      key('Escape');
      expect(panel()).toBeNull();
      expect(document.activeElement).toBe(inBar('Show all 2'));
      // A dialog open under the panel listens on the document, and would have closed too.
      expect(beyond).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', beyond, true);
    }
  });

  it('closes on its Close button', () => {
    press(inBar('Show all 2'));
    press([...panel()!.querySelectorAll('button')].find((button) => button.textContent === 'Close'));
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(inBar('Show all 2'));
    // The message is not dismissed by closing the panel.
    expect(shown()!.textContent).toBe('Opened with 2 warnings');
  });

  it('closes when the focus leaves it for the page, and stays while the focus is on the message’s own buttons', () => {
    press(inBar('Show all 2'));
    act(() => inBar('Dismiss warning notification')!.focus());
    expect(panel()).not.toBeNull();
    act(() => hint().focus());
    expect(panel()).toBeNull();
  });

  it('closes on a press anywhere else', () => {
    press(inBar('Show all 2'));
    act(() => void panel()!.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(panel()).not.toBeNull();
    act(() => void document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(panel()).toBeNull();
  });
});

describe('a message too long for the bar', () => {
  it('says which control shows the rest', () => {
    expect(showLabel(undefined, false)).toBeNull();
    expect(showLabel(undefined, true)).toBe('Show it all');
    expect(showLabel(['one'], false)).toBe('Show it');
    expect(showLabel(['one', 'two'], true)).toBe('Show all 2');
  });

  it('has that control when the bar cut it short, and the panel has the whole of it', () => {
    // No layout here: the text is given a height past the two lines the bar shows.
    const whole = vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(51);
    const lines = vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(34);
    try {
      const long = 'The local recovery copy was kept without the project’s pictures and other assets (this browser’s storage is full); the file itself was exported.';
      act(() => toast.info(long));
      press(inBar('Show it all'));
      expect(panel()!.querySelector('.bl-status-item-text')!.textContent).toBe(long);
    } finally {
      whole.mockRestore();
      lines.mockRestore();
    }
  });

  it('has no such control when the bar shows all of it', () => {
    act(() => toast.info('Restored the previous ids of Task'));
    expect(host.querySelector('[data-toast-details]')).toBeNull();
  });
});

describe('the bar while a dialog is open', () => {
  it('keeps its own things out of reach, and the message in reach', () => {
    const reload = vi.fn();
    draw(true);
    expect(host.querySelector('.bl-status')!.hasAttribute('data-modal')).toBe(true);
    expect(hint().disabled).toBe(true);
    expect(hint().getAttribute('aria-hidden')).toBe('true');
    expect(host.querySelector('.bl-status-counts')!.getAttribute('aria-hidden')).toBe('true');
    press(hint());
    expect(onShortcuts).not.toHaveBeenCalled();

    act(() => useNotificationStore.getState().addNotification({ type: 'info', message: 'Update ready', duration: 0, action: { label: 'Reload', onClick: reload } }));
    act(() => toast.error('An icon is a PNG, JPEG, WebP or SVG.'));
    expect(shown()!.textContent).toBe('An icon is a PNG, JPEG, WebP or SVG.');
    expect(shown()!.closest('[aria-hidden], [inert]')).toBeNull();
    const dismiss = inBar('Dismiss error notification')!;
    expect(dismiss.disabled).toBe(false);
    expect(dismiss.closest('[aria-hidden], [inert]')).toBeNull();
    press(dismiss);
    expect(shown()!.textContent).toBe('Update ready');
    press(inBar('Reload'));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(shown()).toBeNull();
  });

  it('gives the hint back when the dialog closes', () => {
    draw(true);
    draw(false);
    expect(host.querySelector('.bl-status')!.hasAttribute('data-modal')).toBe(false);
    expect(hint().hasAttribute('aria-hidden')).toBe(false);
    press(hint());
    expect(onShortcuts).toHaveBeenCalledTimes(1);
  });

  it('makes the message’s buttons stops of the dialog’s round of Tab: after its last control and before its first', () => {
    const dialog = document.body.appendChild(document.createElement('div'));
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.innerHTML = '<button>Cancel</button><button>Export</button>';
    const [first, last] = [...dialog.querySelectorAll('button')];
    // The dialog's own listener (useModalFocus), which takes Tab back to the dialog.
    const trap = vi.fn();
    document.addEventListener('keydown', trap, true);
    try {
      draw(true);
      // With no message the round is the dialog's alone.
      act(() => last.focus());
      key('Tab');
      expect(trap).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(last);

      act(() => useNotificationStore.getState().addNotification({ type: 'info', message: 'Update ready', duration: 0, action: { label: 'Reload', onClick: () => {} } }));
      key('Tab');
      expect(document.activeElement).toBe(inBar('Reload'));
      act(() => first.focus());
      key('Tab', { shiftKey: true });
      expect(document.activeElement).toBe(inBar('Dismiss info notification'));
      expect(trap).toHaveBeenCalledTimes(1);

      // Anywhere else in the dialog, Tab is the dialog's as before.
      act(() => first.focus());
      key('Tab');
      expect(trap).toHaveBeenCalledTimes(2);
      expect(document.activeElement).toBe(first);
    } finally {
      document.removeEventListener('keydown', trap, true);
      dialog.remove();
    }
  });

  it('keeps Tab in the open panel from the dialog, which would take it back, until the last control', () => {
    const dialog = vi.fn();
    draw(true);
    act(() => toast.warning('Opened with 2 warnings', ['ui/main.ui: an unknown prop', 'logic/main.logic: a stray brace']));
    press(inBar('Show all 2'));
    document.addEventListener('keydown', dialog, true);
    try {
      key('Tab');
      expect(dialog).not.toHaveBeenCalled();
      const stops = [...host.querySelectorAll<HTMLButtonElement>('.bl-status-msg button')];
      act(() => stops[stops.length - 1].focus());
      key('Tab');
      expect(dialog).toHaveBeenCalledTimes(1);
      act(() => stops[0].focus());
      key('Tab', { shiftKey: true });
      expect(dialog).toHaveBeenCalledTimes(2);
    } finally {
      document.removeEventListener('keydown', dialog, true);
    }
  });
});
