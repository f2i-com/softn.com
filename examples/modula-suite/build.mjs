#!/usr/bin/env node
/**
 * Builds the entire Modula Odoo-Alternative Suite:
 * 1. Compiles all 11 React 18 apps (Vite production builds) and packs each with
 *    its PHP 8 backend (`backend/index.php` + `backend/micro.php`) and XDB SQLite 3
 *    schema (`backend/schema.sql`) into a portable `.softn` v2 container bundle.
 * 2. Compiles the React Competitor Website & Internal Parent Host (`parent-host/`).
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
    slug: 'crm',
    id: 'modula.crm',
    name: 'Modula CRM, Sales & Subscriptions',
    description: 'Lead scoring, Kanban pipeline, weighted forecasts, quotations & recurring MRR.',
    color: '#0d9488',
    abbr: 'CR',
  },
  {
    slug: 'accounting',
    id: 'modula.accounting',
    name: 'Modula Accounting & Invoicing',
    description: 'Double-entry GL, invoices, credit notes, bank reconciliation, P&L & Balance Sheet.',
    color: '#6d28d9',
    abbr: 'AC',
  },
  {
    slug: 'inventory',
    id: 'modula.inventory',
    name: 'Modula Inventory, Purchase & MRP',
    description: 'Warehouse stock moves, bin transfers, RFQs, Bills of Materials & manufacturing orders.',
    color: '#d97706',
    abbr: 'IN',
  },
  {
    slug: 'projects',
    id: 'modula.projects',
    name: 'Modula Projects & Timesheets',
    description: 'Task Kanban, subtask checklists, milestones, live timer & profitability analytics.',
    color: '#2563eb',
    abbr: 'PR',
  },
  {
    slug: 'hr',
    id: 'modula.hr',
    name: 'Modula HR, Attendance & Payroll',
    description: 'Employee directory, check-in kiosk, leave approvals, ATS hiring, appraisals & payroll.',
    color: '#db2777',
    abbr: 'HR',
  },
  {
    slug: 'helpdesk',
    id: 'modula.helpdesk',
    name: 'Modula Helpdesk & Knowledge',
    description: 'SLA ticket queue, canned macros, CSAT ratings, chatter & editable SOP wiki.',
    color: '#059669',
    abbr: 'HD',
  },
  {
    slug: 'website',
    id: 'modula.website',
    name: 'Modula Website, eCommerce & Marketing',
    description: 'Block page builder, storefront with promo codes, CMS blog, email campaigns & leads.',
    color: '#ea580c',
    abbr: 'WB',
  },
  {
    slug: 'pos',
    id: 'modula.pos',
    name: 'Modula Point of Sale & Rental',
    description: 'Retail/hospitality touch register, cash drawer Z-reports & equipment rental desk.',
    color: '#0284c7',
    abbr: 'PS',
  },
  {
    slug: 'fieldservice',
    id: 'modula.fieldservice',
    name: 'Modula Field Service & Planning',
    description: 'Technician dispatch board, customer sign-off billing, appointments & shift planning.',
    color: '#0891b2',
    abbr: 'FS',
  },
  {
    slug: 'workspace',
    id: 'modula.workspace',
    name: 'Modula Documents, eSign & Discuss',
    description: 'Document vault, SHA-256 eSignatures, multi-department approvals & team channels.',
    color: '#4f46e5',
    abbr: 'WS',
  },
  {
    slug: 'events',
    id: 'modula.events',
    name: 'Modula Events, Surveys & eLearning',
    description: 'Event ticketing & check-in, live NPS surveys & self-hosted eLearning academy.',
    color: '#9333ea',
    abbr: 'EV',
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
  const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), `modula-${app.slug}-`));
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
    const target = path.join(BUNDLES_OUT, `modula-${app.slug}.softn`);
    fs.writeFileSync(target, zipped);
    console.log(`[modula] Packed modula-${app.slug}.softn (${(zipped.byteLength / 1024).toFixed(1)} KB)`);
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
  console.log('[modula] Built parent-host/dist');
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
  console.log('[modula] Build complete!');
}

main().catch((err) => {
  console.error('[modula] Build failed:', err);
  process.exit(1);
});
