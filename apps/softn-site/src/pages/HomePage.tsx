import React, { useEffect, useState } from 'react';
import { listApps, type AppCard as AppCardData, type Category } from '../lib/api';
import { AppGrid, Featured, FeaturedSkeleton, pickFeatured } from '../components/directory/AppCard';
import { CategoriesNotice, CategoryChips, SearchBox } from '../components/directory/Controls';
import { Doors } from '../components/Doors';
import { Language } from '../components/Language';
import { Pipeline } from '../components/Pipeline';
import { ComponentIndex } from '../components/ComponentIndex';
import { Reveal } from '../components/Reveal';

const LISTS: Array<{ id: string; name: string }> = [
  { id: 'trending', name: 'Trending' },
  { id: 'newest', name: 'New' },
  { id: 'top', name: 'Top rated' },
  { id: 'remixed', name: 'Most remixed' },
];

/**
 * The featured shelf, as it was the last time the directory answered.
 *
 * Kept in this browser so that a directory outage leaves the front page with
 * something to press rather than a headline over nothing. Shown only when
 * the live request fails, and always marked with when it was seen: a
 * visitor must not mistake last week's shelf for today's.
 */
const FEATURED_MEMORY = 'softn.site.featured';

interface RememberedFeatured {
  at: number;
  items: AppCardData[];
}

export function rememberFeatured(items: AppCardData[], now = Date.now()): void {
  try {
    localStorage.setItem(FEATURED_MEMORY, JSON.stringify({ at: now, items } satisfies RememberedFeatured));
  } catch {
    // Storage blocked or full: the live shelf is still on screen.
  }
}

