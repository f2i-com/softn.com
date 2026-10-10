/**
 * Which names a page may call while it is drawn, and what a function of
 * that name may read.
 *
 * drawn-function-state.test.tsx holds the page to it: a function the markup
 * calls is asked again when the state under it changes. This holds the two
 * readings that decide it, with no engine: `collectDrawnNames` over the page
 * and `readsOfDrawnFunctions` over the logic.
 *
 * They err differently. Of the logic, a name too many is mirrored for
 * nothing and a name too few freezes part of the page, so where the text
 * cannot be followed the answer is "unknown" and everything is mirrored. Of
 * the page, a function taken for drawn when only an event runs it is a game's
 * `tick`, and what it reads is all of the state that is held back for speed:
 * so the page is read exactly, expression by expression.
 */
import { describe, it, expect } from 'vitest';
import { parse } from '../src/parser';
import { collectDrawnNames, isCallbackProp, readsOfDrawnFunctions, type DrawnReads } from '../src/runtime/drawn-functions';

function drawn(markup: string): ReadonlySet<string> {
  const names = collectDrawnNames(parse(markup) as never);
  expect(names, 'the page should be walked').not.toBeNull();
  return names!;
}

/** What the functions in `called` may read in `code`, where every function the engine would hold is named. */
function reads(code: string, called: string[], functionNames: string[] = called): DrawnReads {
  return readsOfDrawnFunctions({ code, functionNames, drawn: new Set(called) });
}

function names(result: DrawnReads): ReadonlySet<string> {
  expect(result.known, result.known ? '' : `unknown: ${result.why}`).toBe(true);
  return (result as Extract<DrawnReads, { known: true }>).names;
}

function why(result: DrawnReads): string {
  expect(result.known).toBe(false);
  return (result as Extract<DrawnReads, { known: false }>).why;
}

