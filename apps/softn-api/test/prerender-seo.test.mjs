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

test('multi-page hosted SoftN website: per-page URLs, per-page View-Source HTML & SEO, link rewriting, 404s, and sitemap', skip, async () => {
  const s = await startServer({
    prefix: 'softn-multipage-seo-',
    config: { seedDemos: false, siteOrigin: SITE },
  });
  servers.push(s);

  const siteZip = zipSync({
    'manifest.json': strToU8(
      JSON.stringify({
        engine: 2,
        name: 'Harborline Studio',
        version: '1.0.0',
        description: 'Multi-page studio website hosted in a single SoftN bundle.',
        main: 'index.html',
      })
    ),
    'index.html': strToU8(
      '<!doctype html><html lang="en"><head>' +
        '<title>Harborline Studio — Craft Software & Design</title>' +
        '<meta name="description" content="Home of Harborline Studio: fast, local-first web apps and design systems." />' +
        '</head><body>' +
        '<header><nav><a href="/">Home</a><a href="/about.html">About</a><a href="pricing.html">Pricing</a><a href="/blog/">Blog</a></nav></header>' +
        '<main><h1>Welcome to Harborline</h1><p>One archive, multiple SEO-ready pages.</p>' +
        '<a href="blog/sandboxed-web.html">Read our latest article</a>' +
        '<a href="https://example.org/ext">External Reference</a>' +
        '<a href="javascript:alert(1)">Bad Script Link</a>' +
        '</main></body></html>'
    ),
    'about.html': strToU8(
      '<!doctype html><html lang="en"><head>' +
        '<title>About Harborline Studio</title>' +
        '<meta name="description" content="Meet the engineers and designers behind Harborline Studio." />' +
        '</head><body>' +
        '<header><nav><a href="index.html">Home</a><a href="pricing.html">Pricing</a></nav></header>' +
        '<main><h1>About Our Team</h1><p>Founded in Melbourne to build calm software.</p></main>' +
        '</body></html>'
    ),
    'pricing.html': strToU8(
      '<!doctype html><html lang="en"><head>' +
        '<title>Pricing — Harborline Studio</title>' +
        '<meta name="description" content="Transparent flat-rate plans for teams of every size." />' +
        '<meta name="robots" content="index,follow,noarchive" />' +
        '</head><body>' +
        '<main><h1>Simple Pricing</h1><p>Starter tier starts at $29 per month.</p></main>' +
        '</body></html>'
    ),
    'blog/index.html': strToU8(
      '<!doctype html><html lang="en"><head>' +
        '<title>Journal — Harborline Studio</title>' +
        '<meta name="description" content="Notes on architecture, sandboxing, and web craft." />' +
        '</head><body>' +
        '<main><h1>Studio Journal</h1><p><a href="sandboxed-web.html">Sandboxed Web Apps</a></p><p><a href="../">Back Home</a></p></main>' +
        '</body></html>'
    ),
    'blog/sandboxed-web.html': strToU8(
      '<!doctype html><html lang="en"><head>' +
        '<title>Building Sandboxed Multi-Page Websites — Harborline</title>' +
        '<meta name="description" content="How SoftN combines real View-Source HTML with sandboxed execution." />' +
        '</head><body>' +
        '<article><h1>Sandboxed Multi-Page Websites</h1><p>Every route renders clean semantic HTML on the server.</p>' +
        '<nav><a href="index.html">All Articles</a><a href="../about.html">About Us</a><a href="../">Home</a></nav>' +
        '</article></body></html>'
    ),
    'backend/secret.php': strToU8('<?php echo "TOP_SECRET_DO_NOT_SERVE"; ?>'),
  });

  const fd = new FormData();
  fd.set('bundle', new Blob([siteZip]), 'harborline.softn');
  fd.set('name', 'Harborline Studio');
  const pubRes = await s.api('POST', '/api/apps', { body: fd, headers: { 'X-Admin-Key': s.adminKey } });
  assert.equal(pubRes.status, 201, pubRes.text);
  const slug = pubRes.json.app.slug;

  // 1. Root page `/play/<slug>`
  const homeRes = await fetch(`${s.base}/play/${slug}`);
  assert.equal(homeRes.status, 200);
  const homeHtml = await homeRes.text();
  assert.match(homeHtml, /<title>Harborline Studio — Craft Software &amp; Design<\/title>/);
  assert.match(homeHtml, /name="description" content="Home of Harborline Studio: fast, local-first web apps and design systems\."/);
  assert.match(homeHtml, new RegExp(`<link rel="canonical" href="${SITE}/play/${slug}" />`));
  assert.match(homeHtml, /"@type":"WebPage"/);
  assert.match(homeHtml, /"@type":"BreadcrumbList"/);
  assert.match(homeHtml, /data-softn-page="\/"/);
  assert.match(homeHtml, /Welcome to Harborline/);
  assert.match(homeHtml, new RegExp(`href="/play/${slug}/about\\.html"`));
  assert.match(homeHtml, new RegExp(`href="/play/${slug}/pricing\\.html"`));
  assert.match(homeHtml, new RegExp(`href="/play/${slug}/blog/"`));
  assert.match(homeHtml, new RegExp(`href="/play/${slug}/blog/sandboxed-web\\.html"`));
  assert.match(homeHtml, /href="https:\/\/example\.org\/ext" rel="nofollow ugc noopener noreferrer"/);
  assert.doesNotMatch(homeHtml, /javascript:alert/);
  const homeCfg = JSON.parse(homeHtml.match(/<script type="application\/json" id="softn-runtime-config">(.*?)<\/script>/s)[1]);
  assert.equal(homeCfg.basePath, `/play/${slug}`);
  assert.equal(homeCfg.initialPath, '/');

  // 2. Direct sub-page `/play/<slug>/about.html`
  const aboutRes = await fetch(`${s.base}/play/${slug}/about.html`);
  assert.equal(aboutRes.status, 200);
  const aboutHtml = await aboutRes.text();
  assert.match(aboutHtml, /<title>About Harborline Studio<\/title>/);
  assert.match(aboutHtml, /name="description" content="Meet the engineers and designers behind Harborline Studio\."/);
  assert.match(aboutHtml, new RegExp(`<link rel="canonical" href="${SITE}/play/${slug}/about\\.html" />`));
  assert.match(aboutHtml, new RegExp(`property="og:url" content="${SITE}/play/${slug}/about\\.html"`));
  assert.match(aboutHtml, /data-softn-page="\/about\.html"/);
  assert.match(aboutHtml, /Founded in Melbourne to build calm software\./);
  assert.doesNotMatch(aboutHtml, /Starter tier starts at \$29/);
  const aboutCfg = JSON.parse(aboutHtml.match(/<script type="application\/json" id="softn-runtime-config">(.*?)<\/script>/s)[1]);
  assert.equal(aboutCfg.basePath, `/play/${slug}`);
  assert.equal(aboutCfg.initialPath, '/about.html');

  // 3. Clean extensionless sub-page `/play/<slug>/about` resolves cleanly to about.html
  const aboutCleanRes = await fetch(`${s.base}/play/${slug}/about`);
  assert.equal(aboutCleanRes.status, 200);
  const aboutCleanHtml = await aboutCleanRes.text();
  assert.match(aboutCleanHtml, /<title>About Harborline Studio<\/title>/);
  assert.match(aboutCleanHtml, new RegExp(`<link rel="canonical" href="${SITE}/play/${slug}/about\\.html" />`));
  const aboutCleanCfg = JSON.parse(aboutCleanHtml.match(/<script type="application\/json" id="softn-runtime-config">(.*?)<\/script>/s)[1]);
  assert.equal(aboutCleanCfg.initialPath, '/about.html');

  // 4. Per-page robots meta on `/play/<slug>/pricing.html`
  const pricingRes = await fetch(`${s.base}/play/${slug}/pricing.html`);
  assert.equal(pricingRes.status, 200);
  const pricingHtml = await pricingRes.text();
  assert.match(pricingHtml, /<title>Pricing — Harborline Studio<\/title>/);
  assert.match(pricingHtml, /<meta name="robots" content="index,follow,noarchive" \/>/);
  assert.match(pricingHtml, /Starter tier starts at \$29 per month\./);

  // 5. Nested directory index `/play/<slug>/blog/` and article `/play/<slug>/blog/sandboxed-web.html`
  const blogDirRes = await fetch(`${s.base}/play/${slug}/blog/`);
  assert.equal(blogDirRes.status, 200);
  const blogDirHtml = await blogDirRes.text();
  assert.match(blogDirHtml, /<title>Journal — Harborline Studio<\/title>/);
  assert.match(blogDirHtml, new RegExp(`href="/play/${slug}/blog/sandboxed-web\\.html"`));
  assert.match(blogDirHtml, new RegExp(`href="/play/${slug}"`));

  const postRes = await fetch(`${s.base}/play/${slug}/blog/sandboxed-web.html`);
  assert.equal(postRes.status, 200);
  const postHtml = await postRes.text();
  assert.match(postHtml, /<title>Building Sandboxed Multi-Page Websites — Harborline<\/title>/);
  assert.match(postHtml, new RegExp(`<link rel="canonical" href="${SITE}/play/${slug}/blog/sandboxed-web\\.html" />`));
  assert.match(postHtml, new RegExp(`href="/play/${slug}/blog/"`));
  assert.match(postHtml, new RegExp(`href="/play/${slug}/about\\.html"`));
  assert.match(postHtml, /Every route renders clean semantic HTML on the server\./);

  // 6. Unknown sub-page, private backend file, and traversal attempts all return real 404 + noindex
  const missingRes = await fetch(`${s.base}/play/${slug}/does-not-exist.html`);
  assert.equal(missingRes.status, 404);
  const missingHtml = await missingRes.text();
  assert.match(missingHtml, /<meta name="robots" content="noindex" \/>/);
  assert.match(missingHtml, new RegExp(`href="/play/${slug}"`));

  const secretRes = await fetch(`${s.base}/play/${slug}/backend/secret.php`);
  assert.equal(secretRes.status, 404);
  assert.doesNotMatch(await secretRes.text(), /TOP_SECRET_DO_NOT_SERVE/);

  const dotfileRes = await fetch(`${s.base}/play/${slug}/.env`);
  assert.equal(dotfileRes.status, 404);

  // 7. Sitemap lists /app/<slug> plus every discovered page under /play/<slug>
  const smXml = await (await fetch(`${s.base}/sitemap-apps.xml`)).text();
  assert.match(smXml, new RegExp(`<loc>${SITE}/app/${slug}</loc>`));
  assert.match(smXml, new RegExp(`<loc>${SITE}/play/${slug}</loc>`));
  assert.match(smXml, new RegExp(`<loc>${SITE}/play/${slug}/about\\.html</loc>`));
  assert.match(smXml, new RegExp(`<loc>${SITE}/play/${slug}/pricing\\.html</loc>`));
  assert.match(smXml, new RegExp(`<loc>${SITE}/play/${slug}/blog/</loc>`));
  assert.match(smXml, new RegExp(`<loc>${SITE}/play/${slug}/blog/sandboxed-web\\.html</loc>`));
  assert.doesNotMatch(smXml, /secret\.php/);
});

