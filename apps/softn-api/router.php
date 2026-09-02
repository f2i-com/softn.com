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
        // The built-in server guesses text/plain for types it does not know.
        $types = ['softn' => 'application/octet-stream', 'wasm' => 'application/wasm', 'webmanifest' => 'application/manifest+json', 'mjs' => 'text/javascript'];
        if (isset($types[$ext])) {
            header('Content-Type: ' . $types[$ext]);
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
        readfile("$real/index.html");
        return true;
    }
}

foreach (['web', 'builder', 'studio'] as $app) {
    if (preg_match("#^/$app(/|$)#", $path) && is_file("$root/$app/index.html")) {
        header('Content-Type: text/html; charset=utf-8');
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
readfile("$root/index.html");
return true;
