// Capture authentic screenshots of a full-stack PHP + SQLite Web Container
// running completely sandboxed inside SoftN AI Studio in the browser.
//
// Run after `npm run build:site` (serves `dist/` directly), or set STUDIO_URL
// to point at a running dev server (e.g. http://localhost:1420/studio/).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const distDir = path.join(repoRoot, 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

function buildOrderDeskBundle() {
  const manifest = {
    formatVersion: 2,
    engine: 2,
    name: 'Order Desk',
    version: '1.0.0',
    description: 'Full-stack PHP 8 + SQLite order tracker running completely sandboxed in the browser.',
    main: 'index.html',
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
        file: 'app.db',
        seedSql: 'backend/schema.sql',
      },
    ],
    config: {
      execution: 'worker',
      theme: { mode: 'light' },
    },
  };

  const schemaSql = `-- SQLite 3 schema seeded into app.db (XDB SQLite WASM in IndexedDB)
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  customer TEXT NOT NULL,
  item TEXT NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO orders (id, code, customer, item, amount, status) VALUES
  (1, 'ORD-1041', 'Northside Roasters', 'Espresso Grinder (2 units)', 1240.00, 'completed'),
  (2, 'ORD-1042', 'Harbour Bakery', 'Convection Deck Oven Filter Kit', 385.50, 'in_progress'),
  (3, 'ORD-1043', 'Kestrel Field Ops', 'Rugged Tablet Mounts (x8)', 640.00, 'pending'),
  (4, 'ORD-1044', 'Bayside Clinic', 'Cold-Chain Sensor Pack', 890.00, 'completed'),
  (5, 'ORD-1045', 'Redwood Studio', 'Acoustic Wall Panels (Oak)', 1520.00, 'pending');
`;

  const backendPhp = `<?php
declare(strict_types=1);

// Sandboxed PHP 8 backend — runs in ZIPP WASM locally or ZIPP safe-sandbox on a server
header('Content-Type: application/json; charset=utf-8');

$pdo = new PDO('sqlite:app.db');
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';

// GET /api/orders — list orders + live KPI summary
if ($path === '/api/orders' && $method === 'GET') {
    $status = $_GET['status'] ?? 'all';
    if (in_array($status, ['pending', 'in_progress', 'completed'], true)) {
        $stmt = $pdo->prepare('SELECT * FROM orders WHERE status = ? ORDER BY id DESC');
        $stmt->execute([$status]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    } else {
        $rows = $pdo->query('SELECT * FROM orders ORDER BY id DESC')->fetchAll(PDO::FETCH_ASSOC);
    }

    $stats = $pdo->query(
        "SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
                COALESCE(SUM(amount), 0) AS revenue
         FROM orders"
    )->fetch(PDO::FETCH_ASSOC);

    echo json_encode([
        'engine' => 'PHP ' . PHP_VERSION . ' · XDB SQLite 3 (ZIPP WASM)',
        'orders' => $rows,
        'stats' => $stats,
    ]);
    exit;
}

// POST /api/orders — create a new order in SQLite
if ($path === '/api/orders' && $method === 'POST') {
    $body = json_decode(file_get_contents('php://input') ?: '{}', true) ?: [];
    $customer = trim((string) ($body['customer'] ?? ''));
    $item = trim((string) ($body['item'] ?? ''));
    $amount = max(0, (float) ($body['amount'] ?? 0));

    if ($customer === '' || $item === '') {
        http_response_code(422);
        echo json_encode(['error' => 'Customer and item are required.']);
        exit;
    }

    $countRow = $pdo->query('SELECT COUNT(*) AS cnt FROM orders')->fetch(PDO::FETCH_ASSOC);
    $nextNum = 1041 + (int) ($countRow['cnt'] ?? 0);
    $code = 'ORD-' . $nextNum;

    $stmt = $pdo->prepare(
        'INSERT INTO orders (code, customer, item, amount, status) VALUES (?, ?, ?, ?, ?)'
    );
    $stmt->execute([$code, $customer, $item, $amount, 'pending']);

    $id = (int) $pdo->lastInsertId();
    http_response_code(201);
    echo json_encode([
        'order' => [
            'id' => $id,
            'code' => $code,
            'customer' => $customer,
            'item' => $item,
            'amount' => $amount,
            'status' => 'pending',
        ],
    ]);
    exit;
}

// PATCH /api/orders/:id — mark an order completed
if (preg_match('#^/api/orders/(\\d+)$#', $path, $m) && $method === 'PATCH') {
    $id = (int) $m[1];
    $body = json_decode(file_get_contents('php://input') ?: '{}', true) ?: [];
    $status = (string) ($body['status'] ?? 'completed');
    $stmt = $pdo->prepare('UPDATE orders SET status = ? WHERE id = ?');
    $stmt->execute([$status, $id]);
    echo json_encode(['ok' => true, 'id' => $id, 'status' => $status]);
    exit;
}

http_response_code(404);
echo json_encode(['error' => 'Route not found', 'path' => $path]);
`;

  const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Order Desk</title>
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <div class="app">
    <header class="topbar">
      <div>
        <div class="eyebrow">Full-Stack Browser Sandbox</div>
        <h1>Order Desk</h1>
      </div>
      <div class="runtime-pill" id="runtime-pill">Connecting to PHP + SQLite…</div>
    </header>

    <section class="stats-grid" aria-label="Order summary">
      <article class="stat-card">
        <span class="stat-label">Total orders</span>
        <strong class="stat-value" id="stat-total">—</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">Pending</span>
        <strong class="stat-value accent-amber" id="stat-pending">—</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">Completed</span>
        <strong class="stat-value accent-green" id="stat-completed">—</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">Total value</span>
        <strong class="stat-value" id="stat-revenue">—</strong>
      </article>
    </section>

    <section class="panel composer">
      <div class="panel-head">
        <h2>New order</h2>
        <span class="route-tag">POST /api/orders → backend/index.php → app.db</span>
      </div>
      <form id="order-form" class="form-grid">
        <input id="customer" type="text" placeholder="Customer name" required />
        <input id="item" type="text" placeholder="Order item or SKU" required />
        <input id="amount" type="number" step="0.01" min="0" placeholder="Amount ($)" required />
        <button type="submit" class="btn-primary">Create order</button>
      </form>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>Live SQLite orders</h2>
        <div class="filters" role="group" aria-label="Filter orders">
          <button type="button" class="filter active" data-status="all">All</button>
          <button type="button" class="filter" data-status="pending">Pending</button>
          <button type="button" class="filter" data-status="in_progress">In progress</button>
          <button type="button" class="filter" data-status="completed">Completed</button>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Customer</th>
              <th>Item</th>
              <th class="num">Amount</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="order-rows"></tbody>
        </table>
      </div>
    </section>
  </div>
  <script type="module" src="./app.js"></script>
