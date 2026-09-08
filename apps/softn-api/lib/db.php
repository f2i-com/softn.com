<?php
/**
 * Where the directory keeps its state: folder JSON metadata, one SQLite file
 * per published app for that app's own data, the uploaded bundles, and a JSON
 * config — all under data/ next to the site, which the web server is told
 * never to serve. Nothing else is required of the host.
 */
declare(strict_types=1);

final class Config
{
    /** @var array<string, mixed>|null */
    private static ?array $values = null;

    /** The data directory, created on first use. */
    public static function dataDir(): string
    {
        static $dir = null;
        if ($dir !== null) return $dir;
        $env = getenv('SOFTN_DATA_DIR');
        $dir = is_string($env) && $env !== '' ? $env : dirname(__DIR__, 2) . '/data';
        if (!is_dir($dir) && !@mkdir($dir, 0775, true)) {
            throw new ApiError(503, "The data directory cannot be created. Create $dir and let PHP write to it.");
        }
        if (!is_writable($dir)) {
            throw new ApiError(503, "The data directory is not writable. Let PHP write to $dir.");
        }
        return $dir;
    }

    /** @return array<string, mixed> */
    private static function load(): array
    {
        if (self::$values !== null) return self::$values;
        $path = self::dataDir() . '/config.json';
        $lock = fopen(self::dataDir() . '/config.lock', 'c');
        if (!$lock || !flock($lock, LOCK_EX)) throw new ApiError(503, 'Cannot lock configuration.');
        try {
            $defaults = [
                // Both are generated once. The salt keys the visitor hashes; the
                // admin key is what the site owner presents to moderate.
                'salt' => bin2hex(random_bytes(16)),
                'adminKey' => bin2hex(random_bytes(20)),
                'trustProxy' => false,
                'siteName' => 'SoftN',
                'maxBundleBytes' => 32 * 1024 * 1024,
                'maxThumbnailBytes' => 2 * 1024 * 1024,
                'maxJsonBytes' => 48 * 1024 * 1024,
                'maxVersionsPerApp' => 50,
                'storage' => [
                    'maxCollections' => 32,
                    'maxRecordsPerCollection' => 20000,
                    'maxRecordBytes' => 16 * 1024,
                    'maxDatabaseBytes' => 64 * 1024 * 1024,
                    'maxQueryLimit' => 200,
                ],
                'limits' => [
                    // [count, seconds] per visitor
                    'publish' => [10, 3600],
                    'comment' => [10, 600],
                    'rate' => [60, 600],
                    'run' => [120, 60],
                    'suggest' => [5, 3600],
                    'storageRead' => [600, 60],
                    'storageWrite' => [120, 60],
                ],
                'seedDemos' => true,
            ];
            $values = $defaults;
            if (is_file($path)) {
                $decoded = Catalog::readJson($path);
                if (is_array($decoded)) $values = array_replace_recursive($defaults, $decoded);
            }
            if (!is_file($path) || !isset($decoded['salt'], $decoded['adminKey'])) {
                Catalog::writeJson($path,$values);
            }
            self::$values = $values;
            return $values;
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }

    public static function get(string $key, mixed $default = null): mixed
    {
        $values = self::load();
        $cur = $values;
        foreach (explode('.', $key) as $part) {
            if (!is_array($cur) || !array_key_exists($part, $cur)) return $default;
            $cur = $cur[$part];
        }
        return $cur;
    }

    /** A visitor's identity for limits and one-rating-per-person: a salted hash, never the address. */
    public static function visitorHash(string $ip): string
    {
        return substr(hash('sha256', self::get('salt') . '|' . $ip), 0, 32);
    }

    public static function isAdmin(?string $presented): bool
    {
        $key = self::get('adminKey');
        return is_string($presented) && is_string($key) && $presented !== '' && hash_equals($key, $presented);
    }
}

final class Db
{
    public static function open(string $path): PDO
    {
        try {
            $pdo = new PDO('sqlite:' . $path, null, null, [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            ]);
        } catch (PDOException $e) {
            throw new ApiError(503, 'The database cannot be opened: ' . $e->getMessage());
        }
        $pdo->exec('PRAGMA journal_mode=WAL');
        $pdo->exec('PRAGMA synchronous=NORMAL');
        $pdo->exec('PRAGMA foreign_keys=ON');
        $pdo->exec('PRAGMA busy_timeout=5000');
        return $pdo;
    }
    public static function rateLimit(string $bucket, string $key): void {
        $limit=Config::get("limits.$bucket");if(!is_array($limit)||count($limit)!==2)return;
        [$max,$window]=array_map('intval',$limit);Catalog::boot();
        $path=Config::dataDir().'/ratelimits.json';$rows=Catalog::readJson($path);$now=time();$id=hash('sha256',$bucket.'|'.$key);
        foreach($rows as $k=>$r)if($now>=$r['expires'])unset($rows[$k]);
        $r=$rows[$id]??['count'=>0,'expires'=>$now+$window];
        if($r['count']>=$max)throw new ApiError(429,'Too many requests; try again in a little while.',['retryAfter'=>max(1,$r['expires']-$now)]);
        $r['count']++;$rows[$id]=$r;Catalog::writeJson($path,$rows);
    }
}
