// @vitest-environment jsdom
/**
 * The app beside the canvas starts again when the editing pauses, not once
 * a key.
 *
 * Every change of the page's source is a new start of the app's engine. In
 * the Preview view that is one start, on arriving. Beside the canvas the
 * page changes with each letter typed into a property, and the pane would
 * have started the app eight times for a word. The source it runs is held
 * until the page has been left alone for a moment (`useSettled`); the
 * Preview view passes it straight on, as before.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettled } from './LivePreview';

let root: Root;
let host: HTMLDivElement;
let seen: [string, boolean][];

function Harness({ value, ms }: { value: string; ms: number }) {
  const [settled, waiting] = useSettled(value, ms);
  seen.push([settled, waiting]);
  return null;
}

const draw = (value: string, ms: number) => act(() => root.render(React.createElement(Harness, { value, ms })));
const last = () => seen[seen.length - 1];
/** The values handed on, each once, in the order they were. */
const handedOn = () => seen.map(([value]) => value).filter((value, index, all) => index === 0 || all[index - 1] !== value);

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  seen = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('the source the pane beside the canvas runs', () => {
  it('is the page at once, when the pane opens', () => {
    draw('<App />', 450);
    expect(last()).toEqual(['<App />', false]);
  });

  it('waits for the typing to pause, and is then the page as it is', () => {
    draw('a', 450);
    for (const typed of ['ab', 'abc', 'abcd']) {
      draw(typed, 450);
      act(() => void vi.advanceTimersByTime(200));
      // Still the app that was running, and said to be a moment behind.
      expect(last()).toEqual(['a', true]);
    }
    act(() => void vi.advanceTimersByTime(450));
    expect(last()).toEqual(['abcd', false]);
    // One start for the word, not one a letter.
    expect(handedOn()).toEqual(['a', 'abcd']);
  });

  it('starts nothing for a change that was undone before the pause', () => {
    draw('a', 450);
    draw('ab', 450);
    draw('a', 450);
    act(() => void vi.advanceTimersByTime(1000));
    expect(handedOn()).toEqual(['a']);
    expect(last()).toEqual(['a', false]);
  });

  it('is passed straight on in the Preview view, which has no delay', () => {
    draw('a', 0);
    draw('ab', 0);
    expect(last()).toEqual(['ab', false]);
    expect(handedOn()).toEqual(['a', 'ab']);
  });
});
