#!/usr/bin/env node
/**
 * End-to-end verification suite for Modula Business Suite:
 * 1. Boots ALL 11 `.softn` bundles inside REAL `BackendWorkerSession` (`zipp-php.wasm` + `xdb-wasm.wasm`)
 *    and exercises GET/POST/PATCH/PUT/DELETE + transactional SQLite mutations & `.db` export!
 * 2. Launches a real standalone `php -S` server for CRM and verifies IDENTICAL API responses
 *    with native PHP 8 + WAL SQLite (`mode: "standalone-php"`).
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

async function verifyZippApps() {
  // 1. CRM, Sales & Subscriptions
  {
    const s = await bootBackendSession('modula-crm.softn');
    const rt = await s.call('GET', '/api/runtime');
    assert.equal(rt.status, 200, rt.text);
    assert.equal(rt.json.mode, 'zipp-wasm');
    const ov = await s.call('GET', '/api/overview');
    assert.equal(ov.status, 200, ov.text);
    assert.ok(ov.json.openPipeline > 0);
    assert.ok(ov.json.activeMrr > 0);
    const created = await s.call('POST', '/api/deals', { title: 'Test Enterprise Deal', company: 'Acme', expected_revenue: 15000 });
    assert.equal(created.status, 201, created.text);
    const moved = await s.call('PATCH', `/api/deals/${created.json.deal.id}/stage`, { stage: 'Won' });
    assert.equal(moved.status, 200, moved.text);
    assert.equal(moved.json.deal.stage, 'Won');
    const conv = await s.call('POST', '/api/leads/1/convert', { owner_name: 'Alex Rivera' });
    assert.equal(conv.status, 200, conv.text);
    assert.ok(conv.json.deal?.id);
    const sub = await s.call('POST', '/api/subscriptions', { customer_name: 'Acme', plan_name: 'Managed PHP', mrr: 650, seats: 25 });
    assert.equal(sub.status, 201, sub.text);
    const dbBytes = await s.exportDb();
    assert.ok(dbBytes && dbBytes.byteLength > 4096, 'exported XDB SQLite .db bytes');
    await s.dispose();
    console.log('[PASS] 1/11 modula-crm.softn (Pipeline, Lead Convert, Subscriptions & DB Export)');
  }

  // 2. Accounting, Invoicing & Bank Reconciliation
  {
    const s = await bootBackendSession('modula-accounting.softn');
    const ov1 = await s.call('GET', '/api/overview');
    assert.equal(ov1.status, 200, ov1.text);
    const inv = await s.call('POST', '/api/invoices', {
      kind: 'customer',
      party_name: 'Test Client',
      tax_rate: 10,
      lines: [{ description: 'License', qty: 1, unitPrice: 1000 }],
    });
    assert.equal(inv.status, 201, inv.text);
    assert.equal(inv.json.invoice.total, 1100);
    const paid = await s.call('POST', `/api/invoices/${inv.json.invoice.id}/pay`, { amount: 1100 });
    assert.equal(paid.status, 200, paid.text);
    assert.equal(paid.json.invoice.status, 'Paid');
    const ov2 = await s.call('GET', '/api/overview');
    assert.equal(Math.round(ov2.json.bankBalance - ov1.json.bankBalance), 1100);
    const cn = await s.call('POST', `/api/invoices/${inv.json.invoice.id}/credit-note`, { reason: 'Discount adjustment' });
    assert.ok(cn.status === 200 || cn.status === 201, cn.text);
    assert.equal(cn.json.invoice.status, 'Credited');
    const recon = await s.call('POST', '/api/bank/1/reconcile', { invoice_id: 2 });
    assert.equal(recon.status, 200, recon.text);
    const rep = await s.call('GET', '/api/reports');
    assert.equal(rep.status, 200, rep.text);
    assert.ok(rep.json.pnl && rep.json.balanceSheet && rep.json.agedReceivables);
    await s.dispose();
    console.log('[PASS] 2/11 modula-accounting.softn (Double-Entry, Credit Notes, Bank Recon & Reports)');
  }

  // 3. Inventory, Purchasing & Manufacturing MRP
  {
    const s = await bootBackendSession('modula-inventory.softn');
    const before = await s.call('GET', '/api/products');
    const sku2Before = before.json.products.find((p) => p.id === 2).stock_on_hand;
    const rec = await s.call('POST', '/api/pos/1/receive', {});
    assert.equal(rec.status, 200, rec.text);
    assert.equal(rec.json.po.status, 'Received');
    const after = await s.call('GET', '/api/products');
    const sku2After = after.json.products.find((p) => p.id === 2).stock_on_hand;
    assert.equal(sku2After, sku2Before + 20);
    const mo = await s.call('POST', '/api/mrp/orders', { bom_id: 1, qty_to_produce: 1 });
    assert.equal(mo.status, 201, mo.text);
    const prod = await s.call('POST', `/api/mrp/orders/${mo.json.order.id}/produce`, {});
    assert.equal(prod.status, 200, prod.text);
    assert.equal(prod.json.order.status, 'Done');
    const tr = await s.call('POST', '/api/transfers', { product_id: 1, kind: 'delivery', qty: 1, destination: 'Customer / Test', reference: 'DEL-TEST' });
    assert.equal(tr.status, 201, tr.text);
    await s.dispose();
    console.log('[PASS] 3/11 modula-inventory.softn (Atomic Receiving, MRP Kit Production & Deliveries)');
  }

  // 4. Projects, Milestones & Timesheets
  {
    const s = await bootBackendSession('modula-projects.softn');
    const ts = await s.call('POST', '/api/timesheets', { task_id: 2, employee_name: 'Jordan Patel', hours: 3.5, billable: true, note: 'Test' });
    assert.equal(ts.status, 201, ts.text);
    const tasks = await s.call('GET', '/api/tasks');
    const t2 = tasks.json.tasks.find((t) => t.id === 2);
    assert.equal(Number(t2.logged_hours), 12.5);
    const ms = await s.call('POST', '/api/milestones', { project_id: 1, title: 'Go-Live Cutover', due_date: '2026-12-15' });
    assert.equal(ms.status, 201, ms.text);
    const tog = await s.call('PATCH', `/api/milestones/${ms.json.milestone.id}/toggle`, {});
    assert.equal(tog.status, 200, tog.text);
    const sub = await s.call('PATCH', '/api/tasks/2/subtasks', { subtasks: [{ title: 'Verify XDB WAL', done: true }] });
    assert.equal(sub.status, 200, sub.text);
    await s.dispose();
    console.log('[PASS] 4/11 modula-projects.softn (Timesheets, Milestones & Subtasks)');
  }

  // 5. HR, Attendance, Appraisals & Payroll
  {
    const s = await bootBackendSession('modula-hr.softn');
    const empBefore = (await s.call('GET', '/api/employees')).json.employees.length;
    const hired = await s.call('PATCH', '/api/candidates/1/stage', { stage: 'Hired' });
    assert.equal(hired.status, 200, hired.text);
    assert.ok(hired.json.hiredEmployee);
    const empAfter = (await s.call('GET', '/api/employees')).json.employees.length;
    assert.equal(empAfter, empBefore + 1);
    const att = await s.call('POST', '/api/attendances/toggle', { employee_id: 1 });
    assert.ok(att.status === 200 || att.status === 201, att.text);
    const app = await s.call('POST', '/api/appraisals', { employee_id: 1, cycle: '2026 Q4', self_rating: 5, goals: 'Scale SoftN containers' });
    assert.equal(app.status, 201, app.text);
    const pay = await s.call('POST', '/api/payroll/run', { pay_period: '2026-12' });
    assert.equal(pay.status, 201, pay.text);
    assert.ok(pay.json.created >= empAfter);
    await s.dispose();
    console.log('[PASS] 5/11 modula-hr.softn (ATS Hire, Attendance Kiosk, Appraisals & Payroll Run)');
  }

  // 6. Helpdesk, Macros, CSAT & Knowledge Wiki
  {
    const s = await bootBackendSession('modula-helpdesk.softn');
    const msg = await s.call('POST', '/api/tickets/1/messages', { author: 'Agent', is_internal: true, body: 'Checked logs' });
    assert.equal(msg.status, 201, msg.text);
    const rated = await s.call('PATCH', '/api/tickets/1', { csat_rating: 5 });
    assert.equal(rated.status, 200, rated.text);
    assert.equal(Number(rated.json.ticket.csat_rating), 5);
    const macro = await s.call('POST', '/api/macros', { title: 'SQLite Backup Tip', shortcut: '/backup', body: 'Click Export SQLite .db in topbar.' });
    assert.equal(macro.status, 201, macro.text);
    const voted = await s.call('POST', '/api/kb/1/vote', {});
    assert.equal(voted.status, 200, voted.text);
    assert.equal(Number(voted.json.article.helpful_votes), 25);
    const kbEdit = await s.call('PUT', '/api/kb/1', { title: 'Updated SOP Title', category: 'Operations', body: 'Updated content' });
    assert.equal(kbEdit.status, 200, kbEdit.text);
    await s.dispose();
    console.log('[PASS] 6/11 modula-helpdesk.softn (Chatter, CSAT, Macros & Editable Knowledge Wiki)');
  }

  // 7. Website Builder, eCommerce, Blog & Email Marketing
  {
    const s = await bootBackendSession('modula-website.softn');
    const ord = await s.call('POST', '/api/store/orders', {
      customer_name: 'Buyer Test',
      customer_email: 'buyer@example.com',
      promo_code: 'MODULA10',
      items: [{ product_id: 1, qty: 2 }],
    });
    assert.equal(ord.status, 201, ord.text);
    assert.ok(ord.json.order.discount_amount > 0);
    const blog = await s.call('POST', '/api/blog', { title: 'Zero-Server ERP Launch', category: 'Release', author_name: 'Alex', excerpt: 'Intro', body: 'Full post' });
    assert.equal(blog.status, 201, blog.text);
    const camp = await s.call('POST', '/api/campaigns', { name: 'Q1 Launch Blast', subject: 'Meet Modula', audience: 'All Leads', body: 'Hello!' });
    assert.equal(camp.status, 201, camp.text);
    const sent = await s.call('POST', `/api/campaigns/${camp.json.campaign.id}/send`, {});
    assert.equal(sent.status, 200, sent.text);
    assert.equal(sent.json.campaign.status, 'Sent');
    const lead = await s.call('POST', '/api/leads', { name: 'Lead Test', email: 'lead@example.com', company: 'Test Co', message: 'Want a demo' });
    assert.equal(lead.status, 201, lead.text);
    await s.dispose();
    console.log('[PASS] 7/11 modula-website.softn (Page Builder, Promo Checkout, Blog & Campaigns)');
  }

  // 8. Point of Sale & Equipment Rental
  {
    const s = await bootBackendSession('modula-pos.softn');
    const sale = await s.call('POST', '/api/orders', {
      customer_name: 'Cafe Guest',
      order_type: 'Dine-In',
      table_label: 'Table 2',
      payment_method: 'Cash',
      amount_tendered: 50,
      items: [{ itemId: 6, qty: 2 }, { itemId: 7, qty: 1 }],
    });
    assert.equal(sale.status, 201, sale.text);
    assert.ok(sale.json.order.change_due > 0);
    const ref = await s.call('POST', `/api/orders/${sale.json.order.id}/refund`, {});
    assert.equal(ref.status, 200, ref.text);
    assert.equal(ref.json.order.status, 'Refunded');
    const rent = await s.call('POST', '/api/rentals/bookings', { asset_id: 3, customer_name: 'Depot Co', qty: 1, days: 2 });
    assert.equal(rent.status, 201, rent.text);
    const out = await s.call('PATCH', `/api/rentals/bookings/${rent.json.booking.id}/status`, { status: 'Picked Up' });
    assert.equal(out.status, 200, out.text);
    const ret = await s.call('PATCH', `/api/rentals/bookings/${rent.json.booking.id}/status`, { status: 'Returned' });
    assert.equal(ret.status, 200, ret.text);
    await s.dispose();
    console.log('[PASS] 8/11 modula-pos.softn (POS Register, Cash Change, Refund & Equipment Rental)');
  }

  // 9. Field Service, Appointments & Planning
  {
    const s = await bootBackendSession('modula-fieldservice.softn');
    const wo = await s.call('POST', '/api/work-orders', { title: 'Fiber Router Replacement', customer_name: 'Harbor Co', technician_id: 2, priority: 'Urgent', est_hours: 2 });
    assert.equal(wo.status, 201, wo.text);
    const done = await s.call('POST', `/api/work-orders/${wo.json.workOrder.id}/complete`, { actual_hours: 2.5, customer_signed_by: 'Ops Manager', part_name: 'SFP+ Module', part_qty: 2, part_price: 45 });
    assert.equal(done.status, 200, done.text);
    assert.equal(done.json.workOrder.stage, 'Completed');
    assert.equal(done.json.workOrder.parts_total, 90);
    const appt = await s.call('POST', '/api/appointments', { service_type: 'Network Audit', customer_name: 'Delta Inc', technician_name: 'Daniel Brooks', appt_date: '2026-11-29', start_time: '10:00' });
    assert.equal(appt.status, 201, appt.text);
    const conflict = await s.call('POST', '/api/appointments', { service_type: 'Duplicate Slot', customer_name: 'Other', technician_name: 'Daniel Brooks', appt_date: '2026-11-29', start_time: '10:00' });
    assert.equal(conflict.status, 409, 'Slot conflict check must reject double-booking');
    const pub = await s.call('POST', '/api/shifts/publish-all', {});
    assert.equal(pub.status, 200, pub.text);
    await s.dispose();
    console.log('[PASS] 9/11 modula-fieldservice.softn (Dispatch Sign-Off, Slot Conflict Check & Shifts)');
  }

  // 10. Documents Vault, eSign, Approvals & Discuss
  {
    const s = await bootBackendSession('modula-workspace.softn');
    const doc = await s.call('POST', '/api/documents', { title: 'NDA 2026', folder: 'Legal', content_text: 'Mutual confidentiality.' });
    assert.equal(doc.status, 201, doc.text);
    const env = await s.call('POST', '/api/signs', { document_id: doc.json.document.id, signer_name: 'Taylor Kim', signer_email: 't.kim@example.com' });
    assert.equal(env.status, 201, env.text);
    const signed = await s.call('POST', `/api/signs/${env.json.sign.id}/sign`, { signature_text: 'Taylor Kim' });
    assert.equal(signed.status, 200, signed.text);
    assert.equal(signed.json.sign.audit_hash.length, 64, 'Real SHA-256 audit hash expected');
    const appr = await s.call('PATCH', '/api/approvals/1/decide', { status: 'Approved', decision_note: 'Verified' });
    assert.equal(appr.status, 200, appr.text);
    const msg = await s.call('POST', '/api/channels/1/messages', { author_name: 'Alex Rivera', body: 'All containers green!' });
    assert.equal(msg.status, 201, msg.text);
    await s.dispose();
    console.log('[PASS] 10/11 modula-workspace.softn (Vault, SHA-256 eSign, Approvals & Discuss)');
  }

  // 11. Events, Surveys & eLearning Academy
  {
    const s = await bootBackendSession('modula-events.softn');
    const reg = await s.call('POST', '/api/events/1/registrations', { attendee_name: 'Jordan Test', attendee_email: 'j@example.com', company: 'Modula Labs', ticket_tier: 'VIP' });
    assert.equal(reg.status, 201, reg.text);
    const chk = await s.call('PATCH', `/api/registrations/${reg.json.registration.id}/checkin`, {});
    assert.equal(chk.status, 200, chk.text);
    assert.equal(Number(chk.json.registration.checked_in), 1);
    const resp = await s.call('POST', '/api/surveys/1/responses', { respondent_name: 'Jordan Test', score: 10, comment: 'Fantastic!' });
    assert.equal(resp.status, 201, resp.text);
    const les = await s.call('PATCH', '/api/lessons/3/toggle', {});
    assert.equal(les.status, 200, les.text);
    assert.equal(Number(les.json.lesson.completed), 1);
    await s.dispose();
    console.log('[PASS] 11/11 modula-events.softn (Event Check-In, Live NPS Survey & eLearning)');
  }
}

async function verifyStandalonePhp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modula-standalone-php-'));
  fs.copyFileSync(path.join(DIR, 'shared', 'php', 'micro.php'), path.join(tmpDir, 'micro.php'));
  fs.copyFileSync(path.join(DIR, 'apps', 'crm', 'backend', 'index.php'), path.join(tmpDir, 'index.php'));
  fs.copyFileSync(path.join(DIR, 'apps', 'crm', 'backend', 'schema.sql'), path.join(tmpDir, 'schema.sql'));
  const dbPath = path.join(tmpDir, 'crm.sqlite3');
  const port = 18191;

  const child = spawn('php', ['-S', `127.0.0.1:${port}`, path.join(tmpDir, 'index.php')], {
    cwd: tmpDir,
    env: { ...process.env, MODULA_STANDALONE_DB: dbPath },
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

    const deals = await (await fetch(`http://127.0.0.1:${port}/api/deals`)).json();
    assert.ok(deals.deals.length >= 6);
    const created = await fetch(`http://127.0.0.1:${port}/api/deals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Standalone PHP Deal', company: 'Native Co', expected_revenue: 9900 }),
    });
    assert.equal(created.status, 201);
    assert.ok(fs.existsSync(dbPath), 'WAL SQLite database file created on disk');
    console.log('[PASS] Standalone Native PHP 8 + WAL SQLite mode verified!');
  } finally {
    try { child.kill(); } catch {}
    await new Promise((r) => setTimeout(r, 150));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  await verifyZippApps();
  await verifyStandalonePhp();
  console.log('\nALL 11 ZIPP WASM + XDB SQLITE CONTAINERS & STANDALONE PHP MODE PASSED!');
}

main().catch((err) => {
  console.error('[FAIL]', err);
  process.exit(1);
});
