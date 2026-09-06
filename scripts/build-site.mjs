#!/usr/bin/env node
/**
 * Build everything softn.com serves, into one `dist/` you can upload anywhere.
 *
 *   dist/            the landing page and app directory
 *   dist/demos/      the .softn bundles, at the root so `?open=/demos/x.softn`
 *                    resolves the same way from the site and from the runtime
 *   dist/softn-files/ a clearly named copy of the canonical portable bundles
 *   dist/web/        the web runtime
 *   dist/builder/    the visual builder
 *   dist/studio/     the AI studio
 *   dist/api/        the directory API (PHP), executed by the host, never served
 *   dist/data/       the directory's state; starts out holding only the rules
 *                    that keep it unserved
 *   dist/.htaccess   Apache deployment rules, with nginx.conf.example and
 *                    DEPLOY.md alongside; both configs send the cross-origin
 *                    isolation headers on every response, which the runtime's
 *                    worker mode depends on
 *   dist/BUILD-INFO.json  what was built, from which revision
 *
 * The three apps are built with a `VITE_BASE` matching where they land, which
 * is what makes their assets, their service worker scope and their own internal
 * routes agree with the directory they are served from.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist');

const APPS = [
  { workspace: '@softn/web', dir: 'apps/softn-web', base: '/web/', into: 'web' },
  { workspace: '@softn/builder', dir: 'apps/softn-builder', base: '/builder/', into: 'builder' },
  { workspace: '@softn/studio', dir: 'apps/softn-studio', base: '/studio/', into: 'studio' },
];

const APACHE_CONFIG = String.raw`# SoftN static deployment for Apache 2.4+
# Keep this file beside index.html in the website document root.

DirectoryIndex index.html
Options -Indexes
ErrorDocument 404 default

<IfModule mod_negotiation.c>
  Options -MultiViews
</IfModule>

<IfModule mod_mime.c>
  AddType application/wasm .wasm
  AddType application/manifest+json .webmanifest
  AddType application/octet-stream .softn
</IfModule>

<IfModule mod_headers.c>
  Header always set X-Content-Type-Options "nosniff"
  Header always set Referrer-Policy "strict-origin-when-cross-origin"
  Header always set X-Frame-Options "SAMEORIGIN"

  # Cross-origin isolation gives the page SharedArrayBuffer, which is what
  # lets a language model on the CPU provider use every core instead of one:
  # on a machine without a usable GPU that is the difference between slow and
  # apparently hung. credentialless rather than require-corp, so images and
  # model files fetched from other origins keep working without CORP headers.
  Header always set Cross-Origin-Opener-Policy "same-origin"
  Header always set Cross-Origin-Embedder-Policy "credentialless"

  # Brief caching for unhashed static files. Vite's fingerprinted assets are
  # immutable; HTML, service workers, catalogues and bundles must revalidate.
  #
  # Each pattern tolerates a trailing .br/.gz because FilesMatch tests the file
  # Apache ends up serving, not the URL asked for: after the rewrite below picks
  # a precompressed twin, "app-8f3ac91b.wasm.br" has to match the same rule its
  # uncompressed original does, or every compressed asset silently drops out of
  # the immutable bucket and back to an hour.
  <FilesMatch "\.(?:css|js|mjs|map|wasm|woff2?|ttf|png|jpe?g|gif|webp|svg|ico)(?:\.(?:br|gz))?$">
    Header set Cache-Control "public, max-age=3600"
  </FilesMatch>
  <FilesMatch "-[A-Za-z0-9_-]{8,}\.(?:css|js|mjs|map|wasm|woff2?|ttf|png|jpe?g|gif|webp|svg)(?:\.(?:br|gz))?$">
    Header set Cache-Control "public, max-age=31536000, immutable"
  </FilesMatch>
  <FilesMatch "\.(?:html?|json|webmanifest|softn)(?:\.(?:br|gz))?$">
    Header set Cache-Control "no-cache, max-age=0, must-revalidate"
  </FilesMatch>
  <FilesMatch "^(?:registerSW|sw|service-worker)\.js(?:\.(?:br|gz))?$">
    Header set Cache-Control "no-cache, max-age=0, must-revalidate"
  </FilesMatch>
</IfModule>

<IfModule mod_deflate.c>
  AddOutputFilterByType DEFLATE text/html text/plain text/css text/javascript
  AddOutputFilterByType DEFLATE application/javascript application/json
  AddOutputFilterByType DEFLATE application/manifest+json application/wasm image/svg+xml
</IfModule>

# Prefer the .br/.gz twins the build wrote. Brotli at the quality used here is
# far too slow to run per request, so the win only exists if the file is already
# on disk: the engine alone is 5.4MB raw, 1.8MB gzipped and 1.2MB brotlied.
# mod_deflate above still covers anything without a twin.
#
# AddEncoding, not a Header in a FilesMatch. The first version of this set
# Content-Encoding from <FilesMatch "\.br$"> after the rewrite had already
# chosen the file, and those sections are merged from the ORIGINAL request, so
# on a real host the swap happened and the header did not: browsers were handed
# brotli bytes labelled as JavaScript and reported "Invalid or unexpected
# token". AddEncoding is the mechanism Apache provides for exactly this — it
# reads the trailing .br/.gz as an encoding and takes the content type from the
# extension underneath, so app.js.br serves as application/javascript with
# Content-Encoding: br, and no per-type rules are needed at all.
#
# Both modules are required. Without mod_mime nothing labels the encoding, and
# serving a compressed body unlabelled is worse than not compressing, so the
# rewrite is nested inside it rather than left to run alone.
<IfModule mod_mime.c>
  AddEncoding br .br
  AddEncoding gzip .gz

<IfModule mod_rewrite.c>
  RewriteEngine On

  RewriteCond %{HTTP:Accept-Encoding} br
  RewriteCond %{REQUEST_FILENAME}\.br -f
  RewriteRule ^(.*)$ $1.br [QSA,L]

  RewriteCond %{HTTP:Accept-Encoding} gzip
  RewriteCond %{REQUEST_FILENAME}\.gz -f
  RewriteRule ^(.*)$ $1.gz [QSA,L]
</IfModule>
</IfModule>

<IfModule mod_headers.c>
  # Caches must not hand a brotli body to a client that did not ask for one.
  <FilesMatch "\.(?:css|js|mjs|map|wasm|svg|json|html?|txt|webmanifest)$">
    Header append Vary Accept-Encoding
  </FilesMatch>
</IfModule>

<IfModule mod_rewrite.c>
  RewriteEngine On

  # The directory API: everything under /api/ is one PHP script. Before the
  # static rules, because /api/apps/x/bundle.softn has an extension and would
  # otherwise be refused as a missing asset.
  RewriteRule ^api(?:/.*)?$ api/index.php [QSA,L]

  # The directory's state — its database, every uploaded bundle, the config
  # with the admin key — is never served. The data/.htaccess says so too.
  RewriteRule ^data(?:/|$) - [R=404,L]

  # An app's page, when a browser asks for it, comes through the API so the
  # <meta> tags carry the app's own name and picture: a link pasted into a
  # chat unfurls as the app, not as the site. Every other page is the SPA.
  RewriteCond %{HTTP_ACCEPT} text/html [NC]
  RewriteRule ^app/[^/]+/?$ api/index.php [L]

  # Canonical app roots keep relative assets and service-worker scopes correct.
  RewriteRule ^(web|builder|studio)$ $1/ [R=308,L,NE]

  # Real files and directories always win.
  RewriteCond %{REQUEST_FILENAME} -f [OR]
  RewriteCond %{REQUEST_FILENAME} -d
  RewriteRule ^ - [END]

  # A missing asset is a real 404, never a successful HTML response. This also
  # protects extensionless files requested from known static directories.
  RewriteRule ^(?:assets|demos|softn-files)(?:/|$) - [R=404,L]
  RewriteRule ^(?:web|builder|studio)/(?:assets|demos)(?:/|$) - [R=404,L]
  RewriteCond %{REQUEST_URI} /[^/]*\.[^/]+$
  RewriteRule ^ - [R=404,L]

  # Only browser navigations receive an SPA shell. API/fetch requests with a
  # non-HTML Accept header therefore retain their proper 404 response too.
  RewriteCond %{HTTP_ACCEPT} text/html [NC]
  RewriteRule ^web(?:/.*)?$ web/index.html [END]

  RewriteCond %{HTTP_ACCEPT} text/html [NC]
  RewriteRule ^builder(?:/.*)?$ builder/index.html [END]

  RewriteCond %{HTTP_ACCEPT} text/html [NC]
  RewriteRule ^studio(?:/.*)?$ studio/index.html [END]

  RewriteCond %{HTTP_ACCEPT} text/html [NC]
  RewriteRule ^ index.html [END]
</IfModule>
`;

const NGINX_CONFIG = String.raw`# Install this file in nginx's http context (for example,
# /etc/nginx/sites-available/softn), then change server_name and root.

map $http_accept $softn_html_navigation {
    default      0;
    ~*text/html  1;
}

map "$sent_http_content_type|$uri" $softn_cache_control {
    default                                                        "public, max-age=3600";
    ~^text/html                                                    "no-cache, max-age=0, must-revalidate";
    ~^application/(?:json|manifest\+json)                          "no-cache, max-age=0, must-revalidate";
    ~*\|.*/(?:registerSW|sw|service-worker)\.js$                   "no-cache, max-age=0, must-revalidate";
    ~*\|.*\.softn$                                                "no-cache, max-age=0, must-revalidate";
    "~*\|.*-[A-Za-z0-9_-]{8,}\.(?:css|js|mjs|map|wasm|woff2?|ttf|png|jpe?g|gif|webp|svg)$"
                                                                   "public, max-age=31536000, immutable";
}

