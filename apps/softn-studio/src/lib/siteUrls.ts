/**
 * Where the rest of the site is, from Studio. In a deployment every app is a
 * path of one origin; in development each runs on its own port, so the
 * addresses can be given explicitly.
 */

export const RUNTIME_URL = import.meta.env.VITE_WEB_URL || (import.meta.env.DEV ? 'http://localhost:1420' : '/web/');
export const SITE_URL = import.meta.env.VITE_SITE_URL || (import.meta.env.DEV ? 'http://localhost:1421' : '/');
export const PUBLISH_URL = `${SITE_URL.replace(/\/+$/, '')}/publish`;