describe('collectDrawnNames: what a page may call while it is drawn', () => {
  it('finds a call wherever the page is drawn with one', () => {
    const page = drawn(`<div>
  <p title={hint()}>{label()}</p>
  #if (big())
    <p>large</p>
  #end
  #each (item in rows())
    <p>{price(item)}</p>
  #end
  <p if={shown()}>x</p>
  <input :bind={field} />
</div>`);
    for (const name of ['hint', 'label', 'big', 'rows', 'price', 'shown', 'field', 'item']) {
      expect(page.has(name), name).toBe(true);
    }
  });

  it('leaves out what an event runs', () => {
    const page = drawn(`<div>
  <button @click={() => start()}>a</button>
  <button @click={stop}>b</button>
  <button @click={reset()}>c</button>
  <Loop @tick={tick} />
  <Loop onTick={beat} />
  <Loop onTick={() => pulse()} />
</div>`);
    for (const name of ['start', 'stop', 'reset', 'tick', 'beat', 'pulse', 'onTick']) {
      expect(page.has(name), name).toBe(false);
    }
  });

  it('keeps a name an event hands on rather than calls', () => {
    const page = drawn(`<div>
  <button @click={() => show(rowLabel)}>a</button>
  <button @click={() => chosen = pickLabel}>b</button>
</div>`);
    expect(page.has('rowLabel')).toBe(true);
    expect(page.has('pickLabel')).toBe(true);
    expect(page.has('show')).toBe(false);
  });

  it('treats either side of a choice between two handlers as a handler', () => {
    const page = drawn(`<div>
  <button @click={busy ? wait : save}>a</button>
  <button @click={ready && send}>b</button>
</div>`);
    expect(page.has('wait')).toBe(false);
    expect(page.has('save')).toBe(false);
    expect(page.has('send')).toBe(false);
    expect(page.has('busy')).toBe(true);
  });

  it('keeps a function a component is handed, named or called', () => {
    const page = drawn(`<div>
  <Chart format={(value) => money(value)} />
  <Progress formatLabel={percent} />
  <Table columns={[{ render: cell }, { render: (row) => total(row) }]} />
  <p>{rows.map(describe).join(", ")}</p>
</div>`);
    for (const name of ['money', 'percent', 'cell', 'total', 'describe', 'rows']) expect(page.has(name), name).toBe(true);
  });

  // The two props a component pulls through on its own clock. This is what
  // keeps an emulator's state in the engine: see PULLED_PROPS.
  it('leaves out what a canvas or an audio stream pulls from, however the prop is written', () => {
    const page = drawn(`<div>
  <PixelCanvas getFrame={frameSource} />
  <AudioStream getSamples={sampleSource} />
  <PixelCanvas getFrame={() => otherFrame()} />
</div>`);
    for (const name of ['frameSource', 'sampleSource', 'otherFrame']) expect(page.has(name), name).toBe(false);
  });

  it('reads expressions only: not the words of text, of a class, of a static attribute or of the style block', () => {
    const page = drawn(`<style>
.legend { transform: rotate(2deg); justify-content: flex-start; }
</style>
<div class="hold rebuy" title="fire to start">
  <p>rotate · hold · pick a tool</p>
  <p>{label()}</p>
</div>`);
    for (const name of ['rotate', 'hold', 'rebuy', 'fire', 'start', 'pick', 'legend']) {
      expect(page.has(name), name).toBe(false);
    }
    expect(page.has('label')).toBe(true);
  });

  it("does not take the document's own words for names", () => {
    // Every node carries `loc: { line, column, start, end }` and a `type`.
    const page = drawn('<p class="a">{label()}</p>');
    for (const name of ['start', 'end', 'line', 'column', 'loc', 'type', 'name', 'value', 'Identifier']) {
      expect(page.has(name), name).toBe(false);
    }
  });

  it('reads the name before a dot and not the key after it', () => {
    const page = drawn('<p>{user.name} {table[key]} {game.describe()}</p>');
    for (const name of ['user', 'table', 'key', 'game']) expect(page.has(name), name).toBe(true);
    expect(page.has('name')).toBe(false);
    expect(page.has('describe')).toBe(false);
  });

  it('finds a Unicode name whole', () => {
    expect(drawn('<p>{étiquette()}</p>').has('étiquette')).toBe(true);
  });

  it('agrees with the renderer about which props are callbacks', () => {
    expect(isCallbackProp('onTick')).toBe(true);
    expect(isCallbackProp('online')).toBe(true);
    expect(isCallbackProp('on')).toBe(false);
    expect(isCallbackProp('render')).toBe(false);
  });
});

