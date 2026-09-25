/**
 * Checks on values a component writes into CSS itself — a colour prop into
 * `background`, a column count or a theme token into `<style>` text. Pure
 * functions with no egress policy behind them (see egress.ts for the policy
 * questions), and no dependency on @softn/core, so the theme entry can use
 * them.
 */

/**
 * Functions a colour prop may use: every colour notation, the gradients (a
 * gradient is painted, not fetched) and `var()`/`calc()`. Nothing that loads.
 */
const PAINT_FUNCTIONS = new Set([
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'hwb',
  'lab',
  'lch',
  'oklab',
  'oklch',
  'color',
  'color-mix',
  'light-dark',
  'var',
  'calc',
  'linear-gradient',
  'radial-gradient',
  'conic-gradient',
  'repeating-linear-gradient',
  'repeating-radial-gradient',
  'repeating-conic-gradient',
]);

/**
 * A colour prop as the component may paint it: the value when it is a colour
 * (or a gradient of colours), `undefined` otherwise.
 *
 * A component that writes its `color`, `gutterColor` or `badgeColor` prop
 * into `background` — or interpolates it into a gradient there — gave the
 * bundle a background image by another name: `url(https://…)` is not a
 * colour, but `background` accepts it and the browser fetches it, with or
 * without `net` and before the user has answered the consent bar. Unlike a
 * `background` prop, which may legitimately be an image and is judged against
 * the policy (see {@link judgeCssValue}), a colour never needs to load
 * anything, so this is an allow-list of what a colour is made of rather than
 * a search for what loads: plain characters only — no quotes, backslashes,
 * comments, `:`, `;`, `@` or braces, so no escape or second declaration — and
 * no function outside {@link PAINT_FUNCTIONS}, which refuses `url(`,
 * `image-set(`, `-webkit-image-set(`, `image(`, `element(` and any spelling a
 * later CSS adds. That also stops a value that closes the gradient it is
 * interpolated into and opens an image layer after it.
 */
export function cssPaint(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length > 512 || !/^[A-Za-z0-9_\s#%.,()/+-]*$/.test(value)) return undefined;
  for (const match of value.matchAll(/(-?[A-Za-z_][A-Za-z0-9_-]*)\s*\(/g)) {
    if (!PAINT_FUNCTIONS.has(match[1].toLowerCase())) return undefined;
  }
  return value;
}

/**
 * A column count a component writes into `<style>` text: a whole number from
 * 1 to 64, or `fallback`. The responsive grids interpolate `columns.md` and
 * friends into a stylesheet, not a style object, where a string such as
 * `1fr); } x { background: url(https://…) } y {` would add a rule of the
 * bundle's own — and fetch — with nothing between it and the page.
 */
export function cssColumnCount(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 64 ? n : fallback;
}

/**
 * Functions a theme token may use, beyond a colour's: the timing functions a
 * transition token is made of and the comparison functions a length may be.
 */
const THEME_FUNCTIONS = new Set([...PAINT_FUNCTIONS, 'cubic-bezier', 'steps', 'min', 'max', 'clamp', 'env']);

/** A quoted font family name: letters, digits, spaces and a little punctuation. */
const QUOTED_NAME = /"[A-Za-z0-9 _.,-]*"|'[A-Za-z0-9 _.,-]*'/g;

/**
 * A theme token as the ThemeProvider may write it into its stylesheet: the
 * value when it is a colour, a length, a font stack, a shadow, a duration or a
 * timing function; `undefined` otherwise.
 *
 * The provider writes `--name: value;` into `<style>` text, not a style
 * object, so a value is a way out of its declaration: `red; } body {
 * background: url(https://…) } x {` adds a rule of its own, `</style>` ends
 * the element, a backslash escape or a comment hides a function name from any
 * later check. This is {@link cssPaint}'s allow-list with the little more a
 * theme needs — quoted family names, `*` for `calc()`, the timing functions —
 * and nothing that ends a declaration (`;` `{` `}` `:` `!`), opens markup
 * (`<` `>` `&`), escapes (`\`), comments (`/*`) or at-rules (`@`), and no
 * function outside {@link THEME_FUNCTIONS}, so nothing that fetches.
 */
export function cssThemeValue(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value !== 'string') return undefined;
  if (value.length === 0 || value.length > 512) return undefined;
  if (!/^[A-Za-z0-9_ \t#%.,()/*+"'-]*$/.test(value)) return undefined;
  if (value.includes('/*') || value.includes('*/')) return undefined;
  // Quotes only around a plain family name; a stray one could open a string
  // that runs over the end of the declaration.
  const unquoted = value.replace(QUOTED_NAME, '""');
  if (/["']/.test(unquoted.replace(/""/g, ''))) return undefined;
  let depth = 0;
  for (const ch of unquoted) {
    if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) return undefined;
  }
  if (depth !== 0) return undefined;
  for (const match of unquoted.matchAll(/(-?[A-Za-z_][A-Za-z0-9_-]*)\s*\(/g)) {
    if (!THEME_FUNCTIONS.has(match[1].toLowerCase())) return undefined;
  }
  return value;
}

/** A custom property name segment a theme may contribute: `primary`, `2xl`, `0_5`. */
export function cssThemeKey(key: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(key);
}