</body>
</html>
`;

  const stylesCss = `:root {
  --bg: #f6f7f9;
  --surface: #ffffff;
  --ink: #0f172a;
  --muted: #64748b;
  --border: #e2e8f0;
  --brand: #2563eb;
  --brand-soft: #eff6ff;
  --green: #059669;
  --green-soft: #ecfdf5;
  --amber: #d97706;
  --amber-soft: #fffbeb;
}

* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, sans-serif;
  background: var(--bg);
  color: var(--ink);
  padding: 22px 24px;
}

.app {
  max-width: 960px;
  margin: 0 auto;
  display: grid;
  gap: 16px;
}

.topbar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.eyebrow {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--brand);
  margin-bottom: 3px;
}

h1 {
  margin: 0;
  font-size: 25px;
  letter-spacing: -0.02em;
}

h2 {
  margin: 0;
  font-size: 14.5px;
  font-weight: 600;
}

.runtime-pill {
  font-size: 12px;
  font-weight: 600;
  padding: 6px 12px;
  border-radius: 999px;
  background: var(--green-soft);
  color: var(--green);
  border: 1px solid #a7f3d0;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.stat-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 13px 16px;
  display: grid;
  gap: 3px;
}

.stat-label {
  font-size: 12px;
  color: var(--muted);
}

