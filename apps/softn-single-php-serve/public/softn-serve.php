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
 *   index.php?source      the source pack: the deployment settings, the
 *                         manifest with only the fields the runtime reads,
 *                         every text entry, and the names of the rest
 *   index.php?entry=PATH  one binary entry, with its MIME type, an ETag and
 *                         byte ranges for media
 *   index.php?icon        the manifest icon, for the page's favicon
 *
 * The archive is opened for each request and only the entry asked for is
 * inflated. The pack and the entries need the cookie the page sets, refuse
 * browser navigations and cross-site fetches, and skip anything the operator
 * lists under `withhold`. What reaches the browser is what the app needs to
 * run — its UI and logic text and the media it renders — and nothing else; a
 * browser must still receive that much to execute it, so this is delivery
 * control, not copy protection (see DEPLOYMENT.md).
 */
if (!isset($private) || !is_string($private)) {
    http_response_code(404);
    exit;
}
ini_set('display_errors', '0');
ini_set('zlib.output_compression', '0');
ini_set('memory_limit', '256M');
set_time_limit(60);
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: strict-origin-when-cross-origin');

const SOFTN_COOKIE = 'softn_viewer';
/** Mirrors the per-entry bound of the core archive reader. */
const SOFTN_MAX_ENTRY = 50 * 1024 * 1024;
/** Mirrors the client's bound on the decoded pack. */
const SOFTN_MAX_PACK = 32 * 1024 * 1024;
const SOFTN_MAX_ICON = 256 * 1024;
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
    'softn' => ['text/plain', 'text'],
    'wgsl' => ['text/plain', 'text'],
    'xdb' => ['application/json', 'text'],
    'html' => ['text/html', 'text'],
    'js' => ['application/javascript', 'text'],
    'txt' => ['text/plain', 'text'],
    'xml' => ['application/xml', 'text'],
    'pdf' => ['application/pdf', 'binary'],
];

