/**
 * What a publisher chooses and the directory serves back from its own
 * origin, where every edit key a visitor holds is kept:
 *
 * - an SVG icon is parsed and held to an allowlist, not searched for words:
 *   `<x:script>` and an entity-spelled `javascript:` walked past the old
 *   pattern, and the icon route served them as image/svg+xml;
 * - every icon, thumbnail and bundle goes out with a sandboxing CSP and
 *   nosniff, so an SVG opened as a page runs nothing even if one got by;
 * - an app's name and description reach the share page literally: they
 *   were a preg_replace replacement string, where `$2` expanded to the
 *   matched tag's own quote and a name became a meta refresh;
 * - a 503 anyone can provoke names no filesystem path.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, runPhp, skip } from './helpers/harness.mjs';

let s = null;

before(async () => {
  if (skip.skip) return;
  s = await startServer({ prefix: 'softn-user-content-' });
});

after(() => s?.stop());

const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';

/** Script-capable SVGs; each must be refused. The first two are the ones the old check let through. */
const HOSTILE = [
  ['a namespace-prefixed script', `<svg ${SVG_NS} xmlns:x="http://www.w3.org/2000/svg"><x:script>alert(document.domain)</x:script></svg>`],
  ['an entity-encoded javascript: link', `<svg ${SVG_NS}><image href="&#106;avascript:alert(1)" width="1" height="1"/></svg>`],
  ['a hex-entity javascript: link', `<svg ${SVG_NS} xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="&#x6A;avascript:alert(1)"/></svg>`],
  ['a tab inside the scheme', `<svg ${SVG_NS}><image href="java&#9;script:alert(1)"/></svg>`],
  ['a plain script', `<svg ${SVG_NS}><script>alert(1)</script></svg>`],
  ['an XHTML script by another prefix', `<svg ${SVG_NS}><h:script xmlns:h="http://www.w3.org/1999/xhtml">alert(1)</h:script></svg>`],
  ['an event handler', `<svg ${SVG_NS}><rect width="1" height="1" onclick="alert(1)"/></svg>`],
  ['an event handler on the root', `<svg ${SVG_NS} onload="alert(1)"/>`],
  ['foreignObject', `<svg ${SVG_NS}><foreignObject><body xmlns="http://www.w3.org/1999/xhtml">hi</body></foreignObject></svg>`],
  ['an animation that sets a link', `<svg ${SVG_NS}><a><set attributeName="href" to="javascript:alert(1)"/></a></svg>`],
  ['a DOCTYPE with an entity', `<!DOCTYPE svg [<!ENTITY j "javascript:">]><svg ${SVG_NS}><image href="&j;alert(1)"/></svg>`],
  ['an XSLT stylesheet', `<?xml-stylesheet type="text/xsl" href="data:text/xml,x"?><svg ${SVG_NS}/>`],
  ['a nested SVG as data', `<svg ${SVG_NS}><image href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="/></svg>`],
  ['a style import', `<svg ${SVG_NS}><style>@import url(https://evil.example/x.css);</style></svg>`],
  ['not SVG at all', `<html><svg ${SVG_NS}/></html>`],
  ['malformed XML', `<svg ${SVG_NS}><rect></svg>`],
];

/** Icons as design tools write them; each must be kept. */
const BENIGN = [
  ['a plain icon', `<svg ${SVG_NS} viewBox="0 0 24 24"><path d="M0 0h24v24H0z" fill="#e33"/></svg>`],
  [
    'gradients, a style element and a raster image',
    `<?xml version="1.0" encoding="UTF-8"?><svg ${SVG_NS} xmlns:xlink="http://www.w3.org/1999/xlink" width="64" height="64"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient><style>.a{fill:url(#g)}</style></defs><rect class="a" width="64" height="64"/><image xlink:href="data:image/png;base64,iVBORw0KGgo=" width="8" height="8"/><text x="4" y="40">Hi &amp; bye</text></svg>`,
  ],
  [
    "an editor's metadata",
    `<svg ${SVG_NS} xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><metadata><rdf:RDF/></metadata><inkscape:grid/><circle r="4"/></svg>`,
  ],
];

