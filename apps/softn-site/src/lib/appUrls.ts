/**
 * Where the three SoftN apps live, as seen from this page.
 *
 * A deployed softn.com serves all four builds from one origin — the site at `/`
 * and each app under its own directory — so the defaults are plain paths and no
 * configuration is needed. `npm run dev` provides those same paths through the
 * site's proxy; a standalone `npm run dev:site` falls back to the apps' direct
 * localhost ports. Either default can be replaced with a `VITE_*_URL` entry in
 * `apps/softn-site/.env.local`.
 */

const DEV = import.meta.env.DEV;

function resolve(configured: string | undefined, devUrl: string, prodPath: string): string {
  if (configured) return configured.replace(/\/+$/, '');
  return DEV ? devUrl : prodPath;
}

export const WEB_URL = resolve(import.meta.env.VITE_WEB_URL, 'http://localhost:1420', '/web');
export const BUILDER_URL = resolve(import.meta.env.VITE_BUILDER_URL, 'http://localhost:1422', '/builder');
export const STUDIO_URL = resolve(import.meta.env.VITE_STUDIO_URL, 'http://localhost:1423', '/studio');

/**
 * The same app as a link target.
 *
 * The trailing slash matters in a deployed build: `/studio` is a file that does
 * not exist, and only some static hosts will guess that you meant the directory.
 */
export const WEB_HREF = `${WEB_URL}/`;
export const BUILDER_HREF = `${BUILDER_URL}/`;
export const STUDIO_HREF = `${STUDIO_URL}/`;

export const REPO_URL = 'https://github.com/f2i-com/softn.com';
export const ZIPP_URL = 'https://github.com/f2i-com/zipp.org';
export const XDB_URL = 'https://github.com/f2i-com/xdb.org';

/**
 * Where a published app plays: in the runtime, under the slim bar it draws
 * over every app, with the way back to the app's own page on the site.
 * There is one way to run an app on this site, and this is it.
 */
export function runtimeAppUrl(slug: string): string {
  return `${WEB_URL}/app/${encodeURIComponent(slug)}?back=${encodeURIComponent(`/app/${slug}`)}`;
}