function softn_fail(int $status, string $message): never
{
    header('Content-Type: text/plain; charset=utf-8');
    header('Cache-Control: no-store');
    http_response_code($status);
    echo $message;
    exit;
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

/** `withhold` matches an exact path, a directory (`notes/`) or a glob (`*.md`). */
function softn_withheld(string $name, array $withhold): bool
{
    foreach ($withhold as $pattern) {
        if (str_ends_with($pattern, '/')) {
            if (str_starts_with($name, $pattern)) return true;
        } elseif ($pattern === $name || fnmatch($pattern, $name)) {
            return true;
        }
    }
    return false;
}

function softn_config(string $private): array
{
    $file = $private . '/serve.config.php';
    if (!is_file($file)) softn_fail(503, 'Missing private/serve.config.php.');
    $raw = require $file;
    if (!is_array($raw)) softn_fail(503, 'serve.config.php must return an array.');
    $known = ['id', 'title', 'description', 'lang', 'bundle', 'theme', 'loadingText', 'permissionMode', 'permissions', 'sha256',
        'viewerToken', 'tokenLifetime', 'secret', 'withhold', 'cacheSeconds', 'allowPrivateInWebroot'];
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
    foreach ($withhold as $pattern) {
        if (!is_string($pattern) || $pattern === '' || $pattern === 'manifest.json') softn_fail(503, 'withhold must list non-empty paths other than manifest.json.');
    }
    $cacheSeconds = $raw['cacheSeconds'] ?? 3600;
    if (!is_int($cacheSeconds) || $cacheSeconds < 0 || $cacheSeconds > 31536000) softn_fail(503, 'cacheSeconds must be between 0 and 31536000.');
    $allowPrivateInWebroot = $raw['allowPrivateInWebroot'] ?? false;
    if (!is_bool($allowPrivateInWebroot)) softn_fail(503, 'allowPrivateInWebroot must be true or false.');
    return [
        'id' => $id, 'title' => $title, 'description' => $description, 'lang' => $lang, 'bundle' => $bundle, 'theme' => $theme,
        'loadingText' => $loadingText, 'permissionMode' => $permissionMode, 'permissions' => $permissions, 'sha256' => $sha256,
        'viewerToken' => $viewerToken, 'tokenLifetime' => $tokenLifetime, 'secret' => $secret, 'withhold' => array_values($withhold),
        'cacheSeconds' => $cacheSeconds, 'allowPrivateInWebroot' => $allowPrivateInWebroot,
    ];
}

function softn_open(array $config): ZipArchive
{
    if (!class_exists('ZipArchive')) softn_fail(503, 'Enable the PHP zip extension.');
    $zip = new ZipArchive();
    if ($zip->open($config['bundle'], ZipArchive::RDONLY) !== true) softn_fail(503, 'Application bundle is unavailable.');
    return $zip;
}

/**
 * Every file entry with an acceptable name, name => [size, crc]. The refusals
 * are the core index's: a duplicate name or an entry over the per-entry bound
 * makes the archive unusable rather than partly served.
 */
function softn_index(ZipArchive $zip): array
{
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

/** SHA-256 of the archive, cached beside it by size and mtime. */
function softn_digest(string $private, string $bundle): string
{
    $size = filesize($bundle);
    $mtime = filemtime($bundle);
    $cache = $private . '/digest.cache';
    $line = @file_get_contents($cache);
    if (is_string($line)) {
        $parts = explode(' ', trim($line));
        if (count($parts) === 3 && $parts[0] === (string)$size && $parts[1] === (string)$mtime && preg_match('/^[a-f0-9]{64}$/', $parts[2])) return $parts[2];
    }
    $digest = hash_file('sha256', $bundle);
    if ($digest === false) softn_fail(503, 'Application bundle is unavailable.');
    @file_put_contents($cache, $size . ' ' . $mtime . ' ' . $digest . "\n", LOCK_EX);
    return $digest;
}

function softn_secret(array $config, string $private): string
{
    if ($config['secret'] !== '') return $config['secret'];
    $file = $private . '/secret.key';
    $existing = @file_get_contents($file);
    if (is_string($existing) && strlen(trim($existing)) >= 32) return trim($existing);
    $secret = bin2hex(random_bytes(32));
    if (@file_put_contents($file, $secret . "\n", LOCK_EX) === false) {
        softn_fail(503, 'The private directory is not writable. Set secret in serve.config.php or make it writable by the PHP user.');
    }
    @chmod($file, 0600);
    // Two first requests may have raced; whatever is on disk now is the secret.
    $written = @file_get_contents($file);
    return is_string($written) && strlen(trim($written)) >= 32 ? trim($written) : $secret;
}

function softn_token_issue(string $secret, int $lifetime): string
{
    $body = '1.' . (time() + $lifetime) . '.' . bin2hex(random_bytes(8));
    return $body . '.' . substr(hash_hmac('sha256', $body, $secret), 0, 32);
}

function softn_token_valid(string $token, string $secret): bool
{
    $parts = explode('.', $token);
    if (count($parts) !== 4 || $parts[0] !== '1' || !ctype_digit($parts[1]) || !preg_match('/^[a-f0-9]{16}$/', $parts[2])) return false;
    if ((int)$parts[1] <= time()) return false;
    $body = $parts[0] . '.' . $parts[1] . '.' . $parts[2];
    return hash_equals(substr(hash_hmac('sha256', $body, $secret), 0, 32), $parts[3]);
}

/** The directory the page lives in, with a trailing slash: the cookie's scope. */
function softn_cookie_path(): string
{
    $script = str_replace('\\', '/', (string)($_SERVER['SCRIPT_NAME'] ?? '/'));
    $dir = dirname($script);
    return rtrim($dir === '\\' ? '/' : $dir, '/') . '/';
}

/** Path-absolute URL of index.php, what every fetch and asset URL is relative to. */
function softn_endpoint(): string
{
    $script = str_replace('\\', '/', (string)($_SERVER['SCRIPT_NAME'] ?? ''));
    if (preg_match('#^/[^?\#\s]*$#', $script) && !str_starts_with($script, '//')) return $script;
    return softn_cookie_path() . 'index.php';
}

/** What every request but the page itself must pass. */
function softn_guard(array $config, string $private): void
{
    if (($_SERVER['HTTP_SEC_FETCH_MODE'] ?? '') === 'navigate') softn_fail(403, 'This address is used by the application, not for browsing.');
    if (($_SERVER['HTTP_SEC_FETCH_SITE'] ?? '') === 'cross-site') softn_fail(403, 'Cross-site requests are not allowed.');
    if (!$config['viewerToken']) return;
    $token = $_COOKIE[SOFTN_COOKIE] ?? null;
    if (!is_string($token) || !softn_token_valid($token, softn_secret($config, $private))) softn_fail(403, 'Open the application page first.');
}

/** The manifest with only the fields the runtime reads; never the raw file. */
function softn_manifest(ZipArchive $zip): array
{
    $raw = $zip->getFromName('manifest.json');
    $manifest = is_string($raw) ? json_decode($raw, true) : null;
    if (!is_array($manifest) || !is_string($manifest['name'] ?? null) || !is_string($manifest['main'] ?? null) || !is_array($manifest['files'] ?? null)) {
        softn_fail(503, 'Invalid application manifest.');
    }
    $files = [];
    foreach (['ui', 'logic', 'xdb', 'assets'] as $kind) {
        if (is_array($manifest['files'][$kind] ?? null)) $files[$kind] = array_values(array_filter($manifest['files'][$kind], 'is_string'));
    }
    $out = [
        'name' => $manifest['name'],
        'version' => is_string($manifest['version'] ?? null) ? $manifest['version'] : '0.0.0',
        'main' => $manifest['main'],
        'files' => (object)$files,
    ];
    if (is_string($manifest['description'] ?? null)) $out['description'] = $manifest['description'];
    if (is_string($manifest['icon'] ?? null)) $out['icon'] = $manifest['icon'];
    $config = [];
    if (is_array($manifest['config'] ?? null)) {
        if (is_string($manifest['config']['execution'] ?? null)) $config['execution'] = $manifest['config']['execution'];
        if (is_array($manifest['config']['theme'] ?? null)) $config['theme'] = $manifest['config']['theme'];
        if (is_array($manifest['config']['window'] ?? null)) $config['window'] = $manifest['config']['window'];
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

function softn_shell(array $config, string $private): never
{
    $template = @file_get_contents($private . '/shell.html');
    if (!is_string($template)) softn_fail(503, 'Missing private/shell.html.');
    $zip = softn_open($config);
    $manifest = softn_manifest($zip);
    $icon = softn_icon_entry($zip, $manifest);
    $zip->close();
    $endpoint = softn_endpoint();
    $escape = static fn(string $value): string => htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML5, 'UTF-8');
    $description = $config['description'] ?? (is_string($manifest['description'] ?? null) ? mb_substr($manifest['description'], 0, 300) : null);
    $dark = $config['theme'] === 'dark';
    $boot = json_encode(
        ['version' => 1, 'endpoint' => $endpoint, 'loadingText' => $config['loadingText']],
        JSON_HEX_TAG | JSON_HEX_AMP | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE
    );
    if ($boot === false) softn_fail(503, 'Boot configuration could not be encoded.');
    $iconTag = $icon === null
        ? '<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\'/%3E">'
        : '<link rel="icon" href="' . $escape($endpoint . '?icon') . '" type="' . $escape($icon['mime']) . '">';
    $page = strtr($template, [
        '{{LANG}}' => $escape($config['lang']),
        '{{TITLE}}' => $escape($config['title']),
        '{{THEME}}' => $dark ? 'dark' : 'light',
        '{{BACKGROUND}}' => $dark ? '#171821' : '#f5f5f8',
        '{{FOREGROUND}}' => $dark ? '#f5f5f8' : '#171821',
        '{{DESCRIPTION_TAG}}' => $description === null ? '' : '<meta name="description" content="' . $escape($description) . '">',
        '{{ICON_TAG}}' => $iconTag,
        '{{LOADING_TEXT}}' => $escape($config['loadingText']),
        '{{BOOT_JSON}}' => $boot,
    ]);
    if ($config['viewerToken']) {
        setcookie(SOFTN_COOKIE, softn_token_issue(softn_secret($config, $private), $config['tokenLifetime']), [
            'expires' => time() + $config['tokenLifetime'],
            'path' => softn_cookie_path(),
            'secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
            'httponly' => true,
            'samesite' => 'Strict',
        ]);
    }
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-store');
    header('Content-Length: ' . strlen($page));
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'HEAD') echo $page;
    exit;
}

function softn_source(array $config, string $private): never
{
    $digest = softn_digest($private, $config['bundle']);
    if ($config['sha256'] !== null && !hash_equals($config['sha256'], $digest)) softn_fail(503, 'Application integrity check failed.');
    $zip = softn_open($config);
    $index = softn_index($zip);
    $manifest = softn_manifest($zip);
    $declared = null;
    if ($config['permissions'] !== null) {
        $declared = json_decode((string)@file_get_contents($config['permissions']), true);
        if (!is_array($declared)) softn_fail(503, 'The permission sidecar is not valid JSON.');
    }
    $text = [];
    $entries = [];
    $total = 0;
    foreach ($index as $name => $entry) {
        if ($name === 'manifest.json' || softn_withheld($name, $config['withhold'])) continue;
        if (softn_classify($name)[1] !== 'text') {
            $entries[$name] = $entry['size'];
            continue;
        }
        $total += $entry['size'];
        if ($total > SOFTN_MAX_PACK) softn_fail(503, 'The application source exceeds the size limit.');
        $content = $entry['size'] === 0 ? '' : $zip->getFromName($name);
        if (!is_string($content) || strlen($content) !== $entry['size']) softn_fail(503, 'Corrupt bundle entry: ' . $name);
        $text[$name] = $content;
    }
    $zip->close();
    $pack = json_encode([
        'version' => 1,
        'id' => $config['id'],
        'title' => $config['title'],
        'theme' => $config['theme'],
        'loadingText' => $config['loadingText'],
        'permissionMode' => $config['permissionMode'],
        'digest' => $digest,
        'manifest' => $manifest,
        'declared' => $declared,
        'text' => (object)$text,
        'entries' => (object)$entries,
    ], JSON_INVALID_UTF8_SUBSTITUTE | JSON_UNESCAPED_SLASHES);
    if ($pack === false) softn_fail(503, 'The application source could not be encoded.');
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('Content-Length: ' . strlen($pack));
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'HEAD') echo $pack;
    exit;
}

function softn_entry(array $config, string $name, bool $icon): never
{
    if (!softn_entry_ok($name) || $name === 'manifest.json' || softn_withheld($name, $config['withhold'])) softn_fail(404, 'No such entry.');
    $zip = softn_open($config);
    if ($icon) {
        $found = softn_icon_entry($zip, softn_manifest($zip));
        if ($found === null || $found['name'] !== $name) softn_fail(404, 'No such entry.');
    }
    $stat = $zip->statName($name);
    if ($stat === false) softn_fail(404, 'No such entry.');
    [$mime, $kind] = softn_classify($name);
    // Text travels in the source pack; an entry URL for it is a probe, not a render.
    if ($kind === 'text') softn_fail(404, 'No such entry.');
    $size = (int)$stat['size'];
    if ($size > SOFTN_MAX_ENTRY) softn_fail(503, 'Entry exceeds the size limit.');
    $etag = '"' . dechex((int)$stat['crc']) . '-' . $size . '"';
    header('Content-Type: ' . $mime);
    header('ETag: ' . $etag);
    header('Cache-Control: ' . ($config['cacheSeconds'] > 0 ? 'private, max-age=' . $config['cacheSeconds'] : 'no-store'));
    header('Accept-Ranges: bytes');
    header('Content-Disposition: inline');
    // A document-only policy: harmless to an <img>, a <video> or a fetch, and
    // what an SVG or a PDF opened directly would run under if a browser ever
    // navigated here without the header the guard refuses on.
    header('Content-Security-Policy: sandbox');
    $conditional = $_SERVER['HTTP_IF_NONE_MATCH'] ?? null;
    if (is_string($conditional)) {
        foreach (explode(',', $conditional) as $candidate) {
            $candidate = trim($candidate);
            if (str_starts_with($candidate, 'W/')) $candidate = substr($candidate, 2);
            if ($candidate === $etag || $candidate === '*') {
                http_response_code(304);
                exit;
            }
        }
    }
    $head = ($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'HEAD';
    $range = $_SERVER['HTTP_RANGE'] ?? null;
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
        $data = $zip->getFromName($name);
        if (!is_string($data) || strlen($data) !== $size) softn_fail(503, 'Corrupt bundle entry.');
        http_response_code(206);
        header('Content-Range: bytes ' . $start . '-' . $end . '/' . $size);
        header('Content-Length: ' . ($end - $start + 1));
        if (!$head) echo substr($data, $start, $end - $start + 1);
        exit;
    }
    header('Content-Length: ' . $size);
    if ($head || $size === 0) exit;
    if ($size <= SOFTN_WHOLE_READ) {
        // A whole read is a verified read: libzip checks the CRC at the end.
        $data = $zip->getFromName($name);
        if (!is_string($data) || strlen($data) !== $size) softn_fail(503, 'Corrupt bundle entry.');
        echo $data;
        exit;
    }
    $stream = $zip->getStream($name);
    if ($stream === false) softn_fail(503, 'Corrupt bundle entry.');
    $sent = 0;
    while ($sent < $size && !feof($stream)) {
        $chunk = fread($stream, min(65536, $size - $sent));
        if ($chunk === false || $chunk === '') break;
        echo $chunk;
        $sent += strlen($chunk);
        if (connection_aborted()) break;
    }
    fclose($stream);
    exit;
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
if (!is_string($requestPath) || ($requestPath !== softn_endpoint() && $requestPath !== softn_cookie_path())) {
    softn_fail(404, 'Not found.');
}
$config = softn_config($private);
$privateReal = realpath($private);
$public = realpath((string)($_SERVER['DOCUMENT_ROOT'] ?? __DIR__));
if ($privateReal === false) softn_fail(503, 'The private directory is missing.');
if (!$config['allowPrivateInWebroot'] && $public !== false && ($privateReal === $public || str_starts_with($privateReal, $public . DIRECTORY_SEPARATOR))) {
    softn_fail(503, 'The private directory must be outside the public document root.');
}
if (array_key_exists('source', $_GET)) {
    softn_guard($config, $privateReal);
    softn_source($config, $privateReal);
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
