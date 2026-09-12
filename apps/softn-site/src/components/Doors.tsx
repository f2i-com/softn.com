import React from 'react';
import { Reveal } from './Reveal';
import { BUILDER_HREF, STUDIO_HREF, WEB_HREF } from '../lib/appUrls';

interface Door {
  name: string;
  copy: string;
  href: string;
  action: string;
  badge: string;
  glyph: React.ReactElement;
}

const stroke = {
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  fill: 'none',
};

const DOORS: Door[] = [
  {
    name: 'Studio',
    copy: 'Describe your idea, review a plan and let your chosen AI write the app. Inspect the files, preview each change and undo edits as you go.',
    href: STUDIO_HREF,
    action: 'Open Studio',
    badge: 'Your AI',
    glyph: (
      <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
        <circle cx="5" cy="6" r="2.6" {...stroke} />
        <circle cx="21" cy="6" r="2.6" {...stroke} />
        <circle cx="13" cy="20" r="2.6" {...stroke} />
        <path d="M6.6 8.1 11.7 17.6M19.4 8.1 14.3 17.6M7.6 6h10.8" {...stroke} />
      </svg>
    ),
  },
  {
    name: 'Builder',
    copy: 'Arrange components, shape your data collections and test the result at different screen sizes. Switch to code when you want finer control.',
    href: BUILDER_HREF,
    action: 'Open Builder',
    badge: 'Visual + code',
    glyph: (
      <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
        <rect x="3.5" y="4.5" width="19" height="14" rx="2" {...stroke} />
        <path d="M3.5 9.5h19M9 9.5v9" {...stroke} />
        <circle cx="22.5" cy="18.5" r="2.4" {...stroke} />
        <circle cx="3.5" cy="18.5" r="2.4" {...stroke} />
      </svg>
    ),
  },
  {
    name: 'Web runtime',
    copy: 'Open a .softn file, review its permissions and start using it. Keep apps in your library, export their saved data and see which are ready to open offline.',
    href: WEB_HREF,
    action: 'Open the runtime',
    badge: 'Your library',
    glyph: (
      <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
        <rect x="3" y="4.5" width="20" height="17" rx="2.4" {...stroke} />
        <path d="M3 9h20" {...stroke} />
        <path d="M11 12.6v5l4.4-2.5z" {...stroke} />
      </svg>
    ),
  },
];

function Arrow(): React.ReactElement {
  return (
    <svg className="cta-arrow" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M3 7h8M7.5 3.5 11 7l-3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Doors(): React.ReactElement {
  return (
    <Reveal as="section" className="band" id="apps">
      <div className="wrap">
        <div className="band-head">
          <span className="eyebrow">A connected workspace</span>
          <h2 className="band-title">Create, refine, run.</h2>
          <p className="band-sub">
            Start in Studio, refine in Builder and open in the runtime. Your <code>.softn</code> bundle carries the
            project’s interface, logic and assets between them. All three open directly in your browser.
          </p>
        </div>

        <div className="doors">
          {DOORS.map((d) => (
            <article className="door" key={d.name}>
              <span className="door-glyph">{d.glyph}</span>
              <h3 className="door-name">{d.name}</h3>
              <p className="door-copy">{d.copy}</p>
              <div className="door-foot">
                <a className="door-open" href={d.href}>
                  {d.action}
                  <Arrow />
                </a>
                <span className="door-badge">{d.badge}</span>
              </div>
            </article>
          ))}
        </div>
      </div>
    </Reveal>
  );
}
