import React, { useEffect, useState } from 'react';
import { listApps, type AppCard as AppCardData, type Category } from '../lib/api';
import { AppGrid, Featured, FeaturedSkeleton } from '../components/directory/AppCard';
import { useFeaturedShelf } from '../components/directory/featured';
import { Arrow } from '../components/glyphs';
import { CategoriesNotice, CategoryChips, SearchBox } from '../components/directory/Controls';
import { Doors } from '../components/Doors';
import { Language } from '../components/Language';
import { Pipeline } from '../components/Pipeline';
import { ComponentIndex } from '../components/ComponentIndex';
import { Reveal } from '../components/Reveal';
import { LearnDocs } from '../components/LearnDocs';
import { WorkspacePreview } from '../components/WorkspacePreview';
import { ExampleWalkthrough } from '../components/ExampleWalkthrough';
import { BUILDER_HREF, STUDIO_HREF } from '../lib/appUrls';

const LISTS: Array<{ id: string; name: string }> = [
  { id: 'trending', name: 'Trending' },
  { id: 'newest', name: 'New' },
  { id: 'top', name: 'Top rated' },
  { id: 'remixed', name: 'Most remixed' },
];

/**
 * Start with the creation workflow and real product screenshots. The live
 * directory follows the tools, independently of whether it has any apps yet.
 *
 * The directory's apps do not run here: an app's bundle is only fetched when
 * someone presses Play, which opens it in the runtime. The one exception is
 * the hero's Fieldnotes preview, which embeds the real runtime — engine and
 * all — so LiveAppPreview mounts it only after the page has loaded and once
 * it is scrolled into view, and not at all until asked for on a phone, for a
 * visitor saving data or on a slow connection.
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
      <header className="hero hero-create" id="top">
        <div className="wrap hero-inner hero-create-grid">
          <div className="hero-copy">
            <p className="eyebrow rise">Create it. Keep it. Make it yours.</p>
            <h1 className="hero-title rise" style={{ animationDelay: '60ms' }}>
              Your idea.
              <br />
              A working app.
              <br />
              <em>Yours to change.</em>
            </h1>
            <p className="hero-lede rise" style={{ animationDelay: '140ms' }}>
              Describe what you need with your own AI, or build it by hand. Edit the interface, write the logic in
              JavaScript or Python, connect your data and run it in your browser. Take the source with you in one{' '}
              <code>.softn</code> file.
            </p>
            <div className="hero-cta rise" style={{ animationDelay: '220ms' }}>
              <a className="cta cta-primary" href={STUDIO_HREF}>
                Create with AI
                <Arrow />
              </a>
              <a className="cta" href="/apps">
                Explore apps
                <Arrow />
              </a>
            </div>
            <p className="hero-alternative">Prefer a canvas and code? <a href={BUILDER_HREF}>Open Builder <span aria-hidden="true">↗</span></a></p>
            <ul className="hero-facts" aria-label="Getting started">
              <li>No account to start</li>
              <li>Your model, your choice</li>
              <li>Download the source</li>
            </ul>
            <p className="hero-provider-note">Studio uses the AI provider you connect. Your provider’s usage charges may apply.</p>
          </div>
          <div className="rise hero-workspace" style={{ animationDelay: '180ms' }}><WorkspacePreview /></div>
        </div>
      </header>

      <ExampleWalkthrough />
      <Doors />

      <section className="band band-featured" id="directory">
        <div className="wrap">
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
            <div className="notice" role="status">
              {total === 0 ? (
                <>
                  <strong>The directory is empty.</strong> Create the first app in <a href={STUDIO_HREF}>Studio</a> or{' '}
                  <a href={BUILDER_HREF}>Builder</a>, then <a href="/publish">publish your .softn file</a> to share it here.
                </>
              ) : (
                'Nothing in this list yet.'
              )}
            </div>
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
                App logic, in JavaScript or Python, runs on <a href="https://github.com/f2i-com/zipp.org">zipp</a>, an engine
                compiled to WebAssembly with nothing of the browser inside it. The network, your camera, its own server storage — an app
                gets those from the host, only if its manifest asks, and only after the page has told you and you have
                allowed it. That is a boundary, not a promise that an app is harmless.
              </p>
            </div>
            <div className="how">
              <span className="how-n">02</span>
              <h3 className="how-name">Read it, remix it</h3>
              <p className="how-copy">
                Every app&rsquo;s source is on its page. Open it in <a href={STUDIO_HREF}>Studio</a> to have a model change it, or in{' '}
                <a href={BUILDER_HREF}>Builder</a> to change it by hand, then publish the result as a remix that credits where it came
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

      <LearnDocs />

      <Language />
      <Pipeline />
      <ComponentIndex />
    </>
  );
}
