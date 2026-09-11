import React, { useEffect } from 'react';

/**
 * The page for a path the site does not have.
 *
 * Every path reaches this bundle — the deployed .htaccess answers index.html
 * for any browser navigation that is not a real file — and the app used to
 * show the home page for the ones it did not recognise, so a mistyped or
 * stale link looked like the front door with nothing said. This says what
 * happened and offers the three places a visitor could have meant. The
 * response is still a 200 from the server; a real 404 status is a
 * deployment change, not one this bundle can make.
 */
export function NotFoundPage({ path }: { path: string }): React.ReactElement {
  useEffect(() => {
    document.title = 'Page not found — SoftN';
  }, []);
  return (
    <main className="publish">
      <div className="wrap wrap-narrow">
        <div className="empty">
          <p className="eyebrow">Not found</p>
          <h1 className="page-title">There is no page at {path}.</h1>
          <p className="muted">The link may be old or mistyped. An app&rsquo;s page is at /app/ followed by its name; the directory lists them all.</p>
          <p className="app-actions">
            <a className="cta cta-primary" href="/apps">
              Browse the apps
            </a>
            <a className="cta" href="/">
              Home
            </a>
            <a className="cta" href="/publish">
              Publish an app
            </a>
          </p>
        </div>
      </div>
    </main>
  );
}
