/**
 * A function named as a handler is given the element it was on.
 *
 * `@click={save}` with `function save(e) { … e.currentTarget.dataset.id … }`
 * threw on the main thread: the event was read for the script only after the
 * wait for the engine, by when React had cleared its `currentTarget`, and the
 * script was given neither `target` nor `currentTarget`. The worker, which
 * reads the event before it waits, gave both.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { SoftNRenderer } from '../src/loader/SoftNRenderer';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let root: Root | null = null;
let container: HTMLElement;

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = null;
  }
  container?.remove();
});

describe('a function named as a handler, on the main thread', () => {
  it('is given the element it was on, and the one clicked', async () => {
    const source = `<logic>
let picked = 'none'
function save(e) { picked = e.currentTarget.dataset.id + ':' + e.target.tagName }
</logic>
<div><button id="b" data-id="42" @click={save}><b id="inner">Save</b></button><p id="out">{picked}</p></div>`;
    container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container);
      root.render(<SoftNRenderer source={source} appId="handler-event-target" scriptExecutionMode="main" />);
    });
    for (let i = 0; i < 60 && container.querySelector('#out')?.textContent !== 'none'; i++) {
      await act(async () => {
        await sleep(20);
      });
    }
    expect(container.querySelector('#out')?.textContent).toBe('none');
    await act(async () => {
      (container.querySelector('#inner') as HTMLElement).click();
      await sleep(80);
    });
    expect(container.querySelector('#out')?.textContent).toBe('42:B');
  });
});
