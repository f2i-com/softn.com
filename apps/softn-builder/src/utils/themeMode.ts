/**
 * The project's theme as a file has it: one of three words, or nothing.
 *
 * `config.theme.mode` in a manifest, and `themeMode` in a saved project,
 * are "light", "dark" or "system". A runtime listens to the first two and
 * to nothing else: a declared side wins over the visitor's device, and
 * "system", no word at all and any other word leave the app following it
 * (@softn/components, theme/app-theme.ts).
 *
 * The Builder read a file with no word as "light". That was its own
 * invention, and harmless for as long as no runtime read the manifest: it
 * is written back by the next export, where it now pins an app that
 * followed its visitor's device. So what is not one of the two sides is
 * read as what the runtime makes of it, "system", and a side is in a
 * project only because its manifest said so or a person chose it.
 */

export type ThemeMode = 'light' | 'dark' | 'system';

/** Whether `value` is one of the three words a manifest may say. */
export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system';
}

/** The mode a file's value comes to: the word it is, or "system" for no word and for any other. */
export function readThemeMode(value: unknown): ThemeMode {
  return isThemeMode(value) ? value : 'system';
}
