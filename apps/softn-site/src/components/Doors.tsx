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
    copy: 'Describe the app you want, review the blueprint it proposes, then edit what comes back. Bring your own model key — the generation runs against whichever provider you configure.',
    href: STUDIO_HREF,
    action: 'Open Studio',
    badge: 'Installable',
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
    copy: 'Drag components onto a canvas, draw the data schema, watch it render as you go, and export a .softn bundle. Monaco is right there for the parts you would rather type.',
    href: BUILDER_HREF,
    action: 'Open Builder',
    badge: 'Installable',
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
    copy: 'Drop a .softn file on it and the app runs — tabs, real URLs, per-app permission prompts, and everything cached so it opens again with the network off.',
    href: WEB_HREF,
    action: 'Open the runtime',
    badge: 'Installable',
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
          <span className="eyebrow">Three ways in</span>
          <h2 className="band-title">Nothing to install, unless you want to.</h2>
          <p className="band-sub">
            All three are ordinary web apps. Each one also installs to your dock or start menu and keeps working with
            the network off, because the engine, the components and your projects are already on the machine.
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
