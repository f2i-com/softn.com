#!/usr/bin/env node
/**
 * Builds the entire BaseGrid Open Airtable Alternative Suite:
 * 1. Compiles all 6 React 18 apps (Vite production builds) and packs each with
 *    its PHP 8 backend (`backend/index.php` + `backend/micro.php`) and XDB SQLite 3
 *    schema (`backend/schema.sql`) into a portable `.softn` v2 container bundle.
 * 2. Compiles the React Showcase & Internal Parent Host (`parent-host/`).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { strToU8, zipSync } from 'fflate';
import { build } from 'vite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const BUNDLES_OUT = path.join(HERE, 'bundles');
const SHARED_MICRO_PHP = path.join(HERE, 'shared', 'php', 'micro.php');

const APPS = [
  {
    slug: 'bases',
    id: 'basegrid.bases',
    name: 'BaseGrid Bases & Views Studio',
    description: 'Relational bases, links, rollups, formulas & 7 views (Grid, Kanban, Calendar, Gallery, Timeline, List, Inbox).',
    color: '#6d28d9',
    abbr: 'BV',
  },
  {
    slug: 'interfaces',
    id: 'basegrid.interfaces',
    name: 'BaseGrid Interface Designer & Reporting',
    description: 'Role-specific executive dashboards, SVG charts, record pickers & cross-tab pivot tables.',
    color: '#2563eb',
    abbr: 'IF',
  },
  {
    slug: 'forms',
    id: 'basegrid.forms',
    name: 'BaseGrid Forms Builder & Intake Hub',
    description: 'Branded conditional logic forms feeding XDB SQLite directly with triage queues & CSV export.',
    color: '#db2777',
    abbr: 'FM',
  },
  {
    slug: 'automations',
    id: 'basegrid.automations',
    name: 'BaseGrid Automations & Workflow Engine',
    description: 'No-code trigger-action workflows with live PHP execution, run traces & zero monthly run caps.',
    color: '#ea580c',
    abbr: 'AU',
  },
  {
    slug: 'ai-omni',
    id: 'basegrid.ai-omni',
    name: 'BaseGrid Omni AI Builder & Field Agents',
    description: 'Conversational app architect, column AI Field Agents, AI Plays & MCP tool console.',
    color: '#0284c7',
    abbr: 'AI',
  },
  {
    slug: 'portals-sync',
    id: 'basegrid.portals-sync',
    name: 'BaseGrid Portals, Sync & Governance',
    description: 'White-label external guest portals, two-way HyperDB sync connectors & RBAC audit logs.',
    color: '#0d9488',
    abbr: 'PS',
  },
];

const HTACCESS = `Options -Indexes
<FilesMatch "\\.(env|sql|db|sqlite|sqlite3|lock)$">
  Deny from all
</FilesMatch>
RewriteEngine On
RewriteRule ^api(/.*)?$ backend/index.php [L,QSA]
`;

function makeIconSvg(color, abbr) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="${color}"/>
  <text x="32" y="39" text-anchor="middle" fill="#ffffff" font-family="system-ui, sans-serif" font-size="22" font-weight="800">${abbr}</text>
</svg>
`;
}

function collectFiles(dir, prefix = '') {
  const out = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      Object.assign(out, collectFiles(full, rel));
    } else {
      out[rel] = new Uint8Array(fs.readFileSync(full));
    }
  }
  return out;
}

async function buildChildApp(app, microPhpText) {
  const appRoot = path.join(HERE, 'apps', app.slug);
  const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), `basegrid-${app.slug}-`));
  try {
    process.env.NODE_ENV = 'production';
    await build({
      root: appRoot,
      base: '/',
      configFile: false,
      logLevel: 'error',
      clearScreen: false,
      plugins: [react()],
      build: {
        outDir: tmpOut,
        emptyOutDir: true,
        sourcemap: false,
      },
    });

    const entries = {};
    const frontendFiles = collectFiles(tmpOut, 'public');
    Object.assign(entries, frontendFiles);

    const manifest = {
      id: app.id,
      name: app.name,
      version: '1.0.0',
      description: app.description,
      icon: 'assets/icon.svg',
      engine: 2,
      main: 'public/index.html',
      frontendRoot: 'public',
      backend: {
        runtime: 'php',
        entry: 'backend/index.php',
        mode: 'api',
        routes: ['/api/'],
      },
      databases: [
        {
          name: 'app',
          engine: 'sqlite',
          file: 'data/app.db',
          seedSql: 'backend/schema.sql',
          persist: true,
        },
      ],
    };

    entries['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2) + '\n');
    entries['permission.json'] = strToU8(JSON.stringify({ permissions: {} }, null, 2) + '\n');
    entries['.htaccess'] = strToU8(HTACCESS);
    entries['assets/icon.svg'] = strToU8(makeIconSvg(app.color, app.abbr));
    entries['backend/micro.php'] = strToU8(microPhpText);
    entries['backend/schema.sql'] = new Uint8Array(fs.readFileSync(path.join(appRoot, 'backend', 'schema.sql')));
    entries['backend/index.php'] = new Uint8Array(fs.readFileSync(path.join(appRoot, 'backend', 'index.php')));

    const zipped = zipSync(entries, { level: 9, mtime: new Date(2026, 0, 1) });
    const target = path.join(BUNDLES_OUT, `basegrid-${app.slug}.softn`);
    fs.writeFileSync(target, zipped);
    console.log(`[basegrid] Packed basegrid-${app.slug}.softn (${(zipped.byteLength / 1024).toFixed(1)} KB)`);
  } finally {
    fs.rmSync(tmpOut, { recursive: true, force: true });
  }
}

async function buildParentHost() {
  const hostRoot = path.join(HERE, 'parent-host');
  const distOut = path.join(hostRoot, 'dist');
  process.env.NODE_ENV = 'production';
  await build({
    root: hostRoot,
    base: '/',
    configFile: false,
    logLevel: 'error',
    clearScreen: false,
    plugins: [react()],
    resolve: {
      alias: {
        '@softn/container': path.join(REPO_ROOT, 'packages', '@softn', 'container', 'dist', 'index.js'),
      },
    },
    build: {
      outDir: distOut,
      emptyOutDir: true,
      sourcemap: false,
    },
  });
  console.log('[basegrid] Built parent-host/dist');
}

async function main() {
  fs.mkdirSync(BUNDLES_OUT, { recursive: true });
  const microPhpText = fs.readFileSync(SHARED_MICRO_PHP, 'utf8').replace(/\r\n/g, '\n');

  const onlyHost = process.argv.includes('--host-only');
  if (!onlyHost) {
    for (const app of APPS) {
      await buildChildApp(app, microPhpText);
    }
  }
  await buildParentHost();
  console.log('[basegrid] Build complete!');
}

main().catch((err) => {
  console.error('[basegrid] Build failed:', err);
  process.exit(1);
});
