<?php
/**
 * Multi-user server-hosted container backends for apps in `data/`.
 *
 * When an app's `app.json` has `hosting: "server"` or `hosting: "hybrid"` (without
 * an external `backend_url` override), `/api/apps/{slug}/backend/...` executes the
 * bundle's embedded backend strictly inside ZIPP WebAssembly `safe-sandbox` engines
 * via `hosted-backend-runner.mjs` (Node 24 + WAL SQLite in `data/apps/<slug>/backend-data/`).
 *
 * Never executes app code on native OS PHP, Python, or a shell.
 */
declare(strict_types=1);

final class HostedBackend
{
    private const STRIP_RESPONSE_HEADERS = [
        'transfer-encoding' => true,
        'connection' => true,
        'keep-alive' => true,
        'upgrade' => true,
        'proxy-authenticate' => true,
        'proxy-authorization' => true,
        'te' => true,
        'trailers' => true,
        'access-control-allow-origin' => true,
        'access-control-allow-methods' => true,
        'access-control-allow-headers' => true,
        'access-control-expose-headers' => true,
        'access-control-allow-credentials' => true,
        'access-control-max-age' => true,
        'x-powered-by' => true,
    ];

    public static function dispatch(Request $req, string $slugGiven, string $subpath): Response
    {
        if (Config::get('allowServerHosting', true) !== true) {
            throw new ApiError(503, 'Server-hosted backends are disabled on this SoftN directory.');
        }

        $slug = Apps::resolveSlug($slugGiven);
        $row = Apps::requireBundle($slug);
        $hosting = Apps::hostingInfo($row);

        if (!$hosting['serverHosted']) {
            throw new ApiError(404, 'This app is configured to run locally in your browser sandbox rather than hosted on SoftN.');
        }
        if ($hosting['customBackendUrl'] !== null) {
            throw new ApiError(400, 'This app routes its backend to a custom URL rather than the SoftN hosted sandbox.');
        }
        if (!is_string($row['backend_runtime'] ?? null) || $row['backend_runtime'] === '') {
            throw new ApiError(404, 'This app bundle does not include an embedded backend.');
        }

        $ver = Apps::version($slug);
        $dataDirRoot = Config::dataDir();
        $appDir = Catalog::path($slug);
        $bundlePath = $appDir . '/' . (string) $ver['file'];
        if (!is_file($bundlePath)) {
            throw new ApiError(404, 'The bundle file is missing.');
        }
        $versionNum = (int) $ver['version'];
        $shaPrefix = substr((string) $ver['sha256'], 0, 12);

        $rateKey = Config::limitKey($req->ip) . "|$slug";
        Db::rateLimit('hostedBackend', $rateKey);

        // Read the raw request body BEFORE releasing locks or spawning the sandbox worker.
        $rawBody = ($req->method === 'GET' || $req->method === 'HEAD') ? '' : $req->body();

        // Release the directory catalogue lock BEFORE extraction or ZIPP WASM execution so
        // directory reads and writes are never stalled by an app's backend request.
        Catalog::release();

        $storageLock = @fopen($dataDirRoot . '/storage.lock', 'c');
        if ($storageLock !== false) {
            flock($storageLock, LOCK_SH);
        }
        try {
            $bundleDir = self::ensureExtracted($appDir, $bundlePath, $versionNum, $shaPrefix);
            $backendDataDir = $appDir . '/backend-data';
            if (!is_dir($backendDataDir) && !@mkdir($backendDataDir, 0700, true) && !is_dir($backendDataDir)) {
                throw new ApiError(503, 'Could not prepare hosted backend data folder.');
            }

            $cleanSubpath = '/' . ltrim($subpath, '/');
            $queryString = (string) ($_SERVER['QUERY_STRING'] ?? '');
            $host = (string) ($_SERVER['HTTP_HOST'] ?? 'localhost');
            $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https';

            $payload = [
                'slug' => $slug,
                'bundleDir' => $bundleDir,
                'dataDir' => $backendDataDir,
                'request' => [
                    'method' => $req->method,
                    'path' => $cleanSubpath,
                    'queryString' => $queryString,
                    'headers' => $req->headers,
                    'bodyBase64' => $rawBody !== '' ? base64_encode($rawBody) : '',
                    'client_ip' => $req->ip,
                    'rate_key' => $rateKey,
                    'host' => $host,
                    'https' => $https,
                ],
            ];

            $result = self::runZippSandbox($payload);
            $status = is_int($result['status'] ?? null) ? $result['status'] : 200;
            if ($status < 100 || $status > 599) $status = 502;
            $rawHeaders = is_array($result['headers'] ?? null) ? $result['headers'] : [];
            $outHeaders = [];
            $hasCacheControl = false;
            $hasContentType = false;
            foreach ($rawHeaders as $pair) {
                if (!is_array($pair) || count($pair) < 2) continue;
                $name = trim((string) $pair[0]);
                $lower = strtolower($name);
                if ($name === '' || isset(self::STRIP_RESPONSE_HEADERS[$lower])) continue;
                if ($lower === 'cache-control') $hasCacheControl = true;
                if ($lower === 'content-type') $hasContentType = true;
                $outHeaders[] = [$name, (string) $pair[1]];
            }
            if (!$hasContentType) {
                $outHeaders[] = ['Content-Type', 'application/octet-stream'];
            }
            if (!$hasCacheControl) {
                $outHeaders[] = ['Cache-Control', 'no-store'];
            }
            $outHeaders[] = ['X-SoftN-Sandbox', 'zipp-safe-sandbox'];
            $body = base64_decode((string) ($result['bodyBase64'] ?? ''), true);
            if ($body === false) $body = '';
            return Response::raw($status, $outHeaders, $body);
        } finally {
            if ($storageLock !== false) {
                flock($storageLock, LOCK_UN);
                fclose($storageLock);
            }
        }
    }

