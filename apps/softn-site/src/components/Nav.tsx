import React from 'react';
import { BUILDER_HREF, REPO_URL, STUDIO_HREF, WEB_HREF } from '../lib/appUrls';
import { ThemeToggle } from './ThemeToggle';

export function Nav(): React.ReactElement {
  return (
    <nav className="nav">
      <div className="wrap nav-inner">
        <a className="nav-mark" href="/">
          <span className="nav-mark-dot" aria-hidden="true" />
          softn
        </a>
        <div className="nav-links">
          <a href="/apps">Apps</a>
          <a href="/publish">Publish</a>
          <a href={STUDIO_HREF}>Studio</a>
          <a href={BUILDER_HREF}>Builder</a>
          <a href={WEB_HREF}>Runtime</a>
        </div>
        <ThemeToggle />
        <a className="nav-repo" href={REPO_URL} target="_blank" rel="noreferrer">
          GitHub
        </a>
      </div>
    </nav>
  );
}
