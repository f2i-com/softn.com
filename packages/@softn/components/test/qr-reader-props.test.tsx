/**
 * What QRReader hands its scanner stays the same object while what it says
 * does. The scanner restarts its scan loop when its handler, constraints or
 * formats change, and a restart forgets the code in view: with the page's new
 * handler on every redraw (typing a quantity beside the reader), a code still
 * in front of the camera was reported again once past the two-second debounce.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { mount } from './dom';
import { QRReader } from '../src/utility/QRReader';

const handed: Array<Record<string, unknown>> = [];

vi.mock('@yudiel/react-qr-scanner', () => ({
  prepareZXingModule: () => {},
  Scanner: (props: Record<string, unknown>): React.ReactElement => {
    handed.push(props);
    return React.createElement('video');
  },
}));

describe('QRReader across the page redrawing', () => {
  it('hands its scanner the same handler, constraints and formats, and reports to the newest handler', () => {
    const first = vi.fn();
    const second = vi.fn();
    const view = mount(<QRReader onScan={first} />);
    view.rerender(<QRReader onScan={second} />);
    const [a, b] = handed.slice(-2);
    for (const prop of ['onScan', 'constraints', 'formats', 'components', 'styles']) {
      expect(b[prop], prop).toBe(a[prop]);
    }
    (b.onScan as (codes: Array<{ rawValue: string }>) => void)([{ rawValue: 'item-42' }]);
    expect(second).toHaveBeenCalledWith('item-42');
    expect(first).not.toHaveBeenCalled();
    view.unmount();
  });

  it('hands new constraints when the facing or the size changes', () => {
    const view = mount(<QRReader facing="environment" />);
    view.rerender(<QRReader facing="user" />);
    const [a, b] = handed.slice(-2);
    expect(b.constraints).not.toBe(a.constraints);
    expect(b.constraints).toMatchObject({ facingMode: 'user' });
    view.unmount();
  });
});
