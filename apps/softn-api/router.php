<?php
/**
 * The site on PHP's built-in server, for a local preview with the API alive:
 *
 *   php -S 127.0.0.1:1420 -t dist apps/softn-api/router.php
 *
 * It does what the deployed .htaccess does — /api/ to the API, /data/ to
 * nowhere, an app's share page through the API, real files as they are, and
 * every other navigation to the single-page app that owns it. Production
 * does not use this file; Apache reads the rules from .htaccess.
 */
declare(strict_types=1);

$root = rtrim(str_replace('\\', '/', $_SERVER['DOCUMENT_ROOT'] ?? getcwd()), '/');
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
$path = is_string($path) ? rawurldecode($path) : '/';

if (preg_match('#^/api(/|$)#', $path) || preg_match('#^/app/[^/]+/?$#', $path)) {
    require "$root/api/index.php";
    return true;
}
if (preg_match('#^/data(/|$)#', $path)) {
    http_response_code(404);
    header('Content-Type: text/plain');
    echo 'Not found';
    return true;
}

$real = realpath($root . $path);
$rootReal = realpath($root);
if ($real !== false && $rootReal !== false && str_starts_with(str_replace('\\', '/', $real), str_replace('\\', '/', $rootReal))) {
    if (is_file($real)) {
        $ext = strtolower(pathinfo($real, PATHINFO_EXTENSION));
        // Every static type the site ships is served from here rather than by
        // the built-in server's own handler, for two reasons: that handler
        // guesses text/plain for types it does not know, and it sends none of
        // the isolation headers. Those have to be on every response, not only
        // documents — a page that is cross-origin isolated refuses to start a
        // dedicated worker whose script arrives without the embedder policy,
        // which is exactly how the worker-mode apps (Pocket, WarbleWire) load.
        // The deployed .htaccess and nginx configs set the headers site-wide.
        $types = [
            'softn' => 'application/octet-stream', 'wasm' => 'application/wasm', 'webmanifest' => 'application/manifest+json',
            'mjs' => 'text/javascript', 'js' => 'text/javascript', 'css' => 'text/css', 'json' => 'application/json',
            'map' => 'application/json', 'html' => 'text/html; charset=utf-8', 'txt' => 'text/plain; charset=utf-8',
            'svg' => 'image/svg+xml', 'png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'webp' => 'image/webp',
            'gif' => 'image/gif', 'ico' => 'image/x-icon', 'woff' => 'font/woff', 'woff2' => 'font/woff2', 'ttf' => 'font/ttf',
            'wav' => 'audio/wav', 'mp3' => 'audio/mpeg', 'ogg' => 'audio/ogg', 'mp4' => 'video/mp4', 'webm' => 'video/webm',
        ];
        if (isset($types[$ext])) {
            header('Content-Type: ' . $types[$ext]);
            header('Cross-Origin-Opener-Policy: same-origin');
            header('Cross-Origin-Embedder-Policy: credentialless');
            header('Content-Length: ' . (string) filesize($real));
            readfile($real);
            return true;
        }
        return false;
    }
    if (is_dir($real) && is_file("$real/index.html")) {
        if (!str_ends_with($path, '/')) {
            header("Location: $path/", true, 308);
            return true;
        }
        header('Content-Type: text/html; charset=utf-8');
        header('Cross-Origin-Opener-Policy: same-origin');
        header('Cross-Origin-Embedder-Policy: credentialless');
        readfile("$real/index.html");
        return true;
    }
}

// The single-page shells for every route inside them. These carry the
// isolation headers too: /web/app/Pocket is the document a worker-mode app
// runs in, and a document without them has no SharedArrayBuffer whatever
// its scripts were served with. The deployed configs set the headers on
// every response; this file has to say so for each branch it answers from,
// and the release smoke test (scripts/smoke-site.mjs) checks that it does.
foreach (['web', 'builder', 'studio'] as $app) {
    if (preg_match("#^/$app(/|$)#", $path) && is_file("$root/$app/index.html")) {
        header('Content-Type: text/html; charset=utf-8');
        header('Cross-Origin-Opener-Policy: same-origin');
        header('Cross-Origin-Embedder-Policy: credentialless');
        readfile("$root/$app/index.html");
        return true;
    }
}
if (preg_match('#\.[a-z0-9]+$#i', $path)) {
    http_response_code(404);
    header('Content-Type: text/plain');
    echo 'Not found';
    return true;
}
header('Content-Type: text/html; charset=utf-8');
header('Cross-Origin-Opener-Policy: same-origin');
header('Cross-Origin-Embedder-Policy: credentialless');
readfile("$root/index.html");
return true;