test('the SVG check is a parse: every script-capable construct is refused, ordinary icons are kept', skip, () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-svg-'));
  try {
    const cases = [...HOSTILE, ...BENIGN].map(([, svg]) => svg);
    const r = runPhp({
      dataDir,
      stdin: JSON.stringify(cases),
      script: `echo json_encode(array_map(fn($svg) => Bundle::safeSvg($svg), json_decode(file_get_contents('php://stdin'), true)));`,
    });
    assert.equal(r.status, 0, r.stderr);
    const verdicts = JSON.parse(r.stdout);
    HOSTILE.forEach(([what], i) => assert.equal(verdicts[i], false, `refused: ${what}`));
    BENIGN.forEach(([what], i) => assert.equal(verdicts[HOSTILE.length + i], true, `kept: ${what}`));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

function assertSandboxed(res, what) {
  const csp = res.headers.get('content-security-policy') ?? '';
  assert.match(csp, /(^|;\s*)sandbox(\s*;|$)/, `${what} is sandboxed`);
  assert.match(csp, /default-src 'none'/, `${what} loads nothing`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff', `${what} is not sniffed`);
}

test('a scripted SVG icon is never served; every icon, thumbnail and bundle is sandboxed', skip, async () => {
  const [, xScript] = HOSTILE[0];
  const [, entity] = HOSTILE[1];
  for (const [label, svg] of [
    ['x:script', xScript],
    ['entity', entity],
  ]) {
    const { app } = await s.publish(`Hostile ${label}`, { icon: { path: 'icon.svg', bytes: svg } });
    for (const route of ['icon', 'thumbnail']) {
      const res = await s.api('GET', `/api/apps/${app.slug}/${route}`);
      assert.equal(res.status, 200);
      assert.doesNotMatch(res.text, /script|&#10?6;|&#x6a;/i, `the ${route} is the placeholder, not the upload (${label})`);
      assertSandboxed(res, `the ${route}`);
    }
    const bundle = await s.api('GET', `/api/apps/${app.slug}/bundle.softn`);
    assert.equal(bundle.status, 200);
    assertSandboxed(bundle, 'the bundle');
    const revalidated = await s.api('GET', `/api/apps/${app.slug}/bundle.softn`, { headers: { 'If-None-Match': bundle.headers.get('etag') } });
    assert.equal(revalidated.status, 304);
    assertSandboxed(revalidated, 'a 304 for the bundle');
  }

  // A clean SVG is kept and served as itself, under the same policy.
  const [, clean] = BENIGN[0];
  const { app } = await s.publish('Clean icon', { icon: { path: 'icon.svg', bytes: clean } });
  const icon = await s.api('GET', `/api/apps/${app.slug}/icon`);
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get('content-type'), 'image/svg+xml');
  assert.match(icon.text, /fill="#e33"/);
  assertSandboxed(icon, 'a clean icon');

  // An icon stored before the check was strict is held to it when served.
  const stored = path.join(s.dataDir, 'apps', app.slug, 'icon.svg');
  assert.ok(fs.existsSync(stored));
  fs.writeFileSync(stored, xScript);
  const again = await s.api('GET', `/api/apps/${app.slug}/icon`);
  assert.doesNotMatch(again.text, /script/i, 'a stored icon that fails today is answered with the placeholder');
  assertSandboxed(again, 'the placeholder');
});

test("an app's name and description reach the share and play pages literally", skip, async () => {
  const name = '0;url=https://evil/$2 http-equiv=refresh x=$2';
  const description = 'Backslash \\0 and \\1, dollars $0 $1 ${2}.';
  const { app } = await s.publish('Literal', {}, { name, description });
  const res = await fetch(`${s.base}/app/${app.slug}`, { headers: { Accept: 'text/html' } });
  assert.equal(res.status, 200);
  const html = await res.text();
  for (const tag of html.match(/<meta\b[^>]*>/g) ?? []) {
    // Quoted values emptied, what is left is the tag's own attributes.
    assert.doesNotMatch(tag.replace(/"[^"]*"/g, '""'), /http-equiv/i, `no meta tag gained an http-equiv: ${tag}`);
  }
  assert.match(html, /<meta property="og:title" content="0;url=https:\/\/evil\/\$2 http-equiv=refresh x=\$2 — SoftN" \/>/);
  assert.match(html, /<title>0;url=https:\/\/evil\/\$2 http-equiv=refresh x=\$2 — SoftN<\/title>/);
  assert.ok(html.includes('content="Backslash \\0 and \\1, dollars $0 $1 ${2}."'), 'the description arrives as typed');

  const titled = await s.publish('Title', {}, { name: 'Zero \\0 and $0' });
  const play = await fetch(`${s.base}/play/${titled.app.slug}`, { headers: { Accept: 'text/html' } });
  assert.equal(play.status, 200);
  assert.match(await play.text(), /<title>Zero \\0 and \$0<\/title>/, 'the play page title is literal too');
});

test('a 503 anyone can provoke names no filesystem path', skip, async () => {
  const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'softn-nodata-')), 'a-file');
  fs.writeFileSync(blocker, 'not a directory');
  const dataDir = path.join(blocker, 'private-data');
  const broken = await startServer({ env: { SOFTN_DATA_DIR: dataDir }, prefix: 'softn-nodata-' });
  try {
    for (const route of ['/api/health', '/api/apps']) {
      const res = await broken.api('GET', route);
      assert.equal(res.status, 503, route);
      assert.match(res.json.error, /data directory/i);
      for (const part of [dataDir, blocker, 'private-data', os.tmpdir(), broken.root]) {
        assert.ok(!res.text.includes(part) && !res.text.includes(part.replace(/\\/g, '\\\\')), `${route} does not name ${part}`);
      }
    }
  } finally {
    broken.stop();
    fs.rmSync(path.dirname(blocker), { recursive: true, force: true });
  }
});
