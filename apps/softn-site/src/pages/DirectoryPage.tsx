import React, { useEffect, useState } from 'react';
import { listApps, type AppCard as AppCardData, type Category } from '../lib/api';
import { navigate, type Route } from '../lib/router';
import { AppGrid } from '../components/directory/AppCard';
import { CategoryChips, Pagination, SearchBox, SortSelect } from '../components/directory/Controls';

function buildUrl(params: { q?: string; category?: string; sort?: string; page?: number; tag?: string }): string {
  const qs = new URLSearchParams();
  if (params.q) qs.set('q', params.q);
  if (params.category && params.category !== 'all') qs.set('category', params.category);
  if (params.tag) qs.set('tag', params.tag);
  if (params.sort && params.sort !== 'trending') qs.set('sort', params.sort);
  if (params.page && params.page > 1) qs.set('page', String(params.page));
  const s = qs.toString();
  return s ? `/apps?${s}` : '/apps';
}

export function DirectoryPage({ route, categories, apiDown }: { route: Route; categories: Category[]; apiDown: string | null }): React.ReactElement {
  const q = route.query.get('q') ?? '';
  const category = route.query.get('category') ?? 'all';
  const tag = route.query.get('tag') ?? '';
  const sort = route.query.get('sort') ?? (q ? 'relevance' : 'trending');
  const page = Math.max(1, Number(route.query.get('page') ?? 1) || 1);

  const [apps, setApps] = useState<AppCardData[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = q ? `${q} — apps on SoftN` : 'Apps — SoftN';
  }, [q]);

  useEffect(() => {
    if (apiDown) return undefined;
    const ac = new AbortController();
    setLoading(true);
    listApps({ q, category, tag, sort: sort === 'relevance' ? undefined : sort, page, perPage: 24 }, ac.signal)
      .then((r) => {
        setApps(r.items);
        setTotal(r.total);
        setPages(r.pages);
        setError(null);
      })
      .catch((e) => {
        if (!ac.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [q, category, tag, sort, page, apiDown]);

  const go = (next: Partial<{ q: string; category: string; sort: string; page: number; tag: string }>) => {
    navigate(buildUrl({ q, category, sort, tag, page: 1, ...next }));
  };
  const current = categories.find((c) => c.id === category);

  return (
    <main className="directory">
      <div className="wrap">
        <div className="directory-head">
          <p className="eyebrow">The directory</p>
          <h1 className="page-title">
            {q ? (
              <>
                Apps matching <em>{q}</em>
              </>
            ) : current ? (
              <>
                {current.emoji} {current.name}
              </>
            ) : tag ? (
              <>Tagged {tag}</>
            ) : (
              'Every app'
            )}
          </h1>
          {current?.description && !q && <p className="band-sub">{current.description}</p>}
        </div>
        <div className="directory-bar">
          <SearchBox initial={q} onSearch={(value) => go({ q: value, sort: value ? 'relevance' : 'trending' })} />
          <SortSelect value={sort === 'relevance' ? 'trending' : sort} onChange={(s) => go({ sort: s })} />
        </div>
        <CategoryChips categories={categories} selected={category} hrefFor={(id) => buildUrl({ q, sort, page: 1, category: id })} onSelect={(id) => go({ category: id })} />
        {tag && (
          <p className="muted">
            Showing apps tagged <strong>{tag}</strong>.{' '}
            <a href={buildUrl({ q, category, sort })}>Clear</a>
          </p>
        )}
        {apiDown ? (
          <div className="notice">
            <strong>The directory is not answering.</strong> {apiDown}
          </div>
        ) : error ? (
          <div className="notice">
            <strong>Could not load the apps.</strong> {error}
          </div>
        ) : (
          <>
            <p className="directory-count" aria-live="polite">
              {loading ? 'Loading…' : total === 0 ? 'Nothing matches.' : `${total} app${total === 1 ? '' : 's'}${pages > 1 ? ` · page ${page} of ${pages}` : ''}`}
            </p>
            <AppGrid apps={apps} categories={categories} skeleton={loading ? 8 : 0} />
            {!loading && total === 0 && (
              <div className="empty">
                <p>No app matches that yet.</p>
                <p>
                  <a className="cta cta-primary" href="/publish">
                    Publish the first one
                  </a>
                </p>
              </div>
            )}
            <Pagination page={page} pages={pages} hrefFor={(p) => buildUrl({ q, category, sort, tag, page: p })} onPage={(p) => navigate(buildUrl({ q, category, sort, tag, page: p }))} />
          </>
        )}
      </div>
    </main>
  );
}
