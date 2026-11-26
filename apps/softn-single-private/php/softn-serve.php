<?php
declare(strict_types=1);
/**
 * softn-serve — a PHP host for one .softn application that never puts the
 * archive on a URL.
 *
 * index.php includes this file after setting $private. Four requests exist:
 *
 *   index.php             the page: the shell template with the title, theme,
 *                         icon and boot configuration rendered on the server,
 *                         plus the viewer cookie
 *   index.php?manifest    the web app manifest for installation, built from
 *                         the deployment settings; no cookie needed
 *   index.php?source      the source pack: the deployment settings, the
 *                         manifest with only the fields the runtime reads,
 *                         every text entry, and the names of the rest
 *   index.php?entry=PATH  one binary entry, with its MIME type, an ETag and
 *                         byte ranges for media
 *   index.php?icon        the manifest icon, for the page's favicon
 *
 * The archive is opened for each request and only the entry asked for is
 * inflated. The pack and the entries need the cookie the page sets, refuse
 * browser navigations and fetches from other sites and sibling subdomains,
 * and skip anything the
 * operator lists under `withhold` and the bundle's `server/`. Everything else
 * in the bundle reaches the browser when asked for: this side does not know
 * which entries the app uses. A browser must receive the UI and logic text to
 * execute it, so this is delivery control, not copy protection (see
 * DEPLOYMENT.md).
 */
if (!isset($private) || !is_string($private)) {
    http_response_code(404);
    exit;
}
// Shared hosts disable either of these, and a disabled function is a fatal
// error in PHP 8: called unguarded, they made every request a blank 500 on
// such a host. Each is called only when present, as the backend's http.php
// calls them.
if (function_exists('ini_set')) {
    ini_set('display_errors', '0');
    ini_set('zlib.output_compression', '0');
    ini_set('memory_limit', '256M');
}
if (function_exists('set_time_limit')) set_time_limit(60);
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: strict-origin-when-cross-origin');
// The same cross-origin isolation softn.com sends; credentialless keeps
// cross-origin images and model files working. Set here for a host that reads
// no .htaccess (nginx, the PHP development server); the shipped .htaccess takes
// these off and sets its own, because a browser ignores a policy sent twice.
header('Cross-Origin-Opener-Policy: same-origin');
header('Cross-Origin-Embedder-Policy: credentialless');

const SOFTN_COOKIE = 'softn_viewer';
/** Mirrors the per-entry bound of the core archive reader. */
const SOFTN_MAX_ENTRY = 50 * 1024 * 1024;
/** Mirrors the client's bound on the decoded pack. */
const SOFTN_MAX_PACK = 32 * 1024 * 1024;
const SOFTN_MAX_ICON = 256 * 1024;
const SOFTN_MAX_FILES = 10000;
const SOFTN_MAX_MANIFEST = 1024 * 1024;
/** Entries at or under this are read whole, which makes libzip verify their CRC. */
const SOFTN_WHOLE_READ = 8 * 1024 * 1024;
const SOFTN_ICON_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'svg'];

/**
 * Extension => [MIME type, kind]. A copy of ASSET_CLASSIFICATIONS in
 * packages/@softn/core/src/bundle/asset-classification.ts; the test suite
 * holds the two equal. Kind `text` travels in the source pack; everything
 * else is served as an entry.
 */
const SOFTN_ENTRY_TYPES = [
    'glb' => ['model/gltf-binary', 'model'],
    'gltf' => ['model/gltf+json', 'model'],
    'obj' => ['model/obj', 'model'],
    'fbx' => ['application/octet-stream', 'model'],
    'stl' => ['model/stl', 'model'],
    'bin' => ['application/octet-stream', 'model'],
    'mp3' => ['audio/mpeg', 'audio'],
    'wav' => ['audio/wav', 'audio'],
    'ogg' => ['audio/ogg', 'audio'],
    'opus' => ['audio/ogg', 'audio'],
    'aac' => ['audio/aac', 'audio'],
    'flac' => ['audio/flac', 'audio'],
    'm4a' => ['audio/mp4', 'audio'],
    'mp4' => ['video/mp4', 'video'],
    'webm' => ['video/webm', 'video'],
    'png' => ['image/png', 'image'],
    'jpg' => ['image/jpeg', 'image'],
    'jpeg' => ['image/jpeg', 'image'],
    'gif' => ['image/gif', 'image'],
    'webp' => ['image/webp', 'image'],
    'ico' => ['image/x-icon', 'image'],
    'bmp' => ['image/bmp', 'image'],
    'avif' => ['image/avif', 'image'],
    'tiff' => ['image/tiff', 'image'],
    'tif' => ['image/tiff', 'image'],
    'hdr' => ['image/vnd.radiance', 'image'],
    'exr' => ['image/x-exr', 'image'],
    'svg' => ['image/svg+xml', 'image'],
    'woff' => ['font/woff', 'font'],
    'woff2' => ['font/woff2', 'font'],
    'ttf' => ['font/ttf', 'font'],
    'otf' => ['font/otf', 'font'],
    'eot' => ['application/vnd.ms-fontobject', 'font'],
    'css' => ['text/css', 'text'],
    'json' => ['application/json', 'text'],
    'md' => ['text/markdown', 'text'],
    'ui' => ['text/plain', 'text'],
    'logic' => ['text/plain', 'text'],
    'py' => ['text/x-python', 'text'],
    'softn' => ['text/plain', 'text'],
    'sql' => ['application/sql', 'text'],
    'wgsl' => ['text/plain', 'text'],
    'xdb' => ['application/json', 'text'],
    'html' => ['text/html', 'text'],
    'htm' => ['text/html', 'text'],
    'js' => ['application/javascript', 'text'],
    'txt' => ['text/plain', 'text'],
    'xml' => ['application/xml', 'text'],
    'pdf' => ['application/pdf', 'binary'],
    'wasm' => ['application/wasm', 'program'],
];

function softn_fail(int $status, string $message): never
{
    header('Content-Type: text/plain; charset=utf-8');
    header('Cache-Control: no-store');
    http_response_code($status);
    echo $message;
    exit;
}

/**
 * Text as valid UTF-8, with U+FFFD where it was not. JSON is part of every
 * PHP 8; nothing here needs an extension a server may be without.
 */
function softn_utf8(string $text): string
{
    $clean = json_decode((string)json_encode($text, JSON_INVALID_UTF8_SUBSTITUTE | JSON_UNESCAPED_UNICODE));
    return is_string($clean) ? $clean : '';
}

/**
 * How many characters (code points) a text has, and its first `$max` of
 * them. This is all the page needs of mbstring, which a stock Debian or
 * Ubuntu PHP does not have: the host answered 503 "Enable the PHP mbstring
 * extension" there until a package was added, for a short name and a
 * description. In valid UTF-8 a character starts at every byte that is not a
 * continuation byte (10xxxxxx), so counting those is counting characters.
 */
function softn_text_length(string $text): int
{
    $text = softn_utf8($text);
    $count = 0;
    for ($i = 0, $bytes = strlen($text); $i < $bytes; $i++) {
        if ((ord($text[$i]) & 0xC0) !== 0x80) $count++;
    }
    return $count;
}

function softn_text_cut(string $text, int $max): string
{
    $text = softn_utf8($text);
    $count = 0;
    for ($i = 0, $bytes = strlen($text); $i < $bytes; $i++) {
        if ((ord($text[$i]) & 0xC0) !== 0x80 && ++$count > $max) return substr($text, 0, $i);
    }
    return $text;
}

/** @return array{0: string, 1: string} MIME type and kind */
function softn_classify(string $name): array
{
    $dot = strrpos($name, '.');
    $ext = $dot === false ? '' : strtolower(substr($name, $dot + 1));
    return SOFTN_ENTRY_TYPES[$ext] ?? ['application/octet-stream', 'binary'];
}

/** The same names the core archive index keeps: nothing that could only be an escape. */
function softn_entry_ok(string $name): bool
{
    if ($name === '' || strlen($name) > 1024 || str_contains($name, "\0") || str_contains($name, '\\')) return false;
    if (preg_match('/^[A-Za-z]:/', $name)) return false;
    foreach (explode('/', $name) as $part) {
        if ($part === '' || $part === '.' || $part === '..') return false;
    }
    return true;
}

/**
 * `withhold` matches an exact path, a directory (`notes/`) or a glob (`*.md`),
 * in any case: an entry's kind is read from its extension in any case
 * (softn_classify), so `*.md` withheld `notes.md` and sent `NOTES.MD` in the
 * pack. `server/` is withheld whatever the configuration says: it is where a
 * private server bundle keeps its routes, migrations and settings, and no
 * client ever runs them. An operator who deploys that bundle here in place
 * of its public client serves the app without them, not its server source.
 */
function softn_normalize_withhold(string $pattern): string
{
    $p = str_replace('\\', '/', trim($pattern));
    $trailing = str_ends_with($p, '/');
    while (str_starts_with($p, './') || str_starts_with($p, '/')) {
        $p = str_starts_with($p, './') ? substr($p, 2) : substr($p, 1);
    }
    $p = strtolower(rtrim($p, '/'));
    if ($p === '') return '';
    return $trailing ? ($p . '/') : $p;
}

function softn_withheld(string $name, array $withhold): bool
{
    $name = strtolower($name);
    if (str_starts_with($name, 'server/')) return true;
    foreach ($withhold as $pattern) {
        $pattern = softn_normalize_withhold((string)$pattern);
        if ($pattern === '') continue;
        if (str_ends_with($pattern, '/')) {
            if (str_starts_with($name, $pattern)) return true;
        } elseif ($pattern === $name || fnmatch($pattern, $name)) {
            return true;
        }
    }
    return false;
}

/**
 * Bundle-aware withholding policy for v1 and v2 containers.
 *
 * - v1 bundles and static v2 containers (no declared `backend`): always withhold `server/`.
 * - v2 containers configured with a remote `backendUrl` (multi-user host): withhold `server/`,
 *   `backend/`, the declared backend entry folder, and backend source/database files
 *   (.php, .phtml, .rs, .sql, .db, .sqlite, .sqlite3, .htaccess) so backend code never leaks.
 * - v2 containers running locally in the browser (`backendUrl === null`) with a declared `backend`:
 *   allow the bundle's backend files (e.g. `backend/` or `server/` for Slim 4 apps) to reach the
 *   browser's local ZIPP WASM sandbox unless explicitly listed in the operator's `withhold`.
 */
function softn_is_container_manifest(array $manifest): bool
{
    $engine = $manifest['engine'] ?? null;
    if ((is_int($engine) || is_float($engine)) && (float)$engine === 2.0) return true;
    return ($manifest['container'] ?? null) === true;
}

function softn_norm_rel_path(string $path): string
{
    $norm = str_replace('\\', '/', $path);
    $norm = (string)preg_replace('#^(?:\./)+#', '', ltrim($norm, '/'));
    return strtolower(trim($norm, '/'));
}

