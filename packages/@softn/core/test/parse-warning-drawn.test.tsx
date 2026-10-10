/**
 * A parser warning is said, and stops nothing.
 *
 * The parser's diagnostics were all errors until a second `<data>` block
 * whose name for a collection is already taken became a warning: the page is
 * whole, one declaration was left out, and the author should hear which.
 * Whatever reads diagnostics has to tell the two apart. The loader does: an
 * error goes to `console.error`, anything else to `console.warn`, and the
 * page is drawn either way. (Nothing that builds a bundle parses a page at
 * all, so a warning has nothing there to stop.)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { parse } from '../src/parser';
import { SoftNRenderer } from '../src/loader/SoftNRenderer';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE = `<data><collection name="tasks" as="items" /></data>
<div><p class="shown">drawn all the same</p></div>
<data>
  <collection name="todos" as="items" />
</data>`;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
});

describe('a page the parser warns about', () => {
  it('carries a warning and no error', () => {
    expect((parse(SOURCE).diagnostics ?? []).map((diagnostic) => diagnostic.severity)).toEqual(['warning']);
  });

  it('is drawn, and the warning is printed as a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await act(async () => {
        root = createRoot(container);
        root.render(<SoftNRenderer source={SOURCE} />);
      });
      for (let i = 0; i < 40 && !container.querySelector('.shown'); i++) {
        await act(async () => {
          await new Promise((r) => setTimeout(r, 50));
        });
      }
      expect(container.querySelector('.shown')?.textContent).toBe('drawn all the same');

      const said = (spy: typeof warn) => spy.mock.calls.map((call) => call.map(String).join(' '));
      expect(said(warn).some((line) => line.includes('[SoftN] Parse warning at line 4') && line.includes('"tasks" as items'))).toBe(true);
      expect(said(error).filter((line) => line.includes('[SoftN] Parse'))).toEqual([]);
      await act(async () => root.unmount());
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  }, 60_000);
});
