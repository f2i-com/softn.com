<?php
declare(strict_types=1);
// Set this to the private backend directory if you upload it elsewhere.
$backend = dirname(__DIR__) . '/backend';
// Checked here, in syntax every PHP version reads, so that an old PHP or a
// wrong path is a clear JSON answer and not a parse error or a warning that
// prints this server's paths.
if (PHP_VERSION_ID < 80100 || !is_file($backend . '/http.php')) {
    if (function_exists('ini_set')) ini_set('display_errors', '0');
    http_response_code(503);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo PHP_VERSION_ID < 80100
        ? '{"error":"The SoftN backend needs PHP 8.1 or newer.","code":"backend_unavailable","diagnostic":"php_version"}'
        : '{"error":"The private backend was not found. Set $backend in api.php.","code":"backend_unavailable","diagnostic":"backend_path"}';
    exit;
}
require $backend . '/http.php';
