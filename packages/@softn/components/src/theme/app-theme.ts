/**
 * Which side, light or dark, an app is drawn in: the one rule, for every
 * host that draws one.
 *
 * Several things have a say, and until this was written each host listened
 * to its own selection of them and none to the project:
 *
 *  - the project, in its manifest: `config.theme.mode`, "light", "dark" or
 *    "system". Builder and Studio write it, Builder draws its canvas and its
 *    Preview by it, and no runtime read it;
 *  - the page, in its own `<App theme="light|dark">`, written as the word or
 *    worked out while the app runs (`theme={darkMode ? "dark" : "light"}`);
 *  - the host: softn.com's own page theme in the web runtime and the desktop
 *    shell's in the loader (the host document's `data-theme`), the stored
 *    `softn-theme-preference`, the device's `prefers-color-scheme`, and the
 *    default the host falls back to (a single-app deployment's `theme`).
 *
 * Two sides come out, because there are two things to colour. The tokens are
 * the custom properties every component reads, which the ThemeProvider
 * writes. The page is the `<App>` element, which names most of those
 * properties again on itself for the side it is drawn in, and leaves the
 * rest (the chart series, the code colours) to the tokens.
 *
 * The rule, first match wins, for the tokens:
 *
 *  1. An editor's preview switch (`control`), where a host has one. It is
 *     the editor's, for looking at an app both ways, and no runtime passes it.
 *  2. A project declared "light" or "dark":
 *     a. the page's own light or dark, where it pins one. The page already
 *        won for its own colours; the tokens go with it, or a page pinned
 *        light in a project declared dark would be a light page with the
 *        dark set's chart and code colours on it;
 *     b. otherwise the side the project declares. This is what wins over the
 *        host's theme, the stored preference and the device.
 *  3. A project declared "system", or nothing, or anything that is not one
 *     of the two words: what the host chose before it knew of a manifest,
 *     unchanged. The host's theme, then the stored preference, then the
 *     device, then the host's default.
 *
 * and for the page: its own light or dark where it pins one, the tokens'
 * side otherwise. Under 3 a pinned page therefore still sits on tokens that
 * follow the host, as it always did: nothing a project has not asked for
 * changes.
 *
 * There is no input for a choice the visitor makes for one app, because no
 * runtime offers one: an app that has a switch of its own (glamour-studio,
 * showcase) keeps it in its own storage and says it through the page's
 * `theme`, which is 2a. `softn-theme-preference` is not that either: it is
 * one key for the whole origin, so it stays where it was, in 3.
 */

export type ThemeSide = 'light' | 'dark';

/** What had the last word on the tokens' side. */
export type ThemeDecider = 'control' | 'page' | 'manifest' | 'host' | 'stored' | 'device' | 'fallback';

export interface AppThemeInputs {
  /** The project's `config.theme.mode`, as its manifest has it. Only "light" and "dark" decide anything. */
  manifest?: unknown;
  /** The page's own `<App theme>`, as it stands now. Only "light" and "dark" pin a side. */
  page?: unknown;
  /** An editor's preview switch. Not for a runtime. */
  control?: unknown;
  /** The host's own theme, where the host is followed. */
  host?: unknown;
  /** The stored `softn-theme-preference`, one for the whole origin. */
  stored?: unknown;
  /** The device's preference, where the host follows it. */
  device?: unknown;
  /** What the host falls back to; light where it does not say. */
  fallback?: ThemeSide;
}

export interface AppTheme {
  /** The side of the tokens every component reads. */
  tokens: ThemeSide;
  /** The side the page, `<App>`, is drawn in. */
  page: ThemeSide;
  /**
   * The side the host would have chosen with no project and no page to
   * listen to: what the document around the app is drawn in.
   */
  ambient: ThemeSide;
  /** What decided `tokens`. */
  decidedBy: ThemeDecider;
}

/** The side a value names, or undefined for anything that is not one of the two words. */
export function themeSide(value: unknown): ThemeSide | undefined {
  return value === 'light' || value === 'dark' ? value : undefined;
}

/**
 * The side a page is drawn in over tokens of a given side: its own light or
 * dark, or the tokens'. Asked by the rule below and by `<App>`, which knows
 * its own `theme` and is told the tokens' side by the provider above it.
 */
export function pageSide(pageTheme: unknown, tokens: ThemeSide): ThemeSide {
  return themeSide(pageTheme) ?? tokens;
}

export function resolveAppTheme(inputs: AppThemeInputs): AppTheme {
  const pinned = themeSide(inputs.page);
  const declared = themeSide(inputs.manifest);
  const control = themeSide(inputs.control);
  const host = themeSide(inputs.host);
  const stored = themeSide(inputs.stored);
  const device = themeSide(inputs.device);

  const [ambient, ambientFrom]: [ThemeSide, ThemeDecider] = host
    ? [host, 'host']
    : stored
      ? [stored, 'stored']
      : device
        ? [device, 'device']
        : [inputs.fallback ?? 'light', 'fallback'];

  const [tokens, decidedBy]: [ThemeSide, ThemeDecider] = control
    ? [control, 'control']
    : declared
      ? pinned
        ? [pinned, 'page']
        : [declared, 'manifest']
      : [ambient, ambientFrom];

  return { tokens, page: pageSide(inputs.page, tokens), ambient, decidedBy };
}
