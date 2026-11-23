#!/usr/bin/env node
/**
 * Optional Standalone Native PHP 8 Runner for Opal Business Apps.
 *
 * Launches native `php -S` processes on 127.0.0.1:8201..8208 using the EXACT SAME
 * `backend/index.php` + `shared/php/opal_micro.php` + `backend/schema.sql` files packaged
 * inside each `.softn` container — proving zero code changes between in-browser
 * ZIPP WASM (`zipp-php.wasm` + XDB SQLite) and standalone PHP hosting!
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(DIR, '.standalone-data');
const WORK_DIR = path.join(DATA_DIR, 'runtime-php');
fs.mkdirSync(WORK_DIR, { recursive: true });

const APPS = [
  { slug: 'sales', port: 8201 },
  { slug: 'purchases', port: 8202 },
  { slug: 'banking', port: 8203 },
  { slug: 'accounting', port: 8204 },
  { slug: 'payroll', port: 8205 },
  { slug: 'inventory', port: 8206 },
  { slug: 'contacts', port: 8207 },
  { slug: 'reporting', port: 8208 },
];

const microSrc = path.join(DIR, 'shared', 'php', 'opal_micro.php');
const children = [];

for (const { slug, port } of APPS) {
  const appWork = path.join(WORK_DIR, slug);
  fs.mkdirSync(appWork, { recursive: true });
  fs.copyFileSync(microSrc, path.join(appWork, 'opal_micro.php'));
  fs.copyFileSync(path.join(DIR, 'apps', slug, 'backend', 'index.php'), path.join(appWork, 'index.php'));
  fs.copyFileSync(path.join(DIR, 'apps', slug, 'backend', 'schema.sql'), path.join(appWork, 'schema.sql'));

  const dbPath = path.join(DATA_DIR, `${slug}.sqlite3`);
  const child = spawn('php', ['-S', `127.0.0.1:${port}`, path.join(appWork, 'index.php')], {
    cwd: appWork,
    env: { ...process.env, OPAL_STANDALONE_DB: dbPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => {
    const line = String(d).trim();
    if (line && !line.includes('Development Server')) {
      console.log(`[php:${slug}] ${line}`);
    }
  });
  children.push(child);
  console.log(`[opal-php] ${slug.padEnd(11)} -> http://127.0.0.1:${port} (SQLite: ${path.relative(DIR, dbPath)})`);
}

console.log('\nStandalone PHP 8 servers online! Switch to "Standalone PHP" in the Opal Business Workspace topbar.');
console.log('Press Ctrl+C to stop all servers.');

const shutdown = () => {
  for (const c of children) {
    try { c.kill(); } catch {}
  }
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
