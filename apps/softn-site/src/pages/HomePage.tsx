import React, { useEffect, useState } from 'react';
import { listApps, type AppCard as AppCardData, type Category } from '../lib/api';
import { AppGrid, Featured, FeaturedSkeleton } from '../components/directory/AppCard';
import { useFeaturedShelf } from '../components/directory/featured';
import { Arrow } from '../components/glyphs';
import { CategoriesNotice, CategoryChips } from '../components/directory/Controls';
import { Language } from '../components/Language';
import { Pipeline } from '../components/Pipeline';
import { ComponentIndex } from '../components/ComponentIndex';
import { LearnDocs } from '../components/LearnDocs';
import { HeroApp } from '../components/home/HeroApp';
import { StartWays } from '../components/home/StartWays';
import { HowItWorks } from '../components/home/HowItWorks';
import { WhyDifferent } from '../components/home/WhyDifferent';
import { ForDevelopers } from '../components/home/ForDevelopers';
import { HomeFaq } from '../components/home/HomeFaq';
import { BUILDER_HREF, STUDIO_HREF } from '../lib/appUrls';
import { fieldnotesInRuntime } from '../lib/examples';

const LISTS: Array<{ id: string; name: string }> = [
  { id: 'trending', name: 'Trending' },
  { id: 'newest', name: 'New' },
  { id: 'top', name: 'Top rated' },
  { id: 'remixed', name: 'Most remixed' },
];

/** How many of the directory's apps the front page shows: two rows of three. */
const GALLERY_SIZE = 6;

/**
 * Show the product before teaching it: a real app running in the hero with the two things a visitor came to do — try
 * an app, create one — then apps people have made, the ways to start, the workflow, and only then what makes it
 * different and how it is built. The tools' names (Studio, Builder, the runtime) are introduced where they are the next
 * step, never as a choice to decode first.
 *
 * The directory's apps do not run here: an app's bundle is only fetched when someone presses Play, which opens it in
 * the runtime. The one exception is the hero's Fieldnotes preview, which embeds the real runtime — engine and all — so
 * LiveAppPreview mounts it only after the page has loaded and once it is scrolled into view, and not at all until asked
 * for on a phone, for a visitor saving data or on a slow connection.
 *
 * Three requests feed the gallery — categories, the featured shelf, the list — and each has its own status. None gates
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
    listApps({ sort, perPage: GALLERY_SIZE }, ac.signal)
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
      <header className="hero hero-home" id="top">
        <div className="wrap hero-inner hero-home-grid">
          <div className="hero-copy">
            <p className="eyebrow rise">Build it. Run it. Keep it.</p>
            <h1 className="hero-title rise" style={{ animationDelay: '60ms' }}>
              Build apps you can run, edit and share.
            </h1>
            <p className="hero-lede rise" style={{ animationDelay: '140ms' }}>
              SoftN lets you make portable web-style apps with a visual builder, familiar code or AI. Try a real app,
              change it and publish your own.
            </p>
            <div className="hero-cta rise" style={{ animationDelay: '220ms' }}>
              <a className="cta cta-primary cta-large" href={fieldnotesInRuntime('/#top')}>
                Try an app
                <Arrow />
              </a>
              <a className="cta cta-large" href="#create">
                Create an app
                <Arrow />
              </a>
            </div>
            <p className="hero-links">
              <a href="/apps">Explore all apps</a>
              <a href="/docs/">Read the docs</a>
            </p>
            <ul className="hero-facts" aria-label="Before you start">
              <li>No account needed to try</li>
              <li>Editable source</li>
              <li>Runs in your browser</li>
            </ul>
          </div>
          <div className="rise hero-app" style={{ animationDelay: '180ms' }}><HeroApp /></div>
        </div>
      </header>

      <section className="band band-featured" id="directory">
        <div className="wrap">
          <div className="band-head band-head-row">
            <div>
              <p className="eyebrow">Made with SoftN</p>
              <h2 className="band-title">Apps people have made</h2>
              <p className="band-sub">Play one in your browser, open its source, or remix it into your own.</p>
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
          {(featured === null || featured.length >= 3) && (
            <div className="hero-shelf">
              {featured === null ? <FeaturedSkeleton /> : <Featured apps={featured} categories={categories} heading={null} />}
              {featuredSeenAt !== null && (
                <p className="hero-shelf-note muted" role="status">
                  The directory is not answering right now. This shelf is as it was on{' '}
                  {new Date(featuredSeenAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}.
                </p>
              )}
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
            <AppGrid apps={apps} categories={categories} skeleton={listLoading ? GALLERY_SIZE : 0} loading={listLoading} />
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
      <Language />
      <Pipeline />
      <ComponentIndex />
      <HomeFaq />
    </>
  );
}
