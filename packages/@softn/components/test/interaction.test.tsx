/**
 * Interaction regressions across the widget set.
 *
 * These all leave the screen looking fine while the thing the user just did
 * has no effect — the failure mode that survives review longest.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mount, click, type } from './dom';
import { Input } from '../src/form/Input';
import { Drawer } from '../src/feedback/Drawer';
import { Modal } from '../src/feedback/Modal';
import { Select } from '../src/form/Select';
import { Button } from '../src/form/Button';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('Input clear button', () => {
  it('clears the text it is sitting next to', () => {
    // `internalValue` was never rendered — the DOM input read `value` /
    // `defaultValue` — so clearing changed only whether the ✕ was shown. The
    // text stayed on screen while the button that clears it disappeared.
    const { container } = mount(<Input clearable defaultValue="abc" />);
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('abc');

    const clear = Array.from(container.querySelectorAll('button')).find((b) =>
      /clear|✕|×/i.test(b.textContent ?? '') || /clear/i.test(b.getAttribute('aria-label') ?? '')
    );
    expect(clear, 'a clear button should render').toBeTruthy();
    click(clear);

    expect(input.value).toBe('');
  });

  it('keeps typed text visible when uncontrolled', () => {
    const { container } = mount(<Input clearable />);
    const input = container.querySelector('input') as HTMLInputElement;
    type(input, 'hello');
    expect(input.value).toBe('hello');
  });

  it('leaves a controlled input to its owner', () => {
    const seen: string[] = [];
    const { container } = mount(
      <Input clearable value="fixed" onChange={(e) => seen.push(e.target.value)} />
    );
    const input = container.querySelector('input') as HTMLInputElement;
    const clear = Array.from(container.querySelectorAll('button')).find((b) =>
      /clear|✕|×/i.test(b.textContent ?? '') || /clear/i.test(b.getAttribute('aria-label') ?? '')
    );
    click(clear);

    expect(seen).toEqual(['']);
    expect(input.value).toBe('fixed');
  });
});

describe('Drawer with the overlay turned off', () => {
  it('does not leave an invisible sheet over the page', () => {
    // The backdrop was still rendered at opacity 0 — fixed, inset 0,
    // z-index 1000, with a click handler — so the whole page behind became
    // unclickable with nothing on screen to explain it.
    const { container } = mount(
      <Drawer open onClose={() => {}} showOverlay={false} closeOnOverlay={false}>
        <p>content</p>
      </Drawer>
    );

    const covering = Array.from(container.querySelectorAll('div')).filter((el) => {
      const s = el.style;
      return s.position === 'fixed' && s.inset === '0' && s.opacity === '0';
    });
    expect(covering).toHaveLength(0);
  });

  it('still renders the overlay by default', () => {
    const { container } = mount(
      <Drawer open onClose={() => {}}>
        <p>content</p>
      </Drawer>
    );
    const overlays = Array.from(container.querySelectorAll('div')).filter(
      (el) => el.style.position === 'fixed' && el.style.inset === '0'
    );
    expect(overlays.length).toBeGreaterThan(0);
  });
});

describe('Modal focus', () => {
  it('moves focus into the dialog when it opens', () => {
    // The focus effect keyed on `isModalOpen`, but the dialog DOM is gated
    // behind `isVisible`, set by a different effect in the same commit — so
    // the ref was still null when .focus() ran, and the effect never re-ran.
    // With focus left outside, Tab walked the page behind the overlay.
    const { container } = mount(
      <Modal open onClose={() => {}}>
        <button type="button">Inside</button>
      </Modal>
    );

    const inside = container.querySelector('button') ?? document.querySelector('button');
    expect(inside, 'modal content should render').toBeTruthy();

    const active = document.activeElement;
    expect(active).not.toBe(document.body);
  });
});

describe('Select with search', () => {
  const options = [
    { value: 'a', label: 'Alpha' },
    { value: 'b', label: 'Beta' },
  ];

  it('selects on Enter after filtering', () => {
    // `onKeyDown` was attached only to the trigger, but opening focuses the
    // search input inside the dropdown — a sibling — so keystrokes never
    // reached the handler. Enter selected nothing, and inside a <form> it
    // submitted instead.
    const seen: string[] = [];
    const { container } = mount(
      <Select searchable options={options} onChange={(v) => seen.push(String(v))} />
    );

    const trigger = container.querySelector('[role=combobox]') ?? container.firstElementChild;
    click(trigger);

    // Not `querySelector('input')` — the first input in a Select is the hidden
    // one carrying the form value.
    const search = container.querySelector<HTMLInputElement>('input:not([type=hidden])');
    expect(search, 'search input should render when open').toBeTruthy();
    type(search as HTMLInputElement, 'Bet');

    (search as HTMLInputElement).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    );

    expect(seen).toEqual(['b']);
  });
});

describe('Button with a glyph for a label', () => {
  it('can be given an accessible name', () => {
    // A zoom control reading "+" announces as nothing useful, and there was no
    // prop that let a template say what the button does — `aria-label` passed
    // in was dropped on the floor along with every other unlisted prop.
    const { container } = mount(<Button ariaLabel="Zoom in">+</Button>);
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe('Zoom in');
  });

  it('also accepts the DOM attribute spelling', () => {
    const { container } = mount(<Button aria-label="Zoom out">-</Button>);
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe('Zoom out');
  });

  it('leaves the attribute off when no name was given', () => {
    const { container } = mount(<Button>Save</Button>);
    expect(container.querySelector('button')?.hasAttribute('aria-label')).toBe(false);
  });
});