function softn_withheld_for_bundle(string $name, array $withhold, array $manifest, ?string $backendUrl): bool
{
    $lower = strtolower($name);
    if (
        str_starts_with($lower, 'private/') ||
        str_starts_with($lower, '__softn_generated__/private/') ||
        preg_match('#(?:^|/)\.git(?:/|$)#', $lower) === 1
    ) {
        return true;
    }
    $isContainer = softn_is_container_manifest($manifest);
    $hasDeclaredBackend = $isContainer && is_array($manifest['backend'] ?? null);
    if ($backendUrl !== null && $isContainer) {
        if (preg_match('#^(?:__softn_generated__/)?(?:server|backend|db|database|migrations)/#', $lower) === 1) {
            return true;
        }
        $backendRoot = is_string($manifest['backend']['root'] ?? null)
            ? softn_norm_rel_path($manifest['backend']['root'])
            : '';
        if ($backendRoot !== '' && ($lower === $backendRoot || str_starts_with($lower, $backendRoot . '/'))) {
            return true;
        }
        $entry = is_string($manifest['backend']['entry'] ?? null)
            ? softn_norm_rel_path($manifest['backend']['entry'])
            : '';
        if ($entry !== '') {
            if ($lower === $entry) return true;
            $slash = strpos($entry, '/');
            if ($slash !== false) {
                $entryDir = substr($entry, 0, $slash);
                $feRoots = ['assets', 'css', 'js', 'public', 'static', 'dist', 'frontend', 'src'];
                if ($entryDir !== '' && !in_array($entryDir, $feRoots, true) && str_starts_with($lower, $entryDir . '/')) {
                    return true;
                }
            }
        }
        $frontendRoot = is_string($manifest['frontendRoot'] ?? null)
            ? softn_norm_rel_path($manifest['frontendRoot'])
            : '';
        if ($frontendRoot !== '') {
            $allowedRoot = ['permission.json' => true];
            foreach (['icon', 'thumbnail'] as $metaKey) {
                if (is_string($manifest[$metaKey] ?? null)) {
                    $metaNorm = softn_norm_rel_path($manifest[$metaKey]);
                    if ($metaNorm !== '') $allowedRoot[$metaNorm] = true;
                }
            }
            if (!str_starts_with($lower, $frontendRoot . '/') && !isset($allowedRoot[$lower])) {
                return true;
            }
        }
        $ssrEntry = is_string($manifest['ssrEntry'] ?? null)
            ? softn_norm_rel_path($manifest['ssrEntry'])
            : '';
        if ($ssrEntry !== '' && $lower === $ssrEntry) return true;
        if (is_array($manifest['databases'] ?? null)) {
            foreach ($manifest['databases'] as $dbCfg) {
                if (!is_array($dbCfg)) continue;
                if (is_string($dbCfg['file'] ?? null)) {
                    $dbFile = softn_norm_rel_path($dbCfg['file']);
                    if ($dbFile !== '' && (
                        $lower === $dbFile ||
                        $lower === $dbFile . '-wal' ||
                        $lower === $dbFile . '-shm' ||
                        $lower === $dbFile . '-journal'
                    )) {
                        return true;
                    }
                }
                foreach (['seedSql', 'seedJson'] as $seedKey) {
                    if (!is_string($dbCfg[$seedKey] ?? null)) continue;
                    $seedPath = softn_norm_rel_path($dbCfg[$seedKey]);
                    if ($seedPath !== '' && $lower === $seedPath) {
                        return true;
                    }
                }
            }
        }
        $base = basename($lower);
        if (
            $base === '.htaccess' ||
            $base === '.htpasswd' ||
            $base === '.env' ||
            str_starts_with($base, '.env.') ||
            $base === 'cargo.toml' ||
            $base === 'cargo.lock' ||
            $base === 'composer.json' ||
            $base === 'composer.lock' ||
            $base === 'seed.json' ||
            preg_match('/\.(?:php|phtml|php5|php7|php8|pht|phps|phar|inc|tpl|rs|py|logic|sql|db|sqlite|sqlite3|ini|bak|sh|pem|key|secret|toml|yaml|yml)$/', $base) === 1 ||
            preg_match('/\.(?:db|sqlite|sqlite3)-(?:wal|shm|journal)$/', $base) === 1
        ) {
            return true;
        }
    } elseif (!$hasDeclaredBackend) {
        if (str_starts_with($lower, 'server/')) return true;
    }
    foreach ($withhold as $pattern) {
        $pattern = softn_normalize_withhold((string)$pattern);
        if ($pattern === '') continue;
        if (str_ends_with($pattern, '/')) {
            if (str_starts_with($lower, $pattern)) return true;
        } elseif ($pattern === $lower || fnmatch($pattern, $lower)) {
            return true;
        }
    }
    return false;
}

function softn_is_container_text(string $name, bool $isContainer): bool
{
    if (softn_classify($name)[1] === 'text') return true;
    if (!$isContainer) return false;
    $base = strtolower(basename($name));
    if ($base === '.htaccess') return true;
    $ext = strtolower((string)pathinfo($name, PATHINFO_EXTENSION));
    return in_array($ext, ['htm', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'vue', 'php', 'phtml', 'rs', 'toml'], true);
}

function softn_config(string $private): array
{
    $file = $private . '/serve.config.php';
    if (!is_file($file)) softn_fail(503, 'Missing private/serve.config.php.');
    $raw = require $file;
    if (!is_array($raw)) softn_fail(503, 'serve.config.php must return an array.');
    $known = ['id', 'title', 'description', 'lang', 'bundle', 'theme', 'loadingText', 'permissionMode', 'permissions', 'sha256',
        'viewerToken', 'tokenLifetime', 'secret', 'withhold', 'cacheSeconds', 'allowPrivateInWebroot', 'pwa', 'frameAncestors', 'backendUrl', 'prerender'];
    foreach (array_keys($raw) as $key) {
        if (!in_array($key, $known, true)) softn_fail(503, 'Unknown setting in serve.config.php: ' . $key);
    }
    $id = $raw['id'] ?? null;
    if (!is_string($id) || !preg_match('/^[a-z0-9][a-z0-9_-]{0,63}$/', $id)) softn_fail(503, 'serve.config.php needs an id of lowercase letters, digits, - and _.');
    $title = $raw['title'] ?? null;
    if (!is_string($title) || trim($title) === '' || strlen($title) > 120) softn_fail(503, 'serve.config.php needs a title of up to 120 characters.');
    $description = $raw['description'] ?? null;
    if ($description !== null && (!is_string($description) || strlen($description) > 300)) softn_fail(503, 'description must be a string of up to 300 characters.');
    $lang = $raw['lang'] ?? 'en';
    if (!is_string($lang) || !preg_match('/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/', $lang)) softn_fail(503, 'lang must be a BCP 47 language tag.');
    $bundle = $raw['bundle'] ?? ($private . '/app.softn');
    if (!is_string($bundle) || !is_file($bundle)) softn_fail(503, 'The application bundle is missing. Put it at private/app.softn or set bundle.');
    $theme = $raw['theme'] ?? 'dark';
    if ($theme !== 'light' && $theme !== 'dark') softn_fail(503, 'theme must be light or dark.');
    $loadingText = $raw['loadingText'] ?? 'Loading…';
    if (!is_string($loadingText) || strlen($loadingText) > 160) softn_fail(503, 'loadingText must be a string of up to 160 characters.');
    $permissionMode = $raw['permissionMode'] ?? 'prompt';
    if ($permissionMode !== 'prompt' && $permissionMode !== 'preapproved') softn_fail(503, 'permissionMode must be prompt or preapproved.');
    $permissions = $raw['permissions'] ?? null;
    if ($permissions !== null && (!is_string($permissions) || !is_file($permissions))) softn_fail(503, 'permissions must name an existing JSON file.');
    $sha256 = $raw['sha256'] ?? null;
    if ($sha256 !== null && (!is_string($sha256) || !preg_match('/^[a-f0-9]{64}$/', $sha256))) softn_fail(503, 'sha256 must be a lowercase hex SHA-256.');
    if ($permissionMode === 'preapproved' && $sha256 === null) softn_fail(503, 'Preapproved deployments require a pinned bundle sha256.');
    $viewerToken = $raw['viewerToken'] ?? true;
    if (!is_bool($viewerToken)) softn_fail(503, 'viewerToken must be true or false.');
    $tokenLifetime = $raw['tokenLifetime'] ?? 43200;
    if (!is_int($tokenLifetime) || $tokenLifetime < 60 || $tokenLifetime > 2592000) softn_fail(503, 'tokenLifetime must be between 60 and 2592000 seconds.');
    $secret = $raw['secret'] ?? '';
    if (!is_string($secret) || ($secret !== '' && strlen($secret) < 32)) softn_fail(503, 'secret must be blank or at least 32 characters.');
    $withhold = $raw['withhold'] ?? [];
    if (!is_array($withhold)) softn_fail(503, 'withhold must be a list of paths.');
    $normalizedWithhold = [];
    foreach ($withhold as $pattern) {
        if (!is_string($pattern)) softn_fail(503, 'withhold must list non-empty paths other than manifest.json.');
        $norm = softn_normalize_withhold($pattern);
        if ($norm === '' || $norm === 'manifest.json') softn_fail(503, 'withhold must list non-empty paths other than manifest.json.');
        $normalizedWithhold[] = $norm;
    }
    $cacheSeconds = $raw['cacheSeconds'] ?? 3600;
    if (!is_int($cacheSeconds) || $cacheSeconds < 0 || $cacheSeconds > 31536000) softn_fail(503, 'cacheSeconds must be between 0 and 31536000.');
    $allowPrivateInWebroot = $raw['allowPrivateInWebroot'] ?? false;
    if (!is_bool($allowPrivateInWebroot)) softn_fail(503, 'allowPrivateInWebroot must be true or false.');
    $pwa = softn_pwa_config($raw['pwa'] ?? true, $title);
    // Which other sites may show the page in a frame. None but its own by default: a page
    // that another site can frame can have its permission bar covered with a
    // look-alike and its Allow clicked for the visitor (clickjacking).
    $frameAncestors = $raw['frameAncestors'] ?? [];
    if (!is_array($frameAncestors)) softn_fail(503, 'frameAncestors must be a list of origins, such as https://example.com.');
    foreach ($frameAncestors as $origin) {
        if (!is_string($origin) || !preg_match('#^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$#', $origin)) {
            softn_fail(503, 'frameAncestors must list origins such as https://example.com (scheme, host and optional port, nothing else).');
        }
    }
    $backendUrl = $raw['backendUrl'] ?? null;
    if ($backendUrl !== null) {
        if (!is_string($backendUrl) || trim($backendUrl) === '' || strlen($backendUrl) > 512
            || preg_match('/[\s"<>#]/', $backendUrl)
            || str_contains($backendUrl, '://')
            || str_starts_with($backendUrl, '//')
            || str_contains($backendUrl, '..')) {
            softn_fail(503, 'backendUrl must be a same-origin path (such as / or ./backend).');
        }
    }
    $prerender = $raw['prerender'] ?? false;
    if (!is_bool($prerender)) softn_fail(503, 'prerender must be true or false.');
    return [
        'id' => $id, 'title' => $title, 'description' => $description, 'lang' => $lang, 'bundle' => $bundle, 'theme' => $theme,
        'loadingText' => $loadingText, 'permissionMode' => $permissionMode, 'permissions' => $permissions, 'sha256' => $sha256,
        'viewerToken' => $viewerToken, 'tokenLifetime' => $tokenLifetime, 'secret' => $secret, 'withhold' => $normalizedWithhold,
        'cacheSeconds' => $cacheSeconds, 'allowPrivateInWebroot' => $allowPrivateInWebroot, 'pwa' => $pwa,
        'frameAncestors' => array_values($frameAncestors), 'backendUrl' => $backendUrl, 'prerender' => $prerender,
    ];
}

/**
 * The installable-app and link-preview settings: `'pwa' => true` (the default) takes every
 * default below, an array overrides some of them, `false` turns the whole layer off. Paths are
 * relative to the page's directory unless they are absolute http(s) URLs. Null means off.
 * A colour the operator did not choose is null here: it is the ground of the side the app
 * is drawn in (softn_side), which only the bundle can say.
 */
