import React, { useEffect, useState } from 'react';
import { Nav } from './components/Nav';
import { Footer } from './components/Footer';
import { HomePage } from './pages/HomePage';
import { DirectoryPage } from './pages/DirectoryPage';
import { AppPage } from './pages/AppPage';
import { PublishPage } from './pages/PublishPage';
import { useLinkInterception, useRoute } from './lib/router';
import { getCategories, type Category } from './lib/api';

/**
 * Four pages on one bundle. The directory API is asked for the categories
 * once; if it does not answer, every page still renders and says so, and the
 * demos on the home page still run — they are files, not database rows.
 */
export default function App(): React.ReactElement {
  const route = useRoute();
  useLinkInterception();
  const [categories, setCategories] = useState<Category[]>([]);
  const [apiDown, setApiDown] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    getCategories(ac.signal)
      .then((c) => {
        setCategories(c);
        setApiDown(null);
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        setApiDown(e instanceof Error ? e.message : String(e));
      });
    return () => ac.abort();
  }, []);

  useEffect(() => {
    if (route.path === '/') document.title = 'SoftN — apps that run anywhere, safely';
  }, [route.path]);

  let page: React.ReactElement;
  const appMatch = route.path.match(/^\/app\/([^/]+)$/);
  if (route.path === '/apps') {
    page = <DirectoryPage route={route} categories={categories} apiDown={apiDown} />;
  } else if (appMatch) {
    let slug = appMatch[1];
    try {
      slug = decodeURIComponent(slug);
    } catch {
      /* a stray percent sign stays as it is */
    }
    page = <AppPage slug={slug} categories={categories} route={route} />;
  } else if (route.path === '/publish') {
    page = <PublishPage route={route} categories={categories} onCategories={setCategories} apiDown={apiDown} />;
  } else {
    page = <HomePage categories={categories} apiDown={apiDown} />;
  }

  return (
    <>
      <Nav />
      {route.path === '/' ? <main>{page}</main> : page}
      <Footer />
    </>
  );
}
