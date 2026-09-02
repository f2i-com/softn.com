<?php
/**
 * Each published app's own data: a SQLite file of its own, created the first
 * time the app asks for it, behind an API small enough to police.
 *
 * The app never sees SQL. It has collections of JSON records and a key-value
 * store, and the host translates those into queries here — which is what
 * makes quotas, row limits, query bounds and field validation enforceable,
 * and what keeps one app's careless SELECT from being everybody's problem.
 * Anybody running the app can read and write (a high-score table is the
 * canonical use, and a score comes from whoever just played); clearing a
 * collection is the publisher's alone.
 */
declare(strict_types=1);

final class Storage
{
    private const COLLECTION = '/^[a-z][a-z0-9_]{0,31}$/';
    private const FIELD = '/^[A-Za-z_][A-Za-z0-9_]{0,63}(\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,3}$/';
    private const KEY = '/^[A-Za-z0-9_.:\-]{1,128}$/';
    private const OPS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'contains', 'exists'];

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
        return $open[$slug] = $pdo;
    }

    /** What the app page shows: how much this app keeps on the server. */
    public static function summary(string $slug): array
    {
        $path = self::path($slug);
        if (!is_file($path)) return ['collections' => 0, 'records' => 0, 'keys' => 0, 'bytes' => 0];
        $pdo = self::open($slug);
        return [
            'collections' => (int) $pdo->query('SELECT COUNT(DISTINCT collection) FROM records')->fetchColumn(),
            'records' => (int) $pdo->query('SELECT COUNT(*) FROM records')->fetchColumn(),
            'keys' => (int) $pdo->query('SELECT COUNT(*) FROM kv')->fetchColumn(),
            'bytes' => (int) filesize($path),
        ];
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
        if (in_array($op, $writes, true) && $op !== 'remove' && $op !== 'clear' && $op !== 'kvRemove') {
            $path = self::path($slug);
            if (is_file($path) && filesize($path) > (int) $limits['maxDatabaseBytes']) {
                throw new ApiError(507, 'This app has used all the storage it is allowed.');
            }
        }
        return match ($op) {
            'insert' => self::insert($pdo, $body, $limits),
            'get' => self::get($pdo, $body),
            'update' => self::update($pdo, $body, $limits),
            'set' => self::set($pdo, $body, $limits),
            'remove' => self::remove($pdo, $body),
            'query' => self::query($pdo, $body, $limits),
            'count' => self::count($pdo, $body),
            'collections' => self::collections($pdo),
            'clear' => self::clear($req, $slug, $pdo, $body),
            'kvGet' => self::kvGet($pdo, $body),
            'kvSet' => self::kvSet($pdo, $body, $limits),
            'kvRemove' => self::kvRemove($pdo, $body),
            default => throw new ApiError(400, "Unknown storage operation: $op"),
        };
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

    private static function record(array $row): array
    {
        return [
            'id' => $row['id'],
            'data' => self::obj(json_decode((string) $row['data'], true)),
            'createdAt' => (int) $row['created_at'],
            'updatedAt' => (int) $row['updated_at'],
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

    private static function insert(PDO $pdo, array $body, array $limits): array
    {
        $c = self::collection($body);
        $data = self::data($body, $limits);
        self::assertRoom($pdo, $c, $limits);
        $id = isset($body['id']) ? self::id($body) : self::newId();
        $now = time();
        try {
            $pdo->prepare('INSERT INTO records (collection, id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
                ->execute([$c, $id, json_encode($data, JSON_UNESCAPED_UNICODE), $now, $now]);
        } catch (PDOException $e) {
            if (str_contains($e->getMessage(), 'UNIQUE')) throw new ApiError(409, 'A record with that id already exists.');
            throw $e;
        }
        return ['id' => $id, 'data' => self::obj($data), 'createdAt' => $now, 'updatedAt' => $now];
    }

    private static function get(PDO $pdo, array $body): ?array
    {
        $stmt = $pdo->prepare('SELECT * FROM records WHERE collection = ? AND id = ?');
        $stmt->execute([self::collection($body), self::id($body)]);
        $row = $stmt->fetch();
        return $row ? self::record($row) : null;
    }

    private static function update(PDO $pdo, array $body, array $limits): array
    {
        $c = self::collection($body);
        $id = self::id($body);
        $patch = self::data($body, $limits, 'data');
        $pdo->beginTransaction();
        try {
            $stmt = $pdo->prepare('SELECT * FROM records WHERE collection = ? AND id = ?');
            $stmt->execute([$c, $id]);
            $row = $stmt->fetch();
            if (!$row) {
                $pdo->rollBack();
                throw new ApiError(404, 'No such record.');
            }
            $merged = array_replace(json_decode((string) $row['data'], true) ?: [], $patch);
            $encoded = json_encode($merged, JSON_UNESCAPED_UNICODE);
            if ($encoded === false || strlen($encoded) > (int) $limits['maxRecordBytes']) {
                $pdo->rollBack();
                throw new ApiError(413, 'The updated record would be larger than a record may be.');
            }
            $now = time();
            $pdo->prepare('UPDATE records SET data = ?, updated_at = ? WHERE collection = ? AND id = ?')->execute([$encoded, $now, $c, $id]);
            $pdo->commit();
            return ['id' => $id, 'data' => self::obj($merged), 'createdAt' => (int) $row['created_at'], 'updatedAt' => $now];
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
    }

    /** Replace a record by id, creating it when absent. */
    private static function set(PDO $pdo, array $body, array $limits): array
    {
        $c = self::collection($body);
        $id = self::id($body);
        $data = self::data($body, $limits);
        $now = time();
        $stmt = $pdo->prepare('SELECT created_at FROM records WHERE collection = ? AND id = ?');
        $stmt->execute([$c, $id]);
        $created = $stmt->fetchColumn();
        if ($created === false) self::assertRoom($pdo, $c, $limits);
        $pdo->prepare('INSERT INTO records (collection, id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
            ->execute([$c, $id, json_encode($data, JSON_UNESCAPED_UNICODE), $now, $now]);
        return ['id' => $id, 'data' => self::obj($data), 'createdAt' => $created === false ? $now : (int) $created, 'updatedAt' => $now];
    }

    private static function remove(PDO $pdo, array $body): array
    {
        $stmt = $pdo->prepare('DELETE FROM records WHERE collection = ? AND id = ?');
        $stmt->execute([self::collection($body), self::id($body)]);
        return ['removed' => $stmt->rowCount()];
    }

    /**
     * The one query shape: an optional `where` of field conditions, an
     * `orderBy`, a `limit` and an `offset`. Fields are looked up inside the
     * JSON with json_extract; `_id`, `_created` and `_updated` are the row's
     * own columns.
     *
     * @return array{records: array<int, array<string, mixed>>, total: int, limit: int, offset: int}
     */
    private static function query(PDO $pdo, array $body, array $limits): array
    {
        $c = self::collection($body);
        [$whereSql, $params] = self::where($body['where'] ?? null);
        $order = self::orderBy($body['orderBy'] ?? null);
        $limit = max(1, min((int) $limits['maxQueryLimit'], (int) ($body['limit'] ?? 50)));
        $offset = max(0, min(10000, (int) ($body['offset'] ?? 0)));
        $count = $pdo->prepare("SELECT COUNT(*) FROM records WHERE collection = ? $whereSql");
        $count->execute(array_merge([$c], $params));
        $total = (int) $count->fetchColumn();
        $stmt = $pdo->prepare("SELECT * FROM records WHERE collection = ? $whereSql ORDER BY $order LIMIT $limit OFFSET $offset");
        $stmt->execute(array_merge([$c], $params));
        return ['records' => array_map([self::class, 'record'], $stmt->fetchAll()), 'total' => $total, 'limit' => $limit, 'offset' => $offset];
    }

    private static function count(PDO $pdo, array $body): array
    {
        $c = self::collection($body);
        [$whereSql, $params] = self::where($body['where'] ?? null);
        $count = $pdo->prepare("SELECT COUNT(*) FROM records WHERE collection = ? $whereSql");
        $count->execute(array_merge([$c], $params));
        return ['count' => (int) $count->fetchColumn()];
    }

    private static function collections(PDO $pdo): array
    {
        $rows = $pdo->query('SELECT collection, COUNT(*) AS n, MAX(updated_at) AS u FROM records GROUP BY collection ORDER BY collection')->fetchAll();
        return ['collections' => array_map(fn($r) => ['name' => $r['collection'], 'records' => (int) $r['n'], 'updatedAt' => (int) $r['u']], $rows)];
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
        $count = (int) $pdo->query('SELECT COUNT(*) FROM kv')->fetchColumn();
        $exists = $pdo->prepare('SELECT 1 FROM kv WHERE key = ?');
        $exists->execute([$key]);
        if (!$exists->fetchColumn() && $count >= (int) $limits['maxRecordsPerCollection']) throw new ApiError(400, 'The key-value store is full.');
        $now = time();
        $pdo->prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')->execute([$key, $encoded, $now]);
        return ['value' => $body['value'], 'updatedAt' => $now];
    }

    private static function kvRemove(PDO $pdo, array $body): array
    {
        $stmt = $pdo->prepare('DELETE FROM kv WHERE key = ?');
        $stmt->execute([self::key($body)]);
        return ['removed' => $stmt->rowCount()];
    }
}