function softn_pwa_config(mixed $raw, string $title): ?array
{
    if ($raw === false) return null;
    if ($raw === true || $raw === null) $raw = [];
    if (!is_array($raw)) softn_fail(503, 'pwa must be true, false or an array of settings.');
    $known = ['shortName', 'themeColor', 'backgroundColor', 'display', 'orientation', 'icons', 'appleTouchIcon', 'shareImage',
        'shareImageWidth', 'shareImageHeight', 'siteUrl', 'serviceWorker'];
    foreach (array_keys($raw) as $key) {
        if (!in_array($key, $known, true)) softn_fail(503, 'Unknown pwa setting in serve.config.php: ' . $key);
    }
    $shortName = $raw['shortName'] ?? softn_text_cut($title, 30);
    if (!is_string($shortName) || trim($shortName) === '' || softn_text_length($shortName) > 30) softn_fail(503, 'pwa.shortName must be 1 to 30 characters.');
    $colour = static function (mixed $value, string $name): ?string {
        if ($value === null) return null;
        if (!is_string($value) || !preg_match('/^#[0-9a-fA-F]{6}$/', $value)) softn_fail(503, $name . ' must be a #rrggbb colour.');
        return strtolower($value);
    };
    $themeColor = $colour($raw['themeColor'] ?? null, 'pwa.themeColor');
    $backgroundColor = $colour($raw['backgroundColor'] ?? null, 'pwa.backgroundColor');
    $display = $raw['display'] ?? 'standalone';
    if (!in_array($display, ['standalone', 'minimal-ui', 'fullscreen', 'browser'], true)) softn_fail(503, 'pwa.display must be standalone, minimal-ui, fullscreen or browser.');
    $orientation = $raw['orientation'] ?? 'any';
    if (!in_array($orientation, ['any', 'natural', 'landscape', 'portrait'], true)) softn_fail(503, 'pwa.orientation must be any, natural, landscape or portrait.');
    $path = static function (mixed $value, string $name): string {
        if (!is_string($value) || $value === '' || strlen($value) > 200 || preg_match('/[\s"<>]/', $value)) softn_fail(503, $name . ' must be a relative path or an http(s) URL of up to 200 characters.');
        if (preg_match('#^https?://#i', $value)) return $value;
        if (str_contains($value, '..') || str_starts_with($value, '/') || str_contains($value, '://')) softn_fail(503, $name . ' must be relative to the page directory, without leading slash or "..".');
        return $value;
    };
    $icons = $raw['icons'] ?? [
        ['src' => 'pwa-icons/icon-192.png', 'sizes' => '192x192', 'type' => 'image/png', 'purpose' => 'any'],
        ['src' => 'pwa-icons/icon-512.png', 'sizes' => '512x512', 'type' => 'image/png', 'purpose' => 'any'],
        ['src' => 'pwa-icons/icon-maskable-512.png', 'sizes' => '512x512', 'type' => 'image/png', 'purpose' => 'maskable'],
    ];
    if (!is_array($icons) || $icons === [] || count($icons) > 12) softn_fail(503, 'pwa.icons must list 1 to 12 icons.');
    $checkedIcons = [];
    foreach ($icons as $icon) {
        if (!is_array($icon)) softn_fail(503, 'Each pwa icon must be an array with src, sizes and type.');
        $entry = ['src' => $path($icon['src'] ?? null, 'pwa.icons src')];
        $sizes = $icon['sizes'] ?? null;
        if (!is_string($sizes) || !preg_match('/^\d{2,4}x\d{2,4}$/', $sizes)) softn_fail(503, 'pwa.icons sizes must look like 512x512.');
        $entry['sizes'] = $sizes;
        $type = $icon['type'] ?? 'image/png';
        if (!is_string($type) || !preg_match('#^image/[a-z0-9.+-]+$#', $type)) softn_fail(503, 'pwa.icons type must be an image MIME type.');
        $entry['type'] = $type;
        if (array_key_exists('purpose', $icon)) {
            if (!in_array($icon['purpose'], ['any', 'maskable', 'monochrome'], true)) softn_fail(503, 'pwa.icons purpose must be any, maskable or monochrome.');
            $entry['purpose'] = $icon['purpose'];
        }
        $checkedIcons[] = $entry;
    }
    $appleTouchIcon = $raw['appleTouchIcon'] ?? 'apple-touch-icon.png';
    if ($appleTouchIcon !== false) $appleTouchIcon = $path($appleTouchIcon, 'pwa.appleTouchIcon');
    $shareImage = $raw['shareImage'] ?? 'share.png';
    if ($shareImage !== false) $shareImage = $path($shareImage, 'pwa.shareImage');
    $dimension = static function (mixed $value, int $default, string $name): int {
        if ($value === null) return $default;
        if (!is_int($value) || $value < 1 || $value > 8192) softn_fail(503, $name . ' must be between 1 and 8192.');
        return $value;
    };
    $shareImageWidth = $dimension($raw['shareImageWidth'] ?? null, 1200, 'pwa.shareImageWidth');
    $shareImageHeight = $dimension($raw['shareImageHeight'] ?? null, 630, 'pwa.shareImageHeight');
    $siteUrl = $raw['siteUrl'] ?? null;
    if ($siteUrl !== null) {
        if (!is_string($siteUrl) || strlen($siteUrl) > 200 || !preg_match('#^https?://[A-Za-z0-9.-]+(?::\d{1,5})?(?:/[^\s?\#"<>]*)?$#', $siteUrl)) softn_fail(503, 'pwa.siteUrl must be the absolute http(s) URL of the page directory, without query or fragment.');
        $siteUrl = rtrim($siteUrl, '/');
    }
    $serviceWorker = $raw['serviceWorker'] ?? true;
    if (!is_bool($serviceWorker)) softn_fail(503, 'pwa.serviceWorker must be true or false.');
    return [
        'shortName' => $shortName, 'themeColor' => $themeColor, 'backgroundColor' => $backgroundColor, 'display' => $display,
        'orientation' => $orientation, 'icons' => $checkedIcons, 'appleTouchIcon' => $appleTouchIcon, 'shareImage' => $shareImage,
        'shareImageWidth' => $shareImageWidth, 'shareImageHeight' => $shareImageHeight, 'siteUrl' => $siteUrl, 'serviceWorker' => $serviceWorker,
    ];
}

/**
 * The side the page is drawn in before the app is, and the browser's colours
 * around it: the side the bundle's project declares (`config.theme.mode`,
 * "light" or "dark"), which the runtime draws the app in whatever the
 * deployment's theme; the deployment's theme for "system", no mode or
 * anything else. The rule is packages/@softn/components/src/theme/app-theme.ts.
 * The page's `data-theme` stays the deployment's: the document around the
 * app keeps that side, and the permission bar is drawn by it.
 */
function softn_side(array $config, array $manifest): string
{
    $theme = $manifest['config']->theme ?? null;
    $mode = is_array($theme) ? ($theme['mode'] ?? null) : null;
    if ($mode === 'light' || $mode === 'dark') return $mode;
    $top = $manifest['theme'] ?? null;
    if ($top === 'light' || $top === 'dark') return $top;
    return $config['theme'];
}

/** The ground of a side: behind the boot screen, and the browser's colour where the operator chose none. */
function softn_ground(string $side): string
{
    return $side === 'dark' ? '#171821' : '#f5f5f8';
}

/** A pwa path resolved against the page directory: relative paths gain the directory, absolute URLs pass through. */
function softn_pwa_url(string $value, string $base): string
{
    return preg_match('#^https?://#i', $value) ? $value : $base . $value;
}

function softn_is_https_request(): bool
{
    if (!empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off') return true;
    if ((string)($_SERVER['SERVER_PORT'] ?? '') === '443') return true;
    // Only trust X-Forwarded-Proto from loopback reverse proxies on the same host.
    $remote = trim((string)($_SERVER['REMOTE_ADDR'] ?? ''));
    if ($remote !== '127.0.0.1' && $remote !== '::1') return false;
    $parts = array_values(array_filter(array_map('trim', explode(',', (string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? ''))), static fn(string $v): bool => $v !== ''));
    $xfp = $parts !== [] ? strtolower($parts[count($parts) - 1]) : '';
    return $xfp === 'https';
}

/**
 * The absolute URL of the page directory for link previews: the configured siteUrl, else
 * the request's own scheme and host when the host header is a plain host name.
 */
function softn_pwa_origin(array $pwa, string $base): ?string
{
    if ($pwa['siteUrl'] !== null) return $pwa['siteUrl'] . '/';
    $host = trim((string)($_SERVER['HTTP_HOST'] ?? ''));
    if ($host === '' || strlen($host) > 255 || str_contains($host, '..')) return null;
    if (!preg_match('/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)(?::([0-9]{1,5}))?$/', $host, $m)) {
        return null;
    }
    if (isset($m[1]) && $m[1] !== '' && ((int)$m[1] < 1 || (int)$m[1] > 65535)) return null;
    $secure = softn_is_https_request();
    return ($secure ? 'https' : 'http') . '://' . $host . $base;
}

/** The head tags that make the page installable and give links a card. */
function softn_pwa_tags(array $config, string $endpoint, ?string $description, string $side): string
{
    $pwa = $config['pwa'];
    if ($pwa === null) return '';
    $escape = static fn(string $value): string => htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML5, 'UTF-8');
    $base = softn_cookie_path();
    $dark = $side === 'dark';
    $lines = [
        '<link rel="manifest" href="' . $escape($endpoint . '?manifest') . '">',
        '<meta name="application-name" content="' . $escape($pwa['shortName']) . '">',
        '<meta name="mobile-web-app-capable" content="yes">',
        '<meta name="apple-mobile-web-app-capable" content="yes">',
        '<meta name="apple-mobile-web-app-title" content="' . $escape($pwa['shortName']) . '">',
        '<meta name="apple-mobile-web-app-status-bar-style" content="' . ($dark ? 'black-translucent' : 'default') . '">',
    ];
    if ($pwa['appleTouchIcon'] !== false) $lines[] = '<link rel="apple-touch-icon" href="' . $escape(softn_pwa_url($pwa['appleTouchIcon'], $base)) . '">';
    $origin = softn_pwa_origin($pwa, $base);
    $lines[] = '<meta property="og:type" content="website">';
    $lines[] = '<meta property="og:site_name" content="' . $escape($pwa['shortName']) . '">';
    $lines[] = '<meta property="og:title" content="' . $escape($config['title']) . '">';
    if ($description !== null) $lines[] = '<meta property="og:description" content="' . $escape($description) . '">';
    if ($origin !== null) {
        $lines[] = '<meta property="og:url" content="' . $escape($origin) . '">';
        $lines[] = '<link rel="canonical" href="' . $escape($origin) . '">';
    }
    $share = null;
    if ($pwa['shareImage'] !== false) {
        $share = preg_match('#^https?://#i', $pwa['shareImage']) ? $pwa['shareImage'] : ($origin === null ? null : $origin . $pwa['shareImage']);
    }
    if ($share !== null) {
        $lines[] = '<meta property="og:image" content="' . $escape($share) . '">';
        $lines[] = '<meta property="og:image:width" content="' . $pwa['shareImageWidth'] . '">';
        $lines[] = '<meta property="og:image:height" content="' . $pwa['shareImageHeight'] . '">';
        $lines[] = '<meta property="og:image:alt" content="' . $escape($config['title']) . '">';
        $lines[] = '<meta name="twitter:card" content="summary_large_image">';
        $lines[] = '<meta name="twitter:image" content="' . $escape($share) . '">';
    } else {
        $lines[] = '<meta name="twitter:card" content="summary">';
    }
    $lines[] = '<meta name="twitter:title" content="' . $escape($config['title']) . '">';
    if ($description !== null) $lines[] = '<meta name="twitter:description" content="' . $escape($description) . '">';
    if ($pwa['serviceWorker']) {
        $worker = json_encode($base . 'sw.js', JSON_HEX_TAG | JSON_HEX_AMP | JSON_UNESCAPED_SLASHES);
        $lines[] = '<script>if ("serviceWorker" in navigator) addEventListener("load", function () { navigator.serviceWorker.register(' . $worker . ').catch(function () {}); });</script>';
    }
    return implode("\n    ", $lines);
}

/** index.php?manifest: the web app manifest, built from the deployment's own settings. No cookie needed. */
function softn_webmanifest(array $config, string $private): never
{
    $pwa = $config['pwa'];
    if ($pwa === null) softn_fail(404, 'Not found.');
    $zip = softn_open($config);
    $manifest = softn_manifest($zip);
    $zip->close();
    $base = softn_cookie_path();
    $description = $config['description'] ?? (is_string($manifest['description'] ?? null) ? softn_text_cut($manifest['description'], 300) : null);
    $ground = softn_ground(softn_side($config, $manifest));
    $icons = [];
    foreach ($pwa['icons'] as $icon) {
        $icon['src'] = softn_pwa_url($icon['src'], $base);
        $icons[] = $icon;
    }
    $out = [
        'id' => $base, 'name' => $config['title'], 'short_name' => $pwa['shortName'], 'start_url' => $base, 'scope' => $base,
        'display' => $pwa['display'], 'orientation' => $pwa['orientation'], 'background_color' => $pwa['backgroundColor'] ?? $ground,
        'theme_color' => $pwa['themeColor'] ?? $ground, 'lang' => $config['lang'], 'icons' => $icons,
    ];
    if ($description !== null) $out['description'] = $description;
    $json = json_encode($out, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    if ($json === false) softn_fail(503, 'The web app manifest could not be encoded.');
    header('Content-Type: application/manifest+json; charset=utf-8');
    header('Cache-Control: max-age=3600');
    header('Content-Length: ' . strlen($json));
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'HEAD') echo $json;
    exit;
}