export function recallFeatured(): RememberedFeatured | null {
  try {
    const raw = localStorage.getItem(FEATURED_MEMORY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RememberedFeatured> | null;
    if (!parsed || typeof parsed.at !== 'number' || !Array.isArray(parsed.items)) return null;
    const items = parsed.items.filter((a): a is AppCardData => Boolean(a && typeof a === 'object' && typeof (a as AppCardData).slug === 'string'));
    return items.length > 0 ? { at: parsed.at, items } : null;
  } catch {
    return null;
  }
}

function Arrow(): React.ReactElement {
  return (
    <svg className="cta-arrow" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M3 7h8M7.5 3.5 11 7l-3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The hero is the apps: a headline over the directory's featured shelf, as
 * pictures. Then the directory itself, then how the loop works, then the
 * tools and the language.
 *
 * Nothing on this page runs an app. The pictures are the screenshots the
 * directory keeps, and an app's bundle is only fetched when someone presses
 * Play, which opens it in the runtime — so a visit here downloads the site,
 * not the apps.
 *
 * Three requests feed the page — categories, the featured shelf, the list —
 * and each has its own status. None gates another: the categories are labels
 * on the cards, and a failure there used to be read as "the directory is
 * down", which skipped the list request and showed an empty directory over
 * a working one.
 */
export function HomePage({
  categories,
  categoriesError,
  onRetryCategories,
}: {
  categories: Category[];
  categoriesError: string | null;
  onRetryCategories: () => void;
}): React.ReactElement {
  const [sort, setSort] = useState('trending');
  const [apps, setApps] = useState<AppCardData[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [listAttempt, setListAttempt] = useState(0);
  const [featured, setFeatured] = useState<AppCardData[] | null>(null);
  /** When the shelf on screen was fetched, if it is a remembered one rather than today's. */
  const [featuredSeenAt, setFeaturedSeenAt] = useState<number | null>(null);

  // The featured shelf: the most-played dozen, ranked the way the Apps page
  // ranks them. When the directory cannot answer, the last shelf it gave this
  // browser stands in, marked as such; failing that, the hero is the headline.
  useEffect(() => {
    const ac = new AbortController();
    listApps({ sort: 'runs', perPage: 12 }, ac.signal)
      .then((r) => {
        if (ac.signal.aborted) return;
        const picked = pickFeatured(r.items);
        setFeatured(picked);
        setFeaturedSeenAt(null);
        if (picked.length > 0) rememberFeatured(picked);
      })
      .catch(() => {
        if (ac.signal.aborted) return;
        const remembered = recallFeatured();
        setFeatured(remembered ? remembered.items : []);
        setFeaturedSeenAt(remembered ? remembered.at : null);
      });
    return () => ac.abort();
  }, []);

  // The list has its own loading and failure state, and its own retry.
  useEffect(() => {
    const ac = new AbortController();
    setListError(null);
    setListLoading(true);
    setApps([]);
    listApps({ sort, perPage: 8 }, ac.signal)
      .then((r) => {
        if (ac.signal.aborted) return;
        setApps(r.items);
        setTotal(r.total);
        setListLoading(false);
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        setListError(e instanceof Error ? e.message : String(e));
        setListLoading(false);
      });
    return () => ac.abort();
  }, [sort, listAttempt]);

  return (
    <>
      <header className="hero hero-dir" id="top">
        <div className="wrap hero-inner">
          <div className="hero-copy">
            <h1 className="hero-title rise" style={{ animationDelay: '60ms' }}>
              Open an app.
              <br />
              Read it.
              <br />
              Make it yours.
            </h1>
            <p className="hero-lede rise" style={{ animationDelay: '140ms' }}>
              Every app here is one <code>.softn</code> file — its interface, its logic and its assets — running in a
              sandboxed engine in your browser. Games, tools, an x86 emulator, an image editor. Nothing to install and no
              account to make.
            </p>
            <div className="hero-cta rise" style={{ animationDelay: '220ms' }}>
              <a className="cta cta-primary" href="/apps">
                Browse {total !== null ? `${total} ` : ''}apps
                <Arrow />
              </a>
              <a className="cta" href="/publish">
                Publish yours
                <Arrow />
              </a>
            </div>
          </div>
          {(featured === null || featured.length >= 3) && (
            <div className="hero-shelf rise" style={{ animationDelay: '260ms' }}>
              {featured === null ? <FeaturedSkeleton /> : <Featured apps={featured} categories={categories} heading={null} />}
              {featuredSeenAt !== null && (
                <p className="hero-shelf-note muted" role="status">
                  The directory is not answering right now. This shelf is as it was on{' '}
                  {new Date(featuredSeenAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}.
                </p>
              )}
            </div>
          )}
        </div>
      </header>

      <section className="band band-featured" id="directory">
        <div className="wrap">
          <div className="band-head band-head-row">
            <div>
              <p className="eyebrow">The directory</p>
              <h2 className="band-title">What people are running</h2>
            </div>
            {/* Plain pressed buttons: these filter a list, and the tab pattern
                they used to claim comes with keyboard and panel semantics they
                never had. */}
            <div className="tabs" role="group" aria-label="Sort the list">
              {LISTS.map((f) => (
                <button key={f.id} type="button" aria-pressed={sort === f.id} className={`tab ${sort === f.id ? 'on' : ''}`} onClick={() => setSort(f.id)}>
                  {f.name}
                </button>
              ))}
            </div>
          </div>
          <div className="hero-search">
            <SearchBox autoFocus={false} />
          </div>
          {categories.length > 0 && (
            <div className="hero-pills">
              <CategoryChips categories={categories} selected="" hrefFor={(id) => (id === 'all' ? '/apps' : `/apps?category=${encodeURIComponent(id)}`)} limit={9} />
            </div>
          )}
          <CategoriesNotice error={categoriesError} onRetry={onRetryCategories} />
          {listError ? (
            <div className="notice" role="status">
              <strong>This list could not be loaded.</strong> {listError}{' '}
              <button type="button" className="cta cta-small" onClick={() => setListAttempt((n) => n + 1)}>
                Retry
              </button>
            </div>
          ) : !listLoading && apps.length === 0 ? (
            <div className="notice">Nothing in this list yet.</div>
          ) : (
            <AppGrid apps={apps} categories={categories} skeleton={listLoading ? 8 : 0} loading={listLoading} />
          )}
          <div className="band-foot">
            <a className="cta" href={`/apps?sort=${sort}`}>
              See all
              <Arrow />
            </a>
          </div>
        </div>
      </section>

      <Reveal as="section" className="band band-how" id="how">
        <div className="wrap">
          <div className="band-head">
            <p className="eyebrow">How it works</p>
            <h2 className="band-title">Run it. Read it. Publish yours.</h2>
            <p className="band-sub">
              Start from something useful. Read its source, change it, and share your version.
            </p>
          </div>
          <div className="how-grid">
            <div className="how">
              <span className="how-n">01</span>
              <h3 className="how-name">Run it, in a sandbox</h3>
              <p className="how-copy">
                App logic runs on <a href="https://github.com/f2i-com/zipp.org">zipp</a>, a JavaScript engine compiled to
                WebAssembly with nothing of the browser inside it. The network, your camera, its own server storage — an app
                gets those from the host, only if its manifest asks, and only after the page has told you and you have
                allowed it. That is a boundary, not a promise that an app is harmless.
              </p>
            </div>
            <div className="how">
              <span className="how-n">02</span>
              <h3 className="how-name">Read it, remix it</h3>
              <p className="how-copy">
                Every app&rsquo;s source is on its page. Open it in <a href="/studio/">Studio</a> to have a model change it, or in{' '}
                <a href="/builder/">Builder</a> to change it by hand, then publish the result as a remix that credits where it came
                from.
              </p>
            </div>
            <div className="how">
              <span className="how-n">03</span>
              <h3 className="how-name">Publish, no account</h3>
              <p className="how-copy">
                Upload a <code>.softn</code>, pick a category, get an edit key. That is the whole process, and it is also an API: a
                script or an AI agent can publish with one <code>POST</code>. Apps that declare <code>storage</code> get their own
                database on the server — a scoreboard, shared notes, whatever the app needs — that everyone running the app shares.
              </p>
            </div>
          </div>
        </div>
      </Reveal>

      <Doors />
      <Language />
      <Pipeline />
      <ComponentIndex />
    </>
  );
}
