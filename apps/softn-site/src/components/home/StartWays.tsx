import React from 'react';
import { Reveal } from '../Reveal';
import { Arrow } from '../glyphs';
import { BUILDER_HREF, STUDIO_HREF } from '../../lib/appUrls';
import { FIELDNOTES_BUNDLE, FIELDNOTES_STARTER, fieldnotesInRuntime } from '../../lib/examples';
import { HTML_GUIDE_HREF } from '../../lib/guides';

/**
 * "Create an app": three ways in, each saying what it needs before anyone presses it. The working example comes
 * first and is the one recommended: it needs no account, no AI and no empty project, and opens on a running app.
 */
export function StartWays(): React.ReactElement {
  return (
    <Reveal as="section" className="band band-split band-start" id="create">
      <div className="wrap">
        <div className="band-head">
          <p className="eyebrow">Create an app</p>
          <h2 className="band-title">Three ways to start.</h2>
          <p className="band-sub">
            Whichever you choose, the app ends up the same: a <code>.softn</code> file that holds its pages, logic and
            assets, which you can run, change, download and publish.
          </p>
        </div>
        <div className="start-grid">
          <article className="start-card start-card-recommended" id="try-it">
            <p className="start-badge">Recommended · no account, no AI</p>
            <h3 className="start-name">Start with a working example</h3>
            <p className="start-copy">
              Fieldnotes, a small task app, opens already running. Change a label, a field or the logic behind the
              button visually or in code, see it in Preview, then download it or publish it.
            </p>
            <p className="start-needs"><span>You need</span> a browser.</p>
            <div className="start-actions">
              <a className="cta cta-primary" href={FIELDNOTES_STARTER}>
                Open the example
                <Arrow />
              </a>
              <a className="start-link" href={fieldnotesInRuntime('/#try-it')}>Try it first <span aria-hidden="true">↗</span></a>
              <a className="start-link" href={FIELDNOTES_BUNDLE} download="Fieldnotes.softn">Download the .softn app</a>
            </div>
          </article>
          <article className="start-card">
            <p className="start-badge">Needs an AI connection (or try built-in examples)</p>
            <h3 className="start-name">Describe a full-stack app to AI</h3>
            <p className="start-copy">
              Tell Studio what the app should do, in plain words. It plans and writes the app — choose JavaScript or
              Python, plus an optional sandboxed PHP or JS/TS + SQLite backend — and previews every edit live.
            </p>
            <p className="start-needs">
              <span>You need</span> a local model or your own API key (or open Studio’s built-in PHP + SQLite example with no key).
            </p>
            <div className="start-actions">
              <a className="cta" href={STUDIO_HREF}>
                Open Studio
                <Arrow />
              </a>
            </div>
          </article>
          <article className="start-card">
            <p className="start-badge">No account</p>
            <h3 className="start-name">Build or open any .softn container</h3>
            <p className="start-copy">
              Scaffold a new full-stack container (HTML/TS + PHP or JS/TS + SQLite) or open any <code>.softn</code>{' '}
              bundle — including Slim 4 and Rust apps — to edit frontend and backend files side-by-side and manage
              embedded SQLite tables, schemas and records in the built-in Data explorer.
            </p>
            <p className="start-needs">
              <span>You need</span> a browser. Bringing existing HTML or PHP?{' '}
              <a href={HTML_GUIDE_HREF}>See what carries across</a>.
            </p>
            <div className="start-actions">
              <a className="cta" href={BUILDER_HREF}>
                Open in Builder
                <Arrow />
              </a>
              <a className="start-link" href="/apps">Find an app to remix</a>
            </div>
          </article>
        </div>
      </div>
    </Reveal>
  );
}
