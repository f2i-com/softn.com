/**
 * Diagnostics that are silent unless somebody asked for them.
 *
 * The runtime used to log its own progress with `console.log` on every page
 * it served -- the files a bundle carried, the functions its script defined,
 * its whole initial state -- so every visitor's console filled with a trace
 * meant for whoever was developing the runtime. This is where that trace goes
 * now, and it reaches the console in exactly three cases:
 *
 *  - a development build (`import.meta.env.DEV`, which the consuming app's
 *    bundler resolves -- core is compiled by tsup and leaves it in place);
 *  - `NODE_ENV=development` in Node;
 *  - somebody switched it on in a running page: `localStorage['softn.debug'] = '1'`
 *    in the page, or `globalThis.SOFTN_DEBUG = true` where there is no
 *    storage, such as a worker. Diagnosing a production page should not need
 *    a rebuild.
 *
 * Warnings and errors do not come through here. They are for the person
 * using the page and keep going to `console.warn` and `console.error`.
 */
function enabled(): boolean {
  try {
    // A cast rather than a declaration, for the reason render.tsx gives:
    // whether `import.meta.env` is typed depends on who is compiling.
    const meta = import.meta as unknown as { env?: { DEV?: boolean } } | undefined;
    if (meta?.env?.DEV) return true;
    if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'development') return true;
    const scope = globalThis as { SOFTN_DEBUG?: unknown; localStorage?: Storage };
    if (scope.SOFTN_DEBUG) return true;
    return scope.localStorage?.getItem('softn.debug') === '1';
  } catch {
    // Storage that throws on access -- a sandboxed frame, disabled cookies --
    // means nobody switched this on.
    return false;
  }
}

/** `console.log`, when diagnostics are on; nothing otherwise. */
export function debug(...args: unknown[]): void {
  // The one place a diagnostic reaches the console, and only when asked.
  // eslint-disable-next-line no-console
  if (enabled()) console.log(...args);
}

/** Whether `debug` would print, for callers that would otherwise build an
 * expensive message only to have it dropped. */
export function debugEnabled(): boolean {
  return enabled();
}
