/**
 * SoftN Theme Parser
 *
 * Parses theme.softn files into theme configuration objects.
 *
 * Example theme.softn syntax:
 *
 * <theme name="default">
 *   <colors>
 *     <primary>#3b82f6</primary>
 *     <secondary>#6b7280</secondary>
 *     <success>#22c55e</success>
 *   </colors>
 *   <spacing>
 *     <xs>0.25rem</xs>
 *     <sm>0.5rem</sm>
 *   </spacing>
 * </theme>
 *
 * <theme name="dark" extends="default">
 *   <colors>
 *     <background>#0f172a</background>
 *   </colors>
 * </theme>
 */

export interface ThemeConfig {
  name: string;
  extends?: string;
  colors: Record<string, string>;
  typography: Record<string, string>;
  spacing: Record<string, string>;
  radius: Record<string, string>;
  shadows: Record<string, string>;
}

export interface ParsedThemeFile {
  themes: ThemeConfig[];
}

/**
 * Parse a theme.softn file content into theme configurations
 */
export function parseThemeFile(source: string): ParsedThemeFile {
  const themes: ThemeConfig[] = [];

  // Simple regex-based parser for theme files. A `<theme>` with no
  // attributes is the default theme (see parseThemeBlock); `\s+` after the
  // name passed over it, and its values were never written.
  //
  // Each theme's end is looked for from its start, and where there is none
  // no later theme has one either. As one pattern, `<theme …>([\s\S]*?)</theme>`
  // looked again from every `<theme` there was, to the end of the file each
  // time: a file of unclosed ones took most of a second.
  const open = /<theme(?=[\s>])([^<>]*)>/gi;
  const close = /<\/theme>/gi;
  let match;

  while ((match = open.exec(source)) !== null) {
    close.lastIndex = open.lastIndex;
    const end = close.exec(source);
    if (!end) break;
    themes.push(parseThemeBlock(match[1], source.slice(open.lastIndex, end.index)));
    open.lastIndex = close.lastIndex;
  }

  return { themes };
}

/**
 * What a theme's `<name>` block holds, to the first `</name>` after it: the
 * first block that has an end, as `<name>([\s\S]*?)</name>` read it, without
 * looking again from every later `<name>` when there is none.
 */
function blockOf(content: string, name: string): string | undefined {
  const open = new RegExp(`<${name}>`, 'i').exec(content);
  if (!open) return undefined;
  const close = new RegExp(`</${name}>`, 'gi');
  close.lastIndex = open.index + open[0].length;
  const end = close.exec(content);
  return end ? content.slice(open.index + open[0].length, end.index) : undefined;
}

/**
 * Parse a single theme block
 */
function parseThemeBlock(attributes: string, content: string): ThemeConfig {
  // Parse attributes
  const nameMatch = /name=["']([^"']+)["']/.exec(attributes);
  const extendsMatch = /extends=["']([^"']+)["']/.exec(attributes);

  const theme: ThemeConfig = {
    name: nameMatch?.[1] || 'default',
    colors: {},
    typography: {},
    spacing: {},
    radius: {},
    shadows: {},
  };

  if (extendsMatch) {
    theme.extends = extendsMatch[1];
  }

  // Each block of values, as blockOf finds it.
  for (const group of ['colors', 'typography', 'spacing', 'radius', 'shadows'] as const) {
    const block = blockOf(content, group);
    if (block !== undefined) theme[group] = parseSimpleBlock(block);
  }

  return theme;
}

/**
 * Parse simple key-value blocks like <primary>#fff</primary>
 */
function parseSimpleBlock(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const tagRegex = /<([a-zA-Z][\w-]*)>([^<]*)<\/\1>/g;
  let match;

  while ((match = tagRegex.exec(content)) !== null) {
    const key = match[1];
    const value = match[2].trim();
    result[key] = value;
  }

  return result;
}

/**
 * Convert a ThemeConfig to CSS custom properties
 */
