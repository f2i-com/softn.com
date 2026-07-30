import React from 'react';
import { REPO_URL } from '../lib/appUrls';
import { ThemeToggle } from './ThemeToggle';

export function Nav(): React.ReactElement {
  return (
    <nav className="nav">
      <div className="wrap nav-inner">
        <a className="nav-mark" href="#top">
          <span className="nav-mark-dot" aria-hidden="true" />
          softn
        </a>
        <div className="nav-links">
          <a href="#demos">Demos</a>
          <a href="#apps">Apps</a>
          <a href="#language">Language</a>
          <a href="#runtime">Runtime</a>
          <a href="#components">Components</a>
        </div>
        <ThemeToggle />
        <a className="nav-repo" href={REPO_URL} target="_blank" rel="noreferrer">
          GitHub
        </a>
      </div>
    </nav>
  );
}
