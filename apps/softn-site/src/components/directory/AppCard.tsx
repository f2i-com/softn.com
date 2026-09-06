import React from 'react';
import type { AppCard as AppCardData, Category } from '../../lib/api';
import { recordRun } from '../../lib/api';
import { runtimeAppUrl } from '../../lib/appUrls';
import { formatCount } from '../../lib/format';
import { Stars } from './Stars';

/**
 * The app's picture. A real screenshot fills the frame; an icon sits on the
 * app's own colour; an app with neither gets its initial on that colour, so
 * a grid of them still reads as a shelf of apps and not a shelf of holes.
 */
export function Thumb({ app, className = '' }: { app: AppCardData; className?: string }): React.ReactElement {
  const tint = app.primary ?? '#2a3040';
  const ground = { background: `linear-gradient(135deg, ${tint}, color-mix(in srgb, ${tint} 55%, #000))` };
  if (app.thumbnailKind === 'image') {
    return (
      <div className={`thumb thumb-image ${className}`}>
        <img src={app.thumbnail} alt="" loading="lazy" decoding="async" />
      </div>
    );
  }
  if (app.thumbnailKind === 'icon') {
    return (
      <div className={`thumb thumb-icon ${className}`} style={ground}>
        <img src={app.thumbnail} alt="" loading="lazy" decoding="async" />
      </div>
    );
  }
  return (
    <div className={`thumb thumb-letter ${className}`} style={ground} aria-hidden="true">
      <span>{(app.name.trim().charAt(0) || '?').toUpperCase()}</span>
    </div>
  );
}

function PlayGlyph({ size = 12 }: { size?: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

/**
 * The one way an app runs from the directory: straight into the runtime,
 * with the count bumped on the way out. The runtime's Close brings the
 * visitor back to the app's page.
 */
function PlayLink({ app, className, children }: { app: AppCardData; className: string; children: React.ReactNode }): React.ReactElement {
  return (
    <a className={className} href={runtimeAppUrl(app.slug)} onClick={() => void recordRun(app.slug)} aria-label={`Play ${app.name}`}>
      {children}
    </a>
  );
}

/**
 * One app, as a card. The name is the link to the app's page and stretches
 * over the whole card; the "play" pill over the picture is a second link,
 * straight into the runtime, because the first thing most visitors want to
 * do with an app is run it. The meta row says what a visitor decides on:
 * how it is rated, how much it is played, whether it has been remixed.
 */
export function AppCard({ app, category }: { app: AppCardData; category?: Category }): React.ReactElement {
  const official = app.source === 'seed';
  return (
    <article className="app-card">
      <div className="app-card-media">
        <Thumb app={app} />
        <PlayLink app={app} className="app-card-play">
          <PlayGlyph />
          Play
        </PlayLink>
        {category && (
          <span className="app-card-cat" title={category.name}>
            {category.emoji} {category.name}
          </span>
        )}
      </div>
      <div className="app-card-body">
        <div className="app-card-head">
          <a className="app-card-link app-card-name" href={app.urls.page}>
            {app.name}
          </a>
          {official && (
            <span className="app-card-official" title="Ships with the site">
              SoftN
            </span>
          )}
        </div>
        <span className="app-card-author">
          {app.author}
          {app.parent && <span className="app-card-remix"> · remix of {app.parent.name}</span>}
        </span>
        <p className="app-card-desc">{app.description || 'No description yet.'}</p>
        <div className="app-card-meta">
          {app.rating.count > 0 && (
            <span className="app-card-stat app-card-rating">
              <Stars average={app.rating.average} count={app.rating.count} size={12} showCount={false} />
              {app.rating.average.toFixed(1)}
            </span>
          )}
          <span className="app-card-stat" title={`${app.runs} runs`}>
            <PlayGlyph />
            {formatCount(app.runs)}
          </span>
          {app.remixes > 0 && (
            <span className="app-card-stat" title={`${app.remixes} remixes`}>
              ⑂ {formatCount(app.remixes)}
            </span>
          )}
          {!app.capabilities.includes('net') && (
            <span
              className="app-card-stat app-card-safe"
              title="Makes no network requests of its own; a hosted service it declares, such as server storage, still reaches this site"
            >
              no net
            </span>
          )}
          {app.execution === 'worker' && (
            <span className="app-card-stat app-card-worker" title="Runs its script off the main thread">
              ⚡
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

export function AppGrid({ apps, categories, skeleton = 0, loading = false }: { apps: AppCardData[]; categories: Category[]; skeleton?: number; loading?: boolean }): React.ReactElement {
  const byId = new Map(categories.map((c) => [c.id, c]));
  return (
    <div className={`app-grid ${loading && apps.length > 0 ? 'app-grid-loading' : ''}`} aria-busy={loading}>
      {apps.map((app) => (
        <AppCard key={app.slug} app={app} category={byId.get(app.category)} />
      ))}
      {apps.length === 0 &&
        Array.from({ length: skeleton }, (_, i) => (
          <div key={`s${i}`} className="app-card app-card-skeleton" aria-hidden="true">
            <div className="thumb" />
            <div className="app-card-body">
              <span className="app-card-name">&nbsp;</span>
              <span className="app-card-author">&nbsp;</span>
              <p className="app-card-desc">&nbsp;</p>
            </div>
          </div>
        ))}
    </div>
  );
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

/** The mosaic's shape while the apps are on their way, so the page does not jump. */
export function FeaturedSkeleton(): React.ReactElement {
  return (
    <div className="featured-grid" aria-hidden="true">
      <div className="featured-card featured-lead featured-skeleton" />
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="featured-card featured-skeleton" />
      ))}
    </div>
  );
}

/**
 * The best of the directory, as a mosaic: one app large, with room to say
 * what it is and a Play button, and the next four small beside it. Every
 * tile is a picture first, because a picture is how a visitor tells a game
 * from a spreadsheet at a glance. Three apps make a smaller mosaic; fewer
 * than three is not a shelf, and nothing is drawn.
 */
export function Featured({ apps, categories, heading = 'Featured' }: { apps: AppCardData[]; categories: Category[]; heading?: React.ReactNode | null }): React.ReactElement | null {
  if (apps.length < 3) return null;
  const byId = new Map(categories.map((c) => [c.id, c]));
  const [lead, ...rest] = apps;
  const small = rest.slice(0, rest.length >= 4 ? 4 : 2);
  const leadCategory = byId.get(lead.category);
  return (
    <section className="featured" aria-labelledby={heading ? 'featured-title' : undefined} aria-label={heading ? undefined : 'Featured apps'}>
      {heading && (
        <div className="directory-section-head">
          <h2 id="featured-title" className="directory-section-title">
            {heading}
          </h2>
          <p className="directory-section-note">The most played and best rated, with pictures.</p>
        </div>
      )}
      <div className={`featured-grid ${small.length === 2 ? 'featured-grid-three' : ''}`}>
        <article className="featured-card featured-lead">
          <Thumb app={lead} />
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
              {lead.runs > 0 && <> · {formatCount(lead.runs)} runs</>}
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
          <article key={app.slug} className="featured-card">
            <Thumb app={app} />
            <div className="featured-shade" aria-hidden="true" />
            <PlayLink app={app} className="featured-play featured-play-small">
              <PlayGlyph size={14} />
              Play
            </PlayLink>
            <div className="featured-body">
              <a className="featured-link featured-name" href={app.urls.page}>
                {app.name}
              </a>
              <span className="featured-byline">
                {app.author}
                {app.runs > 0 && <> · {formatCount(app.runs)} runs</>}
              </span>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
