/**
 * Keyboard, focus and ARIA for the form controls.
 *
 * Each block pins one thing a keyboard or screen-reader user could not do
 * (or could not see) before, and the state it has to leave behind.
 */

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, mount, type } from './dom';
import { Button } from '../src/form/Button';
import { Select } from '../src/form/Select';
import { DatePicker } from '../src/form/DatePicker';
import { ColorPicker } from '../src/form/ColorPicker';
import { FileChooser } from '../src/form/FileChooser';
import { Switch } from '../src/form/Switch';
import { Checkbox } from '../src/form/Checkbox';
import { Radio } from '../src/form/Radio';
import { TextArea } from '../src/form/TextArea';
import { Input } from '../src/form/Input';
import { Slider } from '../src/form/Slider';

beforeEach(() => {
  document.body.innerHTML = '';
});

function key(el: Element | null | undefined, init: KeyboardEventInit): KeyboardEvent {
  if (!el) throw new Error('key: element not found');
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => {
    el.dispatchEvent(event);
  });
  return event;
}

function focus(el: HTMLElement | null | undefined): void {
  if (!el) throw new Error('focus: element not found');
  act(() => el.focus());
}

/** React warnings logged while `run` executes. */
function warningsDuring(run: () => void): string[] {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    run();
    return spy.mock.calls.map((args) => String(args[0]));
  } finally {
    spy.mockRestore();
  }
}

// --- Button ---------------------------------------------------------------------

