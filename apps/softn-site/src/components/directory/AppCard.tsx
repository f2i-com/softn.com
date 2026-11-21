import React from 'react';
import type { AppCard as AppCardData, Category } from '../../lib/api';
import { recordRun } from '../../lib/api';
import { runtimeAppUrl } from '../../lib/appUrls';
import { formatCount, runsLabel } from '../../lib/format';
import { ExternalGlyph, PlayGlyph } from '../glyphs';
import { Stars } from './Stars';

/**
 * The app's picture. A real screenshot fills the frame; an icon sits on the
 * app's own colour; an app with neither gets its initial on that colour, so
 * a grid of them still reads as a shelf of apps and not a shelf of holes.
 */
export function Thumb({ app, className = '', loading = 'lazy' }: {
  app: AppCardData;
  className?: string;
  loading?: 'eager' | 'lazy';
}): React.ReactElement {
  const [failedUrl, setFailedUrl] = React.useState<string>();
  const tint = app.primary ?? '#2a3040';
  const ground = { background: `linear-gradient(135deg, ${tint}, color-mix(in srgb, ${tint} 55%, #000))` };
  if (app.thumbnail && app.thumbnail !== failedUrl && (app.thumbnailKind === 'image' || app.thumbnailKind === 'icon')) {
    return (
      <div className={`thumb thumb-${app.thumbnailKind} ${className}`} style={ground}>
        <img src={app.thumbnail} alt="" loading={loading} decoding="async" onError={() => setFailedUrl(app.thumbnail)} />
      </div>
    );
  }
  return (
    <div className={`thumb thumb-letter ${className}`} style={ground} aria-hidden="true">
      <span>{(app.name.trim().charAt(0) || '?').toUpperCase()}</span>
    </div>
  );
}

/**
 * The one way an app runs from the directory: straight into the runtime,
 * with the count bumped on the way out. The runtime's Close brings the
 * visitor back to the app's page.
 *
 * A linked app plays on its own site instead: a real link, in a new tab,
 * so the directory stays behind it and the browser's own link behaviours
 * (middle-click, copy address) all do the expected thing.
 */
function PlayLink({ app, className, children }: { app: AppCardData; className: string; children: React.ReactNode }): React.ReactElement {
  if (app.external) {
    return (
      <a
        className={`${className} play-external`}
        href={app.external.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => void recordRun(app.slug)}
        aria-label={`Play ${app.name} on ${app.external.host} (opens in a new tab)`}
        title={`Opens ${app.external.host} in a new tab`}
      >
        {children}
        <ExternalGlyph size={11} />
      </a>
    );
  }
  return (
    <a className={className} href={runtimeAppUrl(app.slug)} onClick={() => void recordRun(app.slug)} aria-label={`Play ${app.name}`}>
      {children}
    </a>
  );
}

/**
 * One app, as a row of the list: its picture small at the left, then its name,
 * what it does and who made it, and Play at the right. The name is the link to
 * the app's page and stretches over the whole row; Play is a second link,
 * straight into the runtime, because the first thing most visitors want to do
 * with an app is run it, and it is on the row all the time: it used to be a
 * pill that appeared over the picture under a mouse, so a visitor who had not
 * hovered saw a wall of pictures and no way to run one.
 *
 * A row and not a card with a picture across its top: a phone showed two apps
 * a screen and the directory's twenty-three were eleven screens long; a laptop
 * showed eight. Rows show a screenful at once, and the app's own page has the
 * picture large.
 *
 * The line under the description says what a visitor decides on: who made it,
 * what kind of app it is, how it is rated and how much it is played. A count
 * of nothing is not shown.
 */
