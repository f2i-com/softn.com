import React, { useState } from 'react';
import { Reveal } from '../Reveal';
import { Code } from '../../lib/highlight';
import { REPO_URL } from '../../lib/appUrls';
import {
  FORMAT_GUIDE_HREF,
  HOSTING_GUIDE_HREF,
  HTML_GUIDE_HREF,
  PUBLISHING_GUIDE_HREF,
  WEB_CONTAINERS_GUIDE_HREF,
} from '../../lib/guides';
// The same file the guides show and core's docs-examples test runs, so the sample here is one that works.
import helloName from '../../../../../docs/examples/hello-name.ui?raw';

const FULLSTACK_MANIFEST = `{
  "engine": 2,
  "name": "Order Desk",
  "main": "public/index.html",
  "frontendRoot": "public",
  "backend": {
    "runtime": "php",
    "entry": "backend/index.php",
    "mode": "api",
    "routes": ["/api/"]
  },
  "databases": [{
    "name": "app",
    "engine": "sqlite",
    "file": "app.db",
    "seedSql": "backend/schema.sql",
    "persist": true
  }]
}`;

const FULLSTACK_PHP = `<?php
declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');

$pdo = new PDO('sqlite:app.db');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'GET') {
  $stmt = $pdo->query(
    'SELECT id, title, done FROM items ORDER BY id DESC'
  );
  echo json_encode(['items' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
}`;

const LINKS: Array<{ href: string; label: string; detail: string; external?: boolean }> = [
  {
    href: WEB_CONTAINERS_GUIDE_HREF,
    label: 'Full-Stack Web Containers',
    detail: 'Bundle HTML/React/Vue/TS frontends with sandboxed PHP, JS/TS, Rust or Python backends & SQLite.',
  },
  {
    href: HOSTING_GUIDE_HREF,
    label: 'Multi-user ZIPP-sandboxed hosting',
    detail: 'Run the exact same .softn container multi-user on softn-server, softn-host-php, or FormLogic inside ZIPP.',
  },
  { href: FORMAT_GUIDE_HREF, label: 'Inside a .softn file', detail: 'The manifest, frontend, backend, SQLite seeds and permissions.' },
  { href: HTML_GUIDE_HREF, label: 'See HTML differences', detail: 'What carries across from an HTML page, and what SoftN adds.' },
  { href: PUBLISHING_GUIDE_HREF, label: 'Publish with one request', detail: 'The directory’s API, for scripts and agents.' },
  { href: REPO_URL, label: 'Source on GitHub', detail: 'Apache License 2.0.', external: true },
];

type DevTab = 'manifest' | 'php' | 'ui';

const TABS: Array<{
  id: DevTab;
  file: string;
  badge: string;
  language: 'json' | 'php' | 'markup';
  note: string;
  label: string;
  source: string;
}> = [
  {
    id: 'manifest',
    file: 'manifest.json',
    badge: 'v2 container',
    language: 'json',
    note: 'Declares frontend root, sandboxed backend runtime, and persisted SQLite database.',
    label: 'v2 full-stack container manifest.json',
    source: FULLSTACK_MANIFEST,
  },
  {
    id: 'php',
    file: 'backend/index.php',
    badge: 'PHP + SQLite',
    language: 'php',
    note: 'Executes in ZIPP WASM locally in-browser, or in ZIPP safe-sandbox on softn-server.',
    label: 'Sandboxed PHP + SQLite backend',
    source: FULLSTACK_PHP,
  },
  {
    id: 'ui',
    file: 'hello.ui',
    badge: 'SoftN markup',
    language: 'markup',
    note: 'Classic declarative .ui pages remain fully supported alongside v2 Web Containers.',
    label: 'hello.ui source',
    source: helloName.trimEnd(),
  },
];

/** For developers: a full-stack v2 container example (manifest + sandboxed PHP backend) alongside classic SoftN markup. */
export function ForDevelopers(): React.ReactElement {
  const [tab, setTab] = useState<DevTab>('manifest');
  const [copied, setCopied] = useState(false);
  const active = TABS.find((t) => t.id === tab) ?? TABS[0];

  const copyCode = () => {
    navigator.clipboard?.writeText(active.source).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      },
      () => {}
    );
  };

  return (
    <Reveal as="section" className="band band-dev" id="developers">
      <div className="wrap">
        <div className="band-head band-dev-head">
          <p className="eyebrow">For developers</p>
          <h2 className="band-title">Standard web frontends + sandboxed backends in one .softn bundle.</h2>
          <p className="band-sub">
            Ship HTML5, CSS, TypeScript, Preact, React, Vue or Three.js alongside a real sandboxed backend (PHP/Slim 4,
            JS/TS, Rust, or Python) and SQLite database — running locally in your browser via ZIPP WASM + IndexedDB, or
            hosted multi-user on <code>softn-server</code> or FormLogic inside ZIPP <code>safe-sandbox</code> with zero code changes.
          </p>
        </div>
        <div className="dev-grid">
          <div className="dev-code">
            <div className="dev-code-bar">
              <div className="dev-tabs" role="tablist" aria-label="Code examples">
                {TABS.map((item) => (
                  <button
                    key={item.id}
                    id={`dev-tab-${item.id}`}
                    type="button"
                    role="tab"
                    aria-selected={tab === item.id}
                    aria-controls="dev-tab-panel"
                    className={tab === item.id ? 'dev-tab is-active' : 'dev-tab'}
                    onClick={() => {
                      setTab(item.id);
                      setCopied(false);
                    }}
                  >
                    {item.file}
                  </button>
                ))}
              </div>
              <span className="dev-code-badge">{active.badge}</span>
            </div>
            <div id="dev-tab-panel" role="tabpanel" aria-labelledby={`dev-tab-${active.id}`} className="dev-code-panel">
              <Code source={active.source} className="lang-code" label={active.label} language={active.language} />
            </div>
            <div className="dev-code-foot">
              <span className="dev-code-note">{active.note}</span>
              <button type="button" className="dev-copy-btn" onClick={copyCode}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
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
