import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { markSvg } from './brand-mark.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const normalizeNewlines = text => text.replace(/\r\n/g, '\n');

test('shared geometry preserves the current website and runtime SVGs', () => {
  for (const [app, ground] of [['softn-site', '#101317'], ['softn-web', '#0c0a09']]) {
    assert.equal(markSvg(ground), normalizeNewlines(fs.readFileSync(path.join(root, 'apps', app, 'public/favicon.svg'), 'utf8')));
  }
});

test('extracting shared geometry leaves the existing web PWA artwork unchanged', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-web-icons-check-'));
  const files = ['favicon.svg', 'pwa-192x192.png', 'pwa-512x512.png', 'pwa-maskable-512x512.png'];
  try {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/generate-icons.mjs'), temporary, '--ground', '#0c0a09'], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    for (const name of files.filter(name => name.endsWith('.png'))) {
      assert.deepEqual(fs.readFileSync(path.join(temporary, 'public', name)), fs.readFileSync(path.join(root, 'apps/softn-web/public', name)), name);
    }
  } finally {
    for (const name of files) fs.rmSync(path.join(temporary, 'public', name), { force: true });
    if (fs.existsSync(path.join(temporary, 'public'))) fs.rmdirSync(path.join(temporary, 'public'));
    fs.rmdirSync(temporary);
  }
});

test('both native packs use the current mark, valid platform containers and adaptive backgrounds', async () => {
  for (const app of ['softn-loader', 'softn-builder']) {
    const icons = path.join(root, 'apps', app, 'src-tauri/icons');
    const image = await loadImage(path.join(icons, '128x128@2x.png'));
    assert.equal(image.width, 256);
    assert.equal(image.height, 256);
    const canvas = createCanvas(256, 256);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    assert.deepEqual([...context.getImageData(128, 128, 1, 1).data], [53, 224, 192, 255], `${app} center is the mint dot`);
    assert.equal(context.getImageData(0, 0, 1, 1).data[3], 0, 'desktop tile corners stay transparent');
    const ico = fs.readFileSync(path.join(icons, 'icon.ico'));
    assert.equal(ico.readUInt16LE(2), 1);
    assert.ok(ico.readUInt16LE(4) >= 4, 'Windows icon includes several resolutions');
    const icns = fs.readFileSync(path.join(icons, 'icon.icns'));
    assert.equal(icns.subarray(0, 4).toString(), 'icns');
    assert.equal(icns.readUInt32BE(4), icns.length);
    assert.match(fs.readFileSync(path.join(icons, 'android/values/ic_launcher_background.xml'), 'utf8'), />#101317</);
    assert.match(fs.readFileSync(path.join(icons, 'android/mipmap-anydpi-v26/ic_launcher.xml'), 'utf8'), /ic_launcher_monochrome/);
    assert.ok(fs.statSync(path.join(icons, 'android/mipmap-xxxhdpi/ic_launcher_monochrome.png')).size > 0);
  }
});
