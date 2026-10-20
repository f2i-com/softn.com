import React from 'react';
import { Reveal } from './Reveal';
import { Arrow } from './glyphs';
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
            <Arrow className={null} />
          </a>
        </div>
        <div className="learn-grid">
          {landing.cards.map((card, i) => (
            <a className="learn-card" key={card.href} href={card.href}>
              <span className="learn-n">{String(i + 1).padStart(2, '0')}</span>
              <span className="learn-title">{card.label}</span>
              <span className="learn-desc">{card.description}</span>
              <span className="learn-go" aria-hidden="true">
                Read the guide <Arrow className={null} />
              </span>
            </a>
          ))}
        </div>
      </div>
    </Reveal>
  );
}
