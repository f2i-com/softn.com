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

  // Simple regex-based parser for theme files
  const themeRegex = /<theme\s+([^>]*)>([\s\S]*?)<\/theme>/gi;
  let match;

  while ((match = themeRegex.exec(source)) !== null) {
    const attributes = match[1];
    const content = match[2];

    const theme = parseThemeBlock(attributes, content);
    themes.push(theme);
  }

  return { themes };
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

  // Parse colors block
  const colorsMatch = /<colors>([\s\S]*?)<\/colors>/i.exec(content);
  if (colorsMatch) {
    theme.colors = parseSimpleBlock(colorsMatch[1]);
  }

  // Parse typography block
  const typographyMatch = /<typography>([\s\S]*?)<\/typography>/i.exec(content);
  if (typographyMatch) {
    theme.typography = parseSimpleBlock(typographyMatch[1]);
  }

  // Parse spacing block
  const spacingMatch = /<spacing>([\s\S]*?)<\/spacing>/i.exec(content);
  if (spacingMatch) {
    theme.spacing = parseSimpleBlock(spacingMatch[1]);
  }

  // Parse radius block
  const radiusMatch = /<radius>([\s\S]*?)<\/radius>/i.exec(content);
  if (radiusMatch) {
    theme.radius = parseSimpleBlock(radiusMatch[1]);
  }

  // Parse shadows block
  const shadowsMatch = /<shadows>([\s\S]*?)<\/shadows>/i.exec(content);
  if (shadowsMatch) {
    theme.shadows = parseSimpleBlock(shadowsMatch[1]);
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
 * Generate CSS from theme config
 */
export function themeConfigToCss(theme: ThemeConfig, selector: string = ':root'): string {
  const vars = themeConfigToCssVariables(theme);
  const rules = Object.entries(vars)
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

/**
 * Resolve theme inheritance and return all resolved themes
 */
export function resolveThemes(parsed: ParsedThemeFile): ThemeConfig[] {
  const themeMap = new Map<string, ThemeConfig>();

  // First pass: collect all themes
  for (const theme of parsed.themes) {
    themeMap.set(theme.name, theme);
  }

  // Second pass: resolve inheritance
  const resolved: ThemeConfig[] = [];

  for (const theme of parsed.themes) {
    if (theme.extends) {
      const parent = themeMap.get(theme.extends);
      if (parent) {
        resolved.push(mergeThemes(parent, theme));
      } else {
        // Parent not found, use as-is
        resolved.push(theme);
      }
    } else {
      resolved.push(theme);
    }
  }

  return resolved;
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
    } else {
      cssBlocks.push(themeConfigToCss(theme, `[data-theme="${theme.name}"]`));
    }
  }

  return cssBlocks.join('\n\n');
}
