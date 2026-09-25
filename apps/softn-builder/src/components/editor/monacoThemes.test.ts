import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { monacoThemeFor, softnDarkTheme, softnLightTheme, SOFTN_DARK_THEME, SOFTN_LIGHT_THEME } from './monacoThemes';

const tokensCss = readFileSync(new URL('../../../../../packages/@softn/brand/src/tokens.css', import.meta.url), 'utf8');

/** A token's value in the dark (`:root`) or light block of tokens.css. */
function token(name: string, light: boolean): string {
  const lightStart = tokensCss.indexOf(":root[data-theme='light']");
  const block = light ? tokensCss.slice(lightStart) : tokensCss.slice(0, lightStart);
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
  if (!match) throw new Error(`no --${name}`);
  return match[1].toLowerCase();
}

const rule = (theme: typeof softnDarkTheme, name: string) => theme.rules.find((r) => r.token === name)?.foreground;

describe('the Monaco themes', () => {
  it.each([
    ['dark', softnDarkTheme, false],
    ['light', softnLightTheme, true],
  ] as const)('are drawn from the brand tokens (%s)', (_, theme, light) => {
    expect(theme.colors['editor.background']).toBe(token('ink-2', light));
    expect(theme.colors['editor.foreground']).toBe(token('paper', light));
    // The language in coral, literals in sand, comments dim.
    expect(`#${rule(theme, 'keyword')}`).toBe(token('coral', light));
    expect(`#${rule(theme, 'tag')}`).toBe(token('coral', light));
    expect(`#${rule(theme, 'string')}`).toBe(token('sand', light));
    expect(`#${rule(theme, 'comment')}`).toBe(token('dim', light));
  });

  it('colours the .ui markup the same way, over the base theme rules', () => {
    for (const theme of [softnDarkTheme, softnLightTheme]) {
      expect(rule(theme, 'attribute.value.xml')).toBe(rule(theme, 'string'));
      expect(rule(theme, 'delimiter.xml')).toBe(rule(theme, 'delimiter'));
      expect(rule(theme, 'tag.xml')).toBe(rule(theme, 'keyword'));
    }
  });

  it('never uses mint: nothing in an editor is running', () => {
    for (const [theme, light] of [[softnDarkTheme, false], [softnLightTheme, true]] as const) {
      const mint = token('mint', light).slice(1);
      expect(JSON.stringify(theme).toLowerCase()).not.toContain(mint);
    }
  });

  it('follows the page theme unless an editor asks for one', () => {
    expect(monacoThemeFor('dark')).toBe(SOFTN_DARK_THEME);
    expect(monacoThemeFor('light')).toBe(SOFTN_LIGHT_THEME);
    expect(monacoThemeFor('dark', 'light')).toBe(SOFTN_LIGHT_THEME);
    expect(monacoThemeFor('light', 'vs-dark')).toBe(SOFTN_DARK_THEME);
  });
});