function softn_open(array $config, ?string $verifiedDigest = null): ZipArchive
{
    // The one extension this host cannot do without, and one a stock Debian
    // or Ubuntu PHP does not have: say which package, not only which extension.
    if (!class_exists('ZipArchive')) softn_fail(503, 'Enable the PHP zip extension for the web server\'s PHP (Debian/Ubuntu: install the php-zip package, then restart the web server or PHP-FPM).');
    if (is_string($config['sha256'] ?? null) && $config['sha256'] !== '') {
        static $verified = [];
        $cacheKey = $config['bundle'] . "\0" . $config['sha256'];
        if ($verifiedDigest !== null && hash_equals($config['sha256'], $verifiedDigest)) {
            $verified[$cacheKey] = true;
        }
        if (!isset($verified[$cacheKey])) {
            $actual = @hash_file('sha256', $config['bundle']);
            if ($actual === false) softn_fail(503, 'Application bundle is unavailable.');
            if (!hash_equals($config['sha256'], $actual)) softn_fail(503, 'Application integrity check failed.');
            $verified[$cacheKey] = true;
        }
    }
    $zip = new ZipArchive();
    if ($zip->open($config['bundle'], ZipArchive::RDONLY) !== true) softn_fail(503, 'Application bundle is unavailable.');
    if ($zip->numFiles > SOFTN_MAX_FILES) {
        $zip->close();
        softn_fail(503, 'Application bundle has too many entries.');
    }
    return $zip;
}

/**
 * Every file entry with an acceptable name, name => [size, crc]. The refusals
 * are the core index's: a duplicate name or an entry over the per-entry bound
 * makes the archive unusable rather than partly served.
 */
function softn_index(ZipArchive $zip): array
{
    if ($zip->numFiles > SOFTN_MAX_FILES) softn_fail(503, 'Application bundle has too many entries.');
    $index = [];
    for ($i = 0; $i < $zip->numFiles; $i++) {
        $stat = $zip->statIndex($i);
        if ($stat === false) continue;
        $name = (string)$stat['name'];
        if (str_ends_with($name, '/') || !softn_entry_ok($name)) continue;
        if (isset($index[$name])) softn_fail(503, 'Application bundle has duplicate entries.');
        if ((int)$stat['size'] > SOFTN_MAX_ENTRY) softn_fail(503, 'Application bundle has an entry over the size limit.');
        $index[$name] = ['size' => (int)$stat['size'], 'crc' => (int)$stat['crc']];
    }
    return $index;
}

/** The secret a file holds, when it holds a whole one: null for no file, an empty one, or one cut short. */
function softn_secret_read(string $file): ?string
{
    $existing = @file_get_contents($file);
    if (!is_string($existing)) return null;
    $existing = trim($existing);
    return strlen($existing) >= 32 ? $existing : null;
}

/**
 * Make `$candidate` the deployment's secret unless it has one already, and
 * answer the secret it has now: the candidate, or the one somebody else put
 * there first. Null when nothing can be written here.
 *
 * Every first visitor has to be given the same secret. The file used to be
 * written over whatever was there: of two requests that both found none, the
 * second replaced the first's, and the first visitor held a cookie signed
 * with a secret that no longer existed, so the application would not load
 * for them until they opened the page again. A third request could also read
 * the file between its being emptied and its being written, take it for no
 * secret, and write a third.
 *
 * So the secret is written whole under a name of its own, and given the
 * real name by link(), which makes a name only where there is none, in one
 * step: whoever is second fails, and reads the first's. A file that has the
 * name is never empty or half written. Where the filesystem has no links,
 * the name is taken by creating the file exclusively and written then, and
 * a reader that finds it not yet whole waits for it. A file still no secret
 * after that was damaged, and is replaced whole.
 */
function softn_secret_claim(string $file, string $candidate): ?string
{
    $draft = $file . '.' . bin2hex(random_bytes(6)) . '.tmp';
    $oldUmask = function_exists('umask') ? umask(0077) : null;
    try {
        if (@file_put_contents($draft, $candidate . "\n") === false) return null;
        @chmod($draft, 0600);
        if (@link($draft, $file)) return $candidate;
        $theirs = softn_secret_read($file);
        if ($theirs !== null) return $theirs;
        // No link was made and no secret is there: no links here, or a file that is not one yet.
        $own = @fopen($file, 'x');
        if ($own) {
            fwrite($own, $candidate . "\n");
            fclose($own);
            @chmod($file, 0600);
            return $candidate;
        }
        // Somebody has the name and has not finished writing: theirs, when it is whole.
        for ($tries = 0; $tries < 50 && function_exists('usleep'); $tries++) {
            usleep(10000);
            $theirs = softn_secret_read($file);
            if ($theirs !== null) return $theirs;
        }
        // Half a second on it is nobody's writing: an empty or cut file, put right in one step.
        return @rename($draft, $file) ? $candidate : softn_secret_read($file);
    } finally {
        @unlink($draft);
        if ($oldUmask !== null) umask($oldUmask);
    }
}

function softn_secret(array $config, string $private): string
{
    if ($config['secret'] !== '') return $config['secret'];
    $file = $private . '/secret.key';
    $secret = softn_secret_read($file) ?? softn_secret_claim($file, bin2hex(random_bytes(32)));
    if ($secret === null) {
        softn_fail(503, 'The private directory is not writable. Set secret in serve.config.php or make it writable by the PHP user.');
    }
    return $secret;
}

function softn_token_issue(string $secret, int $lifetime): string
{
    $body = '1.' . (time() + $lifetime) . '.' . bin2hex(random_bytes(8));
    return $body . '.' . substr(hash_hmac('sha256', $body, $secret), 0, 32);
}

function softn_token_valid(string $token, string $secret): bool
{
    $parts = explode('.', $token);
    // Digits by PCRE, which no PHP is without. ctype is an extension of its
    // own on some systems (Alpine's php-ctype), and without it ctype_digit()
    // was a fatal error on every request that carries the cookie.
    if (count($parts) !== 4 || $parts[0] !== '1' || !preg_match('/^[0-9]{1,18}$/D', $parts[1]) || !preg_match('/^[a-f0-9]{16}$/D', $parts[2])) return false;
    if ((int)$parts[1] <= time()) return false;
    $body = $parts[0] . '.' . $parts[1] . '.' . $parts[2];
    return hash_equals(substr(hash_hmac('sha256', $body, $secret), 0, 32), $parts[3]);
}

/** Percent-encode each path segment of a decoded path so spaces/UTF-8 work in URLs and cookies. */
function softn_encode_path(string $path): string
{
    $parts = explode('/', $path);
    foreach ($parts as &$seg) {
        if ($seg !== '') $seg = rawurlencode(rawurldecode($seg));
    }
    return implode('/', $parts);
}

/** The directory the page lives in, with a trailing slash: the cookie's scope. */
function softn_cookie_path(): string
{
    $script = str_replace('\\', '/', (string)($_SERVER['SCRIPT_NAME'] ?? '/'));
    $dir = dirname($script);
    return softn_encode_path(rtrim($dir === '\\' ? '/' : $dir, '/') . '/');
}

/** Path-absolute URL of index.php, what every fetch and asset URL is relative to. */
function softn_endpoint(): string
{
    $script = softn_encode_path(str_replace('\\', '/', (string)($_SERVER['SCRIPT_NAME'] ?? '')));
    if (preg_match('#^/[^?\#\s]*$#', $script) && !str_starts_with($script, '//')) return $script;
    return softn_cookie_path() . 'index.php';
}

/** What every request but the page itself must pass. */
function softn_guard(array $config, string $private): void
{
    if (($_SERVER['HTTP_SEC_FETCH_MODE'] ?? '') === 'navigate') softn_fail(403, 'This address is used by the application, not for browsing.');
    // Another site, and a sibling subdomain (`same-site`), which SameSite=Strict
    // sends the cookie to and which on a parent domain shared with others may
    // be someone else's. `none` (a request the browser itself starts) passes,
    // as it did.
    $site = $_SERVER['HTTP_SEC_FETCH_SITE'] ?? '';
    if ($site === 'cross-site' || $site === 'same-site') softn_fail(403, 'Requests from other sites are not allowed.');
    if (!$config['viewerToken']) return;
    $token = $_COOKIE[SOFTN_COOKIE] ?? null;
    if (!is_string($token) || !softn_token_valid($token, softn_secret($config, $private))) softn_fail(403, 'Open the application page first.');
}

