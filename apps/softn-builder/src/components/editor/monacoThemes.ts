/**
 * Monaco themes drawn from @softn/brand's tokens, so the code editors look
 * like the rest of SoftN rather than like VS Code dropped into it.
 *
 * Monaco takes literal colours, not CSS variables, so the values are copied
 * from packages/@softn/brand/src/tokens.css — change them there first. The
 * rule is the site's and Studio's: the language's own marks (keywords, tags,
 * directives) in coral; strings and numbers in sand; names in the ink;
 * comments, attributes and punctuation in its dims. Mint is not used —
 * nothing in an editor is running.
 */

export const MONACO_FONT_FAMILY = "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

interface Palette {
  ground: string;
  raised: string;
  line: string;
  lineSoft: string;
  paper: string;
  dim: string;
  dimmer: string;
  coral: string;
  sand: string;
  danger: string;
  warn: string;
}

const DARK: Palette = {
  ground: '#161a20', // --ink-2
  raised: '#1d222a', // --ink-3
  line: '#262c36',
  lineSoft: '#1c212a',
  paper: '#f2f0ec',
  dim: '#8b94a2',
  dimmer: '#838c9a',
  coral: '#ff8a4c',
  sand: '#d8c39a',
  danger: '#ff6b6b',
  warn: '#e8a33d',
};

const LIGHT: Palette = {
  ground: '#ffffff', // --ink-2
  raised: '#eef1f6', // --ink-3
  line: '#d5dce5',
  lineSoft: '#e4e9f0',
  paper: '#14181d',
  dim: '#5a6472',
  dimmer: '#656e7c',
  coral: '#c2410c',
  sand: '#8a5a17',
  danger: '#b91c1c',
  warn: '#a16207',
};

const hex = (color: string) => color.slice(1);

export interface MonacoThemeData {
  base: 'vs' | 'vs-dark';
  inherit: boolean;
  rules: { token: string; foreground?: string; fontStyle?: string }[];
  colors: Record<string, string>;
}

function theme(p: Palette, base: 'vs' | 'vs-dark'): MonacoThemeData {
  return {
    base,
    inherit: true,
    rules: [
      { token: '', foreground: hex(p.paper) },
      // Plex Mono ships no italic here, so comments are dim, not slanted.
      { token: 'comment', foreground: hex(p.dim) },
      { token: 'keyword', foreground: hex(p.coral) },
      { token: 'tag', foreground: hex(p.coral) },
      { token: 'metatag', foreground: hex(p.coral) },
      { token: 'string', foreground: hex(p.sand) },
      { token: 'attribute.value', foreground: hex(p.sand) },
      { token: 'number', foreground: hex(p.sand) },
      { token: 'regexp', foreground: hex(p.sand) },
      { token: 'attribute.name', foreground: hex(p.dim) },
      { token: 'delimiter', foreground: hex(p.dim) },
      { token: 'delimiter.bracket', foreground: hex(p.dim) },
      { token: 'identifier', foreground: hex(p.paper) },
      { token: 'type', foreground: hex(p.paper) },
      { token: 'variable', foreground: hex(p.paper) },
      { token: 'constant', foreground: hex(p.sand) },
      // The base themes colour markup by language (blue values and
      // delimiters in the light one), and a more specific rule wins, so the
      // .ui source is named here explicitly.
      ...['xml', 'html'].flatMap((lang) => [
        { token: `tag.${lang}`, foreground: hex(p.coral) },
        { token: `metatag.${lang}`, foreground: hex(p.coral) },
        { token: `metatag.content.${lang}`, foreground: hex(p.paper) },
        { token: `attribute.name.${lang}`, foreground: hex(p.dim) },
        { token: `attribute.value.${lang}`, foreground: hex(p.sand) },
        { token: `string.${lang}`, foreground: hex(p.sand) },
        { token: `delimiter.${lang}`, foreground: hex(p.dim) },
      ]),
    ],
    colors: {
      'editor.background': p.ground,
      'editor.foreground': p.paper,
      'editorLineNumber.foreground': p.dimmer,
      'editorLineNumber.activeForeground': p.paper,
      'editor.lineHighlightBackground': p.raised,
      'editor.lineHighlightBorder': p.raised,
      'editor.selectionBackground': `${p.coral}40`,
      'editor.inactiveSelectionBackground': `${p.coral}24`,
      'editorCursor.foreground': p.paper,
      'editorIndentGuide.background1': p.lineSoft,
      'editorIndentGuide.activeBackground1': p.line,
      'editorWhitespace.foreground': p.line,
      // Bracket-pair colours are VS Code's gold, violet and blue: punctuation
      // here is the ink's dim, like every other delimiter.
      ...Object.fromEntries(
        [1, 2, 3, 4, 5, 6].map((n) => [`editorBracketHighlight.foreground${n}`, p.dim])
      ),
      'editorBracketHighlight.unexpectedBracket.foreground': p.danger,
      'editorBracketMatch.background': p.raised,
      'editorBracketMatch.border': p.line,
      'editorError.foreground': p.danger,
      'editorWarning.foreground': p.warn,
      'editorWidget.background': p.ground,
      'editorWidget.border': p.line,
      'editorSuggestWidget.background': p.ground,
      'editorSuggestWidget.border': p.line,
      'editorSuggestWidget.selectedBackground': p.raised,
      'editorHoverWidget.background': p.ground,
      'editorHoverWidget.border': p.line,
      'scrollbarSlider.background': `${p.dim}33`,
      'scrollbarSlider.hoverBackground': `${p.dim}55`,
      'scrollbarSlider.activeBackground': `${p.dim}77`,
      'editorGutter.background': p.ground,
      focusBorder: p.line,
    },
  };
}

export const SOFTN_DARK_THEME = 'softn-dark';
export const SOFTN_LIGHT_THEME = 'softn-light';
export const softnDarkTheme = theme(DARK, 'vs-dark');
export const softnLightTheme = theme(LIGHT, 'vs');

/** The theme name for the page's theme, or for an editor that asked for one. */
export function monacoThemeFor(page: 'light' | 'dark', requested?: 'light' | 'vs-dark'): string {
  const dark = requested ? requested === 'vs-dark' : page === 'dark';
  return dark ? SOFTN_DARK_THEME : SOFTN_LIGHT_THEME;
}
