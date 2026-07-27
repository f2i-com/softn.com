/**
 * Derived values must reflect the keystroke that caused the render.
 *
 * `$:` computed values and sync helpers are evaluated *during* render against
 * the script context, but the context was only refreshed by a post-commit
 * effect — so render N saw the state from render N-1 and every derived value
 * sat permanently one keystroke behind. Nothing errored; the screen was just
 * wrong, which is why it survived four earlier hunts.
 *
 * This mounts the real loader against the real engine rather than stubbing the
 * runtime, because the defect is entirely in the ordering between them.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { SoftNRenderer } from '../src/loader/SoftNRenderer';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE = `<logic>
let name = ""
$: greeting = "Hi " + name
function shout() { return name.toUpperCase() }
</logic>

<div>
  <input type="text" :bind={name} />
  <span class="greeting">{greeting}</span>
  <span class="shout">{shout()}</span>
</div>`;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
});

/** Type into a controlled input the way the DOM does. */
async function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
  });
}

describe('a bound input and the values derived from it', () => {
  it('stay in step, not one keystroke behind', async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(<SoftNRenderer source={SOURCE} />);
    });

    // The engine loads asynchronously; give it room to compile and run _init.
    for (let i = 0; i < 60; i++) {
      if (container.querySelector('input')) break;
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
    }

    const input = container.querySelector('input');
    expect(input, 'the bound input should render').not.toBeNull();

    for (const value of ['a', 'ab', 'abc']) {
      await typeInto(input as HTMLInputElement, value);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 120));
      });

      expect(container.querySelector('.greeting')?.textContent).toBe(`Hi ${value}`);
      expect(container.querySelector('.shout')?.textContent).toBe(value.toUpperCase());
    }

    await act(async () => root.unmount());
  }, 60_000);
});