/** The manifest with only the fields the runtime reads; never the raw file. */
function softn_manifest(ZipArchive $zip): array
{
    $manifestStat = $zip->statName('manifest.json');
    if ($manifestStat !== false && (int)$manifestStat['size'] > SOFTN_MAX_MANIFEST) {
        softn_fail(503, 'Application manifest exceeds the size limit.');
    }
    $raw = $manifestStat !== false ? $zip->getFromName('manifest.json', SOFTN_MAX_MANIFEST + 1) : false;
    if (is_string($raw) && strlen($raw) > SOFTN_MAX_MANIFEST) {
        softn_fail(503, 'Application manifest exceeds the size limit.');
    }
    if (!is_string($raw)) {
        // No manifest: a zipped folder of a web app, opened at its page. The page
        // every other reader of a bundle opens (@softn/bundle-format's
        // zeroConfigEntry): index.html, else app.html, else the first page at the
        // archive's root by name. This host knew the first two names only, and
        // answered 503 for a site whose page is home.html.
        $root = [];
        $folders = [];
        $atRoot = 0;
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $name = $zip->getNameIndex($i);
            if (!is_string($name) || $name === '' || str_ends_with($name, '/')) continue;
            $slash = strpos($name, '/');
            if ($slash === false) {
                $atRoot++;
                if (preg_match('/\.html?$/i', $name)) $root[] = $name;
            } else {
                $folders[substr($name, 0, $slash)] = true;
            }
        }
        $htmlEntry = null;
        if (in_array('index.html', $root, true)) {
            $htmlEntry = 'index.html';
        } elseif (in_array('app.html', $root, true)) {
            $htmlEntry = 'app.html';
        } elseif ($root !== []) {
            sort($root, SORT_STRING);
            $htmlEntry = $root[0];
        }
        if ($htmlEntry === null) {
            // Everything inside one folder: the folder was zipped, not its files.
            // The runtimes that read an archive in the browser look inside it;
            // this host serves each file by its name in the archive, so it says
            // what to do rather than only that something is wrong.
            if ($atRoot === 0 && count($folders) === 1) {
                softn_fail(503, 'The application\'s files are inside a folder ("' . softn_text_cut((string)array_key_first($folders), 64) . '") in the archive. Zip the files themselves, so that the page or manifest.json is at the top of the archive.');
            }
            softn_fail(503, 'Invalid application manifest.');
        }
        // The head of the page is enough for its title, on a request that runs for every visit.
        $htmlText = $zip->getFromName($htmlEntry, 262144);
        $title = 'Web App';
        if (is_string($htmlText) && preg_match('/<title[^>]*>([\s\S]*?)<\/title>/i', $htmlText, $m)) {
            $parsedTitle = trim((string)preg_replace('/\s+/', ' ', strip_tags($m[1])));
            if ($parsedTitle !== '') $title = softn_text_cut($parsedTitle, 64);
        }
        return [
            'engine' => 2,
            'name' => $title,
            'version' => '1.0.0',
            'main' => $htmlEntry,
            'files' => (object)[],
            'config' => (object)['execution' => 'worker'],
        ];
    }
    // A byte order mark, which some editors write, is not part of the JSON; the
    // runtimes that read the archive in the browser read past it.
    if (str_starts_with($raw, "\xEF\xBB\xBF")) $raw = substr($raw, 3);
    $manifest = json_decode($raw, true);
    // `"engine": 2` as JSON has it, with one kind of number: 2.0 and 2e0 are 2.
    // json_decode makes those floats, which `=== 2` took for a SoftN bundle, so
    // a manifest written by a tool that prints 2.0 ran on the other engine here.
    $engine = is_array($manifest) ? ($manifest['engine'] ?? null) : null;
    $engineIsContainer = (is_int($engine) || is_float($engine)) && (float)$engine === 2.0;
    $isV2 = is_array($manifest) && ($engineIsContainer || ($manifest['container'] ?? null) === true);
    $frontendRoot = ($isV2 && is_string($manifest['frontendRoot'] ?? null))
        ? trim(str_replace('\\', '/', $manifest['frontendRoot']), '/')
        : '';
    $main = is_string($manifest['main'] ?? null) ? $manifest['main'] : '';
    if ($main === '' && $isV2) {
        if ($frontendRoot !== '' && $zip->locateName($frontendRoot . '/index.html') !== false) $main = $frontendRoot . '/index.html';
        elseif ($zip->locateName('index.html') !== false) $main = 'index.html';
        elseif (is_array($manifest['backend'] ?? null) && is_string($manifest['backend']['entry'] ?? null)) $main = $manifest['backend']['entry'];
    }
    if (!is_array($manifest) || !is_string($manifest['name'] ?? null) || $main === '' || (!$isV2 && !is_array($manifest['files'] ?? null))) {
        softn_fail(503, 'Invalid application manifest.');
    }
    $files = [];
    if (is_array($manifest['files'] ?? null)) {
        foreach (['ui', 'logic', 'xdb', 'assets'] as $kind) {
            if (is_array($manifest['files'][$kind] ?? null)) $files[$kind] = array_values(array_filter($manifest['files'][$kind], 'is_string'));
        }
    }
    $out = [
        'name' => $manifest['name'],
        'version' => is_string($manifest['version'] ?? null) ? $manifest['version'] : '0.0.0',
        'main' => $main,
        'files' => (object)$files,
    ];
    if ($engineIsContainer) $out['engine'] = 2;
    if (($manifest['container'] ?? null) === true) $out['container'] = true;
    if ($isV2) {
        // What the container reads of a manifest beyond the fields here
        // (packages/@softn/container/src/archive.ts): its import map, theme,
        // static frontend root, SSR entry, embedded backend, and SQLite databases.
        if (is_array($manifest['imports'] ?? null)) {
            $imports = array_filter($manifest['imports'], 'is_string');
            if ($imports !== []) $out['imports'] = (object)$imports;
        }
        if (is_array($manifest['importMap'] ?? null)) {
            $out['importMap'] = $manifest['importMap'];
        }
        if ($frontendRoot !== '' && softn_entry_ok($frontendRoot)) {
            $out['frontendRoot'] = $frontendRoot;
        }
        if (is_string($manifest['ssrEntry'] ?? null) && softn_entry_ok($manifest['ssrEntry'])) {
            $out['ssrEntry'] = $manifest['ssrEntry'];
        }
        if (is_array($manifest['backend'] ?? null)) {
            $out['backend'] = $manifest['backend'];
        }
        if (is_array($manifest['databases'] ?? null)) {
            $out['databases'] = $manifest['databases'];
        }
        if (in_array($manifest['theme'] ?? null, ['light', 'dark'], true)) $out['theme'] = $manifest['theme'];
    }
    if (is_string($manifest['description'] ?? null)) $out['description'] = $manifest['description'];
    if (is_string($manifest['icon'] ?? null)) $out['icon'] = $manifest['icon'];
    if (is_string($manifest['thumbnail'] ?? null)) $out['thumbnail'] = $manifest['thumbnail'];
    if (is_string($manifest['prerender'] ?? null) && softn_entry_ok($manifest['prerender'])) {
        $out['prerender'] = $manifest['prerender'];
    }
    if (is_array($manifest['seo'] ?? null) && is_string($manifest['seo']['prerender'] ?? null) && softn_entry_ok($manifest['seo']['prerender'])) {
        $out['seo'] = ['prerender' => $manifest['seo']['prerender']];
    }
    $config = [];
    if (is_array($manifest['config'] ?? null)) {
        if (is_string($manifest['config']['execution'] ?? null)) $config['execution'] = $manifest['config']['execution'];
        if (is_array($manifest['config']['theme'] ?? null)) $config['theme'] = $manifest['config']['theme'];
        if (is_array($manifest['config']['window'] ?? null)) $config['window'] = $manifest['config']['window'];
        // A container's Python packages, which decide the engine its pages start on.
        if ($isV2 && is_array($manifest['config']['python']['packages'] ?? null)) {
            $config['python'] = ['packages' => array_values(array_filter($manifest['config']['python']['packages'], 'is_string'))];
        }
    }
    $out['config'] = (object)$config;
    if (is_array($manifest['permissions'] ?? null)) {
        // The legacy declaration, kept only as the two flags the runtime's
        // fallback reads when a bundle ships no permission.json.
        $out['permissions'] = [
            'network' => (bool)($manifest['permissions']['network'] ?? false),
            'filesystem' => (bool)($manifest['permissions']['filesystem'] ?? false),
        ];
    }
    return $out;
}

/** The icon entry the shell may link to: an image the bundle holds, under the size bound. */
function softn_icon_entry(ZipArchive $zip, array $manifest): ?array
{
    $icon = $manifest['icon'] ?? null;
    if (!is_string($icon)) return null;
    $icon = preg_replace('#^\./#', '', $icon);
    if (!softn_entry_ok($icon)) return null;
    $dot = strrpos($icon, '.');
    $ext = $dot === false ? '' : strtolower(substr($icon, $dot + 1));
    if (!in_array($ext, SOFTN_ICON_EXTENSIONS, true)) return null;
    $stat = $zip->statName($icon);
    if ($stat === false || (int)$stat['size'] > SOFTN_MAX_ICON) return null;
    return ['name' => $icon, 'mime' => softn_classify($icon)[0]];
}

/**
 * Pure-PHP static HTML/UI sanitizer for opt-in SEO & View-Source pre-rendering.
 * Runs with only PHP core + PCRE + ZipArchive + JSON (no mbstring/DOM/ctype)
 * and strictly honors `softn_withheld_for_bundle()`.
 */
function softn_prerender_preview(ZipArchive $zip, array $manifest, array $config): string
{
    if (!($config['prerender'] ?? false)) return '';
    $backendUrl = $config['backendUrl'] ?? null;
    $frontendRoot = is_string($manifest['frontendRoot'] ?? null) ? trim(str_replace('\\', '/', $manifest['frontendRoot']), '/') : '';
    $snapCandidates = [];
    if (is_array($manifest['seo'] ?? null) && is_string($manifest['seo']['prerender'] ?? null)) {
        $snapCandidates[] = ltrim(str_replace('\\', '/', $manifest['seo']['prerender']), '/');
    }
    if (is_string($manifest['prerender'] ?? null)) {
        $snapCandidates[] = ltrim(str_replace('\\', '/', $manifest['prerender']), '/');
    }
    if ($frontendRoot !== '') {
        $snapCandidates[] = $frontendRoot . '/prerender.html';
        $snapCandidates[] = $frontendRoot . '/__softn_ssr__.html';
    }
    $snapCandidates[] = 'prerender.html';
    $snapCandidates[] = '__softn_ssr__.html';
    foreach ($snapCandidates as $snap) {
        if (!softn_entry_ok($snap) || softn_withheld_for_bundle($snap, $config['withhold'], $manifest, $backendUrl)) continue;
        $ext = strtolower((string)pathinfo($snap, PATHINFO_EXTENSION));
        if ($ext !== 'html' && $ext !== 'htm') continue;
        $st = $zip->statName($snap);
        if ($st === false || (int)$st['size'] === 0 || (int)$st['size'] > 524288) continue;
        $rawSnap = $zip->getFromName($snap, 524288);
        if (is_string($rawSnap) && trim($rawSnap) !== '') {
            $clean = softn_prerender_html($rawSnap);
            if ($clean !== '') return $clean;
        }
    }

    $main = is_string($manifest['main'] ?? null) ? ltrim(str_replace('\\', '/', $manifest['main']), '/') : '';
    $candidates = [];
    if ($main !== '') {
        $candidates[] = $main;
        if ($frontendRoot !== '' && !str_starts_with($main, $frontendRoot . '/')) {
            $candidates[] = $frontendRoot . '/' . $main;
        }
    }
    if ($frontendRoot !== '') $candidates[] = $frontendRoot . '/index.html';
    $candidates[] = 'index.html';
    $candidates[] = 'ui/main.ui';

    $entry = null;
    foreach ($candidates as $cand) {
        if (!softn_entry_ok($cand)) continue;
        if (softn_withheld_for_bundle($cand, $config['withhold'], $manifest, $backendUrl)) continue;
        $ext = strtolower((string)pathinfo($cand, PATHINFO_EXTENSION));
        if (!in_array($ext, ['ui', 'html', 'htm'], true)) continue;
        if ($zip->locateName($cand) !== false) { $entry = $cand; break; }
    }
    if ($entry === null) return '';
    $stat = $zip->statName($entry);
    if ($stat === false || (int)$stat['size'] === 0 || (int)$stat['size'] > 262144) return '';
    $raw = $zip->getFromName($entry, 262144);
    if (!is_string($raw) || trim($raw) === '') return '';
    $ext = strtolower((string)pathinfo($entry, PATHINFO_EXTENSION));
    if ($ext === 'ui') return softn_prerender_ui($raw);
    $sanitized = softn_prerender_html($raw);
    if (strlen(trim(strip_tags($sanitized))) < 40) {
        $chunks = [];
        $bytes = 0;
        $files = 0;
        for ($i = 0; $i < $zip->numFiles && $i < 600 && $files < 16 && $bytes < 262144; $i++) {
            $n = $zip->getNameIndex($i);
            if (!is_string($n) || str_ends_with($n, '/') || !softn_entry_ok($n)) continue;
            if (softn_withheld_for_bundle($n, $config['withhold'], $manifest, $backendUrl)) continue;
            $low = strtolower($n);
            if ($frontendRoot !== '' && !str_starts_with($low, strtolower($frontendRoot) . '/')) continue;
            if (preg_match('#^(?:server|backend|private|vendor|node_modules|kit|lib)/#', $low) === 1) continue;
            $fext = strtolower((string)pathinfo($low, PATHINFO_EXTENSION));
            if (!in_array($fext, ['js', 'mjs', 'jsx', 'tsx', 'vue'], true)) continue;
            $fst = $zip->statIndex($i);
            if ($fst === false || (int)$fst['size'] === 0 || (int)$fst['size'] > 262144) continue;
            $src = $zip->getFromIndex($i, 262144);
            if (!is_string($src) || $src === '') continue;
            if ($fext === 'vue') {
                if (preg_match('/<template\b[^>]*>([\s\S]*?)<\/template\s*>/i', $src, $vm) === 1) {
                    $cleaned = preg_replace('/\{\{[\s\S]*?\}\}/', '', $vm[1]) ?? $vm[1];
                    $chunks[] = $cleaned;
                    $bytes += strlen($cleaned);
                    $files++;
                }
                continue;
            }
            if (!str_contains($src, 'html`')) continue;
            $files++;
            $pos = 0; $slen = strlen($src);
            while ($pos < $slen && count($chunks) < 120) {
                $idx = strpos($src, 'html`', $pos);
                if ($idx === false) break;
                if ($idx > 0 && preg_match('/[A-Za-z0-9_$]/', $src[$idx - 1]) === 1) { $pos = $idx + 5; continue; }
                $j = $idx + 5; $buf = '';
                while ($j < $slen) {
                    $c = $src[$j];
                    if ($c === '\\' && $j + 1 < $slen) { $j += 2; continue; }
                    if ($c === '`') { $j++; break; }
                    if ($c === '$' && $j + 1 < $slen && $src[$j + 1] === '{') {
                        $d = 1; $q = null; $j += 2;
                        while ($j < $slen && $d > 0) {
                            $cc = $src[$j];
                            if ($q !== null) { if ($cc === '\\' && $j + 1 < $slen) { $j += 2; continue; } if ($cc === $q) $q = null; }
                            else { if ($cc === '"' || $cc === "'" || $cc === '`') $q = $cc; elseif ($cc === '{') $d++; elseif ($cc === '}') $d--; }
                            $j++;
                        }
                        $buf .= ' ';
                        continue;
                    }
                    $buf .= $c; $j++;
                }
                $pos = $j;
                if (str_contains($buf, '<') && trim($buf) !== '') { $chunks[] = $buf; $bytes += strlen($buf); }
            }
        }
        if ($chunks !== []) {
            $jsHtml = softn_prerender_html(implode("\n", $chunks));
            if ($jsHtml !== '') $sanitized = $sanitized !== '' ? ($sanitized . "\n" . $jsHtml) : $jsHtml;
        }
    }
    return $sanitized;
}

