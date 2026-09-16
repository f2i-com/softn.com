/**
 * The Python side of the app contract, without an engine.
 *
 * Two things are pinned here and both are about drift:
 *
 * - **Capability parity.** `softn.*` is one capability set, not one per
 *   language. The JavaScript preamble is the list everything else was built
 *   against, so this reads the kinds straight out of it and fails if the
 *   Python facade stops offering the same ones. A capability added for one
 *   language and forgotten for the other is a red test, not a support ticket.
 * - **Whose line is it.** A Python project carries files the author never
 *   wrote. An error that named one of those, or a line past the end of a file
 *   they did write, would be an error they could not act on.
 * - **One symbol table.** The entry the adapter calls resolves every read and
 *   write of state through one owner lookup, writes with `setattr`, and
 *   appends nothing to the author's modules. The engine-level proof is in
 *   `python-state-write.test.ts`; what is pinned here is the shape of the
 *   generated source, so a regression to a per-module setter or a textual
 *   scan is a red test before it is a corrupted app.
 */

import { describe, expect, it } from 'vitest';
import { SOFTN_BRIDGE_PREAMBLE } from '../src/runtime/softn-preamble';
import {
  PYTHON_CAPABILITY_KINDS,
  PYTHON_NAMESPACES,
  SOFTN_PY,
  SOFTN_PY_IMPORTS,
  mainSource,
  snakeCase,
} from '../src/runtime/python/python-runtime-source';
import { authorMessage, lineCount } from '../src/runtime/python/python-errors';
import { SOFTN_PY_STDLIB_IMPORTS, pythonModuleName } from '../src/bundle/source-composer';

/** Every `host.call("<kind>"` the JavaScript guest's preamble can make. */
function javascriptKinds(): string[] {
  const kinds = [...SOFTN_BRIDGE_PREAMBLE.matchAll(/host\.call\("([^"]+)"/g)].map((m) => m[1]);
  return [...new Set(kinds)].sort();
}

describe('one capability set, two languages', () => {
  it('offers a Python app every kind a JavaScript app can reach', () => {
    const javascript = javascriptKinds();
    expect(javascript.length).toBeGreaterThan(50);
    expect([...new Set(PYTHON_CAPABILITY_KINDS)].sort()).toEqual(javascript);
  });

  it('names no kind the host would not answer', () => {
    // The other direction: a Python-only kind would be a call that reaches
    // `executeHostCall` and falls off the end of its switch.
    for (const kind of PYTHON_CAPABILITY_KINDS) {
      expect(SOFTN_BRIDGE_PREAMBLE).toContain(`host.call("${kind}"`);
    }
  });

  it('binds every namespace the app writes before the dot', () => {
    for (const namespace of PYTHON_NAMESPACES) {
      expect(SOFTN_PY).toContain(`\n${namespace} = _Ns_`);
    }
    expect(PYTHON_NAMESPACES).toContain('storage');
    expect(PYTHON_NAMESPACES).toContain('backend');
  });

  it('gives a method both its Python name and the name a JavaScript author knows', () => {
    expect(snakeCase('capturePhoto')).toBe('capture_photo');
    expect(snakeCase('readZipText')).toBe('read_zip_text');
    expect(snakeCase('call')).toBe('call');
    expect(SOFTN_PY).toContain('def capture_photo(');
    expect(SOFTN_PY).toContain('capturePhoto = capture_photo');
    // And the primitive underneath, so a capability this table somehow missed
    // is still reachable rather than unreachable.
    expect(SOFTN_PY).toContain('def call(kind, args, callback=None):');
  });

  it('declares the entry points the adapter calls and nothing an app would name', () => {
    const main = mainSource(['app']);
    for (const name of [
      '__softn_symbols__',
      '__softn_state__',
      '__softn_write__',
      '__softn_drain__',
      '__softn_deliver__',
      '__softn_listeners__',
      '__softn_dispatch__',
    ]) {
      expect(main).toContain(`def ${name}(`);
    }
    // Every author module is both star-imported (so a template can call a
    // function by its bare name) and held as a module (so state can be read
    // and written where it lives).
    const two = mainSource(['helpers', 'app']);
    expect(two).toContain('import helpers as _m_helpers');
    expect(two).toContain('from helpers import *');
    expect(two).toContain('_MODULES = [_m_helpers, _m_app]');
  });

  it('carries the host’s one-time setup hook across the star-import', () => {
    // `from app import *` does not carry a name starting with `_`, so an
    // author's `def _init()` would exist in their module and be invisible to
    // the entry the host actually calls. The entry forwards to it, and the
    // symbol scan lets that one underscore name through so the host knows to
    // call it at all. Both halves are needed; either alone is a silent no-op.
    const main = mainSource(['app']);
    expect(main).toContain('def _init():');
    expect(main).toContain('vars(m).get("_init")');
    expect(main).toContain('_HOST_NAMES = ("_init",)');
    expect(main).toContain('if k.startswith("_") and k not in _HOST_NAMES:');
  });
});

describe('one symbol table for reads and writes', () => {
  const main = mainSource(['helpers', 'app']);

  it('resolves every read and write through the owner the symbols reported', () => {
    // The three entry points share `_owner`; none has a lookup of its own.
    expect(main).toContain('def _owner(k):');
    expect(main).toContain('def _resolve():');
    expect(main.match(/hit = _owner\(k\)/g)).toHaveLength(2);
    expect(main).toContain('return [[k, kind, m.__name__] for k, (m, kind) in _OWNERS.items()]');
    // The write is setattr on the owning module: on ZIPP a `vars(m)[k] = v`
    // updates the dict the host reads and not the globals the module's own
    // functions see, which is a silent corruption rather than a write.
    expect(main).toContain('setattr(hit[0], k, v)');
    expect(main).not.toMatch(/vars\([^)]*\)\[[^\]]*\]\s*=/);
    // What did not land is answered by name, not folded into a count.
    expect(main).toContain('refused.append(k)');
    expect(main).toContain('return refused');
  });

  it('reads each name under its own guard, so one bad value cannot take the rest', () => {
    const read = main.slice(main.indexOf('def __softn_state__'), main.indexOf('def __softn_write__'));
    expect(read).toContain('try:');
    expect(read).toContain('result[k] = _softn._project(getattr(hit[0], k))');
    expect(read).toContain('except Exception:');
    expect(read).toContain('result[k] = None');
  });

  it('adds nothing to the author’s modules and scans nothing textually', () => {
    // No per-module setter is imported or generated, so no keyword inside a
    // docstring can become a `global` list, and no assignment shape the scan
    // did not know — `a, b = 0, 0`, `x = y = 0`, an indented one — can be
    // offered as state and then not written.
    expect(main).not.toContain('__softn_set_');
    expect(main).not.toContain('_SETTERS');
    expect(main).not.toContain('global ');
    // The star-imports and the module handles are what remain.
    expect(main).toContain('import helpers as _m_helpers');
    expect(main).toContain('from helpers import *');
    expect(main).toContain('_MODULES = [_m_helpers, _m_app]');
  });

  it('refuses a function as a write target, as the old setters did', () => {
    expect(main).toContain('if hit is None or hit[1] != "variable":');
  });
});

