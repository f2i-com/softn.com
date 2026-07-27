/**
 * Components that track their own state alongside a callback.
 *
 * Each of these breaks for a caller who wants to *observe* what the component
 * does — passing a handler without also taking over the state — which is the
 * most natural way to reach for them.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { act } from 'react';
import { mount, click } from './dom';
import { TreeView } from '../src/data/TreeView';
import { Toast } from '../src/feedback/Toast';
import { AnimatedNumber } from '../src/animation/AnimatedNumber';

beforeEach(() => {
  document.body.innerHTML = '';
});

/**
 * The expand chevron. TreeView renders it as a span wrapping an svg, not a
 * button, so a role-based selector finds nothing.
 */
function expandToggle(container: HTMLElement): Element | null {
  return container.querySelector('span:has(> svg)') ?? container.querySelector('svg')?.parentElement ?? null;
}

const TREE = [
  { id: 'root', label: 'Root', children: [{ id: 'child', label: 'Child' }] },
];

describe('TreeView with onExpand but no expandedIds', () => {
  it('still expands', () => {
    // `handleExpand` treated the presence of `onExpand` as "the caller owns
    // expansion state" and stopped updating its own. A caller who only wanted
    // to observe expansion — logging, analytics — got a tree that could never
    // open, with the callback firing correctly each time.
    const seen: Array<[string, boolean]> = [];
    const { container } = mount(<TreeView nodes={TREE} onExpand={(id, e) => seen.push([id, e])} />);

    click(expandToggle(container));

    expect(seen).toEqual([['root', true]]);
    expect(container.textContent).toContain('Child');
  });

  it('leaves a caller that supplies expandedIds in control', () => {
    const { container } = mount(
      <TreeView nodes={TREE} expandedIds={new Set()} onExpand={() => {}} />
    );
    click(expandToggle(container));

    // The caller kept expandedIds empty, so nothing should have opened.
    expect(container.textContent).not.toContain('Child');
  });

  it('still expands with no callback at all', () => {
    const { container } = mount(<TreeView nodes={TREE} />);
    click(expandToggle(container));
    expect(container.textContent).toContain('Child');
  });
});

describe('Toast paused by hovering', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not lose the time spent hovering', () => {
    // On resume, the effect cleanup subtracted `Date.now() - startTime` from
    // the remaining time — but `startTime` was set before the pause, so the
    // whole hover was deducted *again*, on top of the deduction mouseenter had
    // already made. Hovering long enough closed the toast the moment the
    // pointer left: the exact opposite of pause-on-hover.
    const onClose = vi.fn();
    const { container } = mount(
      <Toast message="hi" isVisible duration={5000} pauseOnHover onClose={onClose} />
    );

    // React derives onMouseEnter/onMouseLeave from delegated mouseover /
    // mouseout, comparing relatedTarget to decide whether the pointer really
    // crossed the boundary — a bare `mouseenter` never reaches the handler.
    const toast = container.querySelector<HTMLElement>('[role=alert]');
    expect(toast, 'the toast should render').not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    act(() => {
      toast!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }));
    });

    // Hover for well over the remaining 4s.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(onClose, 'a paused toast must not close').not.toHaveBeenCalled();

    act(() => {
      toast!.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: null }));
    });

    // ~4s should remain. Anything less means the hover was charged against it.
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(onClose, 'closed too early after resuming').not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on time when never hovered', () => {
    const onClose = vi.fn();
    mount(<Toast message="hi" isVisible duration={2000} onClose={onClose} />);

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('AnimatedNumber interrupted mid-flight', () => {
  it('continues from what is on screen, not the last settled value', async () => {
    // `previousValueRef` was written only when an animation *completed*, so an
    // update arriving mid-animation restarted from the last finished value. A
    // live counter updating faster than the animation lasts snapped back
    // toward the old number on every tick and never settled.
    const { container, rerender } = mount(<AnimatedNumber value={0} duration={1000} />);
    const read = () => Number((container.textContent ?? '').replace(/[^0-9.-]/g, ''));

    rerender(<AnimatedNumber value={100} duration={1000} />);
    await new Promise((r) => setTimeout(r, 300));
    const partway = read();
    expect(partway, 'the first animation should have made progress').toBeGreaterThan(5);

    // A second update lands before the first finished.
    rerender(<AnimatedNumber value={200} duration={1000} />);
    await new Promise((r) => setTimeout(r, 80));
    const afterInterrupt = read();

    // Restarting from the last *completed* value (0) would drop it back to
    // roughly nothing; continuing from the display keeps it near `partway`.
    expect(afterInterrupt).toBeGreaterThan(partway * 0.6);
  });
});