function softn_prerender_clean_text(string $raw): string
{
    $decoded = html_entity_decode($raw, ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $clean = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/', '', $decoded) ?? '';
    $clean = preg_replace('/\s+/', ' ', $clean) ?? '';
    return trim($clean);
}

function softn_prerender_safe_href(string $attrs): ?string
{
    if (preg_match('/\bhref\s*=\s*(?:"([^"]*)"|\'([^\']*)\')/i', $attrs, $m) !== 1) return null;
    $val = $m[1] !== '' ? $m[1] : ($m[2] ?? '');
    $decoded = trim(html_entity_decode($val, ENT_QUOTES | ENT_HTML5, 'UTF-8'));
    if ($decoded === '' || strlen($decoded) > 512 || preg_match('/[\x00-\x20\x7F"\'<>]/', $decoded) === 1) return null;
    return preg_match('#^https?://[A-Za-z0-9.\-\[\]:]+(?:/.*)?$#i', $decoded) === 1 ? $decoded : null;
}

function softn_prerender_strip_non_content(string $raw): string
{
    static $dropSubtree = [
        'script' => true, 'style' => true, 'noscript' => true, 'template' => true,
        'iframe' => true, 'object' => true, 'embed' => true, 'svg' => true, 'math' => true,
        'form' => true, 'textarea' => true, 'select' => true, 'canvas' => true,
        'audio' => true, 'video' => true,
    ];
    static $dropSingle = ['input' => true, 'meta' => true, 'link' => true, 'base' => true];
    $out = '';
    $len = strlen($raw);
    $i = 0;
    while ($i < $len) {
        $lt = strpos($raw, '<', $i);
        if ($lt === false) { $out .= substr($raw, $i); break; }
        if ($lt > $i) $out .= substr($raw, $i, $lt - $i);
        if (substr_compare($raw, '<!--', $lt, 4) === 0) {
            $end = strpos($raw, '-->', $lt + 4);
            if ($end === false) break;
            $i = $end + 3;
            continue;
        }
        if ($lt + 1 < $len && $raw[$lt + 1] === '!') {
            $gt = strpos($raw, '>', $lt + 2);
            if ($gt === false) break;
            $i = $gt + 1;
            continue;
        }
        $gt = null; $q = null;
        for ($k = $lt + 1; $k < $len; $k++) {
            $ch = $raw[$k];
            if ($q !== null) { if ($ch === $q) $q = null; }
            elseif ($ch === '"' || $ch === "'") { $q = $ch; }
            elseif ($ch === '>') { $gt = $k; break; }
        }
        if ($gt === null) break;
        $tagSlice = substr($raw, $lt, $gt - $lt + 1);
        if (preg_match('/^<\s*([a-zA-Z][a-zA-Z0-9:-]*)(?=[\s\/>])/', $tagSlice, $tm) === 1) {
            $tag = strtolower($tm[1]);
            $selfClosing = str_ends_with(rtrim(substr($tagSlice, 0, -1)), '/');
            if (isset($dropSingle[$tag])) { $i = $gt + 1; continue; }
            if (isset($dropSubtree[$tag])) {
                $i = $gt + 1;
                if (!$selfClosing) {
                    $closePos = null; $searchFrom = $i;
                    while ($searchFrom < $len) {
                        $cand = stripos($raw, '</' . $tag, $searchFrom);
                        if ($cand === false) break;
                        $after = $cand + 2 + strlen($tag);
                        while ($after < $len && ($raw[$after] === ' ' || $raw[$after] === "\t" || $raw[$after] === "\n" || $raw[$after] === "\r")) $after++;
                        if ($after < $len && $raw[$after] === '>') { $closePos = $after + 1; break; }
                        $searchFrom = $cand + 2;
                    }
                    if ($closePos === null) break;
                    $i = $closePos;
                }
                continue;
            }
        }
        $out .= $tagSlice;
        $i = $gt + 1;
    }
    return $out;
}

function softn_prerender_html(string $raw): string
{
    $raw = softn_prerender_strip_non_content($raw);
    $bodyMatch = preg_match('/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i', $raw, $m);
    if ($bodyMatch === false) return '';
    if ($bodyMatch === 1) $raw = $m[1];
    else {
        $strippedHead = preg_replace('/<head\b[^>]*>[\s\S]*?<\/head\s*>/i', '', $raw);
        if ($strippedHead === null) return '';
        $raw = $strippedHead;
    }
    $allowed = ['h1'=>1,'h2'=>1,'h3'=>1,'h4'=>1,'h5'=>1,'h6'=>1,'p'=>1,'ul'=>1,'ol'=>1,'li'=>1,'section'=>1,'article'=>1,'header'=>1,'main'=>1,'footer'=>1,'nav'=>1,'aside'=>1,'div'=>1,'span'=>1,'a'=>1,'strong'=>1,'b'=>1,'em'=>1,'i'=>1,'code'=>1,'pre'=>1,'blockquote'=>1,'table'=>1,'thead'=>1,'tbody'=>1,'tr'=>1,'th'=>1,'td'=>1,'dl'=>1,'dt'=>1,'dd'=>1,'figure'=>1,'figcaption'=>1,'hr'=>1,'br'=>1,'label'=>1,'button'=>1];
    $voids = ['br'=>1,'hr'=>1];
    $esc = static fn(string $s): string => htmlspecialchars($s, ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML5, 'UTF-8');
    $root = ['tag' => '#root', 'attrs' => '', 'children' => []];
    $stack = [&$root];
    $nodes = 0;
    $tokens = preg_split('/(<\/?[a-zA-Z][a-zA-Z0-9:-]*(?:\s[^<>]*?)?\/?>)/', $raw, -1, PREG_SPLIT_DELIM_CAPTURE | PREG_SPLIT_NO_EMPTY);
    if (!is_array($tokens)) return '';
    foreach ($tokens as $tok) {
        if ($nodes >= 200) break;
        if ($tok[0] === '<' && str_ends_with($tok, '>')) {
            if (preg_match('/^<\/([a-zA-Z][a-zA-Z0-9:-]*)\s*>$/', $tok, $cm) === 1) {
                $t = strtolower($cm[1]);
                if (!isset($allowed[$t]) || isset($voids[$t])) continue;
                for ($idx = count($stack) - 1; $idx >= 1; $idx--) {
                    if (($stack[$idx]['orig'] ?? $stack[$idx]['tag']) === $t) { while (count($stack) > $idx) array_pop($stack); break; }
                }
                continue;
            }
            if (preg_match('/^<([a-zA-Z][a-zA-Z0-9:-]*)(\s[^<>]*?)?(\/?)>$/', $tok, $om) === 1) {
                $orig = strtolower($om[1]);
                $t = $orig;
                if (!isset($allowed[$t]) || count($stack) - 1 >= 32) continue;
                $self = ($om[3] ?? '') === '/' || isset($voids[$t]);
                if ($t === 'h1') $t = 'h2';
                elseif ($t === 'main') $t = 'section';
                $attrs = '';
                if ($t === 'a') {
                    $href = softn_prerender_safe_href($om[2] ?? '');
                    if ($href !== null) $attrs = ' href="' . $esc($href) . '" rel="nofollow ugc noopener noreferrer"';
                    else $t = 'span';
                } elseif ($t === 'button') {
                    $attrs = ' type="button"';
                }
                $nodes++;
                $parent = &$stack[count($stack) - 1];
                $parent['children'][] = ['tag' => $t, 'orig' => $orig, 'attrs' => $attrs, 'children' => []];
                if (!$self) { $last = count($parent['children']) - 1; $stack[] = &$parent['children'][$last]; }
            }
            continue;
        }
        $txt = softn_prerender_clean_text($tok);
        if ($txt !== '') { $parent = &$stack[count($stack) - 1]; $parent['children'][] = $txt; }
    }
    $bytes = 0;
    return softn_prerender_serialize($root['children'], 0, $bytes);
}

function softn_prerender_ui(string $raw): string
{
    $raw = preg_replace('/<!--[\s\S]*?-->/', '', $raw) ?? $raw;
    $raw = preg_replace('/<(logic|script|style|data|import)\b[^>]*>[\s\S]*?<\/\1\s*>/i', '', $raw) ?? $raw;
    $raw = preg_replace('/<(logic|script|style|data|import)\b[^>]*\/?>/i', '', $raw) ?? $raw;
    $raw = preg_replace('/^\s*[#\/](?:if|else|elseif|elif|each|for|end|slot)\b[^\n]*$/mi', '', $raw) ?? $raw;
    $map = ['heading'=>'h2','title'=>'h2','h1'=>'h2','h2'=>'h2','h3'=>'h3','h4'=>'h4','h5'=>'h5','h6'=>'h6','text'=>'p','paragraph'=>'p','p'=>'p','subtitle'=>'p','caption'=>'p','section'=>'section','card'=>'section','panel'=>'section','article'=>'article','header'=>'header','footer'=>'footer','nav'=>'nav','main'=>'section','aside'=>'aside','alert'=>'aside','list'=>'ul','ul'=>'ul','ol'=>'ol','listitem'=>'li','li'=>'li','button'=>'button','link'=>'a','a'=>'a','badge'=>'span','tag'=>'span','label'=>'label','span'=>'span','code'=>'code','pre'=>'pre','divider'=>'hr','hr'=>'hr','br'=>'br','app'=>'div','page'=>'div','box'=>'div','stack'=>'div','row'=>'div','col'=>'div','column'=>'div','grid'=>'div','flex'=>'div','container'=>'div','div'=>'div'];
    $voids = ['br'=>1,'hr'=>1];
    $esc = static fn(string $s): string => htmlspecialchars($s, ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML5, 'UTF-8');
    $root = ['tag' => '#root', 'orig' => '', 'attrs' => '', 'children' => []];
    $stack = [&$root];
    $nodes = 0;
    $len = strlen($raw);
    $pos = 0;
    $extractText = static function (string $chunk): string {
        $out = '';
        $n = strlen($chunk);
        $i = 0;
        while ($i < $n) {
            $b = strpos($chunk, '{', $i);
            if ($b === false) { $out .= substr($chunk, $i); break; }
            $out .= substr($chunk, $i, $b - $i);
            $d = 1; $q = null; $j = $b + 1;
            while ($j < $n && $d > 0) {
                $c = $chunk[$j];
                if ($q !== null) { if ($c === '\\' && $j + 1 < $n) { $j += 2; continue; } if ($c === $q) $q = null; }
                else { if ($c === '"' || $c === "'" || $c === '`') $q = $c; elseif ($c === '{') $d++; elseif ($c === '}') $d--; }
                $j++;
            }
            $expr = trim(substr($chunk, $b + 1, max(0, $j - $b - 2)));
            if (preg_match('/^(?:"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"|\'([^\'\\\\]*(?:\\\\.[^\'\\\\]*)*)\')$/s', $expr, $sm) === 1) {
                $out .= stripcslashes($sm[1] !== '' ? $sm[1] : ($sm[2] ?? ''));
            }
            $i = $j;
        }
        return softn_prerender_clean_text($out);
    };
    while ($pos < $len && $nodes < 200) {
        $lt = strpos($raw, '<', $pos);
        if ($lt === false) {
            $t = $extractText(substr($raw, $pos));
            if ($t !== '') { $p = &$stack[count($stack) - 1]; $p['children'][] = $t; }
            break;
        }
        if ($lt > $pos) {
            $t = $extractText(substr($raw, $pos, $lt - $pos));
            if ($t !== '') { $p = &$stack[count($stack) - 1]; $p['children'][] = $t; }
        }
        $depth = 0; $q = null; $end = null;
        for ($i = $lt + 1; $i < $len; $i++) {
            $c = $raw[$i];
            if ($q !== null) { if ($c === '\\' && $i + 1 < $len) { $i++; continue; } if ($c === $q) $q = null; continue; }
            if ($c === '"' || $c === "'" || $c === '`') { $q = $c; continue; }
            if ($c === '{') { $depth++; continue; }
            if ($c === '}') { if ($depth > 0) $depth--; continue; }
            if ($c === '>' && $depth === 0) { $end = $i; break; }
        }
        if ($end === null) break;
        $slice = substr($raw, $lt, $end - $lt + 1);
        $pos = $end + 1;
        if (preg_match('/^<\/([A-Za-z][A-Za-z0-9_.:-]*)\s*>$/', $slice, $cm) === 1) {
            $o = strtolower($cm[1]);
            for ($idx = count($stack) - 1; $idx >= 1; $idx--) {
                if (($stack[$idx]['orig'] ?? '') === $o) { while (count($stack) > $idx) array_pop($stack); break; }
            }
            continue;
        }
        if (preg_match('/^<([A-Za-z][A-Za-z0-9_.:-]*)([\s\S]*?)(\/?)>$/', $slice, $om) === 1) {
            $o = strtolower($om[1]);
            if (!isset($map[$o]) || count($stack) - 1 >= 32) continue;
            $ht = $map[$o];
            $self = $om[3] === '/' || isset($voids[$ht]);
            $attrs = '';
            if ($ht === 'a') {
                $href = softn_prerender_safe_href($om[2]);
                if ($href !== null) $attrs = ' href="' . $esc($href) . '" rel="nofollow ugc noopener noreferrer"';
                else $ht = 'span';
            } elseif ($ht === 'button') {
                $attrs = ' type="button"';
            }
            $children = [];
            foreach (['title', 'label', 'text'] as $prop) {
                if (preg_match('/\b' . $prop . '\s*=\s*(?:"([^"]*)"|\'([^\']*)\')/i', $om[2], $pm) === 1) {
                    $v = softn_prerender_clean_text($pm[1] !== '' ? $pm[1] : ($pm[2] ?? ''));
                    if ($v !== '') { $children[] = $v; break; }
                }
            }
            $nodes++;
            $p = &$stack[count($stack) - 1];
            $p['children'][] = ['tag' => $ht, 'orig' => $o, 'attrs' => $attrs, 'children' => $children];
            if (!$self) { $last = count($p['children']) - 1; $stack[] = &$p['children'][$last]; }
        }
    }
    $bytes = 0;
    return softn_prerender_serialize($root['children'], 0, $bytes);
}

function softn_prerender_serialize(array $children, int $indent, int &$bytes): string
{
    $esc = static fn(string $s): string => htmlspecialchars($s, ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML5, 'UTF-8');
    $parts = [];
    foreach ($children as $child) {
        if ($bytes >= 12288) break;
        $pad = str_repeat('  ', min($indent, 8));
        if (is_string($child)) {
            $e = $esc($child);
            if ($e !== '') { $bytes += strlen($e); $parts[] = $pad . $e; }
            continue;
        }
        $tag = (string)$child['tag'];
        $attrs = (string)($child['attrs'] ?? '');
        if ($tag === 'br' || $tag === 'hr') { $s = $pad . '<' . $tag . ' />'; $bytes += strlen($s); $parts[] = $s; continue; }
        $rawKids = is_array($child['children'] ?? null) ? $child['children'] : [];
        if ($tag === 'div' && $attrs === '' && count($rawKids) === 1 && is_array($rawKids[0])) {
            $s = softn_prerender_serialize([$rawKids[0]], $indent, $bytes);
            if ($s !== '') $parts[] = $s;
            continue;
        }
        $inner = []; $hasEl = false;
        foreach ($rawKids as $k) {
            if ($bytes >= 12288) break;
            if (is_array($k)) {
                $s = softn_prerender_serialize([$k], $indent + 1, $bytes);
                if ($s !== '') { $inner[] = $s; $hasEl = true; }
            } else {
                $e = $esc($k);
                if ($e !== '') { $bytes += strlen($e); $inner[] = $e; }
            }
        }
        if ($inner === []) continue;
        if (!$hasEl) {
            $s = $pad . '<' . $tag . $attrs . '>' . implode(' ', $inner) . '</' . $tag . '>';
            $bytes += strlen($tag) * 2 + strlen($attrs) + 5;
            $parts[] = $s;
        } else {
            $lines = [$pad . '<' . $tag . $attrs . '>'];
            foreach ($inner as $ln) $lines[] = str_starts_with($ln, '  ') ? $ln : ($pad . '  ' . $ln);
            $lines[] = $pad . '</' . $tag . '>';
            $bytes += strlen($tag) * 2 + strlen($attrs) + 7;
            $parts[] = implode("\n", $lines);
        }
    }
    return implode("\n", $parts);
}

function softn_if_none_match(string $etag): bool
{
    $inm = $_SERVER['HTTP_IF_NONE_MATCH'] ?? null;
    if (!is_string($inm) || $inm === '') return false;
    if (trim($inm) === '*') return true;
    if (preg_match_all('/"[^"]*"/', $inm, $m) > 0) {
        foreach ($m[0] as $cand) {
            $norm = preg_replace('/-(?:gzip|br|zstd|deflate)"$/i', '"', $cand) ?? $cand;
            if ($cand === $etag || $norm === $etag) return true;
        }
    }
    return false;
}

function softn_shell(array $config, string $private): never
{
    $template = @file_get_contents($private . '/shell.html');
    if (!is_string($template)) softn_fail(503, 'Missing private/shell.html.');
    $zip = softn_open($config);
    $manifest = softn_manifest($zip);
    $icon = softn_icon_entry($zip, $manifest);
    if ($icon !== null && softn_withheld_for_bundle($icon['name'], $config['withhold'], $manifest, $config['backendUrl'])) {
        $icon = null;
    }
    $previewHtml = softn_prerender_preview($zip, $manifest, $config);
    $zip->close();
    $endpoint = softn_endpoint();
    $escape = static fn(string $value): string => htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML5, 'UTF-8');
    $description = $config['description'] ?? (is_string($manifest['description'] ?? null) ? softn_text_cut($manifest['description'], 300) : null);
    $side = softn_side($config, $manifest);
    $boot = json_encode(
        ['version' => 1, 'endpoint' => $endpoint, 'loadingText' => $config['loadingText']],
        JSON_HEX_TAG | JSON_HEX_AMP | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE
    );
    if ($boot === false) softn_fail(503, 'Boot configuration could not be encoded.');
    $iconTag = $icon === null
        ? '<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\'/%3E">'
        : '<link rel="icon" href="' . $escape($endpoint . '?icon') . '" type="' . $escape($icon['mime']) . '">';
    $structuredData = '';
    if ($config['pwa'] !== null) {
        $ld = [
            '@context' => 'https://schema.org',
            '@type' => 'WebApplication',
            'name' => $config['title'],
            'operatingSystem' => 'Any',
            'applicationCategory' => 'UtilitiesApplication',
        ];
        if ($description !== null) $ld['description'] = $description;
        $ldOrigin = softn_pwa_origin($config['pwa'], softn_cookie_path());
        if ($ldOrigin !== null) $ld['url'] = $ldOrigin;
        $ldJson = json_encode($ld, JSON_HEX_TAG | JSON_HEX_AMP | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        if (is_string($ldJson)) $structuredData = '<script type="application/ld+json">' . $ldJson . '</script>';
    }
    $ssrContent = '';
    if ($config['prerender']) {
        $ssrLines = ['<article class="softn-ssr" data-softn-ssr="single">', '          <h1>' . $escape($config['title']) . '</h1>'];
        if ($description !== null) $ssrLines[] = '          <p>' . $escape($description) . '</p>';
        if ($previewHtml !== '') {
            $indented = implode("\n", array_map(static fn(string $l): string => '            ' . $l, explode("\n", $previewHtml)));
            $ssrLines[] = '          <section data-softn-preview="rendered" aria-label="Rendered application preview">';
            $ssrLines[] = $indented;
            $ssrLines[] = '          </section>';
        }
        $ssrLines[] = '        </article>';
        $ssrContent = implode("\n", $ssrLines);
    }
    $page = strtr($template, [
        '{{LANG}}' => $escape($config['lang']),
        '{{TITLE}}' => $escape($config['title']),
        '{{THEME}}' => $config['theme'],
        '{{BACKGROUND}}' => softn_ground($side),
        '{{THEME_COLOR}}' => $config['pwa']['themeColor'] ?? softn_ground($side),
        '{{PWA_TAGS}}' => softn_pwa_tags($config, $endpoint, $description, $side),
        '{{STRUCTURED_DATA}}' => $structuredData,
        '{{FOREGROUND}}' => $side === 'dark' ? '#f5f5f8' : '#171821',
        '{{DESCRIPTION_TAG}}' => $description === null ? '' : '<meta name="description" content="' . $escape($description) . '">',
        '{{ICON_TAG}}' => $iconTag,
        '{{LOADING_TEXT}}' => $escape($config['loadingText']),
        '{{BOOT_JSON}}' => $boot,
        '{{SSR_CONTENT}}' => $ssrContent,
    ]);
    $https = softn_is_https_request();
    $crossSiteFramed = !empty($config['frameAncestors']) && $https;
    if ($config['viewerToken']) {
        $tokenValue = softn_token_issue(softn_secret($config, $private), $config['tokenLifetime']);
        $expires = time() + $config['tokenLifetime'];
        $cookiePath = softn_cookie_path();
        if ($crossSiteFramed) {
            // Emit CHIPS `Partitioned` alongside `SameSite=None; Secure` so browsers
            // blocking unpartitioned third-party cookies retain softn_viewer inside frames.
            header(
                'Set-Cookie: ' . SOFTN_COOKIE . '=' . rawurlencode($tokenValue)
                . '; Expires=' . gmdate('D, d M Y H:i:s \G\M\T', $expires)
                . '; Max-Age=' . $config['tokenLifetime']
                . '; Path=' . $cookiePath
                . '; Secure; HttpOnly; SameSite=None; Partitioned',
                false
            );
        } else {
            setcookie(SOFTN_COOKIE, $tokenValue, [
                'expires' => $expires,
                'path' => $cookiePath,
                'secure' => $https,
                'httponly' => true,
                'samesite' => 'Strict',
            ]);
        }
    }
    // Hash any inline executable `<script>` blocks (ENTRY_WATCH + optional SW register) so CSP
    // enforces strict `script-src` and `worker-src` without breaking the shell bootstrap.
    $inlineHashes = [];
    if (preg_match_all('#<script\b([^>]*)>(.*?)</script>#is', $page, $scriptMatches, PREG_SET_ORDER)) {
        foreach ($scriptMatches as $sm) {
            $attrs = $sm[1];
            $body = $sm[2];
            if (preg_match('/\bsrc\s*=/i', $attrs)) continue;
            if (preg_match('/\btype\s*=\s*["\']?\s*application\/(?:ld\+)?json\b/i', $attrs)) continue;
            if ($body === '') continue;
            // Browsers normalize CRLF/CR to LF before computing CSP script hashes (HTML5 spec).
            $normalizedBody = str_replace(["\r\n", "\r"], "\n", $body);
            $inlineHashes["'sha256-" . base64_encode(hash('sha256', $normalizedBody, true)) . "'"] = true;
        }
    }
    $scriptSrc = "'self' 'wasm-unsafe-eval'" . ($inlineHashes !== [] ? ' ' . implode(' ', array_keys($inlineHashes)) : '');
    header('Content-Type: text/html; charset=utf-8');
    header("Content-Security-Policy: base-uri 'self'; object-src 'none'; script-src $scriptSrc; worker-src 'self' blob:; frame-ancestors 'self'" . ($config['frameAncestors'] ? ' ' . implode(' ', $config['frameAncestors']) : ''));
    if (!$config['frameAncestors']) header('X-Frame-Options: SAMEORIGIN');
    if ($config['pwa'] !== null && $config['pwa']['siteUrl'] === null) {
        header('Vary: Host, X-Forwarded-Proto');
    }
    if (!$config['viewerToken']) {
        $etag = '"' . substr(hash('sha256', $page), 0, 24) . '"';
        header('Cache-Control: no-cache');
        header('ETag: ' . $etag);
        if (softn_if_none_match($etag)) {
            http_response_code(304);
            exit;
        }
    } else {
        header('Cache-Control: no-store');
    }
    header('Content-Length: ' . strlen($page));
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'HEAD') echo $page;
    exit;
}

