#!/usr/bin/env node
/**
 * Builds `examples/mobile-fieldkit/mobile-fieldkit.softn`:
 * A full-stack SoftN v2 Web + Android Mobile app showcasing:
 * - Same `.softn` bundle running unchanged on Web (`@softn/container`) AND Android (`zipp-browser` APK)
 * - Embedded PHP 8 REST API (`backend/index.php`) + persistent SQLite 3 (`backend/schema.sql`)
 * - Cross-platform Hardware Bridges (`softn:device`, `softn:haptics`, `softn:camera`,
 *   `softn:bluetooth`, `softn:location`, `softn:notifications`) gated by `permission.json`
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'mobile-fieldkit.softn');

const manifest = {
  id: 'softn.mobile.fieldkit',
  name: 'SoftN FieldKit',
  version: '1.0.0',
  description: 'Full-stack offline field inspection & hardware sensor app running identically on Web and Android.',
  engine: 2,
  main: 'index.html',
  theme: 'dark',
  backend: {
    runtime: 'php',
    entry: 'backend/index.php',
    mode: 'api',
    routes: ['/api/'],
  },
  databases: [
    {
      name: 'fieldkit',
      engine: 'sqlite',
      file: 'fieldkit.db',
      seedSql: 'backend/schema.sql',
    },
  ],
};

const permissionJson = {
  permissions: {
    camera: { enabled: true },
    bluetooth: { enabled: true },
    location: { enabled: true },
    haptics: { enabled: true },
    notifications: { enabled: true },
  },
};

const schemaSql = `
CREATE TABLE IF NOT EXISTS inspections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  sensor TEXT NOT NULL DEFAULT 'Manual',
  status TEXT NOT NULL DEFAULT 'open',
  coords TEXT NOT NULL DEFAULT '',
  photo_url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO inspections (title, sensor, status, coords) VALUES
  ('Turbine Bearing Temperature OK (42.3C)', 'BLE Thermal Probe', 'verified', '-33.8688, 151.2093'),
  ('Substation Panel Seal Visual Check', 'Camera Capture', 'open', '-33.8691, 151.2087'),
  ('Backup Battery Voltage 24.4V Nominal', 'BLE BMS Sensor', 'verified', '-33.8685, 151.2098');
`;

const backendPhp = `<?php
header('Content-Type: application/json; charset=utf-8');

$pdo = new PDO('sqlite:fieldkit.db');
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
$uri = $_SERVER['REQUEST_URI'] ?? '/';
$path = parse_url($uri, PHP_URL_PATH) ?: '/';
$bodyRaw = file_get_contents('php://input') ?: '';
$input = json_decode($bodyRaw, true);
if (!is_array($input)) {
    $input = [];
}

if ($method === 'GET' && $path === '/api/inspections') {
    $rows = $pdo->query('SELECT id, title, sensor, status, coords, photo_url, created_at FROM inspections ORDER BY id DESC')->fetchAll(PDO::FETCH_ASSOC);
    $verified = 0;
    foreach ($rows as $r) {
        if (($r['status'] ?? '') === 'verified') {
            $verified++;
        }
    }
    echo json_encode([
        'ok' => true,
        'backend' => 'PHP ' . PHP_VERSION . ' on ZIPP VM + SQLite 3',
        'total' => count($rows),
        'verified' => $verified,
        'items' => $rows,
    ]);
    exit;
}

if ($method === 'POST' && $path === '/api/inspections') {
    $title = trim((string)($input['title'] ?? ''));
    if ($title === '') {
        http_response_code(400);
        echo json_encode(['ok' => false, 'error' => 'Inspection note is required']);
        exit;
    }
    $sensor = trim((string)($input['sensor'] ?? 'Field Entry'));
    $coords = trim((string)($input['coords'] ?? ''));
    $photo = trim((string)($input['photo_url'] ?? ''));
    $stmt = $pdo->prepare('INSERT INTO inspections (title, sensor, status, coords, photo_url) VALUES (?, ?, ?, ?, ?)');
    $stmt->execute([$title, $sensor, 'open', $coords, $photo]);
    $id = (int)$pdo->lastInsertId();
    $row = $pdo->query('SELECT id, title, sensor, status, coords, photo_url, created_at FROM inspections WHERE id = ' . $id)->fetch(PDO::FETCH_ASSOC);
    http_response_code(201);
    echo json_encode(['ok' => true, 'item' => $row]);
    exit;
}

if ($method === 'POST' && preg_match('#^/api/inspections/(\\d+)/toggle$#', $path, $m)) {
    $id = (int)$m[1];
    $stmt = $pdo->prepare('SELECT status FROM inspections WHERE id = ?');
    $stmt->execute([$id]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) {
        http_response_code(404);
        echo json_encode(['ok' => false, 'error' => 'Inspection not found']);
        exit;
    }
    $next = ($row['status'] === 'verified') ? 'open' : 'verified';
    $upd = $pdo->prepare('UPDATE inspections SET status = ? WHERE id = ?');
    $upd->execute([$next, $id]);
    echo json_encode(['ok' => true, 'id' => $id, 'status' => $next]);
    exit;
}

http_response_code(404);
echo json_encode(['ok' => false, 'error' => 'Route not found: ' . $method . ' ' . $path]);
`;

const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SoftN FieldKit</title>
  <link rel="stylesheet" href="softn:ui.css">
  <link rel="stylesheet" href="./styles.css">
  <script type="module" src="./app.js"></script>
</head>
<body>
  <div id="app" class="shell">
    <div class="hero">
      <div class="row between">
        <div>
          <div class="eyebrow">SOFTN CONTAINER V2 • FULL-STACK</div>
          <h1>FieldKit</h1>
        </div>
        <span id="platform-pill" class="pill">Booting...</span>
      </div>
      <div id="runtime-meta" class="meta">Starting ZIPP engine + PHP 8 + SQLite 3...</div>
    </div>

    <div class="section">
      <div class="section-title">HARDWARE BRIDGE</div>
      <div class="bridge-grid">
        <button id="btn-haptic" class="bridge-btn" type="button">Haptic Pulse</button>
        <button id="btn-ble" class="bridge-btn" type="button">Scan BLE</button>
        <button id="btn-gps" class="bridge-btn" type="button">GPS Fix</button>
        <button id="btn-camera" class="bridge-btn" type="button">Take Photo</button>
        <button id="btn-notify" class="bridge-btn" type="button">Send Alert</button>
        <button id="btn-quick" class="bridge-btn accent" type="button">+ Quick Log</button>
      </div>
      <div id="bridge-status" class="status-box">Ready. Tap any hardware action to test the native bridge.</div>
      <div id="photo-preview"></div>
    </div>

    <div class="section">
      <div class="row between">
        <div class="section-title">SQLITE INSPECTIONS (PHP 8 API)</div>
        <span id="stats-pill" class="pill subtle">0 / 0</span>
      </div>
      <form id="log-form" class="entry-form">
        <input id="note-input" type="text" placeholder="Enter field inspection note..." value="">
        <button id="save-btn" class="save-btn" type="submit">Save</button>
      </form>
      <div id="log-list" class="log-list"></div>
    </div>
  </div>
</body>
</html>`;

const stylesCss = `
body {
  background: #0b1120;
  color: #f8fafc;
  font-family: system-ui, -apple-system, sans-serif;
  margin: 0;
  padding: 0;
}
.shell {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.hero {
  background: linear-gradient(135deg, #1d4ed8 0%, #0f172a 100%);
  border: 1px solid #334155;
  border-radius: 16px;
  padding: 16px;
}
.eyebrow {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: #93c5fd;
  margin-bottom: 4px;
}
h1 {
  margin: 0;
  font-size: 24px;
  font-weight: 800;
  color: #ffffff;
}
.meta {
  margin-top: 8px;
  font-size: 12px;
  color: #cbd5e1;
}
.pill {
  display: inline-block;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  background: rgba(16, 185, 129, 0.22);
  color: #6ee7b7;
  border: 1px solid rgba(16, 185, 129, 0.4);
}
.pill.subtle {
  background: rgba(59, 130, 246, 0.18);
  color: #93c5fd;
  border-color: rgba(59, 130, 246, 0.35);
}
.section {
  background: #111c33;
  border: 1px solid #24324d;
  border-radius: 14px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.section-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: #94a3b8;
}
.bridge-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.bridge-btn {
  flex: 1 1 30%;
  min-width: 96px;
  padding: 10px 8px;
  border-radius: 10px;
  border: 1px solid #334155;
  background: #1e293b;
  color: #f8fafc;
  font-size: 13px;
  font-weight: 600;
  text-align: center;
}
.bridge-btn.accent {
  background: #2563eb;
  border-color: #3b82f6;
  color: #ffffff;
}
.status-box {
  background: #0b1222;
  border: 1px solid #1e293b;
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 12px;
  color: #cbd5e1;
}
.entry-form {
  display: flex;
  flex-direction: row;
  gap: 8px;
}
.entry-form input {
  flex: 1;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid #334155;
  background: #0b1222;
  color: #ffffff;
  font-size: 14px;
}
.save-btn {
  padding: 10px 16px;
  border-radius: 10px;
  border: none;
  background: #10b981;
  color: #052e16;
  font-weight: 800;
  font-size: 13px;
}
.log-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.log-card {
  background: #16223a;
  border: 1px solid #263654;
  border-radius: 12px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.log-card.verified {
  border-left: 4px solid #10b981;
}
.log-card.open {
  border-left: 4px solid #f59e0b;
}
.log-title {
  font-size: 14px;
  font-weight: 700;
  color: #f8fafc;
}
.log-meta {
  font-size: 12px;
  color: #94a3b8;
  display: flex;
  justify-content: space-between;
}
.photo-thumb {
  width: 100%;
  max-height: 180px;
  border-radius: 10px;
  border: 1px solid #334155;
  margin-top: 4px;
}
`;

const appJs = `
import { getInfo } from 'softn:device';
import { impact } from 'softn:haptics';
import { scan as scanBle } from 'softn:bluetooth';
import { takePhoto } from 'softn:camera';
import { getCurrentPosition } from 'softn:location';
import { notify } from 'softn:notifications';

let lastCoords = '';
let lastSensor = 'Field Entry';
let lastPhotoUrl = '';
let quickSeq = 1;

function setStatus(msg) {
  const el = document.getElementById('bridge-status');
  if (el) el.textContent = msg;
}

async function refreshInspections() {
  try {
    const res = await fetch('/api/inspections');
    const data = await res.json();
    const stats = document.getElementById('stats-pill');
    if (stats) stats.textContent = data.verified + ' / ' + data.total + ' verified';
    const list = document.getElementById('log-list');
    if (!list) return;
    list.innerHTML = '';
    for (const item of data.items || []) {
      const card = document.createElement('div');
      card.className = 'log-card ' + (item.status === 'verified' ? 'verified' : 'open');

      const title = document.createElement('div');
      title.className = 'log-title';
      title.textContent = (item.status === 'verified' ? '[OK] ' : '[OPEN] ') + item.title;
      card.appendChild(title);

      const meta = document.createElement('div');
      meta.className = 'log-meta';
      const left = document.createElement('span');
      left.textContent = item.sensor + (item.coords ? ' • ' + item.coords : '');
      const right = document.createElement('span');
      right.textContent = 'Tap to toggle';
      meta.appendChild(left);
      meta.appendChild(right);
      card.appendChild(meta);

      if (item.photo_url) {
        const img = document.createElement('img');
        img.className = 'photo-thumb';
        img.setAttribute('src', item.photo_url);
        card.appendChild(img);
      }

      card.addEventListener('click', async () => {
        impact('light').catch(() => {});
        await fetch('/api/inspections/' + item.id + '/toggle', { method: 'POST' });
        setStatus('Toggled inspection #' + item.id + ' in SQLite');
        await refreshInspections();
      });

      list.appendChild(card);
    }
  } catch (err) {
    setStatus('Backend error: ' + (err && err.message ? err.message : String(err)));
  }
}

async function saveInspection(titleText) {
  const title = String(titleText || '').trim();
  if (!title) return;
  const res = await fetch('/api/inspections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title,
      sensor: lastSensor,
      coords: lastCoords,
      photo_url: lastPhotoUrl,
    }),
  });
  const data = await res.json();
  if (data.ok) {
    lastPhotoUrl = '';
    const pv = document.getElementById('photo-preview');
    if (pv) pv.innerHTML = '';
    setStatus('Saved #' + data.item.id + ' to persistent SQLite via PHP 8');
    await refreshInspections();
  } else {
    setStatus('Save error: ' + (data.error || 'unknown'));
  }
}

async function boot() {
  try {
    const info = await getInfo();
    const pill = document.getElementById('platform-pill');
    if (pill) pill.textContent = (info.platform || 'unknown').toUpperCase();
    const meta = document.getElementById('runtime-meta');
    if (meta) {
      meta.textContent =
        (info.engine || 'softn') +
        ' • ' +
        (info.model || info.osVersion || '') +
        ' • PHP 8 + SQLite 3 (offline)';
    }
  } catch (err) {
    setStatus('Device info failed: ' + err.message);
  }

  document.getElementById('btn-haptic').addEventListener('click', async () => {
    try {
      const r = await impact('heavy');
      setStatus('Haptics impact sent (ok=' + Boolean(r && r.ok) + ')');
    } catch (err) {
      setStatus('Haptics: ' + err.message);
    }
  });

  document.getElementById('btn-ble').addEventListener('click', async () => {
    setStatus('Scanning nearby Bluetooth LE devices...');
    try {
      const res = await scanBle({ durationMs: 2000 });
      const count = (res && res.devices ? res.devices.length : 0);
      if (count > 0) {
        lastSensor = 'BLE: ' + res.devices[0].name;
        setStatus('BLE found ' + count + ' device(s): ' + res.devices.map((d) => d.name + ' (' + d.id + ')').join(', '));
      } else {
        setStatus('BLE scan complete: 0 nearby peripherals found');
      }
    } catch (err) {
      setStatus('Bluetooth: ' + err.message);
    }
  });

  document.getElementById('btn-gps').addEventListener('click', async () => {
    setStatus('Requesting GPS coordinates...');
    try {
      const pos = await getCurrentPosition({ highAccuracy: true });
      lastCoords = pos.latitude.toFixed(4) + ', ' + pos.longitude.toFixed(4);
      setStatus('GPS fix: ' + lastCoords + ' (+/- ' + Math.round(pos.accuracy || 0) + 'm)');
    } catch (err) {
      setStatus('Location: ' + err.message);
    }
  });

  document.getElementById('btn-camera').addEventListener('click', async () => {
    setStatus('Opening camera...');
    try {
      const photo = await takePhoto({ facing: 'environment', maxWidth: 640, quality: 0.8 });
      lastPhotoUrl = photo.dataUrl;
      lastSensor = 'Camera (' + photo.width + 'x' + photo.height + ')';
      const pv = document.getElementById('photo-preview');
      if (pv) {
        pv.innerHTML = '';
        const img = document.createElement('img');
        img.className = 'photo-thumb';
        img.setAttribute('src', photo.dataUrl);
        pv.appendChild(img);
      }
      setStatus('Captured ' + photo.width + 'x' + photo.height + ' photo (' + Math.round(photo.size / 1024) + ' KB)');
    } catch (err) {
      setStatus('Camera: ' + err.message);
    }
  });

  document.getElementById('btn-notify').addEventListener('click', async () => {
    try {
      await notify({ title: 'SoftN FieldKit', body: 'Inspection log synced to local SQLite!' });
      setStatus('System notification posted!');
    } catch (err) {
      setStatus('Notification: ' + err.message);
    }
  });

  document.getElementById('btn-quick').addEventListener('click', async () => {
    impact('medium').catch(() => {});
    const n = quickSeq++;
    await saveInspection('Field Check #' + n + ' — Pump Pressure Nominal');
  });

  document.getElementById('log-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const inp = document.getElementById('note-input');
    const val = inp ? inp.value : '';
    if (!val.trim()) return;
    if (inp) inp.value = '';
    await saveInspection(val);
  });

  await refreshInspections();
}

boot();
`;

const zipped = zipSync(
  {
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
    'permission.json': strToU8(JSON.stringify(permissionJson, null, 2)),
    'backend/schema.sql': strToU8(schemaSql),
    'backend/index.php': strToU8(backendPhp),
    'index.html': strToU8(indexHtml),
    'styles.css': strToU8(stylesCss),
    'app.js': strToU8(appJs),
  },
  { level: 9 }
);

fs.writeFileSync(OUT, zipped);
console.log(`[mobile-fieldkit] Built ${OUT} (${zipped.byteLength} bytes)`);
