/**
 * Which calls into the logic may be dropped when it cannot keep up is
 * decided by the event that made the call, not by the function's name.
 *
 * When 32 calls are waiting for the engine, one more that only reports where
 * something is now (a tick, the pointer, a scroll) is not added. It used to
 * be the name that said so: a function called `tick…`, `update…`, `animate…`
 * or `render…` could be dropped whatever it was bound to, so a button whose
 * handler was `updateCart` could lose a press under load, and a game loop
 * called `gameStep` was never dropped at all.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createConsoleModule,
  createMockNavModule,
  createMockXDBModule,
  createScriptRuntime,
  type ScriptContext,
} from '../src/runtime/script-runtime';
import { DROPPABLE_EVENT_PROPS, asDroppable, callIsDroppable } from '../src/runtime/droppable-calls';
import { reactEventProp } from '../src/renderer/render';
import type { ScriptBlock } from '../src/parser/ast';
import type { ComponentRegistry } from '../src/renderer';
import { click, drawPage, removeDrawnPages } from './helpers/drawn-page';

afterEach(() => {
  removeDrawnPages();
  vi.restoreAllMocks();
});

function script(code: string): ScriptBlock {
  return { type: 'ScriptBlock', code, loc: { line: 1, column: 0, start: 0, end: code.length } };
}

async function load(code: string) {
  const state: Record<string, unknown> = {};
  const context: ScriptContext = {
    state,
    setState: (path: string, value: unknown) => {
      state[path] = value;
    },
    data: {},
    xdb: createMockXDBModule(),
    nav: createMockNavModule(),
    console: createConsoleModule(),
  };
  const runtime = createScriptRuntime(context, undefined, `droppable-${Math.random()}`);
  const loaded = await runtime.loadScript(script(code));
  return { runtime, state, functions: loaded.functions };
}

/** Call `fn` `times` times in one turn, so every call but the first waits for the engine. */
const burst = (times: number, fn: () => unknown) => Promise.all(Array.from({ length: times }, fn));

describe('a queue of calls that the engine is behind on', () => {
  const CODE = `
    let cart = 0
    let steps = 0
    function updateCart() { cart = cart + 1 }
    function tick() { steps = steps + 1 }
    function gameStep() { steps = steps + 1 }
  `;

  it('never drops a press, whatever its function is called', async () => {
    const app = await load(CODE);
    // Forty presses in one turn: more than the queue lets a droppable call wait behind.
    await burst(40, () => app.functions.updateCart());
    expect(app.state.cart).toBe(40);
    // Nor a function with a loop's name, when it is a press that calls it.
    await burst(40, () => app.functions.tick());
    expect(app.state.steps).toBe(40);
    app.runtime.cleanup();
  });

  it('drops what a continuous event calls past the 32 that are waiting, whatever its function is called', async () => {
    const app = await load(CODE);
    await burst(40, () => asDroppable(() => app.functions.gameStep()));
    expect(app.state.steps).toBe(32);
    // The same function from a press, with the queue empty again, runs every time.
    await burst(40, () => app.functions.gameStep());
    expect(app.state.steps).toBe(72);
    // And a function with a press's name is dropped like any other when a tick calls it.
    await burst(40, () => asDroppable(() => app.functions.updateCart()));
    expect(app.state.cart).toBe(32);
    app.runtime.cleanup();
  });

  // Found by review, 2026-11-13: each call was counted against the ones its own handler had just
  // made, so a tick that moved forty enemies with forty calls lost eight of them on every tick,
  // with the engine idle. (Before events were what counted, only functions with a loop's name were.)
  it('runs every call one tick makes, however many: an event is not cut short for what it asks itself', async () => {
    const app = await load(CODE);
    await asDroppable(() => burst(40, () => app.functions.gameStep()));
    expect(app.state.steps).toBe(40);
    // And the next tick's forty, the engine having caught up.
    await asDroppable(() => burst(40, () => app.functions.gameStep()));
    expect(app.state.steps).toBe(80);
    app.runtime.cleanup();
  });

  it('leaves a continuous event out whole when it arrives with 32 calls already waiting, and never part of one', async () => {
    const app = await load(CODE);
    // The engine is behind: thirty-five presses wait.
    const presses = burst(35, () => app.functions.updateCart());
    // A tick arrives now, and asks for five things: none is done, not the first two or three.
    const tick = asDroppable(() => burst(5, () => app.functions.gameStep()));
    await Promise.all([presses, tick]);
    expect(app.state.cart).toBe(35);
    expect(app.state.steps).toBe(0);
    // One that arrived before the engine fell behind runs whole, though more was asked after it.
    const early = asDroppable(() => burst(5, () => app.functions.gameStep()));
    const later = burst(40, () => app.functions.updateCart());
    await Promise.all([early, later]);
    expect(app.state.steps).toBe(5);
    expect(app.state.cart).toBe(75);
    app.runtime.cleanup();
  });

  it('never drops a press that is behind a queue full of ticks', async () => {
    const app = await load(CODE);
    const ticks = burst(40, () => asDroppable(() => app.functions.gameStep()));
    const presses = burst(5, () => app.functions.updateCart());
    await Promise.all([ticks, presses]);
    expect(app.state.cart).toBe(5);
    app.runtime.cleanup();
  });
});

