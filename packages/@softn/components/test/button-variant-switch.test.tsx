/**
 * A button that changes variant in place.
 *
 * A nav bar writes `variant={page === id ? "primary" : "ghost"}`, so the
 * button for the page just left goes from primary to ghost on one render. Its
 * transition was `all`: the background snapped (a gradient does not
 * interpolate) to the ghost's transparent while the text colour eased from
 * the primary's white — white text on a light page for the first frames,
 * measured in the runtime at 14 ms after the click. jsdom runs no
 * transitions, so this pins the two things the fix is made of: the colour is
 * the ghost's own token at once, and colour is not a transitioned property.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { Button } from '../src/form/Button';

beforeEach(() => {
  document.body.innerHTML = '';
});

/** The properties a `transition` value names. */
function transitioned(value: string): string[] {
  // Commas inside cubic-bezier(…) do not separate transitions.
  return value
    .split(/,(?![^(]*\))/)
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean);
}

describe('Button switching from primary to ghost', () => {
  it('takes the ghost colour in the same render, with nothing easing it from white', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(<Button variant="primary">Home</Button>));
    const button = container.querySelector('button')!;
    expect(button.style.color).toBe('var(--color-primary-text, #ffffff)');

    act(() => root.render(<Button variant="ghost">Home</Button>));
    expect(button.style.color).toBe('var(--btn-ghost-text, #d4d4d8)');
    expect(button.style.background).toBe('transparent');
    // The text and its background must change together, so neither `all`
    // nor `color` may be eased while the background snaps.
    const properties = transitioned(button.style.transition);
    expect(properties.length).toBeGreaterThan(0);
    expect(properties).not.toContain('all');
    expect(properties).not.toContain('color');
    expect(properties).not.toContain('background');
    act(() => root.unmount());
  });
});
