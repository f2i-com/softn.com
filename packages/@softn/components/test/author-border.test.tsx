/**
 * A field keeps the border its author gave it.
 *
 * Input and TextArea write their border in parts, so focus can change the
 * colour alone. An author's `style={{ border: … }}` won on the first drawing
 * and lost on the next: React wrote the one part that changed, `borderColor`,
 * over the author's border, and the field was the component's grey from its
 * first focus on. Found on the TexasHoldem demo, whose name field is styled
 * that way (React said so in the console).
 */

import { act } from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from './dom';
import { Input } from '../src/form/Input';
import { TextArea } from '../src/form/TextArea';
import { withAuthorStyle } from '../src/utils/authorBorder';

beforeEach(() => {
  document.body.innerHTML = '';
});

function focusThenBlur(field: HTMLElement): void {
  act(() => {
    field.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  });
  act(() => {
    field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

describe('a border the author gave', () => {
  it('stays on an Input through focus and blur', () => {
    const { container } = mount(<Input style={{ border: '2px dashed rgb(1, 2, 3)' }} />);
    const field = container.querySelector('input')!;
    expect(field.style.borderColor).toBe('rgb(1, 2, 3)');
    focusThenBlur(field);
    expect(field.style.borderColor).toBe('rgb(1, 2, 3)');
    expect(field.style.borderStyle).toBe('dashed');
    expect(field.style.borderWidth).toBe('2px');
  });

  it('stays on a TextArea through focus and blur', () => {
    const { container } = mount(<TextArea style={{ border: '2px dashed rgb(1, 2, 3)' }} />);
    const field = container.querySelector('textarea')!;
    expect(field.style.borderColor).toBe('rgb(1, 2, 3)');
    focusThenBlur(field);
    expect(field.style.borderColor).toBe('rgb(1, 2, 3)');
    expect(field.style.borderStyle).toBe('dashed');
  });

  it('leaves the component its own border where the author gave none', () => {
    const { container } = mount(<Input style={{ color: 'rgb(4, 5, 6)' }} />);
    const field = container.querySelector('input')!;
    expect(field.style.borderStyle).toBe('solid');
    expect(field.style.borderWidth).toBe('1px');
    expect(field.style.color).toBe('rgb(4, 5, 6)');
  });

  it('takes one part from the author and keeps the others', () => {
    // A colour alone is the same property the component writes: the author's is last, and wins every drawing.
    expect(withAuthorStyle({ borderWidth: '1px', borderStyle: 'solid', borderColor: 'grey' }, { borderColor: 'gold' })).toEqual({
      borderWidth: '1px',
      borderStyle: 'solid',
      borderColor: 'gold',
    });
    expect(withAuthorStyle({ borderWidth: '1px', borderStyle: 'solid', borderColor: 'grey', padding: 4 }, { border: '0' })).toEqual({ padding: 4, border: '0' });
    expect(withAuthorStyle({ borderColor: 'grey' }, undefined)).toEqual({ borderColor: 'grey' });
  });
});
