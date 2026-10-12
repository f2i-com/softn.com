/**
 * The Share menu, where the browser has no share sheet of its own.
 *
 * Phones mostly have one and never see this menu; a desktop browser without
 * Web Share, or an app's built-in browser on a phone, does. Measured in
 * Chromium with `navigator.share` taken away:
 *
 * - at 320px the menu opened from x = -80 to 120: it hangs from the right
 *   edge of the Share button, the button sits at the left of its row on a
 *   phone, and "Copy link" was off the screen entirely;
 * - Escape closed the menu and left focus on nothing (the body), so a
 *   keyboard visitor lost their place on the page;
 * - the box said `role="menu"` over a button and nine links, none of them a
 *   menu item and none reachable by the arrow keys a menu promises.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ShareMenu } from '../src/components/directory/ShareMenu';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

const shareButton = () => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Share')!;

async function open(): Promise<HTMLElement> {
  await act(async () => {
    root.render(<ShareMenu url="/app/snake" title="Snake on SoftN" text="A small game." />);
  });
  shareButton().focus();
  await act(async () => {
    shareButton().click();
  });
  return container.querySelector<HTMLElement>('.popover')!;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('the Share menu without a system share sheet', () => {
  it('gives focus back to the Share button when Escape closes it', async () => {
    const menu = await open();
    const first = menu.querySelector<HTMLElement>('button, a')!;
    first.focus();
    expect(document.activeElement).toBe(first);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container.querySelector('.popover')).toBeNull();
    expect(document.activeElement).toBe(shareButton());
    expect(shareButton().getAttribute('aria-expanded')).toBe('false');
  });

  it('gives focus back when the menu closes itself after Copy link, and says when the copy was refused', async () => {
    vi.useFakeTimers();
    try {
      // jsdom has no clipboard, as a page served over plain http has none.
      const menu = await open();
      const copy = menu.querySelector<HTMLButtonElement>('button')!;
      copy.focus();
      await act(async () => {
        copy.click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(copy.textContent).toBe('Could not copy');
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(container.querySelector('.popover')).toBeNull();
      expect(document.activeElement).toBe(shareButton());
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves focus alone when a click elsewhere closes it', async () => {
    await open();
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    await act(async () => {
      elsewhere.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(container.querySelector('.popover')).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it('is a labelled group of links, not a menu with no menu items in it', async () => {
    const menu = await open();
    expect(menu.getAttribute('role')).toBe('group');
    expect(menu.getAttribute('aria-label')).toBe('Share this app');
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(shareButton().hasAttribute('aria-haspopup')).toBe(false);
    expect(shareButton().getAttribute('aria-expanded')).toBe('true');
    // Every way to share is a real control, reached with Tab like any other.
    expect(menu.querySelectorAll('a[href], button').length).toBe(10);
  });

  it('opens towards the side that has room for it', async () => {
    // What Chromium reports at 320px: hung from the button's right edge, the box starts 80px left of the screen.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const off = this.classList.contains('popover') && this.classList.contains('popover-right');
      return { left: off ? -80 : 20, right: off ? 120 : 220, top: 0, bottom: 100, width: 200, height: 100, x: off ? -80 : 20, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    const menu = await open();
    expect(menu.classList.contains('popover-left')).toBe(true);
    expect(menu.classList.contains('popover-right')).toBe(false);
  });
});
