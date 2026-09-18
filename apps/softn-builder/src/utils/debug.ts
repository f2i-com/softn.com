/**
 * The builder's diagnostics.
 *
 * `debug` is core's, so the whole product has one switch rather than one per
 * app: on in a development build, off in a production one unless somebody sets
 * `localStorage['softn.debug'] = '1'` in the page. `debugWarn` is for warnings
 * that only mean something while the builder itself is being worked on; real
 * warnings go to `console.warn` directly.
 */
import { debug, debugEnabled } from '@softn/core';

export { debug };

export function debugWarn(...args: unknown[]): void {
  if (debugEnabled()) console.warn(...args);
}