server {
    listen 80;
    listen [::]:80;
    server_name example.com;
    root /var/www/softn;
    index index.html;

    include /etc/nginx/mime.types;
    default_type application/octet-stream;
    charset utf-8;
    autoindex off;
    server_tokens off;

    add_header X-Content-Type-Options "nosniff" always;
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "credentialless" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header Cache-Control $softn_cache_control;

    # Serve the .br/.gz twins the build wrote in preference to compressing per
    # request: brotli at build quality is far too slow to run live, and it is
    # where the engine's 5.4MB becomes 1.2MB rather than the 1.4MB a live
    # brotli pass would manage. gzip_static needs nginx built with
    # --with-http_gzip_static_module; brotli_static needs the ngx_brotli module.
    # Both degrade to the on-the-fly gzip below when absent or when a file has
    # no twin.
    # The directory API is PHP: hand /api/ to PHP-FPM, refuse /data/ outright,
    # and let an app's page go through the API so its <meta> tags are its own.
    location /data/ { return 404; }
    location ~ ^/api(/|$) {
        fastcgi_pass unix:/run/php/php-fpm.sock;
        fastcgi_param SCRIPT_FILENAME $document_root/api/index.php;
        include fastcgi_params;
    }
    location ~ ^/app/[^/]+/?$ {
        fastcgi_pass unix:/run/php/php-fpm.sock;
        fastcgi_param SCRIPT_FILENAME $document_root/api/index.php;
        include fastcgi_params;
    }

    brotli_static on;
    gzip_static on;

    gzip on;
    gzip_vary on;
    gzip_types text/plain text/css application/javascript application/json
               application/manifest+json application/wasm image/svg+xml;

    # Configure TLS here, or terminate HTTPS at the reverse proxy/CDN.

    location = /web { return 308 /web/$is_args$args; }
    location = /builder { return 308 /builder/$is_args$args; }
    location = /studio { return 308 /studio/$is_args$args; }

    # nginx does not protect Apache control files automatically.
    location ~ /\.(?!well-known(?:/|$)) { return 404; }

    # Force the MIME types that older distro mime.types files may omit.
    location ~* \.wasm$ {
        types { application/wasm wasm; }
        try_files $uri =404;
    }
    location ~* \.webmanifest$ {
        types { application/manifest+json webmanifest; }
        try_files $uri =404;
    }
    location ~* \.softn$ {
        types { application/octet-stream softn; }
        try_files $uri =404;
    }

    # Missing static files must stay 404s, including extensionless files in
    # asset/catalogue directories and ordinary files with an extension.
    location ~ ^/(?:assets|demos|softn-files|web/(?:assets|demos)|builder/assets|studio/assets)(?:/|$) {
        try_files $uri =404;
    }
    location ~* /[^/]*\.[^/]+$ {
        try_files $uri =404;
    }

    location /web/ { try_files $uri $uri/ @softn_web; }
    location /builder/ { try_files $uri $uri/ @softn_builder; }
    location /studio/ { try_files $uri $uri/ @softn_studio; }
    location / { try_files $uri $uri/ @softn_site; }

    location @softn_web {
        if ($softn_html_navigation = 0) { return 404; }
        try_files /web/index.html =404;
    }
    location @softn_builder {
        if ($softn_html_navigation = 0) { return 404; }
        try_files /builder/index.html =404;
    }
    location @softn_studio {
        if ($softn_html_navigation = 0) { return 404; }
        try_files /studio/index.html =404;
    }
    location @softn_site {
        if ($softn_html_navigation = 0) { return 404; }
        try_files /index.html =404;
    }
}
`;

const DEPLOY_GUIDE = `# Deploying SoftN

