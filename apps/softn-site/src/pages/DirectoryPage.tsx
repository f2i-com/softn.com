import React, { useEffect, useState } from 'react';
import { listApps, type AppCard as AppCardData, type CapabilityFilter, type Category } from '../lib/api';
import { navigate, type Route } from '../lib/router';
import { AppGrid, Spotlight } from '../components/directory/AppCard';
import { CAP_FILTERS, CapabilityChips, CategoryChips, Pagination, SearchBox, SortSelect } from '../components/directory/Controls';

interface Filters {
  q: string;
  category: string;
  tag: string;
  author: string;
  cap: CapabilityFilter | '';
  sort: string;
  page: number;
}

function buildUrl(f: Partial<Filters>): string {
  const qs = new URLSearchParams();
  if (f.q) qs.set('q', f.q);
  if (f.category && f.category !== 'all') qs.set('category', f.category);
  if (f.tag) qs.set('tag', f.tag);
  if (f.author) qs.set('author', f.author);
  if (f.cap) qs.set('cap', f.cap);
  if (f.sort && f.sort !== 'trending' && f.sort !== 'relevance') qs.set('sort', f.sort);
  if (f.page && f.page > 1) qs.set('page', String(f.page));
  const s = qs.toString();
  return s ? `/apps?${s}` : '/apps';
}

function asCap(v: string | null): CapabilityFilter | '' {
  return CAP_FILTERS.some((c) => c.id === v) ? (v as CapabilityFilter) : '';
}

export function DirectoryPage({ route, categories, apiDown }: { route: Route; categories: Category[]; apiDown: string | null }): React.ReactElement {
  const q = route.query.get('q') ?? '';
  const category = route.query.get('category') ?? 'all';
  const tag = route.query.get('tag') ?? '';
  const author = route.query.get('author') ?? '';
  const cap = asCap(route.query.get('cap'));
  const sort = route.query.get('sort') ?? (q ? 'relevance' : 'trending');
  const page = Math.max(1, Number(route.query.get('page') ?? 1) || 1);
  const filters: Filters = { q, category, tag, author, cap, sort, page };
  const filtered = Boolean(q || category !== 'all' || tag || author || cap);

  const [apps, setApps] = useState<AppCardData[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [spotlight, setSpotlight] = useState<AppCardData | null>(null);

  useEffect(() => {
    document.title = q ? `${q} — apps on SoftN` : author ? `Apps by ${author} — SoftN` : 'Apps — SoftN';
  }, [q, author]);

  useEffect(() => {
    if (apiDown) return undefined;
    const ac = new AbortController();
    setLoading(true);
    listApps({ q, category, tag, author, cap, sort: sort === 'relevance' ? undefined : sort, page, perPage: 24 }, ac.signal)
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
  }, [q, category, tag, author, cap, sort, page, apiDown]);

  // The spotlight is the most-played app with a real screenshot: it changes
  // as the directory does, and the unfiltered front of the directory is the
  // only place it appears.
  useEffect(() => {
    if (apiDown || filtered) {
      setSpotlight(null);
      return undefined;
    }
    const ac = new AbortController();
    listApps({ sort: 'runs', perPage: 12 }, ac.signal)
      .then((r) => setSpotlight(r.items.find((a) => a.thumbnailKind === 'image') ?? r.items[0] ?? null))
      .catch(() => setSpotlight(null));
    return () => ac.abort();
  }, [apiDown, filtered]);

  const go = (next: Partial<Filters>) => {
    navigate(buildUrl({ ...filters, page: 1, ...next }));
  };
  const current = categories.find((c) => c.id === category);
  const byId = new Map(categories.map((c) => [c.id, c]));

  let title: React.ReactNode = 'Every app';
  if (q) title = <>Apps matching <em>{q}</em></>;
  else if (author) title = <>By <em>{author}</em></>;
  else if (current) title = <>{current.emoji} {current.name}</>;
  else if (tag) title = <>Tagged <em>#{tag}</em></>;
  else if (cap) title = CAP_FILTERS.find((c) => c.id === cap)?.name ?? 'Every app';

  return (
    <main className="directory">
      <div className="wrap">
        {spotlight && !filtered && page === 1 && <Spotlight app={spotlight} category={byId.get(spotlight.category)} label="Most played" />}
        <div className="directory-head">
          <p className="eyebrow">The directory</p>
          <h1 className="page-title">{title}</h1>
          {current?.description && !q && <p className="band-sub">{current.description}</p>}
          {author && !q && (
            <p className="band-sub">
              Everything {author} has published.{' '}
              <a href={buildUrl({ ...filters, author: '', page: 1 })}>All authors</a>
            </p>
          )}
        </div>
        <div className="directory-bar">
          <SearchBox initial={q} onSearch={(value) => go({ q: value, sort: value ? 'relevance' : 'trending' })} />
          <SortSelect value={sort} searching={Boolean(q)} onChange={(s) => go({ sort: s })} />
        </div>
        <CategoryChips categories={categories} selected={category} hrefFor={(id) => buildUrl({ ...filters, page: 1, category: id })} onSelect={(id) => go({ category: id })} />
        <CapabilityChips selected={cap} onSelect={(id) => go({ cap: id })} />
        {tag && (
          <p className="muted">
            Showing apps tagged <strong>#{tag}</strong>.{' '}
            <a href={buildUrl({ ...filters, tag: '', page: 1 })}>Clear</a>
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
              {loading && apps.length === 0 ? 'Loading…' : total === 0 ? 'Nothing matches.' : `${total} app${total === 1 ? '' : 's'}${pages > 1 ? ` · page ${page} of ${pages}` : ''}`}
            </p>
            <AppGrid apps={apps} categories={categories} skeleton={loading ? 8 : 0} loading={loading} />
            {!loading && total === 0 && (
              <div className="empty">
                <p className="empty-title">No app matches that yet.</p>
                <p className="muted">
                  {filtered ? 'Try fewer filters, or a different word.' : 'The directory is empty, which is a first.'}
                </p>
                <p className="app-actions">
                  {filtered && (
                    <a className="cta" href="/apps">
                      Clear the filters
                    </a>
                  )}
                  <a className="cta cta-primary" href="/publish">
                    Publish the first one
                  </a>
                </p>
              </div>
            )}
            <Pagination page={page} pages={pages} hrefFor={(p) => buildUrl({ ...filters, page: p })} onPage={(p) => navigate(buildUrl({ ...filters, page: p }))} />
          </>
        )}
      </div>
    </main>
  );
}
