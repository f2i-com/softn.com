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
 * A URL that opens one demo bundle in the web runtime.
 *
 * `?open=` is resolved by the runtime against its own origin and rejected if it
 * escapes it, so the path stays root-relative here — the runtime serves
 * `/demos` itself, and the site only proxies that directory so both sides can
 * use the same path.
 */
export function runtimeUrlFor(file: string, opts: { embed?: boolean } = {}): string {
  const params = new URLSearchParams({ open: `/demos/${file}` });
  if (opts.embed) params.set('embed', '1');
  return `${WEB_URL}/?${params.toString()}`;
}
