import React, { useState } from 'react';
import { Reveal } from '../Reveal';
import { Code } from '../../lib/highlight';
import { REPO_URL } from '../../lib/appUrls';
import { FORMAT_GUIDE_HREF, HOSTING_GUIDE_HREF, HTML_GUIDE_HREF, PUBLISHING_GUIDE_HREF } from '../../lib/guides';
// The same file the guides show and core's docs-examples test runs, so the sample here is one that works.
import helloName from '../../../../../docs/examples/hello-name.ui?raw';

const CONTAINER_SAMPLE = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="stylesheet" href="softn:ui.css" />
  </head>
  <body class="container stack gap-sm">
    <h1>Hello, <span id="who">friend</span>.</h1>
    <input id="name" placeholder="Your name" />
    <script type="module">
      import { db } from 'softn:db';
      const input = document.getElementById('name');
      const who = document.getElementById('who');
      input.addEventListener('input', () => {
        who.textContent = input.value.trim() || 'friend';
        db.create('visits', { name: who.textContent });
      });
    </script>
  </body>
</html>`;

const LINKS: Array<{ href: string; label: string; detail: string; external?: boolean }> = [
  { href: HTML_GUIDE_HREF, label: 'Web Containers & .ui', detail: 'Standard HTML5/DOM in a Worker sandbox, plus SoftN’s optional lightweight .ui language.' },
  { href: FORMAT_GUIDE_HREF, label: 'Inside a .softn file', detail: 'The manifest, HTML or .ui pages, ES modules / Python, and assets.' },
  { href: PUBLISHING_GUIDE_HREF, label: 'Publish with one request', detail: 'The directory’s API, for scripts and agents.' },
  { href: HOSTING_GUIDE_HREF, label: 'Choose a hosting option', detail: 'Compare static sites, PHP hosting with a private API, and FormLogic.' },
  { href: '/docs/', label: 'All the guides', detail: 'Examples and reference for building and running an app.' },
  { href: REPO_URL, label: 'Source on GitHub', detail: 'Apache License 2.0.', external: true },
];

/** For developers: standard Web App Containers first, with SoftN's optional .ui language alongside. */
export function ForDevelopers(): React.ReactElement {
  const [sample, setSample] = useState<'container' | 'ui'>('container');
  const showingContainer = sample === 'container';

  return (
    <Reveal as="section" className="band band-split band-dev" id="developers">
      <div className="wrap">
        <div className="band-head">
          <p className="eyebrow">For developers</p>
          <h2 className="band-title">Build with the web tools you know.</h2>
          <p className="band-sub">
            Package HTML, CSS and JavaScript together, or edit React JSX and Vue components in Studio or Builder.
            Runtime also opens production builds. SoftN selects the engine from the code in your bundle.
            You can also write TypeScript, Python, or use SoftN’s declarative <code>.ui</code> components.
          </p>
        </div>
        <div className="dev-grid">
          <div className="dev-code">
            <div className="panel-bar">
              <div role="group" aria-label="Code example format" style={{ display: 'inline-flex', gap: 6 }}>
                <button
                  type="button"
                  className={`tab ${showingContainer ? 'on' : ''}`}
                  aria-pressed={showingContainer}
                  onClick={() => setSample('container')}
                >
                  index.html
                </button>
                <button
                  type="button"
                  className={`tab ${!showingContainer ? 'on' : ''}`}
                  aria-pressed={!showingContainer}
                  onClick={() => setSample('ui')}
                >
                  hello.ui
                </button>
              </div>
              <span className="panel-bar-tag">{showingContainer ? 'web container' : 'optional .ui'}</span>
            </div>
            <Code
              source={showingContainer ? CONTAINER_SAMPLE : helloName.trimEnd()}
              className="lang-code"
              label={showingContainer ? 'index.html container source' : 'hello.ui source'}
              language="markup"
            />
          </div>
          <ul className="dev-links">
            {LINKS.map((link) => (
              <li key={link.href}>
                <a href={link.href} {...(link.external ? { target: '_blank', rel: 'noreferrer' } : {})}>
                  <span className="dev-link-label">{link.label}</span>
                  <span className="dev-link-detail">{link.detail}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Reveal>
  );
}
