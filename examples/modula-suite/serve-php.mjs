#!/usr/bin/env node
/**
 * Optional Standalone Native PHP Runner for Modula Apps.
 *
 * Launches native `php -S` processes on 127.0.0.1:8101..8107 using the EXACT SAME
 * `backend/index.php` + `shared/php/micro.php` + `backend/schema.sql` files packaged
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
  { slug: 'crm', port: 8101 },
  { slug: 'accounting', port: 8102 },
  { slug: 'inventory', port: 8103 },
  { slug: 'projects', port: 8104 },
  { slug: 'hr', port: 8105 },
  { slug: 'helpdesk', port: 8106 },
  { slug: 'website', port: 8107 },
  { slug: 'pos', port: 8108 },
  { slug: 'fieldservice', port: 8109 },
  { slug: 'workspace', port: 8110 },
  { slug: 'events', port: 8111 },
];

const microSrc = path.join(DIR, 'shared', 'php', 'micro.php');
const children = [];

for (const { slug, port } of APPS) {
  const appWork = path.join(WORK_DIR, slug);
  fs.mkdirSync(appWork, { recursive: true });
  fs.copyFileSync(microSrc, path.join(appWork, 'micro.php'));
  fs.copyFileSync(path.join(DIR, 'apps', slug, 'backend', 'index.php'), path.join(appWork, 'index.php'));
  fs.copyFileSync(path.join(DIR, 'apps', slug, 'backend', 'schema.sql'), path.join(appWork, 'schema.sql'));

  const dbPath = path.join(DATA_DIR, `${slug}.sqlite3`);
  const child = spawn('php', ['-S', `127.0.0.1:${port}`, path.join(appWork, 'index.php')], {
    cwd: appWork,
    env: { ...process.env, MODULA_STANDALONE_DB: dbPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => {
    const line = String(d).trim();
    if (line && !line.includes('Development Server')) {
      console.log(`[php:${slug}] ${line}`);
    }
  });
  children.push(child);
  console.log(`[modula-php] ${slug.padEnd(11)} -> http://127.0.0.1:${port} (SQLite: ${path.relative(DIR, dbPath)})`);
}

console.log('\nStandalone PHP servers running! Switch to "Standalone PHP Host" in the Modula Workspace topbar.');
console.log('Press Ctrl+C to stop all servers.');

const shutdown = () => {
  for (const c of children) {
    try { c.kill(); } catch {}
  }
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
