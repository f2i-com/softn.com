/**
 * What makes a bundle's logic Python, and what the composer refuses.
 *
 * The file name is the whole declaration: a logic file ending `.py` is Python
 * and nothing else says so. That is deliberate — the same rule the hosted
 * shell applies before it chooses an engine and the same rule FormLogic
 * applies on the server, so an app cannot be one language to whoever picked
 * the engine and another to the engine.
 *
 * Pure functions, so this runs on both engines: an app that is Python is
 * refused the same way by a runtime that cannot run Python as by one that can.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  composeBundleSource,
  isPythonLogicPath,
  pythonModuleName,
  PYTHON_LOGIC_SUFFIX,
} from '../src/bundle/source-composer';

const ui = (body: string) => new Map<string, string>([['app.softn', body]]);

/** The repository root, for reading the other two declarations of the rule. */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('one rule, wherever it is applied', () => {
  it('the shell and the editor say the same thing this module says', () => {
    // Three packages decide what makes a file Python, and none of them can
    // import from the others: the hosted shell's `engineInit.ts` is
    // deliberately dependency-free so it can be read and run on its own, and
    // the Builder's copy has to load without Monaco. They are read here
    // instead, the way the packager reads the engine list out of the shell,
    // so the three cannot drift apart without this failing.
    const declarations = [
      'apps/formlogic-host/src/engineInit.ts',
      'apps/softn-builder/src/components/editor/logicLanguage.ts',
    ];
    for (const file of declarations) {
      const source = readFileSync(resolve(root, file), 'utf8');
      const declared = source.match(/PYTHON_LOGIC_SUFFIX\s*=\s*'([^']+)'/)?.[1];
      expect(declared, `${file} declares the suffix`).toBe(PYTHON_LOGIC_SUFFIX);
    }
  });
});

describe('a .py logic file is Python', () => {
  it('recognises the suffix, and only the suffix', () => {
    expect(PYTHON_LOGIC_SUFFIX).toBe('.py');
    expect(isPythonLogicPath('app.py')).toBe(true);
    expect(isPythonLogicPath('lib/helpers.py')).toBe(true);
    expect(isPythonLogicPath('app.PY')).toBe(true);
    expect(isPythonLogicPath('app.logic')).toBe(false);
    expect(isPythonLogicPath('a.py.logic')).toBe(false);
    expect(isPythonLogicPath('python')).toBe(false);
  });

  it('imports a module by its file name', () => {
    expect(pythonModuleName('app.py')).toBe('app');
    expect(pythonModuleName('lib/deep/helpers.py')).toBe('helpers');
    // Python imports by module name, so a name Python could not import is
    // refused here rather than becoming an import error about a generated file.
    expect(() => pythonModuleName('my-helpers.py')).toThrow(/letters, digits and underscores/);
    expect(() => pythonModuleName('2fast.py')).toThrow(/letters, digits and underscores/);
    // `softn` is the module an app imports, so it is the app's to import
    // and not to define; every other generated name starts `__softn`.
    expect(() => pythonModuleName('softn.py')).toThrow(/reserved module name softn\.py/);
    expect(() => pythonModuleName('__softn_main__.py')).toThrow(/reserved module name/);
    // `main.py` is NOT reserved: it is what the Builder's `logic/main.logic`
    // becomes, and taking the most natural file name away from an author to
    // make room for a generated one would be the wrong trade.
    expect(pythonModuleName('logic/main.py')).toBe('main');
  });
});

describe('composing a Python bundle', () => {
  const files = () =>
    new Map<string, string>([
      ['app.softn', '<logic src="./helpers.py" />\n<logic src="./app.py" />\n<p>hi</p>'],
      ['helpers.py', 'def double(x):\n    return x * 2\n'],
      ['app.py', 'count = 0\n'],
    ]);

  it('routes the modules out of the markup and leaves the logic block empty', () => {
    const composed = composeBundleSource(files(), 'app.softn');
    expect(composed.languages).toEqual(['javascript', 'python']);
    expect(composed.python).toEqual({
      files: { helpers: 'def double(x):\n    return x * 2\n', app: 'count = 0\n' },
      modules: ['helpers', 'app'],
    });
    // The document still has a logic block, so the renderer still builds a
    // runtime and the template still calls named functions through it. What it
    // does not have is any of the author's code, because that is not
    // JavaScript.
    expect(composed.source).toContain('<logic>\n</logic>');
    expect(composed.source).not.toContain('def double');
  });

  it('keeps the author’s source exactly as written', () => {
    // A JavaScript fragment has its `import "./x.logic"` lines rewritten to
    // bundle-root paths. Python has no such line, and rewriting anything would
    // edit source whose indentation carries meaning.
    const source = 'import helpers\n\nTEXT = """\nimport "./elsewhere.logic"\n"""\n';
    const map = new Map<string, string>([
      ['app.softn', '<logic src="./app.py" />'],
      ['app.py', source],
    ]);
    expect(composeBundleSource(map, 'app.softn').python?.files.app).toBe(source);
  });

  it('takes modules the manifest lists, in the manifest’s order', () => {
    const map = new Map<string, string>([
      ['app.softn', '<logic src="./app.py" />'],
      ['app.py', 'count = 0\n'],
      ['helpers.py', 'def double(x):\n    return x * 2\n'],
    ]);
    const composed = composeBundleSource(map, 'app.softn', ['helpers.py']);
    expect(composed.python?.modules).toEqual(['helpers', 'app']);
  });

  it('refuses two modules that would be the same import', () => {
    const map = new Map<string, string>([
      ['app.softn', '<logic src="./a/util.py" />\n<logic src="./b/util.py" />'],
      ['a/util.py', 'x = 1\n'],
      ['b/util.py', 'y = 2\n'],
    ]);
    expect(() => composeBundleSource(map, 'app.softn')).toThrow(/both named util\.py/);
  });
});

