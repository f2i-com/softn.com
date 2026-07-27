/**
 * A re-render with fresh callback identities must not restart the engine.
 *
 * The parse effect owns parsing, runtime creation, `loadScript` and `_init()`,
 * and its cleanup disposes the WASM engine and clears every script function.
 * `onLoad` and `onError` were in its dependency array, so a caller passing
 * inline arrows re-ran all of that on every render.
 *
 * The builder's LivePreview does exactly that — inline arrows from a plain
 * function, while subscribing to whole stores with no selector, so it
 * re-renders on selection and hover. Clicking any element on the canvas
 * disposed the engine, recompiled, re-ran the script's top level and called
 * `_init()` again: every button inert during the async gap, and an `_init()`
 * that seeds records duplicating them on each click.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { SoftNRenderer } from '../src/loader/SoftNRenderer';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The top level records a run; the template reads the count back at render
// time, so the number reflects however many times the script actually ran.
const SOURCE = `<logic>
db.create("runs", { at: "x" })

function runCount() { return db.query("runs").length }
</logic>

<div><span class="runs">{runCount()}</span></div>`;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
});

async function settle(ms: number) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

describe('re-rendering with new inline callbacks', () => {
  it('does not re-run the script', async () => {
    // Fresh arrow identities on every render, exactly as LivePreview passes.
    const render = () =>
      root.render(
        <SoftNRenderer
          source={SOURCE}
          appId="ChurnProbe"
          onLoad={() => {}}
          onError={() => {}}
        />
      );

    await act(async () => {
      root = createRoot(container);
      render();
    });

    for (let i = 0; i < 60; i++) {
      const text = container.querySelector('.runs')?.textContent;
      if (text && text !== '' && text !== '0') break;
      await settle(50);
    }
    await settle(400);
    expect(container.querySelector('.runs')?.textContent).toBe('1');

    // Five re-renders, as clicking around the canvas would produce.
    for (let i = 0; i < 5; i++) {
      await act(async () => render());
      await settle(120);
    }
    await settle(600);

    expect(container.querySelector('.runs')?.textContent).toBe('1');

    await act(async () => root.unmount());
  }, 60_000);
});
