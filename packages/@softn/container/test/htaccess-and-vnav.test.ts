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