test('SEO & performance hardening: zero-script engineTier, noindex sitemap exclusion, lang/meta parsing, heading outline, sibling SSR view, and redirects', skip, async () => {
  const s = await startServer({
    prefix: 'softn-seo-perf-hardening-',
    config: { seedDemos: false, siteOrigin: SITE },
  });
  servers.push(s);

  // Create fake WASM engine + runtime-manifest so we verify preload omission on scriptless sites.
  const enginesDir = path.join(s.root, 'shared', 'container-runtime', 'deadbeefcafe', 'engines');
  fs.mkdirSync(enginesDir, { recursive: true });
  fs.writeFileSync(path.join(enginesDir, 'zipp-javascript-lite.wasm'), 'fake-wasm');
  fs.writeFileSync(
    path.join(s.root, 'play', 'runtime-manifest.json'),
    JSON.stringify({
      runtimeBase: '/shared/container-runtime/deadbeefcafe/engines/',
      fullEngineUrl: null,
      containerMountUrl: '/shared/assets/mount-test.js',
    })
  );

  // Scriptless multi-page site with French lang, `>` inside meta description, semantic tags, img alt, and a noindex sub-page.
  const staticSite = zipSync({
    'manifest.json': strToU8(
      JSON.stringify({
        engine: 2,
        name: 'Atelier Nord',
        version: '1.0.0',
        description: 'Pure static HTML/CSS studio showcase.',
        main: 'index.html',
      })
    ),
    'index.html': strToU8(
      '<!doctype html><html lang="fr"><head>' +
        '<title>Atelier Nord — Accueil</title>' +
        '<meta name="description" content="A > B comparison &amp; studio notes." />' +
        '</head><body>' +
        '<main><h1>Bienvenue chez Atelier Nord</h1><h2>Nos Projets</h2>' +
        '<p>Publié le <time datetime="2026-11-25">25 novembre</time>.</p>' +
        '<details><summary>FAQ rapide</summary><p>Sans JavaScript requis.</p></details>' +
        '<img src="hero.png" alt="Architecture minimaliste" />' +
        '<a href="draft.html">Brouillon privé</a>' +
        '</main></body></html>'
    ),
    'draft.html': strToU8(
      '<!doctype html><html lang="fr"><head>' +
        '<title>Brouillon — Atelier Nord</title>' +
        '<meta name="robots" content="noindex, follow" />' +
        '<meta name="description" content="Unpublished draft preview." />' +
        '</head><body><h1>Brouillon interne</h1><p>Ne pas indexer.</p></body></html>'
    ),
  });

  const fd = new FormData();
  fd.set('bundle', new Blob([staticSite]), 'atelier.softn');
  fd.set('name', 'Atelier Nord');
  fd.set('category', 'Business');
  fd.set('subcategory', 'hospitality');
  const pubRes = await s.api('POST', '/api/apps', { body: fd, headers: { 'X-Admin-Key': s.adminKey } });
  assert.equal(pubRes.status, 201, pubRes.text);
  const slug = pubRes.json.app.slug;

  // 1. Root page: `<html lang="fr">`, description containing `>`, full h1->h2 / h2->h3 shift, semantic tags, img alt,
  //    `<main id="softn-ssr-view">` outside `#root`, modulepreload mount chunk, and ZERO WASM preload!
  const rootRes = await fetch(`${s.base}/play/${slug}`);
  assert.equal(rootRes.status, 200);
  const rootHtml = await rootRes.text();
  assert.match(rootHtml, /<html lang="fr"/);
  assert.match(rootHtml, /name="description" content="A &gt; B comparison &amp; studio notes\."/);
  assert.match(rootHtml, /<h2>Bienvenue chez Atelier Nord<\/h2>/);
  assert.match(rootHtml, /<h3>Nos Projets<\/h3>/);
  assert.match(rootHtml, /<details>/);
  assert.match(rootHtml, /<summary>FAQ rapide<\/summary>/);
  assert.match(rootHtml, /<time>25 novembre<\/time>/);
  assert.match(rootHtml, /<span>Architecture minimaliste<\/span>/);
  assert.match(rootHtml, /<div id="root">[\s\S]*?<\/div>\s*<main id="softn-ssr-view" class="softn-ssr" data-softn-ssr="play"/);
  assert.match(rootHtml, /<link rel="modulepreload" crossorigin href="\/shared\/assets\/mount-test\.js" \/>/);
  assert.doesNotMatch(rootHtml, /zipp-javascript-lite\.wasm/, 'scriptless static HTML site must not preload 2.9 MB WASM');

  // 2. Noindex sub-page omits conflicting canonical + og:url and carries noindex,follow
  const draftRes = await fetch(`${s.base}/play/${slug}/draft.html`);
  assert.equal(draftRes.status, 200);
  const draftHtml = await draftRes.text();
  assert.match(draftHtml, /<meta name="robots" content="noindex,follow" \/>/);
  assert.doesNotMatch(draftHtml, /<link rel="canonical"/);
  assert.doesNotMatch(draftHtml, /property="og:url"/);

  // 3. Sitemap includes root page and subcategory URL, and excludes the noindex draft sub-page
  const smRes = await fetch(`${s.base}/sitemap-apps.xml`);
  assert.equal(smRes.status, 200);
  const smXml = await smRes.text();
  assert.match(smXml, new RegExp(`<loc>${SITE}/play/${slug}</loc>`));
  assert.doesNotMatch(smXml, /draft\.html/, 'noindex sub-page must be excluded from sitemap');
  assert.match(smXml, new RegExp(`<loc>${SITE}/apps\\?category=business</loc>`));
  assert.match(smXml, new RegExp(`<loc>${SITE}/apps\\?category=business&amp;subcategory=hospitality</loc>`));

  // 4. `/play/index.html` redirects 301 -> /apps; `/api/page/publish` sends X-Robots-Tag: noindex, nofollow
  const playIndexRes = await fetch(`${s.base}/play/index.html`, { redirect: 'manual' });
  assert.equal(playIndexRes.status, 301);
  assert.equal(playIndexRes.headers.get('location'), '/apps');

  const apiPageAppRes = await fetch(`${s.base}/api/page/app/${slug}`);
  assert.equal(apiPageAppRes.status, 200);
  assert.equal(apiPageAppRes.headers.get('x-robots-tag'), 'noindex, nofollow');

  const apiPagePlayRes = await fetch(`${s.base}/api/page/play/${slug}`);
  assert.equal(apiPagePlayRes.status, 200);
  assert.equal(apiPagePlayRes.headers.get('x-robots-tag'), 'noindex, nofollow');

  // 5. Parameterized `/publish?remix=foo` and `/apps?q=atelier` omit conflicting canonical + emit noindex,follow
  const remixPubHtml = await (await fetch(`${s.base}/publish?remix=${slug}`)).text();
  assert.match(remixPubHtml, /<meta name="robots" content="noindex,follow" \/>/);
  assert.doesNotMatch(remixPubHtml, /<link rel="canonical"/);

  const searchDirHtml = await (await fetch(`${s.base}/apps?q=atelier`)).text();
  assert.match(searchDirHtml, /<meta name="robots" content="noindex,follow" \/>/);
  assert.doesNotMatch(searchDirHtml, /<link rel="canonical"/);
});