describe('readsOfDrawnFunctions: what a drawn function may read', () => {
  it('is nothing, and reads no logic, when the page calls no function', () => {
    const result = readsOfDrawnFunctions({
      code: 'this is not even JavaScript "',
      functionNames: ['tick'],
      drawn: new Set(['score']),
    });
    expect(result).toEqual({ known: true, functions: [], names: new Set() });
  });

  it('reads the names in the function', () => {
    const read = names(reads('let n = 1\nlet other = 2\nfunction label() { return "n is " + n }', ['label']));
    expect(read.has('n')).toBe(true);
    expect(read.has('other')).toBe(false);
  });

  it('follows the functions it names, and the ones those name', () => {
    const code = `
let a = 1
let b = 2
let c = 3
let unrelated = 4
function deepest() { return c }
function inner() { return b + deepest() }
function label() { return a + inner() }
function tick() { unrelated = unrelated + 1 }
`;
    const read = names(reads(code, ['label'], ['deepest', 'inner', 'label', 'tick']));
    for (const name of ['a', 'b', 'c']) expect(read.has(name), name).toBe(true);
    expect(read.has('unrelated')).toBe(false);
  });

  it('follows a function passed by name rather than called', () => {
    const code = 'let rate = 2\nfunction price(x) { return x * rate }\nfunction label() { return [1, 2].map(price).join() }';
    expect(names(reads(code, ['label'], ['price', 'label'])).has('rate')).toBe(true);
  });

  it('follows a name to the declaration that gives it a function', () => {
    const code = `
let rate = 2
let tax = 3
const price = (x) => x * rate
let withTax = function (x) { return x + tax }
function label() { return withTax(price(1)) }
`;
    const read = names(reads(code, ['label']));
    expect(read.has('rate')).toBe(true);
    expect(read.has('tax')).toBe(true);
  });

  it('follows a method to where a class or a record defines it', () => {
    const code = `
let bonus = 1
let depth = 2
let shade = 3
class Game {
  describe() { return "g" + bonus }
  get total() { return depth }
}
let game = null
let palette = null
function start() { game = new Game(); palette = { tint: (x) => x + shade } }
function label() { return game.describe() + game.total + palette.tint(1) }
`;
    const read = names(reads(code, ['label'], ['Game', 'start', 'label']));
    for (const name of ['bonus', 'depth', 'shade']) expect(read.has(name), name).toBe(true);
  });

  it('follows a name that is called to wherever it is given something', () => {
    // `fmt = makeFormatter()` says nothing of a function, but `fmt(…)` does.
    const code = `
let unit = "kg"
let fmt = null
let score = 0
let entities = []
function makeFormatter() { return (x) => x + unit }
function setup() { fmt = makeFormatter() }
function tick() { score = score + entities.length }
function label() { return fmt(1) + score }
`;
    const read = names(reads(code, ['label'], ['makeFormatter', 'setup', 'tick', 'label']));
    expect(read.has('unit')).toBe(true);
    // `score` is read, not called: it does not lead to the tick that adds to it.
    expect(read.has('score')).toBe(true);
    expect(read.has('entities')).toBe(false);
  });

  it('follows a property given a function by assignment, in or out of a function', () => {
    const code = `
let hidden = 1
let deeper = 2
let api = {}
api.show = function () { return hidden }
function wire() { api.more = () => deeper }
function label() { return api.show() + api.more() }
`;
    const read = names(reads(code, ['label'], ['wire', 'label']));
    expect(read.has('hidden')).toBe(true);
    expect(read.has('deeper')).toBe(true);
  });

  it('follows a property named by a string where it is given a function', () => {
    const code = `
let hidden = 1
let deeper = 2
let api = {}
function wireShow() { api["show"] = function () { return hidden } }
function wireMore() { Object.assign(api, { "more": () => deeper }) }
function label() { return api.show() + api.more() }
`;
    const read = names(reads(code, ['label'], ['wireShow', 'wireMore', 'label']));
    expect(read.has('hidden')).toBe(true);
    expect(read.has('deeper')).toBe(true);
  });

  it('reads a name inside a template literal, and not the words of a string or a comment', () => {
    const code = [
      'let shown = 1',
      'let quoted = 2',
      'let noted = 3',
      'function label() {',
      '  // noted is not read here',
      '  /* nor here: noted */',
      '  return `is ${shown + 1}` + "quoted" + \'quoted\'',
      '}',
    ].join('\n');
    const read = names(reads(code, ['label']));
    expect(read.has('shown')).toBe(true);
    expect(read.has('quoted')).toBe(false);
    expect(read.has('noted')).toBe(false);
  });

  it('keeps its place through regular expressions, divisions and nested templates', () => {
    const code = [
      'let a = 8',
      'let b = 2',
      'let hit = 0',
      'let later = 5',
      'function ratio() { return a / b / 2 }',
      'function clean(s) { return s.replace(/[{"\'`]/g, "").split(/\\//).length + hit }',
      'function nested() { return `a${`b${a}c`}d` }',
      'function label() { return ratio() + clean("x") + nested() + after() }',
      'function after() { return later }',
    ].join('\n');
    const read = names(reads(code, ['label'], ['ratio', 'clean', 'nested', 'label', 'after']));
    for (const name of ['a', 'b', 'hit', 'later']) expect(read.has(name), name).toBe(true);
  });

  it('reads one statement for a name, not its neighbours', () => {
    // No semicolons: each declaration ends where the next line begins a statement.
    const code = `
let small = 1
let large = makeLarge()
let wide = small
  + 1
function makeLarge() { return secret }
let secret = 9
function label() { return small }
`;
    const read = names(reads(code, ['label'], ['makeLarge', 'label']));
    expect(read.has('small')).toBe(true);
    expect(read.has('large')).toBe(false);
    expect(read.has('secret')).toBe(false);
  });

  it('reads a declaration that runs over several lines to its end', () => {
    const code = `
let rate = 2
let limit = 3
const price =
  (x) =>
    x * rate
const capped = [1, 2]
  .map((x) => x + limit)
function label() { return price(1) + capped.length }
`;
    const read = names(reads(code, ['label']));
    expect(read.has('rate')).toBe(true);
    expect(read.has('limit')).toBe(true);
  });

  it('reads a function written out where it is called', () => {
    const code = 'let saved = 1\nlet dark = (function () { return saved > 0 })()\nfunction label() { return dark ? "d" : "l" }';
    expect(names(reads(code, ['label'])).has('saved')).toBe(true);
  });

  it('finds a Unicode name whole', () => {
    const read = names(reads('let café = 1\nfunction étiquette() { return café }', ['étiquette']));
    expect(read.has('café')).toBe(true);
    expect(read.has('caf')).toBe(false);
  });

  it('reads the functions a host hands the script, which read nothing of the app', () => {
    const code =
      'let __softnExternalValues = [1];\nfunction walletBalance() { return __softnExternalValues[0]; }\nlet shown = 1\nfunction label() { return walletBalance() + shown }';
    const read = names(reads(code, ['label'], ['walletBalance', 'label']));
    expect(read.has('shown')).toBe(true);
  });

  it('supposes every function is drawn when the page did not say', () => {
    const result = readsOfDrawnFunctions({
      code: 'let a = 1\nlet b = 2\nfunction one() { return a }\nfunction two() { return b }',
      functionNames: ['one', 'two'],
      drawn: null,
    });
    expect(result.functions).toEqual(['one', 'two']);
    expect(names(result).has('a')).toBe(true);
    expect(names(result).has('b')).toBe(true);
  });
});

