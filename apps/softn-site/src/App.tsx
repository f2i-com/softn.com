import React, { useEffect, useRef, useState } from 'react';
import { Nav } from './components/Nav';
import { Footer } from './components/Footer';
import { HomePage } from './pages/HomePage';
import { DirectoryPage } from './pages/DirectoryPage';
import { AppPage } from './pages/AppPage';
import { PublishPage } from './pages/PublishPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { DropAnywhere } from './components/DropAnywhere';
import { selectPage, useLinkInterception, useRoute } from './lib/router';
import { getCategories, type Category } from './lib/api';
import { applyMeta, HOME_TITLE, metaFor } from './lib/meta';

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
  }, [route.path, route.hash]);

  // A change of page puts focus on its main content, so a keyboard or
  // screen-reader visitor starts where the new page starts instead of on
  // the body or a link that has gone. Only a change of path counts: a
  // search, a filter or a retry is the same page with a different query
  // and a refreshed list, and focus stays where the visitor put it. The
  // first render is left alone too.
  const lastPath = useRef(route.path);
  useEffect(() => {
    if (lastPath.current === route.path) return;
    lastPath.current = route.path;
    const main = document.querySelector<HTMLElement>('main');
    if (!main) return;
    if (!main.hasAttribute('tabindex')) main.tabIndex = -1;
    main.focus({ preventScroll: true });
  }, [route.path]);

  let page: React.ReactElement;
  switch (selected.kind) {
    case 'directory':
      page = <DirectoryPage route={route} categories={categories} categoriesError={categoriesError} onRetryCategories={retryCategories} />;
      break;
    case 'app':
      page = <AppPage slug={selected.slug} categories={categories} route={route} />;
      break;
    case 'publish':
      page = <PublishPage route={route} categories={categories} onCategories={setCategories} categoriesError={categoriesError} onRetryCategories={retryCategories} />;
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
      {selected.kind === 'home' ? <main>{page}</main> : page}
      <Footer />
      <DropAnywhere onPublishPage={selected.kind === 'publish'} />
    </>
  );
}
