import React, { useEffect, useState } from 'react';
import { listApps, type AppCard as AppCardData, type Category } from '../lib/api';
import { AppGrid } from '../components/directory/AppCard';
import { CategoryChips, SearchBox } from '../components/directory/Controls';
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

export function HomePage({ categories, apiDown }: { categories: Category[]; apiDown: string | null }): React.ReactElement {
  const [sort, setSort] = useState('trending');
  const [apps, setApps] = useState<AppCardData[]>([]);
  const [total, setTotal] = useState<number | null>(null);

  useEffect(() => {
    if (apiDown) return undefined;
    const ac = new AbortController();
    listApps({ sort, perPage: 8 }, ac.signal)
      .then((r) => {
        setApps(r.items);
        setTotal(r.total);
      })
      .catch(() => {
        /* the banner already says the directory is away */
      });
    return () => ac.abort();
  }, [sort, apiDown]);

  return (
    <>
      <header className="hero hero-dir" id="top">
        <div className="wrap hero-inner">
          <p className="eyebrow rise" style={{ animationDelay: '40ms' }}>
            A directory of apps, and the sandbox they run in
          </p>
          <h1 className="hero-title rise" style={{ animationDelay: '100ms' }}>
            Apps that run anywhere. <em>Safely.</em>
          </h1>
          <p className="hero-lede rise" style={{ animationDelay: '180ms' }}>
            Every app here is one <code>.softn</code> file: its interface, its logic and its assets, running inside a
            sandboxed engine in your browser. Play it, read every line of it, remix it, publish your own —{' '}
            <strong>no account needed</strong>. Made by people, and increasingly by models.
          </p>
          <div className="hero-search rise" style={{ animationDelay: '240ms' }}>
            <SearchBox autoFocus={false} />
          </div>
          <div className="hero-pills rise" style={{ animationDelay: '300ms' }}>
            <CategoryChips categories={categories} selected="" hrefFor={(id) => (id === 'all' ? '/apps' : `/apps?category=${encodeURIComponent(id)}`)} limit={9} />
          </div>
          <div className="hero-cta rise" style={{ animationDelay: '360ms' }}>
            <a className="cta cta-primary" href="/apps">
              Browse {total !== null ? `${total} ` : ''}apps
              <Arrow />
            </a>
            <a className="cta" href="/publish">
              Publish an app
              <Arrow />
            </a>
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
            <div className="tabs" role="tablist" aria-label="Featured apps">
              {FEATURED.map((f) => (
                <button key={f.id} type="button" role="tab" aria-selected={sort === f.id} className={`tab ${sort === f.id ? 'on' : ''}`} onClick={() => setSort(f.id)}>
                  {f.name}
                </button>
              ))}
            </div>
          </div>
          {apiDown ? (
            <div className="notice">
              <strong>The directory is not answering.</strong> {apiDown} The demos below still run.
            </div>
          ) : (
            <AppGrid apps={apps} categories={categories} skeleton={8} />
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
            <h2 className="band-title">Discover → run → read → remix → publish</h2>
            <p className="band-sub">
              The loop is the product. Nothing here asks you to trust the author, because the sandbox does not have to.
            </p>
          </div>
          <div className="how-grid">
            <div className="how">
              <span className="how-n">01</span>
              <h3 className="how-name">Run it, safely</h3>
              <p className="how-copy">
                Apps run on <a href="https://github.com/f2i-com/zipp.org">zipp</a>, a JavaScript engine compiled to WebAssembly with
                nothing of the browser inside it. An app can only reach the network, your camera or its own server storage if its
                manifest declares it — and the page tells you before you allow it.
              </p>
            </div>
            <div className="how">
              <span className="how-n">02</span>
              <h3 className="how-name">Read it, remix it</h3>
              <p className="how-copy">
                Every app's source is on its page. Open it in <a href="/studio/">Studio</a> to have a model change it, or in{' '}
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
            <h2 className="band-title">The runtime, live</h2>
            <p className="band-sub">
              The file on the left is read out of the same bundle the runtime on the right is executing. Neither side is a picture.
            </p>
          </div>
          <Player />
        </div>
      </Reveal>

      <Doors />
      <Language />
      <Pipeline />
      <ComponentIndex />
    </>
  );
}
