/**
 * Round-5 & View-Source SSR / SEO / Sitemap / ETag regression suite:
 *   - `/app/<slug>` and `/play/<slug>` emit sanitized rendered HTML5 for both
 *     Classic `.ui` and Container v2 `.html` apps, plus JSON-LD and Twitter/OG meta
 *   - `withholdBackend` apps never leak backend source into rendered HTML
 *   - Unknown `/app/<slug>` pages include `<meta name="robots" content="noindex" />`
 *   - Conditional GET (`ETag` / `If-None-Match`) returns `304 Not Modified`
 *   - `/sitemap-apps.xml` lists public apps with `<lastmod>`, skips hidden apps,
 *     and returns 404 when `siteOrigin` is not configured
 *   - `POST /api/categories` refuses colliding app directory names (409)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startServer, skip } from './helpers/harness.mjs';

const require = createRequire(import.meta.url);
const { zipSync, strToU8 } = require('fflate');

const SITE = 'https://apps.softn.test';
const servers = [];
after(() => servers.forEach((s) => s.stop()));

test('hosted /app and /play pages emit sanitized View-Source SSR HTML, JSON-LD, and ETag/304', skip, async () => {
  const s = await startServer({
    prefix: 'softn-seo-ssr-',
    config: { siteOrigin: SITE, seedDemos: false },
  });
  servers.push(s);

  // 1. Classic .ui bundle with static UI + dynamic expressions + script/logic tags
  const uiBundle = zipSync({
    'manifest.json': strToU8(
      JSON.stringify({
        name: 'Field Notes',
        version: '2.1.0',
        description: 'Offline field notes and checklists.',
        main: 'ui/main.ui',
        files: { ui: ['ui/main.ui'], logic: ['logic/main.logic'] },
      })
    ),
    'ui/main.ui': strToU8(
      '<logic src="../logic/main.logic" />\n' +
        '<App>\n' +
        '  <Heading level={1}>Daily Field Checklist</Heading>\n' +
        '  <Text>Inspect equipment before shift start.</Text>\n' +
        '  <Button label="Add Entry" />\n' +
        '  <Link href="https://docs.example.test/guide">Read Guide</Link>\n' +
        '  <Link href="javascript:alert(1)">Bad Link</Link>\n' +
        '  <Text>{"Static literal"} {secretRuntimeVar}</Text>\n' +
        '</App>\n'
    ),
    'logic/main.logic': strToU8('let secretRuntimeVar = "DO_NOT_RENDER_LOGIC";\n'),
  });
  const uiFd = new FormData();
  uiFd.set('bundle', new Blob([uiBundle]), 'field-notes.softn');
  uiFd.set('name', 'Field Notes');
  const pubUiRes = await s.api('POST', '/api/apps', { body: uiFd, headers: { 'X-Admin-Key': s.adminKey } });
  assert.equal(pubUiRes.status, 201, pubUiRes.text);
  const uiSlug = pubUiRes.json.app.slug;

  // Fetch /app/<slug> WITHOUT Accept: text/html (crawlers / View Source / curl)
  const shareRes = await fetch(`${s.base}/app/${uiSlug}`);
  assert.equal(shareRes.status, 200);
  const shareEtag = shareRes.headers.get('etag');
  assert.ok(shareEtag, 'share page sends an ETag');
  assert.equal(shareRes.headers.get('cache-control'), 'no-cache');
  const shareHtml = await shareRes.text();
  assert.match(shareHtml, /data-softn-ssr="app"/);
  assert.match(shareHtml, /data-softn-preview="rendered"/);
  assert.match(shareHtml, /<h1>Field Notes<\/h1>/);
  assert.match(shareHtml, /<h2>Daily Field Checklist<\/h2>/);
  assert.match(shareHtml, /<p>Inspect equipment before shift start\.<\/p>/);
  assert.match(shareHtml, /<button type="button">Add Entry<\/button>/);
  assert.match(shareHtml, /<a href="https:\/\/docs\.example\.test\/guide" rel="noopener noreferrer">Read Guide<\/a>/);
  assert.doesNotMatch(shareHtml, /javascript:alert/);
  assert.doesNotMatch(shareHtml, /DO_NOT_RENDER_LOGIC/);
  assert.doesNotMatch(shareHtml, /secretRuntimeVar/);
  assert.match(shareHtml, /name="twitter:title" content="Field Notes — SoftN"/);
  const ldMatch = shareHtml.match(/<script type="application\/ld\+json">(.*?)<\/script>/s);
  assert.ok(ldMatch, 'share page includes JSON-LD');
  const ld = JSON.parse(ldMatch[1]);
  assert.equal(ld['@type'], 'WebApplication');
  assert.equal(ld.name, 'Field Notes');
  assert.equal(ld.url, `${SITE}/app/${uiSlug}`);
  assert.equal(ld.softwareVersion, String(pubUiRes.json.app.version));

  // Conditional GET returns 304 Not Modified
  const share304 = await fetch(`${s.base}/app/${uiSlug}`, {
    headers: { 'If-None-Match': shareEtag },
  });
  assert.equal(share304.status, 304);
  assert.equal(await share304.text(), '');

  // Play page carries rendered HTML inside #boot, JSON-LD, and ETag/304
  const playRes = await fetch(`${s.base}/play/${uiSlug}`, { headers: { Accept: 'text/html' } });
  assert.equal(playRes.status, 200);
  const playEtag = playRes.headers.get('etag');
  assert.ok(playEtag, 'play page sends an ETag');
  const playHtml = await playRes.text();
  assert.match(playHtml, /id="boot"/);
  assert.match(playHtml, /data-softn-ssr="play"/);
  assert.match(playHtml, /Daily Field Checklist/);
  assert.match(playHtml, /application\/ld\+json/);
  const play304 = await fetch(`${s.base}/play/${uiSlug}`, {
    headers: { Accept: 'text/html', 'If-None-Match': playEtag },
  });
  assert.equal(play304.status, 304);

  // Unknown app page stays 200 for SPA routing and marks robots noindex
  const missingHtml = await (await fetch(`${s.base}/app/definitely-missing-app`)).text();
  assert.match(missingHtml, /<meta name="robots" content="noindex" \/>/);

  // 2. Container v2 HTML bundle with hostile script/iframe/onerror + withheld PHP backend
  const v2Bundle = zipSync({
    'manifest.json': strToU8(
      JSON.stringify({
        engine: 2,
        name: 'Ledger Board',
        version: '1.0.0',
        description: 'Multi-user ledger app.',
        main: 'public/index.html',
        frontendRoot: 'public',
        backend: { runtime: 'php', entry: 'backend/index.php' },
      })
    ),
    'public/index.html': strToU8(
      '<!doctype html><html><head><title>Ledger</title><style>body{color:red}</style></head>' +
        '<body><main><h1>Ledger Overview</h1><p onclick="alert(1)">Track balances safely.</p>' +
        '<script>window.pwn=1</script><iframe src="https://evil.test"></iframe>' +
        '<a href="https://ledger.example.test">Docs</a><a href="javascript:evil()">Evil</a></main></body></html>'
    ),
    'backend/index.php': strToU8('<?php echo "SUPER_SECRET_BACKEND_SOURCE"; ?>'),
  });
  const fd = new FormData();
  fd.set('bundle', new Blob([v2Bundle]), 'ledger.softn');
  fd.set('name', 'Ledger Board');
  fd.set('hosting', 'server');
  fd.set('withholdBackend', 'true');
  const pubV2 = await s.api('POST', '/api/apps', { body: fd, headers: { 'X-Admin-Key': s.adminKey } });
  assert.equal(pubV2.status, 201, pubV2.text);
  const v2Slug = pubV2.json.app.slug;

  const v2Html = await (await fetch(`${s.base}/app/${v2Slug}`)).text();
  assert.match(v2Html, /<h2>Ledger Overview<\/h2>/);
  assert.match(v2Html, /<p>Track balances safely\.<\/p>/);
  assert.doesNotMatch(v2Html, /onclick=/);
  assert.doesNotMatch(v2Html, /window\.pwn/);
  assert.doesNotMatch(v2Html, /<iframe/);
  assert.doesNotMatch(v2Html, /javascript:evil/);
  assert.doesNotMatch(v2Html, /SUPER_SECRET_BACKEND_SOURCE/);

  // 3. Dynamic XML sitemap lists public apps, excludes hidden ones, supports ETag/304
  const hiddenApp = await s.publish('Hidden App');
  await s.api('DELETE', `/api/apps/${hiddenApp.app.slug}`, {
    headers: { 'X-Edit-Key': hiddenApp.editKey },
  });
  const smRes = await fetch(`${s.base}/sitemap-apps.xml`);
  assert.equal(smRes.status, 200);
  assert.match(smRes.headers.get('content-type') ?? '', /^application\/xml/);
  const smEtag = smRes.headers.get('etag');
  assert.ok(smEtag);
  const smXml = await smRes.text();
  assert.match(smXml, new RegExp(`<loc>${SITE}/app/${uiSlug}</loc>`));
  assert.match(smXml, new RegExp(`<loc>${SITE}/app/${v2Slug}</loc>`));
  assert.doesNotMatch(smXml, new RegExp(hiddenApp.app.slug));
  const sm304 = await fetch(`${s.base}/sitemap-apps.xml`, { headers: { 'If-None-Match': smEtag } });
  assert.equal(sm304.status, 304);

  // 4. Category suggestion cannot collide with an existing app folder on disk
  const collide = await s.api('POST', '/api/categories', {
    body: { name: uiSlug, description: 'Attempted hijack' },
  });
  assert.equal(collide.status, 409, collide.text);
});

test('/sitemap-apps.xml returns 404 when siteOrigin is not configured', skip, async () => {
  const bare = await startServer({ prefix: 'softn-sitemap-bare-', config: { seedDemos: false } });
  servers.push(bare);
  const res = await fetch(`${bare.base}/sitemap-apps.xml`);
  assert.equal(res.status, 404);
});