    /** Extract a verified `.softn` bundle once into `backend-cache/v<N>-<sha>/` atomically. */
    private static function ensureExtracted(string $appDir, string $bundlePath, int $versionNum, string $shaPrefix): string
    {
        $cacheRoot = $appDir . '/backend-cache';
        $target = $cacheRoot . '/v' . $versionNum . '-' . $shaPrefix;
        if (is_dir($target) && is_file($target . '/manifest.json')) {
            return $target;
        }
        if (!is_dir($cacheRoot) && !@mkdir($cacheRoot, 0775, true) && !is_dir($cacheRoot)) {
            throw new ApiError(503, 'Could not create hosted backend cache folder.');
        }
        $staging = $cacheRoot . '/.extract-' . bin2hex(random_bytes(6));
        if (!@mkdir($staging, 0775, true)) {
            throw new ApiError(503, 'Could not stage hosted backend bundle.');
        }
        $zip = new ZipArchive();
        if ($zip->open($bundlePath, ZipArchive::RDONLY) !== true) {
            self::removeTree($staging);
            throw new ApiError(500, 'Could not open hosted bundle archive.');
        }
        try {
            $manifestEntry = Bundle::manifestName($zip);
            $prefix = $manifestEntry !== null && str_contains($manifestEntry, '/')
                ? substr($manifestEntry, 0, strrpos($manifestEntry, '/') + 1)
                : '';
            for ($i = 0; $i < $zip->numFiles; $i++) {
                $name = (string) $zip->getNameIndex($i);
                if ($name === '' || str_ends_with($name, '/') || Bundle::unsafeName($name)) continue;
                $rel = $prefix !== '' && str_starts_with($name, $prefix) ? substr($name, strlen($prefix)) : $name;
                if ($rel === '' || Bundle::unsafeName($rel)) continue;
                $dest = $staging . '/' . $rel;
                $parent = dirname($dest);
                if (!is_dir($parent) && !@mkdir($parent, 0775, true) && !is_dir($parent)) {
                    throw new ApiError(503, 'Could not extract hosted backend file.');
                }
                $bytes = $zip->getFromIndex($i);
                if (!is_string($bytes)) continue;
                if (@file_put_contents($dest, $bytes) === false) {
                    throw new ApiError(503, 'Could not write hosted backend file.');
                }
            }
        } catch (Throwable $e) {
            $zip->close();
            self::removeTree($staging);
            throw $e;
        }
        $zip->close();

        if (is_dir($target)) {
            self::removeTree($staging);
            return $target;
        }
        if (!@rename($staging, $target)) {
            self::removeTree($staging);
            if (is_dir($target) && is_file($target . '/manifest.json')) return $target;
            throw new ApiError(503, 'Could not finalize hosted backend bundle cache.');
        }
        return $target;
    }

