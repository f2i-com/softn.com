import React, { useEffect, useRef, useState } from 'react';
import { ApiError, getApp, getRating, listApps, rate, recordRun, savedKey, type AppCard as AppCardData, type AppDetail, type Category, type Rating } from '../lib/api';
import { capabilitySummary, formatBytes, formatCount, formatDate, timeAgo } from '../lib/format';
import { WEB_URL } from '../lib/appUrls';
import type { Route } from '../lib/router';
import { AppGrid, Thumb } from '../components/directory/AppCard';
import { StarInput, Stars } from '../components/directory/Stars';
import { ShareMenu } from '../components/directory/ShareMenu';
import { Comments } from '../components/directory/Comments';
import { SourceViewer } from '../components/directory/SourceViewer';

const CAPABILITY_NAMES: Record<string, string> = {
  net: 'Network',
  camera: 'Camera',
  mic: 'Microphone',
  files: 'Files',
  qr: 'QR codes',
  ai: 'AI models',
  gpu: 'GPU',
  sync: 'Sync',
  storage: 'Server storage',
};

function PlayGlyph({ size = 14 }: { size?: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function Badges({ capabilities, execution, official }: { capabilities: string[]; execution: string; official: boolean }): React.ReactElement {
  const { safe } = capabilitySummary(capabilities);
  return (
    <div className="badges" aria-label="What this app can reach">
      <span className={`badge ${safe ? 'badge-safe' : ''}`}>
        <span className="badge-dot" aria-hidden="true" />
        Sandboxed
      </span>
      {capabilities.length === 0 ? (
        <span className="badge">No capabilities</span>
      ) : (
        capabilities.map((c) => (
          <span key={c} className={`badge ${c === 'net' || c === 'camera' || c === 'mic' || c === 'files' ? 'badge-warn' : ''}`}>
            {CAPABILITY_NAMES[c] ?? c}
          </span>
        ))
      )}
      {!capabilities.includes('net') && <span className="badge">No network</span>}
      {execution === 'worker' && (
        <span className="badge" title="Its script runs in a worker thread, so the page stays responsive">
          Off-main-thread
        </span>
      )}
      {official && (
        <span className="badge badge-official" title="One of the demos that ship with the site">
          Ships with SoftN
        </span>
      )}
    </div>
  );
}

/**
 * The app, running, over the whole viewport: a game in a box the size of a
 * paragraph is not a game. A slim bar names the app and offers fullscreen,
 * the runtime and Close; the bar folds away to a corner tab so the app can
 * have every pixel. The runtime posts `softn:app-ready` once the bundle has
 * parsed and painted; until then the frame shows a starting state rather
 * than a black box.
 */
function Player({ app, onClose }: { app: AppDetail; onClose: () => void }): React.ReactElement {
  const [live, setLive] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [barHidden, setBarHidden] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const embedUrl = `${WEB_URL}/?${new URLSearchParams({ open: app.urls.bundle, embed: '1' })}`;

  useEffect(() => {
    let origin: string | null = null;
    try {
      origin = new URL(embedUrl, window.location.href).origin;
    } catch {
      origin = null;
    }
    const onMessage = (event: MessageEvent) => {
      if (!origin || event.origin !== origin) return;
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { type?: string } | null;
      if (data && typeof data === 'object' && data.type === 'softn:app-ready') setLive(true);
    };
    const onFs = () => setFullscreen(document.fullscreenElement === boxRef.current);
    // Escape closes the popup, but only once the app has let the pointer go:
    // a pointer-locked game takes the first Escape for itself.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.pointerLockElement) onClose();
    };
    window.addEventListener('message', onMessage);
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('keydown', onKey);
    // The page behind must not scroll under the popup.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('message', onMessage);
      document.removeEventListener('fullscreenchange', onFs);
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [embedUrl, onClose]);

  useEffect(() => {
    void recordRun(app.slug);
  }, [app.slug]);

  return (
    <div className={`app-popup ${barHidden ? 'app-popup-bare' : ''}`} id="play" ref={boxRef} role="dialog" aria-label={`${app.name}, running`}>
      {barHidden ? (
        <button type="button" className="app-popup-peek" onClick={() => setBarHidden(false)} title="Show the bar">
          <span className="live" data-on={live}>
            <span className="live-dot" aria-hidden="true" />
          </span>
          {app.name}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      ) : (
        <div className="app-frame-bar">
          <span className="app-frame-live">
            <span className="live" data-on={live}>
              <span className="live-dot" aria-hidden="true" />
              {live ? 'live' : 'starting'}
            </span>
            <span className="app-frame-name">{app.name}</span>
          </span>
          <span className="app-frame-actions">
            <button type="button" className="app-frame-btn" onClick={() => setBarHidden(true)} title="Hide this bar and give the app the whole screen">
              Hide bar
            </button>
            <button
              type="button"
              className="app-frame-btn"
              onClick={() => {
                const el = boxRef.current;
                if (!el) return;
                if (document.fullscreenElement !== el) void el.requestFullscreen?.();
                else void document.exitFullscreen?.();
              }}
            >
              {fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            </button>
            <a className="app-frame-btn" href={app.urls.run}>
              Open in the runtime
            </a>
            <button type="button" className="app-frame-btn app-frame-close" onClick={onClose} aria-label="Stop the app and close">
              Close
            </button>
          </span>
        </div>
      )}
      {!live && (
        <div className="app-frame-starting" aria-hidden="true">
          <Thumb app={app} className="app-frame-poster" />
          <span className="app-frame-starting-text">Starting the runtime…</span>
        </div>
      )}
      <iframe
        ref={frameRef}
        src={embedUrl}
        title={`${app.name}, running`}
        allow="camera; microphone; clipboard-write; autoplay; fullscreen; pointer-lock; gamepad"
        loading="eager"
      />
    </div>
  );
}

/** More to try: the same category, and the same author, without repeating the app itself. */
function Related({ app, categories }: { app: AppDetail; categories: Category[] }): React.ReactElement | null {
  const [same, setSame] = useState<AppCardData[]>([]);
  const [byAuthor, setByAuthor] = useState<AppCardData[]>([]);
  useEffect(() => {
    const ac = new AbortController();
    listApps({ category: app.category, sort: 'trending', perPage: 9 }, ac.signal)
      .then((r) => setSame(r.items.filter((a) => a.slug !== app.slug).slice(0, 4)))
      .catch(() => setSame([]));
    listApps({ author: app.author, sort: 'newest', perPage: 9 }, ac.signal)
      .then((r) => setByAuthor(r.items.filter((a) => a.slug !== app.slug).slice(0, 4)))
      .catch(() => setByAuthor([]));
    return () => ac.abort();
  }, [app.slug, app.category, app.author]);
  const category = categories.find((c) => c.id === app.category);
  if (same.length === 0 && byAuthor.length === 0) return null;
  return (
    <>
      {same.length > 0 && (
        <section className="app-section app-related">
          <h2 className="section-title">
            More in {category ? `${category.emoji} ${category.name}` : 'this category'}
            <a className="section-more" href={`/apps?category=${encodeURIComponent(app.category)}`}>
              See all
            </a>
          </h2>
          <AppGrid apps={same} categories={categories} />
        </section>
      )}
      {byAuthor.length > 0 && (
        <section className="app-section app-related">
          <h2 className="section-title">
            More by {app.author}
            <a className="section-more" href={`/apps?author=${encodeURIComponent(app.author)}`}>
              See all
            </a>
          </h2>
          <AppGrid apps={byAuthor} categories={categories} />
        </section>
      )}
    </>
  );
}

export function AppPage({ slug, categories, route }: { slug: string; categories: Category[]; route: Route }): React.ReactElement {
  const [app, setApp] = useState<AppDetail | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const [rating, setRating] = useState<Rating | null>(null);
  const [rateBusy, setRateBusy] = useState(false);
  const [rateError, setRateError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(route.query.get('play') === '1');
  const [showSource, setShowSource] = useState(false);
  const [sourceVersion, setSourceVersion] = useState<number | undefined>(undefined);
  const editable = Boolean(savedKey(slug));

  useEffect(() => {
    const ac = new AbortController();
    setApp(null);
    setError(null);
    setPlaying(route.query.get('play') === '1');
    setShowSource(false);
    setSourceVersion(undefined);
    getApp(slug, ac.signal)
      .then((a) => {
        setApp(a);
        document.title = `${a.name} — SoftN`;
        // A link opened by its manifest name lands on the slug.
        if (a.slug !== slug) window.history.replaceState({}, '', `/app/${a.slug}${window.location.search}`);
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        setError({ status: e instanceof ApiError ? e.status : 0, message: e instanceof Error ? e.message : String(e) });
      });
    getRating(slug, ac.signal)
      .then(setRating)
      .catch(() => {
        /* ratings are optional */
      });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const onRate = async (stars: number) => {
    if (!app) return;
    setRateBusy(true);
    setRateError(null);
    try {
      const r = await rate(app.slug, stars);
      setRating(r);
      setApp({ ...app, rating: { average: r.average, count: r.count } });
    } catch (e) {
      setRateError(e instanceof Error ? e.message : String(e));
    } finally {
      setRateBusy(false);
    }
  };

  const play = () => setPlaying(true);

  if (error) {
    return (
      <main className="app-page">
        <div className="wrap">
          <div className="empty">
            <p className="eyebrow">{error.status === 404 ? 'Not here' : 'Something went wrong'}</p>
            <h1 className="page-title">{error.status === 404 ? 'No app is published under that name.' : 'Could not load this app.'}</h1>
            <p className="muted">{error.message}</p>
            <p>
              <a className="cta cta-primary" href="/apps">
                Browse the directory
              </a>
            </p>
          </div>
        </div>
      </main>
    );
  }
  if (!app) {
    return (
      <main className="app-page">
        <div className="wrap">
          <div className="app-head app-head-skeleton" aria-busy="true">
            <div className="app-head-media">
              <div className="thumb" />
            </div>
            <div className="app-head-body">
              <span className="page-title">&nbsp;</span>
              <span className="app-byline">&nbsp;</span>
              <p className="app-desc">&nbsp;</p>
            </div>
          </div>
        </div>
      </main>
    );
  }

  const category = categories.find((c) => c.id === app.category);
  const shareTitle = `${app.name} on SoftN`;
  const shareText = app.description || `${app.name}, a SoftN app`;
  const breakdown = app.ratingBreakdown;
  const maxBreak = Math.max(1, ...Object.values(breakdown));
  const canStore = app.capabilities.includes('storage');
  const official = app.source === 'seed';

  return (
    <main className="app-page">
      <div className="wrap">
        <nav className="crumbs" aria-label="Breadcrumb">
          <a href="/apps">Apps</a>
          <span aria-hidden="true">›</span>
          {category ? (
            <a href={`/apps?category=${encodeURIComponent(category.id)}`}>
              {category.emoji} {category.name}
            </a>
          ) : (
            <a href="/apps">All</a>
          )}
          <span aria-hidden="true">›</span>
          <span>{app.name}</span>
        </nav>

        {playing && <Player app={app} onClose={() => setPlaying(false)} />}

        <div className="app-head">
          <div className="app-head-media">
            {playing ? (
              <button type="button" className="app-hero-thumb app-hero-thumb-playing" onClick={play}>
                <Thumb app={app} />
                <span className="app-hero-play">Running</span>
              </button>
            ) : (
              <button type="button" className="app-hero-thumb" onClick={play} aria-label={`Play ${app.name} here`}>
                <Thumb app={app} />
                <span className="app-hero-play">
                  <PlayGlyph size={22} />
                  Play here
                </span>
              </button>
            )}
          </div>
          <div className="app-head-body">
            <h1 className="page-title app-title">{app.name}</h1>
            <p className="app-byline">
              by <a href={`/apps?author=${encodeURIComponent(app.author)}`}>{app.author}</a>
              {app.parent && (
                <>
                  {' '}
                  · remix of <a href={`/app/${app.parent.slug}`}>{app.parent.name}</a>
                </>
              )}
              {' · '}
              <span title={app.createdAt}>published {timeAgo(app.createdAt)}</span>
              {app.version > 1 && <> · updated {timeAgo(app.updatedAt)}</>}
            </p>
            <Badges capabilities={app.capabilities} execution={app.execution} official={official} />
            <div className="stats">
              <span className="stat">
                <Stars average={app.rating.average} count={app.rating.count} size={14} showCount={false} />
                <strong>{app.rating.count > 0 ? app.rating.average.toFixed(1) : '–'}</strong>
                <span className="stat-label">{app.rating.count} rating{app.rating.count === 1 ? '' : 's'}</span>
              </span>
              <span className="stat">
                <strong>{formatCount(app.runs)}</strong>
                <span className="stat-label">run{app.runs === 1 ? '' : 's'}</span>
              </span>
              <span className="stat">
                <strong>{formatCount(app.remixes)}</strong>
                <span className="stat-label">remix{app.remixes === 1 ? '' : 'es'}</span>
              </span>
              <span className="stat">
                <strong>{formatCount(app.comments)}</strong>
                <span className="stat-label">comment{app.comments === 1 ? '' : 's'}</span>
              </span>
              <span className="stat">
                <strong>v{app.version}</strong>
                <span className="stat-label">{formatBytes(app.size)}</span>
              </span>
            </div>
            <div className="app-actions">
              <button type="button" className="cta cta-primary" onClick={play}>
                <PlayGlyph />
                Play
              </button>
              <a className="cta" href={app.urls.run}>
                Open in the runtime
              </a>
              <a className="cta" href={app.urls.remix}>
                Remix
              </a>
              <button type="button" className="cta" onClick={() => setShowSource((s) => !s)} aria-expanded={showSource} aria-controls="source">
                {showSource ? 'Hide source' : 'View source'}
              </button>
              <a className="cta" href={app.urls.download} download={`${app.slug}.softn`}>
                Download
              </a>
              <ShareMenu url={app.urls.page} title={shareTitle} text={shareText} />
              {editable && (
                <a className="cta cta-edit" href={`/publish?update=${encodeURIComponent(app.slug)}`}>
                  Update
                </a>
              )}
            </div>
            <p className="app-edit-links muted">
              Change it: <a href={app.urls.studio}>Studio</a> (have a model rewrite it) or <a href={app.urls.builder}>Builder</a> (by hand).
            </p>
          </div>
        </div>

        <div className="app-columns">
          <div className="app-main">
            {app.description && (
              <section className="app-section">
                <h2 className="section-title">About</h2>
                <p className="app-desc">{app.description}</p>
              </section>
            )}
            {app.tags.length > 0 && (
              <div className="tags">
                {app.tags.map((t) => (
                  <a key={t} className="tag" href={`/apps?tag=${encodeURIComponent(t)}`}>
                    #{t}
                  </a>
                ))}
              </div>
            )}

            {showSource && (
              <section className="app-section" id="source">
                <h2 className="section-title">
                  Source
                  {app.versions.length > 1 && (
                    <select className="section-select" value={sourceVersion ?? app.version} onChange={(e) => setSourceVersion(Number(e.target.value))} aria-label="Version to read">
                      {app.versions.map((v) => (
                        <option key={v.version} value={v.version}>
                          v{v.version}
                        </option>
                      ))}
                    </select>
                  )}
                </h2>
                <p className="muted">
                  Every file in the bundle, as published. Open it in <a href={app.urls.studio}>Studio</a> or <a href={app.urls.builder}>Builder</a>{' '}
                  to change it.
                </p>
                <SourceViewer slug={app.slug} version={sourceVersion} main={app.manifest?.main} />
              </section>
            )}

            <Comments slug={app.slug} onCount={(n) => setApp((a) => (a ? { ...a, comments: n } : a))} />
          </div>

          <aside className="app-side">
            <section className="side-card">
              <h2 className="side-title">Rate it</h2>
              <StarInput mine={rating?.mine ?? null} onRate={onRate} busy={rateBusy} />
              {rateError && <p className="form-error">{rateError}</p>}
              <div className="breakdown" aria-label="Rating breakdown">
                {[5, 4, 3, 2, 1].map((n) => {
                  const count = breakdown[String(n) as '1' | '2' | '3' | '4' | '5'] ?? 0;
                  return (
                    <div key={n} className="breakdown-row">
                      <span className="breakdown-n">{n}</span>
                      <span className="breakdown-bar">
                        <span className="breakdown-fill" style={{ width: `${(count / maxBreak) * 100}%` }} />
                      </span>
                      <span className="breakdown-count">{count}</span>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="side-card">
              <h2 className="side-title">What it can reach</h2>
              <ul className="side-list">
                <li>
                  <span className="badge-dot" aria-hidden="true" /> Runs in the zipp sandbox: no DOM, no filesystem, no ambient network.
                </li>
                {app.capabilities.length === 0 && <li>Declares no capabilities at all.</li>}
                {app.capabilities.map((c) => (
                  <li key={c}>
                    <strong>{CAPABILITY_NAMES[c] ?? c}</strong>
                    {c === 'storage' && ' — keeps records in its own database on this site.'}
                    {c === 'net' && ' — may call the internet; the runtime asks you first.'}
                    {c === 'camera' && ' — may take pictures, with your permission.'}
                    {c === 'mic' && ' — may record audio, with your permission.'}
                    {c === 'files' && ' — may read files you choose.'}
                    {c === 'ai' && ' — downloads and runs a model in your browser.'}
                    {c === 'gpu' && ' — uses your graphics card for compute.'}
                    {c === 'sync' && ' — replicates its data to your other devices.'}
                    {c === 'qr' && ' — scans QR codes.'}
                  </li>
                ))}
              </ul>
              {canStore && (
                <p className="muted">
                  Stored here so far: {app.storage.records} record{app.storage.records === 1 ? '' : 's'} in {app.storage.collections} collection
                  {app.storage.collections === 1 ? '' : 's'}
                  {app.storage.keys > 0 ? `, ${app.storage.keys} key${app.storage.keys === 1 ? '' : 's'}` : ''} ({formatBytes(app.storage.bytes)}).
                </p>
              )}
            </section>

            {(app.lineage.length > 0 || app.remixList.length > 0) && (
              <section className="side-card">
                <h2 className="side-title">Lineage</h2>
                {app.lineage.length > 0 && (
                  <p className="side-lineage">
                    {[...app.lineage].reverse().map((l) => (
                      <React.Fragment key={l.slug}>
                        <a href={`/app/${l.slug}`}>{l.name}</a>
                        <span aria-hidden="true"> → </span>
                      </React.Fragment>
                    ))}
                    <strong>{app.name}</strong>
                  </p>
                )}
                {app.remixList.length > 0 && (
                  <>
                    <p className="muted">
                      {app.remixes} remix{app.remixes === 1 ? '' : 'es'} of this app:
                    </p>
                    <ul className="side-list">
                      {app.remixList.map((r) => (
                        <li key={r.slug}>
                          <a href={`/app/${r.slug}`}>{r.name}</a> <span className="muted">by {r.author}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </section>
            )}

            <section className="side-card">
              <h2 className="side-title">Versions</h2>
              <ul className="side-list">
                {app.versions.map((v) => (
                  <li key={v.version}>
                    <a href={`${v.bundle}&download=1`} download={`${app.slug}-v${v.version}.softn`}>
                      v{v.version}
                    </a>{' '}
                    <span className="muted">
                      {v.manifestVersion && `(${v.manifestVersion}) `}
                      {formatDate(v.createdAt)} · {formatBytes(v.size)}
                    </span>
                    {v.notes && <div className="side-note">{v.notes}</div>}
                  </li>
                ))}
              </ul>
              {app.manifest && (
                <p className="muted">
                  Entry <code>{app.manifest.main}</code>
                  {Object.entries(app.manifest.files).length > 0 && (
                    <>
                      {' · '}
                      {Object.entries(app.manifest.files)
                        .map(([k, n]) => `${n} ${k}`)
                        .join(', ')}
                    </>
                  )}
                </p>
              )}
            </section>

            <section className="side-card">
              <h2 className="side-title">{editable ? 'Yours' : 'Yours to update?'}</h2>
              {editable ? (
                <p className="muted">
                  This browser holds the edit key. <a href={`/publish?update=${encodeURIComponent(app.slug)}`}>Publish a new version</a>, change the listing,
                  replace the screenshot or take it down.
                </p>
              ) : official ? (
                <p className="muted">
                  This one ships with the site. To make it yours, <a href={app.urls.remix}>remix it</a>.
                </p>
              ) : (
                <p className="muted">
                  Publishing handed out an edit key. With it, <a href={`/publish?update=${encodeURIComponent(app.slug)}`}>publish a new version</a> or change
                  the listing. Without it, <a href={app.urls.remix}>remix</a> instead.
                </p>
              )}
            </section>
          </aside>
        </div>

        <Related app={app} categories={categories} />
      </div>
    </main>
  );
}
