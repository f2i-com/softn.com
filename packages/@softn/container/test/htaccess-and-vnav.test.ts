import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import fs from 'node:fs';
import path from 'node:path';
import {
  ContainerArchive,
  parseHtaccess,
  evaluateHtaccess,
  evaluateHtaccessChain,
} from '../src/index';

const SNGINE_ROOT =
  'E:\\social_networking_site\\codecanyon-da0suLD6-sngine-the-ultimate-social-network-platform\\Version 5.0\\Script';
const SNGINE_HTACCESS = path.join(SNGINE_ROOT, '.htaccess');

function makeProbe(files: string[]) {
  const fileSet = new Set(files.map((f) => f.replace(/^\/+/, '')));
  const dirSet = new Set<string>();
  for (const f of fileSet) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirSet.add(parts.slice(0, i).join('/'));
    }
  }
  return {
    isFile: (p: string) => fileSet.has(p.replace(/^\/+/, '')),
    isDir: (p: string) => dirSet.has(p.replace(/^\/+/, '').replace(/\/+$/, '')),
    fileSize: (p: string) => (fileSet.has(p.replace(/^\/+/, '')) ? 128 : -1),
  };
}

describe('.htaccess Rewrite Engine & Virtual Folder Navigation', () => {
  it('parses and evaluates RewriteCond, RewriteRule, backrefs, QSA, R=301, F, G, FilesMatch, and RedirectMatch', () => {
    const ht = parseHtaccess(`
      Options -Indexes
      DirectoryIndex index.php index.html

      <FilesMatch "\\.(tpl|sql|env)$">
        Order allow,deny
        Deny from all
      </FilesMatch>

      RedirectMatch 404 ^/includes/

      RewriteEngine On
      RewriteCond %{REQUEST_FILENAME} -f [OR]
      RewriteCond %{REQUEST_FILENAME} -d
      RewriteRule .* - [L,QSA]

      RewriteRule ^old-page/?$ /new-page [R=301,L]
      RewriteRule ^forbidden/?$ - [F,L]
      RewriteRule ^gone/?$ - [G,L]
      RewriteRule ^users/([^/]+)/posts/([0-9]+)/?$ modules/posts.php?user=$1&id=$2 [L,QSA]
      RewriteRule ^search/([^/]+)/?$ modules/search.php?q=$1 [B,L,QSA]
    `);

    const probe = makeProbe([
      'index.php',
      'assets/app.js',
      'modules/posts.php',
      'modules/search.php',
      'includes/config.php',
      'secret.env',
    ]);

    // 1. FilesMatch blocks .env / .sql / .tpl
    const blocked = evaluateHtaccess(ht, { pathname: '/secret.env', query: '', method: 'GET' }, probe);
    expect(blocked.action).toBe('deny');
    if (blocked.action === 'deny') expect(blocked.status).toBe(403);

    // 2. RedirectMatch 404 blocks /includes/
    const hidden = evaluateHtaccess(ht, { pathname: '/includes/config.php', query: '', method: 'GET' }, probe);
    expect(hidden.action).toBe('deny');
    if (hidden.action === 'deny') expect(hidden.status).toBe(404);

    // 3. Existing static file passes through via `-f` + `-`
    const staticAsset = evaluateHtaccess(ht, { pathname: '/assets/app.js', query: 'v=1', method: 'GET' }, probe);
    expect(staticAsset).toEqual({ action: 'rewrite', pathname: '/assets/app.js', query: 'v=1', rewritten: false });

    // 4. External 301 redirect
    const redir = evaluateHtaccess(ht, { pathname: '/old-page', query: '', method: 'GET' }, probe);
    expect(redir).toMatchObject({ action: 'redirect', status: 301, location: '/new-page' });

    // 5. [F] and [G]
    const forb = evaluateHtaccess(ht, { pathname: '/forbidden', query: '', method: 'GET' }, probe);
    expect(forb).toMatchObject({ action: 'deny', status: 403 });
    const gone = evaluateHtaccess(ht, { pathname: '/gone', query: '', method: 'GET' }, probe);
    expect(gone).toMatchObject({ action: 'deny', status: 410 });

    // 6. Rewrite with $1, $2 and [QSA]
    const rew = evaluateHtaccess(
      ht,
      { pathname: '/users/alice/posts/42', query: 'sort=asc', method: 'GET' },
      probe
    );
    expect(rew).toMatchObject({
      action: 'rewrite',
      pathname: '/modules/posts.php',
      query: 'user=alice&id=42&sort=asc',
    });

    // 7. Rewrite with [B] (escape backrefs)
    const search = evaluateHtaccess(
      ht,
      { pathname: '/search/hello world', query: '', method: 'GET' },
      probe
    );
    expect(search.action).toBe('rewrite');
    if (search.action === 'rewrite') {
      expect(search.pathname).toBe('/modules/search.php');
      expect(search.query).toBe('q=hello%20world');
    }
  });

  it('evaluates nested directory .htaccess chains (root + subdirectory)', () => {
    const map = new Map([
      [
        '',
        parseHtaccess(
          `RewriteEngine On
           RewriteRule ^home/?$ index.php [L]`,
          ''
        ),
      ],
      [
        'admin',
        parseHtaccess(
          `RewriteEngine On
           RewriteRule ^users/([0-9]+)/?$ manage.php?uid=$1 [L,QSA]`,
          'admin'
        ),
      ],
    ]);
    const probe = makeProbe(['index.php', 'admin/manage.php']);

    const adminRes = evaluateHtaccessChain(
      map,
      { pathname: '/admin/users/99', query: 'tab=roles', method: 'GET' },
      probe
    );
    expect(adminRes).toMatchObject({
      action: 'rewrite',
      pathname: '/admin/manage.php',
      query: 'uid=99&tab=roles',
    });
  });

  it('evaluates the real Sngine 5.0 .htaccess file accurately', () => {
    if (!fs.existsSync(SNGINE_HTACCESS)) return;
    const raw = fs.readFileSync(SNGINE_HTACCESS, 'utf8');
    const ht = parseHtaccess(raw, '');
    expect(ht.rewriteEngine).toBe(true);
    expect(ht.rules.length).toBeGreaterThan(50);

    const probe = makeProbe([
      'index.php',
      'sign.php',
      'search.php',
      'admin.php',
      'includes/config.php',
      'content/themes/default/templates/index.tpl',
      'content/themes/default/css/style.css',
    ]);

    // Security rules: .tpl denied (403) or /content/themes/... blocked
    const tplRes = evaluateHtaccess(
      ht,
      { pathname: '/content/themes/default/templates/index.tpl', query: '', method: 'GET' },
      probe
    );
    expect(tplRes.action).toBe('deny');

    // Static CSS passes through untouched via `-f` + `-`
    const cssRes = evaluateHtaccess(
      ht,
      { pathname: '/content/themes/default/css/style.css', query: '', method: 'GET' },
      probe
    );
    expect(cssRes).toMatchObject({ action: 'rewrite', pathname: '/content/themes/default/css/style.css', rewritten: false });

    // /signin -> sign.php?do=in
    const signin = evaluateHtaccess(ht, { pathname: '/signin', query: '', method: 'GET' }, probe);
    expect(signin.action).toBe('rewrite');
    if (signin.action === 'rewrite') {
      expect(signin.pathname).toMatch(/sign\.php$/);
      expect(signin.query).toContain('do=in');
    }

    // /signup -> sign.php?do=up
    const signup = evaluateHtaccess(ht, { pathname: '/signup', query: '', method: 'GET' }, probe);
    expect(signup.action).toBe('rewrite');
    if (signup.action === 'rewrite') {
      expect(signup.pathname).toMatch(/sign\.php$/);
      expect(signup.query).toContain('do=up');
    }

    // /admincp/users -> admin.php?view=users
    const admincp = evaluateHtaccess(ht, { pathname: '/admincp/users', query: '', method: 'GET' }, probe);
    expect(admincp.action).toBe('rewrite');
    if (admincp.action === 'rewrite') {
      expect(admincp.pathname).toMatch(/admin\.php$/);
      expect(admincp.query).toContain('view=users');
    }
  });

  it('loads a single .zip archive and provides virtual folder navigation + script classification', async () => {
    const zipBytes = zipSync({
      'my-php-app/.htaccess': strToU8('RewriteEngine On\nRewriteRule ^about/?$ pages/about.php [L]\n'),
      'my-php-app/index.php': strToU8('<?php echo "Home"; ?>'),
      'my-php-app/pages/about.php': strToU8('<?php echo "About"; ?>'),
      'my-php-app/pages/contact.html': strToU8('<h1>Contact</h1>'),
      'my-php-app/includes/db.php': strToU8('<?php // private helper'),
      'my-php-app/assets/logo.png': new Uint8Array([137, 80, 78, 71]),
      'my-php-app/.env': strToU8('SECRET_KEY=super-secret'),
    });

    const archive = await ContainerArchive.open(zipBytes, 'My PHP App');
    expect(archive.manifest.backend?.runtime).toBe('php');
    expect(archive.manifest.backend?.mode).toBe('ssr');
    expect(archive.manifest.ssrEntry).toBe(true);

    // Root virtual directory listing (folders sorted first, then files; hidden dotfiles omitted from nav)
    const rootEntries = archive.listVirtualDirectory('');
    const rootNames = rootEntries.map((e) => `${e.kind}:${e.name}`);
    expect(rootNames).toContain('dir:assets');
    expect(rootNames).toContain('dir:includes');
    expect(rootNames).toContain('dir:pages');
    expect(rootNames).toContain('file:index.php');
    expect(rootNames).not.toContain('file:.env');
    expect(rootNames).not.toContain('file:.htaccess');

    const indexEntry = rootEntries.find((e) => e.name === 'index.php');
    expect(indexEntry?.navigable).toBe(true);
    expect(indexEntry?.path).toBe('index.php');

    // Subfolder navigation: `pages/`
    const pagesEntries = archive.listVirtualDirectory('pages');
    expect(pagesEntries.map((e) => e.path)).toEqual(['pages/about.php', 'pages/contact.html']);
    expect(pagesEntries[0].navigable).toBe(true);
    expect(pagesEntries[1].navigable).toBe(true);

    // Strict VFS partitioning: frontend VFS NEVER contains `.php`, `.env`, or `.htaccess`
    const feVfs = archive.exportFrontendVfs();
    expect('index.php' in feVfs.textFiles).toBe(false);
    expect('includes/db.php' in feVfs.textFiles).toBe(false);
    expect('.env' in feVfs.textFiles).toBe(false);
    expect('.htaccess' in feVfs.textFiles).toBe(false);
    expect('assets/logo.png' in feVfs.binaryFiles).toBe(true);

    // Backend VFS has everything including `.htaccess` and `.env`
    const beVfs = archive.exportBackendVfs();
    expect('index.php' in beVfs.textFiles).toBe(true);
    expect('includes/db.php' in beVfs.textFiles).toBe(true);
    expect('.htaccess' in beVfs.textFiles).toBe(true);
    expect(archive.getHtaccessFiles().has('')).toBe(true);

    archive.dispose();
  });
});

