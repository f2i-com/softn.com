<?php
/**
 * Where the directory keeps its state: one SQLite catalogue, one SQLite file
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
            $decoded = json_decode((string) file_get_contents($path), true);
            if (is_array($decoded)) $values = array_replace_recursive($defaults, $decoded);
        }
        if (!is_file($path) || !isset($decoded['salt'], $decoded['adminKey'])) {
            $written = json_encode($values, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
            if ($written !== false) @file_put_contents($path, $written . "\n", LOCK_EX);
        }
        self::$values = $values;
        return $values;
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
    private static ?PDO $catalog = null;
    private static ?bool $fts = null;

    public static function catalog(): PDO
    {
        if (self::$catalog !== null) return self::$catalog;
        $path = Config::dataDir() . '/directory.sqlite';
        $pdo = self::open($path);
        self::migrate($pdo);
        self::$catalog = $pdo;
        return $pdo;
    }

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

    /** Whether the catalogue has a full-text index; LIKE is the fallback. */
    public static function hasFts(): bool
    {
        if (self::$fts === null) self::catalog();
        return (bool) self::$fts;
    }

    private static function migrate(PDO $pdo): void
    {
        $version = (int) $pdo->query('PRAGMA user_version')->fetchColumn();
        if ($version < 1) {
            $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS apps (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'other',
  tags TEXT NOT NULL DEFAULT '[]',
  parent_slug TEXT,
  root_slug TEXT,
  latest_version INTEGER NOT NULL DEFAULT 1,
  capabilities TEXT NOT NULL DEFAULT '[]',
  execution TEXT NOT NULL DEFAULT 'main',
  thumb TEXT,
  icon TEXT,
  primary_color TEXT,
  edit_key_hash TEXT,
  source TEXT NOT NULL DEFAULT 'upload',
  runs INTEGER NOT NULL DEFAULT 0,
  remixes INTEGER NOT NULL DEFAULT 0,
  rating_sum INTEGER NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  comments INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS apps_category ON apps(category, hidden);
CREATE INDEX IF NOT EXISTS apps_created ON apps(created_at);
CREATE INDEX IF NOT EXISTS apps_parent ON apps(parent_slug);
CREATE TABLE IF NOT EXISTS versions (
  slug TEXT NOT NULL,
  version INTEGER NOT NULL,
  file TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  manifest_version TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (slug, version)
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  visitor TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_slug ON comments(slug, created_at);
CREATE TABLE IF NOT EXISTS ratings (
  slug TEXT NOT NULL,
  visitor TEXT NOT NULL,
  stars INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (slug, visitor)
);
CREATE TABLE IF NOT EXISTS runs_daily (
  slug TEXT NOT NULL,
  day INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (slug, day)
);
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  emoji TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'suggested',
  sort INTEGER NOT NULL DEFAULT 100,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ratelimit (
  bucket TEXT NOT NULL,
  key TEXT NOT NULL,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL,
  PRIMARY KEY (bucket, key)
);
SQL);
            $pdo->exec('PRAGMA user_version = 1');
        }
        if ($version < 2) {
            // Storage collection policies, fixed at publication from the bundle's
            // permission.json; and launches, a press of Play on the directory,
            // counted apart from runs, which is the runtime reporting the app up.
            $pdo->exec("ALTER TABLE apps ADD COLUMN storage_policies TEXT NOT NULL DEFAULT '{}'");
            $pdo->exec('ALTER TABLE apps ADD COLUMN launches INTEGER NOT NULL DEFAULT 0');
            $pdo->exec('PRAGMA user_version = 2');
        }
        // The full-text index is optional: a host whose SQLite lacks FTS5
        // still searches, with LIKE.
        try {
            $pdo->exec("CREATE VIRTUAL TABLE IF NOT EXISTS apps_fts USING fts5(slug UNINDEXED, name, description, tags, author, tokenize='porter unicode61')");
            self::$fts = true;
        } catch (PDOException) {
            self::$fts = false;
        }
    }

    /**
     * Count one action against a visitor and refuse when the window is full.
     * The windows are fixed rather than sliding — simpler, and honest enough
     * for what they guard.
     */
    public static function rateLimit(string $bucket, string $key): void
    {
        $limit = Config::get("limits.$bucket");
        if (!is_array($limit) || count($limit) !== 2) return;
        [$max, $window] = [(int) $limit[0], (int) $limit[1]];
        $pdo = self::catalog();
        $now = time();
        $pdo->beginTransaction();
        try {
            $row = $pdo->prepare('SELECT count, window_start FROM ratelimit WHERE bucket = ? AND key = ?');
            $row->execute([$bucket, $key]);
            $r = $row->fetch();
            if (!$r || $now - (int) $r['window_start'] >= $window) {
                $pdo->prepare('INSERT OR REPLACE INTO ratelimit (bucket, key, count, window_start) VALUES (?, ?, 1, ?)')
                    ->execute([$bucket, $key, $now]);
            } elseif ((int) $r['count'] >= $max) {
                $pdo->commit();
                $retry = $window - ($now - (int) $r['window_start']);
                throw new ApiError(429, 'Too many requests; try again in a little while.', ['retryAfter' => $retry]);
            } else {
                $pdo->prepare('UPDATE ratelimit SET count = count + 1 WHERE bucket = ? AND key = ?')->execute([$bucket, $key]);
            }
            // Old windows are swept opportunistically so the table stays small.
            if (random_int(0, 99) === 0) {
                $pdo->prepare('DELETE FROM ratelimit WHERE window_start < ?')->execute([$now - 86400]);
            }
            $pdo->commit();
        } catch (ApiError $e) {
            throw $e;
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
    }
}
