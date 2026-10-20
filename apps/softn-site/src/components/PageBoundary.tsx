import React from 'react';

/**
 * A page that cannot be shown says so, and the rest of the site stays. An
 * app's page and the publish page are fetched the first time they are
 * visited; a dropped connection, or a new deployment that has replaced their
 * files, fails that fetch, and React then took the whole site down with it,
 * navigation and all.
 */
export class PageBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="publish">
        <div className="wrap wrap-narrow">
          <div className="empty" role="alert">
            <p className="eyebrow">Not loaded</p>
            <h1 className="page-title">This page did not load.</h1>
            <p className="muted">The connection may have dropped, or the site was updated while it was open. Reloading fetches it again.</p>
            <p className="app-actions">
              <button type="button" className="cta cta-primary" onClick={() => window.location.reload()}>
                Reload
              </button>
              <a className="cta" href="/">
                Home
              </a>
            </p>
          </div>
        </div>
      </main>
    );
  }
}
