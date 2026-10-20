/**
 * The builder's diagnostics.
 *
 * `debug` is core's, so the whole product has one switch rather than one per
 * app: on in a development build, off in a production one unless somebody sets
 * `localStorage['softn.debug'] = '1'` in the page. Warnings go to
 * `console.warn` directly.
 */
import { debug } from '@softn/core';

export { debug };