.stat-value {
  font-size: 23px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.accent-amber { color: var(--amber); }
.accent-green { color: var(--green); }

.panel {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 15px 18px;
  display: grid;
  gap: 12px;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.route-tag {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
  color: var(--brand);
  background: var(--brand-soft);
  padding: 4px 9px;
  border-radius: 6px;
}

.form-grid {
  display: grid;
  grid-template-columns: 1.1fr 1.4fr 0.7fr auto;
  gap: 10px;
}

input {
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font: inherit;
  font-size: 13.5px;
  background: #fff;
  color: var(--ink);
}

.btn-primary {
  padding: 8px 15px;
  border: none;
  border-radius: 8px;
  background: var(--brand);
  color: #fff;
  font: inherit;
  font-size: 13.5px;
  font-weight: 600;
  cursor: pointer;
}

.filters {
  display: flex;
  gap: 6px;
}

.filter {
  padding: 5px 11px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: #fff;
  color: var(--muted);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.filter.active {
  background: var(--ink);
  border-color: var(--ink);
  color: #fff;
}

.table-wrap { overflow-x: auto; }

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13.5px;
}

th {
  text-align: left;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
  padding: 7px 10px;
  border-bottom: 1px solid var(--border);
}

td {
  padding: 10px;
  border-bottom: 1px solid #f1f5f9;
  vertical-align: middle;
}

tr:last-child td { border-bottom: none; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; color: var(--brand); }

.badge {
  display: inline-block;
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 11.5px;
  font-weight: 600;
}

.badge.completed { background: var(--green-soft); color: var(--green); }
.badge.pending { background: var(--amber-soft); color: var(--amber); }
.badge.in_progress { background: var(--brand-soft); color: var(--brand); }

.btn-ghost {
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: #fff;
  color: var(--ink);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}
`;

  const appJs = `// Standard browser JavaScript calling the sandboxed PHP + SQLite backend via fetch()
let activeStatus = 'all';

const fmtMoney = (n) => '$' + Number(n || 0).toLocaleString('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const statusLabel = (s) => ({
  pending: 'Pending',
  in_progress: 'In progress',
  completed: 'Completed',
}[s] || s);

async function refresh() {
  const qs = activeStatus === 'all' ? '' : '?status=' + encodeURIComponent(activeStatus);
  const res = await fetch('/api/orders' + qs);
  const data = await res.json();

  document.getElementById('runtime-pill').textContent = '● ' + (data.engine || 'PHP + SQLite');
  document.getElementById('stat-total').textContent = String(data.stats?.total ?? 0);
  document.getElementById('stat-pending').textContent = String(data.stats?.pending ?? 0);
  document.getElementById('stat-completed').textContent = String(data.stats?.completed ?? 0);
  document.getElementById('stat-revenue').textContent = fmtMoney(data.stats?.revenue ?? 0);

  const tbody = document.getElementById('order-rows');
  tbody.innerHTML = '';
  for (const row of data.orders || []) {
    const tr = document.createElement('tr');
    tr.innerHTML = \`
      <td class="code">\${row.code}</td>
      <td><strong>\${row.customer}</strong></td>
      <td>\${row.item}</td>
      <td class="num">\${fmtMoney(row.amount)}</td>
      <td><span class="badge \${row.status}">\${statusLabel(row.status)}</span></td>
      <td class="num">\${row.status !== 'completed' ? \`<button class="btn-ghost" data-complete="\${row.id}">Complete</button>\` : ''}</td>
    \`;
    tbody.appendChild(tr);
  }
}

document.getElementById('order-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const customer = document.getElementById('customer');
  const item = document.getElementById('item');
  const amount = document.getElementById('amount');
  const postRes = await fetch('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer: customer.value.trim(),
      item: item.value.trim(),
      amount: Number(amount.value),
    }),
  });
  if (!postRes.ok) return;
  customer.value = '';
  item.value = '';
  amount.value = '';
  await refresh();
});

document.getElementById('order-rows').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-complete]');
  if (!btn) return;
  await fetch('/api/orders/' + btn.dataset.complete, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'completed' }),
  });
  await refresh();
});

document.querySelectorAll('.filter').forEach((btn) => {
  btn.addEventListener('click', () => {
    activeStatus = btn.dataset.status;
    document.querySelectorAll('.filter').forEach((b) => b.classList.toggle('active', b === btn));
    void refresh();
  });
});

void refresh();
`;

  return zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
    'index.html': strToU8(indexHtml),
    'styles.css': strToU8(stylesCss),
    'app.js': strToU8(appJs),
    'backend/index.php': strToU8(backendPhp),
    'backend/schema.sql': strToU8(schemaSql),
  }, { level: 6 });
}

function startStaticServer(rootDir, fixtureBytes, fixtureUrlPath) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
      if (reqUrl.pathname === fixtureUrlPath) {
        res.writeHead(200, { 'Content-Type': 'application/zip' });
        res.end(fixtureBytes);
        return;
      }
      let rel = decodeURIComponent(reqUrl.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const full = path.resolve(rootDir, '.' + rel);
      if (!full.startsWith(rootDir)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      let file = full;
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        if (fs.existsSync(path.join(file, 'index.html'))) {
          file = path.join(file, 'index.html');
        } else {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
      }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, origin: `http://127.0.0.1:${addr.port}` });
    });
  });
}

const bundle = buildOrderDeskBundle();
const fixturePath = '/__readme_orderdesk.softn';
const { server, origin } = process.env.STUDIO_URL
  ? { server: null, origin: new URL(process.env.STUDIO_URL).origin }
  : await startStaticServer(distDir, bundle, fixturePath);