export function AppCard({ app, category }: { app: AppCardData; category?: Category }): React.ReactElement {
  const official = app.source === 'seed';
  const subcategory = app.subcategory ? category?.subcategories?.find((s) => s.slug === app.subcategory) : undefined;
  return (
    <article className="app-card">
      <div className="app-card-media">
        <Thumb app={app} />
      </div>
      <div className="app-card-body">
        <a className="app-card-link app-card-name" href={app.urls.page}>
          {app.name}
        </a>
        <p className="app-card-desc">{app.description || 'No description yet.'}</p>
        <div className="app-card-meta">
          {/* The mint tag marks an app that ships with the site. Where its
              author is SoftN too, the tag is the byline: the row said
              "SoftN" twice, once in each colour. */}
          <span className="app-card-stat app-card-author">
            {!(official && app.author === 'SoftN') && <>{app.author} </>}
            {official && (
              <span className="app-card-official" title="Ships with the site">
                SoftN
              </span>
            )}
          </span>
          {app.parent && <span className="app-card-stat app-card-remix">remix of {app.parent.name}</span>}
          {category && (
            <span className="app-card-stat app-card-cat">
              {category.emoji} {category.name}
              {subcategory ? ` · ${subcategory.name}` : app.subcategory ? ` · ${app.subcategory}` : ''}
            </span>
          )}
          {app.rating.count > 0 && (
            <span className="app-card-stat app-card-rating">
              <Stars average={app.rating.average} count={app.rating.count} size={12} showCount={false} />
              {app.rating.average.toFixed(1)}
            </span>
          )}
          {app.runs > 0 && <span className="app-card-stat">{runsLabel(app.runs)}</span>}
          {app.remixes > 0 && (
            <span className="app-card-stat">
              {formatCount(app.remixes)} {app.remixes === 1 ? 'remix' : 'remixes'}
            </span>
          )}
          {app.external && (
            <span className="app-card-stat app-card-linked" title={`Plays at ${app.external.host}, in a new tab`}>
              <ExternalGlyph size={11} />
              {app.external.host}
            </span>
          )}
          {!app.external && app.hosting?.serverHosted && (
            <span
              className="app-card-stat app-card-hosting"
              title={
                app.hosting.mode === 'hybrid'
                  ? 'Hosted multi-user on SoftN (ZIPP safe-sandbox) or run locally in your browser sandbox'
                  : 'Hosted multi-user on SoftN inside ZIPP safe-sandbox'
              }
            >
              {app.hosting.mode === 'hybrid' ? 'hosted + local' : 'hosted on SoftN'}
            </span>
          )}
          {!app.external && !app.hosting?.serverHosted && app.backendRuntime && (
            <span
              className="app-card-stat app-card-hosting"
              title={`Runs its ${app.backendRuntime.toUpperCase()} backend + SQLite locally inside your browser sandbox`}
            >
              browser · {app.backendRuntime.toUpperCase()}
            </span>
          )}
          {!app.external && !app.capabilities.includes('net') && (
            <span
              className="app-card-stat app-card-safe"
              title="Makes no network requests of its own; a hosted service it declares, such as server storage, still reaches this site"
            >
              no net
            </span>
          )}
        </div>
      </div>
      {/* The word is drawn where there is room for it; a phone's row has the
          glyph alone, and the link's name says the rest either way. */}
      <PlayLink app={app} className="app-card-play">
        <PlayGlyph size={12} />
        <span className="app-card-play-label">Play</span>
      </PlayLink>
    </article>
  );
}

export function AppGrid({
  apps,
  categories,
  skeleton = 0,
  loading = false,
  short = false,
}: {
  apps: AppCardData[];
  categories: Category[];
  skeleton?: number;
  loading?: boolean;
  /** A sample of a list, not the list: a phone shows its first six rows. */
  short?: boolean;
}): React.ReactElement {
  const byId = new Map(categories.map((c) => [c.id, c]));
  return (
    <div className={`app-grid${short ? ' app-grid-short' : ''}${loading && apps.length > 0 ? ' app-grid-loading' : ''}`} aria-busy={loading}>
      {apps.map((app) => (
        <AppCard key={app.slug} app={app} category={byId.get(app.category)} />
      ))}
      {apps.length === 0 &&
        Array.from({ length: skeleton }, (_, i) => (
          <div key={`s${i}`} className="app-card app-card-skeleton" aria-hidden="true">
            <div className="app-card-media">
              <div className="thumb" />
            </div>
            <div className="app-card-body">
              <span className="app-card-name">&nbsp;</span>
              <p className="app-card-desc">&nbsp;</p>
            </div>
          </div>
        ))}
    </div>
  );
}