/**
 * The status a request is refused with under `.htaccess` files `htaccess` (each a directory and
 * its text) and other files `files`, or 0 when it is not refused.
 */
function refusal(
  htaccess: Record<string, string>,
  files: string[],
  request: { method?: string; path: string; query?: string; host?: string; headers?: Record<string, string> }
): number {
  const map = new Map(Object.entries(htaccess).map(([dir, text]) => [dir, parseHtaccess(text, dir)] as const));
  const probe = makeProbe([...Object.keys(htaccess).map((dir) => (dir ? `${dir}/.htaccess` : '.htaccess')), ...files]);
  const res = evaluateHtaccessChain(
    map,
    {
      pathname: request.path,
      query: request.query ?? '',
      method: request.method ?? 'GET',
      host: request.host ?? 'localhost',
      headers: request.headers ?? {},
      https: false,
    },
    probe
  );
  return res.action === 'deny' ? res.status : 0;
}

// The cases the two server hosts are held to (apps/softn-host-rust/src/container_backend.rs and
// apps/softn-host-php/tests/container-backend.test.mjs), where this reader read them otherwise.
describe('.htaccess read as the server hosts read it', () => {
  const LOOKAHEAD = '<FilesMatch "^(?!index\\.php$).*\\.php$">\n  Require all denied\n</FilesMatch>\n';
  const DRUPAL = [
    '<FilesMatch "\\.(engine|inc|install|make|module|profile|po|sh|.*sql|theme|twig|tpl(\\.php)?|xtmpl|yml)',
    '(~|\\.sw[op]|\\.bak|\\.orig|\\.save)?$|^(\\.(?!well-known).*|Entries.*|Repository|Root|Tag|Template|',
    'composer\\.(json|lock)|web\\.config|yarn\\.lock|package\\.json)$|^#.*#$|\\.php(~|\\.sw[op]|\\.bak|\\.orig|\\.save)$">\n',
    '  <IfModule mod_authz_core.c>\n    Require all denied\n  </IfModule>\n',
    '  <IfModule !mod_authz_core.c>\n    Order allow,deny\n    Deny from all\n  </IfModule>\n',
    '</FilesMatch>\n',
  ].join('');
  const denies = (source: string, path: string, method = 'GET') => refusal({ '': source }, [], { method, path }) !== 0;

  it('keeps a deny inside a section for that section', () => {
    // Patterns this reader does not compile. None of the blocks may take the entry script, or
    // anything else, with it. (A pattern over 512 bytes is not read either, and closes the
    // directory instead: 'closes a directory whose <Files> pattern is too long'.)
    const nested = '<FilesMatch "^(a+)+$">\nDeny from all\n</FilesMatch>\n';
    const invalid = '<FilesMatch "(">\nDeny from all\n</FilesMatch>\n';
    for (const source of [DRUPAL, nested, invalid]) {
      for (const path of ['/index.php', '/', '/assets/app.css', '/api/notes', '/aaa']) {
        expect(denies(source, path), `${path} under ${source}`).toBe(false);
      }
    }
    // A look-ahead compiles here (as on the Node host), and names every script but the entry.
    expect(denies(LOOKAHEAD, '/index.php')).toBe(false);
    expect(denies(LOOKAHEAD, '/admin.php')).toBe(true);
    // A header whose pattern holds a `<` or a `>` still opens a block. One that is not closed is
    // not a header Apache reads, and closes the directory ('closes a directory whose section tags
    // are malformed').
    const unclosedHeader = '<FilesMatch "\\.inc$"\nDeny from all\n</FilesMatch>\n';
    expect([denies(unclosedHeader, '/index.php'), denies(unclosedHeader, '/db.inc')]).toEqual([true, true]);
    const named = '<FilesMatch "\\.(?<ext>bak|old)$">\nDeny from all\n</FilesMatch>\n';
    expect([denies(named, '/index.php'), denies(named, '/site.old')]).toEqual([false, true]);
    const angled = '<FilesMatch "^(?!a>b)x\\.txt$">\nDeny from all\n</FilesMatch>\n';
    expect([denies(angled, '/x.txt'), denies(angled, '/index.php')]).toEqual([true, false]);
    // The block ends where it says, so what follows it is still read.
    const thenFiles = `${DRUPAL}<Files "notes.txt">\nDeny from all\n</Files>\n`;
    expect([denies(thenFiles, '/notes.txt'), denies(thenFiles, '/index.php')]).toEqual([true, false]);
    expect(denies(`${DRUPAL}Require all denied\n`, '/index.php')).toBe(true);
    // `<Files ~ "regex">` is the regular-expression form, and an opening tag may have spaces before
    // its `>` (a closing one may not: `</Files >` closes the directory).
    const tilde = '<Files ~ "^\\.ht|\\.bak$">\nDeny from all\n</Files>\n';
    expect([denies(tilde, '/old.BAK'), denies(tilde, '/index.php')]).toEqual([true, false]);
    const quoted = "<FilesMatch '\\.(inc|tpl)$' >\nRequire all denied\n</FilesMatch>\n<Files config.php>\nRequire all denied\n</Files>\n";
    expect([denies(quoted, '/lib/db.inc'), denies(quoted, '/config.php'), denies(quoted, '/index.php')]).toEqual([true, true, false]);
    // Expression sections are not evaluated, so their denies are for nobody. A method section's
    // are for the methods it names.
    const conditional = [
      '<LimitExcept GET POST>\n  Order deny,allow\n  Deny from all\n</LimitExcept>\n',
      '<Limit PUT DELETE>\n  Require all denied\n</Limit>\n',
      '<If "%{HTTP_HOST} == \'old.example\'">\n  Require all denied\n</If>\n',
      '<ElseIf "-R \'10.0.0.0/8\'">\n  Require all denied\n</ElseIf>\n',
      '<Else>\n  <Files "index.php">\n    Require all denied\n  </Files>\n</Else>\n',
      '<Files "admin.php">\n  <Limit POST>\n    Require all denied\n  </Limit>\n</Files>\n',
      '<Files "notes.txt">\n  Require all denied\n</Files>\n',
    ].join('');
    for (const path of ['/index.php', '/admin.php', '/assets/app.css']) {
      expect(denies(conditional, path, 'GET'), `GET ${path}`).toBe(false);
      expect(denies(conditional, path, 'PUT'), `PUT ${path}`).toBe(true);
    }
    expect([denies(conditional, '/index.php', 'POST'), denies(conditional, '/admin.php', 'POST')]).toEqual([false, true]);
    for (const method of ['GET', 'POST', 'PUT']) expect(denies(conditional, '/notes.txt', method)).toBe(true);
    // <IfModule> bodies apply as written: the usual way to close a directory still does.
    const closed = '<IfModule mod_authz_core.c>\n  Require all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\n  Deny from all\n</IfModule>\n';
    expect(denies(closed, '/index.php')).toBe(true);
    const inIfModule = '<IfModule mod_authz_core.c>\n  <Files "config.php">\n    Require all denied\n  </Files>\n</IfModule>\n';
    expect([denies(inIfModule, '/config.php'), denies(inIfModule, '/index.php')]).toEqual([true, false]);
    // Rules outside a skipped section are kept and the ones inside it are not.
    const rewrites = parseHtaccess(
      "RewriteEngine On\n<If \"%{HTTPS} == 'off'\">\n  RewriteRule ^ https://example.test/ [R=301,L]\n</If>\nRewriteRule ^a$ /b [L]\n"
    );
    expect(rewrites.rules.map((rule) => rule.substitution)).toEqual(['/b']);
  });

  it('reads denies as the hosts do', () => {
    const fileDenies = (source: string, files: string[], method: string, path: string) => refusal({ '': source }, files, { method, path }) !== 0;
    // A directive is its words: in any case, with any run of spaces and tabs between. A deny
    // outside a block is for the directory, which this reader did not read at all.
    for (const deny of ['deny  from\tall', 'DENY FROM ALL', 'Require\t\tall   denied', 'require all DENIED', '\t Deny from all \t', '\uFEFFDeny from all']) {
      expect(denies(`${deny}\n`, '/index.php'), JSON.stringify(deny)).toBe(true);
      expect(denies(`<Files "a.txt">\n${deny}\n</Files>\n`, '/a.txt'), JSON.stringify(deny)).toBe(true);
    }
    for (const other of ['Deny from all.example.com', 'Deny from allowed.example', 'Require all deniedx', 'Require all granted', 'Denyfrom all', '# Deny from all']) {
      expect(denies(`${other}\n`, '/index.php'), JSON.stringify(other)).toBe(false);
      expect(denies(`<Files "a.txt">\n${other}\n</Files>\n`, '/a.txt'), JSON.stringify(other)).toBe(false);
    }

    // A rules file too large to read in full refuses everything under it, by its size in UTF-8.
    const padding = (bytes: number) => `#${'x'.repeat(bytes - 2)}\n`;
    const tooLarge = `${padding(64 * 1024)}Options -Indexes\n`;
    for (const path of ['/index.php', '/assets/app.css', '/']) expect(denies(tooLarge, path), path).toBe(true);
    const lastBlock = '<Files "z.txt">\nDeny from all\n</Files>\n';
    const largest = `${padding(64 * 1024 - lastBlock.length)}${lastBlock}`;
    expect(new TextEncoder().encode(largest).length).toBe(64 * 1024);
    expect([denies(largest, '/index.php'), denies(largest, '/z.txt')]).toEqual([false, true]);
    // Bytes, not characters: 22,000 euro signs are 66,000 bytes.
    expect(denies(`#${'€'.repeat(22_000)}\n`, '/index.php')).toBe(true);
    expect(denies(`#${'€'.repeat(21_000)}\n`, '/index.php')).toBe(false);

    // A <Files> block names the file a request is mapped to: the last segment, and a segment
    // before it that is a file (the rest is its PATH_INFO).
    const inc = '<FilesMatch "\\.inc$">\nRequire all denied\n</FilesMatch>\n';
    const under = (path: string) => fileDenies(inc, ['index.php', 'db.inc', 'lib/db.inc'], 'GET', path);
    for (const path of ['/db.inc', '/lib/db.inc', '/nowhere/x.inc', '/db.inc/anything', '/lib/db.inc/a/b']) expect(under(path), path).toBe(true);
    for (const path of ['/missing.inc/anything', '/index.php/anything', '/lib/other']) expect(under(path), path).toBe(false);

    // A deny inside <Limit>/<LimitExcept> is for the methods the section names.
    const except = '<LimitExcept GET POST>\n  Order deny,allow\n  Deny from all\n</LimitExcept>\n';
    for (const [method, refused] of [['GET', false], ['HEAD', false], ['POST', false], ['get', false], ['PUT', true], ['DELETE', true], ['PROPFIND', true]] as const) {
      expect(denies(except, '/index.php', method), method).toBe(refused);
    }
    const only = '<Limit PUT DELETE>\n  Require all denied\n</Limit>\n';
    for (const [method, refused] of [['PUT', true], ['DELETE', true], ['delete', true], ['GET', false], ['POST', false]] as const) {
      expect(denies(only, '/index.php', method), method).toBe(refused);
    }
    // To Apache HEAD is GET, and a method's name is matched by case.
    const get = '<Limit GET>\nDeny from all\n</Limit>\n';
    expect(['GET', 'HEAD', 'POST'].map((method) => denies(get, '/', method))).toEqual([true, true, false]);
    const head = '<LimitExcept HEAD>\nDeny from all\n</LimitExcept>\n';
    expect(['GET', 'HEAD', 'POST'].map((method) => denies(head, '/', method))).toEqual([false, false, true]);
    expect(denies('<Limit get>\nDeny from all\n</Limit>\n', '/', 'GET')).toBe(false);
    expect(denies('<LimitExcept get>\nDeny from all\n</LimitExcept>\n', '/', 'GET')).toBe(true);
    // Inside a block, and with the block's own deny beside it.
    const admin = '<Files "admin.php">\n  <Limit POST>\n    Require all denied\n  </Limit>\n</Files>\n<Limit PUT>\nDeny from all\n</Limit>\n<Files "x.txt">\nDeny from all\n</Files>\n';
    expect(
      [['POST', '/admin.php'], ['GET', '/admin.php'], ['POST', '/index.php'], ['PUT', '/index.php'], ['GET', '/x.txt'], ['GET', '/index.php']].map(([method, path]) => denies(admin, path, method))
    ).toEqual([true, false, false, true, true, false]);
    // What Apache would not load is read the safe way: for every method.
    const nested = '<Limit POST>\n<LimitExcept GET>\nDeny from all\n</LimitExcept>\n</Limit>\n';
    expect(['GET', 'POST'].map((method) => denies(nested, '/', method))).toEqual([true, true]);
    expect(denies('<Limit>\nDeny from all\n</Limit>\n', '/')).toBe(true);
    // A method section under an expression section is skipped with it.
    expect(denies('<If "true">\n<Limit GET>\nDeny from all\n</Limit>\n</If>\n', '/')).toBe(false);

    // More denies than are kept close the directory.
    const blocks = (count: number) =>
      Array.from({ length: count }, (_, n) => `<Files "f${n}.txt">\n<IfModule a>\nRequire all denied\n</IfModule>\n<IfModule !a>\nDeny from all\n</IfModule>\n</Files>\n`).join('');
    expect(denies(blocks(64), '/index.php'), 'said twice in a block is one deny').toBe(false);
    expect(denies(blocks(64), '/f63.txt')).toBe(true);
    expect(denies(blocks(65), '/index.php')).toBe(true);
    expect(denies(`${blocks(64)}Require all denied\n`, '/assets/app.css')).toBe(true);

    // A request for a directory is under that directory's own rules, as one for a file in it is.
    const closedDir = (path: string) => refusal({ admin: 'Require all denied\n' }, ['admin/index.php'], { path }) !== 0;
    for (const path of ['/admin', '/admin/', '/admin/index.php', '/admin/missing']) expect(closedDir(path), path).toBe(true);
    expect([closedDir('/'), closedDir('/administrator')]).toEqual([false, false]);
  });

  it('refuses what RedirectMatch and RewriteRule refuse', () => {
    const files = ['index.php', 'lib/db.inc', 'lib/util.php'];
    type Asked = { method?: string; path: string; query?: string; host?: string; headers?: Record<string, string> };
    const refused = (htaccess: Record<string, string>, request: Asked) => refusal(htaccess, files, request);
    const get = (source: string, path: string, query = '') => refused({ '': source }, { path, query });

    // A RedirectMatch to a status of 400 or more refuses what it matches with that status. It
    // matches the whole path, by case, for any method. This reader refused only for 403, 404
    // and 410, and sent a request elsewhere for any other status with a target.
    const statuses = [
      'RedirectMatch 403 ^/secret/',
      'RedirectMatch 404 ^/includes/',
      'RedirectMatch gone ^/old\\.php$',
      'RedirectMatch 401 ^/members',
      'RedirectMatch 451 ^/withheld',
      'RedirectMatch 503 ^/down$',
      'RedirectMatch 403 ^/Cased',
    ].join('\n');
    for (const [path, status] of [
      ['/secret/key', 403], ['/secret', 0], ['/includes/config.php', 404], ['/old.php', 410], ['/members/list', 401],
      ['/withheld', 451], ['/down', 503], ['/down/x', 0], ['/Cased', 403], ['/cased', 0], ['/index.php', 0],
    ] as const) {
      expect(get(statuses, path), path).toBe(status);
    }
    expect(refused({ '': statuses }, { method: 'POST', path: '/secret/key' })).toBe(403);
    // One that sends the request elsewhere first is the answer; one without a target is passed over.
    const order = 'RedirectMatch 301 ^/moved/(.*)$ /new/$1\nRedirectMatch 403 ^/moved/\nRedirectMatch 302 ^/bare\nRedirectMatch 403 ^/bare\n';
    expect([get(order, '/moved/x'), get(order, '/bare')]).toEqual([0, 403]);
    // A status of 400 or more refuses with a target too; `seeother` is a redirect (303).
    expect(get('RedirectMatch 401 ^/members /login\n', '/members/x')).toBe(401);
    expect(get('RedirectMatch seeother ^/x /y\nRedirectMatch 403 ^/x\n', '/x')).toBe(0);
    // Not read inside a block, a method section or an expression section; read inside <IfModule>.
    const sections = [
      '<Files "x.txt">\nRedirectMatch 403 ^/\n</Files>\n',
      '<Limit GET>\nRedirectMatch 403 ^/\n</Limit>\n',
      '<If "true">\nRedirectMatch 403 ^/\n</If>\n',
      '<IfModule mod_alias.c>\nRedirectMatch 404 ^/hidden/\n</IfModule>\n',
    ].join('');
    expect(['/x.txt', '/index.php', '/hidden/a'].map((path) => get(sections, path))).toEqual([0, 0, 404]);
    // A directory's own, for the directory and what is under it, by the whole path.
    const admin = { admin: 'RedirectMatch 403 ^/admin/?$\nRedirectMatch 404 ^/admin/private/\n' };
    expect(['/admin', '/admin/', '/admin/private/x', '/admin/ok.php', '/private/x'].map((path) => refused(admin, { path }))).toEqual([403, 403, 404, 0, 0]);

    // `RewriteRule … [F]` refuses with 403 and `[G]` with 410, where the rewrite engine is on, the
    // rules before it let the request get that far, and its conditions hold.
    const rules = [
      'RewriteEngine On',
      'RewriteRule ^index\\.php$ - [L]',
      'RewriteRule ^admin/ - [F]',
      'RewriteRule ^ADMIN2 - [F,NC]',
      'RewriteRule ^old\\.html$ - [G]',
      'RewriteCond %{REQUEST_METHOD} =POST',
      'RewriteRule ^api/ - [F]',
      'RewriteCond %{QUERY_STRING} (^|&)debug=',
      'RewriteRule ^ - [F]',
    ].join('\n');
    for (const [path, query, status] of [
      ['/admin/x', '', 403], ['/admin2', '', 403], ['/old.html', '', 410], ['/api/notes', '', 0],
      ['/page', 'debug=1', 403], ['/page', 'a=1&debug', 0], ['/page', '', 0], ['/index.php', 'debug=1', 0], ['/other', '', 0],
    ] as const) {
      expect(get(rules, path, query), `${path}?${query}`).toBe(status);
    }
    expect(refused({ '': rules }, { method: 'POST', path: '/api/notes' })).toBe(403);
    // With the engine off, at the end of the file or never turned on, no rule is run.
    expect(get('RewriteEngine On\nRewriteRule ^ - [F]\nRewriteEngine Off\n', '/x')).toBe(0);
    expect(get('RewriteRule ^ - [F]\n', '/x')).toBe(0);

    // A request the rules rewrite is refused for where it is rewritten to: by a later rule, a
    // <FilesMatch> or a RedirectMatch. One they send elsewhere first is not refused.
    const rewrites = [
      'RewriteEngine On',
      'RewriteRule ^go$ /elsewhere [R=301,L]',
      'RewriteRule ^go$ - [F]',
      'RewriteRule ^old/(.*)$ new/$1',
      'RewriteRule ^new/secret - [F]',
      'RewriteRule ^config$ lib/db.inc [L]',
      'RewriteRule ^hide/(.*)$ /hidden/$1 [L]',
      '<FilesMatch "\\.inc$">\nRequire all denied\n</FilesMatch>',
      'RedirectMatch 404 ^/hidden/',
    ].join('\n');
    expect(['/go', '/old/secret', '/old/public', '/config', '/hide/a'].map((path) => get(rewrites, path))).toEqual([0, 403, 0, 403, 404]);

    // Conditions on the bundle's files and directories, the host and the request's headers, with
    // [OR] and [NC]. The Cookie header is never read into one (this reader read it).
    const conditions = [
      'RewriteEngine On',
      'RewriteCond %{REQUEST_FILENAME} !-f',
      'RewriteRule \\.php$ - [F]',
      'RewriteCond %{REQUEST_FILENAME} -d',
      'RewriteRule ^ - [G]',
      'RewriteCond %{HTTP_HOST} ^old\\. [NC,OR]',
      'RewriteCond %{HTTP:X-Legacy} ^1$',
      'RewriteRule ^ - [F]',
      'RewriteCond %{HTTP:Cookie} session',
      'RewriteRule ^ - [F]',
    ].join('\n');
    const asked = (request: Asked) => refused({ '': conditions }, request);
    expect(asked({ path: '/missing.php' })).toBe(403);
    expect(asked({ path: '/index.php' })).toBe(0);
    expect(asked({ path: '/lib/util.php' })).toBe(0);
    expect(asked({ path: '/lib' })).toBe(410);
    expect(asked({ path: '/page', host: 'Old.example.com' })).toBe(403);
    expect(asked({ path: '/page', headers: { 'x-legacy': '1' } })).toBe(403);
    expect(asked({ path: '/page', headers: { cookie: 'session=abc' } })).toBe(0);
    expect(asked({ path: '/page' })).toBe(0);

    // A directory's rules are for what is under it, matched without its name.
    const sub = { admin: 'RewriteEngine On\nRewriteRule ^secret - [F]\n' };
    expect(['/admin/secret.txt', '/secret.txt', '/admin', '/admin/x/secret'].map((path) => refused(sub, { path }))).toEqual([403, 0, 0, 0]);
    // Not read inside a method section; a rule whose pattern does not compile is not read, and the
    // conditions before it go with it.
    expect(refused({ '': 'RewriteEngine On\n<Limit POST>\nRewriteRule ^ - [F]\n</Limit>\n' }, { method: 'POST', path: '/x' })).toBe(0);
    const invalid = 'RewriteEngine On\nRewriteCond %{REQUEST_METHOD} =GET\nRewriteRule ( - [F]\nRewriteRule ^blocked - [F]\n';
    expect(refused({ '': invalid }, { method: 'POST', path: '/blocked' })).toBe(403);
    expect(get(invalid, '/x')).toBe(0);
  });

  it('closes a directory with more rules than are kept', () => {
    const get = (source: string, path: string) => refusal({ '': source }, ['index.php'], { path });
    const lines = (count: number, line: (n: number) => string) => Array.from({ length: count }, (_, n) => `${line(n)}\n`).join('');
    // 256 RewriteRule lines are read, the last of them too; a 257th closes the directory.
    const rules = (count: number) => `RewriteEngine On\n${lines(count, (n) => `RewriteRule ^r${n}$ /x${n}`)}RewriteRule ^admin - [F]\n`;
    expect([get(rules(255), '/admin'), get(rules(255), '/index.php')]).toEqual([403, 0]);
    for (const path of ['/admin', '/index.php', '/assets/app.css']) expect(get(rules(256), path), path).toBe(403);
    // So do 257 RedirectMatch lines.
    const redirects = (count: number) => `${lines(count, (n) => `RedirectMatch 301 ^/r${n}$ /x${n}`)}RedirectMatch 403 ^/secret\n`;
    expect([get(redirects(255), '/secret'), get(redirects(255), '/index.php')]).toEqual([403, 0]);
    expect([get(redirects(256), '/secret'), get(redirects(256), '/index.php')]).toEqual([403, 403]);
    // And 65 RewriteCond lines before one rule (64 are read).
    const conds = (count: number, then: string) =>
      `RewriteEngine On\n${lines(count, (n) => `RewriteCond %{HTTP_HOST} !^nowhere${n}$`)}${then}RewriteRule ^public - [L]\nRewriteRule ^ - [F]\n`;
    expect([get(conds(64, ''), '/public'), get(conds(64, ''), '/other')]).toEqual([0, 403]);
    expect(get(conds(64, 'RewriteCond %{HTTP_HOST} =nowhere\n'), '/public')).toBe(403);
    expect(get(conds(65, ''), '/public')).toBe(403);
    // Lines that are not read (in an expression section) are not counted.
    const skipped = `RewriteEngine On\n<If "true">\n${lines(300, (n) => `RewriteRule ^r${n}$ /x${n}`)}</If>\nRewriteRule ^admin - [F]\n`;
    expect([get(skipped, '/admin'), get(skipped, '/index.php')]).toEqual([403, 0]);
  });

  it('closes a directory whose sections do not match up', () => {
    const get = (source: string, path: string) => refusal({ '': source }, ['index.php'], { path });
    // Left open at the end of the file: a block, a method section, <IfModule>, <If>.
    for (const source of [
      '<Files "secret.txt">\nRequire all denied\n',
      '<FilesMatch "\\.inc$">\nDeny from all\n',
      '<Files "a.txt">\nRequire all denied\nRewriteEngine On\nRewriteRule ^admin - [F]\n',
      '<Limit POST>\nRequire all denied\n',
      '<IfModule mod_rewrite.c>\nRewriteEngine On\n',
      '<If "true">\nRequire all denied\n',
      '<IfModule a>\n<Files "x.txt">\nRequire all denied\n</Files>\n',
    ]) {
      for (const path of ['/index.php', '/secret.txt', '/assets/app.css', '/']) {
        expect(get(source, path), `${path} under ${JSON.stringify(source)}`).toBe(403);
      }
    }
    // Closed where it is not the innermost open section, or not open at all.
    for (const source of [
      '</Files>\nOptions -Indexes\n',
      '<Files "a.txt">\nRequire all denied\n</FilesMatch>\n',
      '<IfModule a>\n<Files "x">\n</IfModule>\n</Files>\n',
      '<Limit POST>\n</LimitExcept>\n',
      '<If "true">\n</If>\n</If>\n',
    ]) {
      expect(get(source, '/index.php'), JSON.stringify(source)).toBe(403);
    }
    // Sections that match up are read as before, whatever the case of their names.
    const nested = '<IfModule a>\n<Files "x.txt">\nRequire all denied\n</Files>\n</IfModule>\n';
    expect([get(nested, '/x.txt'), get(nested, '/index.php')]).toEqual([403, 0]);
    const cased = '<files "x.txt">\nRequire all denied\n</FILES>\n';
    expect([get(cased, '/x.txt'), get(cased, '/index.php')]).toEqual([403, 0]);
    expect(get('# <Files "x.txt">\nOptions -Indexes\n', '/index.php')).toBe(0);
  });

  type RefusalRequest = { method?: string; path: string; query?: string; host?: string };
  /** The status a request is refused with in a bundle of index.php, lib/db.inc and lib/util.php whose `.htaccess` files are `htaccess`, or 0. */
  const refusalOf = (htaccess: Record<string, string>, request: RefusalRequest) => refusal(htaccess, ['index.php', 'lib/db.inc', 'lib/util.php'], request);

  // The hosts' "the two hosts read negated rule patterns as Apache does". All three readers took
  // the `!` of `RewriteRule !pattern` for part of the pattern, so `RewriteRule !^public/ - [F]`
  // matched nothing and forbade nothing.
  it('reads negated rule patterns as Apache does', () => {
    const get = (source: string, path: string) => refusalOf({ '': source }, { path });

    // `RewriteRule !pattern` is for a path the pattern does not match, by case unless [NC].
    const outside = 'RewriteEngine On\nRewriteRule !^public/ - [F]\n';
    expect(['/public/app.css', '/public/', '/index.php', '/public', '/', '/x/public/a', '/PUBLIC/a'].map((path) => get(outside, path))).toEqual([
      0, 0, 403, 403, 403, 403, 403,
    ]);
    expect(['/PUBLIC/a', '/Other'].map((path) => get('RewriteEngine On\nRewriteRule !^public/ - [F,NC]\n', path))).toEqual([0, 403]);
    expect(['/keep.html', '/x'].map((path) => get('RewriteEngine On\nRewriteRule !^keep\\.html$ - [G]\n', path))).toEqual([0, 410]);
    // An empty pattern matches every path, so its negation none.
    expect(get('RewriteEngine On\nRewriteRule ! - [F]\n', '/x')).toBe(0);
    // A directory's, for what is under it, matched without its name.
    const admin = { admin: 'RewriteEngine On\nRewriteRule !^login\\.php$ - [F]\n' };
    expect(['/admin/login.php', '/admin/users', '/admin', '/index.php'].map((path) => refusalOf(admin, { path }))).toEqual([0, 403, 403, 0]);
    // Its conditions must hold, as for any rule.
    const posted = { '': 'RewriteEngine On\nRewriteCond %{REQUEST_METHOD} =POST\nRewriteRule !^api/ - [F]\n' };
    expect(
      [['POST', '/x'], ['POST', '/api/notes'], ['GET', '/x']].map(([method, path]) => refusalOf(posted, { method, path }))
    ).toEqual([403, 0, 0]);
    // `$1`…`$9` are empty, as the pattern matched nothing: `/x` is rewritten to `/gone/`.
    const groups = 'RewriteEngine On\nRewriteRule !^(public)/(.*)$ /gone/$2 [L]\nRedirectMatch 410 ^/gone/$\n';
    expect(['/x', '/public/a'].map((path) => get(groups, path))).toEqual([410, 0]);
  });

  // The hosts' "the two hosts read negated conditions and RedirectMatch as Apache does". All three
  // readers read these so already.
  it('reads negated conditions and RedirectMatch as Apache does', () => {
    const get = (source: string, path: string) => refusalOf({ '': source }, { path });

    // RedirectMatch has no negated form: a leading `!` is part of its pattern, as Apache reads it,
    // so `!^/public/` matches nothing.
    const redirects = 'RedirectMatch 403 !^/public/\nRedirectMatch 404 !private\n';
    expect(['/x', '/public/a', '/private', '/a!private'].map((path) => get(redirects, path))).toEqual([0, 0, 0, 404]);

    // `RewriteCond … !CondPattern` holds where the pattern does not: a pattern, `=text` (by case
    // unless [NC]) or a file test, alone or in an [OR] run.
    const conds = { '': 'RewriteEngine On\nRewriteCond %{REQUEST_URI} !^/public/\nRewriteCond %{HTTP_HOST} !=static.example [NC]\nRewriteRule ^ - [F]\n' };
    expect(
      [['/public/x', 'localhost'], ['/other', 'localhost'], ['/other', 'STATIC.example'], ['/other', 'static.example.com']].map(([path, host]) =>
        refusalOf(conds, { path, host })
      )
    ).toEqual([0, 403, 0, 403]);
    expect(['/lib', '/lib.txt'].map((path) => get('RewriteEngine On\nRewriteCond %{REQUEST_FILENAME} !-d\nRewriteRule ^lib - [F]\n', path))).toEqual([0, 403]);
    const either = { '': 'RewriteEngine On\nRewriteCond %{HTTP_HOST} ^admin\\. [OR]\nRewriteCond %{QUERY_STRING} !(^|&)token=\nRewriteRule ^panel - [F]\n' };
    expect(
      [['', 'localhost'], ['token=1', 'localhost'], ['token=1', 'admin.example']].map(([query, host]) => refusalOf(either, { path: '/panel', query, host }))
    ).toEqual([403, 0, 403]);
    // A negated condition gives `%1`…`%9` nothing, even where its pattern matched: `%1` here is
    // the first condition's `secret`, not the second's `public`.
    const backrefs = {
      '': [
        'RewriteEngine On',
        'RewriteCond %{QUERY_STRING} ^to=([a-z]+)$',
        'RewriteCond %{HTTP_HOST} !^(public)\\. [OR]',
        'RewriteCond %{REQUEST_METHOD} =GET',
        'RewriteRule ^go$ /%1 [L]',
        'RewriteRule ^secret$ - [F]',
      ].join('\n'),
    };
    expect(
      [['to=secret', 'public.example'], ['to=secret', 'localhost'], ['to=public', 'public.example']].map(([query, host]) =>
        refusalOf(backrefs, { path: '/go', query, host })
      )
    ).toEqual([403, 403, 0]);
  });

  // The hosts' "the two hosts close a directory whose section tags are malformed". Apache will
  // not load a file with a section tag like these and answers 500 for everything under the
  // directory; all three readers took `</Files >` and `<Files "secret.txt"` for the tags they
  // look like.
  it('closes a directory whose section tags are malformed', () => {
    const get = (source: string, path: string) => refusal({ '': source }, ['index.php'], { path });
    const malformed = [
      // An opening tag without its `>`, one with a `>` among its arguments and none at the end,
      // one whose name runs into its argument, and one in a section not evaluated.
      '<Files "secret.txt"\nRequire all denied\n</Files>\n',
      '<FilesMatch "\\.inc$"\nDeny from all\n</FilesMatch>\n',
      '<IfModule mod_rewrite.c\nRewriteEngine On\n</IfModule>\n',
      '<IfVersion >= 2.4\n</IfVersion>\n',
      '<Files"secret.txt">\nRequire all denied\n</Files>\n',
      '<If "true">\n<Files "secret.txt"\n</Files>\n</If>\n',
      // A closing tag that is not `</Name>`: a space before its `>`, no `>`, a space after its `<`.
      '<Files "secret.txt">\nRequire all denied\n</Files >\n',
      '<Files "secret.txt">\nRequire all denied\n</Files\n',
      '<IfModule a>\n</IfModule >\n',
      '</ Files>\nOptions -Indexes\n',
      // Words after a tag's `>`. Apache passes over them after some tags and not others; here a
      // tag is its whole line.
      '<Files "secret.txt"> # private\nRequire all denied\n</Files>\n',
      '<Files "secret.txt">\nRequire all denied\n</Files> # private\n',
    ];
    const readAnyway = malformed.filter((source) => ['/index.php', '/secret.txt', '/assets/app.css', '/'].some((path) => get(source, path) !== 403));
    expect(readAnyway, 'not refused everything under these').toEqual([]);
    // Spaces before an opening tag's `>`, a tab after its name, a `>` among its arguments or in its
    // pattern, and a name with its `>` alone, are tags Apache reads, and so are they here.
    for (const source of [
      '<Files "secret.txt" >\nRequire all denied\n</Files>\n',
      '<Files\t"secret.txt">\nRequire all denied\n</Files>\n',
      '<IfVersion >= 2.4>\n<Files "secret.txt">\nRequire all denied\n</Files>\n</IfVersion>\n',
      '<FilesMatch "^secret>?\\.txt$">\nRequire all denied\n</FilesMatch>\n',
      '<If "true">\n</If>\n<Else>\nRequire all denied\n</Else>\n<Files "secret.txt">\nRequire all denied\n</Files>\n',
    ]) {
      expect([get(source, '/secret.txt'), get(source, '/index.php')], JSON.stringify(source)).toEqual([403, 0]);
    }
  });

  // The hosts' "the two hosts close a directory whose <Files> pattern is too long". A
  // <FilesMatch> or <Files ~> pattern was held to 512 characters here (by the guard on patterns),
  // 1024 bytes on the Rust host and 256 characters on the Node host, and a <Files> name to 512
  // characters of the pattern it is made into here and 256 there, and one past the limit denied
  // nothing.
  it('closes a directory whose <Files> pattern is too long', () => {
    const get = (source: string, path: string) => refusal({ '': source }, ['index.php'], { path });
    const regexOf = (padding: string) => `^secret\\.txt$|^${padding}$`;
    const filesMatch = (pattern: string) => `<FilesMatch "${pattern}">\nRequire all denied\n</FilesMatch>\n`;
    const tilde = (pattern: string) => `<Files ~ "${pattern}">\nRequire all denied\n</Files>\n`;
    const files = (name: string) => `<Files "${name}">\nRequire all denied\n</Files>\n`;
    // 512 bytes, in ASCII and in two-byte characters, and a byte more.
    const [fits, fitsShort] = [regexOf('a'.repeat(496)), regexOf('é'.repeat(248))];
    const [over, overShort] = [regexOf('a'.repeat(497)), regexOf(`a${'é'.repeat(248)}`)];
    const [name, nameShort] = [`${'a'.repeat(508)}.txt`, `${'é'.repeat(254)}.txt`];
    const [longName, longNameShort] = [`${'a'.repeat(509)}.txt`, `a${'é'.repeat(254)}.txt`];
    expect(
      [fits, fitsShort, over, overShort, name, nameShort, longName, longNameShort].map((pattern) => [new TextEncoder().encode(pattern).length, pattern.length])
    ).toEqual([[512, 512], [512, 264], [513, 513], [513, 265], [512, 512], [512, 258], [513, 513], [513, 259]]);

    // A pattern of 512 bytes is read: it names what it names, and nothing else.
    const read: Array<[string, string, string]> = [
      ['<FilesMatch> of 512 bytes', filesMatch(fits), '/secret.txt'],
      ['<FilesMatch> of 512 bytes in 264 characters', filesMatch(fitsShort), '/secret.txt'],
      ['<Files ~> of 512 bytes', tilde(fits), '/secret.txt'],
      ['<Files ~> of 512 bytes in 264 characters', tilde(fitsShort), '/secret.txt'],
      ['<Files> of 512 bytes', files(name), `/${name}`],
      ['<Files> of 512 bytes in 258 characters', files(nameShort), `/${nameShort}`],
    ];
    const misread = read.filter(([, source, named]) => get(source, named) !== 403 || get(source, '/index.php') !== 0).map(([label]) => label);

    // One a byte longer, or far longer, refuses everything under the directory.
    const closing: Array<[string, string]> = [
      ['<FilesMatch> of 513 bytes', filesMatch(over)],
      ['<FilesMatch> of 513 bytes in 265 characters', filesMatch(overShort)],
      ['<FilesMatch> of 2000 bytes', filesMatch('a'.repeat(2000))],
      ['<Files ~> of 513 bytes', tilde(over)],
      ['<Files ~> of 513 bytes in 265 characters', tilde(overShort)],
      ['<Files> of 513 bytes', files(longName)],
      ['<Files> of 513 bytes in 259 characters', files(longNameShort)],
    ];
    const readAnyway = closing
      .filter(([, source]) => ['/index.php', '/secret.txt', '/assets/app.css', '/'].some((path) => get(source, path) !== 403))
      .map(([label]) => label);
    // Those not read as written, and those not refused everything under.
    expect({ misread, readAnyway }).toEqual({ misread: [], readAnyway: [] });

    // Not read in a section that is not evaluated, and so not held to the limit.
    expect(get(`<If "true">\n${filesMatch('a'.repeat(2000))}</If>\n`, '/index.php')).toBe(0);
  });
});
