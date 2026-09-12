import React, { useEffect, useState } from 'react';
import { listApps, type AppCard as AppCardData, type CapabilityFilter, type Category } from '../lib/api';
import { navigate, type Route } from '../lib/router';
import { AppGrid, Featured, pickFeatured } from '../components/directory/AppCard';
import { CAP_FILTERS, SORTS, CapabilityChips, CategoriesNotice, CategoryChips, Pagination, SearchBox, SortSelect } from '../components/directory/Controls';

interface Filters {
  q: string;
  category: string;
  tag: string;
  author: string;
  cap: CapabilityFilter | '';
  sort: string;
  page: number;
}

function selectedSort(raw: string | null | undefined, q: string): string {
  if (raw === 'relevance' && q) return raw;
  return SORTS.some((sort) => sort.id === raw) ? raw! : q ? 'relevance' : 'trending';
}

function buildUrl(f: Partial<Filters>): string {
  const qs = new URLSearchParams();
  if (f.q) qs.set('q', f.q);
  if (f.category && f.category !== 'all') qs.set('category', f.category);
  if (f.tag) qs.set('tag', f.tag);
  if (f.author) qs.set('author', f.author);
  if (f.cap) qs.set('cap', f.cap);
  // Searching defaults to relevance; browsing defaults to trending. Only
  // omit the applicable default, or Trending silently becomes Best match.
  const sort = selectedSort(f.sort, f.q ?? '');
  if (sort !== (f.q ? 'relevance' : 'trending')) qs.set('sort', sort);
  if (f.page && f.page > 1) qs.set('page', String(f.page));
  const s = qs.toString();
  return s ? `/apps?${s}` : '/apps';
}

function asCap(v: string | null): CapabilityFilter | '' {
  return CAP_FILTERS.some((c) => c.id === v) ? (v as CapabilityFilter) : '';
}

/**
 * The page number an address asks for: a positive integer, or 1. Anything
 * else — `abc`, `-3`, `2.5`, `1e3`, a number too large to hold — used to be
 * handed to `Number()` and, when that gave a finite value, sent to the API
 * as it was. Bounded above only so the value stays an integer; a page past
 * the last one is clamped once the reply says how many there are.
 */
export function parsePageParam(raw: string | null): number {
  if (raw === null || !/^[1-9][0-9]{0,8}$/.test(raw)) return 1;
  return Number(raw);
}

/*
 * The Apps page: the directory, and nothing in front of it. The featured
 * shelf leads when nobody has narrowed anything; the moment a filter is on,
 * the listing is the whole page, because a visitor who typed a word wants
 * the answer, not the shelf again.
 *
 * The categories are labels and chips. When their request fails the listing
 * is still asked for and still shown, without them; the failure is a notice
 * with a retry, not a reason to show nothing.
 */
