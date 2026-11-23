<?php
declare(strict_types=1);

/**
 * BaseGrid Shared PHP 8 Micro-Framework for SoftN v2 Web Containers.
 *
 * Zero-code-change dual-mode execution:
 * 1. Embedded inside a Parent Application (Default): runs inside `zipp-php.wasm`
 *    Worker against `PDO('sqlite:app.db')` backed by XDB SQLite 3 WASM
 *    (persisted automatically in browser IndexedDB and pre-seeded via `seedSql`).
 * 2. Hosted Standalone (`php -S`, Apache, Nginx+FPM, or `softn-host-php`):
 *    opens a local WAL SQLite 3 database file (`BASEGRID_STANDALONE_DB` or
 *    `data/app.db`), auto-executes `schema.sql` on first boot, and emits CORS headers.
 */

final class BaseGridDb
{
    private static ?PDO $pdo = null;
    private static string $mode = 'zipp-wasm';

    public static function mode(): string
    {
        return self::$mode;
    }

    public static function pdo(string $schemaPath = ''): PDO
    {
        if (self::$pdo !== null) {
            return self::$pdo;
        }

        $envDb = getenv('BASEGRID_STANDALONE_DB');
        $serverSoftware = isset($_SERVER['SERVER_SOFTWARE']) ? (string) $_SERVER['SERVER_SOFTWARE'] : '';
        $isStandalone = ($envDb !== false && $envDb !== '')
            || PHP_SAPI === 'cli-server'
            || ($serverSoftware !== '' && stripos($serverSoftware, 'zipp') === false);

        if ($isStandalone) {
            self::$mode = 'standalone-php';
            $dbFile = ($envDb !== false && $envDb !== '')
                ? $envDb
                : dirname(__DIR__) . '/data/app.db';
            $dir = dirname($dbFile);
            if (!is_dir($dir)) {
                @mkdir($dir, 0775, true);
            }
            $needsSeed = !file_exists($dbFile) || filesize($dbFile) === 0;
            $pdo = new PDO('sqlite:' . $dbFile);
            $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
            $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
            $pdo->exec('PRAGMA journal_mode = WAL;');
            $pdo->exec('PRAGMA foreign_keys = ON;');
            if ($needsSeed && $schemaPath !== '' && file_exists($schemaPath)) {
                $sql = file_get_contents($schemaPath);
                if (is_string($sql) && trim($sql) !== '') {
                    $pdo->exec($sql);
                }
            }
            self::$pdo = $pdo;
            return $pdo;
        }

        self::$mode = 'zipp-wasm';
        $pdo = new PDO('sqlite:app.db');
        $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        self::$pdo = $pdo;
        return $pdo;
    }

    /** @return list<array<string, mixed>> */
    public static function all(PDO $pdo, string $sql, array $params = []): array
    {
        $stmt = $pdo->prepare($sql);
        $stmt->execute(self::normParams($params));
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        return is_array($rows) ? $rows : [];
    }

    /** @return array<string, mixed>|null */
    public static function one(PDO $pdo, string $sql, array $params = []): ?array
    {
        $stmt = $pdo->prepare($sql);
        $stmt->execute(self::normParams($params));
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return is_array($row) ? $row : null;
    }

    public static function scalar(PDO $pdo, string $sql, array $params = []): mixed
    {
        $stmt = $pdo->prepare($sql);
        $stmt->execute(self::normParams($params));
        return $stmt->fetchColumn();
    }

    public static function exec(PDO $pdo, string $sql, array $params = []): int
    {
        $stmt = $pdo->prepare($sql);
        $stmt->execute(self::normParams($params));
        return (int) $pdo->lastInsertId();
    }

    private static function normParams(array $params): array
    {
        $out = [];
        foreach ($params as $k => $v) {
            if (is_bool($v)) {
                $out[$k] = $v ? 1 : 0;
            } else {
                $out[$k] = $v;
            }
        }
        return $out;
    }
}

final class BaseGridHttp
{
    public static function sendCorsIfStandalone(): void
    {
        if (BaseGridDb::mode() === 'standalone-php' || PHP_SAPI === 'cli-server') {
            header('Access-Control-Allow-Origin: *');
            header('Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS');
            header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With');
        }
    }

    public static function method(): string
    {
        return strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
    }

    public static function path(): string
    {
        $uri = (string) ($_SERVER['REQUEST_URI'] ?? '/');
        $q = strpos($uri, '?');
        $path = $q === false ? $uri : substr($uri, 0, $q);
        $path = '/' . trim($path, '/');
        return $path === '' ? '/' : $path;
    }

    /** @return array<string, mixed> */
    public static function body(): array
    {
        $raw = file_get_contents('php://input');
        if (!is_string($raw) || trim($raw) === '') {
            return [];
        }
        $decoded = json_decode($raw, true);
        return is_array($decoded) ? $decoded : [];
    }

