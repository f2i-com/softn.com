/**
 * How a Python app's state is read and written, on the engine it runs on.
 *
 * Every case here was first a probe that FAILED against the design this
 * replaces — a generated `__softn_set_<module>__` per author module, built
 * from a textual scan of its column-0 assignments — and each is kept as the
 * specification of what must never come back:
 *
 * - the setter's own parameters `name`/`value` were resolved as the module's
 *   globals when the app had globals of those names, so a host write of
 *   `{value: 7, count: 3}` left `{value: 50, count: 50}` behind (A1);
 * - a `count` defined in two modules was read from the last one and written
 *   to the first, so a write never showed up in a read (A2);
 * - `lambda = 1` inside a docstring became `global lambda`, and the whole app
 *   failed to compile with the error blamed on the author's own line (B1);
 * - `a, b = 0, 0`, `x = y = 0`, an indented assignment, a name created with
 *   `global` inside a function and a non-ASCII identifier were all OFFERED as
 *   state and then silently not written (B2);
 * - a dict subclass whose `items()` raised took every other variable with it
 *   when state was read (B3).
 *
 * The replacement resolves the owning module of a name once, from the same
 * table `__softn_symbols__` reports, and writes with `setattr` on that
 * module. That last part is a ZIPP 0.0.19 property — on 0.0.18 a `setattr`
 * from another module was not visible to the module's own functions, which
 * FormLogic's Python corpus case `zipp-defect-cross-module-setattr` pinned as
 * a defect and now pins as fixed — so it is asserted here by name, against the
 * raw engine, before anything built on it is.
 *
 * This file is excluded from `vitest.host-js.config.ts` for the same reason
 * `python-logic.test.tsx` is: the host-JavaScript engine cannot run Python,
 * which `python-engine-choice.test.ts` asserts in both runs.
 */

import { describe, expect, it, vi } from 'vitest';
import { Engine } from '../wasm-zipp/zipp_wasm.js';
import { PythonLogicAdapter } from '../src/runtime/python/python-logic-adapter';
import { SOFTN_PY, mainSource } from '../src/runtime/python/python-runtime-source';

const ENTRY = '__softn_main__';

/** The files the adapter would send, for the given author modules in import order. */
function projectFiles(modules: Record<string, string>): Record<string, string> {
  const order = Object.keys(modules);
  const files: Record<string, string> = { [`${ENTRY}.py`]: mainSource(order), 'softn.py': SOFTN_PY };
  for (const name of order) files[`${name}.py`] = modules[name];
  return files;
}

/** Run `fn` against a raw engine holding the generated project; always freed. */
function withEngine<T>(files: Record<string, string>, entry: string, fn: (engine: Engine) => T): T {
  const engine = new Engine();
  try {
    engine.setInstructionBudget(50_000_000);
    engine.initPythonProject(files, entry, []);
    return fn(engine);
  } finally {
    try {
      engine.dispose();
    } finally {
      engine.free();
    }
  }
}

/** The adapter over the given author modules, in import order. */
async function adapterFor(modules: Record<string, string>) {
  const adapter = await PythonLogicAdapter.create();
  const symbols = await adapter.initializePythonProject({ files: modules, modules: Object.keys(modules) });
  return { adapter, symbols, index: (name: string) => symbols.get(name)!.index };
}

type Rows = Array<[string, string, string]>;

describe('the ZIPP primitive the write design stands on (zipp-defect-cross-module-setattr, fixed in 0.0.19)', () => {
  const app = 'count = 0\ndef read():\n    return count\n';

  it('setattr on an imported module is visible to that module’s own functions', () => {
    // If this fails, the engine has regressed to 0.0.18 behaviour and every
    // host write below would land in a dict nobody reads. Fail here, by name.
    const seen = withEngine(
      { 'app.py': app, 'main.py': 'import app as _m\ndef w(v):\n    setattr(_m, "count", v)\n    return _m.read()\n' },
      'main',
      (engine) => engine.pythonCall('w', [7])
    );
    expect(seen).toBe(7);
  });

  it('and vars(module)[name] = value is NOT, which is why the design does not use it', () => {
    // Documented so nobody "simplifies" setattr into a dict store: the dict
    // the host reads and the globals the functions see are not the same thing.
    const seen = withEngine(
      { 'app.py': app, 'main.py': 'import app as _m\ndef w(v):\n    vars(_m)["count"] = v\n    return _m.read()\n' },
      'main',
      (engine) => engine.pythonCall('w', [7])
    );
    expect(seen).toBe(0);
  });
});

