import React, { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Input, type InputProps } from '../src/form/Input';
import { mount, type } from './dom';

describe('native date and time inputs', () => {
  const cases: Array<[InputProps['type'], string]> = [
    ['date', '2026-09-12'],
    ['time', '11:30'],
    ['datetime-local', '2026-09-12T11:30'],
  ];

  for (const [inputType, selected] of cases) {
    it(`keeps the browser's ${inputType} value in controlled form state`, () => {
      function Form() {
        const [value, setValue] = useState('');
        return <><Input type={inputType} label="Meeting" value={value} onChange={event => setValue(event.target.value)} /><output>{value}</output></>;
      }
      const { container, unmount } = mount(<Form />);
      try {
        const input = container.querySelector('input')!;
        expect(input.type).toBe(inputType);
        type(input, selected);
        expect(input.value).toBe(selected);
        expect(container.querySelector('output')?.textContent).toBe(selected);
        type(input, '');
        expect(input.value).toBe('');
        expect(container.querySelector('output')?.textContent).toBe('');
      } finally {
        unmount();
      }
    });
  }
});
