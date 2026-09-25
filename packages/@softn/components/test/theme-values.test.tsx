/**
 * The ThemeProvider writes its theme into `<style>` text, where a value is a
 * way out of its declaration and a name a way out of its property. Every name
 * and value is checked on the way in; a refused value falls back to the light
 * theme's, so the stylesheet stays complete.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { mount } from './dom';
import { ThemeProvider, themeToCssVariables } from '../src/theme/ThemeProvider';
import { darkTheme, lightTheme, type Theme } from '../src/theme/tokens';
import { cssThemeValue } from '../src/utils/css-values';

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

function withColors(colors: Partial<Theme['colors']>): Theme {
  return { ...lightTheme, colors: { ...lightTheme.colors, ...colors } };
}

function styleText(container: HTMLElement): string {
  return container.querySelector('style')?.textContent ?? '';
}

describe('cssThemeValue', () => {
  it.each([
    '#2563eb',
    'rgb(0 0 0 / 0.1)',
    '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
    'Inter, "Segoe UI", -apple-system, system-ui, sans-serif',
    "'JetBrains Mono', monospace",
    'cubic-bezier(0.4, 0, 0.2, 1)',
    '150ms',
    'calc(100% * 2 - var(--x))',
    'clamp(1rem, 2vw, 2rem)',
    '0.375rem',
    '640px',
    'linear-gradient(to right, #fff, #000)',
  ])('keeps %s', (value) => {
    expect(cssThemeValue(value)).toBe(value);
  });

  it.each([
    ['a declaration break', 'red; } body { background: red } x {'],
    ['a second declaration', 'red; background: url(https://evil.example/x)'],
    ['a fetch', 'url(https://evil.example/x)'],
    ['a fetch by another name', 'image-set("x.png" 1x)'],
    ['a closing style tag', 'red</style><script>alert(1)</script>'],
    ['an escape', 'u\\72l(https://evil.example/x)'],
    ['a comment', 'red /* } */'],
    ['an at-rule', '@import "x"'],
    ['!important', 'red !important'],
    ['a stray quote', '"Inter, sans-serif'],
    ['a quote holding a brace', '"}"'],
    ['unbalanced parentheses', 'rgb(0 0 0'],
    ['a newline', 'red\n}'],
    ['an empty value', ''],
    ['an object', { toString: (): string => 'red' }],
  ])('refuses %s', (_label, value) => {
    expect(cssThemeValue(value)).toBeUndefined();
  });

  it('writes a finite number and refuses NaN', () => {
    expect(cssThemeValue(600)).toBe('600');
    expect(cssThemeValue(Number.NaN)).toBeUndefined();
  });
});

