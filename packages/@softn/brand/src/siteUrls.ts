/**
 * Where the rest of the site is, from inside one of its apps.
 *
 * A deployed softn.com puts every app under one origin, so the addresses
 * are paths. In development each app can run on its own port — its own
 * origin — unless the integrated dev launcher is serving it under the
 * public site's path (`/studio/`, `/builder/`), in which case that launcher
 * is the one origin and the paths are right again. A desktop build has no
 * site of its own and points at softn.com.
 *
 * Builder and Studio each had a copy of this rule and each knew half of it:
 * one the desktop build, the other the integrated launcher. This is the
 * union, pure so an app can feed it `import.meta.env` and a test can feed
 * it anything.
 */

import { DEFAULT_URLS, type ProductUrls } from './ProductBar';

export interface SiteUrlInputs {
  /** A desktop (Tauri) build: the site is softn.com, wherever the app runs. */
  desktop?: boolean;
  /** `import.meta.env.DEV`. */
  dev: boolean;
  /** `import.meta.env.BASE_URL`; an app path here means the integrated launcher is the public origin. */
  baseUrl?: string;
  /** `import.meta.env`, or any object naming the receivers (VITE_SITE_URL, VITE_WEB_URL, VITE_STUDIO_URL, VITE_BUILDER_URL). */
  env: { readonly [key: string]: unknown };
}

export interface SiteUrls {
  SITE_URL: string;
  RUNTIME_URL: string;
  STUDIO_URL: string;
  BUILDER_URL: string;
  PUBLISH_URL: string;
  /** The product bar's addresses when they are not the defaults (desktop); undefined otherwise. */
  PRODUCT_URLS: ProductUrls | undefined;
}

const PRODUCTION = 'https://softn.com';

export function resolveSiteUrls(input: SiteUrlInputs): SiteUrls {
  if (input.desktop) {
    const site = `${PRODUCTION}/`;
    const urls: SiteUrls = {
      SITE_URL: site,
      RUNTIME_URL: `${PRODUCTION}${DEFAULT_URLS.runtime}`,
      STUDIO_URL: `${PRODUCTION}${DEFAULT_URLS.studio}`,
      BUILDER_URL: `${PRODUCTION}${DEFAULT_URLS.builder}`,
      PUBLISH_URL: `${PRODUCTION}${DEFAULT_URLS.publish}`,
      PRODUCT_URLS: undefined,
    };
    urls.PRODUCT_URLS = {
      home: urls.SITE_URL,
      apps: `${PRODUCTION}${DEFAULT_URLS.apps}`,
      runtime: urls.RUNTIME_URL,
      studio: urls.STUDIO_URL,
      builder: urls.BUILDER_URL,
      publish: urls.PUBLISH_URL,
      docs: `${PRODUCTION}${DEFAULT_URLS.docs}`,
      repo: DEFAULT_URLS.repo,
    };
    return urls;
  }
  // The integrated dev launcher serves an editor under its public path. Its
  // private Vite port is not a receiving site and cannot share staged bundles.
  const sharedOrigin = /^\/(?:studio|builder|web)\/?$/.test(input.baseUrl ?? '/');
  const standaloneDev = input.dev && !sharedOrigin;
  const configured = (key: string): string => {
    const value = input.env[key];
    return typeof value === 'string' ? value : '';
  };
  const SITE_URL = configured('VITE_SITE_URL') || (standaloneDev ? 'http://localhost:1421' : DEFAULT_URLS.home);
  return {
    SITE_URL,
    RUNTIME_URL: configured('VITE_WEB_URL') || (standaloneDev ? 'http://localhost:1420' : DEFAULT_URLS.runtime),
    STUDIO_URL: configured('VITE_STUDIO_URL') || (standaloneDev ? 'http://localhost:1423' : DEFAULT_URLS.studio),
    BUILDER_URL: configured('VITE_BUILDER_URL') || (standaloneDev ? 'http://localhost:1422' : DEFAULT_URLS.builder),
    PUBLISH_URL: `${SITE_URL.replace(/\/+$/, '')}${DEFAULT_URLS.publish}`,
    PRODUCT_URLS: undefined,
  };
}
