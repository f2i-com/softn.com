import React from 'react';
import { BUILDER_HREF, REPO_URL, STUDIO_HREF, WEB_HREF, XDB_URL, ZIPP_URL } from '../lib/appUrls';

export function Footer(): React.ReactElement {
  return (
    <footer className="foot">
      <div className="wrap">
        <div className="foot-grid">
          <div>
            <a className="nav-mark" href="#top">
              <span className="nav-mark-dot" aria-hidden="true" />
              softn
            </a>
            <p className="foot-blurb">
              A UI language, a component library, a sandboxed JavaScript engine and a local-first database. Write it
              yourself or have a model write it — either way it runs anywhere a browser does.
            </p>
          </div>

          {/* Wrapped so the three lists can be re-grouped under the brand on a
              phone. It is display: contents on a desktop, so the four blocks are
              still four peers in one row there. */}
          <div className="foot-cols">
            <div className="foot-col">
              <div className="foot-col-head">Apps</div>
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
            </div>

            <div className="foot-col">
              <div className="foot-col-head">On this page</div>
              {/* The nav bar's five section anchors, all of them. Demos used to
                  sit under "Apps" and #apps was in neither column, so the footer
                  could not reach every section it claims to list. */}
              <a href="#demos">Demos</a>
              <a href="#apps">Apps</a>
              <a href="#language">Language</a>
              <a href="#runtime">Runtime</a>
              <a href="#components">Components</a>
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
