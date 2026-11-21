import React, { useState } from 'react';
import { Reveal } from '../Reveal';
import { Code, type HighlightLanguage } from '../../lib/highlight';
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

const REACT_FRONTEND = `import { useEffect, useState } from 'react';

// Standard React talking directly to your sandboxed PHP / JS / Rust backend
export default function OrderDesk() {
  const [items, setItems] = useState([]);
  const [title, setTitle] = useState('');

  useEffect(() => {
    fetch('/api/items').then((r) => r.json()).then((d) => setItems(d.items));
  }, []);

  async function addItem(e) {
    e.preventDefault();
    const res = await fetch('/api/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    const { item } = await res.json();
    setItems((list) => [item, ...list]);
    setTitle('');
  }

  return (
    <form onSubmit={addItem}>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New order…" />
      <button type="submit">Add</button>
      <ul>{items.map((it) => <li key={it.id}>{it.title}</li>)}</ul>
    </form>
  );
}`;

const VUE_FRONTEND = `<script setup>
${'import'} { onMounted, ref } from 'vue';

// Standard Vue 3 SFC talking to the exact same sandboxed backend
const items = ref([]);
const title = ref('');

onMounted(async () => {
  const res = await fetch('/api/items');
  items.value = (await res.json()).items;
});

async function addItem() {
  const res = await fetch('/api/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: title.value }),
  });
  items.value.unshift((await res.json()).item);
  title.value = '';
}
</script>

<template>
  <form @submit.prevent="addItem">
    <input v-model="title" placeholder="New order…" />
    <button type="submit">Add</button>
    <ul><li v-for="it in items" :key="it.id">{{ it.title }}</li></ul>
  </form>
</template>`;

const VANILLA_FRONTEND = `<!-- Plain HTML + JS — zero build step, same /api/items backend -->
<form id="order-form">
  <input id="title" placeholder="New order…" required />
  <button type="submit">Add</button>
</form>
<ul id="list"></ul>

<script type="module">
  const list = document.querySelector('#list');
  const load = async () => {
    const { items } = await fetch('/api/items').then((r) => r.json());
    list.innerHTML = items.map((i) => \`<li>\${i.title}</li>\`).join('');
  };

  document.querySelector('#order-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.querySelector('#title');
    await fetch('/api/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: input.value }),
    });
    input.value = '';
    await load();
  });

  load();
</script>`;

const FULLSTACK_PHP = `<?php
declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');

// Runs locally inside ZIPP WASM (IndexedDB) or server-side in ZIPP safe-sandbox
$pdo = new PDO('sqlite:app.db');
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($method === 'POST') {
  $body = json_decode(file_get_contents('php://input') ?: '{}', true);
  $stmt = $pdo->prepare('INSERT INTO items (title, done) VALUES (?, 0)');
  $stmt->execute([trim((string) ($body['title'] ?? ''))]);
  $id = (int) $pdo->lastInsertId();
  echo json_encode(['item' => ['id' => $id, 'title' => $body['title'], 'done' => 0]]);
  return;
}

$rows = $pdo->query('SELECT id, title, done FROM items ORDER BY id DESC');
echo json_encode(['items' => $rows->fetchAll(PDO::FETCH_ASSOC)]);`;

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

const LINKS: Array<{ href: string; label: string; detail: string; external?: boolean }> = [
  {
    href: WEB_CONTAINERS_GUIDE_HREF,
    label: 'Full-Stack Web Containers',
    detail: 'Pair React, Vue, or HTML/JS frontends with sandboxed PHP, JS/TS, Rust, or Python backends & SQLite.',
  },
  {
    href: HOSTING_GUIDE_HREF,
    label: 'Multi-user ZIPP-sandboxed hosting',
    detail: 'Run the exact same .softn container multi-user on softn-server, softn-host-php, or FormLogic inside ZIPP.',
  },
  { href: FORMAT_GUIDE_HREF, label: 'Inside a .softn file', detail: 'The manifest, frontend, backend, SQLite seeds and permissions.' },
  { href: HTML_GUIDE_HREF, label: 'See HTML differences', detail: 'What carries across from an HTML, React, or Vue app — and what SoftN adds.' },
  { href: PUBLISHING_GUIDE_HREF, label: 'Publish with one request', detail: 'The directory’s API, for scripts and agents.' },
  { href: REPO_URL, label: 'Source on GitHub', detail: 'Apache License 2.0.', external: true },
];

type DevTab = 'react' | 'vue' | 'html' | 'php' | 'manifest' | 'ui';

