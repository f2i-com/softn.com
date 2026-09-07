import React, { useEffect, useState } from 'react';
import { Nav } from './components/Nav';
import { Footer } from './components/Footer';
import { HomePage } from './pages/HomePage';
import { DirectoryPage } from './pages/DirectoryPage';
import { AppPage } from './pages/AppPage';
import { PublishPage } from './pages/PublishPage';
import { DropAnywhere } from './components/DropAnywhere';
import { useLinkInterception, useRoute } from './lib/router';
import { getCategories, type Category } from './lib/api';

/**
 * Four pages on one bundle. The directory API is asked for the categories
 * once; if that does not answer, every page still renders — and still asks
 * for its apps. The categories are labels on the cards and chips to filter
 * by, not a precondition for the list: an earlier version treated their
 * failure as "the directory is down" and skipped the app-list request on
 * every page, so a taxonomy endpoint could make a working directory look
 * empty. Each request now carries its own status, and categories can be
 * retried in place. No page runs an app: pressing Play hands the visitor to
 * the runtime.
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

  useEffect(() => {
    if (route.path === '/') document.title = 'SoftN — apps that run anywhere, safely';
  }, [route.path]);

  let page: React.ReactElement;
  const appMatch = route.path.match(/^\/app\/([^/]+)$/);
  if (route.path === '/apps') {
    page = <DirectoryPage route={route} categories={categories} categoriesError={categoriesError} onRetryCategories={retryCategories} />;
  } else if (appMatch) {
    let slug = appMatch[1];
    try {
      slug = decodeURIComponent(slug);
    } catch {
      /* a stray percent sign stays as it is */
    }
    page = <AppPage slug={slug} categories={categories} route={route} />;
  } else if (route.path === '/publish') {
    page = <PublishPage route={route} categories={categories} onCategories={setCategories} categoriesError={categoriesError} onRetryCategories={retryCategories} />;
  } else {
    page = <HomePage categories={categories} categoriesError={categoriesError} onRetryCategories={retryCategories} />;
  }

  return (
    <>
      <Nav />
      {route.path === '/' ? <main>{page}</main> : page}
      <Footer />
      <DropAnywhere onPublishPage={route.path === '/publish'} />
    </>
  );
}
