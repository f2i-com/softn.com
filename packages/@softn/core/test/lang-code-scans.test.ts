/**
 * The quick readings of a script's text the runtime makes before it runs it
 * (runtime/declared-functions.ts, runtime/module-syntax.ts), and the theme
 * file reader's (parser/themeParser.ts): what each finds, and that a long run
 * of spaces where a pattern allowed two runs, or a file of tags that never
 * close, is read in one pass. Each pattern could split one run of spaces
 * between its two halves every way there is, or look again from every open
 * tag to the end of the file: 20,000 spaces after `function` took 150 ms and
 * after `export {a}` 330 ms, and 20,000 `<theme ` 800 ms, growing with the
 * square of the length.
 */

import { describe, expect, it } from 'vitest';
import { declaredFunctionNames } from '../src/runtime/declared-functions';
import { moduleSyntaxAsScript } from '../src/runtime/module-syntax';
import { blankCommentsAndStrings } from '../src/runtime/code-text';
import { detectWorkerIncompatibilities } from '../src/runtime/script-runtime';
import { windowNamesIn } from '../src/runtime/window-bridge';
import { parseThemeFile } from '../src/parser/themeParser';

/**
 * And the code a check reads for the names it uses, with its comments and
 * strings taken out (runtime/code-text.ts): a quote in a regular expression
 * began a string there that ran on to the next quote, so a script with
 * `s.replace(/"/g, '')` above its `db.query(…)` was taken to use no `db`
 * (and could be run in a worker that has none), and the `window.__…` names
 * after it were not bridged.
 */
describe('code with its comments and strings taken out', () => {
  it('keeps a regular expression as written, and the code after it', () => {
    const code = 'const quote = /"/g\nfunction load() { return db.query("notes") }\nwindow.__softnKeys = 1';
    expect(blankCommentsAndStrings(code)).toBe('const quote = /"/g\nfunction load() { return db.query("") }\nwindow.__softnKeys = 1');
    expect(detectWorkerIncompatibilities(code)).toContain('uses db bridge (synchronous host access)');
    expect(windowNamesIn("const q = /'/g\nlet seen = window.__scene3dYaw").read).toEqual(['__scene3dYaw']);
  });

  it('still empties strings and takes out comments, and divides', () => {
    expect(blankCommentsAndStrings('a / b / c // note\nx = "s" / 2; y = (z) / 3 /* c */ + `t${u}`')).toBe('a / b / c \nx = "" / 2; y = (z) / 3  + ""');
    expect(blankCommentsAndStrings('if (ok) return /[/"]+/.test(s) && "db."')).toBe('if (ok) return /[/"]+/.test(s) && ""');
  });
});

describe('the functions a script declares', () => {
  it('are found as they were', () => {
    expect(
      declaredFunctionNames(
        'function save() {}\nfunction* gen() {}\nfunction *spaced () {}\nfunction*tight(){}\nasync function load() {}\n' +
          'const f = async (a) => 1\nlet g = x => x\nvar h = function () {}\ndef py_fn(x):\n    pass'
      )
    ).toEqual(['save', 'gen', 'spaced', 'tight', 'load', 'f', 'g', 'h', 'py_fn']);
  });

  it('are found past a long run of spaces, in one pass', () => {
    const spaces = ' '.repeat(200_000);
    expect(declaredFunctionNames(`function${spaces}(`)).toEqual([]);
    expect(declaredFunctionNames(`function${spaces}*${spaces}late() {}`)).toEqual(['late']);
  });
});

describe('logic written as a module', () => {
  it('is read as the script it means, line for line', () => {
    expect(moduleSyntaxAsScript('export const a = 1\nexport { a, b };\nexport {\n  c,\n  d\n}\nimport { x } from "./x.js";  \nexport default main ;\nexport default function* run() {}\nexport default async function *go() {}')).toBe(
      'const a = 1\n\n\n\n\n\nimport "./x.js"\n\nfunction* run() {}\nasync function *go() {}'
    );
  });

  it('leaves what means something else as written', () => {
    const code = 'import { a as b } from "./a.js"\nimport x from "./x.js"\nexport default 42\nexport { a } ; junk';
    expect(moduleSyntaxAsScript(code)).toBe(code);
  });

  it('reads a long run of spaces at the end of a line in one pass', () => {
    const spaces = ' '.repeat(200_000);
    expect(moduleSyntaxAsScript(`export {a}${spaces}x`)).toBe(`export {a}${spaces}x`);
    expect(moduleSyntaxAsScript(`import {a} from "./a.js"${spaces}x`)).toBe(`import {a} from "./a.js"${spaces}x`);
    expect(moduleSyntaxAsScript(`export default function${spaces}(`)).toBe(`export default function${spaces}(`);
    expect(moduleSyntaxAsScript(`export {a}${spaces}`)).toBe('');
  });
});

describe('a theme file of tags that never close', () => {
  it('is read in one pass, and gives the themes that do close', () => {
    expect(parseThemeFile('<theme '.repeat(100_000)).themes).toEqual([]);
    const file = '<theme name="a"><colors><x>#000001</x></colors></theme>' + '<theme name="b">'.repeat(50_000);
    expect(parseThemeFile(file).themes.map((theme) => theme.name)).toEqual(['a']);
    const colors = '<theme name="c">' + '<colors>'.repeat(50_000) + '</theme>';
    expect(parseThemeFile(colors).themes[0].colors).toEqual({});
  });

  it('reads each block to its first end, in any case, as before', () => {
    const [theme] = parseThemeFile('<THEME name="x"><Colors><a>#111111</a></COLORS><colors><b>#222222</b></colors><spacing><s>1px</s></spacing></THEME>').themes;
    expect(theme.colors).toEqual({ a: '#111111' });
    expect(theme.spacing).toEqual({ s: '1px' });
  });
});
