import React from 'react';
import { Player } from './Player';
import { BUILDER_HREF, STUDIO_HREF, WEB_HREF } from '../lib/appUrls';

function Arrow(): React.ReactElement {
  return (
    <svg className="cta-arrow" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M3 7h8M7.5 3.5 11 7l-3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Hero(): React.ReactElement {
  return (
    <header className="hero" id="top">
      <div className="wrap hero-inner">
        <p className="eyebrow rise" style={{ animationDelay: '40ms' }}>
          A UI language and its runtime
        </p>

        <h1 className="hero-title rise" style={{ animationDelay: '100ms' }}>
          Write the interface. <em>It&rsquo;s already running.</em>
        </h1>

        <p className="hero-lede rise" style={{ animationDelay: '180ms' }}>
          SoftN reads a <code>.ui</code> file and puts a working application on screen. Behind it: 90 components, a
          sandboxed JavaScript engine compiled to WebAssembly, and a local-first database that syncs peer to peer.{' '}
          <strong>What&rsquo;s below isn&rsquo;t a screenshot</strong> — the right panel is the runtime, executing the
          file on the left.
        </p>

        <div className="hero-cta rise" style={{ animationDelay: '250ms' }}>
          <a className="cta cta-primary" href={STUDIO_HREF}>
            Open Studio
            <Arrow />
          </a>
          <a className="cta" href={BUILDER_HREF}>
            Open Builder
            <Arrow />
          </a>
          <a className="cta" href={WEB_HREF}>
            Open the runtime
            <Arrow />
          </a>
        </div>

        <div className="rise" style={{ animationDelay: '330ms' }}>
          <Player />
        </div>
      </div>
    </header>
  );
}
