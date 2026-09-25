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
        // The reply names no path: it goes to anyone who asks, and where the
        // site keeps its private data is not theirs to learn. The operator
        // finds the path in the error log.
        if (!is_dir($dir) && !@mkdir($dir, 0775, true)) {
            error_log("softn-api: the data directory cannot be created: $dir");
            throw new ApiError(503, 'The data directory cannot be created. The server error log names it: create it and let PHP write to it.');
        }
        if (!is_writable($dir)) {
            error_log("softn-api: the data directory is not writable: $dir");
            throw new ApiError(503, 'The data directory is not writable. The server error log names it: let PHP write to it.');
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
                // Who may say where a request came from: the addresses and
                // CIDR ranges (IPv4 and IPv6) of the proxies in front of this
                // host, whose X-Forwarded-For is believed. Empty trusts nobody.
                // `trustProxy: true` is the older switch and means the peer
                // this request came in on, whoever it is; see README.
                'trustedProxies' => [],
                'trustProxy' => false,
                'siteName' => 'SoftN',
                // The request limits, in bytes; how each route gets one is
                // Limits in http.php and the Limits section of the README.
                // A config.json written by an earlier version carries the old
                // 48 MB maxJsonBytes; lower it to this by hand.
                'maxBundleBytes' => 32 * 1024 * 1024,
                'maxThumbnailBytes' => 2 * 1024 * 1024,
                'maxThumbnailSide' => 8192,
                'maxThumbnailPixels' => 16 * 1000 * 1000,
                'maxJsonBytes' => 256 * 1024,
                // A Server-Timing header on every response with the catalogue's
                // lock wait and hold, boot, cache rebuild and commit times —
                // what scripts/bench/catalog-bench.mjs reads. Off unless asked.
                'debugTimings' => false,
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
                    'version' => [30, 3600],
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

    /**
     * The key a visitor's rate limits count under. An IPv4 address is one
     * visitor; an IPv6 address is counted by its /64, because one subscriber
     * is handed a whole /64 (often more) and picks a fresh address in it at
     * will — keyed by the full address, every request could come from a new
     * "visitor" and no limit held. A rating is counted the same way (one
     * vote per /64); a storage owner is the visitor token, not an address.
     */
    public static function limitKey(string $ip): string
    {
        return self::visitorHash(Net::limitBucket($ip));
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
        if (!extension_loaded('pdo_sqlite')) {
            error_log('softn-api: the pdo_sqlite extension is not loaded; per-app storage needs it');
            throw new ApiError(503, "This server's PHP has no pdo_sqlite extension, which server-side storage needs.");
        }
        try {
            $pdo = new PDO('sqlite:' . $path, null, null, [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            ]);
        } catch (PDOException $e) {
            // PDO's message carries the file's path; it goes to the log only.
            error_log('softn-api: the database cannot be opened: ' . $e->getMessage());
            throw new ApiError(503, 'The database cannot be opened.');
        }
        $pdo->exec('PRAGMA journal_mode=WAL');
        $pdo->exec('PRAGMA synchronous=NORMAL');
        $pdo->exec('PRAGMA foreign_keys=ON');
        $pdo->exec('PRAGMA busy_timeout=5000');
        return $pdo;
    }
    /**
     * Count one use of `$bucket` by `$key` and refuse it past the limit.
     *
     * The counters have a lock of their own, held for this read-modify-write
     * alone. They used to be kept under the catalogue lock, which a request
     * then held until it ended — through the upload that follows a publish
     * or a new version. One client trickling a bundle in held every other
     * request, including every read, for the duration of its upload. Nothing
     * else touches ratelimits.json, so nothing else waits on it now.
     */
    public static function rateLimit(string $bucket, string $key): void {
        $limit=Config::get("limits.$bucket");if(!is_array($limit)||count($limit)!==2)return;
        [$max,$window]=array_map('intval',$limit);
        $dir=Config::dataDir();$lock=fopen("$dir/ratelimits.lock",'c');
        if(!$lock||!flock($lock,LOCK_EX))throw new ApiError(503,'The directory is busy.');
        try {
            $path="$dir/ratelimits.json";$rows=Catalog::readJson($path);$now=time();$id=hash('sha256',$bucket.'|'.$key);
            foreach($rows as $k=>$r)if($now>=$r['expires'])unset($rows[$k]);
            $r=$rows[$id]??['count'=>0,'expires'=>$now+$window];
            if($r['count']>=$max)throw new ApiError(429,'Too many requests; try again in a little while.',['retryAfter'=>max(1,$r['expires']-$now)]);
            $r['count']++;$rows[$id]=$r;Catalog::writeJson($path,$rows);
        } finally {flock($lock,LOCK_UN);fclose($lock);}
    }
}
