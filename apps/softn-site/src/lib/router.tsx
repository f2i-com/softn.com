import React, { useEffect, useState } from 'react';

/**
 * The site's routes, on the history API and nothing else.
 *
 * Four pages share one bundle: the home page, the directory, an app's page
 * and the publish form. A real path for each — /app/space-invaders, not a
 * hash — is what makes a link to an app worth pasting, and the deployed
 * .htaccess hands every one of them the same index.html. Anything the SPA
 * does not own (/web/, /studio/, /builder/, /api/, /demos/) is a normal
 * navigation to another app on the same origin.
 */
export interface Route {
  path: string;
  query: URLSearchParams;
  hash?: string;
}

const OWNED = /^\/(?:apps|app\/[^/]+|publish)\/?$/;
const FOREIGN = /^\/(?:web|studio|builder|api|demos|softn-files)(?:\/|$)/;

function read(): Route {
  return { path: window.location.pathname.replace(/\/+$/, '') || '/', query: new URLSearchParams(window.location.search), hash: window.location.hash };
}

const listeners = new Set<() => void>();

export function navigate(to: string, replace = false): void {
  const url = new URL(to, window.location.origin);
  if (url.origin !== window.location.origin) {
    window.location.assign(to);
    return;
  }
  if (replace) window.history.replaceState({}, '', url.pathname + url.search + url.hash);
  else window.history.pushState({}, '', url.pathname + url.search + url.hash);
  for (const l of listeners) l();
  if (!url.hash) window.scrollTo({ top: 0 });
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => (typeof window === 'undefined' ? { path: '/', query: new URLSearchParams() } : read()));
  useEffect(() => {
    const update = () => setRoute(read());
    listeners.add(update);
    window.addEventListener('popstate', update);
    window.addEventListener('hashchange', update);
    return () => {
      listeners.delete(update);
      window.removeEventListener('popstate', update);
      window.removeEventListener('hashchange', update);
    };
  }, []);
  return route;
}

/** Whether a same-origin path is one of this SPA's own pages. */
export function isOwnedPath(pathname: string): boolean {
  return pathname === '/' || (OWNED.test(pathname) && !FOREIGN.test(pathname));
}

/** Which page a path is, decided by the same pattern that decides which links are the SPA's to follow. */
export type Page = { kind: 'home' } | { kind: 'directory' } | { kind: 'app'; slug: string } | { kind: 'publish' } | { kind: 'not-found' };

/**
 * The page for a path. Anything `OWNED` does not name is not-found — the
 * app used to fall back to the home page there, so a mistyped or stale
 * link looked like the front door. The deployed .htaccess still serves
 * index.html for every path, so this is the only place an unknown one is
 * told apart.
 */
export function selectPage(pathname: string): Page {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return { kind: 'home' };
  if (!isOwnedPath(path)) return { kind: 'not-found' };
  if (path === '/apps') return { kind: 'directory' };
  if (path === '/publish') return { kind: 'publish' };
  const app = path.match(/^\/app\/([^/]+)$/);
  if (app) {
    let slug = app[1];
    try {
      slug = decodeURIComponent(slug);
    } catch {
      /* a stray percent sign stays as it is */
    }
    return { kind: 'app', slug };
  }
  return { kind: 'not-found' };
}

/**
 * Clicks on links to the SPA's own pages become navigations without a page
 * load, wherever the link is. Installed once by the app; nothing else needs
 * to know the router exists to link into it.
 */
export function useLinkInterception(): void {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const target = (e.target as Element | null)?.closest('a');
      if (!target || target.target || target.hasAttribute('download')) return;
      const href = target.getAttribute('href');
      if (!href || href.startsWith('#')) return;
      let url: URL;
      try {
        url = new URL(href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin || !isOwnedPath(url.pathname)) return;
      e.preventDefault();
      navigate(url.pathname + url.search + url.hash);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);
}

export function Link({ to, children, ...rest }: { to: string; children: React.ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>): React.ReactElement {
  return (
    <a href={to} {...rest}>
      {children}
    </a>
  );
}
