/** @vitest-environment jsdom */
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FrameBar } from '../src/components/FrameBar';

let root: Root;
let container: HTMLDivElement;
const tab = { id: 'one', name: 'Fieldnotes', directorySlug: 'fieldnotes' };
const props = {
  tab,
  onHome: vi.fn(),
  onClose: vi.fn(),
  onHide: vi.fn(),
  onDownload: vi.fn(),
  fullscreenTarget: createRef<HTMLDivElement>(),
};
const key = (node: Element, name: string) =>
  act(() => node.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })));
const menuButton = () => container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('runtime frame controls', () => {
  it('moves focus into the menu, supports arrows and returns to the trigger on Escape', () => {
    act(() => root.render(<FrameBar {...props} />));
    act(() => menuButton().focus());
    key(menuButton(), 'ArrowDown');
    const items = [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(document.activeElement).toBe(items[0]);
    key(items[0], 'ArrowDown');
    expect(document.activeElement).toBe(items[1]);
    key(items[1], 'End');
    expect(document.activeElement).toBe(items[items.length - 1]);
    key(items[items.length - 1], 'Escape');
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(menuButton());
  });

  it('exposes a selectable share link when clipboard permission fails', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    act(() => root.render(<FrameBar {...props} />));
    act(() => menuButton().click());
    const copy = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Copy share link'
    )!;
    await act(async () => copy.click());
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Could not copy automatically'
    );
    expect(container.querySelector<HTMLInputElement>('[aria-label="Share link"]')?.value).toBe(
      `${location.origin}/app/fieldnotes`
    );
    expect(container.querySelector('[role="menu"]')).toBeTruthy();
  });

  it('resets menu state when the active app changes', () => {
    act(() => root.render(<FrameBar {...props} />));
    act(() => menuButton().click());
    act(() => root.render(<FrameBar {...props} tab={{ ...tab, id: 'two', name: 'Second app' }} />));
    expect(menuButton().getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  it('reports unavailable fullscreen without rejecting the event handler', async () => {
    act(() =>
      root.render(
        <div ref={props.fullscreenTarget}>
          <FrameBar {...props} />
        </div>
      )
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Fullscreen"]')!.click()
    );
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Fullscreen is unavailable'
    );
    expect(container.querySelector('[aria-label="Hide the app bar"]')).toBeTruthy();
  });
});
