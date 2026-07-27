/**
 * A `.logic` top level must run once per mount, not twice.
 *
 * This is an end-to-end smoke test, not the regression test for the disposal
 * race — under jsdom the engine is already initialised, so `loadScript`'s first
 * await resolves before cleanup can land and the race window never opens.
 * Confirmed: this test still passes with the fix reverted. The invariant itself
 * is pinned in `runtime-disposal.test.ts`, which drives the runtime directly
 * and does fail without it.
 *
 * What this does cover is the whole path staying wired together: mount under
 * StrictMode the way every app does, and see the author's one record rather
 * than two.
 */

import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { SoftNRenderer } from '../src/loader/SoftNRenderer';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The top level writes a record; the template reads the count back at render
// time so the answer comes from whichever engine ended up live.
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

describe('mounting under StrictMode', () => {
  it('runs the script top level exactly once', async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <React.StrictMode>
          <SoftNRenderer source={SOURCE} appId="StrictProbe" />
        </React.StrictMode>
      );
    });

    for (let i = 0; i < 60; i++) {
      const text = container.querySelector('.runs')?.textContent;
      if (text && text !== '' && text !== '0') break;
      await settle(50);
    }
    // Let any second, abandoned load land before reading.
    await settle(600);

    expect(container.querySelector('.runs')?.textContent).toBe('1');

    await act(async () => root.unmount());
  }, 60_000);
});