const TABS: Array<{
  id: DevTab;
  file: string;
  group: 'frontend' | 'backend' | 'config' | 'optional';
  badge: string;
  language: HighlightLanguage;
  note: string;
  label: string;
  source: string;
}> = [
  {
    id: 'react',
    file: 'App.jsx',
    group: 'frontend',
    badge: 'React frontend',
    language: 'markup',
    note: 'Standard React component calling fetch("/api/items") — no .ui files required.',
    label: 'React frontend calling sandboxed /api/items',
    source: REACT_FRONTEND,
  },
  {
    id: 'vue',
    file: 'App.vue',
    group: 'frontend',
    badge: 'Vue 3 frontend',
    language: 'markup',
    note: 'Standard Vue 3 SFC calling the exact same /api/items backend.',
    label: 'Vue 3 frontend calling sandboxed /api/items',
    source: VUE_FRONTEND,
  },
  {
    id: 'html',
    file: 'index.html',
    group: 'frontend',
    badge: 'HTML + JS',
    language: 'markup',
    note: 'Plain HTML and JavaScript module — zero framework needed to talk to your backend.',
    label: 'Vanilla HTML and JavaScript calling sandboxed /api/items',
    source: VANILLA_FRONTEND,
  },
  {
    id: 'php',
    file: 'backend/index.php',
    group: 'backend',
    badge: 'PHP + SQLite',
    language: 'php',
    note: 'Runs locally in ZIPP WASM (IndexedDB) or multi-user in ZIPP safe-sandbox. Swap for JS/TS, Rust, or Python.',
    label: 'Sandboxed PHP + SQLite backend',
    source: FULLSTACK_PHP,
  },
  {
    id: 'manifest',
    file: 'manifest.json',
    group: 'config',
    badge: 'v2 container',
    language: 'json',
    note: 'Wires your frontend root, sandboxed backend runtime, and persisted SQLite database together.',
    label: 'v2 full-stack container manifest.json',
    source: FULLSTACK_MANIFEST,
  },
  {
    id: 'ui',
    file: 'hello.ui',
    group: 'optional',
    badge: 'Optional .ui',
    language: 'markup',
    note: 'Classic declarative .ui pages remain fully supported as an optional alternative to HTML/React/Vue.',
    label: 'Optional hello.ui source',
    source: helloName.trimEnd(),
  },
];

/** For developers: shows React, Vue, or plain HTML/JS frontends calling the same sandboxed backend + SQLite, plus optional .ui. */
export function ForDevelopers(): React.ReactElement {
  const [tab, setTab] = useState<DevTab>('react');
  const [copied, setCopied] = useState(false);
  const active = TABS.find((t) => t.id === tab) ?? TABS[0];

  const selectTab = (id: DevTab) => {
    setTab(id);
    setCopied(false);
  };

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
          <h2 className="band-title">Use React, Vue, or plain HTML/JS with a sandboxed backend.</h2>
          <p className="band-sub">
            You don’t need <code>.ui</code> files to build full-stack SoftN apps. Bring your own React, Vue, or plain
            HTML/JavaScript/TypeScript frontend and call <code>{'fetch("/api/...")'}</code> directly against a sandboxed
            PHP (Slim 4), JavaScript, TypeScript, Rust, or Python backend with SQLite — running locally in your browser
            via ZIPP WASM + IndexedDB, or hosted multi-user on <code>softn-server</code> or FormLogic inside ZIPP{' '}
            <code>safe-sandbox</code> with zero code changes.
          </p>
        </div>
        <div className="dev-grid">
          <div className="dev-code">
            <div className="dev-flow" aria-label="Full-stack container request flow">
              <button
                type="button"
                className={active.group === 'frontend' ? 'dev-flow-node is-active' : 'dev-flow-node'}
                onClick={() => selectTab(active.group === 'frontend' ? active.id : 'react')}
              >
                <span className="dev-flow-kicker">Your frontend</span>
                <strong>React · Vue · HTML/JS</strong>
              </button>
              <span className="dev-flow-arrow" aria-hidden="true">
                <code>{'fetch("/api/items")'}</code>
                <span>→</span>
              </span>
              <button
                type="button"
                className={active.group === 'backend' ? 'dev-flow-node dev-flow-node-mint is-active' : 'dev-flow-node dev-flow-node-mint'}
                onClick={() => selectTab('php')}
              >
                <span className="dev-flow-kicker">Sandboxed backend + SQLite</span>
                <strong>PHP · JS/TS · Rust · Python</strong>
              </button>
            </div>
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
                    className={
                      tab === item.id
                        ? `dev-tab is-active dev-tab-${item.group}`
                        : `dev-tab dev-tab-${item.group}`
                    }
                    onClick={() => selectTab(item.id)}
                  >
                    {item.file}
                  </button>
                ))}
              </div>
              <span className={active.group === 'backend' ? 'dev-code-badge dev-code-badge-mint' : 'dev-code-badge'}>
                {active.badge}
              </span>
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
