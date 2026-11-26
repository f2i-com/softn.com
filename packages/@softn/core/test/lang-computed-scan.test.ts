/**
 * Finding a script's `$:` declarations, and the names each one reads.
 *
 * The scan passed over comments and strings but not regular expressions, so
 * a pattern in the logic, anywhere above a `$:`, could hide it:
 *
 *   const quote = /"/g          // the `"` began a string that ran to the next quote
 *   $: label = "n is " + n      // never found: run once as the script loaded, and never again
 *
 * and a brace in one (`/[{]/`) was counted as an open block, so every `$:`
 * after it was taken for one written inside a function and left unsettled.
 * Either way the value stood at its first for as long as the app ran, in
 * logic and on the page.
 *
 * A `$:` name was read with `\w`, so `$: café = …`, `$: tổng = …` and
 * `$: $total = …` were not declarations at all. And a template literal was
 * read as code, so the apostrophe of `` `It's ${count}` `` hid `count` and
 * every name after it from the order the values are worked out in.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractComputedDeclarations, namesReadBy, planComputed } from '../src/runtime/computed-declarations';
import {
  createConsoleModule,
  createMockNavModule,
  createMockXDBModule,
  createScriptRuntime,
  type ScriptContext,
} from '../src/runtime/script-runtime';
import type { LogicBlock } from '../src/parser/ast';

const found = (code: string) => extractComputedDeclarations(code).map(({ name, expression, topLevel }) => ({ name, expression, topLevel }));

describe('a regular expression above a $: declaration', () => {
  it('does not hide the declaration when it holds a quote', () => {
    expect(found('const quote = /"/g\n$: label = name + "!"\n$: other = 1')).toEqual([
      { name: 'label', expression: 'name + "!"', topLevel: true },
      { name: 'other', expression: '1', topLevel: true },
    ]);
    expect(found("function esc(s) { return s.replace(/'/g, \"\\\\'\") }\n$: total = a + b")).toEqual([
      { name: 'total', expression: 'a + b', topLevel: true },
    ]);
  });

  it('does not open a block when it holds a brace', () => {
    expect(found('function isOpen(s) { return /[{]/.test(s) }\n$: double = n * 2')).toEqual([
      { name: 'double', expression: 'n * 2', topLevel: true },
    ]);
    expect(found('const close = /\\}/;\nif (x) {\n  $: inner = 1\n}\n$: outer = 2')).toEqual([
      { name: 'inner', expression: '1', topLevel: false },
      { name: 'outer', expression: '2', topLevel: true },
    ]);
  });

  it('still reads a division as one', () => {
    expect(found('let half = total / 2 / count\nlet q = (a + b) / c, r = arr[0] / "x".length\n$: d = 1')).toEqual([
      { name: 'd', expression: '1', topLevel: true },
    ]);
    expect(found('let s = "a/b" / 2\n$: e = n')).toEqual([{ name: 'e', expression: 'n', topLevel: true }]);
  });

  it('reads one that begins a statement', () => {
    expect(found('go();\n/"/.test(s) && run()\n$: b = 2')).toEqual([{ name: 'b', expression: '2', topLevel: true }]);
    expect(found('if (x) {\n}\n/{/.test(s) && run()\n$: c = 3')).toEqual([{ name: 'c', expression: '3', topLevel: true }]);
  });
});

describe('the name of a $: declaration', () => {
  it('is read whole past ASCII, and may begin with $', () => {
    expect(found('$: café = n * 2\n$: tổng = a + b\n$: $total = 3\n$: なまえ = "x"').map((d) => d.name)).toEqual([
      'café',
      'tổng',
      '$total',
      'なまえ',
    ]);
  });

  it('is not one that begins with a digit', () => {
    expect(found('$: 2x = 1')).toEqual([]);
  });
});

describe('the names a $: expression reads', () => {
  it('reads past an apostrophe in a template literal', () => {
    expect([...namesReadBy("`It's ${count} items` + other")]).toEqual(['count', 'other']);
  });

  it('reads the code of each ${…}, nested ones too, and nothing of the text', () => {
    expect([...namesReadBy('`a ${`b ${inner} ${"}"}`} c ${ { k: v }.k }` + outer')]).toEqual(['inner', 'k', 'v', 'outer']);
  });

  it('orders a value after one its template reads', () => {
    const plan = planComputed(extractComputedDeclarations("$: msg = `It's ${total}`\n$: total = n + 1"));
    expect(plan.order.map((d) => d.name)).toEqual(['total', 'msg']);
  });
});

describe('a $: value under a regular expression, run', () => {
  const open: Array<() => void> = [];
  afterEach(() => {
    while (open.length > 0) open.pop()?.();
    vi.restoreAllMocks();
  });

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
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const runtime = createScriptRuntime(context);
    open.push(() => runtime.cleanup());
    const block: LogicBlock = { type: 'LogicBlock', code, loc: { line: 1, column: 0, start: 0, end: code.length } };
    return runtime.loadScript(block);
  }

  for (const [what, pattern] of [
    ['a quote', 'const quoteRe = /"/g'],
    ['a brace', 'function isOpen(s) { return /[{]/.test(s) }'],
  ] as const) {
    it(`is worked out again after a change, with ${what} in a pattern above it`, async () => {
      const loaded = await load(`
let n = 1
${pattern}
$: label = "n" + n
function bump() { n = n + 1 }
function show() { return label }
`);
      expect(Object.keys(loaded.computed)).toEqual(['label']);
      await loaded.functions.bump();
      expect(loaded.computed.label()).toBe('n2');
      expect(loaded.syncFunctions.show()).toBe('n2');
    });
  }
});
