<?php
/**
 * Each published app's own data: a SQLite file of its own, created the first
 * time the app asks for it, behind an API small enough to police.
 *
 * The app never sees SQL. It has collections of JSON records and a key-value
 * store, and the host translates those into queries here — which is what
 * makes quotas, row limits, query bounds and field validation enforceable,
 * and what keeps one app's careless SELECT from being everybody's problem.
 *
 * The data is shared: anybody running the app reaches the same database.
 * What each of them may do to a collection is its policy, declared in the
 * bundle's permission.json under `storage.collections` and fixed at
 * publication (the schema is packages/@softn/core/src/runtime/capabilities.ts):
 *
 *   public       anyone reads, changes and removes every record (the default)
 *   append-only  anyone adds and reads; changing or removing needs the edit key
 *   owner-write  anyone reads; a record is changed or removed by whoever
 *                added it, or with the edit key
 *   private      each visitor sees and changes only the records they added;
 *                nobody else reads them, the publisher included
 *   publisher    reading and writing need the edit key
 *
 * "Whoever added it" is a visitor identity: a hash of a token the runtime
 * keeps in the visitor's browser, salted and bound to this app, sent as
 * X-Visitor-Token. It is not an account. Clear the browser's storage and the
 * records stay where the policy leaves them, but nothing can claim them
 * again. The rate limit is per visitor address per app and is not
 * ownership. Clearing a whole collection needs the edit key under every
 * policy. The key-value store has no policies: it is public.
 *
 * Every write is one SQLite transaction that takes the write lock before it
 * reads (`write` below): the row a policy check looked at is the row the
 * change lands on, and the change names that row's owner as well as its id,
 * so a record removed and re-added by somebody else between the check and
 * the write is a conflict, never a write onto their record. The quota is
 * the data itself — the bytes of every record and key an app holds, counted
 * inside the same transaction — not the size of the database file, which
 * says little in WAL mode (the file can be a few pages while the log holds
 * megabytes) and nothing about what an app actually keeps.
 */
declare(strict_types=1);