describe('themeToCssVariables', () => {
  it('writes the built-in themes unchanged', () => {
    const vars = themeToCssVariables(lightTheme);
    expect(vars['--color-primary-500']).toBe('#6366f1');
    expect(vars['--font-sans']).toBe(lightTheme.typography.fontFamily.sans);
    expect(vars['--shadow-md']).toBe(lightTheme.shadows.md);
    expect(vars['--easing-inOut']).toBe(lightTheme.transitions.easing.inOut);
    expect(vars['--space-0_5']).toBe(lightTheme.spacing[0.5]);
    expect(Object.keys(vars).length).toBeGreaterThan(100);
  });

  it.each([
    ['light', lightTheme],
    ['dark', darkTheme],
  ])('refuses nothing in the built-in %s theme, so neither is quietly patched with the other', (_name, theme) => {
    const count = (t: Theme) =>
      Object.values(t.colors).reduce<number>(
        (n, v) => n + (typeof v === 'string' ? 1 : v && typeof v === 'object' ? Object.keys(v).length : 0),
        0,
      );
    const vars = themeToCssVariables(theme);
    // Every value the theme defines is written exactly as the theme says it.
    const expected: Record<string, string> = {
      '--color-bg': theme.colors.background,
      '--color-text': theme.colors.text,
      '--color-gray-50': theme.colors.gray[50],
      '--color-gray-900': theme.colors.gray[900],
      '--font-mono': theme.typography.fontFamily.mono,
      '--font-bold': String(theme.typography.fontWeight.bold),
      '--shadow-lg': theme.shadows.lg,
      '--easing-out': theme.transitions.easing.out,
      '--duration-fast': theme.transitions.duration.fast,
      '--breakpoint-2xl': theme.breakpoints['2xl'],
    };
    for (const [name, value] of Object.entries(expected)) expect(vars[name], name).toBe(value);
    for (const [kind, color] of Object.entries(theme.colors.code ?? {})) expect(vars[`--color-code-${kind}`]).toBe(color);
    for (const [key, value] of Object.entries(theme.spacing)) expect(vars[`--space-${key.replace('.', '_')}`]).toBe(value);
    for (const [key, value] of Object.entries(theme.shadows)) expect(vars[`--shadow-${key}`]).toBe(value);
    for (const [key, value] of Object.entries(theme.typography.fontFamily)) expect(vars[`--font-${key}`]).toBe(value);
    expect(count(theme)).toBeGreaterThan(70);
  });

  it('replaces a refused value with the light theme value for the same variable', () => {
    const vars = themeToCssVariables(withColors({ background: 'red; } body { background: url(https://evil.example/x) } x {' }));
    expect(vars['--color-bg']).toBe(lightTheme.colors.background);
  });

  it('drops a name that is not a plain identifier', () => {
    const theme = {
      ...lightTheme,
      radii: { ...lightTheme.radii, 'x: 0; } body { background: url(https://evil.example/x) } y { --z': '1px' },
    } as unknown as Theme;
    const vars = themeToCssVariables(theme);
    expect(Object.keys(vars).some((name) => /[{};: ]/.test(name))).toBe(false);
    expect(vars['--radius-md']).toBe(lightTheme.radii.md);
  });

  it('renders a theme that leaves whole sections out instead of throwing', () => {
    const partial = { name: 'brand', colors: { primary: { 500: '#ff0000' } } } as unknown as Theme;
    const vars = themeToCssVariables(partial);
    expect(vars['--color-primary-500']).toBe('#ff0000');
    expect(vars['--color-code-keyword']).toBeDefined();
  });

  it('publishes the code editor palette for each theme', () => {
    expect(themeToCssVariables(lightTheme)['--color-code-string']).toBe(lightTheme.colors.code?.string);
    expect(themeToCssVariables(darkTheme)['--color-code-string']).toBe(darkTheme.colors.code?.string);
  });

  it('runs the dark grays from the surface to the ink, as App does', () => {
    const vars = themeToCssVariables(darkTheme);
    // gray-50 is a surface a step off the dark background, gray-900 near the text.
    expect(vars['--color-gray-50']).not.toBe('#f9fafb');
    expect(vars['--color-gray-900']).toBe(darkTheme.colors.text);
  });
});

describe('ThemeProvider stylesheet', () => {
  const hostile = withColors({
    primary: { ...lightTheme.colors.primary, 500: '</style><img src=x onerror="alert(1)">' },
    text: 'red; } body { background: url(https://evil.example/x) } x {',
  });

  it('never lets a theme close the style element or add a rule', () => {
    const { container } = mount(
      <ThemeProvider theme={hostile}>
        <p>content</p>
      </ThemeProvider>,
    );
    expect(container.querySelector('img')).toBeNull();
    const css = styleText(container);
    expect(css).not.toContain('evil.example');
    expect(css).not.toContain('</style');
    expect(css).toContain(`--color-primary-500: ${lightTheme.colors.primary[500]};`);
    // One :root block of plain declarations: nothing opened a second rule.
    const variables = css.slice(0, css.indexOf('}') + 1);
    expect(variables).toMatch(/^:root \{\n(?: {2}--[\w-]+: [^;{}<>\n]+;\n)+\}$/);
  });

  it('is equally safe when rendered on the server', () => {
    const html = renderToStaticMarkup(
      <ThemeProvider theme={hostile}>
        <p>content</p>
      </ThemeProvider>,
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('evil.example');
  });

  it('follows a new theme prop without a remount', () => {
    const brand = withColors({ primary: { ...lightTheme.colors.primary, 500: '#ff0000' } });
    const { container, rerender } = mount(
      <ThemeProvider theme={lightTheme}>
        <p>content</p>
      </ThemeProvider>,
    );
    expect(styleText(container)).toContain('--color-primary-500: #6366f1;');
    rerender(
      <ThemeProvider theme={brand}>
        <p>content</p>
      </ThemeProvider>,
    );
    expect(styleText(container)).toContain('--color-primary-500: #ff0000;');
  });

  it('stops CSS motion for someone who asked for less of it', () => {
    const { container } = mount(
      <ThemeProvider>
        <p>content</p>
      </ThemeProvider>,
    );
    expect(styleText(container)).toMatch(/@media \(prefers-reduced-motion: reduce\)[^}]*animation-duration: 0\.01ms !important/);
  });
});
