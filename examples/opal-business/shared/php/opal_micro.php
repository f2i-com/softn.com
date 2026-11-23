<?php
declare(strict_types=1);

/**
 * Opal Business Shared PHP 8 Micro-Framework for SoftN v2 Containers.
 *
 * Dual-mode execution with zero app code changes:
 * - Embedded in Parent App via SoftN / ZIPP (`zipp-php.wasm`): opens `PDO('sqlite:app.db')`
 *   backed by XDB SQLite 3 WASM (persisted automatically in browser IndexedDB and pre-seeded
 *   from `backend/schema.sql` via `manifest.json`).
 * - Hosted Standalone (`php -S` / Apache / `softn-host-php`): opens a local WAL SQLite 3 file
 *   under `data/app.db` (or `OPAL_STANDALONE_DB`), auto-executes `schema.sql` on first boot,
 *   and sends CORS headers so the Opal Business Parent Host can connect via `backendUrl`.
 */

final class OpalDb
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

        $envDb = getenv('OPAL_STANDALONE_DB');
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

final class OpalHttp
{
    public static function sendCorsIfStandalone(): void
    {
        if (OpalDb::mode() === 'standalone-php' || PHP_SAPI === 'cli-server') {
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

    public static function str(array $in, string $key, string $default = '', int $maxLen = 2000): string
    {
        $v = $in[$key] ?? $default;
        $s = trim((string) $v);
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

    public static function bool(array $in, string $key, bool $default = false): bool
    {
        if (!array_key_exists($key, $in)) {
            return $default;
        }
        $v = $in[$key];
        if (is_bool($v)) {
            return $v;
        }
        if (is_int($v) || is_float($v)) {
            return ((int) $v) !== 0;
        }
        $s = strtolower(trim((string) $v));
        return in_array($s, ['1', 'true', 'yes', 'on'], true);
    }

    public static function today(): string
    {
        return date('Y-m-d');
    }

    public static function now(): string
    {
        return date('Y-m-d H:i');
    }
}

/**
 * Australian Tax, ABN, GST & Stage 3 PAYG/Superannuation Utilities.
 */
final class OpalAu
{
    public const SUPER_GUARANTEE_RATE = 0.12; // 12.0% SG rate from 1 July 2025

    /**
     * Official Australian Business Register (ABR) Mod-89 ABN Checksum Validator.
     */
    public static function validateAbn(string $abn): array
    {
        $digits = preg_replace('/\D+/', '', $abn) ?? '';
        if (strlen($digits) !== 11) {
            return ['valid' => false, 'formatted' => $abn, 'reason' => 'ABN must be 11 digits'];
        }
        $weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
        $sum = 0;
        for ($i = 0; $i < 11; $i++) {
            $d = (int) $digits[$i];
            if ($i === 0) {
                $d -= 1;
            }
            $sum += $d * $weights[$i];
        }
        $valid = ($sum % 89) === 0;
        $formatted = substr($digits, 0, 2) . ' ' . substr($digits, 2, 3) . ' ' . substr($digits, 5, 3) . ' ' . substr($digits, 8, 3);
        return [
            'valid' => $valid,
            'formatted' => $formatted,
            'digits' => $digits,
            'reason' => $valid ? 'Valid ABR Mod-89 checksum' : 'Failed ABR Mod-89 checksum',
        ];
    }

    /**
     * Australian GST calculation for a line item.
     * Codes: GST (10%), CAP (10%), FRE (0%), EXP (0%), INP (0%), ITS (0%), N-T (0%).
     */
    public static function lineTax(float $amount, string $taxCode, bool $taxInclusive = false): array
    {
        $code = strtoupper(trim($taxCode));
        $taxable = ($code === 'GST' || $code === 'CAP');
        if (!$taxable || $amount == 0.0) {
            $amt = round($amount, 2);
            return ['subtotal' => $amt, 'gst' => 0.0, 'total' => $amt, 'taxCode' => $code === '' ? 'N-T' : $code];
        }
        if ($taxInclusive) {
            $total = round($amount, 2);
            $gst = round($total / 11.0, 2);
            $sub = round($total - $gst, 2);
            return ['subtotal' => $sub, 'gst' => $gst, 'total' => $total, 'taxCode' => $code];
        }
        $sub = round($amount, 2);
        $gst = round($sub * 0.10, 2);
        $total = round($sub + $gst, 2);
        return ['subtotal' => $sub, 'gst' => $gst, 'total' => $total, 'taxCode' => $code];
    }

    /**
     * Australian Resident PAYG Withholding estimator (FY2025-26 / FY2026-27 Stage 3 tax brackets + 2% Medicare Levy).
     */
    public static function calculatePayg(float $periodGross, string $frequency, bool $taxFreeThreshold = true, bool $hasHelpDebt = false): float
    {
        if ($periodGross <= 0.0) {
            return 0.0;
        }
        $periodsPerYear = match (strtolower($frequency)) {
            'weekly' => 52.0,
            'monthly' => 12.0,
            default => 26.0, // fortnightly
        };
        $annual = $periodGross * $periodsPerYear;

        if ($taxFreeThreshold) {
            // FY2025-26/2026-27 Resident Stage 3 brackets:
            // $0-$18,200: 0% | $18,201-$45,000: 16% | $45,001-$135,000: 30% | $135,001-$190,000: 37% | $190,001+: 45%
            if ($annual <= 18200.0) {
                $incomeTax = 0.0;
            } elseif ($annual <= 45000.0) {
                $incomeTax = ($annual - 18200.0) * 0.16;
            } elseif ($annual <= 135000.0) {
                $incomeTax = 4288.0 + ($annual - 45000.0) * 0.30;
            } elseif ($annual <= 190000.0) {
                $incomeTax = 31288.0 + ($annual - 135000.0) * 0.37;
            } else {
                $incomeTax = 51638.0 + ($annual - 190000.0) * 0.45;
            }
            $medicare = $annual > 27222.0 ? ($annual * 0.02) : 0.0;
        } else {
            // No tax-free threshold (higher withholding schedule)
            $incomeTax = $annual <= 135000.0 ? ($annual * 0.32) : (43200.0 + ($annual - 135000.0) * 0.45);
            $medicare = $annual * 0.02;
        }

        $help = 0.0;
        if ($hasHelpDebt && $annual > 54435.0) {
            if ($annual <= 67000.0) {
                $help = $annual * 0.02;
            } elseif ($annual <= 90000.0) {
                $help = $annual * 0.045;
            } elseif ($annual <= 125000.0) {
                $help = $annual * 0.07;
            } else {
                $help = $annual * 0.095;
            }
        }

        $periodTax = ($incomeTax + $medicare + $help) / $periodsPerYear;
        // ATO PAYG withholding rounds to the nearest whole dollar
        return round(max(0.0, $periodTax), 0);
    }
}

final class OpalRouter
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
        $method = OpalHttp::method();
        $path = OpalHttp::path();

        if ($method === 'OPTIONS') {
            OpalHttp::sendCorsIfStandalone();
            http_response_code(204);
            exit;
        }

        try {
            $pdo = OpalDb::pdo($this->schemaPath);

            if ($method === 'GET' && ($path === '/api/health' || $path === '/api/runtime')) {
                OpalHttp::json([
                    'ok' => true,
                    'appId' => $this->appId,
                    'appName' => $this->appName,
                    'mode' => OpalDb::mode(),
                    'phpVersion' => PHP_VERSION,
                    'database' => OpalDb::mode() === 'zipp-wasm'
                        ? 'XDB SQLite 3 (ZIPP WASM / IndexedDB)'
                        : 'SQLite 3 (Standalone WAL File)',
                    'jurisdiction' => 'AU (GST 10% · SG 12% · STP Phase 2)',
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
                        OpalHttp::json($payload, $status);
                    }
                    OpalHttp::json($result, 200);
                }
            }

            OpalHttp::error('Route not found: ' . $method . ' ' . $path, 404);
        } catch (Throwable $e) {
            OpalHttp::error($e->getMessage(), 500);
        }
    }
}
