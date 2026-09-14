import React from 'react';
import { Reveal } from './Reveal';
import landing from '../../../../docs/generated/landing.json';

/**
 * The documentation, on the front door. The cards come from the generated
 * `docs/generated/landing.json`, a few kilobytes derived from the same JSON
 * the guides are built from (docs/content/softn-docs.json), so the section
 * never drifts from the pages and the site bundle never carries the
 * articles. The links are ordinary anchors: the guides are static pages
 * beside the site, not routes of this app, and the router leaves them alone.
 */
export function LearnDocs(): React.ReactElement {
  return (
    <Reveal as="section" className="band band-learn" id="docs">
      <div className="wrap">
        <div className="band-head band-head-row">
          <div>
            <p className="eyebrow">{landing.eyebrow}</p>
            <h2 className="band-title">{landing.title}</h2>
            <p className="band-sub">{landing.description}</p>
          </div>
          <a className="cta" href={landing.cta.href}>
            {landing.cta.label}
            <Arrow />
          </a>
        </div>
        <div className="learn-grid">
          {landing.cards.map((card, i) => (
            <a className="learn-card" key={card.href} href={card.href}>
              <span className="learn-n">{String(i + 1).padStart(2, '0')}</span>
              <span className="learn-title">{card.label}</span>
              <span className="learn-desc">{card.description}</span>
              <span className="learn-go" aria-hidden="true">
                Read the guide <Arrow />
              </span>
            </a>
          ))}
        </div>
      </div>
    </Reveal>
  );
}

function Arrow(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 8h9M8.5 3.5 13 8l-4.5 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
