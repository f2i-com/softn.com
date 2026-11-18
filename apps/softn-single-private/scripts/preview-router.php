<?php
// php -S ignores .htaccess. Dedicated workers need the embedder policy
// deployed by Apache, including when their parent page runs on localhost.
declare(strict_types=1);

if (PHP_SAPI !== 'cli-server') {
    http_response_code(404);
    exit;
}

$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (!is_string($path) || !preg_match('#^/assets/(?:[\w-][\w.-]*/)*[\w-][\w.-]*\.m?js$#D', $path)) {
    return false;
}
$assets = realpath($_SERVER['DOCUMENT_ROOT'] . '/assets');
$file = realpath($_SERVER['DOCUMENT_ROOT'] . $path);
if (!$assets || !$file || !str_starts_with($file, $assets . DIRECTORY_SEPARATOR) || !is_file($file)) {
    http_response_code(404);
    return true;
}
$method = $_SERVER['REQUEST_METHOD'];
if ($method !== 'GET' && $method !== 'HEAD') {
    header('Allow: GET, HEAD');
    http_response_code(405);
    return true;
}
header('Content-Type: text/javascript');
header('Cross-Origin-Opener-Policy: same-origin');
header('Cross-Origin-Embedder-Policy: credentialless');
header('Content-Length: ' . filesize($file));
if ($method === 'GET') readfile($file);
return true;