export function DirectoryPage({
  route,
  categories,
  categoriesError,
  onRetryCategories,
}: {
  route: Route;
  categories: Category[];
  categoriesError: string | null;
  onRetryCategories: () => void;
}): React.ReactElement {
  const q = route.query.get('q') ?? '';
  const category = route.query.get('category') ?? 'all';
  const tag = route.query.get('tag') ?? '';
  const author = route.query.get('author') ?? '';
  const cap = asCap(route.query.get('cap'));
  const rawSort = route.query.get('sort');
  const sort = selectedSort(rawSort, q);
  const rawPage = route.query.get('page');
  const page = parsePageParam(rawPage);
  const filters: Filters = { q, category, tag, author, cap, sort, page };
  const filtered = Boolean(q || category !== 'all' || tag || author || cap);

  // Three things the listing can be: not loaded yet (no reply so far), a
  // reply with nothing in it, and a request that failed. They used to share
  // one look. The last keeps whatever was on screen — the previous list is
  // more use than a blank — and says so, with a retry.
  const [apps, setApps] = useState<AppCardData[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [featured, setFeatured] = useState<AppCardData[]>([]);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    document.title = q ? `${q} — apps on SoftN` : author ? `Apps by ${author} — SoftN` : 'Apps — SoftN';
  }, [q, author]);

  // An address that says page=abc, page=0 or page=1 means page 1, and the
  // address is made to say so — replaced, so back does not return to it.
  useEffect(() => {
    if ((rawPage !== null && rawPage !== (page > 1 ? String(page) : null)) || (rawSort !== null && rawSort !== sort)) navigate(buildUrl(filters), true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawPage, page, rawSort, sort]);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    listApps({ q, category, tag, author, cap, sort: sort === 'relevance' ? undefined : sort, page, perPage: 24 }, ac.signal)
      .then((r) => {
        // A reply for a request this page has moved past is never painted,
        // whether or not the request honoured the abort.
        if (ac.signal.aborted) return;
        if (page > r.pages && r.pages >= 1) {
          // Past the last page: ask for the last one instead, in place.
          navigate(buildUrl({ ...filters, page: r.pages }), true);
          return;
        }
        setApps(r.items);
        setTotal(r.total);
        setPages(Math.max(1, r.pages));
        setLoaded(true);
        setError(null);
        setLoading(false);
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, category, tag, author, cap, sort, page, attempt]);

  // The featured shelf is chosen from the most-played dozen and changes as
  // the directory does. It only appears on the unfiltered front page.
  const showFeatured = !filtered && page === 1 && sort === 'trending';
  useEffect(() => {
    if (!showFeatured) return undefined;
    const ac = new AbortController();
    listApps({ sort: 'runs', perPage: 12 }, ac.signal)
      .then((r) => {
        if (!ac.signal.aborted) setFeatured(pickFeatured(r.items));
      })
      .catch(() => {
        if (!ac.signal.aborted) setFeatured([]);
      });
    return () => ac.abort();
  }, [showFeatured]);

  const go = (next: Partial<Filters>) => {
    navigate(buildUrl({ ...filters, page: 1, ...next }));
  };
  const current = categories.find((c) => c.id === category);

  // What the listing is showing, in the section's own heading. The page is
  // always "Apps"; the heading over the grid says which ones.
  let heading: React.ReactNode = 'All apps';
  if (q) heading = <>Matching “{q}”</>;
  else if (author) heading = <>By {author}</>;
  else if (current) heading = <>{current.emoji} {current.name}</>;
  // The category is known by id even when the categories request failed.
  else if (category !== 'all') heading = <>In {category}</>;
  else if (tag) heading = <>Tagged #{tag}</>;
  else if (cap) heading = CAP_FILTERS.find((c) => c.id === cap)?.name ?? 'All apps';

  const count = loading ? (loaded ? 'Updating results…' : 'Loading…') : total === 0 ? 'Nothing matches.' : `${total} app${total === 1 ? '' : 's'}${pages > 1 ? `, page ${page} of ${pages}` : ''}`;
  const empty = loaded && !loading && !error && total === 0;
  const activeFilters = [
    ...(q ? [{ label: `Search: ${q}`, clear: { q: '' } }] : []),
    ...(category !== 'all' ? [{ label: `Category: ${current?.name ?? category}`, clear: { category: 'all' } }] : []),
    ...(tag ? [{ label: `Tag: #${tag}`, clear: { tag: '' } }] : []),
    ...(author ? [{ label: `Author: ${author}`, clear: { author: '' } }] : []),
    ...(cap ? [{ label: CAP_FILTERS.find((item) => item.id === cap)!.name, clear: { cap: '' as const } }] : []),
  ];

  return (
    <main className="directory">
      <div className="wrap">
        <header className="directory-top">
          <div className="directory-intro">
            <h1 className="page-title">Apps</h1>
            <p className="directory-lede">
              {author && !q ? (
                <>
                  Everything {author} has published. <a href={buildUrl({ ...filters, author: '', page: 1 })}>All authors</a>
                </>
              ) : current?.description && !q ? (
                current.description
              ) : (
                <>Each one is a single file. Press play and it runs here, in a sandbox, with nothing to install.</>
              )}
            </p>
          </div>
          <div className="directory-bar">
            <SearchBox initial={q} onSearch={(value) => go({ q: value, sort: value ? 'relevance' : 'trending' })} />
            <SortSelect value={sort} searching={Boolean(q)} onChange={(s) => go({ sort: s })} />
          </div>
        </header>

        {showFeatured && <Featured apps={featured} categories={categories} />}

        <section className="directory-all" aria-labelledby="all-apps-title">
          <div className="directory-section-head">
            <h2 id="all-apps-title" className="directory-section-title">
              {heading}
            </h2>
            {!error && (
              <p className="directory-count" aria-live="polite">
                {count}
              </p>
            )}
          </div>
          <div className="directory-filters">
            {categories.length > 0 && (
              <>
                <div className="directory-categories-desktop">
                  <CategoryChips categories={categories} selected={category} hrefFor={(id) => buildUrl({ ...filters, page: 1, category: id })} onSelect={(id) => go({ category: id })} />
                </div>
                <label className="sort directory-categories-mobile">
                  <span className="sort-label">Category</span>
                  <select aria-label="Filter apps by category" value={category} onChange={(event) => go({ category: event.target.value })}>
                    <option value="all">All categories</option>
                    {category !== 'all' && !current && <option value={category}>{category}</option>}
                    {categories.map((item) => <option key={item.id} value={item.id}>{item.name}{item.apps ? ` · ${item.apps}` : ''}</option>)}
                  </select>
                </label>
              </>
            )}
            <CapabilityChips selected={cap} onSelect={(id) => go({ cap: id })} />
          </div>
          <CategoriesNotice error={categoriesError} onRetry={onRetryCategories} />
          {filtered && (
            <div className="directory-active-filters" role="group" aria-label="Active filters">
              <span className="directory-filter-label">Filtered by</span>
              {activeFilters.map((filter) => (
                <a key={filter.label} className="pill directory-filter-remove" href={buildUrl({ ...filters, ...filter.clear, page: 1 })} aria-label={`Remove ${filter.label}`}>
                  <span>{filter.label}</span><span aria-hidden="true">×</span>
                </a>
              ))}
              <a className="directory-clear-filters" href={buildUrl({ sort })}>Clear all</a>
            </div>
          )}
          {error && (
            <div className="notice" role="alert">
              <strong>Could not load the apps.</strong> {error}{' '}
              {apps.length > 0 && 'The list below is the last one that loaded. '}
              <button type="button" className="cta cta-small" disabled={loading} onClick={() => setAttempt((n) => n + 1)}>
                {loading ? 'Retrying…' : 'Retry'}
              </button>
            </div>
          )}
          {(!error || apps.length > 0) && <AppGrid apps={apps} categories={categories} skeleton={loading && !error ? 8 : 0} loading={loading} />}
          {empty && (
            <div className="empty">
              <p className="empty-title">No app matches that yet.</p>
              <p className="muted">
                {q
                  ? 'Try a different word, or fewer filters.'
                  : filtered
                    ? 'Try fewer filters, or a different word.'
                    : 'The directory is empty. Drop .softn files anywhere on this page to publish them, one or a folder at once.'}
              </p>
              <p className="app-actions">
                {q && (
                  <a className="cta" href={buildUrl({ ...filters, q: '', page: 1 })}>
                    Clear the search
                  </a>
                )}
                {filtered && (
                  <a className="cta" href={buildUrl({ sort })}>
                    Clear the filters
                  </a>
                )}
                <a className="cta cta-primary" href="/publish">
                  {filtered ? 'Publish an app' : 'Publish the first one'}
                </a>
              </p>
            </div>
          )}
          {!error && !loading && <Pagination page={page} pages={pages} hrefFor={(p) => buildUrl({ ...filters, page: p })} onPage={(p) => navigate(buildUrl({ ...filters, page: p }))} />}
        </section>
      </div>
    </main>
  );
}