final class Storage
{
    private const COLLECTION = '/^[a-z][a-z0-9_]{0,31}$/';
    private const FIELD = '/^[A-Za-z_][A-Za-z0-9_]{0,63}(\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,3}$/';
    private const KEY = '/^[A-Za-z0-9_.:\-]{1,128}$/';
    private const OPS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'contains', 'exists'];
    /** The visitor token as the runtime mints it: URL-safe base64, never stored, only hashed. */
    private const TOKEN = '/^[A-Za-z0-9_-]{16,128}$/';
    /** The policies a collection may declare; the same list as the schema's STORAGE_POLICIES. */
    public const POLICIES = ['public', 'append-only', 'owner-write', 'private', 'publisher'];

    private static function path(string $slug): string
    {
        return Apps::dir($slug) . '/storage.sqlite';
    }

    private static function open(string $slug): PDO
    {
        static $open = [];
        if (isset($open[$slug])) return $open[$slug];
        $pdo = Db::open(self::path($slug));
        $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS records (
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS records_updated ON records(collection, updated_at);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
SQL);
        // Who added a record. Absent on records from before policies existed;
        // under a policy that asks, such a record belongs to nobody, so only
        // the edit key can change it.
        $columns = array_column($pdo->query('PRAGMA table_info(records)')->fetchAll(PDO::FETCH_ASSOC), 'name');
        if (!in_array('owner', $columns, true)) $pdo->exec('ALTER TABLE records ADD COLUMN owner TEXT');
        $pdo->exec('CREATE INDEX IF NOT EXISTS records_owner ON records(collection, owner)');
        return $open[$slug] = $pdo;
    }

    /**
     * What the app page shows: how much this app keeps on the server.
     * `bytes` is the data — what the quota counts; `diskBytes` is what the
     * database, its write-ahead log and its shared-memory index take on disk,
     * which is the operator's number and can be larger or, after deletions,
     * smaller.
     */
    public static function summary(string $slug): array
    {
        $path = self::path($slug);
        if (!is_file($path)) return ['collections' => 0, 'records' => 0, 'keys' => 0, 'bytes' => 0, 'diskBytes' => 0];
        $pdo = self::open($slug);
        return [
            'collections' => (int) $pdo->query('SELECT COUNT(DISTINCT collection) FROM records')->fetchColumn(),
            'records' => (int) $pdo->query('SELECT COUNT(*) FROM records')->fetchColumn(),
            'keys' => (int) $pdo->query('SELECT COUNT(*) FROM kv')->fetchColumn(),
            'bytes' => self::usedBytes($pdo),
            'diskBytes' => self::diskBytes($path),
        ];
    }

    /** The bytes an app's data takes: every record's collection, id and JSON, and every key and value. */
    private static function usedBytes(PDO $pdo): int
    {
        $records = (int) $pdo->query('SELECT COALESCE(SUM(LENGTH(collection) + LENGTH(id) + LENGTH(data)), 0) FROM records')->fetchColumn();
        $kv = (int) $pdo->query('SELECT COALESCE(SUM(LENGTH(key) + LENGTH(value)), 0) FROM kv')->fetchColumn();
        return $records + $kv;
    }

    /** What the database takes on disk: the main file, the write-ahead log and the shared-memory index. */
    private static function diskBytes(string $path): int
    {
        clearstatcache(true, $path);
        $total = 0;
        foreach ([$path, "$path-wal", "$path-shm"] as $file) {
            if (is_file($file)) $total += (int) filesize($file);
        }
        return $total;
    }

    /**
     * Refuse a write that would take the app's data over its quota. Called
     * inside the write transaction, so the count is of the data as it is at
     * the moment of the write and nothing can slip in between. `$incoming`
     * is what the write adds; `$replacing` what it removes.
     */
    private static function assertQuota(PDO $pdo, array $limits, int $incoming, int $replacing = 0): void
    {
        if (self::usedBytes($pdo) - $replacing + $incoming > (int) $limits['maxDatabaseBytes']) {
            throw new ApiError(507, 'This app has used all the storage it is allowed.');
        }
    }

    /**
     * One write, whole. BEGIN IMMEDIATE takes SQLite's write lock before the
     * first read, so the ownership and room a check finds are the ownership
     * and room the change lands on; a second writer waits (busy_timeout) and
     * then sees the committed result. A statement that fails rolls the whole
     * thing back, and a lock that could not be had in time is a 503 the
     * runtime retries, never a half-applied write.
     */
    private static function write(PDO $pdo, callable $fn): mixed
    {
        try {
            $pdo->exec('BEGIN IMMEDIATE');
        } catch (PDOException $e) {
            throw self::contention($e);
        }
        try {
            $out = $fn();
            $pdo->exec('COMMIT');
            return $out;
        } catch (Throwable $e) {
            try {
                $pdo->exec('ROLLBACK');
            } catch (Throwable) {
                // The connection is past helping; the original failure is the one to report.
            }
            throw $e instanceof PDOException ? self::contention($e) : $e;
        }
    }

    private static function contention(PDOException $e): Throwable
    {
        $message = $e->getMessage();
        if (str_contains($message, 'locked') || str_contains($message, 'busy')) {
            return new ApiError(503, "The app's storage is busy; try again in a moment.");
        }
        return $e;
    }

    /** The policies an app row declares, by collection name (`*` is the default). @return array<string, string> */
    public static function policiesOf(array $appRow): array
    {
        $decoded = json_decode((string) ($appRow['storage_policies'] ?? '{}'), true);
        if (!is_array($decoded)) return [];
        $out = [];
        foreach ($decoded as $name => $policy) {
            if (is_string($name) && is_string($policy) && in_array($policy, self::POLICIES, true)) $out[$name] = $policy;
        }
        return $out;
    }

    /**
     * One operation. `$op` is the body's `op`; the rest of the body is its
     * arguments. Every read and write is rate-limited per visitor per app.
     *
     * @param array<string, mixed> $body
     */
    public static function run(Request $req, string $slug, array $body): mixed
    {
        $op = is_string($body['op'] ?? null) ? $body['op'] : '';
        $visitor = Config::visitorHash($req->ip);
        $writes = ['insert', 'update', 'set', 'remove', 'clear', 'kvSet', 'kvRemove'];
        Db::rateLimit(in_array($op, $writes, true) ? 'storageWrite' : 'storageRead', "$visitor|$slug");
        $pdo = self::open($slug);
        $limits = Config::get('storage');
        // The quota is checked by each write, inside its transaction: see assertQuota.
        $ctx = self::actor($req, $slug);
        return match ($op) {
            'insert' => self::insert($pdo, $body, $limits, $ctx),
            'get' => self::get($pdo, $body, $ctx),
            'update' => self::update($pdo, $body, $limits, $ctx),
            'set' => self::set($pdo, $body, $limits, $ctx),
            'remove' => self::remove($pdo, $body, $ctx),
            'query' => self::query($pdo, $body, $limits, $ctx),
            'count' => self::count($pdo, $body, $ctx),
            'collections' => self::collections($pdo, $ctx),
            'clear' => self::clear($req, $slug, $pdo, $body),
            'kvGet' => self::kvGet($pdo, $body),
            'kvSet' => self::kvSet($pdo, $body, $limits),
            'kvRemove' => self::kvRemove($pdo, $body),
            default => throw new ApiError(400, "Unknown storage operation: $op"),
        };
    }

    // ── Who is asking, and what the collection allows ──────────────────────

    /**
     * The request's standing: the visitor's storage identity, if the runtime
     * sent a token; whether it carries the edit key or the admin key; and the
     * app's declared policies. The identity is the token hashed with the
     * site's salt and this app's slug, so one app's owners cannot be matched
     * with another's and the token itself is never written down.
     *
     * @return array{owner: ?string, publisher: bool, policies: array<string, string>}
     */
    private static function actor(Request $req, string $slug): array
    {
        $token = $req->header('x-visitor-token');
        $owner = is_string($token) && preg_match(self::TOKEN, $token) ? Config::visitorHash("storage|$slug|$token") : null;
        $app = Apps::row($slug);
        return ['owner' => $owner, 'publisher' => Apps::isOwner($req, $slug), 'policies' => self::policiesOf($app)];
    }

    private static function policy(array $ctx, string $collection): string
    {
        return $ctx['policies'][$collection] ?? $ctx['policies']['*'] ?? 'public';
    }

    private static function noToken(string $c): ApiError
    {
        return new ApiError(403, "Collection \"$c\" records who adds to it, and this request carries no visitor token. Open the app from the directory in a runtime that sends one.");
    }

    /** May this actor read from the collection at all? Private collections read only their own rows; see `own`. */
    private static function allowRead(array $ctx, string $c): void
    {
        $policy = self::policy($ctx, $c);
        if ($policy === 'publisher' && !$ctx['publisher']) throw new ApiError(403, "Collection \"$c\" is the publisher's: reading it needs the edit key.");
        if ($policy === 'private' && $ctx['owner'] === null) throw self::noToken($c);
    }

    /** May this actor add a record? */
    private static function allowAdd(array $ctx, string $c): void
    {
        $policy = self::policy($ctx, $c);
        if ($ctx['publisher'] && $policy !== 'private') return;
        if ($policy === 'publisher') throw new ApiError(403, "Collection \"$c\" is the publisher's: writing to it needs the edit key.");
        if (($policy === 'owner-write' || $policy === 'private') && $ctx['owner'] === null) throw self::noToken($c);
    }

    /**
     * May this actor change or remove this record? `$rowOwner` is who added
     * it, or null for a record from before policies or added without a token.
     */
    private static function allowModify(array $ctx, string $c, ?string $rowOwner): void
    {
        $policy = self::policy($ctx, $c);
        switch ($policy) {
            case 'public':
                return;
            case 'append-only':
                if ($ctx['publisher']) return;
                throw new ApiError(403, "Collection \"$c\" is append-only: records are changed or removed only with the edit key.");
            case 'publisher':
                if ($ctx['publisher']) return;
                throw new ApiError(403, "Collection \"$c\" is the publisher's: writing to it needs the edit key.");
            case 'owner-write':
                if ($ctx['publisher']) return;
                if ($ctx['owner'] === null) throw self::noToken($c);
                if ($rowOwner === null || !hash_equals($rowOwner, $ctx['owner'])) {
                    throw new ApiError(403, 'That record was added by someone else; only they, or the publisher, can change it.');
                }
                return;
            case 'private':
                // A private record that is not yours is one you cannot see, so
                // the answer is the same as for a record that does not exist.
                if ($ctx['owner'] === null) throw self::noToken($c);
                if ($rowOwner === null || !hash_equals($rowOwner, $ctx['owner'])) throw new ApiError(404, 'No such record.');
                return;
        }
    }

    /**
     * The SQL that keeps a read to what this actor may see: under `private`,
     * their own rows. Everything else sees the whole collection.
     * @return array{0: string, 1: array<int, string>}
     */
    private static function own(array $ctx, string $c): array
    {
        if (self::policy($ctx, $c) === 'private') return [' AND owner = ?', [(string) $ctx['owner']]];
        return ['', []];
    }

    // ── Records ────────────────────────────────────────────────────────────

    private static function collection(array $body): string
    {
        $c = $body['collection'] ?? null;
        if (!is_string($c) || !preg_match(self::COLLECTION, $c)) {
            throw new ApiError(400, 'A collection name is lowercase letters, digits and underscores, up to 32 characters, starting with a letter.');
        }
        return $c;
    }

    private static function id(array $body): string
    {
        $id = $body['id'] ?? null;
        if (is_int($id)) $id = (string) $id;
        if (!is_string($id) || !preg_match(self::KEY, $id)) throw new ApiError(400, 'A record id is up to 128 letters, digits, dots, colons, dashes or underscores.');
        return $id;
    }

    /** @return array<string, mixed> */
    private static function data(array $body, array $limits, string $field = 'data'): array
    {
        $d = $body[$field] ?? null;
        if (!is_array($d) || array_is_list($d) && $d !== []) throw new ApiError(400, "$field must be an object.");
        $encoded = json_encode($d, JSON_UNESCAPED_UNICODE);
        if ($encoded === false) throw new ApiError(400, "$field cannot be stored as JSON.");
        if (strlen($encoded) > (int) $limits['maxRecordBytes']) throw new ApiError(413, 'A record is at most ' . (int) ($limits['maxRecordBytes'] / 1024) . ' KB.');
        return $d;
    }

    /** A record's fields as a JSON object even when there are none: `{}`, never `[]`. */
    private static function obj(mixed $data): array|stdClass
    {
        return is_array($data) && $data !== [] ? $data : new stdClass();
    }

    /** A row as the app sees it. `mine` says whether this visitor added it, which is what an owner-write UI needs to know. */
    private static function record(array $row, array $ctx): array
    {
        $owner = $row['owner'] ?? null;
        return [
            'id' => $row['id'],
            'data' => self::obj(json_decode((string) $row['data'], true)),
            'createdAt' => (int) $row['created_at'],
            'updatedAt' => (int) $row['updated_at'],
            'mine' => is_string($owner) && $ctx['owner'] !== null && hash_equals($owner, $ctx['owner']),
        ];
    }

    private static function assertRoom(PDO $pdo, string $collection, array $limits): void
    {
        $exists = $pdo->prepare('SELECT 1 FROM records WHERE collection = ? LIMIT 1');
        $exists->execute([$collection]);
        if (!$exists->fetchColumn()) {
            $n = (int) $pdo->query('SELECT COUNT(DISTINCT collection) FROM records')->fetchColumn();
            if ($n >= (int) $limits['maxCollections']) throw new ApiError(400, 'This app has as many collections as it is allowed.');
        }
        $count = $pdo->prepare('SELECT COUNT(*) FROM records WHERE collection = ?');
        $count->execute([$collection]);
        if ((int) $count->fetchColumn() >= (int) $limits['maxRecordsPerCollection']) {
            throw new ApiError(400, 'This collection is full. Remove records to add more.');
        }
    }

    private static function insert(PDO $pdo, array $body, array $limits, array $ctx): array
    {
        $c = self::collection($body);
        self::allowAdd($ctx, $c);
        $data = self::data($body, $limits);
        $id = isset($body['id']) ? self::id($body) : self::newId();
        $encoded = json_encode($data, JSON_UNESCAPED_UNICODE);
        $now = time();
        return self::write($pdo, function () use ($pdo, $c, $id, $encoded, $now, $limits, $ctx, $data) {
            self::assertRoom($pdo, $c, $limits);
            self::assertQuota($pdo, $limits, strlen($c) + strlen($id) + strlen($encoded));
            try {
                $pdo->prepare('INSERT INTO records (collection, id, data, created_at, updated_at, owner) VALUES (?, ?, ?, ?, ?, ?)')
                    ->execute([$c, $id, $encoded, $now, $now, $ctx['owner']]);
            } catch (PDOException $e) {
                if (str_contains($e->getMessage(), 'UNIQUE')) throw new ApiError(409, 'A record with that id already exists.');
                throw $e;
            }
            return ['id' => $id, 'data' => self::obj($data), 'createdAt' => $now, 'updatedAt' => $now, 'mine' => $ctx['owner'] !== null];
        });
    }

    private static function get(PDO $pdo, array $body, array $ctx): ?array
    {
        $c = self::collection($body);
        self::allowRead($ctx, $c);
        [$ownSql, $ownParams] = self::own($ctx, $c);
        $stmt = $pdo->prepare("SELECT * FROM records WHERE collection = ? AND id = ?$ownSql");
        $stmt->execute(array_merge([$c, self::id($body)], $ownParams));
        $row = $stmt->fetch();
        return $row ? self::record($row, $ctx) : null;
    }

    /**
     * Change one record's fields in place. The UPDATE names the owner the
     * check saw as well as the id, and must change exactly one row: inside
     * BEGIN IMMEDIATE nothing can have moved, and if the count says otherwise
     * something has gone very wrong and the write is refused rather than
     * landing on a record the check never saw.
     */
    private static function update(PDO $pdo, array $body, array $limits, array $ctx): array
    {
        $c = self::collection($body);
        $id = self::id($body);
        $patch = self::data($body, $limits, 'data');
        return self::write($pdo, function () use ($pdo, $c, $id, $patch, $limits, $ctx) {
            $stmt = $pdo->prepare('SELECT * FROM records WHERE collection = ? AND id = ?');
            $stmt->execute([$c, $id]);
            $row = $stmt->fetch();
            if (!$row) throw new ApiError(404, 'No such record.');
            $owner = $row['owner'] ?? null;
            self::allowModify($ctx, $c, $owner);
            $merged = array_replace(json_decode((string) $row['data'], true) ?: [], $patch);
            $encoded = json_encode($merged, JSON_UNESCAPED_UNICODE);
            if ($encoded === false || strlen($encoded) > (int) $limits['maxRecordBytes']) {
                throw new ApiError(413, 'The updated record would be larger than a record may be.');
            }
            self::assertQuota($pdo, $limits, strlen($encoded), strlen((string) $row['data']));
            $now = time();
            self::changeOne($pdo, 'UPDATE records SET data = ?, updated_at = ? WHERE collection = ? AND id = ? AND owner IS ?', [$encoded, $now, $c, $id, $owner]);
            return self::record(['id' => $id, 'data' => $encoded, 'created_at' => $row['created_at'], 'updated_at' => $now, 'owner' => $owner], $ctx);
        });
    }

    /** Replace a record by id, creating it when absent. Adding follows the add rule, replacing the modify rule. */
    private static function set(PDO $pdo, array $body, array $limits, array $ctx): array
    {
        $c = self::collection($body);
        $id = self::id($body);
        $data = self::data($body, $limits);
        $encoded = json_encode($data, JSON_UNESCAPED_UNICODE);
        $now = time();
        return self::write($pdo, function () use ($pdo, $c, $id, $data, $encoded, $now, $limits, $ctx) {
            $stmt = $pdo->prepare('SELECT created_at, owner, LENGTH(data) AS bytes FROM records WHERE collection = ? AND id = ?');
            $stmt->execute([$c, $id]);
            $existing = $stmt->fetch();
            if ($existing === false) {
                self::allowAdd($ctx, $c);
                self::assertRoom($pdo, $c, $limits);
                self::assertQuota($pdo, $limits, strlen($c) + strlen($id) + strlen($encoded));
                $pdo->prepare('INSERT INTO records (collection, id, data, created_at, updated_at, owner) VALUES (?, ?, ?, ?, ?, ?)')
                    ->execute([$c, $id, $encoded, $now, $now, $ctx['owner']]);
                return ['id' => $id, 'data' => self::obj($data), 'createdAt' => $now, 'updatedAt' => $now, 'mine' => $ctx['owner'] !== null];
            }
            $owner = $existing['owner'] ?? null;
            self::allowModify($ctx, $c, $owner);
            self::assertQuota($pdo, $limits, strlen($encoded), (int) $existing['bytes']);
            // The record keeps whoever added it: replacing its fields is not adopting it.
            self::changeOne($pdo, 'UPDATE records SET data = ?, updated_at = ? WHERE collection = ? AND id = ? AND owner IS ?', [$encoded, $now, $c, $id, $owner]);
            return ['id' => $id, 'data' => self::obj($data), 'createdAt' => (int) $existing['created_at'], 'updatedAt' => $now,
                'mine' => is_string($owner) && $ctx['owner'] !== null && hash_equals($owner, $ctx['owner'])];
        });
    }

    private static function remove(PDO $pdo, array $body, array $ctx): array
    {
        $c = self::collection($body);
        $id = self::id($body);
        return self::write($pdo, function () use ($pdo, $c, $id, $ctx) {
            $stmt = $pdo->prepare('SELECT owner FROM records WHERE collection = ? AND id = ?');
            $stmt->execute([$c, $id]);
            $row = $stmt->fetch();
            if (!$row) return ['removed' => 0];
            $owner = $row['owner'] ?? null;
            self::allowModify($ctx, $c, $owner);
            self::changeOne($pdo, 'DELETE FROM records WHERE collection = ? AND id = ? AND owner IS ?', [$c, $id, $owner]);
            return ['removed' => 1];
        });
    }

    /**
     * Run a statement that must change exactly the one row the check
     * authorized. Any other count means the row is not what was checked, and
     * the authorization does not carry: the caller's transaction is rolled
     * back and the runtime is told to look again.
     */
    private static function changeOne(PDO $pdo, string $sql, array $params): void
    {
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        if ($stmt->rowCount() !== 1) {
            throw new ApiError(409, 'That record changed while this request was being checked; read it again and retry.');
        }
    }

    /**
     * The one query shape: an optional `where` of field conditions, an
     * `orderBy`, a `limit` and an `offset`. Fields are looked up inside the
     * JSON with json_extract; `_id`, `_created` and `_updated` are the row's
     * own columns.
     *
     * @return array{records: array<int, array<string, mixed>>, total: int, limit: int, offset: int}
     */
    private static function query(PDO $pdo, array $body, array $limits, array $ctx): array
    {
        $c = self::collection($body);
        self::allowRead($ctx, $c);
        [$ownSql, $ownParams] = self::own($ctx, $c);
        [$whereSql, $params] = self::where($body['where'] ?? null);
        $order = self::orderBy($body['orderBy'] ?? null);
        $limit = max(1, min((int) $limits['maxQueryLimit'], (int) ($body['limit'] ?? 50)));
        $offset = max(0, min(10000, (int) ($body['offset'] ?? 0)));
        $count = $pdo->prepare("SELECT COUNT(*) FROM records WHERE collection = ?$ownSql $whereSql");
        $count->execute(array_merge([$c], $ownParams, $params));
        $total = (int) $count->fetchColumn();
        $stmt = $pdo->prepare("SELECT * FROM records WHERE collection = ?$ownSql $whereSql ORDER BY $order LIMIT $limit OFFSET $offset");
        $stmt->execute(array_merge([$c], $ownParams, $params));
        return ['records' => array_map(fn($r) => self::record($r, $ctx), $stmt->fetchAll()), 'total' => $total, 'limit' => $limit, 'offset' => $offset];
    }

    private static function count(PDO $pdo, array $body, array $ctx): array
    {
        $c = self::collection($body);
        self::allowRead($ctx, $c);
        [$ownSql, $ownParams] = self::own($ctx, $c);
        [$whereSql, $params] = self::where($body['where'] ?? null);
        $count = $pdo->prepare("SELECT COUNT(*) FROM records WHERE collection = ?$ownSql $whereSql");
        $count->execute(array_merge([$c], $ownParams, $params));
        return ['count' => (int) $count->fetchColumn()];
    }

    /**
     * The collections this actor may read, with the counts they would see.
     * The listing used to be the whole table for everyone, which told a
     * visitor how many rows a publisher-only collection held and how many
     * private notes everybody else had written — metadata the record reads
     * were careful to withhold. A publisher's collection is not listed to a
     * visitor; a private one is listed with the visitor's own count, and not
     * at all without a token.
     */
    private static function collections(PDO $pdo, array $ctx): array
    {
        $rows = $pdo->query('SELECT collection, COUNT(*) AS n, MAX(updated_at) AS u FROM records GROUP BY collection ORDER BY collection')->fetchAll();
        $own = null;
        $out = [];
        foreach ($rows as $r) {
            $c = (string) $r['collection'];
            $policy = self::policy($ctx, $c);
            if ($policy === 'publisher' && !$ctx['publisher']) continue;
            if ($policy === 'private') {
                if ($ctx['owner'] === null) continue;
                $own ??= $pdo->prepare('SELECT COUNT(*), MAX(updated_at) FROM records WHERE collection = ? AND owner = ?');
                $own->execute([$c, $ctx['owner']]);
                [$n, $u] = $own->fetch(PDO::FETCH_NUM);
                $out[] = ['name' => $c, 'records' => (int) $n, 'updatedAt' => (int) $u];
                continue;
            }
            $out[] = ['name' => $c, 'records' => (int) $r['n'], 'updatedAt' => (int) $r['u']];
        }
        return ['collections' => $out];
    }

    private static function clear(Request $req, string $slug, PDO $pdo, array $body): array
    {
        Apps::requireOwner($req, $slug);
        $c = self::collection($body);
        $stmt = $pdo->prepare('DELETE FROM records WHERE collection = ?');
        $stmt->execute([$c]);
        return ['removed' => $stmt->rowCount()];
    }

    private static function column(string $field): string
    {
        return match ($field) {
            '_id' => 'id',
            '_created' => 'created_at',
            '_updated' => 'updated_at',
            default => "json_extract(data, '$." . $field . "')",
        };
    }

    private static function field(mixed $field): string
    {
        if (!is_string($field) || !(preg_match(self::FIELD, $field) || in_array($field, ['_id', '_created', '_updated'], true))) {
            throw new ApiError(400, 'A field name is letters, digits and underscores, with dots between nested names.');
        }
        return $field;
    }

    /** @return array{0: string, 1: array<int, mixed>} */
    private static function where(mixed $where): array
    {
        if ($where === null || $where === []) return ['', []];
        if (!is_array($where)) throw new ApiError(400, 'where must be an object of field conditions.');
        $clauses = [];
        $params = [];
        $n = 0;
        foreach ($where as $field => $cond) {
            if (++$n > 10) throw new ApiError(400, 'A query has at most ten conditions.');
            $col = self::column(self::field($field));
            $conds = is_array($cond) && !array_is_list($cond) ? $cond : ['eq' => $cond];
            foreach ($conds as $op => $value) {
                if (!in_array($op, self::OPS, true)) throw new ApiError(400, "Unknown condition: $op");
                switch ($op) {
                    case 'eq':
                        if ($value === null) { $clauses[] = "$col IS NULL"; break; }
                        $clauses[] = "$col = " . self::slot($value);
                        $params[] = self::scalar($value);
                        break;
                    case 'ne':
                        if ($value === null) { $clauses[] = "$col IS NOT NULL"; break; }
                        $clauses[] = "($col IS NULL OR $col != " . self::slot($value) . ')';
                        $params[] = self::scalar($value);
                        break;
                    case 'lt': case 'lte': case 'gt': case 'gte':
                        $sym = ['lt' => '<', 'lte' => '<=', 'gt' => '>', 'gte' => '>='][$op];
                        $clauses[] = "$col $sym " . self::slot($value);
                        $params[] = self::scalar($value);
                        break;
                    case 'in':
                        if (!is_array($value) || !array_is_list($value) || count($value) === 0 || count($value) > 50) throw new ApiError(400, 'in takes a list of up to fifty values.');
                        $clauses[] = "$col IN (" . implode(',', array_map([self::class, 'slot'], $value)) . ')';
                        foreach ($value as $v) $params[] = self::scalar($v);
                        break;
                    case 'contains':
                        if (!is_string($value)) throw new ApiError(400, 'contains takes a string.');
                        $clauses[] = "$col LIKE ? ESCAPE '\\'";
                        $params[] = '%' . addcslashes($value, '%_\\') . '%';
                        break;
                    case 'exists':
                        $clauses[] = $value ? "$col IS NOT NULL" : "$col IS NULL";
                        break;
                }
            }
        }
        return [$clauses ? ' AND ' . implode(' AND ', $clauses) : '', $params];
    }

    /**
     * The placeholder for a value. PDO binds every parameter as text, and
     * SQLite will not read text as a number against the untyped result of
     * json_extract — `score >= '120'` is false for a score of 120 — so a
     * number is cast on the way in.
     */
    private static function slot(mixed $v): string
    {
        return is_int($v) || is_float($v) || is_bool($v) ? 'CAST(? AS NUMERIC)' : '?';
    }

    private static function scalar(mixed $v): string|int|float
    {
        if (is_bool($v)) return $v ? 1 : 0;
        if (is_int($v) || is_float($v) || is_string($v)) return $v;
        throw new ApiError(400, 'A condition compares against a string, number or boolean.');
    }

    private static function orderBy(mixed $order): string
    {
        if ($order === null) return 'created_at DESC, id DESC';
        $list = is_string($order) ? [[$order, 'asc']] : $order;
        if (!is_array($list)) throw new ApiError(400, 'orderBy is a field name, a [field, direction] pair, or a list of pairs.');
        if (count($list) === 2 && is_string($list[0] ?? null) && is_string($list[1] ?? null)) $list = [$list];
        $parts = [];
        foreach ($list as $pair) {
            if (is_string($pair)) $pair = [$pair, 'asc'];
            if (!is_array($pair) || !is_string($pair[0] ?? null)) throw new ApiError(400, 'orderBy entries are [field, direction] pairs.');
            $dir = strtolower((string) ($pair[1] ?? 'asc')) === 'desc' ? 'DESC' : 'ASC';
            $parts[] = self::column(self::field($pair[0])) . " $dir";
            if (count($parts) >= 3) break;
        }
        $parts[] = 'id ASC';
        return implode(', ', $parts);
    }

    private static function newId(): string
    {
        return substr(strtr(base64_encode(random_bytes(9)), '+/', '-_'), 0, 12);
    }

    // ── Key-value ──────────────────────────────────────────────────────────

    private static function key(array $body): string
    {
        $k = $body['key'] ?? null;
        if (!is_string($k) || !preg_match(self::KEY, $k)) throw new ApiError(400, 'A key is up to 128 letters, digits, dots, colons, dashes or underscores.');
        return $k;
    }

    private static function kvGet(PDO $pdo, array $body): array
    {
        $stmt = $pdo->prepare('SELECT value, updated_at FROM kv WHERE key = ?');
        $stmt->execute([self::key($body)]);
        $row = $stmt->fetch();
        return ['value' => $row ? json_decode((string) $row['value'], true) : null, 'updatedAt' => $row ? (int) $row['updated_at'] : null];
    }

    private static function kvSet(PDO $pdo, array $body, array $limits): array
    {
        $key = self::key($body);
        if (!array_key_exists('value', $body)) throw new ApiError(400, 'value is required.');
        $encoded = json_encode($body['value'], JSON_UNESCAPED_UNICODE);
        if ($encoded === false || strlen($encoded) > (int) $limits['maxRecordBytes']) throw new ApiError(413, 'A value is at most ' . (int) ($limits['maxRecordBytes'] / 1024) . ' KB.');
        $now = time();
        return self::write($pdo, function () use ($pdo, $key, $encoded, $now, $limits, $body) {
            $existing = $pdo->prepare('SELECT LENGTH(key) + LENGTH(value) FROM kv WHERE key = ?');
            $existing->execute([$key]);
            $replacing = $existing->fetchColumn();
            if ($replacing === false) {
                $count = (int) $pdo->query('SELECT COUNT(*) FROM kv')->fetchColumn();
                if ($count >= (int) $limits['maxRecordsPerCollection']) throw new ApiError(400, 'The key-value store is full.');
            }
            self::assertQuota($pdo, $limits, strlen($key) + strlen($encoded), (int) $replacing);
            $pdo->prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')->execute([$key, $encoded, $now]);
            return ['value' => $body['value'], 'updatedAt' => $now];
        });
    }

    private static function kvRemove(PDO $pdo, array $body): array
    {
        $stmt = $pdo->prepare('DELETE FROM kv WHERE key = ?');
        $stmt->execute([self::key($body)]);
        return ['removed' => $stmt->rowCount()];
    }
}
