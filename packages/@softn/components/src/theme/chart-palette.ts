/**
 * The series colours a chart cycles through when a series names none.
 *
 * Charts used to hard-code one hex list each, so a dark theme drew its
 * series in colours chosen for a white page. The palette is now six CSS
 * custom properties, `--color-chart-1` … `--color-chart-6`, that the
 * ThemeProvider writes for the light theme and the dark theme (`chart` on a
 * theme's colours, so a custom theme can bring its own), and the charts ask
 * this module for them. What a chart gets back is a `var()` reference with
 * the light value as its fallback: the browser resolves it where the chart
 * is painted, follows a theme switch without a re-render, and a host with no
 * ThemeProvider at all still sees the colours the charts always had.
 */

/** The light palette: the six colours charts shipped with, in that order. */
export const CHART_PALETTE_LIGHT: readonly string[] = [
  '#6366f1',
  '#ef4444',
  '#10b981',
  '#f59e0b',
  '#8b5cf6',
  '#ec4899',
];

/** The same six hues one step lighter, for a dark surface. */
export const CHART_PALETTE_DARK: readonly string[] = [
  '#818cf8',
  '#f87171',
  '#34d399',
  '#fbbf24',
  '#a78bfa',
  '#f472b6',
];

/** The custom property a palette slot is published under (1-based). */
export function chartColorVariable(slot: number): string {
  return `--color-chart-${slot}`;
}

/**
 * The palette as the charts consume it: one `var(--color-chart-n, <light>)`
 * per slot. Constant strings, safe to build once at module load.
 */
export function chartPalette(): readonly string[] {
  return CHART_PALETTE_LIGHT.map((hex, index) => `var(${chartColorVariable(index + 1)}, ${hex})`);
}

/** The colour for series `index`, cycling through the palette. */
export function chartColor(index: number): string {
  const palette = chartPalette();
  const slot = ((index % palette.length) + palette.length) % palette.length;
  return palette[slot];
}
