import React from 'react';
import type { AppCard as AppCardData, Category } from '../../lib/api';
import { formatCount } from '../../lib/format';
import { Stars } from './Stars';

/** The app's picture: a real screenshot fills the frame, an icon sits on the app's colour. */
export function Thumb({ app, className = '' }: { app: AppCardData; className?: string }): React.ReactElement {
  const tint = app.primary ?? '#2a3040';
  if (app.thumbnailKind === 'image') {
    return (
      <div className={`thumb thumb-image ${className}`}>
        <img src={app.thumbnail} alt="" loading="lazy" decoding="async" />
      </div>
    );
  }
  return (
    <div className={`thumb thumb-icon ${className}`} style={{ background: `linear-gradient(135deg, ${tint}, color-mix(in srgb, ${tint} 55%, #000))` }}>
      <img src={app.thumbnail} alt="" loading="lazy" decoding="async" />
    </div>
  );
}

function PlayGlyph(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

/**
 * One app, as a card. The whole card is the link to the page; the picture
 * carries a "play" affordance on hover because the page's first act is to
 * run the app, and the meta row says what a visitor decides on: how it is
 * rated, how much it is played, whether it has been remixed.
 */
export function AppCard({ app, category, featured = false }: { app: AppCardData; category?: Category; featured?: boolean }): React.ReactElement {
  const official = app.source === 'seed';
  return (
    <a className={`app-card ${featured ? 'app-card-featured' : ''}`} href={app.urls.page} aria-label={`${app.name} by ${app.author}`}>
      <div className="app-card-media">
        <Thumb app={app} />
        <span className="app-card-play" aria-hidden="true">
          <PlayGlyph />
          Play
        </span>
        {category && (
          <span className="app-card-cat" title={category.name}>
            {category.emoji} {category.name}
          </span>
        )}
      </div>
      <div className="app-card-body">
        <div className="app-card-head">
          <span className="app-card-name">{app.name}</span>
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
          <span className="app-card-stat app-card-rating">
            <Stars average={app.rating.average} count={app.rating.count} size={12} showCount={false} />
            {app.rating.count > 0 ? app.rating.average.toFixed(1) : ''}
          </span>
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
            <span className="app-card-stat app-card-safe" title="Declares no network access">
              offline
            </span>
          )}
          {app.execution === 'worker' && (
            <span className="app-card-stat app-card-worker" title="Runs its script off the main thread">
              ⚡
            </span>
          )}
        </div>
      </div>
    </a>
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
 * One app, large: the picture across the top of the directory, with what a
 * visitor needs to decide to press play. The directory shows its best.
 */
export function Spotlight({ app, category, label = 'Spotlight' }: { app: AppCardData; category?: Category; label?: string }): React.ReactElement {
  return (
    <section className="spotlight" aria-label={`${label}: ${app.name}`}>
      <a className="spotlight-media" href={app.urls.page} aria-label={`Open ${app.name}`}>
        <Thumb app={app} />
      </a>
      <div className="spotlight-body">
        <p className="eyebrow">{label}</p>
        <h2 className="spotlight-title">{app.name}</h2>
        <p className="spotlight-byline">
          by <a href={`/apps?author=${encodeURIComponent(app.author)}`}>{app.author}</a>
          {category && (
            <>
              {' · '}
              <a href={`/apps?category=${encodeURIComponent(category.id)}`}>
                {category.emoji} {category.name}
              </a>
            </>
          )}
        </p>
        <p className="spotlight-desc">{app.description}</p>
        <div className="spotlight-meta">
          <Stars average={app.rating.average} count={app.rating.count} size={14} />
          <span className="app-card-stat">
            <PlayGlyph /> {formatCount(app.runs)} runs
          </span>
          {app.tags.slice(0, 4).map((t) => (
            <a key={t} className="tag" href={`/apps?tag=${encodeURIComponent(t)}`}>
              #{t}
            </a>
          ))}
        </div>
        <div className="app-actions">
          <a className="cta cta-primary" href={`${app.urls.page}?play=1`}>
            <PlayGlyph /> Play now
          </a>
          <a className="cta" href={app.urls.page}>
            About it
          </a>
        </div>
      </div>
    </section>
  );
}
