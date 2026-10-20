#!/usr/bin/env node
/**
 * Publish every app in the folder into a running SoftN site, screenshots and all.
 *
 *   npm run apps:publish -- --site https://example.com --admin-key <key> [--dir <folder>] [--category games]
 *
 * One POST /api/apps per bundle with its name, description, category, tags,
 * author and the screenshot from thumbs/ as the thumbnail; the admin key
 * (data/config.json on the server) is what lets a whole folder in past the
 * ten-an-hour visitor limit. An app the site already has, by id, is left
 * alone and said so. Each new app's edit key is printed once — keep them.
 *
 * No dependencies: Node 22.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const dirArg = flag('--dir', process.env.SOFTN_APPS_DIR || '');
const demosDir = dirArg ? path.resolve(process.cwd(), dirArg) : path.join(here, 'apps');
const site = (flag('--site', process.env.SOFTN_SITE_URL || '') || '').replace(/\/+$/, '');
const adminKey = flag('--admin-key', process.env.SOFTN_ADMIN_KEY || '');
const defaultCategory = flag('--category', 'demos');
if (!site) {
  console.error('Usage: npm run apps:publish -- --site https://example.com --admin-key <key>');
  process.exit(1);
}

const index = JSON.parse(fs.readFileSync(path.join(demosDir, 'index.json'), 'utf8'));
let published = 0;
let skipped = 0;
let failed = 0;
for (const entry of index) {
  const existing = await fetch(`${site}/api/apps/${encodeURIComponent(entry.id)}`, { headers: { Accept: 'application/json' } });
  if (existing.ok) {
    skipped++;
    console.log(`${entry.file.padEnd(28)} already there as /app/${entry.id}`);
    continue;
  }
  const fd = new FormData();
  fd.append('bundle', new Blob([fs.readFileSync(path.join(demosDir, entry.file))], { type: 'application/zip' }), entry.file);
  fd.append('name', entry.name);
  if (entry.description) fd.append('description', entry.description);
  fd.append('category', entry.category || defaultCategory);
  if (entry.tags) fd.append('tags', entry.tags);
  fd.append('author', entry.author || 'SoftN');
  if (entry.primary) fd.append('primary', entry.primary);
  const base = entry.file.replace(/\.softn$/i, '');
  const shot = ['webp', 'png', 'jpg'].map((ext) => path.join(demosDir, 'thumbs', `${base}.${ext}`)).find((p) => fs.existsSync(p));
  if (shot) fd.append('thumbnail', new Blob([fs.readFileSync(shot)], { type: `image/${path.extname(shot).slice(1)}` }), path.basename(shot));
  const res = await fetch(`${site}/api/apps`, { method: 'POST', body: fd, headers: adminKey ? { 'X-Admin-Key': adminKey } : {} });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Not the API's answer: a host that dropped the upload serves a page.
  }
  if (!res.ok || !json || json.ok !== true) {
    failed++;
    const why = json && json.error
      ? json.error
      : json
        ? text.slice(0, 200)
        : `the host answered ${res.status} with a page, not JSON — an upload limit below ${(entry.size / 1048576).toFixed(1)} MB? (api/.user.ini asks for 64 MB)`;
    console.error(`${entry.file.padEnd(28)} FAILED: ${why}`);
    continue;
  }
  published++;
  console.log(`${entry.file.padEnd(28)} published as ${site}${json.page}${json.editKey ? `  edit key ${json.editKey}` : ''}`);
}
console.log(`\n${published} published, ${skipped} already there, ${failed} failed`);
if (failed) process.exit(1);
