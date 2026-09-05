import React from 'react';
import { Mark } from '@softn/brand';
import { BUILDER_HREF, REPO_URL, STUDIO_HREF, WEB_HREF, XDB_URL, ZIPP_URL } from '../lib/appUrls';

export function Footer(): React.ReactElement {
  return (
    <footer className="foot">
      <div className="wrap">
        <div className="foot-grid">
          <div>
            <a className="nav-mark" href="/">
              <Mark size={22} radius={6} />
              softn
            </a>
            <p className="foot-blurb">
              A directory of self-contained apps, a UI language, a component library, a sandboxed JavaScript engine and a
              local-first database. Write it yourself or have a model write it — either way it runs anywhere a browser does,
              and anyone can read it.
            </p>
          </div>

          {/* Wrapped so the three lists can be re-grouped under the brand on a
              phone. It is display: contents on a desktop, so the four blocks are
              still four peers in one row there. */}
          <div className="foot-cols">
            <div className="foot-col">
              <div className="foot-col-head">Directory</div>
              <a href="/apps">All apps</a>
              <a href="/apps?sort=newest">Newest</a>
              <a href="/apps?sort=remixed">Most remixed</a>
              <a href="/publish">Publish an app</a>
              <a href="/api">The API</a>
            </div>

            <div className="foot-col">
              <div className="foot-col-head">Tools</div>
              <a href={STUDIO_HREF}>Studio</a>
              <a href={BUILDER_HREF}>Builder</a>
              <a href={WEB_HREF}>Web runtime</a>
            </div>

            <div className="foot-col">
              <div className="foot-col-head">Source</div>
              <a href={REPO_URL} target="_blank" rel="noreferrer">
                softn.com
              </a>
              <a href={ZIPP_URL} target="_blank" rel="noreferrer">
                zipp.org
              </a>
              <a href={XDB_URL} target="_blank" rel="noreferrer">
                xdb.org
              </a>
              <a href="/#language">The language</a>
              <a href="/#components">Components</a>
            </div>
          </div>
        </div>

        <div className="foot-rule">
          <span>Apache License 2.0</span>
        </div>
      </div>
    </footer>
  );
}
