import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {execFileSync,spawnSync} from 'node:child_process';

function leb(value) {
  const bytes=[];
  do {const next=value&127;value>>>=7;bytes.push(next|(value?128:0));} while(value);
  return Buffer.from(bytes);
}

/**
 * A checkout of its own for the packagers to run in: the scripts and what
 * they import under scripts/, a git repository with one commit (the HEAD a
 * build must come from), a package.json, and dist/ as build:site leaves it,
 * with BUILD-INFO.json naming that commit. Not this checkout: the packagers
 * look at the checkout they are in.
 */
function siteCheckout(t,files={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'softn-zip-test-')));
  t.after(()=>{
    assert.equal(path.dirname(root),fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('softn-zip-test-'));
    fs.rmSync(root,{recursive:true,force:true});
  });
  const scripts=path.join(root,'scripts'),dist=path.join(root,'dist');
  fs.mkdirSync(path.join(scripts,'lib'),{recursive:true});fs.mkdirSync(path.join(scripts,'release'),{recursive:true});
  for(const name of ['package-site.mjs','package-docs.mjs','release-packages.mjs','release-explainers.mjs'])fs.copyFileSync(new URL('./'+name,import.meta.url),path.join(scripts,'release',name));
  for(const name of fs.readdirSync(new URL('../lib/',import.meta.url)))
    if(name.endsWith('.mjs')&&!name.endsWith('.test.mjs'))fs.copyFileSync(new URL('../lib/'+name,import.meta.url),path.join(scripts,'lib',name));
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({version:'0.0.0'}));
  const git=(...args)=>execFileSync('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false',...args],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-q');
  git('commit','-q','--allow-empty','-m','fixture');
  const head=git('rev-parse','HEAD');
  const buildInfo=(softn,more={})=>Buffer.from(JSON.stringify({builtAt:'2026-01-01T00:00:00Z',softn,zipp:{version:'0.0.15'},...more}));
  const all={
    'index.html':Buffer.from('<!doctype html><title>Test</title>'),
    '.htaccess':Buffer.from('Options -Indexes\n'),
    'data/.htaccess':Buffer.from('Require all denied\n'),
    'data/README.txt':Buffer.from('Private runtime state.\n'),
    'BUILD-INFO.json':buildInfo({revision:head,dirty:false}),
    ...files,
  };
  for(const [name,bytes] of Object.entries(all)){
    fs.mkdirSync(path.dirname(path.join(dist,name)),{recursive:true});
    fs.writeFileSync(path.join(dist,name),bytes);
  }
  const out=path.join(root,'release');
  const run=(script,args)=>spawnSync(process.execPath,[path.join(scripts,'release',script),...args],{cwd:root,encoding:'utf8'});
  return {
    root,dist,out,head,files:all,git,
    built:(softn,more)=>fs.writeFileSync(path.join(dist,'BUILD-INFO.json'),buildInfo(softn,more)),
    packSite:(...args)=>run('package-site.mjs',['--tag','v0.0.0-test','--out',out,...args]),
    packDocs:(...args)=>run('package-docs.mjs',['--out',out,...args]),
    archives:()=>fs.existsSync(out)?fs.readdirSync(out).filter(name=>name.endsWith('.zip')):[],
  };
}

test('hosting ZIP deflates valid raw WASM, preserves compressed twins and restores exact bytes',t=>{
  const payload=Buffer.concat([Buffer.from([7]),Buffer.from('fixture'),Buffer.alloc(65536)]);
  const wasm=Buffer.concat([Buffer.from([0,97,115,109,1,0,0,0,0]),leb(payload.length),payload]);
  assert.doesNotThrow(()=>new WebAssembly.Module(wasm));
  const gz=zlib.gzipSync(wasm);
  const site=siteCheckout(t,{
    'engine.wasm':wasm,
    'engine.wasm.gz':gz,
    // A source map whose sources are where the build put them, relative: shipped.
    'web/assets/index.js':Buffer.from('console.log(1);\n//# sourceMappingURL=index.js.map\n'),
    'web/assets/index.js.map':Buffer.from(JSON.stringify({version:3,file:'index.js',sources:['../../../../packages/x/src/index.ts'],sourcesContent:['console.log(1)'],mappings:'AAAA'})),
  });
  const files={...site.files};
  const packed=site.packSite();
  assert.equal(packed.status,0,packed.stderr);
  // The packager writes the explainer into dist/ before packaging; the archive must carry it too.
  files['README.md']=fs.readFileSync(path.join(site.dist,'README.md'));
  assert.ok(files['README.md'].toString().startsWith('# Start here: The complete softn.com website'));
  const zip=fs.readFileSync(path.join(site.out,site.archives()[0]));
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
});

