/**
 * Where the rest of the site is, from Studio. The rule (paths under one
 * origin in production and under the integrated dev launcher, ports in
 * standalone development) is @softn/brand's; this feeds it Studio's inputs.
 */

import { resolveSiteUrls } from '@softn/brand';

export const { RUNTIME_URL, SITE_URL, PUBLISH_URL } = resolveSiteUrls({
  dev: import.meta.env.DEV,
  baseUrl: import.meta.env.BASE_URL,
  env: import.meta.env,
});