/**
 * The apps the mosaic below draws, of a ranked list: the lead and four small
 * ones, or the lead and two when there are fewer than five. The front page
 * asks so that the list under its shelf can leave these out.
 */
export function shelfApps(apps: AppCardData[]): AppCardData[] {
  if (apps.length < 3) return [];
  return apps.slice(0, apps.length - 1 >= 4 ? 5 : 3);
}

/**
 * Which apps lead the directory. Played a lot, rated well, and with a
 * picture to show for it — a screenshot counts for more than an icon, and
 * an icon for more than a letter, because this is the shelf a first-time
 * visitor sees. Ties go to the app that bothered to describe itself.
 */
export function pickFeatured(apps: AppCardData[], count = 5): AppCardData[] {
  const score = (a: AppCardData) =>
    Math.log1p(a.runs) +
    (a.rating.average * Math.min(a.rating.count, 5)) / 5 +
    (a.thumbnailKind === 'image' ? 1.25 : a.thumbnailKind === 'icon' ? 0.4 : 0) +
    (a.description ? 0.25 : 0);
  return [...apps].sort((x, y) => score(y) - score(x)).slice(0, count);
}

/** Reserve the same shelf layout while the directory is loading. */
export function FeaturedSkeleton(): React.ReactElement {
  return (
    <div aria-hidden="true">
      <p className="featured-heading">Featured apps</p>
      <div className="featured-grid">
        <div className="featured-card featured-lead featured-skeleton" />
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="featured-card featured-pick featured-skeleton" />
        ))}
      </div>
    </div>
  );
}

/** A featured app and up to four more picks, each with its own direct Play link. */
export function Featured({ apps, categories }: { apps: AppCardData[]; categories: Category[] }): React.ReactElement | null {
  const shown = shelfApps(apps);
  if (shown.length === 0) return null;
  const byId = new Map(categories.map((c) => [c.id, c]));
  const [lead, ...small] = shown;
  const leadCategory = byId.get(lead.category);
  return (
    <section className="featured" aria-labelledby="featured-title">
      <h2 id="featured-title" className="featured-heading">Featured apps</h2>
      <div className="featured-grid">
        <article className="featured-card featured-lead">
          <Thumb app={lead} loading="eager" />
          <div className="featured-shade" aria-hidden="true" />
          <div className="featured-body">
            {leadCategory && (
              <span className="featured-cat">
                {leadCategory.emoji} {leadCategory.name}
              </span>
            )}
            <a className="featured-link featured-name" href={lead.urls.page}>
              {lead.name}
            </a>
            <span className="featured-byline">
              {lead.author}
              {lead.runs > 0 && <> · {runsLabel(lead.runs)}</>}
              {lead.rating.count > 0 && <> · {lead.rating.average.toFixed(1)} ★</>}
            </span>
            {lead.description && <p className="featured-desc">{lead.description}</p>}
            <div className="featured-actions">
              <PlayLink app={lead} className="featured-play">
                <PlayGlyph size={14} />
                Play
              </PlayLink>
              <a className="featured-about" href={lead.urls.page}>
                About this app
              </a>
            </div>
          </div>
        </article>
        {small.map((app) => (
          <article key={app.slug} className="featured-card featured-pick">
            <Thumb app={app} />
            <div className="featured-body">
              <a className="featured-link featured-name" href={app.urls.page}>
                {app.name}
              </a>
              <span className="featured-byline">
                {app.author}
                {app.runs > 0 && <> · {runsLabel(app.runs)}</>}
              </span>
            </div>
            <PlayLink app={app} className="featured-play featured-play-small">
              <PlayGlyph size={16} />
            </PlayLink>
          </article>
        ))}
      </div>
    </section>
  );
}