/**
 * An archive is named for a release, and BUILD-INFO.json inside it says
 * which commit was built: the two must be one. dist/ is not rebuilt by the
 * packager, and one left from an earlier build (the dist/ beside this test
 * when it was written was built from another commit, from a dirty tree) was
 * packaged under whatever tag it was given.
 */
test('the site is not packaged from a dist built from another commit than HEAD',t=>{
  const site=siteCheckout(t);
  site.git('commit','-q','--allow-empty','-m','later');
  const stale=site.packSite();
  assert.equal(stale.status,1,stale.stdout);
  assert.match(stale.stderr,new RegExp(`dist/ was built from ${site.head.slice(0,10)}, not from HEAD \\(${site.git('rev-parse','HEAD').slice(0,10)}\\)`));
  assert.deepEqual(site.archives(),[]);
  // Rebuilt from HEAD it is packaged; one with no revision at all is not.
  site.built({revision:site.git('rev-parse','HEAD'),dirty:false});
  assert.equal(site.packSite().status,0);
  site.built({dirty:false});
  const unnamed=site.packSite();
  assert.equal(unnamed.status,1);
  assert.match(unnamed.stderr,/BUILD-INFO\.json names no SoftN revision/);
});

/**
 * A dist built for the browser journeys alone (build-site --no-precompress)
 * has no .br/.gz twins, which the deployment rules serve first; the site and
 * its documentation are not packaged from one.
 */
test('a dist built without its precompressed twins is not packaged',t=>{
  const site=siteCheckout(t,{'docs/index.html':Buffer.from('<!doctype html><title>Docs</title>')});
  site.built({revision:site.head,dirty:false},{precompressed:false});
  for(const refused of [site.packSite(),site.packDocs()]){
    assert.equal(refused.status,1,refused.stdout);
    assert.match(refused.stderr,/built with --no-precompress, for tests/);
  }
  assert.deepEqual(site.archives(),[]);
  site.built({revision:site.head,dirty:false},{precompressed:true});
  assert.equal(site.packSite().status,0);
});

/**
 * Source maps ship, for reading an error report against the build that
 * made it, but the build machine's own paths do not: the service workers'
 * maps named the temporary file workbox wrote (C:/Users/<name>/AppData/...)
 * and carried the checkout's path in every import. build-site.mjs leaves
 * such maps out; the packager refuses a dist that still has one, or any
 * file that names the checkout it was built in.
 */
test('the site is not packaged with a source map or a file that names a path on the build machine',t=>{
  for(const [name,body,said] of [
    ['web/sw.js.map',JSON.stringify({version:3,file:'sw.js',sources:['C:/Users/someone/AppData/Local/Temp/0123abcd/sw.js'],mappings:'AAAA'}),/web\/sw\.js\.map names a path on the build machine \(C:\/Users\/someone\/AppData\/Local\/Temp\/0123abcd\/sw\.js\)/],
    ['web/sw.js.map',JSON.stringify({version:3,file:'sw.js',sources:['/tmp/0123abcd/sw.js'],mappings:'AAAA'}),/web\/sw\.js\.map names a path on the build machine \(\/tmp\/0123abcd\/sw\.js\)/],
    ['web/a.js.map',JSON.stringify({version:3,file:'a.js',sourceRoot:'file:///home/runner/work/',sources:['a.ts'],mappings:'AAAA'}),/web\/a\.js\.map names a path on the build machine/],
  ]){
    const site=siteCheckout(t,{[name]:Buffer.from(body)});
    const refused=site.packSite();
    assert.equal(refused.status,1,name+' '+refused.stdout);
    assert.match(refused.stderr,said);
    assert.deepEqual(site.archives(),[]);
  }
  // The checkout's own path, in any file the site serves, however it is spelt there.
  const BACKSLASH=String.fromCharCode(92);
  const forward=p=>p.split(BACKSLASH).join('/'),back=p=>p.split('/').join(BACKSLASH);
  for(const [name,text] of [
    // In a map's JSON: forward slashes, and backslashes as JSON writes them (doubled).
    ['app.js.map',root=>JSON.stringify({version:3,sources:['src/app.ts'],sourcesContent:[`import x from '${forward(root)}/node_modules/x/index.mjs';`],mappings:'AAAA'})],
    ['app.js.map',root=>JSON.stringify({version:3,sources:['src/app.ts'],sourcesContent:[`import x from '${back(root+'/node_modules/x/index.mjs')}';`],mappings:'AAAA'})],
    // In a script, as Windows writes it.
    ['web/app.js',root=>`// built in ${back(root)}\n`],
  ]){
    const site=siteCheckout(t);
    fs.mkdirSync(path.dirname(path.join(site.dist,name)),{recursive:true});
    fs.writeFileSync(path.join(site.dist,name),text(site.root));
    const refused=site.packSite();
    assert.equal(refused.status,1,name+' '+refused.stdout);
    assert.ok(refused.stderr.includes(`${name} names the checkout this was built in`),refused.stderr);
    assert.deepEqual(site.archives(),[]);
  }
});

