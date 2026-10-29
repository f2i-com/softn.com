/**
 * What a function leaves in state reaches the page as it is.
 *
 * After each call the runtime reads the state that moved with
 * getGlobalsBatch. From ZIPP 0.0.32 the engine hands a batch JSON can carry
 * as one JSON text for the host to parse, and converts the rest value by value
 * as before. Either way the page must get the same values: an own `__proto__`
 * key as an own property, -0, keys that read as numbers in order, every
 * character of a string, null for what has no plain form (a function, a Date),
 * and, in the batches JSON cannot carry, undefined, NaN, Infinity and a lone
 * surrogate.
 */
import { describe, expect, it } from 'vitest';
import {
  createConsoleModule,
  createMockNavModule,
  createMockXDBModule,
  createScriptRuntime,
  type ScriptContext,
} from '../src/runtime/script-runtime';

async function filled(code: string): Promise<Record<string, unknown>> {
  const state: Record<string, unknown> = {};
  const context: ScriptContext = {
    state,
    setState: (path: string, value: unknown) => {
      state[path] = value;
    },
    batchSetState: (changes) => {
      Object.assign(state, changes);
    },
    data: {},
    xdb: createMockXDBModule(),
    nav: createMockNavModule(),
    console: createConsoleModule(),
  };
  const runtime = createScriptRuntime(context);
  try {
    const loaded = await runtime.loadScript({ type: 'LogicBlock', code, loc: { line: 1, column: 0, start: 0, end: code.length } });
    Object.assign(state, loaded.state);
    await loaded.functions.fill();
    return state;
  } finally {
    runtime.cleanup();
  }
}

// Escaped as the logic's string literal writes it, which JSON reads the same way.
const TEXT = 'quote \\" back \\\\ tab \\t line \\n nul \\u0000 bell \\u0007 del \\u007f emoji \\ud83d\\ude00 line sep \\u2028';

describe('state read out of the engine after a call', () => {
  it('is what JSON can carry, exactly', async () => {
    const state = await filled(`
      let tricky = null;
      function fill() {
        tricky = { ["__proto__"]: 1, b: 1, "10": "ten", "2": "two", a: -0, text: "${TEXT}", nested: [1, -0, null, { x: [] }, true], big: 1e300, tiny: 5e-324, third: 1 / 3 };
      }
    `);
    const tricky = state.tricky as Record<string, unknown>;
    expect(Object.getPrototypeOf(tricky)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(tricky, '__proto__')).toEqual({ value: 1, writable: true, enumerable: true, configurable: true });
    expect(Object.keys(tricky)).toEqual(['2', '10', '__proto__', 'b', 'a', 'text', 'nested', 'big', 'tiny', 'third']);
    expect(Object.is(tricky.a, -0)).toBe(true);
    expect(tricky.text).toBe(JSON.parse(`"${TEXT}"`));
    expect(tricky.nested).toEqual([1, -0, null, { x: [] }, true]);
    expect(Object.is((tricky.nested as unknown[])[1], -0)).toBe(true);
    expect([tricky.big, tricky.tiny, tricky.third]).toEqual([1e300, 5e-324, 1 / 3]);
  });

  it('is null for what has no plain form', async () => {
    const state = await filled(`
      let things = null;
      function fill() { things = { f: function () {}, d: new Date(0), m: new Map([[1, 2]]), list: [function () {}] }; }
    `);
    expect(state.things).toEqual({ f: null, d: null, m: null, list: [null] });
  });

  it('keeps an own __proto__ key on its way back into the logic', async () => {
    const state: Record<string, unknown> = {};
    const context: ScriptContext = {
      state,
      setState: (path: string, value: unknown) => {
        state[path] = value;
      },
      batchSetState: (changes) => {
        Object.assign(state, changes);
      },
      data: {},
      xdb: createMockXDBModule(),
      nav: createMockNavModule(),
      console: createConsoleModule(),
    };
    const runtime = createScriptRuntime(context);
    try {
      const code = `
        let record = { kept: 1 };
        let seen = null;
        function look() { seen = [Object.keys(record).join(","), Object.getPrototypeOf(record) === Object.prototype, record.__proto__ === Object.prototype ? "proto" : JSON.stringify(record.__proto__)]; }
      `;
      const loaded = await runtime.loadScript({ type: 'LogicBlock', code, loc: { line: 1, column: 0, start: 0, end: code.length } });
      Object.assign(state, loaded.state);
      const written: Record<string, unknown> = { kept: 2 };
      Object.defineProperty(written, '__proto__', { value: { x: 1 }, writable: true, enumerable: true, configurable: true });
      runtime.updateContext({ record: written });
      await loaded.functions.look();
      expect(state.seen).toEqual(['kept,__proto__', true, '{"x":1}']);
    } finally {
      runtime.cleanup();
    }
  });

  it('is what JSON cannot carry, as before', async () => {
    const state = await filled(`
      let gap = null, odd = null, lone = null, after = null;
      function fill() { gap = [1, undefined, 3]; odd = { n: NaN, up: Infinity, down: -Infinity }; lone = "a\\ud800b"; after = { plain: "yes" }; }
    `);
    expect(state.gap).toEqual([1, undefined, 3]);
    expect(state.odd).toEqual({ n: NaN, up: Infinity, down: -Infinity });
    expect(state.lone).toBe('a\ud800b');
    expect(state.after).toEqual({ plain: 'yes' });
  });
});
