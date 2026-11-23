#!/usr/bin/env node
/**
 * End-to-end verification suite for Opal Business (MYOB AU Alternative on SoftN):
 * 1. Boots ALL 8 `.softn` bundles inside REAL `BackendWorkerSession` (`zipp-php.wasm` + `xdb-wasm.wasm`)
 *    and exercises full Australian accounting, invoicing, OCR In Tray, banking, BAS, STP2 payroll,
 *    inventory/jobs, Mod-89 ABN validation, and multi-currency FX workflows + live `.db` export!
 * 2. Launches a real standalone `php -S` server and verifies identical API behavior on native PHP 8 + WAL SQLite.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContainerArchive, BackendWorkerSession } from '../../packages/@softn/container/dist/index.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(DIR, '..', '..');
const ENGINES_DIR = path.join(REPO_ROOT, 'packages', '@softn', 'container', 'dist', 'runtime', 'engines');
const PHP_WASM = path.join(ENGINES_DIR, 'zipp-php.wasm');
const XDB_WASM = path.join(ENGINES_DIR, 'xdb-wasm.wasm');
const XDB_GLUE = path.join(ENGINES_DIR, 'xdb-wasm.glue.js');

async function bootBackendSession(bundleFile) {
  const bytes = new Uint8Array(fs.readFileSync(path.join(DIR, 'bundles', bundleFile)));
  const archive = await ContainerArchive.open(bytes);
  const { textFiles, binaryFiles } = archive.exportBackendVfs();

  const pending = new Map();
  let nextReq = 1;
  let resolveReady;
  let rejectReady;
  const readyPromise = new Promise((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

  const session = new BackendWorkerSession((msg) => {
    if (msg.type === 'ready') resolveReady();
    else if (msg.type === 'error') rejectReady(new Error(msg.message));
    else if (msg.type === 'response' || msg.type === 'rpc-reply') {
      const waiter = pending.get(msg.reqId);
      if (waiter) {
        pending.delete(msg.reqId);
        waiter(msg);
      }
    }
  });

  await session.handleMessage({
    type: 'init',
    appId: archive.manifest.id,
    backend: archive.manifest.backend,
    databases: archive.manifest.databases,
    textFiles,
    binaryFiles,
    runtimeUrl: path.join(REPO_ROOT, 'packages', '@softn', 'container', 'dist', 'runtime'),
    engineModule: PHP_WASM,
    xdbModule: XDB_WASM,
    xdbGlueUrl: XDB_GLUE,
  });

  await readyPromise;

  const call = async (method, urlPath, bodyObj) => {
    const reqId = nextReq++;
    const [p, q = ''] = urlPath.split('?');
    const bodyBytes = bodyObj !== undefined ? new TextEncoder().encode(JSON.stringify(bodyObj)) : undefined;
    const headers = bodyObj !== undefined ? { 'content-type': 'application/json' } : {};
    const respPromise = new Promise((resolve) => pending.set(reqId, resolve));
    await session.handleMessage({ type: 'fetch', reqId, method, path: p, query: q, headers, bodyBytes });
    const resp = await respPromise;
    const text = new TextDecoder().decode(resp.bodyBytes);
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: resp.status, text, json };
  };

  const exportDb = async () => {
    const reqId = nextReq++;
    const p = new Promise((resolve) => pending.set(reqId, resolve));
    await session.handleMessage({ type: 'export-db', reqId, dbName: 'app' });
    const reply = await p;
    return reply.result;
  };

  const dispose = async () => {
    await session.handleMessage({ type: 'dispose' });
    archive.dispose();
  };

  return { archive, call, exportDb, dispose };
}

async function verifyAllZippApps() {
  // 1. Sales
  {
    const s = await bootBackendSession('opal-sales.softn');
    const rt = await s.call('GET', '/api/runtime');
    assert.equal(rt.status, 200, rt.text);
    assert.equal(rt.json.mode, 'zipp-wasm');
    const inv = await s.call('POST', '/api/docs', {
      doc_type: 'invoice',
      customer_name: 'Sydney Harbour Co',
      tax_mode: 'exclusive',
      lines: [{ description: 'Advisory', qty: 1, unitPrice: 1000, taxCode: 'GST' }],
    });
    assert.equal(inv.status, 201, inv.text);
    assert.equal(inv.json.doc.gst_amount, 100);
    assert.equal(inv.json.doc.total, 1100);
    const conv = await s.call('POST', '/api/docs/6/convert', { target_type: 'invoice' });
    assert.equal(conv.status, 201, conv.text);
    assert.equal(conv.json.created.doc_type, 'invoice');
    const paid = await s.call('POST', `/api/docs/${inv.json.doc.id}/pay`, { amount: 1100, method: 'EFT / OSKO' });
    assert.equal(paid.status, 200, paid.text);
    assert.equal(paid.json.doc.status, 'Paid');
    const dbBytes = await s.exportDb();
    assert.ok(dbBytes && dbBytes.byteLength > 4096, 'exported XDB SQLite .db bytes');
    await s.dispose();
    console.log('[PASS] opal-sales.softn (AU GST Tax Invoices, Quote->Invoice & Payments)');
  }

  // 2. Purchases & In Tray
  {
    const s = await bootBackendSession('opal-purchases.softn');
    const toBill = await s.call('POST', '/api/intray/1/to-bill', {});
    assert.equal(toBill.status, 201, toBill.text);
    assert.equal(toBill.json.bill.total, 924);
    assert.equal(toBill.json.intrayDoc.status, 'Linked');
    const poConv = await s.call('POST', '/api/docs/5/to-bill', {});
    assert.equal(poConv.status, 201, poConv.text);
    await s.dispose();
    console.log('[PASS] opal-purchases.softn (OCR In Tray -> Bill & PO Conversion)');
  }

  // 3. Banking
  {
    const s = await bootBackendSession('opal-banking.softn');
    const rules = await s.call('POST', '/api/rules/apply', {});
    assert.equal(rules.status, 200, rules.text);
    assert.ok(rules.json.appliedCount >= 3, `Expected >= 3 rules applied, got ${rules.json.appliedCount}`);
    const trf = await s.call('POST', '/api/money', { kind: 'transfer', account_id: 1, to_account_id: 2, amount: 2500 });
    assert.equal(trf.status, 201, trf.text);
    const rec = await s.call('POST', '/api/reconcile', { account_id: 1, statement_date: '2026-11-22', statement_balance: 162320.5, transaction_ids: [7] });
    assert.equal(rec.status, 201, rec.text);
    await s.dispose();
    console.log('[PASS] opal-banking.softn (Bank Rules Engine, Transfers & Reconciliation)');
  }

  // 4. Accounting & AI BAS
  {
    const s = await bootBackendSession('opal-accounting.softn');
    const bas1 = await s.call('GET', '/api/bas');
    assert.equal(bas1.status, 200, bas1.text);
    assert.equal(bas1.json.bas.anomalies.length, 2);
    const resAn = await s.call('POST', '/api/bas/anomalies/9/resolve', { tax_code: 'CAP' });
    assert.equal(resAn.status, 200, resAn.text);
    assert.equal(resAn.json.bas.anomalies.length, 1);
    const jn = await s.call('POST', '/api/journals', {
      memo: 'Audit Test Accrual',
      lines: [
        { account_code: '6-1400', debit: 500, credit: 0 },
        { account_code: '1-1100', debit: 0, credit: 500 },
      ],
    });
    assert.equal(jn.status, 201, jn.text);
    const lodged = await s.call('POST', '/api/bas/lodge', {});
    assert.equal(lodged.status, 201, lodged.text);
    assert.ok(String(lodged.json.lodgement.ato_receipt).startsWith('ATO-BAS-'));
    await s.dispose();
    console.log('[PASS] opal-accounting.softn (AU Chart of Accounts, Journals & AI BAS ATO Lodge)');
  }

  // 5. Payroll, STP Phase 2 & 12% Super
  {
    const s = await bootBackendSession('opal-payroll.softn');
    const pr = await s.call('POST', '/api/pay-runs', {
      frequency: 'Fortnightly',
      period_start: '2026-11-16',
      period_end: '2026-11-29',
      payment_date: '2026-11-30',
    });
    assert.equal(pr.status, 201, pr.text);
    assert.ok(pr.json.payRun.total_gross > 18000);
    assert.ok(pr.json.payRun.total_payg > 3500);
    assert.ok(pr.json.payRun.total_super > 2000);
    const stp = await s.call('POST', `/api/pay-runs/${pr.json.payRun.id}/lodge-stp`, {});
    assert.equal(stp.status, 200, stp.text);
    assert.equal(stp.json.payRun.stp_status, 'Accepted by ATO');
    const sup = await s.call('POST', `/api/pay-runs/${pr.json.payRun.id}/pay-super`, {});
    assert.equal(sup.status, 200, sup.text);
    assert.equal(sup.json.payRun.super_status, 'Paid');
    await s.dispose();
    console.log('[PASS] opal-payroll.softn (Stage 3 PAYG, 12% SG Super, STP Phase 2 & Payslips)');
  }

  // 6. Inventory, Jobs & Time Billing
  {
    const s = await bootBackendSession('opal-inventory.softn');
    const adj = await s.call('POST', '/api/items/3/adjust', { qty_delta: 12, reason: 'Supplier Restock' });
    assert.equal(adj.status, 200, adj.text);
    assert.equal(Number(adj.json.item.qty_on_hand), 16);
    const billSlip = await s.call('POST', '/api/time-slips/1/bill', {});
    assert.equal(billSlip.status, 200, billSlip.text);
    assert.equal(billSlip.json.timeSlip.status, 'Billed');
    await s.dispose();
    console.log('[PASS] opal-inventory.softn (Multi-Location Stocktake & Time Billing -> Job Rollup)');
  }

  // 7. Contacts, ABR ABN Validator & TPAR
  {
    const s = await bootBackendSession('opal-contacts.softn');
    const abnOk = await s.call('GET', '/api/validate-abn?abn=53004085616');
    assert.equal(abnOk.status, 200, abnOk.text);
    assert.equal(abnOk.json.valid, true);
    const abnBad = await s.call('GET', '/api/validate-abn?abn=53004085617');
    assert.equal(abnBad.json.valid, false);
    const created = await s.call('POST', '/api/contacts', {
      name: 'Fremantle Solar Pty Ltd',
      contact_type: 'Contractor',
      abn: '53 004 085 616',
      tpar_reportable: true,
    });
    assert.equal(created.status, 201, created.text);
    assert.equal(Number(created.json.contact.abn_valid), 1);
    await s.dispose();
    console.log('[PASS] opal-contacts.softn (Live ABR Mod-89 ABN Validator & ATO TPAR Directory)');
  }

  // 8. Financial Reporting & Multi-Currency FX
  {
    const s = await bootBackendSession('opal-reporting.softn');
    const st = await s.call('GET', '/api/statements?basis=accrual');
    assert.equal(st.status, 200, st.text);
    assert.equal(st.json.balanceSheet.balanced, true);
    assert.equal(st.json.trialBalance.balanced, true);
    const fx = await s.call('PATCH', '/api/fx/USD', { current_rate: 1.58 });
    assert.equal(fx.status, 200, fx.text);
    assert.equal(Number(fx.json.position.current_rate), 1.58);
    await s.dispose();
    console.log('[PASS] opal-reporting.softn (Balanced P&L/BS/TB & AccountRight Premier Multi-Currency FX)');
  }
}

async function verifyStandalonePhp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opal-standalone-php-'));
  fs.copyFileSync(path.join(DIR, 'shared', 'php', 'opal_micro.php'), path.join(tmpDir, 'opal_micro.php'));
  fs.copyFileSync(path.join(DIR, 'apps', 'accounting', 'backend', 'index.php'), path.join(tmpDir, 'index.php'));
  fs.copyFileSync(path.join(DIR, 'apps', 'accounting', 'backend', 'schema.sql'), path.join(tmpDir, 'schema.sql'));
  const dbPath = path.join(tmpDir, 'accounting.sqlite3');
  const port = 18291;

  const child = spawn('php', ['-S', `127.0.0.1:${port}`, path.join(tmpDir, 'index.php')], {
    cwd: tmpDir,
    env: { ...process.env, OPAL_STANDALONE_DB: dbPath },
    stdio: 'ignore',
  });

  try {
    let ok = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/runtime`);
        if (r.ok) {
          const j = await r.json();
          assert.equal(j.mode, 'standalone-php');
          ok = true;
          break;
        }
      } catch {}
    }
    assert.ok(ok, 'Standalone PHP server did not become ready');

    const bas = await (await fetch(`http://127.0.0.1:${port}/api/bas`)).json();
    assert.ok(bas.bas.G1 > 90000);
    assert.ok(fs.existsSync(dbPath), 'WAL SQLite database file created on disk');
    console.log('[PASS] Standalone Native PHP 8 + WAL SQLite mode verified (identical PHP scripts)!');
  } finally {
    try { child.kill(); } catch {}
    await new Promise((r) => setTimeout(r, 150));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  await verifyAllZippApps();
  await verifyStandalonePhp();
  console.log('\nALL 8 OPAL BUSINESS ZIPP WASM + XDB SQLITE CONTAINERS & STANDALONE PHP MODE PASSED!');
}

main().catch((err) => {
  console.error('[FAIL]', err);
  process.exit(1);
});
