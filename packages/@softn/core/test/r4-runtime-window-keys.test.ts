/**
 * The `window.__…` keys a script's window gains are found after the call that
 * wrote them, however much else the window holds, and the window is not read
 * after a call that did not change it.
 *
 * The runtime looked for new keys after every call by reading the script's
 * whole window as page values: half of what a call cost on an empty window,
 * and four fifths of a millisecond a call for logic keeping 2,000 records on
 * it. It now asks the engine for a digest of the window first, and reads it
 * only when that has moved.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createConsoleModule,
  createMockNavModule,
  createMockXDBModule,
  createScriptRuntime,
  type ScriptContext,
} from '../src/runtime/script-runtime';
import type { LogicEngine } from '../src/runtime/vm-adapter';

const realWin = window as unknown as Record<string, unknown>;

afterEach(() => {
  delete realWin.__r4Late;
  vi.restoreAllMocks();
});

function makeContext(): ScriptContext {
  const state: Record<string, unknown> = {};
  return {
    state,
    setState: (path, value) => {
      state[path] = value;
    },
    data: {},
    xdb: createMockXDBModule(),
    nav: createMockNavModule(),
    console: createConsoleModule(),
  };
}

describe('the keys a script adds to its window', () => {
  it('are found after the call that wrote them, and the window is read only when it moved', async () => {
    const runtime = createScriptRuntime(makeContext(), undefined, 'r4-window-keys', undefined, undefined, { mode: 'main' });
    try {
      const loaded = await runtime.loadScript({
        type: 'LogicBlock',
        code: `
          window.cache = [];
          for (let i = 0; i < 500; i++) window.cache.push({ id: i });
          let n = 0;
          function tick() { n = n + 1; }
          function arm() { window.__r4Late = 5; }
          function bump() { window.__r4Late = window.__r4Late + 1; }
        `,
        loc: { line: 1, column: 0, start: 0, end: 0 },
      });
      const engine = (runtime as unknown as { vmEngine: LogicEngine }).vmEngine;
      const windowIndex = (runtime as unknown as { windowBridge: { windowGlobalIndex: number } }).windowBridge.windowGlobalIndex;
      // ZIPP digests the window, so the runtime can tell it has not moved. An engine that gives
      // no digest (the host-JavaScript one answers null) has it read after every call instead.
      const digests = (engine.getGlobalsFingerprint?.([windowIndex]) ?? null) !== null;
      const reads = vi.spyOn(engine, 'getGlobal');
      const windowReads = () => reads.mock.calls.filter(([index]) => index === windowIndex).length;

      await loaded.functions.tick!();
      await loaded.functions.tick!();
      const afterTicks = windowReads();
      await loaded.functions.tick!();
      await loaded.functions.tick!();
      // Nothing on the window moved: with a digest it is not read again.
      expect(windowReads()).toBe(digests ? afterTicks : afterTicks + 2);

      await loaded.functions.arm!();
      expect(windowReads()).toBeGreaterThan(afterTicks);
      // Found after the call that wrote it, written to the page from the next.
      await loaded.functions.bump!();
      expect(realWin.__r4Late).toBe(6);
    } finally {
      runtime.cleanup();
    }
  });
});
