/**
 * Three more things drawn other than as they were meant, found by measuring
 * the components in Chromium from a page.
 *
 * A Drawer was not at the edge it names. Its style object set the named
 * side to 0 and then, a few keys later, the two sides across it to
 * `undefined`, and a later key wins: a right drawer had no `right`, and was
 * drawn wherever it sat in the page (at the left of its container on a wide
 * screen, with its close button off a phone's screen).
 *
 * A Slider's thumb lost its shadow while hovered, and a SmartStats icon its
 * tinted square for any colour but a six-digit hex: both wrote two hex
 * digits of alpha after a colour that may be `var(…)` or a name, which is no
 * colour at all once the variable is filled in.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { mount } from './dom';
import { Drawer } from '../src/feedback/Drawer';
import { Slider } from '../src/form/Slider';
import { SmartStats } from '../src/smart/SmartStats';
import { act } from 'react';

describe('a Drawer', () => {
  it.each([
    ['right', { right: '0px', top: '0px', bottom: '0px' }, 'left'],
    ['left', { left: '0px', top: '0px', bottom: '0px' }, 'right'],
    ['top', { top: '0px', left: '0px', right: '0px' }, 'bottom'],
    ['bottom', { bottom: '0px', left: '0px', right: '0px' }, 'top'],
  ] as const)('opened from the %s is held to that edge', (position, edges, across) => {
    const { unmount } = mount(
      <Drawer open onClose={() => {}} title="Filters" position={position}>
        <p>Body</p>
      </Drawer>
    );
    const panel = document.querySelector<HTMLElement>('[role="dialog"]')!;
    for (const [side, value] of Object.entries(edges)) expect(panel.style.getPropertyValue(side), side).toBe(value);
    expect(panel.style.getPropertyValue(across)).toBe('');
    unmount();
  });

  it('is never wider or taller than the screen it is on', () => {
    for (const position of ['right', 'bottom'] as const) {
      const { unmount } = mount(
        <Drawer open onClose={() => {}} title="Filters" position={position} size="900px">
          <p>Body</p>
        </Drawer>
      );
      const panel = document.querySelector<HTMLElement>('[role="dialog"]')!;
      if (position === 'right') expect(panel.style.maxWidth).toBe('100vw');
      else expect(panel.style.maxHeight).toBe('100vh');
      unmount();
    }
  });
});

/** Hex digits written straight after a colour that is a var() or a word: `var(--x, #fff)33`, `teal20`. */
const ALPHA_AFTER_A_NAME = /(\)|[a-z])[0-9a-f]{2}(?![0-9a-z(])/i;

describe('a colour given a transparency', () => {
  it('is mixed, not suffixed, for the Slider thumb while hovered', () => {
    const { container, unmount } = mount(<Slider value={40} ariaLabel="Volume" />);
    const thumb = container.querySelector<HTMLElement>('[role="slider"]')!;
    act(() => {
      thumb.parentElement!.parentElement!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    const shadow = thumb.style.boxShadow;
    expect(shadow).toContain('color-mix(');
    expect(shadow.replace(/#[0-9a-f]{3,8}/gi, '')).not.toMatch(ALPHA_AFTER_A_NAME);
    unmount();
  });

  it('is mixed, not suffixed, for a SmartStats icon in any colour', () => {
    const html = renderToStaticMarkup(
      <SmartStats
        stats={[
          { label: 'Revenue', value: 1200, icon: 'dollar', color: 'var(--color-success-500)' },
          { label: 'Users', value: 30, icon: 'users', color: 'teal' },
        ]}
      />
    );
    const squares = [...html.matchAll(/style="([^"]*border-radius:var\(--radius-md[^"]*)"/g)].map((m) => m[1]);
    expect(squares).toHaveLength(2);
    for (const style of squares) {
      const background = /background:([^;]*)/.exec(style)?.[1] ?? '';
      expect(background).toContain('color-mix(');
      expect(background.replace(/#[0-9a-f]{3,8}/gi, '')).not.toMatch(ALPHA_AFTER_A_NAME);
    }
  });
});