This directory is the complete static release. Upload its **contents** to one
website document root so that this file sits beside \`index.html\`; keep the
directory layout intact and make sure your upload includes the hidden
\`.htaccess\` file.

## The directory API (PHP)

\`/api/\` is the app directory: the catalogue, uploads, comments, ratings,
remixes and each published app's own database. It is plain PHP (8.1 or newer)
with SQLite, and it keeps every piece of state as files under \`data/\`, so the
host needs no database server and no accounts.

What it needs from the host:

- PHP 8.1+ with the \`pdo_sqlite\` and \`zip\` extensions (both are standard on
  cPanel hosts; \`/api/health\` reports what it found).
- \`data/\` writable by PHP. Upload it with the site and, if the first request
  to \`/api/health\` says it is not writable, give it write permission (0775 or
  0777 on shared hosting).
- Upload limits large enough for a bundle: \`api/.user.ini\` asks for 64 MB on
  PHP-FPM and CGI hosts. A mod_php host reads \`php_value\` from .htaccess
  instead; if publishing a large bundle fails, raise \`upload_max_filesize\`
  and \`post_max_size\` wherever this host takes them.

On first use the API publishes the demo bundles into the directory and writes
\`data/config.json\` — which holds the site's **admin key**. Keep that file
private (it is, by the rules above) and use the key to moderate: approve or
rename suggested categories, hide apps, remove comments. Back the directory up
by copying \`data/\`; move it by copying it; reset it by emptying it.

Publishing from a script: \`POST /api/apps\` with the bundle as a multipart
field, as the raw body, or as base64 in JSON. \`GET /api\` lists the routes.

## Apache / cPanel

The included \`.htaccess\` is ready for Apache 2.4. The host must permit
\`AllowOverride FileInfo Indexes Options\` (or \`AllowOverride All\`) and enable
\`mod_rewrite\` and \`mod_mime\`;
\`mod_headers\` and \`mod_deflate\` add the supplied security, cache and
compression rules when available.

## Compression

The build writes \`.br\` and \`.gz\` twins beside every compressible file.
They exist because the quality worth having cannot be afforded per request: the
zipp engine is 5.4MB raw, 1.8MB gzipped, and 1.2MB at the brotli quality used
here -- 6.3s to produce against 0.1s for a live-quality pass, which is why it
is spent once at build time rather than per request. Serving the twin costs
the server nothing.

nginx needs \`gzip_static\` (built in with
\`--with-http_gzip_static_module\`) and, for the smaller half of the win,
the third-party \`ngx_brotli\` module for \`brotli_static\`. Apache serves them
through the supplied rewrite, which needs \`mod_rewrite\` and \`mod_headers\`:
without \`mod_headers\` the rewrite is skipped entirely, deliberately, because a
brotli stream served without \`Content-Encoding\` is not a file any browser can
read. Either way, anything with no twin still falls back to compressing live.

Bundles are left alone: a \`.softn\` is a ZIP, so a second pass would spend CPU
to produce a slightly larger file.

## Optional: the poker table authority

Texas Hold'em's online table is a separate process — softn-server running
the bundle's own server logic — which this static release does not include.
Without it the app still plays solo, with bots, and over peer-to-peer sync.
To offer online tables, run the process and proxy a path of the site to it;
the recipe is \`docs/hosting-the-poker-authority.md\` in the repository.

## nginx

nginx ignores \`.htaccess\`. Copy \`nginx.conf.example\` into nginx's HTTP
configuration, change its \`server_name\` and \`root\`, then validate and reload:

    sudo nginx -t
    sudo systemctl reload nginx

Add TLS in nginx or at your hosting proxy/CDN. HTTPS is required for service
workers and browser permissions outside localhost.

## What is included

- \`/\` — landing site
- \`/web/\` — browser runtime
- \`/builder/\` — visual builder
- \`/studio/\` — AI studio
- \`/demos/\` — bundles used by the live site
- \`/softn-files/\` — clearly separated, canonical \`.softn\` files for download
- \`/api/\` — the directory API (PHP + SQLite) and \`/data/\` — its state, never served

\`BUILD-INFO.json\` records the exact SoftN revision, whether the source tree had
uncommitted changes, and the Zipp revision/hash used by the browser runtime.

After upload, open each app and refresh a deep link. A request for a nonexistent
asset such as \`/web/assets/missing.js\` must return 404, not an HTML page. Some
demo networking or AI features may need their separately configured service or
provider, but the website and browser apps themselves are static.
`;