/**
 * The documentation alone is named for the commit it was built from, and
 * is only packaged from a dist built from HEAD: it was named for HEAD,
 * whatever dist/docs/ had been built from.
 */
test('the documentation is packaged only from a dist built from HEAD, and named for it',t=>{
  const site=siteCheckout(t,{'docs/index.html':Buffer.from('<!doctype html><title>Docs</title>')});
  const packed=site.packDocs();
  assert.equal(packed.status,0,packed.stderr);
  assert.deepEqual(site.archives(),[`softn-docs-v0.0.0-${site.head.slice(0,10)}.zip`]);
  fs.rmSync(site.out,{recursive:true});
  site.git('commit','-q','--allow-empty','-m','later');
  const stale=site.packDocs();
  assert.equal(stale.status,1,stale.stdout);
  assert.match(stale.stderr,/dist\/ was built from [0-9a-f]{10}, not from HEAD/);
  assert.deepEqual(site.archives(),[]);
  // Built from HEAD with uncommitted changes: refused unless asked for.
  site.built({revision:site.git('rev-parse','HEAD'),dirty:true});
  assert.equal(site.packDocs().status,1);
  assert.equal(site.packDocs('--allow-dirty').status,0);
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
const buildSource = fs.readFileSync(new URL('../build/build-site.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const routerSource = fs.readFileSync(new URL('../../apps/softn-api/router.php', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

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
    'RewriteRule ^(?:assets|demos|softn-files|shared)(?:/|$) - [R=404,L]',
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
    'location ~ ^/(?:assets|demos|softn-files|shared|web/(?:assets|demos)|builder/assets|studio/assets|play/assets)(?:/|$) {',
  ]) {
    assert.ok(nginx.includes(kept), kept);
  }
});

/**
 * Apache sent the .gz twins as application/gzip. AddEncoding names a twin's
 * encoding, but its type comes from the last extension that has one, and
 * nearly every host gives .gz a type. Browsers ask for gzip rather than
 * brotli over plain HTTP, so every page was saved as a file and every script
 * and stylesheet refused (seen in Chromium against Apache 2.4 with Ubuntu's
 * mime.types). And nginx refuses to start on a directive it does not know:
 * brotli_static is a third-party module's, so it ships commented out.
 */
