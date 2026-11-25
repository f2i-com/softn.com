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
        'content-length' => true,
        'status' => true,
        'refresh' => true,
        'clear-site-data' => true,
        'service-worker-allowed' => true,
        'strict-transport-security' => true,
        'content-security-policy' => true,
        'content-security-policy-report-only' => true,
        'x-frame-options' => true,
        'x-content-type-options' => true,
        'cross-origin-opener-policy' => true,
        'cross-origin-embedder-policy' => true,
        'cross-origin-resource-policy' => true,
        'referrer-policy' => true,
        'access-control-allow-origin' => true,
        'access-control-allow-methods' => true,
        'access-control-allow-headers' => true,
        'access-control-expose-headers' => true,
        'access-control-allow-credentials' => true,
        'access-control-max-age' => true,
        'x-powered-by' => true,
    ];

    private const STRIP_REQUEST_HEADERS = [
        'x-admin-key' => true,
        'x-edit-key' => true,
        'x-visitor-token' => true,
        'proxy-authorization' => true,
        'forwarded' => true,
        'x-real-ip' => true,
        'x-original-url' => true,
        'x-rewrite-url' => true,
        'x-http-method-override' => true,
        'x-method-override' => true,
    ];

    private const MAX_RESPONSE_HEADERS = 128;
    private const MAX_RESPONSE_HEADER_LEN = 8192;
    private const MAX_RESPONSE_BODY_BYTES = 16 * 1024 * 1024;
    private const MAX_STDOUT_BYTES = 24 * 1024 * 1024;
    private const MAX_STDERR_BYTES = 65536;

    private static function isBlockedResponseHeader(string $lower): bool
    {
        if (isset(self::STRIP_RESPONSE_HEADERS[$lower])) return true;
        return str_starts_with($lower, 'x-accel-')
            || str_starts_with($lower, 'x-sendfile')
            || str_starts_with($lower, 'x-litespeed-')
            || str_starts_with($lower, 'x-lighttpd-');
    }

    /**
     * Scope a guest backend's Set-Cookie header strictly to `/api/apps/{slug}/backend`
     * so one hosted app can never overwrite directory cookies or sibling apps' cookies.
     */
    private static function scopeSetCookie(string $raw, string $slug, bool $https): ?string
    {
        $raw = str_replace(["\r", "\n", "\0"], '', $raw);
        if ($raw === '' || strlen($raw) > 4096) return null;
        $parts = explode(';', $raw);
        $nv = trim($parts[0]);
        $eq = strpos($nv, '=');
        if ($eq === false || $eq === 0) return null;
        $name = trim(substr($nv, 0, $eq));
        $value = trim(substr($nv, $eq + 1));
        if ($name === '' || !preg_match('/^[!#$%&\'*+\-.^_`|~0-9A-Za-z]+$/', $name)) return null;
        // __Host- cookies require Path=/; never allow a guest backend to claim root path.
        if (stripos($name, '__Host-') === 0) return null;

        $attrs = ["$name=$value"];
        $hasHttpOnly = false;
        for ($i = 1; $i < count($parts); $i++) {
            $attr = trim($parts[$i]);
            if ($attr === '') continue;
            $aEq = strpos($attr, '=');
            $aKey = strtolower(trim($aEq === false ? $attr : substr($attr, 0, $aEq)));
            if ($aKey === 'domain' || $aKey === 'path' || $aKey === 'samesite' || $aKey === 'secure') {
                continue;
            }
            if ($aKey === 'httponly') {
                $hasHttpOnly = true;
                continue;
            }
            $attrs[] = $attr;
        }
        $attrs[] = "Path=/api/apps/$slug/backend";
        $attrs[] = 'SameSite=Lax';
        if ($https) $attrs[] = 'Secure';
        if ($hasHttpOnly) $attrs[] = 'HttpOnly';
        return implode('; ', $attrs);
    }

    /** @param array<string, string> $headers @return array<string, string> */
    private static function scrubRequestHeaders(array $headers): array
    {
        $safe = [];
        foreach ($headers as $k => $v) {
            $lower = strtolower((string) $k);
            if ($lower === '' || isset(self::STRIP_REQUEST_HEADERS[$lower])) continue;
            if (str_starts_with($lower, 'x-forwarded-') || str_starts_with($lower, 'x-formlogic')) continue;
            $safe[$lower] = (string) $v;
        }
        return $safe;
    }

    /** Acquire a bounded concurrency slot (flock) for hosted sandbox workers. @return resource */
    private static function acquireSlot(string $dataDirRoot)
    {
        $maxSlots = max(1, min(16, (int) Config::get('hostedBackend.maxConcurrent', 4)));
        $slotDir = $dataDirRoot . '/hosted-slots';
        if (!is_dir($slotDir) && !@mkdir($slotDir, 0700, true) && !is_dir($slotDir)) {
            throw new ApiError(503, 'Could not prepare hosted backend slot folder.');
        }
        for ($i = 0; $i < $maxSlots; $i++) {
            $fh = @fopen("$slotDir/slot-$i.lock", 'c');
            if ($fh === false) continue;
            if (@flock($fh, LOCK_EX | LOCK_NB)) {
                return $fh;
            }
            fclose($fh);
        }
        throw new ApiError(503, 'The hosted app backend is busy. Please try again in a moment.', ['retryAfter' => 2]);
    }

    public static function dispatch(Request $req, string $slugGiven, string $subpath): Response
    {
        if (Config::get('allowServerHosting', true) !== true) {
            throw new ApiError(503, 'Server-hosted backends are disabled on this SoftN directory.');
        }

        // Read the raw request body BEFORE acquiring catalog.lock (LOCK_EX) so a slow-POST
        // client trickling up to 10 MiB over the network cannot stall the entire directory.
        $rawBody = ($req->method === 'GET' || $req->method === 'HEAD') ? '' : $req->body();

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

        // Acquire storage.lock (LOCK_SH) BEFORE releasing catalog.lock so a concurrent retire()
        // or moveAppFolder() cannot delete or move `$appDir` between release and lock acquisition.
        $storageLock = @fopen($dataDirRoot . '/storage.lock', 'c');
        if ($storageLock !== false) {
            flock($storageLock, LOCK_SH);
        }
        Catalog::release();

        $slot = null;
        try {
            $rateKey = Config::limitKey($req->ip) . "|$slug";
            Db::rateLimit('hostedBackend', $rateKey);
            $slot = self::acquireSlot($dataDirRoot);
            if (!is_file($bundlePath)) {
                throw new ApiError(404, 'The bundle file is missing.');
            }
            $bundleDir = self::ensureExtracted($appDir, $bundlePath, $versionNum, $shaPrefix);
            $backendDataDir = $appDir . '/backend-data';
            if (!is_dir($backendDataDir) && !@mkdir($backendDataDir, 0700, true) && !is_dir($backendDataDir)) {
                throw new ApiError(503, 'Could not prepare hosted backend data folder.');
            }

            $cleanSubpath = '/' . ltrim($subpath, '/');
            $queryString = (string) ($_SERVER['QUERY_STRING'] ?? '');
            $host = (string) ($_SERVER['HTTP_HOST'] ?? 'localhost');
            $https = Request::isHttps();

            $payload = [
                'slug' => $slug,
                'bundleDir' => $bundleDir,
                'dataDir' => $backendDataDir,
                'request' => [
                    'method' => $req->method,
                    'path' => $cleanSubpath,
                    'queryString' => $queryString,
                    'headers' => self::scrubRequestHeaders($req->headers),
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
            $headerCount = 0;
            foreach ($rawHeaders as $pair) {
                if ($headerCount >= self::MAX_RESPONSE_HEADERS) break;
                if (!is_array($pair) || count($pair) < 2) continue;
                $rawName = (string) $pair[0];
                // Validate raw header name BEFORE trimming/lowercasing/blocklist check so interior NUL bytes
                // (e.g. `Set\0-Cookie`, `X-Accel\0-Redirect`) can never slip past blocklists and be reconstructed later.
                if ($rawName === '' || !preg_match('/^[A-Za-z0-9!#$%&\'*+\-.^_`|~]+$/D', $rawName)) continue;
                $name = $rawName;
                $lower = strtolower($name);
                if (self::isBlockedResponseHeader($lower)) continue;
                $val = str_replace(["\r", "\n", "\0"], '', (string) $pair[1]);
                if (strlen($val) > self::MAX_RESPONSE_HEADER_LEN) continue;
                if ($lower === 'set-cookie') {
                    $scoped = self::scopeSetCookie($val, $slug, $https);
                    if ($scoped === null) continue;
                    $outHeaders[] = ['Set-Cookie', $scoped];
                    $headerCount++;
                    continue;
                }
                if ($lower === 'cache-control') $hasCacheControl = true;
                if ($lower === 'content-type') $hasContentType = true;
                $outHeaders[] = [$name, $val];
                $headerCount++;
            }
            if (!$hasContentType) {
                $outHeaders[] = ['Content-Type', 'application/octet-stream'];
            }
            if (!$hasCacheControl) {
                $outHeaders[] = ['Cache-Control', 'no-store'];
            }
            // Enforce user-content sandboxing so HTML/SVG responses served on the directory's
            // origin can never execute scripts in the directory origin or read edit keys.
            $outHeaders[] = ['Content-Security-Policy', Response::USER_CONTENT['Content-Security-Policy']];
            $outHeaders[] = ['X-Content-Type-Options', 'nosniff'];
            $outHeaders[] = ['X-Frame-Options', 'DENY'];
            $outHeaders[] = ['X-SoftN-Sandbox', 'zipp-safe-sandbox'];
            $body = base64_decode((string) ($result['bodyBase64'] ?? ''), true);
            if ($body === false) $body = '';
            if (strlen($body) > self::MAX_RESPONSE_BODY_BYTES) {
                throw new ApiError(502, 'The hosted app backend response exceeded the maximum allowed size.');
            }
            return Response::raw($status, $outHeaders, $body);
        } finally {
            if (is_resource($slot)) {
                flock($slot, LOCK_UN);
                fclose($slot);
            }
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
        Config::requireRoom();
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
            if ($zip->numFiles > Bundle::MAX_ENTRIES) {
                throw new ApiError(400, 'Hosted bundle exceeds the maximum entry count.');
            }
            $stagingReal = realpath($staging);
            if ($stagingReal === false) {
                throw new ApiError(503, 'Could not resolve hosted backend staging folder.');
            }
            $manifestEntry = Bundle::manifestName($zip);
            $prefix = $manifestEntry !== null && str_contains($manifestEntry, '/')
                ? substr($manifestEntry, 0, strrpos($manifestEntry, '/') + 1)
                : '';
            $totalBytes = 0;
            for ($i = 0; $i < $zip->numFiles; $i++) {
                $name = (string) $zip->getNameIndex($i);
                if ($name === '' || str_ends_with($name, '/') || Bundle::unsafeName($name)) continue;
                if (preg_match('/[\x00-\x1f\x7f]/', $name) === 1) continue;
                $opsys = 0;
                $extAttr = 0;
                if ($zip->getExternalAttributesIndex($i, $opsys, $extAttr)
                    && $opsys === ZipArchive::OPSYS_UNIX
                    && ((($extAttr >> 16) & 0o170000) === 0o120000)) {
                    continue;
                }
                $stat = $zip->statIndex($i);
                if ($stat === false || (int) ($stat['encryption_method'] ?? 0) !== ZipArchive::EM_NONE) {
                    continue;
                }
                $declaredSize = (int) ($stat['size'] ?? 0);
                if ($declaredSize < 0 || $totalBytes + $declaredSize > Bundle::MAX_UNCOMPRESSED) {
                    throw new ApiError(400, 'Hosted bundle expands beyond the maximum allowed size.');
                }
                $rel = $prefix !== '' && str_starts_with($name, $prefix) ? substr($name, strlen($prefix)) : $name;
                if ($rel === '' || Bundle::unsafeName($rel) || preg_match('/[\x00-\x1f\x7f]/', $rel) === 1) continue;
                $dest = $staging . '/' . $rel;
                $parent = dirname($dest);
                if (!is_dir($parent) && !@mkdir($parent, 0775, true) && !is_dir($parent)) {
                    throw new ApiError(503, 'Could not extract hosted backend file.');
                }
                if (is_link($parent) || is_link($dest)) {
                    throw new ApiError(400, 'Refused symbolic link while extracting hosted bundle.');
                }
                $parentReal = realpath($parent);
                if ($parentReal === false
                    || ($parentReal !== $stagingReal && !str_starts_with($parentReal, $stagingReal . DIRECTORY_SEPARATOR))) {
                    throw new ApiError(400, 'Hosted bundle entry escaped extraction root.');
                }
                $bytes = $zip->getFromIndex($i);
                if (!is_string($bytes)) continue;
                $totalBytes += strlen($bytes);
                if ($totalBytes > Bundle::MAX_UNCOMPRESSED) {
                    throw new ApiError(400, 'Hosted bundle expands beyond the maximum allowed size.');
                }
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
        // Prune superseded version caches older than the max request timeout + grace window
        // so concurrent requests executing against the previous version are never deleted mid-flight.
        $activeName = basename($target);
        $pruneCutoff = time() - 120;
        foreach (@scandir($cacheRoot) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..' || $entry === $activeName) continue;
            if (!str_starts_with($entry, 'v')) continue;
            $stale = $cacheRoot . '/' . $entry;
            if (!is_dir($stale) || is_link($stale)) continue;
            $mtime = @filemtime($stale);
            if ($mtime !== false && $mtime < $pruneCutoff) {
                self::removeTree($stale);
            }
        }
        return $target;
    }

    /**
     * Spawn `hosted-backend-runner.mjs` under Node 24 with an explicit argv array (no shell),
     * minimal whitelisted environment, memory/prototype hardening, and a strict wall-clock timeout.
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

        // Minimal clean environment whitelist: never forward parent credentials/secrets to guest worker.
        $env = [];
        foreach (['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'COMSPEC', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'TZ', 'LC_ALL', 'LANG', 'SOFTN_HOST_RUNTIME_DIR', 'SOFTN_CONTAINER_ENGINES_DIR', 'SOFTN_CORE_WASM_DIR', 'SOFTN_CONTAINER_BACKEND_MODULE'] as $key) {
            $val = getenv($key);
            if (is_string($val) && $val !== '') $env[$key] = $val;
        }
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
        $argv = [$nodeBin, '--max-old-space-size=128', '--disable-proto=throw', $runner];
        $proc = @proc_open($argv, $descriptors, $pipes, __DIR__, $env, ['bypass_shell' => true]);
        if (!is_resource($proc)) {
            error_log("softn-api: failed to spawn ZIPP hosted backend runner via $nodeBin");
            throw new ApiError(503, 'The hosted ZIPP sandbox runtime could not be started.');
        }

        $inputJson = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        if ($inputJson === false) $inputJson = '{}';

        stream_set_blocking($pipes[0], false);
        stream_set_blocking($pipes[1], false);
        stream_set_blocking($pipes[2], false);

        $stdinOpen = true;
        $stdinOffset = 0;
        $stdinLen = strlen($inputJson);
        if ($stdinLen === 0) {
            fclose($pipes[0]);
            $stdinOpen = false;
        }

        $stdout = '';
        $stderr = '';
        $deadline = microtime(true) + $timeout;
        $timedOut = false;
        $overflowed = false;

        while (true) {
            $read = [];
            if (!feof($pipes[1])) $read[] = $pipes[1];
            if (!feof($pipes[2])) $read[] = $pipes[2];
            $write = $stdinOpen ? [$pipes[0]] : null;
            if ($read === [] && !$stdinOpen) break;

            $remaining = $deadline - microtime(true);
            if ($remaining <= 0) {
                $timedOut = true;
                break;
            }
            $sec = (int) floor($remaining);
            $usec = (int) (($remaining - $sec) * 1_000_000);
            $except = null;
            $ready = @stream_select($read, $write, $except, $sec, $usec);
            if ($ready === false) break;

            if ($stdinOpen && is_array($write) && in_array($pipes[0], $write, true)) {
                $chunk = substr($inputJson, $stdinOffset, 65536);
                $written = @fwrite($pipes[0], $chunk);
                if ($written === false) {
                    @fclose($pipes[0]);
                    $stdinOpen = false;
                } else {
                    $stdinOffset += $written;
                    if ($stdinOffset >= $stdinLen) {
                        @fclose($pipes[0]);
                        $stdinOpen = false;
                    }
                }
            }
            foreach ($read as $pipe) {
                $chunk = fread($pipe, 65536);
                if ($chunk === false || $chunk === '') continue;
                if ($pipe === $pipes[1]) {
                    if (strlen($stdout) + strlen($chunk) > self::MAX_STDOUT_BYTES) {
                        $overflowed = true;
                        break 2;
                    }
                    $stdout .= $chunk;
                } elseif (strlen($stderr) < self::MAX_STDERR_BYTES) {
                    $stderr .= substr($chunk, 0, self::MAX_STDERR_BYTES - strlen($stderr));
                }
            }
        }

        if ($stdinOpen) {
            @fclose($pipes[0]);
        }
        if ($timedOut || $overflowed) {
            @proc_terminate($proc, PHP_OS_FAMILY === 'Windows' ? 15 : 9);
        }
        @fclose($pipes[1]);
        @fclose($pipes[2]);
        $exitCode = proc_close($proc);

        if ($overflowed) {
            error_log('softn-api: hosted backend stdout exceeded limit for ' . (string) ($payload['slug'] ?? 'unknown'));
            throw new ApiError(502, 'The hosted app backend response exceeded the maximum allowed size.');
        }
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
