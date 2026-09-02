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

export function AppCard({ app, category }: { app: AppCardData; category?: Category }): React.ReactElement {
  return (
    <a className="app-card" href={app.urls.page} aria-label={`${app.name} by ${app.author}`}>
      <Thumb app={app} />
      <div className="app-card-body">
        <div className="app-card-head">
          <span className="app-card-name">{app.name}</span>
          {category && (
            <span className="app-card-cat" title={category.name}>
              {category.emoji}
            </span>
          )}
        </div>
        <span className="app-card-author">
          {app.author}
          {app.parent && <span className="app-card-remix"> · remix of {app.parent.name}</span>}
        </span>
        <p className="app-card-desc">{app.description || 'No description yet.'}</p>
        <div className="app-card-meta">
          <Stars average={app.rating.average} count={app.rating.count} size={12} showCount={false} />
          <span className="app-card-stat" title={`${app.rating.count} ratings`}>
            {app.rating.count > 0 ? app.rating.average.toFixed(1) : '–'}
          </span>
          <span className="app-card-stat" title="Runs">
            ▶ {formatCount(app.runs)}
          </span>
          <span className="app-card-stat" title="Remixes">
            ⑂ {formatCount(app.remixes)}
          </span>
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

export function AppGrid({ apps, categories, skeleton = 0 }: { apps: AppCardData[]; categories: Category[]; skeleton?: number }): React.ReactElement {
  const byId = new Map(categories.map((c) => [c.id, c]));
  return (
    <div className="app-grid">
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
