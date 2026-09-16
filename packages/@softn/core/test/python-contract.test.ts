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
 *   wrote, and each of their own modules has a setter appended. An error that
 *   named one of those would be an error they could not act on.
 */

import { describe, expect, it } from 'vitest';
import { SOFTN_BRIDGE_PREAMBLE } from '../src/runtime/softn-preamble';
import {
  PYTHON_CAPABILITY_KINDS,
  PYTHON_NAMESPACES,
  SOFTN_PY,
  mainSource,
  scanTopLevelNames,
  setterSource,
  snakeCase,
} from '../src/runtime/python/python-runtime-source';
import { authorMessage, lineCount } from '../src/runtime/python/python-errors';

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

describe('the generated setter', () => {
  it('finds the names a module assigns at column 0', () => {
    const names = scanTopLevelNames(
      [
        'count = 0',
        'title: str = "hi"',
        'total += 1',
        'a, b = 1, 2',
        '_private = 1',
        '    indented = 1',
        'def f():',
        '    inner = 1',
        'is_equal = x == y',
      ].join('\n')
    );
    expect(names).toContain('count');
    expect(names).toContain('title');
    expect(names).toContain('total');
    expect(names).toContain('is_equal');
    // Underscore names are the module's own business; indented ones are not
    // module globals.
    expect(names).not.toContain('_private');
    expect(names).not.toContain('indented');
    expect(names).not.toContain('inner');
  });

  it('is appended, so the author’s lines keep the numbers they wrote', () => {
    const source = 'count = 0\n';
    const setter = setterSource('app', scanTopLevelNames(source));
    expect(setter.startsWith('\n')).toBe(true);
    expect(setter).toContain('def __softn_set_app__(name, value):');
    expect(setter).toContain('global count');
    expect((source + setter).startsWith(source)).toBe(true);
  });

  it('answers False for a module that assigns nothing, rather than not existing', () => {
    // `main.py` imports the setter from every module; one that had none would
    // be an ImportError about a generated name.
    expect(setterSource('helpers', [])).toContain('def __softn_set_helpers__(name, value):');
    expect(setterSource('helpers', [])).toContain('return False');
  });
});

describe('an error in the author’s terms', () => {
  const lines = new Map([['app', 2]]);

  it('folds a location past the end of the file back onto their last line', () => {
    // Python reports an unterminated bracket at the end of the file, and the
    // file now ends with a generated setter.
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
