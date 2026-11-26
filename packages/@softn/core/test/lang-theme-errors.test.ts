/**
 * A theme file's themes, and a parse error's own report of where it is.
 *
 * - `<theme>` written with no attributes is the default theme (its name
 *   defaults to "default"); the reader asked for a space after the name, so
 *   it read nothing at all and the theme's values were never written.
 * - A theme two steps down an `extends` chain has its grandparent's values:
 *   only the parent's own were merged. A chain that comes round on itself
 *   ends, rather than running out of stack.
 * - `SoftNParseError.format()` and `createErrorContext` place a caret under
 *   a column 0, which a token that begins with the line break before it is
 *   at, where `' '.repeat(-1)` threw; and quote a line saved with CR LF
 *   without its `\r`.
 */

import { describe, expect, it } from 'vitest';
import { generateThemeCss, parseThemeFile, resolveThemes } from '../src/parser/themeParser';
import { SoftNParseError, createErrorContext } from '../src/parser/errors';

describe('a theme file', () => {
  it('reads a <theme> with no attributes as the default theme', () => {
    const parsed = parseThemeFile('<theme>\n  <colors><primary>#111111</primary></colors>\n</theme>');
    expect(parsed.themes.map((theme) => theme.name)).toEqual(['default']);
    expect(generateThemeCss('<theme><colors><primary>#111111</primary></colors></theme>')).toBe(':root {\n  --color-primary: #111111;\n}');
  });

  it('does not take <themes> or <theme-set> for a theme', () => {
    expect(parseThemeFile('<themes><colors><a>red</a></colors></themes><theme-set x="1"><colors><a>red</a></colors></theme-set>').themes).toEqual([]);
  });

  it('gives a theme its grandparent’s values', () => {
    const resolved = resolveThemes(
      parseThemeFile(`
        <theme name="default"><colors><primary>#111111</primary><text>#222222</text></colors><spacing><sm>4px</sm></spacing></theme>
        <theme name="dark" extends="default"><colors><text>#eeeeee</text></colors></theme>
        <theme name="brand" extends="dark"><colors><primary>#ff0000</primary></colors></theme>
      `)
    );
    const brand = resolved.find((theme) => theme.name === 'brand')!;
    expect(brand.colors).toEqual({ primary: '#ff0000', text: '#eeeeee' });
    expect(brand.spacing).toEqual({ sm: '4px' });
  });

  it('ends an extends chain that comes round on itself', () => {
    const resolved = resolveThemes(
      parseThemeFile(`
        <theme name="a" extends="b"><colors><x>#000001</x></colors></theme>
        <theme name="b" extends="a"><colors><y>#000002</y></colors></theme>
        <theme name="c" extends="c"><colors><z>#000003</z></colors></theme>
      `)
    );
    expect(resolved.find((theme) => theme.name === 'a')!.colors).toEqual({ x: '#000001', y: '#000002' });
    expect(resolved.find((theme) => theme.name === 'b')!.colors).toEqual({ x: '#000001', y: '#000002' });
    expect(resolved.find((theme) => theme.name === 'c')!.colors).toEqual({ z: '#000003' });
  });

  it('follows a long chain without running out of stack', () => {
    const chain = Array.from({ length: 2000 }, (_, i) => `<theme name="t${i}"${i > 0 ? ` extends="t${i - 1}"` : ''}><colors><c${i}>#00000${i % 10}</c${i}></colors></theme>`).join('');
    expect(() => resolveThemes(parseThemeFile(chain))).not.toThrow();
  });
});

describe('a parse error’s report', () => {
  it('places the caret under column 0 rather than throwing', () => {
    const error = new SoftNParseError('boom', { line: 2, column: 0, start: 4, end: 4 }, 'abc\ndef');
    expect(error.format()).toBe('SoftNParseError: boom\n  at line 2, column 0\n\n  2 | def\n    | ^\n');
    expect(createErrorContext('abc\ndef', { line: 2, column: 0, start: 4, end: 4 }, 0)).toBe('>    2 | def\n       | ^\n');
  });

  it('quotes a line saved with CR LF without its carriage return', () => {
    const error = new SoftNParseError('boom', { line: 1, column: 3, start: 2, end: 3 }, 'abc\r\ndef');
    expect(error.format()).toBe('SoftNParseError: boom\n  at line 1, column 3\n\n  1 | abc\n    |   ^\n');
    expect(createErrorContext('abc\r\ndef', { line: 1, column: 3, start: 2, end: 3 }, 1)).toBe('>    1 | abc\n       |   ^\n     2 | def\n');
  });
});
