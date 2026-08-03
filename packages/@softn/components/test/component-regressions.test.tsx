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
import { Input } from '../src/form/Input';
import { TextArea } from '../src/form/TextArea';
import { Slider } from '../src/form/Slider';
import { List, ListItem } from '../src/data/List';
import { Box } from '../src/layout/Box';
import { Card } from '../src/layout/Card';
import { Modal } from '../src/feedback/Modal';

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
  document.body.style.overflow = '';
  vi.useRealTimers();
});

const mount = (node: React.ReactElement) => act(() => root.render(node));

describe('Select given a plain list of strings', () => {
  it('shows the options in the menu, not a column of blank rows', () => {
    // Only the lookup list was normalised; the list that got rendered was the
    // caller's array untouched. So the trigger showed the right label while
    // every row in the menu rendered `opt.label` of undefined — blank lines,
    // which look exactly like text the same colour as the background.
    mount(<Select options={['quiet', 'standard', 'storm'] as never} defaultValue="standard" />);
    const trigger = container.querySelector('[role=combobox]') ?? container.firstElementChild;
    act(() => { (trigger as HTMLElement).click(); });

    const text = container.textContent ?? '';
    expect(text).toContain('quiet');
    expect(text).toContain('storm');
  });

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

describe('Slider without a mouse', () => {
  it('is focusable and moves with the arrow keys', () => {
    const onChange = vi.fn();
    mount(<Slider value={50} min={0} max={100} step={5} onChange={onChange} />);

    const thumb = container.querySelector('[role="slider"]') as HTMLElement;
    expect(thumb).not.toBeNull();
    expect(thumb.getAttribute('tabindex')).toBe('0');
    expect(thumb.getAttribute('aria-valuenow')).toBe('50');

    act(() => {
      thumb.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith(55);

    act(() => {
      thumb.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith(0);
  });

  it('is not focusable when disabled', () => {
    mount(<Slider value={50} disabled onChange={() => {}} />);
    const thumb = container.querySelector('[role="slider"]') as HTMLElement;
    expect(thumb.getAttribute('tabindex')).toBe('-1');
  });
});

describe('a clickable List item', () => {
  it('can be activated from the keyboard', () => {
    const onClick = vi.fn();
    mount(
      <List>
        <ListItem onClick={onClick}>Pick me</ListItem>
      </List>
    );
    const item = container.querySelector('[role="button"]') as HTMLElement;
    expect(item).not.toBeNull();
    expect(item.getAttribute('tabindex')).toBe('0');

    act(() => {
      item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onClick).toHaveBeenCalled();
  });

  it('leaves a non-clickable item as a plain list item', () => {
    mount(
      <List>
        <ListItem>Just text</ListItem>
      </List>
    );
    expect(container.querySelector('[role="button"]')).toBeNull();
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

describe('form field labelling', () => {
  it('connects generated field ids to labels and helper text', () => {
    mount(
      <>
        <Input label="First name" helperText="As shown on your ID" />
        <Input label="Last name" helperText="As shown on your ID" />
        <TextArea label="Notes" error="Notes are required" />
      </>
    );

    const fields = Array.from(container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      'input:not([type="hidden"]), textarea'
    ));
    const labels = Array.from(container.querySelectorAll('label'));

    expect(fields).toHaveLength(3);
    expect(new Set(fields.map((field) => field.id)).size).toBe(3);
    expect(labels.map((label) => label.htmlFor)).toEqual(fields.map((field) => field.id));
    for (const field of fields) {
      const description = field.getAttribute('aria-describedby');
      expect(description).toBeTruthy();
      expect(document.getElementById(description!)).not.toBeNull();
    }
  });

  it('associates DatePicker labels and errors and names its clear control', () => {
    mount(
      <DatePicker
        label="Start date"
        value="2026-08-04"
        error="Choose a future date"
        onChange={() => {}}
      />
    );

    const field = container.querySelector('input') as HTMLInputElement;
    expect(container.querySelector('label')?.htmlFor).toBe(field.id);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(field.getAttribute('aria-describedby')!)).not.toBeNull();
    expect(container.querySelector('button[aria-label="Clear date"]')).not.toBeNull();
  });
});

describe('generic clickable containers', () => {
  it.each([
    ['Box', (onClick: () => void) => <Box onClick={onClick}>Open</Box>],
    ['Card', (onClick: () => void) => <Card onClick={onClick}>Open</Card>],
  ] as const)('%s activates with Enter and Space', (_name, renderControl) => {
    const onClick = vi.fn();
    mount(renderControl(onClick));
    const control = container.querySelector('[role="button"]') as HTMLElement;

    expect(control?.getAttribute('tabindex')).toBe('0');
    act(() => {
      control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      control.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('does not advertise a hover-only Card as a button', () => {
    mount(<Card hover>Preview</Card>);
    expect(container.firstElementChild?.hasAttribute('role')).toBe(false);
    expect(container.firstElementChild?.hasAttribute('tabindex')).toBe(false);
  });
});

describe('Modal body scroll lock', () => {
  it('restores the body overflow value that existed before opening', () => {
    document.body.style.overflow = 'scroll';
    mount(<Modal open disableAnimation onClose={() => {}}>Content</Modal>);
    expect(document.body.style.overflow).toBe('hidden');

    mount(<></>);
    expect(document.body.style.overflow).toBe('scroll');
  });

  it.each([
    ['first', ['second']],
    ['second', ['first']],
  ] as const)('keeps scrolling locked when the %s of two modals closes', (_closed, remaining) => {
    const renderModals = (ids: readonly string[]) => (
      <>
        {ids.map((id) => (
          <Modal key={id} open disableAnimation onClose={() => {}}>
            {id}
          </Modal>
        ))}
      </>
    );

    document.body.style.overflow = 'scroll';
    mount(renderModals(['first', 'second']));
    expect(document.body.style.overflow).toBe('hidden');

    mount(renderModals(remaining));
    expect(document.body.style.overflow).toBe('hidden');

    mount(<></>);
    expect(document.body.style.overflow).toBe('scroll');
  });
});
