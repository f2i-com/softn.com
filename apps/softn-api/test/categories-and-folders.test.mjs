/**
 * Main categories + subcategories, hierarchical folder layout (`data/apps/<cat>/<sub/>/<slug>/`),
 * auto-generated `category.json` caches & custom full display names, drag-and-drop `.softn` adoption
 * with icon extraction & version suffix history, and backup/restore round-trip of nested trees.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { apiDir, makeBundle, PNG_1x1, startServer as server, skip } from './helpers/harness.mjs';

const require = createRequire(import.meta.url);
const { strToU8 } = require('fflate');

const SAFE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#2563eb"/><circle cx="32" cy="32" r="16" fill="#fff"/></svg>';

test('categorized folder tree: auto category.json, custom full names, subcategories, and rolled-up counts', skip, async () => {
  const s = await server({
    prefix: 'softn-cat-tree-',
    config: { seedDemos: false, folderLayout: 'categorized' },
  });
  try {
    // Create nested category/subcategory folders and drop loose .softn files straight into them!
    const games3d = path.join(s.dataDir, 'apps', 'games', '3d');
    const gamesArcade = path.join(s.dataDir, 'apps', 'games', 'arcade');
    const gamesRacing = path.join(s.dataDir, 'apps', 'games', 'drift-racing');
    const toolsDir = path.join(s.dataDir, 'apps', 'tools');
    fs.mkdirSync(games3d, { recursive: true });
    fs.mkdirSync(gamesArcade, { recursive: true });
    fs.mkdirSync(gamesRacing, { recursive: true });
    fs.mkdirSync(toolsDir, { recursive: true });

    // Custom category.json with a full display name distinct from the folder name ("drift-racing")
    fs.writeFileSync(
      path.join(gamesRacing, 'category.json'),
      JSON.stringify({ name: 'Drift & Circuit Racing', description: 'High-speed drift tracks', emoji: '🏎️', sort: 25 }, null, 2),
    );

    // Drop loose .softn bundles directly into category & subcategory folders:
    // 1) With explicit manifest.icon
    fs.writeFileSync(
      path.join(games3d, 'voxel-island.softn'),
      makeBundle('Voxel Island', { icon: { path: 'assets/icon.svg', bytes: SAFE_SVG } }),
    );
    // 2) Without manifest.icon, relying on automatic fallback icon discovery (`icon.svg` in bundle root)
    fs.writeFileSync(
      path.join(gamesArcade, 'duck-dash.softn'),
      makeBundle('Duck Dash', { extra: { 'icon.svg': strToU8(SAFE_SVG) } }),
    );
    // 3) Inside custom-named subcategory folder
    fs.writeFileSync(
      path.join(gamesRacing, 'turbo-drift.softn'),
      makeBundle('Turbo Drift'),
    );
    // 4) Directly inside a main category folder (no subcategory)
    fs.writeFileSync(
      path.join(toolsDir, 'quick-calc.softn'),
      makeBundle('Quick Calc'),
    );

    // First request triggers automatic adoption, icon extraction, app.json creation, and category.json caching.
    const allRes = await s.api('GET', '/api/apps');
    assert.equal(allRes.status, 200);
    assert.equal(allRes.json.total, 4);

    // Verify loose .softn files were organized into <slug>/v1.softn with auto-generated app.json & icons
    assert.ok(fs.existsSync(path.join(games3d, 'voxel-island', 'v1.softn')));
    assert.ok(fs.existsSync(path.join(games3d, 'voxel-island', 'app.json')));
    assert.ok(fs.existsSync(path.join(games3d, 'voxel-island', 'icon.svg')));
    assert.ok(!fs.existsSync(path.join(games3d, 'voxel-island.softn')), 'loose file was moved into app folder');

    assert.ok(fs.existsSync(path.join(gamesArcade, 'duck-dash', 'v1.softn')));
    assert.ok(fs.existsSync(path.join(gamesArcade, 'duck-dash', 'icon.svg')), 'fallback icon.svg extracted automatically');
    assert.equal(JSON.parse(fs.readFileSync(path.join(gamesArcade, 'duck-dash', 'app.json'), 'utf8')).app.icon, 'icon.svg');

    // Verify category.json was auto-created for games, games/3d, games/arcade, tools — and custom name preserved for drift-racing
    const gamesMeta = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'apps', 'games', 'category.json'), 'utf8'));
    assert.equal(gamesMeta.name, 'Games');
    assert.equal(gamesMeta.cache.appCount, 3, 'games rolls up all subcategory apps');
    assert.deepEqual(gamesMeta.cache.subcategories, ['3d', 'arcade', 'drift-racing']);

    const racingMeta = JSON.parse(fs.readFileSync(path.join(gamesRacing, 'category.json'), 'utf8'));
    assert.equal(racingMeta.name, 'Drift & Circuit Racing', 'custom display name preserved');
    assert.equal(racingMeta.emoji, '🏎️');
    assert.equal(racingMeta.cache.appCount, 1);
    assert.deepEqual(racingMeta.cache.apps, ['turbo-drift']);

    // Verify GET /api/categories returns rolled-up main count and nested subcategories
    const catsRes = await s.api('GET', '/api/categories');
    assert.equal(catsRes.status, 200);
    const gamesCat = catsRes.json.categories.find((c) => c.id === 'games');
    assert.ok(gamesCat);
    assert.equal(gamesCat.apps, 3);
    assert.equal(gamesCat.directApps, 0);
    const racingSub = gamesCat.subcategories.find((sub) => sub.slug === 'drift-racing');
    assert.ok(racingSub);
    assert.equal(racingSub.id, 'games/drift-racing');
    assert.equal(racingSub.name, 'Drift & Circuit Racing');
    assert.equal(racingSub.apps, 1);

    // Filtering by main category returns ALL games across all subcategories
    const onlyGames = await s.api('GET', '/api/apps?category=games');
    assert.equal(onlyGames.json.total, 3);
    assert.deepEqual(onlyGames.json.apps.map((a) => a.slug).sort(), ['duck-dash', 'turbo-drift', 'voxel-island']);

    // Filtering by subcategory (both ?category=games&subcategory=3d and shorthand ?category=games/3d)
    const only3d = await s.api('GET', '/api/apps?category=games&subcategory=3d');
    assert.equal(only3d.json.total, 1);
    assert.equal(only3d.json.apps[0].slug, 'voxel-island');
    assert.equal(only3d.json.apps[0].subcategory, '3d');
    assert.equal(only3d.json.apps[0].categoryPath, 'games/3d');

    const shorthand = await s.api('GET', '/api/apps?category=games/drift-racing');
    assert.equal(shorthand.json.total, 1);
    assert.equal(shorthand.json.apps[0].slug, 'turbo-drift');

    // Bundle download, icon serving, and source view work from nested paths
    const iconResp = await fetch(`${s.base}/api/apps/duck-dash/icon`);
    assert.equal(iconResp.status, 200);
    assert.match(iconResp.headers.get('content-type') || '', /image\/svg\+xml/);
    const bundleResp = await fetch(`${s.base}/api/apps/voxel-island/bundle.softn`);
    assert.equal(bundleResp.status, 200);
    assert.ok((await bundleResp.arrayBuffer()).byteLength > 50);
  } finally {
    await s.stop();
  }
});

test('dropping an updated .softn increments version suffixes (v2.softn) and deduplicates identical bytes', skip, async () => {
  const s = await server({
    prefix: 'softn-drop-versions-',
    config: { seedDemos: false, folderLayout: 'categorized' },
  });
  try {
    const arcadeDir = path.join(s.dataDir, 'apps', 'games', 'arcade');
    fs.mkdirSync(arcadeDir, { recursive: true });
    const v1Bytes = makeBundle('Duck Dash', { version: '1.0.0' });
    fs.writeFileSync(path.join(arcadeDir, 'duck-dash.softn'), v1Bytes);

    let detail = (await s.api('GET', '/api/apps/duck-dash')).json.app;
    assert.equal(detail.version, 1);
    assert.equal(detail.versions.length, 1);

    // Dropping identical bytes again does not create a redundant v2
    fs.writeFileSync(path.join(arcadeDir, 'duck-dash.softn'), v1Bytes);
    detail = (await s.api('GET', '/api/apps/duck-dash')).json.app;
    assert.equal(detail.version, 1);
    assert.ok(!fs.existsSync(path.join(arcadeDir, 'duck-dash.softn')));

    // Dropping updated bytes automatically creates v2.softn and preserves v1.softn
    const v2Bytes = makeBundle('Duck Dash', { version: '1.1.0', extra: { 'notes.txt': strToU8('v2 update') } });
    fs.writeFileSync(path.join(arcadeDir, 'duck-dash-v2.softn'), v2Bytes);
    detail = (await s.api('GET', '/api/apps/duck-dash')).json.app;
    assert.equal(detail.version, 2);
    assert.equal(detail.versions.length, 2);
    assert.ok(fs.existsSync(path.join(arcadeDir, 'duck-dash', 'v1.softn')));
    assert.ok(fs.existsSync(path.join(arcadeDir, 'duck-dash', 'v2.softn')));

    // Dropping a thumb.png directly into the app folder is auto-detected on next request
    fs.writeFileSync(path.join(arcadeDir, 'duck-dash', 'thumb.png'), PNG_1x1);
    detail = (await s.api('GET', '/api/apps/duck-dash')).json.app;
    assert.equal(detail.thumbnailKind, 'image');
  } finally {
    await s.stop();
  }
});

test('moving folders on disk or PATCHing category/subcategory updates layout, app.json, and category caches dynamically', skip, async () => {
  const s = await server({
    prefix: 'softn-move-cat-',
    config: { seedDemos: false, folderLayout: 'categorized' },
  });
  try {
    // Publish via API directly into games/arcade
    const fd = new FormData();
    fd.append('bundle', new Blob([makeBundle('Star Hopper')]), 'star-hopper.softn');
    fd.append('category', 'games');
    fd.append('subcategory', 'arcade');
    const pub = await s.api('POST', '/api/apps', { body: fd, headers: { 'X-Admin-Key': s.adminKey } });
    assert.equal(pub.status, 201, pub.text);
    assert.equal(pub.json.app.category, 'games');
    assert.equal(pub.json.app.subcategory, 'arcade');
    assert.ok(fs.existsSync(path.join(s.dataDir, 'apps', 'games', 'arcade', 'star-hopper', 'v1.softn')));

    // PATCH category/subcategory via API moves the folder to games/3d
    const patched = await s.api('PATCH', '/api/apps/star-hopper', {
      body: { category: 'games', subcategory: '3d' },
      headers: { 'X-Edit-Key': pub.json.editKey },
    });
    assert.equal(patched.status, 200, patched.text);
    assert.equal(patched.json.app.subcategory, '3d');
    assert.ok(!fs.existsSync(path.join(s.dataDir, 'apps', 'games', 'arcade', 'star-hopper')));
    assert.ok(fs.existsSync(path.join(s.dataDir, 'apps', 'games', '3d', 'star-hopper', 'v1.softn')));

    // Moving the folder manually on disk to games/story dynamically updates app.json & API
    const storyDir = path.join(s.dataDir, 'apps', 'games', 'story');
    fs.mkdirSync(storyDir, { recursive: true });
    fs.renameSync(
      path.join(s.dataDir, 'apps', 'games', '3d', 'star-hopper'),
      path.join(storyDir, 'star-hopper'),
    );
    const afterMove = (await s.api('GET', '/api/apps/star-hopper')).json.app;
    assert.equal(afterMove.category, 'games');
    assert.equal(afterMove.subcategory, 'story');

    // Legacy ?category=story alias finds apps in games/story
    const legacy = (await s.api('GET', '/api/apps?category=story')).json;
    assert.equal(legacy.total, 1);
    assert.equal(legacy.apps[0].slug, 'star-hopper');

    // Suggesting a new subcategory under games creates it and makes it immediately usable
    const suggested = await s.api('POST', '/api/categories', {
      body: { name: 'Rhythm', description: 'Beat and music games', emoji: '🥁', parent: 'games' },
    });
    assert.equal(suggested.status, 201, suggested.text);
    assert.equal(suggested.json.category.id, 'games/rhythm');
    assert.equal(suggested.json.category.parent, 'games');
    assert.ok(fs.existsSync(path.join(s.dataDir, 'apps', 'games', 'rhythm', 'category.json')));
  } finally {
    await s.stop();
  }
});

test('an app named after a subcategory folder gets a name of its own, and the folder and the apps in it stay', skip, async () => {
  // Published as "Arcade" into games, the bundle and app.json were written
  // into games/arcade/ itself. The next scan read that folder as the app:
  // every app filed under it answered 404, its slug could be published
  // again, and purging the squatter deleted the apps' folders with it.
  const s = await server({
    prefix: 'softn-cat-squat-',
    config: { seedDemos: false, folderLayout: 'categorized' },
  });
  try {
    const arcadeDir = path.join(s.dataDir, 'apps', 'games', 'arcade');
    await s.publish('Star Hopper', {}, { category: 'games', subcategory: 'arcade' });
    assert.ok(fs.existsSync(path.join(arcadeDir, 'star-hopper', 'v1.softn')));

    // A visitor, with no key: the name of the subcategory, filed straight into its category.
    const publishAs = async (name, fields = {}) => {
      const fd = new FormData();
      fd.append('bundle', new Blob([makeBundle(name)]), 'app.softn');
      fd.append('name', name);
      for (const [k, v] of Object.entries(fields)) fd.append(k, v);
      return s.api('POST', '/api/apps', { body: fd });
    };
    const squat = await publishAs('Arcade', { category: 'games' });
    assert.equal(squat.status, 201, squat.text);
    assert.notEqual(squat.json.app.slug, 'arcade', 'the subcategory folder is not an app\'s to take');
    assert.equal(squat.json.app.category, 'games');
    assert.equal(squat.json.app.subcategory, null);
    assert.ok(!fs.existsSync(path.join(arcadeDir, 'app.json')), 'nothing was written into the subcategory folder');
    assert.ok(!fs.existsSync(path.join(arcadeDir, 'v1.softn')));
    assert.ok(fs.existsSync(path.join(s.dataDir, 'apps', 'games', squat.json.app.slug, 'v1.softn')));

    // The next request scans the tree again: the subcategory and its app are where they were.
    assert.equal((await s.api('GET', '/api/apps/star-hopper')).status, 200);
    const inArcade = (await s.api('GET', '/api/apps?category=games&subcategory=arcade')).json;
    assert.deepEqual(inArcade.apps.map((a) => a.slug), ['star-hopper']);
    const games = (await s.api('GET', '/api/categories')).json.categories.find((c) => c.id === 'games');
    assert.equal(games.subcategories.find((sub) => sub.slug === 'arcade').apps, 1);

    // A subcategory the site starts with, before it has a folder: its name is kept for it too,
    // or the first app filed under it would be put inside the app that took it.
    assert.ok(!fs.existsSync(path.join(s.dataDir, 'apps', 'games', 'puzzle')));
    const early = await publishAs('Puzzle', { category: 'games' });
    assert.equal(early.status, 201, early.text);
    assert.notEqual(early.json.app.slug, 'puzzle');
    const filed = await publishAs('Sliding Tiles', { category: 'games', subcategory: 'puzzle' });
    assert.equal(filed.status, 201, filed.text);
    assert.equal((await s.api('GET', '/api/apps/sliding-tiles')).json.app.subcategory, 'puzzle');

    // The folders an app's own runtime data goes in are passed over by the scan, so no app is named for one.
    const runtime = await publishAs('Backend Data', { category: 'games' });
    assert.equal(runtime.status, 201, runtime.text);
    assert.notEqual(runtime.json.app.slug, 'backend-data');
    assert.equal((await s.api('GET', `/api/apps/${runtime.json.app.slug}`)).status, 200);

    // Purging the app that asked for the name removes that app's folder and no other.
    const purged = await s.api('DELETE', `/api/apps/${squat.json.app.slug}?purge=1`, { headers: { 'X-Admin-Key': s.adminKey } });
    assert.equal(purged.status, 204, purged.text);
    assert.ok(fs.existsSync(path.join(arcadeDir, 'star-hopper', 'v1.softn')), 'the apps filed under the subcategory are untouched');
    assert.equal((await s.api('GET', '/api/apps/star-hopper')).status, 200);

    // The same name elsewhere is no one's folder, and is free.
    const elsewhere = await publishAs('Retro', { category: 'tools' });
    assert.equal(elsewhere.status, 201, elsewhere.text);
    assert.equal(elsewhere.json.app.slug, 'retro');

    // Refiled under games by its owner, that app is not moved to where the subcategory's folder goes.
    assert.ok(!fs.existsSync(path.join(s.dataDir, 'apps', 'games', 'retro')));
    const refiled = await s.api('PATCH', '/api/apps/retro', { body: { category: 'games' }, headers: { 'X-Edit-Key': elsewhere.json.editKey } });
    assert.equal(refiled.status, 200, refiled.text);
    assert.ok(!fs.existsSync(path.join(s.dataDir, 'apps', 'games', 'retro')), 'the subcategory\'s name is still its own');
    assert.ok(fs.existsSync(path.join(s.dataDir, 'apps', 'tools', 'retro', 'v1.softn')));
    assert.equal((await s.api('GET', '/api/apps/retro')).status, 200);
  } finally {
    await s.stop();
  }
});

test('a legacy category id takes a subcategory its category has, and makes none', skip, async () => {
  // `story` and `strategy` moved under games. Whatever subcategory was sent
  // beside one was taken as written: a folder and a listed, approved
  // subcategory of that name, with none of what a suggestion is held to.
  const s = await server({
    prefix: 'softn-cat-alias-',
    config: { seedDemos: false, folderLayout: 'categorized' },
  });
  try {
    const alone = await s.publish('Lantern Tale', {}, { category: 'story' });
    assert.deepEqual([alone.app.category, alone.app.subcategory], ['games', 'story']);
    // Another of games' subcategories, by its slug or by its name.
    const bySlug = await s.publish('Maze Tale', {}, { category: 'story', subcategory: 'puzzle' });
    assert.deepEqual([bySlug.app.category, bySlug.app.subcategory], ['games', 'puzzle']);
    const byName = await s.publish('Card Tale', {}, { category: 'strategy', subcategory: 'Retro & Tabletop' });
    assert.deepEqual([byName.app.category, byName.app.subcategory], ['games', 'retro']);

    // A visitor, with no key, and a subcategory games does not have: the app goes where the id moved.
    const fd = new FormData();
    fd.append('bundle', new Blob([makeBundle('Shelf Tale')]), 'app.softn');
    fd.append('category', 'strategy');
    fd.append('subcategory', 'A Shelf Of My Own');
    const made = await s.api('POST', '/api/apps', { body: fd });
    assert.equal(made.status, 201, made.text);
    assert.deepEqual([made.json.app.category, made.json.app.subcategory], ['games', 'strategy']);
    assert.ok(!fs.existsSync(path.join(s.dataDir, 'apps', 'games', 'a-shelf-of-my-own')), 'no folder was made for it');
    assert.ok(fs.existsSync(path.join(s.dataDir, 'apps', 'games', 'strategy', 'shelf-tale', 'v1.softn')));
    const games = (await s.api('GET', '/api/categories')).json.categories.find((c) => c.id === 'games');
    assert.ok(!games.subcategories.some((sub) => sub.slug === 'a-shelf-of-my-own'), 'and no subcategory is listed');
  } finally {
    await s.stop();
  }
});

test('backup.php export, verify, and restore round-trips nested category/subcategory directories', skip, async () => {
  const s = await server({
    prefix: 'softn-nested-backup-',
    config: { seedDemos: false, folderLayout: 'categorized' },
  });
  const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-nested-restore-'));
  try {
    const fd = new FormData();
    fd.append('bundle', new Blob([makeBundle('Nested Backup App', { permissions: { storage: { enabled: true } } })]), 'nested.softn');
    fd.append('category', 'business');
    fd.append('subcategory', 'hospitality');
    const pub = await s.api('POST', '/api/apps', { body: fd, headers: { 'X-Admin-Key': s.adminKey } });
    assert.equal(pub.status, 201, pub.text);

    // Write a storage record so storage.sqlite exists inside the nested folder
    const st = await s.api('POST', `/api/apps/${pub.json.app.slug}/storage`, {
      body: { op: 'insert', collection: 'orders', data: { item: 'Latte' } },
    });
    assert.equal(st.status, 200, st.text);

    const archive = path.join(tmpOut, 'nested.zip');
    const restored = path.join(tmpOut, 'restored');
    const backupScript = path.join(apiDir, 'backup.php');

    const exp = spawnSync('php', [backupScript, 'export', archive, '--data', s.dataDir], { encoding: 'utf8' });
    assert.equal(exp.status, 0, exp.stderr + exp.stdout);

    const ver = spawnSync('php', [backupScript, 'verify', archive], { encoding: 'utf8' });
    assert.equal(ver.status, 0, ver.stderr + ver.stdout);

    const res = spawnSync('php', [backupScript, 'restore', archive, '--into', restored], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.ok(fs.existsSync(path.join(restored, 'apps', 'business', 'hospitality', 'nested-backup-app', 'v1.softn')));
    assert.ok(fs.existsSync(path.join(restored, 'apps', 'business', 'hospitality', 'category.json')));
    assert.ok(fs.existsSync(path.join(restored, 'apps', 'business', 'hospitality', 'nested-backup-app', 'storage.sqlite')));
  } finally {
    await s.stop();
    fs.rmSync(tmpOut, { recursive: true, force: true });
  }
});
