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
import fs from 'node:fs';
import path from 'node:path';
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
  assert.match(shareHtml, /<a href="https:\/\/docs\.example\.test\/guide" rel="nofollow ugc noopener noreferrer">Read Guide<\/a>/);
  assert.doesNotMatch(shareHtml, /javascript:alert/);
  assert.doesNotMatch(shareHtml, /DO_NOT_RENDER_LOGIC/);
  assert.doesNotMatch(shareHtml, /secretRuntimeVar/);
  assert.match(shareHtml, /name="twitter:title" content="Field Notes — SoftN"/);
  const ldMatch = shareHtml.match(/<script type="application\/ld\+json">(.*?)<\/script>/s);
  assert.ok(ldMatch, 'share page includes JSON-LD');
  const ld = JSON.parse(ldMatch[1]);
  assert.equal(ld['@type'], 'WebApplication');
  assert.equal(ld.applicationCategory, 'UtilitiesApplication');
  assert.equal(ld.name, 'Field Notes');
  assert.equal(ld.url, `${SITE}/app/${uiSlug}`);
  assert.equal(ld.softwareVersion, String(pubUiRes.json.app.version));

  // Conditional GET returns 304 Not Modified (including Apache mod_deflate `-gzip` ETag suffix)
  const share304 = await fetch(`${s.base}/app/${uiSlug}`, {
    headers: { 'If-None-Match': shareEtag },
  });
  assert.equal(share304.status, 304);
  assert.equal(await share304.text(), '');
  const shareGzip304 = await fetch(`${s.base}/app/${uiSlug}`, {
    headers: { 'If-None-Match': shareEtag.replace(/"$/, '-gzip"') },
  });
  assert.equal(shareGzip304.status, 304);

  // Play page carries rendered HTML inside #boot, preload link for bundle, JSON-LD, and ETag/304
  const playRes = await fetch(`${s.base}/play/${uiSlug}`, { headers: { Accept: 'text/html' } });
  assert.equal(playRes.status, 200);
  const playEtag = playRes.headers.get('etag');
  assert.ok(playEtag, 'play page sends an ETag');
  const playHtml = await playRes.text();
  assert.match(playHtml, /<link rel="preload" href="\/api\/apps\/[^"]+\/bundle\.softn\?[^"]+" as="fetch" crossorigin="anonymous" fetchpriority="high" \/>/);
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
  assert.match(v2Html, /<a href="https:\/\/ledger\.example\.test" rel="nofollow ugc noopener noreferrer">Docs<\/a>/);
  assert.doesNotMatch(v2Html, /data-softn-preview="rendered"[\s\S]*?<main\b/);
  assert.doesNotMatch(v2Html, /onclick=/);
  assert.doesNotMatch(v2Html, /window\.pwn/);
  assert.doesNotMatch(v2Html, /<iframe/);
  assert.doesNotMatch(v2Html, /javascript:evil/);
  assert.doesNotMatch(v2Html, /SUPER_SECRET_BACKEND_SOURCE/);
  assert.match(v2Html, /"@type":"BreadcrumbList"/);

  // 2b. Container v2 SPA bundle (`<div id="app"></div>` + frontend JS `html\`...\`` templates)
  const spaBundle = zipSync({
    'manifest.json': strToU8(
      JSON.stringify({
        engine: 2,
        name: 'Farm Desk',
        version: '1.0.0',
        description: 'Paddock & harvest tracker.',
        main: 'index.html',
        backend: { runtime: 'php', entry: 'server/index.php' },
      })
    ),
    'index.html': strToU8('<!doctype html><html><head><title>Farm Desk</title></head><body><div id="app"></div><script type="module" src="./js/main.js"></script></body></html>'),
    'js/main.js': strToU8(
      'export function view(s){ return html`<section><h1>Paddock Status</h1><p>Active spray schedule for ${s.name}.</p><button>Log Harvest</button></section>`; }'
    ),
    'server/index.php': strToU8('<?php echo "PRIVATE_FARM_SECRET"; ?>'),
  });
  const spaFd = new FormData();
  spaFd.set('bundle', new Blob([spaBundle]), 'farm.softn');
  spaFd.set('name', 'Farm Desk');
  const pubSpa = await s.api('POST', '/api/apps', { body: spaFd, headers: { 'X-Admin-Key': s.adminKey } });
  assert.equal(pubSpa.status, 201, pubSpa.text);
  const spaSlug = pubSpa.json.app.slug;
  const spaHtml = await (await fetch(`${s.base}/app/${spaSlug}`)).text();
  assert.match(spaHtml, /<h2>Paddock Status<\/h2>/);
  assert.match(spaHtml, /<button type="button">Log Harvest<\/button>/);
  assert.doesNotMatch(spaHtml, /PRIVATE_FARM_SECRET/);

  // 2c. Live-captured ssr.html snapshot (tagged with full source bundle sha256) overrides
  // static extraction even when withholdBackend is active, and is strictly sanitized.
  const spaDir = path.join(s.dataDir, 'apps', spaSlug);
  const spaMeta = JSON.parse(fs.readFileSync(path.join(spaDir, 'app.json'), 'utf8'));
  const spaSha = spaMeta.versions?.at(-1)?.sha256 ?? '';
  assert.match(spaSha, /^[a-f0-9]{64}$/);
  fs.writeFileSync(
    path.join(spaDir, 'ssr.html'),
    `<!-- softn-ssr-sha256: ${spaSha} -->\n<main><h1 onclick="evil()">Live Captured Farm Board</h1><p>12 paddocks monitored</p><script>alert(1)</script></main>`,
    'utf8'
  );
  const snapPlayHtml = await (await fetch(`${s.base}/play/${spaSlug}`, { headers: { Accept: 'text/html' } })).text();
  assert.match(snapPlayHtml, /data-softn-ssr="play"/);
  assert.match(snapPlayHtml, /<h2>Live Captured Farm Board<\/h2>/);
  assert.match(snapPlayHtml, /<p>12 paddocks monitored<\/p>/);
  assert.doesNotMatch(snapPlayHtml, /onclick=/);
  assert.doesNotMatch(snapPlayHtml, /alert\(1\)/);

  // Recording a run increments `runs` and surfaces in WebApplication JSON-LD interactionStatistic
  await s.api('POST', `/api/apps/${spaSlug}/runs`);
  const spaWithRunsHtml = await (await fetch(`${s.base}/app/${spaSlug}`)).text();
  assert.match(spaWithRunsHtml, /"userInteractionCount":1/);

  // 2d. Directory (/apps) and Publish (/publish) pages emit full SSR HTML and SEO metadata
  const dirRes = await fetch(`${s.base}/apps`);
  assert.equal(dirRes.status, 200);
  const dirHtml = await dirRes.text();
  assert.match(dirHtml, /data-softn-ssr="directory"/);
  assert.match(dirHtml, /"@type":"CollectionPage"/);
  assert.match(dirHtml, /"@type":"ItemList"/);
  assert.match(dirHtml, /"@type":"BreadcrumbList"/);
  assert.match(dirHtml, new RegExp(`href="/app/${uiSlug}"`));
  assert.match(dirHtml, new RegExp(`href="/app/${spaSlug}"`));
  const dirQueryHtml = await (await fetch(`${s.base}/apps?q=farm`)).text();
  assert.match(dirQueryHtml, /<meta name="robots" content="noindex,follow" \/>/);
  const dirTagHtml = await (await fetch(`${s.base}/apps?tag=notes`)).text();
  assert.match(dirTagHtml, /<meta name="robots" content="noindex,follow" \/>/);
  const dirEmptyCatHtml = await (await fetch(`${s.base}/apps?category=no-such-category-xyz`)).text();
  assert.match(dirEmptyCatHtml, /<meta name="robots" content="noindex,follow" \/>/);

  const pubPageHtml = await (await fetch(`${s.base}/publish`)).text();
  assert.match(pubPageHtml, /data-softn-ssr="publish"/);
  assert.match(pubPageHtml, /Publish a SoftN App/);

  // 3. Dynamic XML sitemap lists public apps + image tags, excludes hidden ones, supports ETag/304
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
  assert.match(smXml, /xmlns:image="http:\/\/www\.google\.com\/schemas\/sitemap-image\/1\.1"/);
  assert.match(smXml, new RegExp(`<loc>${SITE}/app/${uiSlug}</loc>`));
  assert.match(smXml, new RegExp(`<image:loc>${SITE}/api/apps/${uiSlug}/thumbnail`));
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

test('Round-7 API/SSR hardening: unclosed <script> stripped, unknown /app drops canonical, POST /apps is 405, JSON has X-Robots-Tag, malformed Range is 416', skip, async () => {
  const s = await startServer({
    prefix: 'softn-r7-hardening-',
    config: { seedDemos: false, siteOrigin: SITE },
  });
  servers.push(s);

  const rawZip = zipSync({
    'manifest.json': strToU8(JSON.stringify({ name: 'Unclosed Script App', version: '1.0.0', main: 'index.html' })),
    'index.html': strToU8('<!doctype html><html><body><h1>Safe Heading</h1><script>var secret = "NEVER_SHOW_THIS";'),
  });
  const fd = new FormData();
  fd.set('bundle', new Blob([rawZip]), 'unclosed.softn');
  fd.set('name', 'Unclosed Script App');
  const pubRes = await s.api('POST', '/api/apps', { body: fd, headers: { 'X-Admin-Key': s.adminKey } });
  assert.equal(pubRes.status, 201, pubRes.text);
  const slug = pubRes.json.app.slug;

  const playHtml = await (await fetch(`${s.base}/play/${slug}`)).text();
  assert.match(playHtml, /Safe Heading/);
  assert.doesNotMatch(playHtml, /NEVER_SHOW_THIS/);

  const unknownAppRes = await fetch(`${s.base}/app/no-such-app-r7`);
  assert.equal(unknownAppRes.status, 200);
  const unknownAppHtml = await unknownAppRes.text();
  assert.match(unknownAppHtml, /<meta name="robots" content="noindex" \/>/);
  assert.doesNotMatch(unknownAppHtml, /<link rel="canonical"/);
  assert.doesNotMatch(unknownAppHtml, /property="og:url"/);

  const postApps = await fetch(`${s.base}/apps`, { method: 'POST' });
  assert.equal(postApps.status, 405);

  const apiApps = await fetch(`${s.base}/api/apps`);
  assert.equal(apiApps.status, 200);
  assert.equal(apiApps.headers.get('x-robots-tag'), 'noindex');

  const badRange = await fetch(`${s.base}/api/apps/${slug}/source/file?path=index.html`, {
    headers: { Range: 'bytes=-' },
  });
  assert.equal(badRange.status, 416);
});
