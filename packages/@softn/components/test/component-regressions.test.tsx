/**
 * Regressions in the built-in components.
 *
 * Each of these was reproduced against the real component before it was fixed:
 * a control that threw on a shape the rest of the codebase accepts, a toast that
 * never left the screen, and a date field a parent could not clear.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { Select } from '../src/form/Select';
import { Toast } from '../src/feedback/Toast';
import { DatePicker } from '../src/form/DatePicker';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const mount = (node: React.ReactElement) => act(() => root.render(node));

describe('Select given a plain list of strings', () => {
  it('renders instead of throwing', () => {
    // `'options' in option` throws a TypeError on a primitive, and it ran inside
    // a useMemo on the render path — so this did not degrade, it replaced the
    // field with an error box permanently. SmartForm already accepts this shape.
    expect(() =>
      mount(<Select label="Colour" options={['red', 'green'] as never} />)
    ).not.toThrow();
  });

  it('still renders normal object options', () => {
    expect(() =>
      mount(<Select label="Colour" options={[{ value: 'r', label: 'Red' }]} />)
    ).not.toThrow();
  });
});

describe('Toast whose parent re-renders faster than its duration', () => {
  it('still closes', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();

    // A fresh arrow every render, which is what any inline handler is. Listing
    // onClose as an effect dependency restarted the countdown each time, so the
    // toast sat over the corner of the app for the rest of the session.
    function Parent({ tick }: { tick: number }) {
      return (
        <Toast message={`Saved ${tick}`} duration={1000} isVisible onClose={() => onClose()} />
      );
    }

    mount(<Parent tick={0} />);
    for (let i = 1; i <= 6; i++) {
      act(() => { vi.advanceTimersByTime(200); });
      mount(<Parent tick={i} />);
    }
    act(() => { vi.advanceTimersByTime(1200); });

    expect(onClose).toHaveBeenCalled();
  });
});

describe('DatePicker with a parent holding its value', () => {
  it('can be cleared by the parent', () => {
    mount(<DatePicker name="when" value="2024-01-15" onChange={() => {}} />);
    const input = () => container.querySelector('input') as HTMLInputElement;
    expect(input().value).not.toBe('');

    // The sync effect only copied `value` in when it parsed to a truthy date, so
    // a form reset left the old date on screen and in the submitted input.
    mount(<DatePicker name="when" value="" onChange={() => {}} />);
    expect(input().value).toBe('');
  });

  it('leaves an uncontrolled field alone', () => {
    expect(() => mount(<DatePicker name="when" />)).not.toThrow();
  });
});