function softn_source(array $config): never
{
    // Deployment tools can preserve the size and timestamp of a changed bundle.
    // Compute its identity once per source response, including on read-only hosts.
    $digest = hash_file('sha256', $config['bundle']);
    if ($digest === false) softn_fail(503, 'Application bundle is unavailable.');
    if ($config['sha256'] !== null && !hash_equals($config['sha256'], $digest)) softn_fail(503, 'Application integrity check failed.');
    $zip = softn_open($config, $digest);
    $index = softn_index($zip);
    $manifest = softn_manifest($zip);
    $declared = null;
    if ($config['permissions'] !== null) {
        $declared = json_decode((string)@file_get_contents($config['permissions']), true);
        if (!is_array($declared)) softn_fail(503, 'The permission sidecar is not valid JSON.');
    }
    $isContainer = softn_is_container_manifest($manifest);
    $backendUrl = $config['backendUrl'] ?? null;
    $clientManifest = $manifest;
    if ($isContainer && $backendUrl !== null) {
        // In multi-user remote backend mode, never expose backend entry paths or database metadata to the browser.
        unset($clientManifest['backend'], $clientManifest['databases'], $clientManifest['ssrEntry']);
    }
    $text = [];
    $entries = [];
    $total = 0;
    foreach ($index as $name => $entry) {
        // An array's key that reads as a whole number is one: a file called "2024".
        $name = (string)$name;
        if ($name === 'manifest.json' || softn_withheld_for_bundle($name, $config['withhold'], $manifest, $backendUrl)) continue;
        $isText = softn_is_container_text($name, $isContainer);
        if (!$isText) {
            $entries[$name] = $entry['size'];
            continue;
        }
        $total += $entry['size'];
        if ($total > SOFTN_MAX_PACK) softn_fail(503, 'The application source exceeds the size limit.');
        $content = $entry['size'] === 0 ? '' : $zip->getFromName($name, $entry['size'] + 1);
        if (!is_string($content) || strlen($content) !== $entry['size']) softn_fail(503, 'Corrupt bundle entry: ' . $name);
        $text[$name] = $content;
    }
    $zip->close();
    $payload = [
        'version' => 1,
        'id' => $config['id'],
        'title' => $config['title'],
        'theme' => $config['theme'],
        'loadingText' => $config['loadingText'],
        'permissionMode' => $config['permissionMode'],
        'digest' => $digest,
        'manifest' => $clientManifest,
        'declared' => $declared,
        'text' => (object)$text,
        'entries' => (object)$entries,
    ];
    if ($backendUrl !== null) {
        $payload['backendUrl'] = $backendUrl;
    }
    $pack = json_encode($payload, JSON_INVALID_UTF8_SUBSTITUTE | JSON_UNESCAPED_SLASHES);
    if ($pack === false) softn_fail(503, 'The application source could not be encoded.');
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('Content-Length: ' . strlen($pack));
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'HEAD') echo $pack;
    exit;
}

