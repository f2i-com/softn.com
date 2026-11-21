import React, { useEffect, useState } from 'react';
import { listApps, type AppCard as AppCardData, type Category } from '../lib/api';
import { AppGrid, Featured, FeaturedSkeleton, shelfApps } from '../components/directory/AppCard';
import { useFeaturedShelf } from '../components/directory/featured';
import { Arrow } from '../components/glyphs';
import { CategoriesNotice, CategoryChips } from '../components/directory/Controls';
import { LearnDocs } from '../components/LearnDocs';
import { StartWays } from '../components/home/StartWays';
import { OfflineExamples } from '../components/home/OfflineExamples';
import { HowItWorks } from '../components/home/HowItWorks';
import { WhyDifferent } from '../components/home/WhyDifferent';
import { ForDevelopers } from '../components/home/ForDevelopers';
import { HomeFaq } from '../components/home/HomeFaq';
import { BUILDER_HREF, STUDIO_HREF } from '../lib/appUrls';
import { HOSTING_GUIDE_HREF } from '../lib/guides';

const LISTS: Array<{ id: string; name: string }> = [
  { id: 'trending', name: 'Trending' },
  { id: 'newest', name: 'New' },
  { id: 'top', name: 'Top rated' },
  { id: 'remixed', name: 'Most remixed' },
];

/** How many of the directory's apps the front page lists under its shelf: three rows of four on a laptop. */
const GALLERY_SIZE = 12;
/** The most the shelf shows, which the list leaves out; asked for on top, so the list is still full without them. */
const SHELF_SIZE = 5;