describe('the modules softn.py imports are the runtime’s, not the app’s', () => {
  it('reads them out of the generated source', () => {
    expect([...SOFTN_PY_IMPORTS].sort()).toEqual(['json', 'math']);
  });

  it('is exactly the list the composer reserves', () => {
    // The composer is on the bundle side and does not import the runtime, so
    // the list is written twice; this is what keeps the two copies one list.
    expect([...SOFTN_PY_STDLIB_IMPORTS].sort()).toEqual([...SOFTN_PY_IMPORTS].sort());
    for (const name of SOFTN_PY_IMPORTS) {
      expect(() => pythonModuleName(`${name}.py`)).toThrow(/reserved module name/);
      expect(() => pythonModuleName(`lib/${name}.py`)).toThrow(new RegExp(`standard library's ${name}`));
    }
  });
});

describe('an error in the author’s terms', () => {
  const lines = new Map([['app', 2]]);

  it('folds a location past the end of the file back onto their last line', () => {
    // Python reports an unterminated bracket at the position after the last
    // line, which is a line the author's editor does not have.
    expect(authorMessage('SyntaxError: unexpected EOF while parsing (app.py:14:1)', lines)).toBe(
      'SyntaxError: unexpected EOF while parsing (app.py:2:1)'
    );
    expect(authorMessage('Python: app.py:99: bad', lines)).toBe('Python: app.py:2: bad');
    expect(authorMessage('  File "app.py", line 40, in add', lines)).toBe('  File "app.py", line 2, in add');
  });

  it('leaves a line the author really wrote alone', () => {
    expect(authorMessage('NameError: double (app.py:1)', lines)).toBe('NameError: double (app.py:1)');
  });

  it('drops the frames of files the runtime generated', () => {
    const raw = [
      'Traceback (most recent call last):',
      '  File "__softn_main__.py", line 12, in __softn_dispatch__',
      '  File "softn.py", line 40, in call',
      '  File "app.py", line 1, in on_key',
      'NameError: nope',
    ].join('\n');
    const out = authorMessage(raw, lines);
    expect(out).not.toContain('__softn_main__.py');
    expect(out).not.toContain('softn.py');
    expect(out).toContain('File "app.py", line 1, in on_key');
    expect(out).toContain('NameError: nope');
  });

  it('drops the repeat marker that belonged to a dropped frame', () => {
    const raw = [
      '  File "softn.py", line 40, in call',
      '  [Previous line repeated 3 more times]',
      '  File "app.py", line 1, in go',
    ].join('\n');
    const out = authorMessage(raw, lines);
    expect(out).not.toContain('Previous line repeated');
    expect(out).toContain('app.py');
  });

  it('counts an author’s lines the way a person would', () => {
    expect(lineCount('a = 1\n')).toBe(1);
    expect(lineCount('a = 1\nb = 2\n')).toBe(2);
    expect(lineCount('a = 1')).toBe(1);
    expect(lineCount('')).toBe(1);
  });
});
