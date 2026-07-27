/**
 * The per-render cache for sync helper calls must not conflate arguments.
 *
 * The key interpolated the value alone, so `f(1)` and `f("1")` — and
 * `f(true)`/`f("true")`, and `f(null)`/`f("null")` — shared one entry. Within a
 * single render the second call silently returned the first one's answer, so a
 * helper that branches on `typeof` rendered the wrong thing with nothing to
 * suggest it had.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { SoftNRenderer } from '../src/loader/SoftNRenderer';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE = `<logic>
function label(v) {
  if (typeof v === "number") { return "num:" + v }
  if (typeof v === "boolean") { return "bool:" + v }
  return "str:" + v
}
</logic>

<div>
  <span class="a">{label(1)}</span>
  <span class="b">{label("1")}</span>
  <span class="c">{label(true)}</span>
  <span class="d">{label("true")}</span>
</div>`;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
});

describe('two calls to one helper in a single render', () => {
  it('keep a number distinct from the same digits as a string', async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(<SoftNRenderer source={SOURCE} />);
    });

    for (let i = 0; i < 60; i++) {
      if (container.querySelector('.a')?.textContent) break;
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
    }

    expect(container.querySelector('.a')?.textContent).toBe('num:1');
    expect(container.querySelector('.b')?.textContent).toBe('str:1');
    expect(container.querySelector('.c')?.textContent).toBe('bool:true');
    expect(container.querySelector('.d')?.textContent).toBe('str:true');

    await act(async () => root.unmount());
  }, 60_000);
});
