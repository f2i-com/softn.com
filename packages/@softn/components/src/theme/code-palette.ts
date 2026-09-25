/**
 * The colours CodeEditor paints syntax in, one per token kind.
 *
 * Like the chart palette, these are custom properties the ThemeProvider
 * writes for the light and the dark theme (`code` on a theme's colours, so a
 * custom theme can bring its own): `--color-code-keyword`,
 * `--color-code-string`, … . The editor asks for `var(--color-code-<kind>,
 * <fallback>)`. The fallback is the dark palette, because an editor with no
 * ThemeProvider above it draws on its own dark fallback surface.
 */

import type { TokenKind } from '../editors/highlight';

/** The kinds that are coloured; `plain` text takes the editor's text colour. */
export type CodeTokenColorKind = Exclude<TokenKind, 'plain'>;

export type CodePalette = Readonly<Record<CodeTokenColorKind, string>>;

/** For a light surface: the 600–700 steps, legible on white. */
export const CODE_PALETTE_LIGHT: CodePalette = {
  keyword: '#7c3aed',
  string: '#047857',
  number: '#c2410c',
  literal: '#b91c1c',
  comment: '#6b7280',
  function: '#1d4ed8',
  decorator: '#a21caf',
  regex: '#be123c',
  punct: '#4b5563',
  property: '#0e7490',
  tag: '#be185d',
  attr: '#b45309',
  mark: '#7c3aed',
  type: '#0369a1',
};

/** For a dark surface: the 300–400 steps. */
export const CODE_PALETTE_DARK: CodePalette = {
  keyword: '#a78bfa',
  string: '#34d399',
  number: '#fb923c',
  literal: '#f87171',
  comment: '#a1a1aa',
  function: '#60a5fa',
  decorator: '#e879f9',
  regex: '#fb7185',
  punct: '#a1a1aa',
  property: '#22d3ee',
  tag: '#f472b6',
  attr: '#fbbf24',
  mark: '#a78bfa',
  type: '#38bdf8',
};

/** The custom property a token kind's colour is published under. */
export function codeColorVariable(kind: CodeTokenColorKind): string {
  return `--color-code-${kind}`;
}

/** The colour CodeEditor paints `kind` in: the theme's, else the dark fallback. */
export function codeColor(kind: CodeTokenColorKind): string {
  return `var(${codeColorVariable(kind)}, ${CODE_PALETTE_DARK[kind]})`;
}