describe('Button focus and loading', () => {
  it('leaves the outline to the focus-visible ring', () => {
    const { container } = mount(<Button>Save</Button>);
    const button = container.querySelector('button')!;
    // An inline `outline: none` beats the theme's `:focus-visible` rule.
    expect(button.style.outline).toBe('');
    expect(button.style.outlineStyle).toBe('');
  });

  it('stays focusable while loading, says it is busy and refuses the click', () => {
    const onClick = vi.fn();
    const { container, rerender } = mount(<Button onClick={onClick}>Save</Button>);
    const button = container.querySelector('button')!;
    focus(button);
    rerender(
      <Button onClick={onClick} loading>
        Save
      </Button>
    );
    expect(button.disabled).toBe(false);
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('does not submit its form while loading', () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    const { container } = mount(
      <form onSubmit={onSubmit}>
        <Button type="submit" loading>
          Send
        </Button>
      </form>
    );
    // A real click is cancelable; the harness's `click` is not.
    act(() => {
      container
        .querySelector('button')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

// --- Select ---------------------------------------------------------------------

describe('Select as a listbox', () => {
  const options = [
    { value: 'a', label: 'Alpha' },
    { value: 'b', label: 'Beta', disabled: true },
    { value: 'c', label: 'Gamma' },
    { value: 'd', label: 'Delta' },
  ];

  function setup(props: Partial<React.ComponentProps<typeof Select>> = {}) {
    const onChange = vi.fn();
    const view = mount(<Select label="Letter" options={options} onChange={onChange} {...props} />);
    const trigger = view.container.querySelector<HTMLElement>('[role=combobox]')!;
    return { ...view, trigger, onChange };
  }

  const active = (trigger: HTMLElement) =>
    document.getElementById(trigger.getAttribute('aria-activedescendant') ?? '');

  it('is named by its label and exposes a listbox of options', () => {
    const { container, trigger } = setup({ defaultValue: 'c' });
    const label = container.querySelector('label')!;
    expect(trigger.getAttribute('aria-labelledby')).toBe(label.id);
    focus(trigger);
    key(trigger, { key: 'ArrowDown' });
    const listbox = container.querySelector('[role=listbox]')!;
    expect(listbox).not.toBeNull();
    expect(trigger.getAttribute('aria-controls')).toBe(listbox.id);
    const opts = Array.from(listbox.querySelectorAll('[role=option]'));
    expect(opts).toHaveLength(4);
    expect(new Set(opts.map((o) => o.id)).size).toBe(4);
    expect(opts.map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true', 'false']);
    expect(opts[1].getAttribute('aria-disabled')).toBe('true');
    // Opening highlights the selected option, not the first.
    expect(active(trigger)?.textContent).toContain('Gamma');
  });

  it('skips disabled options with the arrows and moves to the ends with Home and End', () => {
    const { trigger } = setup();
    focus(trigger);
    key(trigger, { key: 'ArrowDown' });
    expect(active(trigger)?.textContent).toContain('Alpha');
    key(trigger, { key: 'ArrowDown' });
    expect(active(trigger)?.textContent).toContain('Gamma');
    key(trigger, { key: 'End' });
    expect(active(trigger)?.textContent).toContain('Delta');
    key(trigger, { key: 'Home' });
    expect(active(trigger)?.textContent).toContain('Alpha');
  });

  it('never selects a disabled option from the keyboard', () => {
    const disabledFirst = [{ value: 'x', label: 'X', disabled: true }, { value: 'y', label: 'Y' }];
    const { trigger, onChange } = setup({ options: disabledFirst });
    focus(trigger);
    key(trigger, { key: 'ArrowDown' });
    expect(active(trigger)?.textContent).toContain('Y');
    key(trigger, { key: 'ArrowUp' });
    key(trigger, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('y');
    expect(onChange).not.toHaveBeenCalledWith('x');
  });

  it('selects with Enter and puts focus back on the trigger', () => {
    const { trigger, onChange, container } = setup({ searchable: true });
    focus(trigger);
    key(trigger, { key: 'Enter' });
    const search = container.querySelector<HTMLInputElement>('input:not([type=hidden])')!;
    expect(document.activeElement).toBe(search);
    key(search, { key: 'ArrowDown' });
    key(search, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('c');
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on Escape without letting a surrounding dialog see it, and returns focus', () => {
    const outer = vi.fn();
    const onEscape = (e: KeyboardEvent) => e.key === 'Escape' && outer();
    document.addEventListener('keydown', onEscape);
    try {
      const { trigger } = setup({ searchable: true });
      focus(trigger);
      key(trigger, { key: 'Enter' });
      key(document.activeElement, { key: 'Escape' });
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(trigger);
      expect(outer).not.toHaveBeenCalled();
      // Closed, Escape is the dialog's again.
      key(trigger, { key: 'Escape' });
      expect(outer).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', onEscape);
    }
  });

  it('opens with Space and ArrowUp as well', () => {
    const { trigger } = setup();
    focus(trigger);
    key(trigger, { key: ' ' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    key(trigger, { key: 'Escape' });
    key(trigger, { key: 'ArrowUp' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('jumps to an option by typing its first letter', () => {
    const { trigger } = setup();
    focus(trigger);
    key(trigger, { key: 'd' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(active(trigger)?.textContent).toContain('Delta');
  });

  it('cannot be opened from the keyboard when disabled', () => {
    const { trigger } = setup({ disabled: true });
    key(trigger, { key: 'Enter' });
    key(trigger, { key: 'ArrowDown' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('describes its error and requirement', () => {
    const { trigger, container } = setup({ error: 'Pick one', required: true });
    expect(trigger.getAttribute('aria-invalid')).toBe('true');
    expect(trigger.getAttribute('aria-required')).toBe('true');
    expect(document.getElementById(trigger.getAttribute('aria-describedby')!)?.textContent).toBe('Pick one');
    expect(container.querySelector('label span')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('clears from a named clear button whose Enter clears rather than opens', () => {
    const { trigger, onChange, container } = setup({ defaultValue: 'a', clearable: true });
    const clear = container.querySelector<HTMLButtonElement>('button[aria-label="Clear selection"]')!;
    expect(clear).not.toBeNull();
    const enter = key(clear, { key: 'Enter' });
    expect(enter.defaultPrevented).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    click(clear);
    expect(onChange).toHaveBeenLastCalledWith('');
    expect(document.activeElement).toBe(trigger);
  });

  it('gives the create button a type, so it does not submit a form', () => {
    const { container, trigger } = setup({ searchable: true, onCreate: () => {} });
    focus(trigger);
    key(trigger, { key: 'Enter' });
    type(container.querySelector<HTMLInputElement>('input:not([type=hidden])'), 'Zeta');
    const create = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Zeta'));
    expect(create?.getAttribute('type')).toBe('button');
  });

  it('reports blur when focus leaves while the list is open', () => {
    const onBlur = vi.fn();
    const { trigger } = setup({ onBlur });
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    focus(trigger);
    key(trigger, { key: 'ArrowDown' });
    focus(outside);
    expect(onBlur).toHaveBeenCalledTimes(1);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows a value the options do not list as itself, not as the placeholder', () => {
    const { trigger } = setup({ value: 'zz', placeholder: 'Choose' });
    expect(trigger.textContent).toContain('zz');
  });

  it('marks a multi-select listbox as multiselectable', () => {
    const { trigger, container } = setup({ multiple: true, defaultValue: ['a', 'd'] });
    focus(trigger);
    key(trigger, { key: 'ArrowDown' });
    expect(container.querySelector('[role=listbox]')?.getAttribute('aria-multiselectable')).toBe('true');
    const selected = Array.from(container.querySelectorAll('[role=option][aria-selected=true]'));
    expect(selected.map((o) => o.textContent)).toEqual(['Alpha', 'Delta']);
  });
});

// --- DatePicker -------------------------------------------------------------------

describe('DatePicker dates', () => {
  const originalTz = process.env.TZ;
  beforeEach(() => {
    // West of Greenwich, where `new Date('2024-01-15')` is the 14th.
    process.env.TZ = 'America/New_York';
  });
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('shows a YYYY-MM-DD value as that day in any time zone', () => {
    const { container } = mount(<DatePicker value="2024-01-15" onChange={() => {}} />);
    expect(container.querySelector('input')!.value).toBe('2024-01-15');
  });

  it('hands back the day that was picked, not the day before', () => {
    const onChange = vi.fn();
    const { container } = mount(<DatePicker defaultValue="2024-01-15" onChange={onChange} />);
    const input = container.querySelector('input')!;
    focus(input);
    key(input, { key: 'Enter' });
    key(document.activeElement, { key: 'Enter' });
    expect(onChange.mock.calls[0][1]).toBe('2024-01-15');
  });
});

describe('DatePicker from the keyboard', () => {
  function open(props: Partial<React.ComponentProps<typeof DatePicker>> = {}) {
    const onChange = vi.fn();
    const view = mount(<DatePicker label="Start" defaultValue="2024-03-15" onChange={onChange} {...props} />);
    const input = view.container.querySelector('input')!;
    focus(input);
    key(input, { key: 'Enter' });
    return { ...view, input, onChange };
  }

  it('opens a calendar dialog from the field and focuses the selected day', () => {
    const { input, container } = open();
    const dialog = container.querySelector('[role=dialog]')!;
    expect(dialog).not.toBeNull();
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-controls')).toBe(dialog.id);
    expect(input.getAttribute('aria-haspopup')).toBe('dialog');
    const day = document.activeElement as HTMLElement;
    expect(day.getAttribute('aria-label')).toBe('Friday 15 March 2024');
    expect(day.getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('[role=grid]')).not.toBeNull();
  });

  it('moves through the grid with arrows, Home, End and the page keys', () => {
    const { container } = open();
    key(document.activeElement, { key: 'ArrowRight' });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Saturday 16 March 2024');
    key(document.activeElement, { key: 'ArrowDown' });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Saturday 23 March 2024');
    key(document.activeElement, { key: 'Home' });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Sunday 17 March 2024');
    key(document.activeElement, { key: 'End' });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Saturday 23 March 2024');
    key(document.activeElement, { key: 'PageDown' });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Tuesday 23 April 2024');
    expect(container.textContent).toContain('April 2024');
    key(document.activeElement, { key: 'PageUp', shiftKey: true });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Sunday 23 April 2023');
    // Only one day is a tab stop.
    expect(container.querySelectorAll('[role=gridcell][tabindex="0"]')).toHaveLength(1);
  });

  it('closes on Escape, returns focus to the field and keeps the Escape to itself', () => {
    const outer = vi.fn();
    const onEscape = (e: KeyboardEvent) => e.key === 'Escape' && outer();
    document.addEventListener('keydown', onEscape);
    try {
      const { input, container } = open();
      key(document.activeElement, { key: 'Escape' });
      expect(container.querySelector('[role=dialog]')).toBeNull();
      expect(document.activeElement).toBe(input);
      expect(outer).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', onEscape);
    }
  });

  it('names its navigation buttons and marks today', () => {
    const { container } = open({ defaultValue: undefined });
    for (const name of ['Previous year', 'Previous month', 'Next month', 'Next year']) {
      expect(container.querySelector(`button[aria-label="${name}"]`), name).not.toBeNull();
    }
    expect(container.querySelectorAll('[aria-current="date"]')).toHaveLength(1);
  });

  it('does not select a day outside min and max', () => {
    const { onChange } = open({ min: '2024-03-15', max: '2024-03-15' });
    key(document.activeElement, { key: 'ArrowRight' });
    expect(document.activeElement?.getAttribute('aria-disabled')).toBe('true');
    key(document.activeElement, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('DatePicker as a form field', () => {
  it('stops a form submitting while a required date is empty', () => {
    const { container, rerender } = mount(
      <form>
        <DatePicker name="when" required />
      </form>
    );
    const form = container.querySelector('form')!;
    expect(container.querySelector('input')!.getAttribute('aria-required')).toBe('true');
    expect(form.checkValidity()).toBe(false);
    rerender(
      <form>
        <DatePicker name="when" required value="2024-05-01" onChange={() => {}} />
      </form>
    );
    expect(form.checkValidity()).toBe(true);
  });

  it('leaves a controlled date alone when its clear button is pressed', () => {
    const onChange = vi.fn();
    const { container } = mount(<DatePicker value="2024-05-01" onChange={onChange} />);
    click(container.querySelector('button[aria-label="Clear date"]'));
    expect(onChange).toHaveBeenCalledWith(null, '');
    expect(container.querySelector('input')!.value).toBe('2024-05-01');
  });
});

// --- ColorPicker ------------------------------------------------------------------

describe('ColorPicker', () => {
  it('opens from a real button and closes on Escape with focus back on it', () => {
    const { container } = mount(<ColorPicker label="Brand" />);
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!;
    expect(trigger).not.toBeNull();
    expect(trigger.getAttribute('aria-labelledby')).toContain(container.querySelector('label')!.id);
    focus(trigger);
    click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const swatch = container.querySelector<HTMLButtonElement>('[role=dialog] button')!;
    focus(swatch);
    key(swatch, { key: 'Escape' });
    expect(container.querySelector('[role=dialog]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps its form value in the form while the palette is closed', () => {
    const { container } = mount(<ColorPicker name="brand" defaultValue="#112233" />);
    const hidden = container.querySelector<HTMLInputElement>('input[type=hidden][name=brand]');
    expect(hidden?.value).toBe('#112233');
  });

  it('marks the selected swatch pressed and names the rest', () => {
    const { container } = mount(<ColorPicker defaultValue="#ff0000" presets={['#ff0000', '#00ff00']} />);
    click(container.querySelector('button[aria-haspopup="dialog"]'));
    const swatches = Array.from(container.querySelectorAll('[role=dialog] [aria-pressed]'));
    expect(swatches.map((s) => s.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    expect(swatches[1].getAttribute('aria-label')).toBe('#00ff00');
    // Unselected swatches keep their outline for the focus ring.
    expect((swatches[1] as HTMLElement).style.outline).toBe('');
  });

  it('lets a controlling parent refuse a colour', () => {
    const { container } = mount(<ColorPicker value="#ff0000" presets={['#ff0000', '#00ff00']} onChange={() => {}} />);
    click(container.querySelector('button[aria-haspopup="dialog"]'));
    click(container.querySelector('[role=dialog] button[aria-label="#00ff00"]'));
    expect(container.querySelector<HTMLInputElement>('input[type=hidden]')!.value).toBe('#FF0000');
  });
});

// --- FileChooser ------------------------------------------------------------------

function dragEvent(type: string, init: { files?: File[]; relatedTarget?: EventTarget | null } = {}): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, relatedTarget: init.relatedTarget ?? null });
  Object.defineProperty(event, 'dataTransfer', { value: { files: init.files ?? [] } });
  return event;
}

describe('FileChooser drop zone', () => {
  it('can be operated from the keyboard through a real button', () => {
    const { container } = mount(<FileChooser variant="dropzone" label="Upload" />);
    const button = container.querySelector('button')!;
    expect(button.textContent).toBe('Upload');
    expect(document.getElementById(button.getAttribute('aria-describedby')!)).not.toBeNull();
    const input = container.querySelector<HTMLInputElement>('input[type=file]')!;
    const picker = vi.spyOn(input, 'click').mockImplementation(() => {});
    click(button);
    expect(picker).toHaveBeenCalledTimes(1);
  });

  it('keeps the drop state while the pointer crosses its own children', () => {
    const { container } = mount(<FileChooser variant="dropzone" label="Upload" />);
    const zone = container.querySelector('input[type=file]')!.nextElementSibling as HTMLElement;
    act(() => {
      zone.dispatchEvent(dragEvent('dragover'));
    });
    expect(zone.textContent).toContain('Drop files here');
    act(() => {
      zone.dispatchEvent(dragEvent('dragleave', { relatedTarget: zone.querySelector('svg') }));
    });
    expect(zone.textContent).toContain('Drop files here');
    act(() => {
      zone.dispatchEvent(dragEvent('dragleave', { relatedTarget: document.body }));
    });
    expect(zone.textContent).not.toContain('Drop files here');
  });

  it('takes only the dropped files `accept` admits, and says so', () => {
    const onSelect = vi.fn();
    const { container } = mount(
      <FileChooser variant="dropzone" accept="image/*,.pdf" multiple onSelect={onSelect} className="drop" />
    );
    expect(container.firstElementChild?.className).toBe('drop');
    const zone = container.querySelector('input[type=file]')!.nextElementSibling as HTMLElement;
    const files = [
      new File(['a'], 'a.png', { type: 'image/png' }),
      new File(['b'], 'b.exe', { type: 'application/x-msdownload' }),
      new File(['c'], 'C.PDF', { type: '' }),
    ];
    act(() => {
      zone.dispatchEvent(dragEvent('drop', { files }));
    });
    expect(onSelect.mock.calls[0][0].map((f: { name: string }) => f.name)).toEqual(['a.png', 'C.PDF']);
    expect(container.querySelector('[role=status]')?.textContent).toContain('1 file was not an accepted type');
  });
});

// --- Switch, Checkbox, Radio --------------------------------------------------------

describe('Switch', () => {
  it('is a switch, described by its description, with a solid focus ring on the track', () => {
    const { container } = mount(<Switch label="Wi-Fi" description="Join known networks" />);
    const input = container.querySelector('input')!;
    expect(input.getAttribute('role')).toBe('switch');
    expect(input.getAttribute('aria-checked')).toBe('false');
    expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toBe('Join known networks');
    focus(input);
    const track = input.nextElementSibling as HTMLElement;
    expect(track.style.boxShadow).toContain('var(--color-primary-500');
    click(input);
    expect(input.getAttribute('aria-checked')).toBe('true');
  });

  it('draws a white thumb, not a light grey one', () => {
    const { container } = mount(<Switch />);
    const thumb = container.querySelector('input')!.nextElementSibling!.firstElementChild as HTMLElement;
    expect(thumb.style.background).toContain('--color-white');
  });
});

describe('Checkbox', () => {
  it('shows keyboard focus with a solid ring, even when checked', () => {
    const { container } = mount(<Checkbox label="Agree" defaultChecked description="Required" error />);
    const input = container.querySelector('input')!;
    focus(input);
    const box = input.nextElementSibling as HTMLElement;
    expect(box.style.boxShadow).toContain('var(--color-primary-500');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toBe('Required');
  });
});

describe('Radio', () => {
  it('is a labelled radiogroup that reports its error', () => {
    const { container } = mount(
      <Radio name="size" label="Size" error="Pick a size" options={[{ value: 's', label: 'Small' }]} />
    );
    const group = container.querySelector('[role=radiogroup]')!;
    expect(document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent).toBe('Size');
    expect(group.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(group.getAttribute('aria-describedby')!)?.textContent).toBe('Pick a size');
  });

  it('accepts plain strings as options and groups radios that were given no name', () => {
    const { container } = mount(<Radio {...({ options: ['red', 'green'] } as unknown as React.ComponentProps<typeof Radio>)} />);
    const radios = Array.from(container.querySelectorAll<HTMLInputElement>('input[type=radio]'));
    expect(radios.map((r) => r.value)).toEqual(['red', 'green']);
    expect(container.textContent).toContain('green');
    expect(radios[0].name).not.toBe('');
    expect(radios[0].name).toBe(radios[1].name);
  });
});

// --- TextArea, Input, Slider ---------------------------------------------------------

describe('TextArea', () => {
  it('counts a controlled value, including after the parent resets it', () => {
    const { container, rerender } = mount(<TextArea value="hello" onChange={() => {}} showCharCount />);
    expect(container.textContent).toContain('5 characters');
    rerender(<TextArea value="" onChange={() => {}} showCharCount />);
    expect(container.textContent).toContain('0 characters');
  });

  it('does not pass both value and defaultValue to the textarea', () => {
    const warnings = warningsDuring(() => {
      mount(<TextArea value="a" defaultValue="b" onChange={() => {}} />);
    });
    expect(warnings.filter((w) => /both the value and defaultValue/i.test(w))).toEqual([]);
  });
});

describe('Input clear button', () => {
  it('returns focus to the field it emptied', () => {
    const { container } = mount(<Input defaultValue="abc" clearable />);
    const input = container.querySelector('input')!;
    click(container.querySelector('button[aria-label="Clear input"]'));
    expect(input.value).toBe('');
    expect(document.activeElement).toBe(input);
  });
});

describe('Slider from the keyboard', () => {
  it('ends each change a key makes, as a pointer release does', () => {
    const onChangeEnd = vi.fn();
    const { container } = mount(<Slider defaultValue={10} onChangeEnd={onChangeEnd} />);
    const thumb = container.querySelector<HTMLElement>('[role=slider]')!;
    key(thumb, { key: 'ArrowRight' });
    expect(onChangeEnd).toHaveBeenLastCalledWith(11);
    key(thumb, { key: 'End' });
    expect(onChangeEnd).toHaveBeenLastCalledWith(100);
  });
});
