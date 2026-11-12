/**
 * An app's variables, carried from the engine its old logic ran in to the one
 * its new logic starts in (runtime/state-carry.ts): what moved is carried,
 * what did not takes the new logic's starting value, and anything that could
 * arrive broken refuses the whole carry, with nothing written.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createLogicEngine, type LogicEngine } from '../src/runtime/vm-adapter';
import { carriedValues, carryIn, carryOut, markStart, shapeFits, type StateSlots } from '../src/runtime/state-carry';

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
  return {
    engine,
    slots: { names, indices },
    slotOf: (name) => (names.includes(name) ? indices[names.indexOf(name)] : undefined),
  };
}

afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

describe('carrying variables from one engine to the next', () => {
  it('carries what moved and leaves the rest to the new logic', async () => {
    const old = await start(`
      let count = 0
      let speed = 5
      let user = { name: "", tags: [] }
      function work() { count = 7; user.name = "Bo"; user.tags.push("a") }
    `);
    const mark = markStart(old.engine, old.slots);
    old.engine.callFunction('work', []);
    const out = carryOut(old.engine, old.slots, mark);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.names.sort()).toEqual(['count', 'user']);
    expect(carriedValues(out.state)).toEqual({ count: 7, user: { name: 'Bo', tags: ['a'] } });

    const next = await start(`
      let count = 10
      let speed = 9
      let user = { name: "", tags: [] }
      let added = "new"
      function read() { return [count, speed, user, added] }
    `);
    const into = carryIn(next.engine, next.slotOf, out.state);
    expect(into).toEqual({ ok: true, carried: ['count', 'user'] });
    expect(next.engine.callFunctionSync('read', [])).toEqual([7, 9, { name: 'Bo', tags: ['a'] }, 'new']);
  });

  it('keeps one object one object among the carried variables', async () => {
    const old = await start(`
      let items = []
      let selected = null
      function work() { items = [{ id: 1, done: false }, { id: 2, done: false }]; selected = items[1] }
    `);
    const mark = markStart(old.engine, old.slots);
    old.engine.callFunction('work', []);
    const out = carryOut(old.engine, old.slots, mark);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const next = await start(`
      let items = []
      let selected = null
      function tick() { selected.done = true; return [selected === items[1], items[1].done] }
    `);
    expect(carryIn(next.engine, next.slotOf, out.state).ok).toBe(true);
    expect(next.engine.callFunctionSync('tick', [])).toEqual([true, true]);
  });

  it('fills a list or object the new logic already holds, so what else holds it sees the contents', async () => {
    const old = await start(`
      const store = { n: 0 }
      function work() { store.n = 3; store.extra = [1] }
    `);
    const mark = markStart(old.engine, old.slots);
    old.engine.callFunction('work', []);
    const out = carryOut(old.engine, old.slots, mark);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const next = await start(`
      const store = { n: 0 }
      const views = [store]
      function read() { return [views[0] === store, views[0].n, store.extra] }
    `);
    expect(carryIn(next.engine, next.slotOf, out.state).ok).toBe(true);
    expect(next.engine.callFunctionSync('read', [])).toEqual([true, 3, [1]]);
  });

  it('carries the numbers JSON has no word for, and nothing at all', async () => {
    const old = await start(`
      let a = 1
      let b = 1
      let c = 1
      function work() { a = NaN; b = -Infinity; c = undefined }
    `);
    const mark = markStart(old.engine, old.slots);
    old.engine.callFunction('work', []);
    const out = carryOut(old.engine, old.slots, mark);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const next = await start(`
      let a = 1
      let b = 1
      let c = 1
      function read() { return [a !== a, b === -Infinity, c === undefined] }
    `);
    expect(carryIn(next.engine, next.slotOf, out.state).ok).toBe(true);
    expect(next.engine.callFunctionSync('read', [])).toEqual([true, true, true]);
  });

  it('leaves a variable that holds a function to the new logic', async () => {
    const old = await start(`
      let label = (n) => "n is " + n
      let count = 0
      function work() { count = 2; label = (n) => "changed " + n }
    `);
    const mark = markStart(old.engine, old.slots);
    old.engine.callFunction('work', []);
    const out = carryOut(old.engine, old.slots, mark);
    expect(out.ok && out.names).toEqual(['count']);
  });

  it.each([
    ['an object made by a class', 'class Game { constructor() { this.score = 0 } }\nlet game = new Game()\nfunction work() { game.score = 4 }', 'game'],
    ['a function inside a list', 'let steps = []\nfunction work() { steps.push(() => 1) }', 'steps'],
    ['a Map among the variables that stay', 'let seen = new Map()\nlet count = 0\nfunction work() { count = 1; seen.set("a", 1) }', 'seen'],
    ['a typed array', 'let grid = new Uint8Array(4)\nlet count = 0\nfunction work() { grid[0] = 1 }', 'grid'],
    ['a Date', 'let at = new Date(0)\nfunction work() { at = new Date(5) }', 'at'],
  ])('refuses %s', async (_what, code, name) => {
    const old = await start(code);
    const mark = markStart(old.engine, old.slots);
    old.engine.callFunction('work', []);
    const out = carryOut(old.engine, old.slots, mark);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.why).toContain(`\`${name}\``);
  });

  it('leaves an object made by a class to the new logic only where the engine can say it has not moved', async () => {
    const old = await start(`
      class Game { constructor() { this.score = 0 } }
      let game = new Game()
      let count = 0
      function work() { count = 1 }
    `);
    const mark = markStart(old.engine, old.slots);
    old.engine.callFunction('work', []);
    const out = carryOut(old.engine, old.slots, mark);
    // ZIPP digests the object where it stands, and knows. An engine whose
    // variables are only read out cannot tell, and the carry is refused.
    const digests = Array.isArray(old.engine.getGlobalsFingerprint?.([]));
    if (digests) expect(out.ok && out.names).toEqual(['count']);
    else expect(out).toEqual({ ok: false, why: '`game` holds an object made by a class' });
  });

  it('refuses an object a carried variable shares with one that stays', async () => {
    const old = await start(`
      let rows = [{ id: 1 }]
      let open = null
      function work() { open = rows[0] }
    `);
    const mark = markStart(old.engine, old.slots);
    old.engine.callFunction('work', []);
    const out = carryOut(old.engine, old.slots, mark);
    expect(out).toEqual({ ok: false, why: '`open` holds an object another variable also holds' });
  });

  it('refuses a variable whose shape the new logic changed, and writes nothing', async () => {
    const old = await start(`
      let user = { name: "" }
      let count = 0
      function work() { user.name = "Bo"; count = 3 }
    `);
    const mark = markStart(old.engine, old.slots);
    old.engine.callFunction('work', []);
    const out = carryOut(old.engine, old.slots, mark);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const next = await start(`
      let user = { first: "", last: "" }
      let count = 0
      function read() { return [user, count] }
    `);
    expect(carryIn(next.engine, next.slotOf, out.state)).toEqual({ ok: false, why: '`user` has changed shape' });
    expect(next.engine.callFunctionSync('read', [])).toEqual([{ first: '', last: '' }, 0]);
  });

  it('refuses a variable the new logic starts as something that is not plain data', async () => {
    const old = await start('let player = { x: 0 }\nfunction work() { player.x = 5 }');
    const mark = markStart(old.engine, old.slots);
    old.engine.callFunction('work', []);
    const out = carryOut(old.engine, old.slots, mark);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const next = await start('class Player { constructor() { this.x = 0 } }\nlet player = new Player()');
    const into = carryIn(next.engine, next.slotOf, out.state);
    expect(into.ok).toBe(false);
  });

  it('drops a variable the new logic no longer has, and one that is code there now', async () => {
    const old = await start(`
      let gone = 0
      let helper = 0
      let kept = 0
      function work() { gone = 1; helper = 2; kept = 3 }
    `);
    const mark = markStart(old.engine, old.slots);
    old.engine.callFunction('work', []);
    const out = carryOut(old.engine, old.slots, mark);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const next = await start(`
      let helper = () => 1
      let kept = 0
      function read() { return [typeof helper, kept] }
    `);
    expect(carryIn(next.engine, next.slotOf, out.state)).toEqual({ ok: true, carried: ['kept'] });
    expect(next.engine.callFunctionSync('read', [])).toEqual(['function', 3]);
  });
});

describe('whether a carried value fits where the new logic starts', () => {
  it.each([
    [7, 0, true],
    ['a', 0, false],
    [[1], [], true],
    [[], {}, false],
    [{ a: 1, extra: 2 }, { a: 0 }, true],
    [{ a: 1 }, { a: 0, b: 0 }, false],
    [null, { a: 0 }, true],
    [{ a: 1 }, null, true],
    [[{ id: 1 }], [{ id: 0, done: false }], false],
  ])('%j where %j starts: %s', (carried, fresh, fits) => {
    expect(shapeFits(carried, fresh)).toBe(fits);
  });
});