function run(args, env) {
  console.log(`\n> npm ${args.join(' ')}`);
  execFileSync('npm', args, {
    cwd: root,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, ...env },
  });
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else if (entry.isFile()) fs.copyFileSync(src, dest);
  }
}

function requireDir(dir, what) {
  if (!fs.existsSync(dir)) throw new Error(`${what} did not produce ${path.relative(root, dir)}`);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Put the public catalogue's exact bundle set in an unmistakable directory for
 * people who want the portable application files, rather than the website.
 * The catalogue is authoritative: stale sizes, unsafe names and unlisted files
 * fail the build instead of silently producing an ambiguous release.
 */
function copyCanonicalBundles(from) {
  const cataloguePath = path.join(from, 'index.json');
  const catalogue = JSON.parse(fs.readFileSync(cataloguePath, 'utf8'));
  if (!Array.isArray(catalogue) || catalogue.length === 0) {
    throw new Error('The demo catalogue must contain at least one .softn bundle');
  }

  const destination = path.join(outDir, 'softn-files');
  fs.mkdirSync(destination, { recursive: true });

  const names = new Set();
  for (const item of catalogue) {
    const name = item && item.file;
    if (
      typeof name !== 'string' ||
      path.basename(name) !== name ||
      !name.toLowerCase().endsWith('.softn') ||
      names.has(name.toLowerCase())
    ) {
      throw new Error(`Invalid or duplicate bundle name in demos/index.json: ${String(name)}`);
    }
    names.add(name.toLowerCase());

    const source = path.join(from, name);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
      throw new Error(`The canonical bundle is missing: ${path.relative(root, source)}`);
    }
    const actualSize = fs.statSync(source).size;
    if (item.size !== actualSize) {
      throw new Error(`${name} is ${actualSize} bytes but demos/index.json declares ${item.size}`);
    }
    fs.copyFileSync(source, path.join(destination, name));
  }

  const unlisted = fs
    .readdirSync(from, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.softn'))
    .map((entry) => entry.name)
    .filter((name) => !names.has(name.toLowerCase()));
  if (unlisted.length) {
    throw new Error(`Unlisted .softn bundles in the public demo directory: ${unlisted.join(', ')}`);
  }

  fs.copyFileSync(cataloguePath, path.join(destination, 'index.json'));
  const downloadLinks = catalogue
    .map((item) => {
      const file = escapeHtml(item.file);
      const label = escapeHtml(typeof item.name === 'string' ? item.name : item.file);
      const description = escapeHtml(typeof item.description === 'string' ? item.description : 'SoftN application bundle');
      const size = `${(item.size / (1024 * 1024)).toFixed(2)} MiB`;
      return `      <li><a href="./${file}" download>${label}</a><span>${description} · ${size}</span></li>`;
    })
    .join('\n');
  fs.writeFileSync(
    path.join(destination, 'index.html'),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SoftN application bundles</title>
    <style>
      :root { color-scheme: light dark; font: 16px/1.5 system-ui, sans-serif; }
      body { max-width: 52rem; margin: 0 auto; padding: 2rem 1rem 4rem; }
      h1 { line-height: 1.15; }
      ul { display: grid; gap: .75rem; padding: 0; list-style: none; }
      li { padding: 1rem; border: 1px solid #8886; border-radius: .75rem; }
      a { display: block; font-size: 1.1rem; font-weight: 700; }
      span { display: block; margin-top: .25rem; opacity: .78; }
    </style>
  </head>
  <body>
    <h1>SoftN application bundles</h1>
    <p>Download any complete, portable <code>.softn</code> application below.</p>
    <ul>
${downloadLinks}
    </ul>
    <p><a href="../">Back to softn.com</a></p>
  </body>
</html>
`,
  );
  fs.writeFileSync(
    path.join(destination, 'README.txt'),
    `SoftN application bundles\n` +
      `=========================\n\n` +
      `Each .softn file in this directory is one complete, portable SoftN app.\n` +
      `index.html is a download page and index.json is the canonical catalogue.\n` +
      `The website also serves these same\n` +
      `bundles from /demos/ for its live launcher and shared links.\n`
  );

  return catalogue.length;
}

function writeDeploymentFiles() {
  fs.writeFileSync(path.join(outDir, '.htaccess'), APACHE_CONFIG);
  fs.writeFileSync(path.join(outDir, 'nginx.conf.example'), NGINX_CONFIG);
  fs.writeFileSync(path.join(outDir, 'DEPLOY.md'), DEPLOY_GUIDE);
}

function writeBuildInfo() {
  const sourceDate = process.env.SOURCE_DATE_EPOCH;
  const builtAt = sourceDate
    ? new Date(Number.parseInt(sourceDate, 10) * 1000).toISOString()
    : new Date().toISOString();
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const dirty = Boolean(
    execFileSync('git', ['status', '--porcelain'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
  );
  const zipp = JSON.parse(
    fs.readFileSync(path.join(root, 'packages/@softn/core/wasm-zipp/SOURCE.json'), 'utf8'),
  );
  fs.writeFileSync(
    path.join(outDir, 'BUILD-INFO.json'),
    `${JSON.stringify(
      {
        formatVersion: 1,
        builtAt,
        softn: { revision, dirty },
        zipp,
      },
      null,
      2,
    )}\n`,
  );
}

// The apps import @softn/core and @softn/components from dist/, so those have
// to exist before any app build starts.
run(['run', 'build:core']);
run(['run', 'build:components']);

for (const app of APPS) {
  run(['run', 'build', '-w', app.workspace], { VITE_BASE: app.base });
}

// The site links to the apps by path, not by localhost port.
run(['run', 'build', '-w', '@softn/site'], {
  VITE_WEB_URL: '/web',
  VITE_BUILDER_URL: '/builder',
  VITE_STUDIO_URL: '/studio',
});

fs.rmSync(outDir, { recursive: true, force: true });

const siteDist = path.join(root, 'apps/softn-site/dist');
requireDir(siteDist, 'The site build');
copyDir(siteDist, outDir);

for (const app of APPS) {
  const appDist = path.join(root, app.dir, 'dist');
  requireDir(appDist, `The ${app.workspace} build`);
  copyDir(appDist, path.join(outDir, app.into));
}

// A second copy of the bundles at the root. The runtime serves its own set from
// /web/demos/ for its launcher, but every `?open=` link on the landing page is
// root-relative so that one path works from both places.
const demos = path.join(root, 'apps/softn-web/public/demos');
requireDir(demos, 'The runtime');
copyDir(demos, path.join(outDir, 'demos'));

// The directory API travels with the site: the PHP under apps/softn-api goes
// to dist/api, and dist/data — its state — starts out holding only the rules
// that keep it unserved. Nothing in api/ or data/ is precompressed: PHP is
// executed, not served, and the data is not ours to touch.
function copyDirectoryApi() {
  const apiSrc = path.join(root, 'apps/softn-api');
  requireDir(apiSrc, 'The directory API');
  const apiDest = path.join(outDir, 'api');
  fs.mkdirSync(apiDest, { recursive: true });
  for (const entry of fs.readdirSync(apiSrc, { withFileTypes: true })) {
    if (['test', 'node_modules', 'package.json', 'data'].includes(entry.name)) continue;
    const src = path.join(apiSrc, entry.name);
    const dest = path.join(apiDest, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else if (entry.isFile()) fs.copyFileSync(src, dest);
  }
  const dataDest = path.join(outDir, 'data');
  fs.mkdirSync(dataDest, { recursive: true });
  for (const name of ['.htaccess', 'README.txt']) {
    fs.copyFileSync(path.join(apiSrc, 'data', name), path.join(dataDest, name));
  }
}

// Apache-2.0 section 4(a) says a distributed copy must carry the licence, and
// dist/ IS the distributed copy — uploading it is the act of distributing.
// Third-party terms are generated separately from the exact dependency graph.
function copyProjectLicences() {
  for (const name of ['LICENSE', 'NOTICE']) {
    fs.copyFileSync(path.join(root, name), path.join(outDir, name));
  }
}

/**
 * Make a shared deep link survive a static host.
 *
 * `/web/app/Notes` is a route inside the runtime, not a file on disk. The
 * service worker binds a navigation route, so it works for anyone who has been
 * here before — and 404s for exactly the person a shared link is for. Both
 * conventions below are written because they are inert on hosts that do not use
 * them: Netlify and Cloudflare read `_redirects` and never reach the 404, GitHub
 * Pages ignores `_redirects` and serves `404.html`, and a plain file server
 * ignores both and still works from the second visit onwards.
 */
function writeDeepLinkFallbacks() {
  const apps = APPS.map((a) => a.into);

  fs.writeFileSync(
    path.join(outDir, '_redirects'),
    `${apps.map((a) => `/${a}/*  /${a}/index.html  200`).join('\n')}\n/api/*  /api/index.php  200\n/*  /index.html  200\n`,
  );

  // GitHub Pages hands this file the original URL, so it forwards the path to
  // the app that owns it; the app puts the address back before first paint.
  fs.writeFileSync(
    path.join(outDir, '404.html'),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>SoftN</title>
    <meta name="robots" content="noindex" />
    <script>
      (function () {
        var apps = ${JSON.stringify(apps)};
        // Already forwarded once and still nothing here: stop, or this loops.
        if (location.search.indexOf('softn-restore=') !== -1) {
          location.replace('/');
          return;
        }
        var path = location.pathname;
        var owner = apps.filter(function (a) {
          return path === '/' + a || path.indexOf('/' + a + '/') === 0;
        })[0];
        var target = owner ? '/' + owner + '/' : '/';
        // Nothing to restore for the app root itself.
        if (path === target) {
          location.replace(target);
          return;
        }
        location.replace(target + '?softn-restore=' + encodeURIComponent(path + location.search));
      })();
    </script>
  </head>
  <body></body>
</html>
`,
  );

  return apps.length;
}

/**
 * Write .br and .gz twins beside everything worth compressing.
 *
 * Done at build time because the quality that makes this worthwhile cannot be
 * afforded per request: the zipp engine is 5.74MB raw, 1.88MB gzipped, 1.51MB
 * under the brotli quality a live pass can spare, and 1.28MB at quality 11.
 * Paying that once here is the difference between the last two figures.
 *
 * Skipped: anything already compressed, which for a .softn is the whole point —
 * they are ZIP archives, and a second pass costs CPU to produce a slightly
 * larger file. Small files are skipped because the win is smaller than a TCP
 * segment, and any twin that fails to beat 95% of the original is discarded
 * rather than shipped as dead weight the server has to stat.
 */
const COMPRESSIBLE = new Set([
  '.html', '.js', '.mjs', '.css', '.json', '.webmanifest',
  '.wasm', '.svg', '.map', '.txt', '.md', '.xml', '.ui', '.logic',
]);
const MIN_COMPRESS_BYTES = 1024;

function precompressTree(dir, stats) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // PHP is executed, not served, and the data directory is the API's own.
      if (dir === outDir && (entry.name === 'api' || entry.name === 'data')) continue;
      precompressTree(full, stats);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!COMPRESSIBLE.has(path.extname(entry.name).toLowerCase())) continue;

    const source = fs.readFileSync(full);
    if (source.length < MIN_COMPRESS_BYTES) continue;

    const brotli = zlib.brotliCompressSync(source, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: source.length,
      },
    });
    const gzip = zlib.gzipSync(source, { level: 9 });

    stats.scanned += 1;
    stats.raw += source.length;
    if (brotli.length < source.length * 0.95) {
      fs.writeFileSync(full + '.br', brotli);
      stats.brotli += brotli.length;
      stats.written += 1;
    } else {
      stats.brotli += source.length;
    }
    if (gzip.length < source.length * 0.95) {
      fs.writeFileSync(full + '.gz', gzip);
      stats.gzip += gzip.length;
      stats.written += 1;
    } else {
      stats.gzip += source.length;
    }
  }
  return stats;
}