function softn_entry(array $config, string $name, bool $icon): never
{
    if (!softn_entry_ok($name) || $name === 'manifest.json') softn_fail(404, 'No such entry.');
    $zip = softn_open($config);
    $manifest = softn_manifest($zip);
    $backendUrl = $config['backendUrl'] ?? null;
    if (softn_withheld_for_bundle($name, $config['withhold'], $manifest, $backendUrl)) softn_fail(404, 'No such entry.');
    if ($icon) {
        $found = softn_icon_entry($zip, $manifest);
        if ($found === null || $found['name'] !== $name) softn_fail(404, 'No such entry.');
    }
    $stat = $zip->statName($name);
    if ($stat === false) softn_fail(404, 'No such entry.');
    $isContainer = softn_is_container_manifest($manifest);
    [$mime, $kind] = softn_classify($name);
    // Text travels in the source pack; an entry URL for it is a probe, not a render.
    if ($kind === 'text' || softn_is_container_text($name, $isContainer)) softn_fail(404, 'No such entry.');
    $size = (int)$stat['size'];
    if ($size > SOFTN_MAX_ENTRY) softn_fail(503, 'Entry exceeds the size limit.');
    $compMethod = (int)($stat['comp_method'] ?? 0);
    $etag = '"' . dechex((int)$stat['crc']) . '-' . $size . '"';
    header('Content-Type: ' . $mime);
    header('ETag: ' . $etag);
    header('Cache-Control: ' . ($config['cacheSeconds'] > 0 ? 'private, max-age=' . $config['cacheSeconds'] : 'no-store'));
    header('Accept-Ranges: ' . ($size > SOFTN_WHOLE_READ && $compMethod !== ZipArchive::CM_STORE ? 'none' : 'bytes'));
    header('Content-Disposition: inline');
    // A document-only policy: harmless to an <img>, a <video> or a fetch, and
    // what an SVG or a PDF opened directly would run under if a browser ever
    // navigated here without the header the guard refuses on.
    header('Content-Security-Policy: sandbox');
    if (softn_if_none_match($etag)) {
        http_response_code(304);
        exit;
    }
    $head = ($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'HEAD';
    $range = $_SERVER['HTTP_RANGE'] ?? null;
    // Refuse range-seek decompression amplification on large deflated entries:
    // seeking to the tail of a 50 MB compressed stream would inflate 50 MB per request.
    if ($size > SOFTN_WHOLE_READ && $compMethod !== ZipArchive::CM_STORE) {
        $range = null;
    }
    // A range is only meaningful against the entry the client has part of.
    // If-Range names that entry; when it is not this one — the bundle was
    // republished under the same address — the whole entry goes back as 200,
    // else the client stitches bytes of the new file onto bytes of the old.
    $ifRange = $_SERVER['HTTP_IF_RANGE'] ?? null;
    if (is_string($ifRange) && trim($ifRange) !== $etag) $range = null;
    if (is_string($range) && $size > 0 && preg_match('/^bytes=(\d*)-(\d*)$/', $range, $m) && ($m[1] !== '' || $m[2] !== '')) {
        if ($m[1] === '') {
            $suffix = min((int)$m[2], $size);
            $start = $size - $suffix;
            $end = $size - 1;
        } else {
            $start = (int)$m[1];
            $end = $m[2] === '' ? $size - 1 : min((int)$m[2], $size - 1);
        }
        if ($start > $end || $start >= $size) {
            header('Content-Range: bytes */' . $size);
            softn_fail(416, 'Range not satisfiable.');
        }
        if ($size <= SOFTN_WHOLE_READ) {
            $data = $zip->getFromName($name, $size + 1);
            if (!is_string($data) || strlen($data) !== $size) softn_fail(503, 'Corrupt bundle entry.');
            http_response_code(206);
            header('Content-Range: bytes ' . $start . '-' . $end . '/' . $size);
            header('Content-Length: ' . ($end - $start + 1));
            if (!$head) echo substr($data, $start, $end - $start + 1);
            exit;
        }
        // A large entry is streamed for a range as it is for the whole: the
        // bytes before the range are inflated and dropped a piece at a time,
        // never held. Reading it whole put up to 50 MB in memory for every
        // 206, and a seeking <video> asks for dozens.
        $stream = $zip->getStream($name);
        if ($stream === false) softn_fail(503, 'Corrupt bundle entry.');
        http_response_code(206);
        header('Content-Range: bytes ' . $start . '-' . $end . '/' . $size);
        header('Content-Length: ' . ($end - $start + 1));
        if ($head) exit;
        softn_stream($stream, $start, $end - $start + 1);
        exit;
    }
    header('Content-Length: ' . $size);
    if ($head || $size === 0) exit;
    if ($size <= SOFTN_WHOLE_READ) {
        // A whole read is a verified read: libzip checks the CRC at the end.
        $data = $zip->getFromName($name, $size + 1);
        if (!is_string($data) || strlen($data) !== $size) softn_fail(503, 'Corrupt bundle entry.');
        echo $data;
        exit;
    }
    $stream = $zip->getStream($name);
    if ($stream === false) softn_fail(503, 'Corrupt bundle entry.');
    softn_stream($stream, 0, $size);
    exit;
}

/**
 * Send `$length` bytes of an entry's stream from `$offset`, 64 KB at a time.
 * A zip stream cannot seek, so what comes before `$offset` is read and
 * dropped the same way. Stops when the client goes away.
 *
 * @param resource $stream
 */
function softn_stream($stream, int $offset, int $length): void
{
    $skip = $offset;
    while ($skip > 0 && !feof($stream)) {
        $chunk = fread($stream, min(65536, $skip));
        if ($chunk === false || $chunk === '') break;
        $skip -= strlen($chunk);
        if (connection_aborted()) break;
    }
    $sent = 0;
    while ($skip === 0 && $sent < $length && !feof($stream)) {
        $chunk = fread($stream, min(65536, $length - $sent));
        if ($chunk === false || $chunk === '') break;
        echo $chunk;
        $sent += strlen($chunk);
        if (connection_aborted()) break;
    }
    fclose($stream);
}

/**
 * Whether the private directory is somewhere the web server serves files
 * from: inside the directory this page is in, or inside the document root.
 * The page's own directory is public whatever DOCUMENT_ROOT says; a site
 * mounted with Alias or as a user directory has the main site's there, and
 * Apache names the mounted one CONTEXT_DOCUMENT_ROOT. Only DOCUMENT_ROOT
 * was looked at, so on such a site a private directory beside index.php
 * passed this check with the archive and the cookie secret on a URL.
 *
 * @param array<string, mixed> $server
 */
function softn_private_is_public(string $private, array $server): bool
{
    $flat = static fn(string $path): string => rtrim(str_replace('\\', '/', $path), '/');
    $private = $flat($private);
    $roots = [__DIR__];
    foreach (['DOCUMENT_ROOT', 'CONTEXT_DOCUMENT_ROOT'] as $key) {
        if (is_string($server[$key] ?? null) && $server[$key] !== '') $roots[] = $server[$key];
    }
    foreach ($roots as $root) {
        $public = realpath($root);
        if ($public === false) continue;
        $public = $flat($public);
        if ($private === $public || str_starts_with($private, $public . '/')) return true;
    }
    return false;
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method !== 'GET' && $method !== 'HEAD') {
    header('Allow: GET, HEAD');
    softn_fail(405, 'Method not allowed.');
}
// Only the page's own address answers. PHP's built-in server and front
// controller rewrites send every unknown path to index.php; those paths are
// not this host's, and a 404 says so rather than rendering the page under a
// name like /app.softn.
$requestPath = parse_url((string)($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
$decodedRequest = is_string($requestPath) ? rawurldecode($requestPath) : null;
if (!is_string($decodedRequest) || ($decodedRequest !== rawurldecode(softn_endpoint()) && $decodedRequest !== rawurldecode(softn_cookie_path()))) {
    softn_fail(404, 'Not found.');
}
$config = softn_config($private);
$privateReal = realpath($private);
if ($privateReal === false) softn_fail(503, 'The private directory is missing.');
if (!$config['allowPrivateInWebroot'] && softn_private_is_public($privateReal, $_SERVER)) {
    softn_fail(503, 'The private directory must be outside the public document root.');
}
if (array_key_exists('manifest', $_GET)) {
    softn_webmanifest($config, $privateReal);
}
if (array_key_exists('source', $_GET)) {
    softn_guard($config, $privateReal);
    softn_source($config);
}
if (array_key_exists('icon', $_GET)) {
    softn_guard($config, $privateReal);
    $zip = softn_open($config);
    $found = softn_icon_entry($zip, softn_manifest($zip));
    $zip->close();
    if ($found === null) softn_fail(404, 'No such entry.');
    softn_entry($config, $found['name'], true);
}
if (array_key_exists('entry', $_GET)) {
    softn_guard($config, $privateReal);
    $name = $_GET['entry'];
    if (!is_string($name)) softn_fail(404, 'No such entry.');
    softn_entry($config, preg_replace('#^\./#', '', $name), false);
}
softn_shell($config, $privateReal);