test('the twins go out under their original type, and the nginx config starts without ngx_brotli', () => {
  const apache = rawBlock('APACHE_CONFIG');
  const twins = apache.match(/<IfModule mod_mime\.c>\n((?:(?!<\/?IfModule).*\n)*)<IfModule mod_rewrite\.c>/);
  assert.ok(twins, 'the twins block: mod_mime around the twin rewrite');
  assert.match(twins[1], /^\s*RemoveType \.br \.gz$/m);
  assert.match(twins[1], /^\s*AddEncoding br \.br$/m);
  assert.match(twins[1], /^\s*AddEncoding gzip \.gz$/m);
  const vary = apache.match(/<FilesMatch "([^"]+)">\n\s*Header append Vary Accept-Encoding/);
  assert.ok(vary, 'the Vary rule');
  for (const file of ['app-1a2b3c4d.js', 'app-1a2b3c4d.js.br', 'engine.wasm.gz', 'index.html.gz']) {
    assert.ok(new RegExp(vary[1]).test(file), `Vary: Accept-Encoding on ${file}`);
  }

  const nginx = rawBlock('NGINX_CONFIG');
  assert.match(nginx, /^\s*# brotli_static on;$/m);
  assert.doesNotMatch(nginx, /^\s*brotli_static/m);
  assert.match(nginx, /^\s*gzip_static on;$/m);
  assert.match(nginx, /gzip_types [^;]*\btext\/javascript\b/);
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

/**
 * Audit 2026-09-15 server L6: the directory's own files are never served.
 * The API's `.htaccess` (`RewriteRule ^lib/ - [F,L]`, the `.md` refusal)
 * and `data/.htaccess` (deny all) only take effect under `AllowOverride
 * All`; on the site both hosts refuse the same paths by construction, and
 * this pins that: every `/api/...` request is the one PHP script (a request
 * for `/api/lib/x.php`, `/api/backup.php` or `/api/README.md` never reaches
 * a file), `/data/` is a 404, and the two CLI helpers refuse to run over
 * HTTP even when the directory is served on its own.
 */
const apiHtaccess = fs.readFileSync(new URL('../../apps/softn-api/.htaccess', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const dataHtaccess = fs.readFileSync(new URL('../../apps/softn-api/data/.htaccess', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const PRIVATE_PATHS = ['api/lib/apps.php', 'api/lib/', 'api/data/config.json', 'api/backup.php', 'api/seed-folder.php', 'api/README.md', 'api/test/api.test.mjs'];

test("the API directory's own files are never served by either host", () => {
  const apache = rawBlock('APACHE_CONFIG');
  // Apache: /api/... is rewritten to the script before any file rule runs.
  const rules = apache.split('\n').map(line => line.trim()).filter(line => line.startsWith('RewriteRule '));
  const at = rules.indexOf('RewriteRule ^api(?:/.*)?$ api/index.php [QSA,L]');
  assert.ok(at >= 0, 'the API rewrite');
  // Only the precompressed-twin rules come before it, and those rewrite a
  // URI to its own .br/.gz file when that file exists, never to another path.
  for (const earlier of rules.slice(0, at)) assert.match(earlier, /^RewriteRule \^\(\.\*\)\$ \$1\.(?:br|gz) \[QSA,L\]$/, `before the API rule: ${earlier}`);
  const api = new RegExp(rules[at].split(' ')[1]);
  for (const path of PRIVATE_PATHS) assert.ok(api.test(path), `Apache hands "${path}" to the API script`);
  assert.ok(apache.includes('RewriteRule ^data(?:/|$) - [R=404,L]'));
  // The directory on its own: lib/ is forbidden, .md refused, data/ denied.
  assert.ok(apiHtaccess.includes('RewriteRule ^lib/ - [F,L]'));
  assert.match(apiHtaccess, /<FilesMatch "\\\.md\$">\n\s*<IfModule mod_authz_core\.c>\n\s*Require all denied/);
  assert.match(dataHtaccess, /<IfModule mod_authz_core\.c>\n\s*Require all denied/);
  // nginx: the /api location names the script, whatever the URI, and /data/ is gone.
  const nginx = rawBlock('NGINX_CONFIG');
  const location = nginx.match(/location ~ \^\/api\(\/\|\$\) \{([\s\S]*?)\n\s*\}/);
  assert.ok(location, 'the /api location');
  assert.ok(location[1].includes('fastcgi_param SCRIPT_FILENAME $document_root/api/index.php;'));
  assert.ok(!/try_files|alias|root /.test(location[1]), 'the /api location serves no file');
  const nginxApi = /^\/api(\/|$)/;
  for (const path of PRIVATE_PATHS) assert.ok(nginxApi.test(`/${path}`), `nginx hands "/${path}" to the API script`);
  assert.ok(nginx.includes('location /data/ { return 404; }'));
  // The CLI helpers refuse HTTP themselves.
  for (const helper of ['backup.php', 'seed-folder.php']) {
    const source = fs.readFileSync(new URL(`../../apps/softn-api/${helper}`, import.meta.url), 'utf8');
    assert.match(source, /PHP_SAPI !== 'cli'/, `${helper} refuses to run over HTTP`);
  }
});