describe('readsOfDrawnFunctions: when it cannot be worked out', () => {
  it('is unknown for Python', () => {
    const result = readsOfDrawnFunctions({ code: '', functionNames: ['label'], drawn: new Set(['label']), python: true });
    expect(why(result)).toMatch(/Python/);
  });

  it('is unknown when the logic cannot be read to its end', () => {
    expect(why(reads('function label() { return "open }', ['label']))).toMatch(/could not be read/);
    expect(why(reads('function label() { return (1 }', ['label']))).toMatch(/could not be read/);
    expect(why(reads('function label() { return 1 } /* open', ['label']))).toMatch(/could not be read/);
  });

  it('is unknown when a function the engine holds is not found in the text', () => {
    expect(why(reads('function label() { return 1 }', ['label'], ['label', 'elsewhere']))).toMatch(/elsewhere was not found/);
  });

  const DYNAMIC: Array<[string, string]> = [
    ['a function found by a name worked out as it runs', 'function label() { return handlers[kind](1) }'],
    ['the function a call gives back, called at once', 'function label() { return pick(kind)(1) }'],
    ['eval', 'function label() { return eval("n") }'],
    ['a function made from text', 'function label() { return new Function("return n")() }'],
    ['globalThis', 'function label() { return globalThis[name] }'],
    ['window by a worked-out name', 'function label() { return window[name] }'],
  ];
  for (const [what, code] of DYNAMIC) {
    it(`is unknown for ${what}`, () => {
      expect(reads(`let n = 1\nlet name = "n"\nlet kind = "a"\nlet handlers = {}\nfunction pick() {}\n${code}`, ['label'], ['pick', 'label']).known).toBe(false);
    });
  }

  it('is unknown when the function it cannot follow is one a drawn function reaches', () => {
    const code = 'let table = {}\nfunction lookup(k) { return table[k]() }\nfunction label() { return lookup("a") }';
    expect(reads(code, ['label'], ['lookup', 'label']).known).toBe(false);
  });

  it('is not unknown for what no drawn function reaches', () => {
    const code = 'let n = 1\nlet table = {}\nfunction dispatch(k) { return table[k]() }\nfunction label() { return n }';
    expect(reads(code, ['label'], ['dispatch', 'label']).known).toBe(true);
  });
});