test('the page cache and the sitemap cache do not grow with the addresses asked for or the catalogue\'s changes', skip, async () => {
  const s = await startServer({
    prefix: 'softn-seo-cache-growth-',
    config: { seedDemos: false, siteOrigin: SITE },
  });
  servers.push(s);

  // A bundle that leaves its pages to a backend: every address under it that
  // is not a file's is a page, and each one asked for was a cache file of its own.
  const bundle = zipSync({
    'manifest.json': strToU8(
      JSON.stringify({
        name: 'Backend Pages',
        version: '1.0.0',
        description: 'Pages a backend answers.',
        main: 'index.html',
        ssrEntry: 'server/render.php',
      })
    ),
    'index.html': strToU8('<!doctype html><html><head><title>Home</title></head><body><main><h1>Home</h1></main></body></html>'),
    'about.html': strToU8('<!doctype html><html><head><title>About</title></head><body><main><h1>About</h1></main></body></html>'),
  });
  // A visitor, with no key: the manifest alone is what makes a bundle one of these.
  const fd = new FormData();
  fd.set('bundle', new Blob([bundle]), 'backend-pages.softn');
  const pub = await s.api('POST', '/api/apps', { body: fd });
  assert.equal(pub.status, 201, pub.text);
  const slug = pub.json.app.slug;

  const pageCache = path.join(s.dataDir, 'page-cache');
  const cached = () => (fs.existsSync(pageCache) ? fs.readdirSync(pageCache).sort() : []);
  assert.equal((await fetch(`${s.base}/play/${slug}`)).status, 200);
  assert.equal((await fetch(`${s.base}/play/${slug}/about.html`)).status, 200);
  const kept = cached();
  assert.ok(kept.some((f) => f.startsWith('page-meta-')), 'a page that is a file in the bundle is still cached');

  for (let i = 0; i < 6; i++) {
    const res = await fetch(`${s.base}/play/${slug}/made-up/page-${i}`);
    assert.equal(res.status, 200, 'the backend\'s pages are still served');
    assert.match(await res.text(), /<meta name="robots" content="noindex,follow" \/>/);
  }
  assert.deepEqual(cached(), kept, 'an address the backend answers leaves no file behind');
  // The file's page is read from the cache it had, and is the same page.
  assert.match(await (await fetch(`${s.base}/play/${slug}/about.html`)).text(), /<title>About<\/title>/);
  assert.deepEqual(cached(), kept);

  // The sitemap is cached under a fingerprint of the catalogue; the one before a change is not kept.
  const cacheDir = path.join(s.dataDir, 'cache');
  const sitemaps = () => fs.readdirSync(cacheDir).filter((f) => /^sitemap-apps-.*\.xml$/.test(f));
  assert.equal((await fetch(`${s.base}/sitemap-apps.xml`)).status, 200);
  const first = sitemaps();
  assert.equal(first.length, 1);
  for (const name of ['Second Listing', 'Third Listing']) {
    const added = await s.publish(name);
    const xml = await (await fetch(`${s.base}/sitemap-apps.xml`)).text();
    assert.match(xml, new RegExp(`<loc>${SITE}/app/${added.app.slug}</loc>`));
    assert.equal(sitemaps().length, 1, 'one sitemap is kept, the current one');
  }
  assert.notDeepEqual(sitemaps(), first);
  // And it is still the cached one that is served.
  const again = await fetch(`${s.base}/sitemap-apps.xml`);
  assert.equal(again.status, 200);
  assert.match(await again.text(), new RegExp(`<loc>${SITE}/app/${slug}</loc>`));
});
