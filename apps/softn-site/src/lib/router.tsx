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
}

const OWNED = /^\/(?:apps|app\/[^/]+|publish)\/?$/;
const FOREIGN = /^\/(?:web|studio|builder|api|demos|softn-files)(?:\/|$)/;

function read(): Route {
  return { path: window.location.pathname.replace(/\/+$/, '') || '/', query: new URLSearchParams(window.location.search) };
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
    return () => {
      listeners.delete(update);
      window.removeEventListener('popstate', update);
    };
  }, []);
  return route;
}

/** Whether a same-origin path is one of this SPA's own pages. */
export function isOwnedPath(pathname: string): boolean {
  return pathname === '/' || (OWNED.test(pathname) && !FOREIGN.test(pathname));
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
