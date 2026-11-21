import React from 'react';
import { Reveal } from '../Reveal';
import {
  FORMAT_GUIDE_HREF,
  FORMLOGIC_GUIDE_HREF,
  HOSTING_GUIDE_HREF,
  HTML_GUIDE_HREF,
  PERMISSIONS_GUIDE_HREF,
  WEB_CONTAINERS_GUIDE_HREF,
} from '../../lib/guides';
import { ZIPP_URL } from '../../lib/appUrls';

/** What sets SoftN apart, in four points, two by two, each with the guide that backs it. */
export function WhyDifferent(): React.ReactElement {
  return (
    <Reveal as="section" className="band band-split band-why" id="why">
      <div className="wrap">
        <div className="band-head">
          <p className="eyebrow">What makes SoftN different</p>
          <h2 className="band-title">Full-stack apps you can read, run locally and host sandboxed.</h2>
        </div>
        <ul className="why-grid">
          <li className="why">
            <h3 className="why-name">One file for frontend &amp; backend</h3>
            <p className="why-copy">
              A <code>.softn</code> file holds standard HTML/CSS/TS pages, sandboxed backend code (PHP, JS/TS, Rust, or
              Python), SQLite schemas and assets as editable source. Download it, inspect every line, or remix it.{' '}
              <a href={FORMAT_GUIDE_HREF}>What is inside</a>
            </p>
          </li>
          <li className="why">
            <h3 className="why-name">Written the way you already know</h3>
            <p className="why-copy">
              Build standard v2 web containers (HTML, TypeScript, Preact, PHP/Slim 4, SQLite) or classic SoftN apps where
              pages read like HTML and logic is JavaScript or Python. Builder and Studio open each other’s work.{' '}
              <a href={HTML_GUIDE_HREF}>HTML and SoftN</a>
            </p>
          </li>
          <li className="why">
            <h3 className="why-name">Sandboxed frontend &amp; backend</h3>
            <p className="why-copy">
              All code runs through <a href={ZIPP_URL}>zipp</a>, an interpreter-only VM with no ambient filesystem,
              browser DOM, or network access. The network, camera, and storage stay off unless an app asks and you allow
              it. <a href={PERMISSIONS_GUIDE_HREF}>Permissions</a>
            </p>
          </li>
          <li className="why">
            <h3 className="why-name">Local in-browser or multi-user server</h3>
            <p className="why-copy">
              Run full-stack <a href={WEB_CONTAINERS_GUIDE_HREF}>web containers</a> privately in your browser with
              IndexedDB SQLite, or deploy the exact same bundle multi-user on{' '}
              <a href={HOSTING_GUIDE_HREF}>softn-server</a> (still ZIPP-sandboxed) or{' '}
              <a href={FORMLOGIC_GUIDE_HREF}>FormLogic</a>.
            </p>
          </li>
        </ul>
      </div>
    </Reveal>
  );
}
