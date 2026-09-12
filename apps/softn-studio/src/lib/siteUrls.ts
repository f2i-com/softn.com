/**
 * Where the rest of the site is, from Studio. In a deployment every app is a
 * path of one origin; in development each runs on its own port, so the
 * addresses can be given explicitly.
 */

// The integrated dev launcher serves Studio at /studio/ on the public site.
// Its private Vite port is not a receiving site and cannot share staged bundles.
const sharedOrigin = /^\/studio\/?$/.test(import.meta.env.BASE_URL);
const standaloneDev = import.meta.env.DEV && !sharedOrigin;
export const RUNTIME_URL = import.meta.env.VITE_WEB_URL || (standaloneDev ? 'http://localhost:1420' : '/web/');
export const SITE_URL = import.meta.env.VITE_SITE_URL || (standaloneDev ? 'http://localhost:1421' : '/');
export const PUBLISH_URL = `${SITE_URL.replace(/\/+$/, '')}/publish`;