describe('the renderer says which event a handler is for', () => {
  /** A component that hands back whatever it was given, so a test can call its callbacks. */
  const given: Record<string, Record<string, unknown>> = {};
  const register = (registry: ComponentRegistry) => {
    for (const tag of ['Loop', 'Scene3D', 'Box']) {
      registry.register(tag, (props: Record<string, unknown>) => {
        given[tag] = props;
        return null;
      });
    }
  };
  type Callback = (...args: unknown[]) => unknown;

  it('marks @tick, @hover, the pointer moving, a scroll and the wheel, and nothing else', () => {
    const seen: Array<[string, boolean]> = [];
    const note = (name: string) => () => {
      seen.push([name, callIsDroppable()]);
    };
    const functions = { step: note('step'), look: note('look'), press: note('press'), update: note('update') };
    const page = drawPage(
      `<div>
        <Loop running @tick={step} />
        <Scene3D @hover={look} @pointerMove={look} @click={press} @pointerDown={press} />
        <Box @pointerMove={look} @click={update} @keyDown={press} />
        <div id="plain" @mousemove={look} @scroll={look} @wheel={look} @touchmove={look} @click={update} @change={update}>x</div>
      </div>`,
      {},
      { functions, register }
    );
    (given.Loop.onTick as Callback)(0.016);
    (given.Scene3D.onHover as Callback)({ objectId: 'a' });
    (given.Scene3D.onPointerMove as Callback)({});
    (given.Scene3D.onClick as Callback)({ objectId: 'a' });
    (given.Scene3D.onPointerDown as Callback)({});
    (given.Box.onPointerMove as Callback)({});
    (given.Box.onClick as Callback)({});
    (given.Box.onKeyDown as Callback)({});
    expect(seen).toEqual([
      ['step', true],
      ['look', true],
      ['look', true],
      ['press', false],
      ['press', false],
      ['look', true],
      ['update', false],
      ['press', false],
    ]);

    // A plain element's own events, as React fires them.
    seen.length = 0;
    const plain = page.one('#plain');
    for (const type of ['mousemove', 'wheel', 'touchmove']) {
      React.act(() => {
        plain.dispatchEvent(new Event(type, { bubbles: true }));
      });
    }
    React.act(() => {
      plain.dispatchEvent(new Event('scroll', { bubbles: false }));
    });
    click(plain);
    expect(seen).toEqual([['look', true], ['look', true], ['look', true], ['look', true], ['update', false]]);
    // The mark is for the handler's own run and no longer.
    expect(callIsDroppable()).toBe(false);
  });

  it('marks the handler however it is written: by name, as an arrow, as a call, and as a prop', () => {
    const seen: boolean[] = [];
    const functions = {
      step: () => {
        seen.push(callIsDroppable());
      },
    };
    for (const written of ['@tick={step}', '@tick={(dt) => step(dt)}', '@tick={step()}', 'onTick={step}', 'onTick={(dt) => step(dt)}']) {
      drawPage(`<Loop running ${written} />`, {}, { functions, register });
      (given.Loop.onTick as Callback)(0.016);
    }
    expect(seen).toEqual([true, true, true, true, true]);
  });

  it('does not mark what a handler calls later, after waiting: that call is never dropped', async () => {
    const seen: boolean[] = [];
    const functions = {
      wait: () => Promise.resolve().then(() => seen.push(callIsDroppable())),
    };
    drawPage('<Loop running @tick={wait} />', {}, { functions, register });
    await (given.Loop.onTick as Callback)(0.016);
    expect(seen).toEqual([false]);
  });

  it('keeps what a handler answers, and its failure', () => {
    const functions = {
      step: (dt: unknown) => `stepped ${String(dt)}`,
      fail: () => {
        throw new Error('no');
      },
    };
    drawPage('<Loop running @tick={step} />', {}, { functions, register });
    expect((given.Loop.onTick as Callback)(0.5)).toBe('stepped 0.5');
    drawPage('<Loop running @tick={fail} />', {}, { functions, register });
    expect(() => (given.Loop.onTick as Callback)(0.5)).toThrow('no');
    expect(callIsDroppable()).toBe(false);
  });

  it('lists the events by the prop the renderer gives each', () => {
    for (const event of ['tick', 'hover', 'pointerMove', 'pointermove', 'mousemove', 'touchmove', 'scroll', 'wheel', 'drag', 'dragover', 'timeupdate', 'level', 'fps', 'frame']) {
      expect(DROPPABLE_EVENT_PROPS.has(reactEventProp(event)), event).toBe(true);
    }
    for (const event of ['click', 'change', 'input', 'submit', 'keydown', 'keyup', 'pointerdown', 'pointerup', 'press', 'release', 'samples', 'select', 'end', 'ready', 'dragend', 'drop']) {
      expect(DROPPABLE_EVENT_PROPS.has(reactEventProp(event)), event).toBe(false);
    }
  });
});
