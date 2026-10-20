import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { markSvg } from './brand-mark.mjs';
import { repoRoot as root } from '../lib/paths.mjs';

const normalizeNewlines = text => text.replace(/\r\n/g, '\n');

// The generator draws with @napi-rs/canvas, which a checkout does not install
// (scripts/brand/generate-icons.mjs says why); drawing the PNGs again is checked
// where it is installed.
const canvas = await import('@napi-rs/canvas').then(() => true, () => false);
const NEEDS_CANVAS = canvas ? false : 'drawing the PNGs needs @napi-rs/canvas (npm install --no-save @napi-rs/canvas@0.1.88)';

/** An 8-bit RGBA PNG's pixels, read with nothing but zlib: the header, the joined data, and each row unfiltered. */
function readPng(bytes) {
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  let at = 8, width = 0, height = 0, depth = 0, colour = 0;
  const data = [];
  while (at < bytes.length) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.subarray(at + 4, at + 8).toString();
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') ({ width, height, depth, colour } = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], colour: body[9] });
    if (type === 'IDAT') data.push(body);
    at += 12 + length;
  }
  assert.equal(depth, 8, 'an 8-bit PNG');
  assert.equal(colour, 6, 'an RGBA PNG');
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? pixels[y * stride + x - 4] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? pixels[(y - 1) * stride + x - 4] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predicted = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
      pixels[y * stride + x] = (line[x] + predicted) & 0xff;
    }
  }
  return { width, height, pixel: (x, y) => [...pixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)] };
}

test('shared geometry preserves the current website and runtime SVGs', () => {
  for (const [app, ground] of [['softn-site', '#101317'], ['softn-web', '#0c0a09']]) {
    assert.equal(markSvg(ground), normalizeNewlines(fs.readFileSync(path.join(root, 'apps', app, 'public/favicon.svg'), 'utf8')));
  }
});

test('extracting shared geometry leaves the existing web PWA artwork unchanged', { skip: NEEDS_CANVAS }, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-web-icons-check-'));
  const files = ['favicon.svg', 'pwa-192x192.png', 'pwa-512x512.png', 'pwa-maskable-512x512.png'];
  try {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/brand/generate-icons.mjs'), temporary, '--ground', '#0c0a09'], { encoding: 'utf8', windowsHide: true });
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

test('both native packs use the current mark, valid platform containers and adaptive backgrounds', () => {
  for (const app of ['softn-loader', 'softn-builder']) {
    const icons = path.join(root, 'apps', app, 'src-tauri/icons');
    const image = readPng(fs.readFileSync(path.join(icons, '128x128@2x.png')));
    assert.equal(image.width, 256);
    assert.equal(image.height, 256);
    assert.deepEqual(image.pixel(128, 128), [53, 224, 192, 255], `${app} center is the mint dot`);
    assert.equal(image.pixel(0, 0)[3], 0, 'desktop tile corners stay transparent');
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