describe('what a Python bundle may not do', () => {
  it('refuses inline Python, because markup indentation is not reliable', () => {
    for (const attribute of ['lang="python"', "lang='python'", 'language="Python"', 'lang=" python "']) {
      expect(() => composeBundleSource(ui(`<logic ${attribute}>count = 0</logic>`), 'app.softn')).toThrow(
        /put Python in a \.py file/
      );
    }
    // A JavaScript block that says so, or says nothing, is untouched.
    expect(composeBundleSource(ui('<logic lang="javascript">let a = 1;</logic>'), 'app.softn').languages).toEqual([
      'javascript',
    ]);
    expect(composeBundleSource(ui('<logic>let a = 1;</logic>'), 'app.softn').languages).toEqual(['javascript']);
  });

  it('refuses a bundle whose logic is partly each language', () => {
    const map = new Map<string, string>([
      ['app.softn', '<logic src="./helpers.logic" />\n<logic src="./app.py" />'],
      ['helpers.logic', 'function double(x) { return x * 2; }'],
      ['app.py', 'count = 0\n'],
    ]);
    expect(() => composeBundleSource(map, 'app.softn')).toThrow(/mixes Python and JavaScript logic/);
  });

  it('refuses a mix that came from an inline block as well as a file', () => {
    const map = new Map<string, string>([
      ['app.softn', '<logic>let a = 1;</logic>\n<logic src="./app.py" />'],
      ['app.py', 'count = 0\n'],
    ]);
    expect(() => composeBundleSource(map, 'app.softn')).toThrow(/mixes Python and JavaScript/);
  });

  it('does not count an empty JavaScript block as a mix', () => {
    // A component can contribute a `<logic>` block with nothing in it. That is
    // not the author writing JavaScript, so it does not make the bundle mixed.
    const map = new Map<string, string>([
      ['app.softn', '<import Card from="./card.softn" />\n<logic src="./app.py" />\n<Card />'],
      ['card.softn', '<logic>\n  \n</logic><div>card</div>'],
      ['app.py', 'count = 0\n'],
    ]);
    expect(composeBundleSource(map, 'app.softn').languages).toEqual(['javascript', 'python']);
  });
});

describe('a JavaScript bundle is composed exactly as it always was', () => {
  it('says so in languages and carries no python project', () => {
    const map = new Map<string, string>([
      ['app.softn', '<logic src="./helpers.logic" />\n<logic>let b = 2;</logic>\n<p>hi</p>'],
      ['helpers.logic', 'let a = 1;'],
    ]);
    const composed = composeBundleSource(map, 'app.softn');
    expect(composed.languages).toEqual(['javascript']);
    expect(composed.python).toBeUndefined();
    expect(composed.source).toContain('let a = 1;');
    expect(composed.source).toContain('let b = 2;');
    // Both fragments come from the main document, so the first one with a file
    // of its own is the entry — which is why nothing is listed as
    // pre-included. Unchanged, and asserted here so the Python branch above
    // cannot quietly become the JavaScript branch's behaviour too.
    expect(composed.logicBasePath).toBe('helpers.logic');
    expect(composed.preIncludedLogicPaths).toEqual([]);
  });

  it('still lists a manifest helper as pre-included', () => {
    const map = new Map<string, string>([
      ['app.softn', '<logic src="./app.logic" />'],
      ['app.logic', 'let b = 2;'],
      ['helpers.logic', 'let a = 1;'],
    ]);
    const composed = composeBundleSource(map, 'app.softn', ['helpers.logic']);
    expect(composed.logicBasePath).toBe('app.logic');
    expect(composed.preIncludedLogicPaths).toEqual(['helpers.logic']);
    expect(composed.languages).toEqual(['javascript']);
  });

  it('a bundle with no logic at all is unchanged too', () => {
    const composed = composeBundleSource(ui('<p>hi</p>'), 'app.softn');
    expect(composed.languages).toEqual(['javascript']);
    expect(composed.python).toBeUndefined();
    expect(composed.source).toBe('<p>hi</p>');
    expect(composed.preIncludedLogicPaths).toEqual([]);
  });
});