const studioUrl = process.env.STUDIO_URL || `${origin}/studio/`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 920 },
  deviceScaleFactor: 1.5,
  colorScheme: 'light',
  reducedMotion: 'reduce',
  serviceWorkers: 'block',
});

// Capture handles to closed ShadowRoots solely for test assertions & live form interaction.
await context.addInitScript(() => {
  const orig = Element.prototype.attachShadow;
  window.__softnCapturedRoots = [];
  Element.prototype.attachShadow = function (init) {
    const root = orig.call(this, init);
    window.__softnCapturedRoots.push(root);
    return root;
  };
});

const errors = [];
context.on('page', (page) => page.on('pageerror', (err) => errors.push(err.message)));
if (server === null) {
  await context.route((url) => url.pathname === fixturePath,
    (route) => route.fulfill({ body: bundle, contentType: 'application/zip' }));
}
await mkdir(here, { recursive: true });

const capture = async (page, filename) => {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({
    path: path.join(here, filename),
    type: 'jpeg',
    quality: 90,
    animations: 'disabled',
  });
};

const queryShadow = async (page, fn, arg) => {
  return page.evaluate(([source, param]) => {
    const roots = window.__softnCapturedRoots || [];
    const fnImpl = new Function('root', 'param', source);
    for (let i = roots.length - 1; i >= 0; i--) {
      const res = fnImpl(roots[i], param);
      if (res !== undefined && res !== null && res !== false) return res;
    }
    return null;
  }, [fn, arg]);
};

try {
  const page = await context.newPage();
  await page.goto(`${studioUrl}?open=${encodeURIComponent(fixturePath)}`, { waitUntil: 'domcontentloaded' });

  // Open the Files drawer so the full-stack project files (index.html, app.js, backend/index.php, backend/schema.sql)
  // are visible right next to the live running PHP + SQLite app!
  await page.getByRole('button', { name: 'Files', exact: true }).click();

  // Wait for the sandboxed PHP + SQLite backend to return the 5 seeded orders.
  await expect.poll(async () => {
    return queryShadow(page, `
      const total = root.querySelector('#stat-total');
      const pill = root.querySelector('#runtime-pill');
      return total && pill && pill.textContent.includes('PHP') ? total.textContent.trim() : null;
    `);
  }, { timeout: 30000 }).toBe('5');

  // Exercise a live POST /api/orders -> PHP 8 PDO -> SQLite INSERT using real mouse + keyboard input!
  const getBox = async (selector) => {
    return queryShadow(page, `
      const el = root.querySelector(param);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    `, selector);
  };
  const typeInto = async (selector, text) => {
    const pt = await getBox(selector);
    expect(pt).not.toBeNull();
    await page.mouse.click(pt.x, pt.y);
    await page.keyboard.type(text);
  };
  await typeInto('#customer', 'Summit Bikes');
  await typeInto('#item', 'Carbon Wheelset (Pair)');
  await typeInto('#amount', '940');
  const submitPt = await getBox('#order-form button[type="submit"]');
  expect(submitPt).not.toBeNull();
  await page.mouse.click(submitPt.x, submitPt.y);

  await expect.poll(async () => {
    return queryShadow(page, `
      const total = root.querySelector('#stat-total');
      const text = root.textContent || '';
      return total && text.includes('Summit Bikes') ? total.textContent.trim() : null;
    `);
  }, { timeout: 15000 }).toBe('6');

  // 1) Screenshot: Live full-stack PHP + SQLite app running in SoftN Studio alongside the file tree
  await capture(page, 'fullstack-preview.jpg');

  // 2) Screenshot: Open backend/index.php in Code view (clicking a .php file switches straight to Code)
  await page.getByText('index.php', { exact: true }).first().click();
  await expect(page.getByText("new PDO('sqlite:app.db')")).toBeVisible({ timeout: 10000 });
  await capture(page, 'fullstack-backend-code.jpg');

  // 3) Screenshot: Open full-width Data tab showing live XDB SQLite 3 database explorer
  await page.getByRole('button', { name: 'Data', exact: true }).click();
  await expect(page.getByText('orders').first()).toBeVisible({ timeout: 20000 });
  await expect(page.getByText('Northside Roasters').first()).toBeVisible({ timeout: 20000 });
  await capture(page, 'fullstack-sqlite-data.jpg');

  expect(errors).toEqual([]);
  console.log('Captured fullstack-preview.jpg, fullstack-backend-code.jpg, and fullstack-sqlite-data.jpg cleanly.');
} finally {
  await browser.close();
  server?.close();
}
