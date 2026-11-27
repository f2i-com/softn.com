import { describe, it, expect, beforeEach } from 'vitest';
import { zipSync } from 'fflate';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountSoftNContainer } from '../src/index';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(PKG_ROOT, '..', '..', '..');
const PROFILE_DIR = path.join(REPO_ROOT, 'examples', 'fullstack-crud');
const ENGINES_DIR = path.join(PKG_ROOT, 'dist', 'runtime', 'engines');
const TS_WASM = path.join(ENGINES_DIR, 'zipp-typescript.wasm');
const PHP_WASM = path.join(ENGINES_DIR, 'zipp-php.wasm');
const XDB_WASM = path.join(ENGINES_DIR, 'xdb-wasm.wasm');
const XDB_GLUE = path.join(ENGINES_DIR, 'xdb-wasm.glue.js');

function flushAsync(ms = 120): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function zipDirectory(dir: string, prefix = ''): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      Object.assign(out, zipDirectory(full, rel));
    } else if (
      entry.isFile() &&
      entry.name !== 'README.md' &&
      entry.name !== 'serve.mjs' &&
      entry.name !== 'playground.html'
    ) {
      out[rel] = new Uint8Array(fs.readFileSync(full));
    }
  }
  return out;
}

describe('Official React + TypeScript + PHP Slim Application Profile (examples/fullstack-crud)', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('verifies PSR-4 autoloading, Slim routing, PSR-7, PDO prepared statements, transactions (commit/rollback), auth/validation middleware, lossless JSON, React TSX execution, and reload persistence', async () => {
    const bundleBytes = zipSync(zipDirectory(PROFILE_DIR));

    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = await mountSoftNContainer(host, {
      source: bundleBytes,
      appId: 'test-fullstack-crud-profile',
      storagePrefix: 'softn-test-fullstack-crud:',
      persistStorage: true,
      isolation: 'inline',
      permissionMode: 'deny', // Zero external network permissions required!
      engineWasm: { typescript: TS_WASM, php: PHP_WASM },
      xdbWasm: XDB_WASM,
      xdbGlueUrl: XDB_GLUE,
    });

    await flushAsync(200);

    // 1. React .tsx direct execution + initial GET /api/items (with migration v2 priority column!)
    expect(handle.engineTier).toBe('typescript');
    expect(handle.shadowRoot.querySelector('#app-title')?.textContent).toContain('Inventory CRUD');
    expect(handle.shadowRoot.querySelector('#summary')?.textContent).toBe('2 items · 16 total units');
    const initialRows = Array.from(handle.shadowRoot.querySelectorAll('#items-tbody tr'));
    expect(initialRows.length).toBe(2);
    expect(initialRows[0].textContent).toContain('INV-1001');
    expect(initialRows[0].textContent).toContain('9007199254740993');
    expect(initialRows[0].textContent).toContain('12450.7500');
    expect(initialRows[0].textContent).toContain('high');

    // 2. React controlled forms -> POST /api/items -> persisted in SQLite
    const skuInput = handle.shadowRoot.querySelector('#sku-input') as HTMLInputElement;
    const titleInput = handle.shadowRoot.querySelector('#title-input') as HTMLInputElement;
    const priceInput = handle.shadowRoot.querySelector('#price-input') as HTMLInputElement;
    const qtyInput = handle.shadowRoot.querySelector('#qty-input') as HTMLInputElement;

    skuInput.value = 'INV-2001';
    skuInput.dispatchEvent(new Event('input', { bubbles: true }));
    titleInput.value = 'Optical Flow Meter';
    titleInput.dispatchEvent(new Event('input', { bubbles: true }));
    priceInput.value = '3499.2500';
    priceInput.dispatchEvent(new Event('input', { bubbles: true }));
    qtyInput.value = '5';
    qtyInput.dispatchEvent(new Event('input', { bubbles: true }));
    await flushAsync(80);

    (handle.shadowRoot.querySelector('#create-btn') as HTMLButtonElement).click();
    await flushAsync(180);

    expect(handle.shadowRoot.querySelector('#summary')?.textContent).toBe('3 items · 21 total units');
    const createdRow = handle.shadowRoot.querySelector('tr[data-sku="INV-2001"]') as HTMLTableRowElement;
    expect(createdRow).not.toBeNull();
    expect(createdRow.textContent).toContain('3499.2500');

    // 3. PATCH /api/items/{id} via button click (+1 Qty)
    const bumpBtn = createdRow.querySelector('button[data-action="bump"]') as HTMLButtonElement;
    bumpBtn.click();
    await flushAsync(180);
    expect(handle.shadowRoot.querySelector('#summary')?.textContent).toBe('3 items · 22 total units');

    // 4. Direct backend transport tests for AuthMiddleware, ValidationMiddleware, Transactions (commit + rollback), DELETE
    const transport = handle.backendTransport!;
    // Auth middleware rejects unauthenticated /api/admin/health with 401
    const unauth = await transport.fetch({ method: 'GET', path: '/api/admin/health', query: '', headers: {} });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.some(([k, v]) => k.toLowerCase() === 'x-softn-profile' && v === 'react-ts-php-slim')).toBe(true);

    // Auth middleware accepts valid bearer token
    const authed = await transport.fetch({
      method: 'GET',
      path: '/api/admin/health',
      query: '',
      headers: { authorization: 'Bearer softn-demo-admin' },
    });
    expect(authed.status).toBe(200);
    expect(JSON.parse(new TextDecoder().decode(authed.body))).toMatchObject({ ok: true, role: 'admin', itemCount: 3 });

    // ValidationMiddleware rejects malformed JSON with 422
    const badJson = await transport.fetch({
      method: 'POST',
      path: '/api/items',
      query: '',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    });
    expect(badJson.status).toBe(422);

    // PDO Transaction ROLLBACK: second item duplicates INV-1001 -> first item INV-ROLLBACK MUST NOT exist!
    const rollbackRes = await transport.fetch({
      method: 'POST',
      path: '/api/items/batch',
      query: '',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [
          { sku: 'INV-ROLLBACK', title: 'Should Roll Back', unit_price: '10.00', quantity: 1 },
          { sku: 'INV-1001', title: 'Duplicate SKU Trigger', unit_price: '20.00', quantity: 1 },
        ],
      }),
    });
    const rollbackBody = new TextDecoder().decode(rollbackRes.body);
    expect(rollbackRes.status, `rollback body: ${rollbackBody}`).toBe(409);
    const afterRollback = await transport.fetch({ method: 'GET', path: '/api/items', query: '', headers: {} });
    const afterRollbackJson = JSON.parse(new TextDecoder().decode(afterRollback.body));
    expect(afterRollbackJson.items.some((i: { sku: string }) => i.sku === 'INV-ROLLBACK')).toBe(false);

    // PDO Transaction COMMIT: both items persist atomically
    const commitRes = await transport.fetch({
      method: 'POST',
      path: '/api/items/batch',
      query: '',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [
          { sku: 'INV-3001', title: 'Batch A', unit_price: '12.50', quantity: 2 },
          { sku: 'INV-3002', title: 'Batch B', unit_price: '25.00', quantity: 3 },
        ],
      }),
    });
    expect(commitRes.status).toBe(201);

    // DELETE /api/items/{id}
    const delBtn = handle.shadowRoot.querySelector('tr[data-sku="INV-1002"] button[data-action="delete"]') as HTMLButtonElement;
    delBtn.click();
    await flushAsync(180);

    // Flush SQLite persistence and reload container to confirm durable persistence across reload!
    await handle.flushDatabase();
    handle.dispose();

    const host2 = document.createElement('div');
    document.body.appendChild(host2);
    const reloaded = await mountSoftNContainer(host2, {
      source: bundleBytes,
      appId: 'test-fullstack-crud-profile',
      storagePrefix: 'softn-test-fullstack-crud:',
      persistStorage: true,
      isolation: 'inline',
      permissionMode: 'deny',
      engineWasm: { typescript: TS_WASM, php: PHP_WASM },
      xdbWasm: XDB_WASM,
      xdbGlueUrl: XDB_GLUE,
    });
    await flushAsync(200);

    const skusAfterReload = Array.from(reloaded.shadowRoot.querySelectorAll('#items-tbody tr')).map((tr) =>
      tr.getAttribute('data-sku')
    );
    expect(skusAfterReload).toContain('INV-1001');
    expect(skusAfterReload).toContain('INV-2001');
    expect(skusAfterReload).toContain('INV-3001');
    expect(skusAfterReload).toContain('INV-3002');
    expect(skusAfterReload).not.toContain('INV-1002');

    reloaded.dispose();
  }, 45_000);
});
