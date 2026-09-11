import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {execFileSync} from 'node:child_process';

function leb(value) {
  const bytes=[];
  do {const next=value&127;value>>>=7;bytes.push(next|(value?128:0));} while(value);
  return Buffer.from(bytes);
}

test('hosting ZIP deflates valid raw WASM, preserves compressed twins and restores exact bytes',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'softn-zip-test-'));
  try {
    const scripts=path.join(root,'scripts'),dist=path.join(root,'dist');
    fs.mkdirSync(scripts);fs.mkdirSync(path.join(dist,'data'),{recursive:true});
    fs.copyFileSync(new URL('./package-site.mjs',import.meta.url),path.join(scripts,'package-site.mjs'));
    const payload=Buffer.concat([Buffer.from([7]),Buffer.from('fixture'),Buffer.alloc(65536)]);
    const wasm=Buffer.concat([Buffer.from([0,97,115,109,1,0,0,0,0]),leb(payload.length),payload]);
    assert.doesNotThrow(()=>new WebAssembly.Module(wasm));
    const gz=zlib.gzipSync(wasm);
    const files={
      'index.html':Buffer.from('<!doctype html><title>Test</title>'),
      '.htaccess':Buffer.from('Options -Indexes\n'),
      'data/.htaccess':Buffer.from('Require all denied\n'),
      'data/README.txt':Buffer.from('Private runtime state.\n'),
      'BUILD-INFO.json':Buffer.from(JSON.stringify({builtAt:'2026-01-01T00:00:00Z',softn:{revision:'0'.repeat(40),dirty:false},zipp:{version:'0.0.15'}})),
      'engine.wasm':wasm,
      'engine.wasm.gz':gz,
    };
    for(const [name,bytes] of Object.entries(files))fs.writeFileSync(path.join(dist,name),bytes);
    const out=path.join(root,'release');
    execFileSync(process.execPath,[path.join(scripts,'package-site.mjs'),'--tag','v0.0.0-test','--out',out],{stdio:'pipe'});
    const zip=fs.readFileSync(path.join(out,fs.readdirSync(out).find(name=>name.endsWith('.zip'))));
    const entries=new Map();let offset=0;
    while(zip.readUInt32LE(offset)===0x04034b50){
      const method=zip.readUInt16LE(offset+8),size=zip.readUInt32LE(offset+18);
      const length=zip.readUInt16LE(offset+26),extra=zip.readUInt16LE(offset+28);
      const name=zip.toString('utf8',offset+30,offset+30+length);
      const start=offset+30+length+extra,packed=zip.subarray(start,start+size);
      const bytes=method===8?zlib.inflateRawSync(packed):packed;
      assert.deepEqual(bytes,files[name],name);
      entries.set(name,{method,size});offset=start+size;
    }
    assert.equal(entries.size,Object.keys(files).length);
    assert.equal(entries.get('engine.wasm').method,8);
    assert.ok(entries.get('engine.wasm').size<wasm.length/10);
    assert.equal(entries.get('engine.wasm.gz').method,0);
    assert.equal(entries.get('engine.wasm.gz').size,gz.length);
  } finally {
    const checked=fs.realpathSync(root);
    assert.equal(path.dirname(checked),fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(checked).startsWith('softn-zip-test-'));
    fs.rmSync(checked,{recursive:true,force:true});
  }
});

/**
 * The deployed rewrite rules answer 404 for a path the site has no page for.
 *
 * Every config the build emits used to hand index.html, at 200, to any
 * browser navigation that was not a real file: a stale or mistyped link
 * looked like a page to crawlers, link checkers and browser history. Now
 * each names the site's own pages — /, /apps, /app/<slug>, /publish, a
 * trailing slash allowed — and sends the rest to a 404 whose body is the
 * site, so its not-found page shows. build-site.mjs runs the build when
 * imported, so the rules are read from its source and each allowlist is
 * exercised as the regular expression the server will run.
 */
