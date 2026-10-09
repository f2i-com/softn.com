<?php
declare(strict_types=1);
// Set this to the private backend directory if you upload it elsewhere.
$backend = dirname(__DIR__) . '/backend';
// Checked here, in syntax every PHP version reads, so that an old PHP or a
// wrong path is a clear JSON answer and not a parse error or a warning that
// prints this server's paths. Errors stop being shown before the path is
// looked at, and the look itself is silenced (ini_set may be disabled): where
// open_basedir does not include the backend, is_file() is a warning naming
// the backend's path and every allowed one, and a host that shows errors
// printed it above the JSON.
if (function_exists('ini_set')) ini_set('display_errors', '0');
if (function_exists('error_clear_last')) error_clear_last();
$softnBackendFound = @is_file($backend . '/http.php');
if (PHP_VERSION_ID < 80100 || !$softnBackendFound) {
    // Not found because PHP may not look there is another thing to fix than a wrong path.
    $softnLast = function_exists('error_get_last') ? error_get_last() : null;
    $softnBasedir = is_array($softnLast) && strpos((string) $softnLast['message'], 'open_basedir') !== false;
    http_response_code(503);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo PHP_VERSION_ID < 80100
        ? '{"error":"The SoftN backend needs PHP 8.1 or newer.","code":"backend_unavailable","diagnostic":"php_version"}'
        : ($softnBasedir
            ? '{"error":"PHP on this site may not read the private backend directory: add it to open_basedir.","code":"backend_unavailable","diagnostic":"open_basedir"}'
            : '{"error":"The private backend was not found. Set $backend in api.php.","code":"backend_unavailable","diagnostic":"backend_path"}');
    exit;
}
require $backend . '/http.php';