    /**
     * Spawn `hosted-backend-runner.mjs` under Node 24 with an explicit argv array (no shell)
     * and a strict wall-clock timeout.
     *
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    private static function runZippSandbox(array $payload): array
    {
        $runner = __DIR__ . '/hosted-backend-runner.mjs';
        if (!is_file($runner)) {
            throw new ApiError(503, 'ZIPP hosted backend runner is not installed.');
        }
        $nodeBin = (string) Config::get('hostedBackend.nodeBin', getenv('SOFTN_NODE_BIN') ?: 'node');
        $timeout = max(2, min(60, (int) Config::get('hostedBackend.timeoutSeconds', 15)));

        $env = getenv();
        if (!is_array($env)) $env = [];
        foreach ([
            'hostedBackend.runtimeDir' => 'SOFTN_HOST_RUNTIME_DIR',
            'hostedBackend.enginesDir' => 'SOFTN_CONTAINER_ENGINES_DIR',
            'hostedBackend.coreWasmDir' => 'SOFTN_CORE_WASM_DIR',
        ] as $cfgKey => $envKey) {
            $val = Config::get($cfgKey);
            if (is_string($val) && $val !== '') $env[$envKey] = $val;
        }

        $descriptors = [
            0 => ['pipe', 'r'],
            1 => ['pipe', 'w'],
            2 => ['pipe', 'w'],
        ];
        $proc = @proc_open([$nodeBin, $runner], $descriptors, $pipes, __DIR__, $env, ['bypass_shell' => true]);
        if (!is_resource($proc)) {
            error_log("softn-api: failed to spawn ZIPP hosted backend runner via $nodeBin");
            throw new ApiError(503, 'The hosted ZIPP sandbox runtime could not be started.');
        }

        $inputJson = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        if ($inputJson === false) $inputJson = '{}';

        fwrite($pipes[0], $inputJson);
        fclose($pipes[0]);

        stream_set_blocking($pipes[1], false);
        stream_set_blocking($pipes[2], false);

        $stdout = '';
        $stderr = '';
        $deadline = microtime(true) + $timeout;
        $timedOut = false;

        while (true) {
            $read = [];
            if (!feof($pipes[1])) $read[] = $pipes[1];
            if (!feof($pipes[2])) $read[] = $pipes[2];
            if ($read === []) break;

            $remaining = $deadline - microtime(true);
            if ($remaining <= 0) {
                $timedOut = true;
                break;
            }
            $sec = (int) floor($remaining);
            $usec = (int) (($remaining - $sec) * 1_000_000);
            $write = null;
            $except = null;
            $ready = @stream_select($read, $write, $except, $sec, $usec);
            if ($ready === false) break;
            foreach ($read as $pipe) {
                $chunk = fread($pipe, 65536);
                if ($chunk === false || $chunk === '') continue;
                if ($pipe === $pipes[1]) $stdout .= $chunk;
                else $stderr .= $chunk;
            }
        }

        if ($timedOut) {
            @proc_terminate($proc);
        }
        fclose($pipes[1]);
        fclose($pipes[2]);
        $exitCode = proc_close($proc);

        if ($timedOut) {
            error_log('softn-api: hosted backend timed out for ' . (string) ($payload['slug'] ?? 'unknown'));
            throw new ApiError(504, 'The hosted app backend took too long to respond.');
        }

        $decoded = json_decode($stdout, true);
        if (!is_array($decoded)) {
            error_log('softn-api: hosted backend invalid output (exit ' . $exitCode . '): ' . trim($stderr ?: $stdout));
            throw new ApiError(502, 'The hosted app backend returned an invalid response.');
        }
        if (($decoded['ok'] ?? false) !== true) {
            $errMsg = is_string($decoded['error'] ?? null) ? $decoded['error'] : 'Hosted backend execution failed.';
            error_log('softn-api: hosted backend error for ' . (string) ($payload['slug'] ?? 'unknown') . ': ' . $errMsg . ($stderr !== '' ? ' | ' . trim($stderr) : ''));
            throw new ApiError(502, 'The hosted app backend encountered an error.');
        }
        return $decoded;
    }

    private static function removeTree(string $dir): void
    {
        if (!is_dir($dir)) return;
        foreach (scandir($dir) ?: [] as $name) {
            if ($name === '.' || $name === '..') continue;
            $p = "$dir/$name";
            if (is_dir($p) && !is_link($p)) self::removeTree($p);
            else @unlink($p);
        }
        @rmdir($dir);
    }
}
