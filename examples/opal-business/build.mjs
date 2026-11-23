#!/usr/bin/env node
/**
 * Builds the Opal Business (Australian MYOB Alternative) SoftN Suite:
 * 1. Compiles all 8 React 18 apps (Vite production builds) and packs each with
 *    its PHP 8 backend (`backend/index.php` + `backend/opal_micro.php`) and XDB SQLite 3
 *    schema (`backend/schema.sql`) into a portable `.softn` v2 container bundle.
 * 2. Compiles the Internal Parent Application Host (`parent-host/`).
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
const SHARED_MICRO_PHP = path.join(HERE, 'shared', 'php', 'opal_micro.php');

const APPS = [
  {
    slug: 'sales',
    id: 'opal.sales',
    name: 'Opal Sales & Invoicing',
    description: 'AU Tax Invoices, Quotes, Sales Orders, Customer Returns, Recurring & Online Pay.',
    color: '#6100a5',
    abbr: 'SL',
  },
  {
    slug: 'purchases',
    id: 'opal.purchases',
    name: 'Opal Purchases, Bills & In Tray',
    description: 'OCR In Tray receipt capture, Supplier Bills, Purchase Orders, Debit Notes & Expenses.',
    color: '#be185d',
    abbr: 'PU',
  },
  {
    slug: 'banking',
    id: 'opal.banking',
    name: 'Opal Banking, Feeds & Reconciliation',
    description: 'Unlimited AU bank feeds, smart invoice matching, automated Bank Rules & reconciliation.',
    color: '#0d9488',
    abbr: 'BK',
  },
  {
    slug: 'accounting',
    id: 'opal.accounting',
    name: 'Opal Accounting, Journals & BAS',
    description: 'AU Chart of Accounts (1-xxxx–8-xxxx), Double-Entry Journals & AI-audited ATO BAS.',
    color: '#4338ca',
    abbr: 'GL',
  },
  {
    slug: 'payroll',
    id: 'opal.payroll',
    name: 'Opal Payroll, STP Phase 2 & Super',
    description: 'Unlimited AU payroll with Stage 3 PAYG, 12% SG Superannuation, STP2, Payslips & NES Leave.',
    color: '#059669',
    abbr: 'PR',
  },
  {
    slug: 'inventory',
    id: 'opal.inventory',
    name: 'Opal Inventory, Jobs & Time Billing',
    description: 'Multi-location stock, 3-tier pricing, stocktakes, sub-job budgeting & billable time slips.',
    color: '#d97706',
    abbr: 'IJ',
  },
  {
    slug: 'contacts',
    id: 'opal.contacts',
    name: 'Opal Contacts, ABN & TPAR',
    description: 'Customers, Suppliers, ATO TPAR Contractors, free Advisor seats & live Mod-89 ABN check.',
    color: '#2563eb',
    abbr: 'CT',
  },
  {
    slug: 'reporting',
    id: 'opal.reporting',
    name: 'Opal Financial Reports & Multi-Currency',
    description: 'Accrual/Cash P&L, Balance Sheet, Cash Flow, Trial Balance, Aged AR/AP & Multi-Currency FX.',
    color: '#4f46e5',
    abbr: 'RP',
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
  const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), `opal-${app.slug}-`));
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
    Object.assign(entries, collectFiles(tmpOut, 'public'));

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
    entries['backend/opal_micro.php'] = strToU8(microPhpText);
    entries['backend/schema.sql'] = new Uint8Array(fs.readFileSync(path.join(appRoot, 'backend', 'schema.sql')));
    entries['backend/index.php'] = new Uint8Array(fs.readFileSync(path.join(appRoot, 'backend', 'index.php')));

    const zipped = zipSync(entries, { level: 9, mtime: new Date(2026, 0, 1) });
    const target = path.join(BUNDLES_OUT, `opal-${app.slug}.softn`);
    fs.writeFileSync(target, zipped);
    console.log(`[opal] Packed opal-${app.slug}.softn (${(zipped.byteLength / 1024).toFixed(1)} KB)`);
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
  console.log('[opal] Built parent-host/dist');
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
  console.log('[opal] Opal Business Suite build complete!');
}

main().catch((err) => {
  console.error('[opal] Build failed:', err);
  process.exit(1);
});