// A checkout under autocrlf carries the sources with CRLF; the rules are the same.
const buildSource = fs.readFileSync(new URL('./build-site.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const routerSource = fs.readFileSync(new URL('../apps/softn-api/router.php', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function rawBlock(name) {
  const match = buildSource.match(new RegExp(`const ${name} = String\\.raw\`([\\s\\S]*?)\\n\`;`));
  assert.ok(match, `${name} in build-site.mjs`);
  return match[1];
}

const SITE_PAGES = ['', 'apps', 'apps/', 'app/space-invaders', 'app/space-invaders/', 'app/x%20y', 'publish', 'publish/'];
const NOT_PAGES = ['nothing-here', 'nothing-here/', 'apps/extra', 'app', 'app/', 'app/x/y', 'publishing', 'apps.html', 'web/app/Notes', 'studio/x', 'play/x', 'api/apps'];

test('the Apache rules serve the site only for its own pages and 404 the rest, with the site as the error body', () => {
  const apache = rawBlock('APACHE_CONFIG');
  assert.match(apache, /^ErrorDocument 404 \/index\.html$/m);
  const spa = apache.match(/RewriteCond %\{HTTP_ACCEPT\} text\/html \[NC\]\n\s*RewriteRule (\S+) index\.html \[END\]\n\n\s*RewriteRule \^ - \[R=404,L\]\n<\/IfModule>/);
  assert.ok(spa, 'the site rule, followed by the catch-all 404, closes the rewrite block');
  const pattern = new RegExp(spa[1]);
  for (const path of SITE_PAGES) assert.ok(pattern.test(path), `Apache serves the site for "${path}"`);
  for (const path of NOT_PAGES) assert.ok(!pattern.test(path), `Apache does not serve the site for "${path}"`);
  // Everything that was there before still is.
  for (const kept of [
    'RewriteRule ^api(?:/.*)?$ api/index.php [QSA,L]',
    'RewriteRule ^data(?:/|$) - [R=404,L]',
    'RewriteRule ^app/[^/]+/?$ api/index.php [L]',
    'RewriteRule ^play/?$ /apps [R=302,L]',
    'RewriteRule ^play/[^/]+/?$ api/index.php [L]',
    'RewriteRule ^(web|builder|studio)$ $1/ [R=308,L,NE]',
    'RewriteRule ^(?:assets|demos|softn-files)(?:/|$) - [R=404,L]',
    'RewriteRule ^(?:web|builder|studio|play)/(?:assets|demos)(?:/|$) - [R=404,L]',
    'RewriteRule ^web(?:/.*)?$ web/index.html [END]',
    'RewriteRule ^builder(?:/.*)?$ builder/index.html [END]',
    'RewriteRule ^studio(?:/.*)?$ studio/index.html [END]',
  ]) {
    assert.ok(apache.includes(kept), kept);
  }
});

test('the nginx config maps the same pages, 404s the rest, and uses the site as the 404 body', () => {
  const nginx = rawBlock('NGINX_CONFIG');
  assert.match(nginx, /^\s*error_page 404 \/index\.html;$/m);
  const map = nginx.match(/map \$uri \$softn_site_page \{\n\s*default\s+0;\n\s*~(\^\S+)\s+1;\n\}/);
  assert.ok(map, 'the $softn_site_page map');
  const pattern = new RegExp(map[1]);
  for (const path of SITE_PAGES) assert.ok(pattern.test(`/${path}`), `nginx serves the site for "/${path}"`);
  for (const path of NOT_PAGES) assert.ok(!pattern.test(`/${path}`), `nginx does not serve the site for "/${path}"`);
  const site = nginx.match(/location @softn_site \{([\s\S]*?)\n\s*\}/);
  assert.ok(site, 'the @softn_site location');
  assert.ok(site[1].includes('if ($softn_html_navigation = 0) { return 404; }'));
  assert.ok(site[1].includes('if ($softn_site_page = 0) { return 404; }'));
  assert.ok(site[1].includes('try_files /index.html =404;'));
  for (const kept of [
    'location /data/ { return 404; }',
    'location ~ ^/api(/|$) {',
    'location ~ ^/app/[^/]+/?$ {',
    'location ~ ^/play/[^/]+/?$ {',
    'location /web/ { try_files $uri $uri/ @softn_web; }',
    'location /builder/ { try_files $uri $uri/ @softn_builder; }',
    'location /studio/ { try_files $uri $uri/ @softn_studio; }',
    'location / { try_files $uri $uri/ @softn_site; }',
    'location ~ ^/(?:assets|demos|softn-files|web/(?:assets|demos)|builder/assets|studio/assets|play/assets)(?:/|$) {',
  ]) {
    assert.ok(nginx.includes(kept), kept);
  }
});

test('the PHP router and the static-host redirects apply the same allowlist', () => {
  const guard = routerSource.match(/if \(!preg_match\('#(\^[^']+\$)#', \$path\)\) \{\n\s*http_response_code\(404\);\n\}/);
  assert.ok(guard, 'the router 404s a path outside the allowlist before serving index.html');
  const pattern = new RegExp(guard[1]);
  for (const path of SITE_PAGES) assert.ok(pattern.test(`/${path}`), `the router serves the site for "/${path}"`);
  for (const path of NOT_PAGES) assert.ok(!pattern.test(`/${path}`), `the router does not serve the site for "/${path}"`);
  assert.ok(routerSource.includes('readfile("$root/index.html");'));

  // The _redirects template nests template literals, so it is checked as
  // the text the build writes: the site's pages at 200, then the rest at 404.
  const redirects = buildSource.slice(buildSource.indexOf("path.join(outDir, '_redirects')"));
  assert.ok(redirects.includes('/apps  /index.html  200\\n/app/:slug  /index.html  200\\n/publish  /index.html  200\\n/*  /index.html  404\\n'), 'the _redirects rules');
  assert.ok(!buildSource.includes('/*  /index.html  200'), 'no catch-all 200 is left');
});
