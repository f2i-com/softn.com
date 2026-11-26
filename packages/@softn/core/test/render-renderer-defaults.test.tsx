/**
 * A SoftNRenderer given none of its record-shaped props (`initialData`,
 * `functions`, `initialState`, `componentProps`, `computedDefs`) stood each
 * one in with `{}` written as a default, a new object every render. The
 * memos and effects that follow those props took that for a change each
 * time, and one of them calls the logic's `_onDataChange()`: it ran after
 * every render, so an app whose `_onDataChange` changes state drew, ran it,
 * drew again, and never stopped (some 56,000 calls in five seconds).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { SoftNRenderer } from '../src/loader/SoftNRenderer';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = null;
  }
  container?.remove();
  container = null;
});

async function settle(ms = 25) {
  await act(async () => {
    await sleep(ms);
  });
}

const COUNTING = `<logic>
let calls = 0
function _onDataChange() { calls = calls + 1 }
</logic>
<p class="calls">{calls}</p>
<p class="other">{other}</p>`;

describe('a renderer given no data', () => {
  it('tells the logic of its data once, not after every render', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    const draw = (other: string) =>
      root!.render(<SoftNRenderer source={COUNTING} appId="render-defaults" scriptExecutionMode="main" initialState={undefined} componentProps={{ other }} />);
    await act(async () => {
      root = createRoot(container!);
      draw('a');
    });
    for (let i = 0; i < 12 && container.querySelector('.calls')?.textContent !== '1'; i++) await settle();
    expect(container.querySelector('.calls')?.textContent).toBe('1');
    // The host draws it again for something else: the data has not changed.
    await act(async () => draw('b'));
    await settle();
    await act(async () => draw('c'));
    for (let i = 0; i < 6; i++) await settle();
    expect(container.querySelector('.other')?.textContent).toBe('c');
    expect(container.querySelector('.calls')?.textContent).toBe('1');
  }, 4000);
});
