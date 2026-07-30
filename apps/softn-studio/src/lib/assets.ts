/**
 * Paths to files shipped in `public/`.
 *
 * Vite rewrites absolute asset URLs it finds in `index.html`, but not ones
 * written as strings in a component — so a hardcoded `/studio-icon.png` breaks
 * the moment Studio is served from a subpath like `/studio/`, which is exactly
 * how softn.com deploys it. `BASE_URL` always carries a trailing slash.
 */
export const STUDIO_ICON = `${import.meta.env.BASE_URL}studio-icon.png`;