describe('a host write lands where the app reads (A1)', () => {
  it('writes value and count when the app has globals named value and count', () => {
    const files = projectFiles({ main: 'value = 50\ncount = 0\ndef show():\n    return [value, count]\n' });
    const out = withEngine(files, ENTRY, (engine) => ({
      refused: engine.pythonCall('__softn_write__', [{ value: 7, count: 3 }]),
      state: engine.pythonCall('__softn_state__', [['value', 'count']]),
      show: engine.pythonCall('show', []),
    }));
    expect(out.refused).toEqual([]);
    expect(out.state).toEqual({ value: 7, count: 3 });
    expect(out.show).toEqual([7, 3]);
  });

  it('writes count when the app has a global named name', () => {
    const files = projectFiles({ main: 'name = "Ada"\ncount = 0\ndef show():\n    return [name, count]\n' });
    const out = withEngine(files, ENTRY, (engine) => ({
      refused: engine.pythonCall('__softn_write__', [{ count: 3 }]),
      state: engine.pythonCall('__softn_state__', [['name', 'count']]),
      show: engine.pythonCall('show', []),
    }));
    expect(out.refused).toEqual([]);
    expect(out.state).toEqual({ name: 'Ada', count: 3 });
    expect(out.show).toEqual(['Ada', 3]);
  });
});

describe('read and write name the same module (A2)', () => {
  const modules = { helpers: 'count = 100\ndef hread():\n    return count\n', main: 'count = 0\ndef read():\n    return count\n' };

  it('a write is visible to the next read, and to the module the symbols named', () => {
    const out = withEngine(projectFiles(modules), ENTRY, (engine) => {
      const symbols = engine.pythonCall('__softn_symbols__', []) as Rows;
      const before = engine.pythonCall('__softn_state__', [['count']]);
      const refused = engine.pythonCall('__softn_write__', [{ count: 7 }]);
      const after = engine.pythonCall('__softn_state__', [['count']]);
      return { owner: symbols.find((row) => row[0] === 'count')![2], before, refused, after, read: engine.pythonCall('read', []), hread: engine.pythonCall('hread', []) };
    });
    // The entry module wins the name, as it does for a template calling
    // `read()` after both star-imports; the write goes to the same place.
    expect(out.owner).toBe('main');
    expect(out.before).toEqual({ count: 0 });
    expect(out.refused).toEqual([]);
    expect(out.after).toEqual({ count: 7 });
    expect(out.read).toBe(7);
    expect(out.hread).toBe(100);
  });

  it('numbers the symbols in first-seen order with the later module as owner', () => {
    const rows = withEngine(projectFiles(modules), ENTRY, (engine) => engine.pythonCall('__softn_symbols__', []) as Rows);
    expect(rows).toEqual([
      ['count', 'variable', 'main'],
      ['hread', 'function', 'helpers'],
      ['read', 'function', 'main'],
    ]);
  });
});