    public static function query(string $key, string $default = ''): string
    {
        if (isset($_GET[$key]) && is_string($_GET[$key])) {
            return trim($_GET[$key]);
        }
        return $default;
    }

    public static function json(mixed $data, int $status = 200): never
    {
        self::sendCorsIfStandalone();
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode($data, JSON_UNESCAPED_SLASHES);
        exit;
    }

    public static function error(string $message, int $status = 400): never
    {
        self::json(['error' => $message], $status);
    }

    public static function str(array $in, string $key, string $default = '', int $maxLen = 4000): string
    {
        if (!array_key_exists($key, $in) || $in[$key] === null) {
            return $default;
        }
        $s = trim((string) $in[$key]);
        if (strlen($s) > $maxLen) {
            $s = substr($s, 0, $maxLen);
        }
        return $s;
    }

    public static function int(array $in, string $key, int $default = 0): int
    {
        if (!isset($in[$key]) || $in[$key] === '') {
            return $default;
        }
        return (int) $in[$key];
    }

    public static function float(array $in, string $key, float $default = 0.0): float
    {
        if (!isset($in[$key]) || $in[$key] === '') {
            return $default;
        }
        return (float) $in[$key];
    }

    public static function boolInt(array $in, string $key, int $default = 0): int
    {
        if (!array_key_exists($key, $in)) {
            return $default;
        }
        $v = $in[$key];
        if (is_bool($v)) {
            return $v ? 1 : 0;
        }
        if (is_numeric($v)) {
            return ((int) $v) !== 0 ? 1 : 0;
        }
        $s = strtolower(trim((string) $v));
        return ($s === 'true' || $s === '1' || $s === 'yes') ? 1 : 0;
    }

    public static function today(): string
    {
        return date('Y-m-d');
    }

    public static function now(): string
    {
        return date('Y-m-d H:i:s');
    }
}

final class BaseGridRouter
{
    /** @var list<array{method: string, pattern: string, handler: callable}> */
    private array $routes = [];
    private string $appId;
    private string $appName;
    private string $schemaPath;

    public function __construct(string $appId, string $appName, string $schemaPath)
    {
        $this->appId = $appId;
        $this->appName = $appName;
        $this->schemaPath = $schemaPath;
    }

    public function get(string $pattern, callable $handler): void
    {
        $this->routes[] = ['method' => 'GET', 'pattern' => $pattern, 'handler' => $handler];
    }

    public function post(string $pattern, callable $handler): void
    {
        $this->routes[] = ['method' => 'POST', 'pattern' => $pattern, 'handler' => $handler];
    }

    public function put(string $pattern, callable $handler): void
    {
        $this->routes[] = ['method' => 'PUT', 'pattern' => $pattern, 'handler' => $handler];
    }

    public function patch(string $pattern, callable $handler): void
    {
        $this->routes[] = ['method' => 'PATCH', 'pattern' => $pattern, 'handler' => $handler];
    }

    public function delete(string $pattern, callable $handler): void
    {
        $this->routes[] = ['method' => 'DELETE', 'pattern' => $pattern, 'handler' => $handler];
    }

    public function dispatch(): void
    {
        $method = BaseGridHttp::method();
        $path = BaseGridHttp::path();

        if ($method === 'OPTIONS') {
            BaseGridHttp::sendCorsIfStandalone();
            http_response_code(204);
            exit;
        }

        try {
            $pdo = BaseGridDb::pdo($this->schemaPath);

            if ($method === 'GET' && ($path === '/api/health' || $path === '/api/runtime')) {
                BaseGridHttp::json([
                    'ok' => true,
                    'appId' => $this->appId,
                    'appName' => $this->appName,
                    'mode' => BaseGridDb::mode(),
                    'phpVersion' => PHP_VERSION,
                    'database' => BaseGridDb::mode() === 'zipp-wasm'
                        ? 'XDB SQLite 3 (ZIPP WASM / IndexedDB)'
                        : 'SQLite 3 (Native PHP WAL File)',
                ]);
            }

            foreach ($this->routes as $route) {
                if ($route['method'] !== $method) {
                    continue;
                }
                $regex = '#^' . preg_replace('#\{([a-zA-Z_][a-zA-Z0-9_]*)\}#', '(?P<$1>[^/]+)', $route['pattern']) . '$#';
                if (preg_match($regex, $path, $matches) === 1) {
                    $params = [];
                    foreach ($matches as $k => $v) {
                        if (is_string($k)) {
                            $params[$k] = urldecode($v);
                        }
                    }
                    $result = ($route['handler'])($pdo, $params);
                    if (is_array($result) && isset($result['__status'])) {
                        $status = (int) $result['__status'];
                        $payload = $result['__body'] ?? [];
                        BaseGridHttp::json($payload, $status);
                    }
                    BaseGridHttp::json($result, 200);
                }
            }

            BaseGridHttp::error('Route not found: ' . $method . ' ' . $path, 404);
        } catch (Throwable $e) {
            BaseGridHttp::error($e->getMessage(), 500);
        }
    }
}