/**
 * The apps first: the hero is the directory's featured shelf, under one line of what SoftN is and the things a
 * visitor came to do — find an app, make one, see how it works. Then the rest of the directory, the ways to start, the
 * four steps from playing an app to publishing one, what makes it different, a page of markup, the guides and the
 * questions people ask.
 * The tools' names (Studio, Builder, the runtime) are in the product bar, and introduced in the page where each is the
 * next step. The language, the engine's pipeline and the component list are in the guides.
 *
 * The list under the shelf is "more apps": it leaves out the ones the shelf is already showing, which were its first
 * four rows on every visit, and it waits for the shelf so that it does not draw them and then take them away.
 *
 * Nothing runs here: an app's bundle is only fetched when someone presses Play, which opens it in the runtime.
 *
 * Three requests feed the page — categories, the featured shelf, the list — and each has its own status. None gates
 * another: the categories are labels on the cards, and a failure there used to be read as "the directory is down",
 * which skipped the list request and showed an empty directory over a working one.
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
  // The featured shelf, ranked the way the Apps page ranks it. When the
  // directory cannot answer, the last shelf it gave this browser stands in,
  // marked as such (`featuredSeenAt`, when it was fetched); failing that, the
  // hero is the headline.
  const { featured, seenAt: featuredSeenAt } = useFeaturedShelf({ remember: true });

  // The list has its own loading and failure state, and its own retry.
  useEffect(() => {
    const ac = new AbortController();
    setListError(null);
    setListLoading(true);
    setApps([]);
    listApps({ sort, perPage: GALLERY_SIZE + SHELF_SIZE }, ac.signal)
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

  // The apps the shelf is showing, which the list leaves out. A directory too
  // small to have three more keeps its list whole: a list of one app under a
  // shelf of five would read as a directory with one app in it.
  const onShelf = new Set((featured ? shelfApps(featured) : []).map((a) => a.slug));
  const rest = apps.filter((a) => !onShelf.has(a.slug));
  const gallery = (rest.length >= 3 ? rest : apps).slice(0, GALLERY_SIZE);
  const galleryLoading = listLoading || (featured === null && !listError);

  const showShelf = featured === null || featured.length >= 3;

  return (
    <>
      <header className="hero hero-apps" id="top">
        <div className="wrap hero-inner">
          <div className={showShelf ? 'hero-top hero-top-shelf' : 'hero-top hero-top-blueprint'}>
            <div className="hero-apps-head">
              <div className="hero-copy">
                <p className="hero-eyebrow rise">
                  <span className="hero-eyebrow-dot" aria-hidden="true" />
                  Sandboxed Full-Stack Web Containers
                </p>
                <h1 className="hero-title rise" style={{ animationDelay: '60ms' }}>
                  Full web apps — frontend and backend — sandboxed in your browser.
                </h1>
                <p className="hero-lede rise" style={{ animationDelay: '120ms' }}>
                  Bring standard HTML, React, Vue, or TypeScript frontends — or optional <code>.ui</code> files — paired with sandboxed PHP (Slim 4), JS/TS, Rust, or Python backends and SQLite persisted in IndexedDB. Run locally with zero install, or host the exact same <code>.softn</code> bundle multi-user inside ZIPP safe-sandbox.
                </p>
              </div>
              <div className="hero-cta rise" style={{ animationDelay: '180ms' }}>
                <a className="cta cta-primary cta-large" href="/apps">
                  Explore all apps
                  <Arrow />
                </a>
                <a className="cta cta-large" href="#create">
                  Create an app
                  <Arrow />
                </a>
                <a className="hero-more" href="#how">
                  How it works
                </a>
              </div>
            </div>

            {showShelf ? (
              <div className="hero-shelf rise" style={{ animationDelay: '160ms' }}>
                {featured === null ? <FeaturedSkeleton /> : <Featured apps={featured} categories={categories} />}
                {featuredSeenAt !== null && (
                  <p className="hero-shelf-note muted" role="status">
                    The directory is not answering right now. This shelf is as it was on{' '}
                    {new Date(featuredSeenAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}.
                  </p>
                )}
              </div>
            ) : (
              <aside className="hero-blueprint rise" style={{ animationDelay: '160ms' }} aria-label="Inside a SoftN v2 Web Container">
                <div className="blueprint-bar">
                  <span className="blueprint-file">order-desk.softn</span>
                  <span className="blueprint-pill">
                    <span className="blueprint-pill-dot" aria-hidden="true" />
                    ZIPP Sandbox
                  </span>
                </div>
                <div className="blueprint-stack">
                  <div className="blueprint-layer">
                    <div className="blueprint-layer-head">
                      <span className="blueprint-layer-tag">Frontend</span>
                      <span className="blueprint-layer-meta">Worker + Shadow DOM</span>
                    </div>
                    <div className="blueprint-chips">
                      <span className="blueprint-chip blueprint-chip-code">React</span>
                      <span className="blueprint-chip blueprint-chip-code">Vue</span>
                      <span className="blueprint-chip blueprint-chip-code">HTML / JS</span>
                      <span className="blueprint-chip blueprint-chip-code">TypeScript</span>
                      <span className="blueprint-chip">.ui optional</span>
                    </div>
                  </div>
                  <div className="blueprint-wire" aria-hidden="true">
                    <span className="blueprint-wire-line" />
                    <code>{'fetch("/api/items")'}</code>
                    <span className="blueprint-wire-line" />
                  </div>
                  <div className="blueprint-layer">
                    <div className="blueprint-layer-head">
                      <span className="blueprint-layer-tag blueprint-layer-tag-mint">Backend</span>
                      <span className="blueprint-layer-meta">ZIPP WASM · zero ambient access</span>
                    </div>
                    <div className="blueprint-chips">
                      <span className="blueprint-chip blueprint-chip-mint">PHP 8 / Slim 4</span>
                      <span className="blueprint-chip blueprint-chip-mint">JS / TS</span>
                      <span className="blueprint-chip blueprint-chip-mint">Rust</span>
                      <span className="blueprint-chip blueprint-chip-mint">Python</span>
                    </div>
                  </div>
                  <div className="blueprint-layer blueprint-layer-db">
                    <div className="blueprint-layer-head">
                      <span className="blueprint-layer-tag">SQLite 3</span>
                      <span className="blueprint-layer-meta">IndexedDB locally · WAL on server</span>
                    </div>
                  </div>
                </div>
                <div className="blueprint-foot">
                  <span>Open in browser or host multi-user</span>
                  <div className="blueprint-foot-links">
                    <a href={STUDIO_HREF}>Studio <span aria-hidden="true">↗</span></a>
                    <a href={BUILDER_HREF}>Builder <span aria-hidden="true">↗</span></a>
                  </div>
                </div>
              </aside>
            )}
          </div>

          <div className="hero-sandbox-grid rise" style={{ animationDelay: '200ms' }} aria-label="How SoftN sandboxes full web apps">
            <article className="hero-sandbox-card">
              <div className="hero-sandbox-head">
                <span className="hero-sandbox-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="4" width="18" height="15" rx="2" />
                    <path d="M3 9h18M8 6.5h.01M11 6.5h.01" />
                  </svg>
                </span>
                <span className="hero-sandbox-badge">Frontend Sandbox</span>
                <span className="hero-sandbox-num" aria-hidden="true">01</span>
              </div>
              <h2>React, Vue, or plain HTML</h2>
              <p>
                Run standard HTML5, CSS, TypeScript, React, Vue, Preact, or Three.js inside an isolated WebAssembly Worker + Shadow DOM — zero ambient access to the host page or browser secrets.
              </p>
            </article>
            <article className="hero-sandbox-card">
              <div className="hero-sandbox-head">
                <span className="hero-sandbox-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                    <ellipse cx="12" cy="5.5" rx="7.5" ry="3" />
                    <path d="M4.5 5.5v13c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3v-13M4.5 12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3" />
                  </svg>
                </span>
                <span className="hero-sandbox-badge">Backend + SQLite</span>
                <span className="hero-sandbox-num" aria-hidden="true">02</span>
              </div>
              <h2>ZIPP WASM + IndexedDB</h2>
              <p>
                Bundle real PHP (Slim 4 + PDO), JS/TS, Rust, or Python HTTP backends and SQLite inside the same <code>.softn</code> file. Every <code>{'fetch("/api/...")'}</code> runs locally in your browser.
              </p>
            </article>
            <article className="hero-sandbox-card">
              <div className="hero-sandbox-head">
                <span className="hero-sandbox-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 3 4.5 6.5V12c0 5 3.3 8.4 7.5 9.5 4.2-1.1 7.5-4.5 7.5-9.5V6.5z" />
                    <path d="m9 12 2 2 4-4" />
                  </svg>
                </span>
                <span className="hero-sandbox-badge">Flexible Hosting</span>
                <span className="hero-sandbox-num" aria-hidden="true">03</span>
              </div>
              <h2>Browser-only or SoftN-hosted</h2>
              <p>
                Let visitors download and run the whole app in their browser sandbox, or host its backend on SoftN, FormLogic, or <a href={HOSTING_GUIDE_HREF}>softn-server</a> with shared WAL SQLite — always inside ZIPP safe-sandbox.
              </p>
            </article>
          </div>

          <ul className="hero-facts" aria-label="Before you start">
            <li>React, Vue, HTML/JS, TS &amp; optional .ui frontends</li>
            <li>PHP (Slim 4), JS/TS, Rust &amp; Python + SQLite in ZIPP</li>
            <li>Runs locally in IndexedDB — or scales multi-user in ZIPP safe-sandbox</li>
          </ul>
        </div>
      </header>

      <OfflineExamples />

      <section className="band band-featured" id="directory">
        <div className="wrap">
          <div className="band-head band-head-row">
            <div>
              <h2 className="band-title">More apps to play</h2>
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
          {/* One failure, one notice: with the list down too, its own notice says so and its Retry asks for both. */}
          <CategoriesNotice error={listError ? null : categoriesError} onRetry={onRetryCategories} />
          {listError ? (
            <div className="notice" role="status">
              <strong>This list could not be loaded.</strong> {listError}{' '}
              <button
                type="button"
                className="cta cta-small"
                onClick={() => {
                  setListAttempt((n) => n + 1);
                  if (categoriesError) onRetryCategories();
                }}
              >
                Retry
              </button>
            </div>
          ) : !galleryLoading && gallery.length === 0 ? (
            total === 0 ? (
              <div className="dir-empty-card" role="status">
                <div className="dir-empty-copy">
                  <strong>The directory is empty.</strong>
                  <p>
                    Create the first app in <a href={STUDIO_HREF}>Studio</a> or <a href={BUILDER_HREF}>Builder</a>, then{' '}
                    <a href="/publish">publish your <code>.softn</code> file</a> to share it here.
                  </p>
                </div>
                <div className="dir-empty-actions">
                  <a className="cta cta-primary cta-small" href={STUDIO_HREF}>Open Studio <Arrow /></a>
                  <a className="cta cta-small" href={BUILDER_HREF}>Open Builder <Arrow /></a>
                  <a className="cta cta-small" href="/publish">Publish .softn</a>
                </div>
              </div>
            ) : (
              <div className="notice" role="status">Nothing in this list yet.</div>
            )
          ) : (
            <AppGrid apps={galleryLoading ? [] : gallery} categories={categories} skeleton={galleryLoading ? GALLERY_SIZE : 0} loading={galleryLoading} short />
          )}
          {categories.length > 0 && (
            <div className="hero-pills">
              <CategoryChips categories={categories} selected="" hrefFor={(id) => (id === 'all' ? '/apps' : `/apps?category=${encodeURIComponent(id)}`)} limit={8} />
            </div>
          )}
          <div className="band-foot">
            <a className="cta" href={`/apps?sort=${sort}`}>
              Explore all apps
              <Arrow />
            </a>
          </div>
        </div>
      </section>

      <StartWays />
      <HowItWorks />
      <WhyDifferent />
      <ForDevelopers />
      <LearnDocs />
      <HomeFaq />
    </>
  );
}
