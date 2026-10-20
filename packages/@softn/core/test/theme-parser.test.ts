/**
 * The theme file reader's CSS (parser/themeParser.ts): a theme's values and
 * name are written into CSS, so neither may end the rule it is written in,
 * add one of its own, or load anything.
 */

import { describe, expect, it } from 'vitest';
import { generateThemeCss, themeConfigToCss } from '../src/parser/themeParser';

describe('a theme written as CSS', () => {
  it('writes each value as a custom property of its theme', () => {
    const css = generateThemeCss(`
      <theme name="default"><colors><primary>#3b82f6</primary></colors><spacing><sm>0.5rem</sm></spacing></theme>
      <theme name="ocean" extends="default"><colors><primary>rgb(0, 80, 160)</primary></colors></theme>
    `);
    expect(css).toBe(
      ':root {\n  --color-primary: #3b82f6;\n  --space-sm: 0.5rem;\n}\n\n' +
        '[data-theme="ocean"] {\n  --color-primary: rgb(0, 80, 160);\n  --space-sm: 0.5rem;\n}'
    );
  });

  it('leaves out a value that would end its rule or load something', () => {
    const css = generateThemeCss(`
      <theme name="default"><colors>
        <primary>red; } body { display: none } :root { --x: 1</primary>
        <secondary>url(https://example.com/beacon)</secondary>
        <accent>red @import "x"</accent>
        <ok>#fff</ok>
      </colors></theme>
    `);
    expect(css).toBe(':root {\n  --color-ok: #fff;\n}');
  });

  it('writes no theme whose name would leave its selector', () => {
    // `x\` escaped the selector's closing quote, and the CSS after it was the selector's.
    expect(generateThemeCss('<theme name="x\\"><colors><a>red</a></colors></theme>')).toBe('');
    expect(generateThemeCss('<theme name="a] body {"><colors><a>red</a></colors></theme>')).toBe('');
  });

  it('writes no property whose name is not one, given a theme made by hand', () => {
    const css = themeConfigToCss({ name: 'x', colors: { 'a: red; } body {': 'blue', ok: 'green' }, typography: {}, spacing: {}, radius: {}, shadows: {} });
    expect(css).toBe(':root {\n  --color-ok: green;\n}');
  });
});
