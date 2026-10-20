import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Nav } from './components/Nav';
import { Footer } from './components/Footer';
import { HomePage } from './pages/HomePage';
import { DirectoryPage } from './pages/DirectoryPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { DropAnywhere } from './components/DropAnywhere';
import { selectPage, useLinkInterception, useRoute } from './lib/router';
import { getCategories, type Category } from './lib/api';
import { applyMeta, HOME_TITLE, metaFor } from './lib/meta';

// An app's page and the publish page load the first time they are visited:
// the landing page and the directory use neither, and the publish page alone
// is some 70 KB with the bundle checks it runs in the browser.
const AppPage = lazy(() => import('./pages/AppPage').then((m) => ({ default: m.AppPage })));
const PublishPage = lazy(() => import('./pages/PublishPage').then((m) => ({ default: m.PublishPage })));

/** Says when a page that loads on demand has arrived, so focus and a fragment can find it. */
function Arrived({ onArrive, children }: { onArrive: () => void; children: React.ReactNode }): React.ReactElement {
  useEffect(onArrive, [onArrive]);
  return <>{children}</>;
}

/**
 * Four pages on one bundle, and a fifth for paths that are none of them.
 * The directory API is asked for the categories once; if that does not
 * answer, every page still renders — and still asks for its apps. The
 * categories are labels on the cards and chips to filter by, not a
 * precondition for the list: an earlier version treated their failure as
 * "the directory is down" and skipped the app-list request on every page,
 * so a taxonomy endpoint could make a working directory look empty. Each
 * request now carries its own status, and categories can be retried in
 * place. No page runs an app: pressing Play hands the visitor to the
 * runtime.
 */
export default function App(): React.ReactElement {
  const route = useRoute();
  useLinkInterception();
  const [categories, setCategories] = useState<Category[]>([]);
  const [categoriesError, setCategoriesError] = useState<string | null>(null);
  const [categoriesAttempt, setCategoriesAttempt] = useState(0);
  const retryCategories = () => setCategoriesAttempt((n) => n + 1);

  useEffect(() => {
    const ac = new AbortController();
    getCategories(ac.signal)
      .then((c) => {
        setCategories(c);
        setCategoriesError(null);
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        setCategoriesError(e instanceof Error ? e.message : String(e));
      });
    return () => ac.abort();
  }, [categoriesAttempt]);

  const selected = selectPage(route.path);
  // Counts the arrivals of on-demand pages: the effects below run again when
  // one has, as the page they look for was not there when the path changed.
  const [arrivals, setArrivals] = useState(0);
  const arrive = useRef(() => setArrivals((n) => n + 1)).current;

  useEffect(() => {
    if (route.path === '/') document.title = HOME_TITLE;
  }, [route.path]);

  // The canonical URL, description and robots line for the route (lib/meta).
  // Only a change of page reapplies them, so the description an app's page
  // sets once its app has loaded is not reset by a search or a filter.
  const metaKey = selected.kind === 'app' ? `app:${selected.slug}` : selected.kind;
  useEffect(() => {
    applyMeta(metaFor(selectPage(route.path)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- metaKey is the page; route.path within one page changes nothing here
  }, [metaKey]);

  // pushState does not perform native fragment scrolling. Wait until the
  // destination page is mounted, then resolve the ID without a CSS selector.
  useEffect(() => {
    if (!route.hash) return;
    let id: string;
    try { id = decodeURIComponent(route.hash.slice(1)); } catch { return; }
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(id);
      if (!target) return;
      if (!target.hasAttribute('tabindex')) target.tabIndex = -1;
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'start' });
    });
    return () => cancelAnimationFrame(frame);
  }, [route.path, route.hash, arrivals]);

  // A change of page puts focus on its main content, so a keyboard or
  // screen-reader visitor starts where the new page starts instead of on
  // the body or a link that has gone. Only a change of path counts: a
  // search, a filter or a retry is the same page with a different query
  // and a refreshed list, and focus stays where the visitor put it. The
  // first render is left alone too.
  const lastPath = useRef(route.path);
  useEffect(() => {
    if (lastPath.current === route.path) return;
    const main = document.querySelector<HTMLElement>('main');
    // A page still loading has no main yet: this runs again when it arrives.
    if (!main) return;
    lastPath.current = route.path;
    if (!main.hasAttribute('tabindex')) main.tabIndex = -1;
    main.focus({ preventScroll: true });
  }, [route.path, arrivals]);

  let page: React.ReactElement;
  switch (selected.kind) {
    case 'directory':
      page = <DirectoryPage route={route} categories={categories} categoriesError={categoriesError} onRetryCategories={retryCategories} />;
      break;
    case 'app':
      page = <Arrived onArrive={arrive}><AppPage slug={selected.slug} categories={categories} route={route} /></Arrived>;
      break;
    case 'publish':
      page = <Arrived onArrive={arrive}><PublishPage route={route} categories={categories} onCategories={setCategories} categoriesError={categoriesError} onRetryCategories={retryCategories} /></Arrived>;
      break;
    case 'not-found':
      page = <NotFoundPage path={route.path} />;
      break;
    case 'home':
      page = <HomePage categories={categories} categoriesError={categoriesError} onRetryCategories={retryCategories} />;
      break;
  }

  return (
    <>
      <Nav />
      {selected.kind === 'home' ? <main>{page}</main> : <Suspense fallback={null}>{page}</Suspense>}
      <Footer />
      <DropAnywhere onPublishPage={selected.kind === 'publish'} />
    </>
  );
}
