/**
 * @vitest-environment jsdom
 *
 * An app that is still opening after a while says so, and can be stopped.
 *
 * The opening screen was a spinner over "Opening …" for as long as the
 * download took to answer. With the connection gone nothing on it ever
 * changed, and nothing on it was a way out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SLOW_OPEN_MS, SlowOpen } from '../src/components/SlowOpen';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('the opening screen once the wait has gone on', () => {
  it('says nothing for a load that is over in ordinary time', () => {
    act(() => root.render(<SlowOpen onCancel={() => {}} />));
    expect(container.textContent).toBe('');
    act(() => {
      vi.advanceTimersByTime(SLOW_OPEN_MS - 1);
    });
    expect(container.textContent).toBe('');
    expect(container.querySelector('button')).toBeNull();
  });

  it('then says it is still waiting, and stops when asked', () => {
    const onCancel = vi.fn();
    act(() => root.render(<SlowOpen onCancel={onCancel} />));
    act(() => {
      vi.advanceTimersByTime(SLOW_OPEN_MS);
    });
    const notice = container.querySelector('[role="status"]');
    expect(notice?.textContent).toContain('taking longer than usual');
    const stop = container.querySelector('button');
    expect(stop?.textContent).toBe('Stop waiting');
    act(() => stop!.click());
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('is words alone where there is nothing to stop', () => {
    act(() => root.render(<SlowOpen afterMs={10} />));
    act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(container.textContent).toContain('taking longer than usual');
    expect(container.querySelector('button')).toBeNull();
  });

  it('does not appear after the screen it belongs to has gone', () => {
    act(() => root.render(<SlowOpen onCancel={() => {}} />));
    act(() => root.render(<span>open</span>));
    act(() => {
      vi.advanceTimersByTime(SLOW_OPEN_MS * 2);
    });
    expect(container.textContent).toBe('open');
  });
});
