import React, { useEffect, useState } from 'react';
import { listApps, type AppCard as AppCardData, type Category } from '../lib/api';
import { AppGrid } from '../components/directory/AppCard';
import { CategoryChips, SearchBox } from '../components/directory/Controls';
import { HeroStage } from '../components/HeroStage';
import { Player } from '../components/Player';
import { Doors } from '../components/Doors';
import { Language } from '../components/Language';
import { Pipeline } from '../components/Pipeline';
import { ComponentIndex } from '../components/ComponentIndex';
import { Reveal } from '../components/Reveal';

const FEATURED: Array<{ id: string; name: string }> = [
  { id: 'trending', name: 'Trending' },
  { id: 'newest', name: 'New' },
  { id: 'top', name: 'Top rated' },
  { id: 'remixed', name: 'Most remixed' },
];

function Arrow(): React.ReactElement {
  return (
    <svg className="cta-arrow" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M3 7h8M7.5 3.5 11 7l-3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The hero is the apps: a headline beside a stage that runs one of six of
 * them on request. Then the directory, then how the loop works, then the
 * runtime with its source open, then the tools and the language.
 *
 * The stage and the source explorer each hold a runtime iframe, so they are
 * made mutually exclusive here: launching an app closes the explorer, and
 * opening the explorer closes the app. The page never carries two engines,
 * and idle it carries none.
 */
export function HomePage({ categories, apiDown }: { categories: Category[]; apiDown: string | null }): React.ReactElement {
  const [sort, setSort] = useState('trending');
  const [apps, setApps] = useState<AppCardData[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [featuredLoading, setFeaturedLoading] = useState(true);
  const [featuredError, setFeaturedError] = useState<string | null>(null);
  const [featuredAttempt, setFeaturedAttempt] = useState(0);
  const [explorerOpen, setExplorerOpen] = useState(false);

  // The featured list has its own loading and failure state. It used to
  // swallow a failed request on the theory that the outage banner already
  // covered it — but the banner reflects the categories request, and the two
  // can fail independently: categories cached, list down, and the page showed
  // eight skeleton cards forever with nothing to press.
  useEffect(() => {
    if (apiDown) return undefined;
    const ac = new AbortController();
    setFeaturedError(null);
    setFeaturedLoading(true);
    setApps([]);
    listApps({ sort, perPage: 8 }, ac.signal)
      .then((r) => {
        if (ac.signal.aborted) return;
        setApps(r.items);
        setTotal(r.total);
        setFeaturedLoading(false);
      })
      .catch(() => {
        if (ac.signal.aborted) return;
        setFeaturedError('This list could not be loaded. Try again, or launch a demo above.');
        setFeaturedLoading(false);
      });
    return () => ac.abort();
  }, [sort, apiDown, featuredAttempt]);

  return (
    <>
      <header className="hero hero-dir" id="top">
        <div className="wrap hero-inner hero-grid">
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
            <p className="hero-aside rise" style={{ animationDelay: '300ms' }}>
              Or pick one of the six on the right. It only starts when you say so.
            </p>
          </div>
          <div className="hero-stage rise" style={{ animationDelay: '180ms' }}>
            <HeroStage suspended={explorerOpen} onLaunch={() => setExplorerOpen(false)} />
          </div>
        </div>
      </header>

      <section className="band band-featured" id="featured">
        <div className="wrap">
          <div className="band-head band-head-row">
            <div>
              <p className="eyebrow">The directory</p>
              <h2 className="band-title">What people are running</h2>
            </div>
            {/* Plain pressed buttons: these filter a list, and the tab pattern
                they used to claim comes with keyboard and panel semantics they
                never had. */}
            <div className="tabs" role="group" aria-label="Sort featured apps">
              {FEATURED.map((f) => (
                <button key={f.id} type="button" aria-pressed={sort === f.id} className={`tab ${sort === f.id ? 'on' : ''}`} onClick={() => setSort(f.id)}>
                  {f.name}
                </button>
              ))}
            </div>
          </div>
          <div className="hero-search">
            <SearchBox autoFocus={false} />
          </div>
          <div className="hero-pills">
            <CategoryChips categories={categories} selected="" hrefFor={(id) => (id === 'all' ? '/apps' : `/apps?category=${encodeURIComponent(id)}`)} limit={9} />
          </div>
          {apiDown ? (
            <div className="notice">
              <strong>The directory is not answering.</strong> {apiDown} The demos above still run.
            </div>
          ) : featuredError ? (
            <div className="notice" role="status">
              <strong>{featuredError}</strong>{' '}
              <button type="button" className="cta" onClick={() => setFeaturedAttempt((n) => n + 1)}>
                Retry
              </button>
            </div>
          ) : !featuredLoading && apps.length === 0 ? (
            <div className="notice">Nothing in this list yet. The demos above are a place to start.</div>
          ) : (
            <AppGrid apps={apps} categories={categories} skeleton={featuredLoading ? 8 : 0} loading={featuredLoading} />
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
                database on the server — a scoreboard, shared notes, whatever the app needs.
              </p>
            </div>
          </div>
        </div>
      </Reveal>

      <Reveal as="section" className="band" id="demos">
        <div className="wrap">
          <div className="band-head">
            <p className="eyebrow">Under the hood</p>
            <h2 className="band-title">The runtime, with its source open</h2>
            <p className="band-sub">
              The file on the left is read out of the same bundle the runtime on the right is executing. Neither side is a picture.
            </p>
          </div>
          {/* Mounted only when opened: the explorer boots a runtime of its own,
              and a visitor who came for the directory should not pay for it. */}
          <button
            type="button"
            className="cta"
            aria-expanded={explorerOpen}
            aria-controls="runtime-source-explorer"
            onClick={() => setExplorerOpen((open) => !open)}
          >
            {explorerOpen ? 'Close the source explorer' : 'Open the source explorer'}
            <Arrow />
          </button>
          <div id="runtime-source-explorer">{explorerOpen && <Player />}</div>
        </div>
      </Reveal>

      <Doors />
      <Language />
      <Pipeline />
      <ComponentIndex />
    </>
  );
}
