/**
 * Where the rest of the site is, from Builder. The rule (paths under one
 * origin in production and under the integrated dev launcher, ports in
 * standalone development, softn.com from the desktop build) is
 * @softn/brand's; this feeds it Builder's inputs.
 */

import { resolveSiteUrls } from '@softn/brand';
import { isDesktop } from './desktop';

export const { STUDIO_URL, RUNTIME_URL, SITE_URL, PRODUCT_URLS } = resolveSiteUrls({
  desktop: isDesktop(),
  dev: import.meta.env.DEV,
  baseUrl: import.meta.env.BASE_URL,
  env: import.meta.env,
});
