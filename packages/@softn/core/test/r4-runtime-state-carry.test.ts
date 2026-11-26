/**
 * A variable carried to the logic that replaces the old (state-carry.ts) keeps
 * every key it had, one named `__proto__` too, and stays a plain object.
 *
 * The new engine rebuilt each object by assigning its keys, and an assigned
 * `__proto__` sets the object's prototype: a record parsed from JSON with such
 * a key lost it in the carry, and came out an object of another kind, which
 * the next carry then refused as "an object made by a class".
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createLogicEngine, type LogicEngine } from '../src/runtime/vm-adapter';
import { carryIn, carryOut, markStart, type StateSlots } from '../src/runtime/state-carry';

const engines: LogicEngine[] = [];

async function start(code: string): Promise<{ engine: LogicEngine; slots: StateSlots; slotOf: (name: string) => number | undefined }> {
  const engine = await createLogicEngine();
  engines.push(engine);
  const map = await engine.initializeScript(code);
  const names: string[] = [];
  const indices: number[] = [];
  for (const [name, symbol] of map.entries()) {
    if (symbol.scope === 'function' || ['window', 'navigator', 'host'].includes(name)) continue;
    names.push(name);
    indices.push(symbol.index);
  }
  return { engine, slots: { names, indices }, slotOf: (name) => (names.includes(name) ? indices[names.indexOf(name)] : undefined) };
}

afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

describe('a carried object with a key named __proto__', () => {
  it('arrives with the key, as a plain object, and can be carried again', async () => {
    const old = await start(`
      let cfg = { b: 1 }
      function work() { cfg = JSON.parse('{"__proto__": {"a": 1}, "b": 2}') }
    `);
    const mark = markStart(old.engine, old.slots);
    old.engine.callFunction('work', []);
    const out = carryOut(old.engine, old.slots, mark);
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const next = await start(`
      let cfg = { b: 0 }
      function look() { return [Object.keys(cfg).join(","), Object.getPrototypeOf(cfg) === Object.prototype, cfg.b] }
    `);
    const nextMark = markStart(next.engine, next.slots);
    expect(carryIn(next.engine, next.slotOf, out.state)).toEqual({ ok: true, carried: ['cfg'] });
    expect(next.engine.callFunctionSync('look', [])).toEqual(['__proto__,b', true, 2]);

    // And on to the logic after that.
    const again = carryOut(next.engine, next.slots, nextMark);
    expect(again.ok).toBe(true);
  });
});