describe('nothing is scanned, so nothing is misread (B1) or missed (B2)', () => {
  it('compiles a docstring that contains a keyword assignment', () => {
    const files = projectFiles({ main: '"""\nlambda = 1\n"""\nx = 1\n' });
    const out = withEngine(files, ENTRY, (engine) => ({
      state: engine.pythonCall('__softn_state__', [['x']]),
      refused: engine.pythonCall('__softn_write__', [{ x: 2 }]),
      after: engine.pythonCall('__softn_state__', [['x']]),
    }));
    expect(out.state).toEqual({ x: 1 });
    expect(out.refused).toEqual([]);
    expect(out.after).toEqual({ x: 2 });
  });

  it('writes every name it offers, whatever the assignment looked like', () => {
    const source = [
      'a, b = 0, 0',
      'x = y = 0',
      'if True:',
      '    flag = 1',
      'café = 1',
      'def show():',
      '    return [a, b, x, y, flag, café]',
    ].join('\n');
    const out = withEngine(projectFiles({ main: source }), ENTRY, (engine) => {
      const offered = (engine.pythonCall('__softn_symbols__', []) as Rows).filter((r) => r[1] === 'variable').map((r) => r[0]);
      const refused = engine.pythonCall('__softn_write__', [{ a: 1, b: 2, x: 3, y: 4, flag: 0, 'café': 9 }]);
      return { offered, refused, show: engine.pythonCall('show', []) };
    });
    expect(out.offered.sort()).toEqual(['a', 'b', 'café', 'flag', 'x', 'y']);
    expect(out.refused).toEqual([]);
    expect(out.show).toEqual([1, 2, 3, 4, 0, 9]);
  });

  it('writes a name a function created with global after the symbols were read', () => {
    const source = 'def _init():\n    global late\n    late = 5\ndef show():\n    return late\n';
    const out = withEngine(projectFiles({ main: source }), ENTRY, (engine) => {
      const before = (engine.pythonCall('__softn_symbols__', []) as Rows).map((r) => r[0]);
      engine.pythonCall('_init', []);
      const refused = engine.pythonCall('__softn_write__', [{ late: 9 }]);
      return { before, refused, state: engine.pythonCall('__softn_state__', [['late']]), show: engine.pythonCall('show', []) };
    });
    expect(out.before).not.toContain('late');
    expect(out.refused).toEqual([]);
    expect(out.state).toEqual({ late: 9 });
    expect(out.show).toBe(9);
  });

  it('refuses, by name, a name it never offered and a function', () => {
    const source = '_private = 1\ncount = 0\nclass Thing:\n    pass\nthing = Thing()\ndef f():\n    return 1\n';
    const out = withEngine(projectFiles({ main: source }), ENTRY, (engine) => ({
      refused: engine.pythonCall('__softn_write__', [{ count: 1, nope: 1, _private: 2, thing: {}, f: 3 }]),
      f: engine.pythonCall('f', []),
      state: engine.pythonCall('__softn_state__', [['count', 'nope', '_private']]),
    }));
    expect(out.refused).toEqual(['nope', '_private', 'thing', 'f']);
    expect(out.f).toBe(1);
    expect(out.state).toEqual({ count: 1 });
  });
});

describe('reading state cannot fail, and one value cannot take the rest (B3)', () => {
  it('reads a value whose projection raises as None and the others as themselves', () => {
    const source = 'class D(dict):\n    def items(self):\n        raise RuntimeError("boom")\nbad = D()\ngood = 1\nalso = "x"\n';
    const state = withEngine(projectFiles({ main: source }), ENTRY, (engine) =>
      engine.pythonCall('__softn_state__', [['good', 'bad', 'also']])
    );
    expect(state).toEqual({ good: 1, bad: null, also: 'x' });
  });
});

describe('the adapter surfaces a write that did not land', () => {
  it('writes through the slots the symbol map numbers, and reads them back', async () => {
    const { adapter, index } = await adapterFor({
      helpers: 'count = 100\n',
      app: 'value = 50\ncount = 0\ndef show():\n    return [value, count]\n',
    });
    try {
      adapter.setGlobalsBatch([index('value'), index('count')], [7, 3]);
      expect(adapter.getGlobalsBatch([index('value'), index('count')])).toEqual([7, 3]);
      expect(adapter.callFunction('show', [])).toEqual([7, 3]);
      adapter.setGlobal(index('count'), 4);
      expect(adapter.getGlobal(index('count'))).toBe(4);
    } finally {
      adapter.dispose();
    }
  });

  it('throws, naming the variables, rather than counting them and moving on', async () => {
    // The runtime only writes names it got from the symbol table, and the
    // table's owner is written whatever the module holds now, so through the
    // adapter a refusal is unreachable by construction. It is still the one
    // answer the engine can give that must not be dropped on the floor — the
    // old adapter discarded the count — so the engine is made to give it.
    const { adapter, index } = await adapterFor({ app: 'count = 0\nother = 1\n' });
    const wasm = (adapter as unknown as { wasm: Engine }).wasm;
    const real = wasm.pythonCall.bind(wasm);
    const spy = vi.spyOn(wasm, 'pythonCall').mockImplementation((name: string, args: unknown[]) => {
      const answer = real(name, args);
      return name === '__softn_write__' ? ['count', 'other'] : answer;
    });
    try {
      expect(() => adapter.setGlobalsBatch([index('count'), index('other')], [5, 6])).toThrow(
        /offered `count`, `other` as state but would not take them back/
      );
      expect(() => adapter.setGlobal(index('count'), 7)).toThrow(/offered `count`, `other` as state/);
      // The write itself still went through to the engine before the answer
      // was read: nothing is refused on the host's side of the boundary.
      spy.mockRestore();
      expect(adapter.getGlobalsBatch([index('count'), index('other')])).toEqual([7, 6]);
    } finally {
      spy.mockRestore();
      adapter.dispose();
    }
  });
});
