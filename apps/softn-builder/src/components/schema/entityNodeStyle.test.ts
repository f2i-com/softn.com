// @vitest-environment jsdom
/**
 * A collection that is no longer picked looks like one that never was.
 *
 * The card set its border with the `border` shorthand and the picked card
 * added a `borderColor`. When another collection was picked, React took
 * that colour away by clearing it, which clears the colour the shorthand
 * had set: the card that had been picked kept a border in the colour of
 * its text, as though it were still picked, and the console had an error
 * each time. Seen in Chromium with two collections.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { entityNodeStyle } from './EntityNode';

it('goes back to the border it had when another collection is picked', () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    const card = (selected: boolean) => React.createElement('div', { style: entityNodeStyle(selected) });
    act(() => root.render(card(false)));
    const before = host.firstElementChild!.getAttribute('style');
    act(() => root.render(card(true)));
    expect(host.firstElementChild!.getAttribute('style')).not.toBe(before);
    act(() => root.render(card(false)));
    expect(host.firstElementChild!.getAttribute('style')).toBe(before);
  } finally {
    console.error = original;
    act(() => root.unmount());
    host.remove();
  }
  expect(errors.filter((message) => message.includes('shorthand'))).toEqual([]);
});
