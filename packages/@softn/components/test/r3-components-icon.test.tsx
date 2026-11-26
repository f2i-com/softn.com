/**
 * Audit round 3 (2026-11-27): an Icon drawn from markup a page gives it.
 *
 * Its own file, because it counts the calls into `@softn/core`'s sanitizer,
 * which takes replacing that module for the whole file.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type Mounted } from './dom';

const calls = vi.hoisted(() => ({ sanitizeSvg: 0 }));

vi.mock('@softn/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@softn/core')>();
  return {
    ...core,
    sanitizeSvg: (...args: Parameters<typeof core.sanitizeSvg>) => {
      calls.sanitizeSvg++;
      return core.sanitizeSvg(...args);
    },
  };
});

const { Icon } = await import('../src/display/Icon');

const mounted: Mounted[] = [];
afterEach(() => {
  for (const view of mounted.splice(0)) view.unmount();
  calls.sanitizeSvg = 0;
});

const MARK = '<svg viewBox="0 0 24 24"><path d="M4 12h16"/></svg>';

describe('an Icon drawn from markup', () => {
  it('cleans its markup once, not again on every draw of the page', () => {
    // Cleaning parses the markup, twice at least (until it reads back as
    // itself), and it was done on every draw: a list of custom icons parsed
    // all of them again whenever anything on the page changed.
    const view = mount(
      <div>
        {Array.from({ length: 20 }, (_, i) => (
          <Icon key={i} svg={MARK} size={16} />
        ))}
      </div>
    );
    mounted.push(view);
    const first = calls.sanitizeSvg;
    expect(first).toBe(20);
    for (let draw = 0; draw < 5; draw++) {
      view.rerender(
        <div data-draw={draw}>
          {Array.from({ length: 20 }, (_, i) => (
            <Icon key={i} svg={MARK} size={16} />
          ))}
        </div>
      );
    }
    expect(calls.sanitizeSvg).toBe(first);
    expect(view.container.querySelector('path')).not.toBeNull();
  });

  it('cleans new markup when it is given', () => {
    const view = mount(<Icon svg={MARK} />);
    mounted.push(view);
    view.rerender(<Icon svg={'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/></svg>'} />);
    expect(calls.sanitizeSvg).toBe(2);
    expect(view.container.querySelector('circle')).not.toBeNull();
    expect(view.container.querySelector('path')).toBeNull();
  });

  it('still takes out what is not inert', () => {
    const view = mount(<Icon svg={'<svg><path d="M0 0"/></svg><img src=x onerror="alert(1)">'} />);
    mounted.push(view);
    expect(view.container.querySelector('img')).toBeNull();
    expect(view.container.innerHTML).not.toContain('onerror');
  });
});
