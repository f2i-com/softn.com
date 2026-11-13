/**
 * A key listener on the window that calls `preventDefault()` is told, once,
 * that the call does nothing.
 *
 * Logic hears a key after the browser has acted on it, so the call cannot
 * stop the arrows scrolling the page. Eight shipped games make it anyway,
 * and none names its keys with `softn.input.captureKeys`. The runtime says
 * so the first time it happens for a key that was not kept from the
 * browser, naming the two ways to keep one, and says nothing for a key that
 * was.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createConsoleModule,
  createMockNavModule,
  createMockXDBModule,
  createScriptRuntime,
  type ScriptContext,
} from '../src/runtime/script-runtime';
import type { ScriptBlock } from '../src/parser/ast';
import { extractEventProps } from '../src/runtime/event-props';
import { withInProcessWorker } from './helpers/in-process-worker';

function script(code: string): ScriptBlock {
  return { type: 'ScriptBlock', code, loc: { line: 1, column: 0, start: 0, end: code.length } };
}

const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

function context() {
  const state: Record<string, unknown> = {};
  const made: ScriptContext = {
    state,
    setState: (path: string, value: unknown) => {
      state[path] = value;
    },
    data: {},
    xdb: createMockXDBModule(),
    nav: createMockNavModule(),
    console: createConsoleModule(),
  };
  return made;
}

async function load(code: string) {
  const made = context();
  const runtime = createScriptRuntime(made, undefined, `key-prevented-${Math.random()}`);
  const loaded = await runtime.loadScript(script(code));
  return { runtime, state: made.state as Record<string, unknown>, functions: loaded.functions };
}

/** A key as a browser sends one: it can be cancelled. */
const key = (type: string, name: string, code = '') => new KeyboardEvent(type, { key: name, code, bubbles: true, cancelable: true });

const GAME = `
  let heard = ""
  let prevented = ""
  function onKey(e) {
    if (e.key === "ArrowUp" || e.key === " ") { e.preventDefault() }
    heard = heard + e.key
    prevented = prevented + (e.defaultPrevented ? "y" : "n")
  }
  function _init() { window.addEventListener("keydown", onKey) }
  function capture() { softn.input.captureKeys(["ArrowUp", " "]) }
  function stop() { window.removeEventListener("keydown", onKey) }
`;

let warn: { mock: { calls: unknown[][] } };
const warnings = () => warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('preventDefault'));

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('preventDefault() in a key listener the logic put on the window', () => {
  it('is said once, with the two ways to keep a key, for a key that was not kept', async () => {
    const app = await load(GAME);
    await app.functions._init();

    const up = key('keydown', 'ArrowUp', 'ArrowUp');
    window.dispatchEvent(up);
    await settle();
    // The listener ran and its call changed nothing: the browser's default stands.
    expect(app.state.heard).toBe('ArrowUp');
    expect(up.defaultPrevented).toBe(false);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('softn.input.captureKeys');
    expect(warnings()[0]).toContain('<Controls');
    expect(warnings()[0]).toContain('ArrowUp');

    // Once for the app: not again for the same key, nor for another.
    window.dispatchEvent(key('keydown', 'ArrowUp', 'ArrowUp'));
    window.dispatchEvent(key('keydown', ' ', 'Space'));
    await settle();
    expect(warnings()).toHaveLength(1);
    app.runtime.cleanup();
  });

  it('is not said for a key the app kept with softn.input.captureKeys', async () => {
    const app = await load(GAME);
    await app.functions._init();
    await app.functions.capture();
    await settle();

    const up = key('keydown', 'ArrowUp', 'ArrowUp');
    window.dispatchEvent(up);
    window.dispatchEvent(key('keydown', ' ', 'Space'));
    await settle();
    expect(up.defaultPrevented).toBe(true);
    // And the listener is told the key was kept.
    expect(app.state.prevented).toBe('yy');
    expect(warnings()).toEqual([]);
    app.runtime.cleanup();
  });

  it('is not said for a listener that does not call it, nor for a key something else on the page already took', async () => {
    const app = await load(GAME);
    await app.functions._init();
    window.dispatchEvent(key('keydown', 'x', 'KeyX'));
    // What a <Controls> does: takes the key first, on its way down.
    const taken = key('keydown', 'ArrowUp', 'ArrowUp');
    const take = (event: Event) => event.preventDefault();
    document.addEventListener('keydown', take, true);
    document.body.dispatchEvent(taken);
    document.removeEventListener('keydown', take, true);
    await settle();
    expect(app.state.heard).toBe('xArrowUp');
    expect(app.state.prevented).toBe('ny');
    expect(warnings()).toEqual([]);
    app.runtime.cleanup();
  });

  it('leaves a listener as it was: added twice it is heard as before, and taken away it hears nothing', async () => {
    const app = await load(`
      let heard = 0
      function onKey(e) { heard = heard + 1 }
      function add() { window.addEventListener("keydown", onKey) }
      function stop() { window.removeEventListener("keydown", onKey) }
    `);
    const plain = await load(`
      let heard = 0
      function onClick(e) { heard = heard + 1 }
      function add() { window.addEventListener("click", onClick) }
    `);
    // What the engine does with the same function added twice for an event
    // the runtime does not stand in front of, it does for a key.
    await plain.functions.add();
    await plain.functions.add();
    window.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    await app.functions.add();
    await app.functions.add();
    window.dispatchEvent(key('keydown', 'a', 'KeyA'));
    await settle();
    expect(app.state.heard).toBe(plain.state.heard);

    await app.functions.stop();
    await app.functions.stop();
    const before = app.state.heard;
    window.dispatchEvent(key('keydown', 'a', 'KeyA'));
    await settle();
    expect(app.state.heard).toBe(before);
    app.runtime.cleanup();
    plain.runtime.cleanup();
  });

  it('gives a key event the fields it had, and whether the key was kept', () => {
    const event = key('keydown', 'ArrowLeft', 'ArrowLeft');
    expect(extractEventProps(event)).toMatchObject({ type: 'keydown', key: 'ArrowLeft', code: 'ArrowLeft', repeat: false, defaultPrevented: false });
    event.preventDefault();
    expect(extractEventProps(event).defaultPrevented).toBe(true);
  });

  it('is said the same when the logic runs in a worker of its own', () =>
    withInProcessWorker(async () => {
      const { createWorkerScriptRuntime } = await import('../src/runtime/script-worker-runtime');
      const made = context();
      const runtime = createWorkerScriptRuntime(made, undefined, `key-prevented-worker-${Math.random()}`);
      try {
        const loaded = await runtime.loadScript({ type: 'LogicBlock', code: GAME, loc: { line: 1, column: 0, start: 0, end: 0 } });
        await loaded.functions._init!();
        await settle();
        window.dispatchEvent(key('keydown', 'ArrowUp', 'ArrowUp'));
        for (let i = 0; i < 20 && warnings().length === 0; i++) await settle();
        expect(warnings()).toHaveLength(1);
        expect(warnings()[0]).toContain('softn.input.captureKeys');
      } finally {
        runtime.cleanup();
      }
    }), 60_000);
});