export function themeConfigToCssVariables(theme: ThemeConfig): Record<string, string> {
  const vars: Record<string, string> = {};

  // Colors
  for (const [key, value] of Object.entries(theme.colors)) {
    // Convert kebab-case key to CSS variable name
    vars[`--color-${key}`] = value;
  }

  // Typography
  for (const [key, value] of Object.entries(theme.typography)) {
    if (key === 'font-family' || key === 'fontFamily') {
      vars['--font-sans'] = value;
    } else if (key === 'heading-weight' || key === 'headingWeight') {
      vars['--font-heading'] = value;
    } else {
      vars[`--${key}`] = value;
    }
  }

  // Spacing
  for (const [key, value] of Object.entries(theme.spacing)) {
    vars[`--space-${key}`] = value;
  }

  // Radius
  for (const [key, value] of Object.entries(theme.radius)) {
    vars[`--radius-${key}`] = value;
  }

  // Shadows
  for (const [key, value] of Object.entries(theme.shadows)) {
    vars[`--shadow-${key}`] = value;
  }

  return vars;
}

/**
 * Generate CSS from theme config.
 *
 * A value is written only when it is a value and nothing more: one holding
 * `;`, a brace, `<`, a backslash, a line break, `@` or `url(` is left out, as
 * is a name that is not a custom property's. Written as they came, a colour of
 * `red; } body { display: none } :root {` ended the rule and styled the whole
 * page, and `url(…)` loaded whatever it named.
 */
export function themeConfigToCss(theme: ThemeConfig, selector: string = ':root'): string {
  const vars = themeConfigToCssVariables(theme);
  const rules = Object.entries(vars)
    .filter(([key, value]) => /^--[A-Za-z0-9_-]+$/.test(key) && !/[;{}<>\\\r\n@]|url\s*\(/i.test(value))
    .map(([key, value]) => `  ${key}: ${value};`)
    .join('\n');

  return `${selector} {\n${rules}\n}`;
}

/**
 * Merge a child theme with its parent
 */
export function mergeThemes(parent: ThemeConfig, child: ThemeConfig): ThemeConfig {
  return {
    name: child.name,
    colors: { ...parent.colors, ...child.colors },
    typography: { ...parent.typography, ...child.typography },
    spacing: { ...parent.spacing, ...child.spacing },
    radius: { ...parent.radius, ...child.radius },
    shadows: { ...parent.shadows, ...child.shadows },
  };
}

/** How many themes deep an `extends` chain is followed. */
const MAX_EXTENDS = 32;

/**
 * Resolve theme inheritance and return all resolved themes
 */
export function resolveThemes(parsed: ParsedThemeFile): ThemeConfig[] {
  const themeMap = new Map<string, ThemeConfig>();

  // First pass: collect all themes
  for (const theme of parsed.themes) {
    themeMap.set(theme.name, theme);
  }

  // Second pass: resolve inheritance. A parent is resolved before it is
  // merged, so `brand` extending `dark`, which extends `default`, has
  // `default`'s values too: only the parent's own were merged, and a theme
  // two steps down lost everything its grandparent gave. An `extends` that
  // comes round to a theme already on the way (or runs past MAX_EXTENDS)
  // ends there; a parent not found leaves the theme as it is.
  const resolve = (theme: ThemeConfig, seen: ReadonlySet<string>): ThemeConfig => {
    const parent = theme.extends ? themeMap.get(theme.extends) : undefined;
    if (!parent || seen.has(parent.name) || seen.size >= MAX_EXTENDS) return theme;
    return mergeThemes(resolve(parent, new Set([...seen, parent.name])), theme);
  };

  return parsed.themes.map((theme) => resolve(theme, new Set([theme.name])));
}

/**
 * Generate complete CSS from a theme file
 */
export function generateThemeCss(source: string): string {
  const parsed = parseThemeFile(source);
  const resolved = resolveThemes(parsed);

  const cssBlocks: string[] = [];

  for (const theme of resolved) {
    if (theme.name === 'default' || theme.name === 'light') {
      cssBlocks.push(themeConfigToCss(theme, ':root'));
    } else if (theme.name === 'dark') {
      cssBlocks.push(themeConfigToCss(theme, ':root.dark, [data-theme="dark"]'));
    } else if (/^[A-Za-z0-9_-]+$/.test(theme.name)) {
      // A name goes into the selector, so only a name's characters: `x"] , body {` is none.
      cssBlocks.push(themeConfigToCss(theme, `[data-theme="${theme.name}"]`));
    }
  }

  return cssBlocks.join('\n\n');
}
