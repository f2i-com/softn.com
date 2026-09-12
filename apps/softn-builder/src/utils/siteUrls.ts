/**
 * Where the rest of the site is, from Builder. A deployed softn.com puts
 * every app under one origin; in development each runs on its own port, so
 * the addresses can be given explicitly.
 */

import { isDesktop } from './desktop';

const desktop = isDesktop();
export const STUDIO_URL = desktop ? 'https://softn.com/studio/' : import.meta.env.VITE_STUDIO_URL || (import.meta.env.DEV ? 'http://localhost:1423' : '/studio/');
export const RUNTIME_URL = desktop ? 'https://softn.com/web/' : import.meta.env.VITE_WEB_URL || (import.meta.env.DEV ? 'http://localhost:1420' : '/web/');
export const SITE_URL = desktop ? 'https://softn.com/' : import.meta.env.VITE_SITE_URL || (import.meta.env.DEV ? 'http://localhost:1421' : '/');
export const PUBLISH_URL = `${SITE_URL.replace(/\/+$/, '')}/publish`;
export const PRODUCT_URLS = desktop ? {
  home: SITE_URL, apps: 'https://softn.com/apps', runtime: RUNTIME_URL,
  studio: STUDIO_URL, builder: 'https://softn.com/builder/', publish: PUBLISH_URL,
} : undefined;
