/**
 * A `$:` that cannot be compiled must cost that one value, not the app.
 *
 * `loadScript` compiles every `$:` declaration into a real function alongside
 * the script, and falls back to compiling the script alone when the scanner
 * mis-extracts one. zipp v0.0.1 broke that fallback twice over: `initScript`
 * terminates the Engine on failure — so the retry hit a corpse — and the
 * capability allowlist it wipes on the way out is frozen at the *next*
 * `initScript`, so a retry that did survive would have compiled into a VM that
 * denied every `db.*` call in the top level.
 *
 * The fix builds a fresh engine and re-wires it. This test holds both halves:
 * the app still loads, and the record its top level writes still lands.
 * Nothing else in the suite feeds a bad `$:`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import { SoftNRenderer } from '../src/loader/SoftNRenderer';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * A template inside another template's `${}` is valid JavaScript, and the
 * engine reads `bumped` as the string it builds. The scanner that finds `$:`
 * expressions does not follow a template into its `${}`: it takes the inner
 * template's opening backtick for the end of the outer one, and the `}` after
 * it for the end of the block the declaration is written in. So it extracts
 * `` `${base > 0 ? ` `` and generates a function around it that does not
 * compile — a SyntaxError in the combined unit and nowhere else. That is
 * exactly the mis-extraction the fallback exists for.
 *
 * (This used to be `base +` above a line holding `1`, which the scanner cut
 * at the line's end. It reads that as JavaScript does now.)
 */
const SOURCE = `<logic>
let base = 1

db.create("runs", { at: "x" })

$: bumped = \`\${base > 0 ? \`}\` : ""}\`

function runCount() { return db.query("runs").length }
</logic>

<div><span class="runs">{runCount()}</span><span class="bumped">{bumped}</span></div>`;

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

describe('the `$:` compile fallback', () => {
  it('rebuilds and re-grants the engine, so the top level still reaches the db', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await act(async () => {
        root = createRoot(container);
        root.render(<SoftNRenderer source={SOURCE} appId="ComputedFallbackProbe" />);
      });

      for (let i = 0; i < 60; i++) {
        const text = container.querySelector('.runs')?.textContent;
        if (text && text !== '' && text !== '0') break;
        await settle(50);
      }
      await settle(300);

      // The fallback was taken — otherwise this test has stopped testing it,
      // because the scanner learned to read the expression correctly.
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes('`$:` declaration could not be compiled'))
      ).toBe(true);

      // The retry engine was wired AND granted: `db.create` in the top level
      // reached the bridge instead of throwing
      // `SecurityError: synchronous host capability denied`.
      expect(container.querySelector('.runs')?.textContent).toBe('1');

      // The mis-extracted value itself stays empty: the half a template it
      // was cut to is no more evaluable per-render than it was compilable,
      // so what the fallback actually buys is the rest of the app — the
      // record above, the function, the markup — surviving one bad
      // declaration.
      expect(container.querySelector('.bumped')?.textContent).toBe('');
    } finally {
      warn.mockRestore();
      await act(async () => {
        root.unmount();
      });
    }
  });
});
