/**
 * Whether a build writes source maps: only a development build does
 * (`SOFTN_SOURCEMAPS=1`, which `npm run build:site:dev` sets), for testing a
 * deployment with readable stack traces. A production build — every release,
 * and `npm run build:site` — writes none: they were 19 MB of the site, read
 * by no visitor. The packages' own dist/ keep theirs for development; nothing
 * deployed copies them.
 */
export function buildSourcemaps() {
  return process.env.SOFTN_SOURCEMAPS === '1';
}