function precompressAssets() {
  const stats = precompressTree(outDir, {
    scanned: 0,
    written: 0,
    raw: 0,
    gzip: 0,
    brotli: 0,
  });
  const mb = (n) => (n / 1024 / 1024).toFixed(2) + 'MB';
  console.log(
    `\nPrecompressed ${stats.scanned} files (${stats.written} twins written)\n` +
      `  raw ${mb(stats.raw)}  ->  gzip ${mb(stats.gzip)}  ->  brotli ${mb(stats.brotli)}`
  );
  return stats;
}

function countFiles(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(path.join(dir, entry.name));
    else if (entry.isFile()) n += 1;
  }
  return n;
}

copyProjectLicences();
copyDirectoryApi();
const bundleCount = copyCanonicalBundles(demos);
writeDeepLinkFallbacks();
writeDeploymentFiles();
run(['run', 'licenses:site']);
writeBuildInfo();
precompressAssets();

console.log(`\nBuilt ${countFiles(outDir)} files into dist/`);
console.log('  dist/           landing page');
console.log('  dist/demos/     .softn bundles');
console.log(`  dist/softn-files/ canonical .softn bundles (${bundleCount} apps)`);
console.log('  dist/api/       the directory API (PHP + SQLite); dist/data/ its state');
console.log('  dist/.htaccess, nginx.conf.example, DEPLOY.md');
console.log('  dist/BUILD-INFO.json');
console.log('  *.br / *.gz     precompressed twins for brotli_static / gzip_static');
console.log('  dist/LICENSE, NOTICE, THIRD-PARTY-NOTICES.txt, THIRD-PARTY-INVENTORY.json');
for (const app of APPS) console.log(`  dist/${app.into}/`.padEnd(18) + app.workspace);
