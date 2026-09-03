<?php
/**
 * The catalogue: publishing, versions, remixes, the listing and its search,
 * categories, thumbnails.
 *
 * Every published app is a row and a directory of immutable version files.
 * Publishing hands back an edit key; a new version, a metadata change or a
 * thumbnail needs it, and nothing else does. A remix is a new app that
 * remembers where it came from — that lineage is a first-class fact here,
 * because the point of a directory of sandboxed apps is that anyone can take
 * one apart and put it back together differently.
 */
declare(strict_types=1);

final class Apps
{
    private const SORTS = ['trending', 'newest', 'top', 'remixed', 'runs', 'name'];

    // ── Slugs ──────────────────────────────────────────────────────────────

    public static function slugify(string $name): string
    {
        $s = strtolower(trim($name));
        if (function_exists('iconv')) {
            $t = @iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $s);
            if (is_string($t) && $t !== '') $s = $t;
        }
        $s = preg_replace('/[^a-z0-9]+/', '-', $s) ?? '';
        $s = trim($s, '-');
        if ($s === '') $s = 'app';
        return substr($s, 0, 48);
    }

    private static function uniqueSlug(string $base): string
    {
        $pdo = Db::catalog();
        $stmt = $pdo->prepare('SELECT 1 FROM apps WHERE slug = ?');
        $slug = $base;
        for ($n = 2; $n < 1000; $n++) {
            $stmt->execute([$slug]);
            if (!$stmt->fetchColumn()) return $slug;
            $slug = substr($base, 0, 44) . '-' . $n;
        }
        throw new ApiError(500, 'Could not find a free name for the app.');
    }

    /** A slug as a visitor typed it into a URL: the manifest name works too. */
    public static function resolveSlug(string $given): string
    {
        $given = trim($given);
        $pdo = Db::catalog();
        $stmt = $pdo->prepare('SELECT slug FROM apps WHERE slug = ?');
        $stmt->execute([$given]);
        $found = $stmt->fetchColumn();
        if (is_string($found)) return $found;
        $stmt->execute([self::slugify($given)]);
        $found = $stmt->fetchColumn();
        if (is_string($found)) return $found;
        $byName = $pdo->prepare('SELECT slug FROM apps WHERE name = ? COLLATE NOCASE AND hidden = 0 ORDER BY created_at LIMIT 1');
        $byName->execute([$given]);
        $found = $byName->fetchColumn();
        if (is_string($found)) return $found;
        throw new ApiError(404, 'No app is published under that name.');
    }

    // ── Rows ───────────────────────────────────────────────────────────────

    /** @return array<string, mixed> */
    public static function row(string $slug, bool $includeHidden = false): array
    {
        $stmt = Db::catalog()->prepare('SELECT * FROM apps WHERE slug = ?');
        $stmt->execute([$slug]);
        $row = $stmt->fetch();
        if (!$row || (!$includeHidden && (int) $row['hidden'] === 1)) throw new ApiError(404, 'No app is published under that name.');
        return $row;
    }

    public static function dir(string $slug): string
    {
        $dir = Config::dataDir() . '/apps/' . $slug;
        if (!is_dir($dir) && !@mkdir($dir, 0775, true)) throw new ApiError(500, 'Could not create the app\'s directory.');
        return $dir;
    }

    /** @return array<string, mixed> */
    public static function version(string $slug, ?int $version = null): array
    {
        $pdo = Db::catalog();
        if ($version === null) {
            $stmt = $pdo->prepare('SELECT * FROM versions WHERE slug = ? ORDER BY version DESC LIMIT 1');
            $stmt->execute([$slug]);
        } else {
            $stmt = $pdo->prepare('SELECT * FROM versions WHERE slug = ? AND version = ?');
            $stmt->execute([$slug, $version]);
        }
        $row = $stmt->fetch();
        if (!$row) throw new ApiError(404, 'That version does not exist.');
        return $row;
    }

    // ── Presentation ───────────────────────────────────────────────────────

    /** @param array<string, mixed> $row @return array<string, mixed> */
    public static function card(array $row): array
    {
        $slug = (string) $row['slug'];
        $bundle = "/api/apps/$slug/bundle.softn";
        $count = (int) $row['rating_count'];
        $parent = null;
        if (!empty($row['parent_slug'])) {
            $p = Db::catalog()->prepare('SELECT slug, name FROM apps WHERE slug = ?');
            $p->execute([$row['parent_slug']]);
            $pr = $p->fetch();
            if ($pr) $parent = ['slug' => $pr['slug'], 'name' => $pr['name']];
        }
        return [
            'slug' => $slug,
            'name' => (string) $row['name'],
            'description' => (string) $row['description'],
            'author' => (string) $row['author'],
            'category' => (string) $row['category'],
            'tags' => json_decode((string) $row['tags'], true) ?: [],
            'capabilities' => json_decode((string) $row['capabilities'], true) ?: [],
            'execution' => (string) $row['execution'],
            'version' => (int) $row['latest_version'],
            'size' => (int) $row['size'],
            'primary' => $row['primary_color'] ?: null,
            // Versioned by the last update, so a replaced picture is never the
            // cached one: the images are served with a ten-minute max-age.
            'thumbnail' => "/api/apps/$slug/thumbnail?v=" . (int) $row['updated_at'],
            'thumbnailKind' => $row['thumb'] ? 'image' : ($row['icon'] ? 'icon' : 'placeholder'),
            'icon' => $row['icon'] ? "/api/apps/$slug/icon?v=" . (int) $row['updated_at'] : null,
            'runs' => (int) $row['runs'],
            'remixes' => (int) $row['remixes'],
            'rating' => ['average' => $count > 0 ? round((int) $row['rating_sum'] / $count, 2) : 0, 'count' => $count],
            'comments' => (int) $row['comments'],
            'parent' => $parent,
            'source' => (string) $row['source'],
            'createdAt' => gmdate('c', (int) $row['created_at']),
            'updatedAt' => gmdate('c', (int) $row['updated_at']),
            'urls' => [
                'page' => "/app/$slug",
                'run' => "/web/app/$slug",
                'bundle' => $bundle,
                'download' => "$bundle?download=1",
                'studio' => '/studio/?open=' . rawurlencode($bundle),
                'builder' => '/builder/?open=' . rawurlencode($bundle),
                'remix' => "/publish?remix=$slug",
            ],
        ];
    }

    /** @param array<string, mixed> $row @return array<string, mixed> */
    public static function detail(array $row): array
    {
        $slug = (string) $row['slug'];
        $pdo = Db::catalog();
        $card = self::card($row);
        $v = $pdo->prepare('SELECT version, size, sha256, manifest_version, notes, created_at FROM versions WHERE slug = ? ORDER BY version DESC');
        $v->execute([$slug]);
        $versions = [];
        foreach ($v->fetchAll() as $r) {
            $versions[] = [
                'version' => (int) $r['version'],
                'manifestVersion' => (string) $r['manifest_version'],
                'size' => (int) $r['size'],
                'sha256' => (string) $r['sha256'],
                'notes' => (string) $r['notes'],
                'createdAt' => gmdate('c', (int) $r['created_at']),
                'bundle' => "/api/apps/$slug/bundle.softn?v=" . (int) $r['version'],
            ];
        }
        $dist = $pdo->prepare('SELECT stars, COUNT(*) AS n FROM ratings WHERE slug = ? GROUP BY stars');
        $dist->execute([$slug]);
        $breakdown = [1 => 0, 2 => 0, 3 => 0, 4 => 0, 5 => 0];
        foreach ($dist->fetchAll() as $r) $breakdown[(int) $r['stars']] = (int) $r['n'];
        $kids = $pdo->prepare('SELECT slug, name, author, created_at FROM apps WHERE parent_slug = ? AND hidden = 0 ORDER BY created_at DESC LIMIT 12');
        $kids->execute([$slug]);
        $remixes = [];
        foreach ($kids->fetchAll() as $r) {
            $remixes[] = ['slug' => $r['slug'], 'name' => $r['name'], 'author' => $r['author'], 'createdAt' => gmdate('c', (int) $r['created_at'])];
        }
        $lineage = [];
        $cur = $row['parent_slug'] ?? null;
        $hops = 0;
        while (is_string($cur) && $cur !== '' && $hops++ < 8) {
            $p = $pdo->prepare('SELECT slug, name, author, parent_slug FROM apps WHERE slug = ?');
            $p->execute([$cur]);
            $pr = $p->fetch();
            if (!$pr) break;
            $lineage[] = ['slug' => $pr['slug'], 'name' => $pr['name'], 'author' => $pr['author']];
            $cur = $pr['parent_slug'];
        }
        $card['versions'] = $versions;
        $card['ratingBreakdown'] = $breakdown;
        $card['remixList'] = $remixes;
        $card['lineage'] = $lineage;
        $card['storage'] = Storage::summary($slug);
        $card['manifest'] = self::manifestSummary($slug, (int) $row['latest_version']);
        return $card;
    }

    /** The parts of the manifest worth showing: entry file and the file counts by kind. */
    private static function manifestSummary(string $slug, int $version): ?array
    {
        try {
            $ver = self::version($slug, $version);
            $zip = new ZipArchive();
            if ($zip->open(self::dir($slug) . '/' . $ver['file'], ZipArchive::RDONLY) !== true) return null;
            $text = $zip->getFromName('manifest.json');
            $zip->close();
            $m = is_string($text) ? json_decode($text, true) : null;
            if (!is_array($m)) return null;
            $files = is_array($m['files'] ?? null) ? $m['files'] : [];
            $counts = [];
            foreach ($files as $kind => $list) {
                if (is_array($list)) $counts[(string) $kind] = count($list);
            }
            return [
                'main' => is_string($m['main'] ?? null) ? $m['main'] : null,
                'version' => is_string($m['version'] ?? null) ? $m['version'] : null,
                'files' => $counts,
            ];
        } catch (Throwable) {
            return null;
        }
    }

    // ── Listing ────────────────────────────────────────────────────────────

    /** @param array<string, string> $q @return array<string, mixed> */
    public static function list(array $q): array
    {
        $pdo = Db::catalog();
        $search = Text::clean($q['q'] ?? '', 80);
        $category = Text::clean($q['category'] ?? '', 40);
        $tag = strtolower(Text::clean($q['tag'] ?? '', 24));
        $author = Text::clean($q['author'] ?? '', 40);
        $sort = in_array($q['sort'] ?? '', self::SORTS, true) ? $q['sort'] : ($search !== '' ? 'relevance' : 'trending');
        $perPage = max(1, min(48, (int) ($q['perPage'] ?? 24)));
        $page = max(1, min(500, (int) ($q['page'] ?? 1)));

        $where = ['a.hidden = 0'];
        $params = [];
        if ($category !== '' && $category !== 'all') {
            $where[] = 'a.category = :category';
            $params[':category'] = $category;
        }
        if ($tag !== '') {
            $where[] = "EXISTS (SELECT 1 FROM json_each(a.tags) WHERE json_each.value = :tag)";
            $params[':tag'] = $tag;
        }
        if ($author !== '') {
            $where[] = 'a.author = :author COLLATE NOCASE';
            $params[':author'] = $author;
        }
        // What an app may reach, as the visitor filters for it: nothing at
        // all, no network, its own server storage, or an off-main-thread script.
        $cap = Text::clean($q['cap'] ?? '', 16);
        if ($cap === 'none') {
            $where[] = "json_array_length(a.capabilities) = 0";
        } elseif ($cap === 'nonet') {
            $where[] = "NOT EXISTS (SELECT 1 FROM json_each(a.capabilities) WHERE json_each.value = 'net')";
        } elseif ($cap === 'storage') {
            $where[] = "EXISTS (SELECT 1 FROM json_each(a.capabilities) WHERE json_each.value = 'storage')";
        } elseif ($cap === 'worker') {
            $where[] = "a.execution = 'worker'";
        }
        $join = '';
        $relevance = '0';
        if ($search !== '') {
            if (Db::hasFts()) {
                // FTS5 wants its own name on the left of MATCH, never an alias.
                $join = 'JOIN apps_fts ON apps_fts.slug = a.slug';
                $where[] = 'apps_fts MATCH :match';
                $params[':match'] = self::ftsQuery($search);
                $relevance = 'bm25(apps_fts)';
            } else {
                $where[] = "(a.name LIKE :like ESCAPE '\\' OR a.description LIKE :like ESCAPE '\\' OR a.tags LIKE :like ESCAPE '\\' OR a.author LIKE :like ESCAPE '\\')";
                $params[':like'] = '%' . addcslashes($search, '%_\\') . '%';
            }
        }
        $since = time() - 7 * 86400;
        $runs7 = '(SELECT COALESCE(SUM(count), 0) FROM runs_daily r WHERE r.slug = a.slug AND r.day >= ' . (int) floor($since / 86400) . ')';
        $order = match ($sort) {
            'newest' => 'a.created_at DESC',
            'top' => '(CASE WHEN a.rating_count > 0 THEN a.rating_sum * 1.0 / a.rating_count ELSE 0 END) DESC, a.rating_count DESC, a.runs DESC',
            'remixed' => 'a.remixes DESC, a.runs DESC',
            'runs' => 'a.runs DESC',
            'name' => 'a.name COLLATE NOCASE ASC',
            'relevance' => "$relevance ASC, a.runs DESC",
            default => "($runs7 * 3 + a.remixes * 5 + a.rating_count * 2 + a.comments + CASE WHEN a.created_at > $since THEN 4 ELSE 0 END) DESC, a.runs DESC, a.created_at DESC",
        };
        $whereSql = implode(' AND ', $where);
        $count = $pdo->prepare("SELECT COUNT(*) FROM apps a $join WHERE $whereSql");
        $count->execute($params);
        $total = (int) $count->fetchColumn();
        $stmt = $pdo->prepare("SELECT a.* FROM apps a $join WHERE $whereSql ORDER BY $order LIMIT :limit OFFSET :offset");
        foreach ($params as $k => $v) $stmt->bindValue($k, $v);
        $stmt->bindValue(':limit', $perPage, PDO::PARAM_INT);
        $stmt->bindValue(':offset', ($page - 1) * $perPage, PDO::PARAM_INT);
        $stmt->execute();
        $apps = array_map([self::class, 'card'], $stmt->fetchAll());
        return [
            'apps' => $apps,
            'page' => $page,
            'perPage' => $perPage,
            'total' => $total,
            'pages' => max(1, (int) ceil($total / $perPage)),
            'sort' => $sort,
            'query' => $search,
            'category' => $category,
        ];
    }

    /** A visitor's words as an FTS5 query: each word a prefix, none of them syntax. */
    private static function ftsQuery(string $search): string
    {
        $words = preg_split('/\s+/u', $search) ?: [];
        $terms = [];
        foreach ($words as $w) {
            $w = preg_replace('/[^\p{L}\p{N}]+/u', '', $w) ?? '';
            if ($w === '') continue;
            $terms[] = '"' . str_replace('"', '', $w) . '"*';
            if (count($terms) >= 8) break;
        }
        return $terms ? implode(' ', $terms) : '""';
    }

    private static function indexForSearch(string $slug): void
    {
        if (!Db::hasFts()) return;
        $pdo = Db::catalog();
        $row = self::row($slug, true);
        $pdo->prepare('DELETE FROM apps_fts WHERE slug = ?')->execute([$slug]);
        $tags = implode(' ', json_decode((string) $row['tags'], true) ?: []);
        $pdo->prepare('INSERT INTO apps_fts (slug, name, description, tags, author) VALUES (?, ?, ?, ?, ?)')
            ->execute([$slug, $row['name'], $row['description'], $tags, $row['author']]);
    }

    // ── Publishing ─────────────────────────────────────────────────────────

    /**
     * Publish a bundle as a new app. `$opts` are the visitor's fields; the
     * bundle's own manifest fills whatever they left out.
     *
     * @param array<string, mixed> $opts
     * @return array{app: array<string, mixed>, editKey: string|null}
     */
    public static function create(string $bundlePath, array $opts, string $source = 'upload', ?string $parentSlug = null): array
    {
        $info = Bundle::inspect($bundlePath);
        $name = Text::clean($opts['name'] ?? '', 64) ?: $info['name'];
        $description = Text::clean($opts['description'] ?? '', 600, true) ?: $info['description'];
        $author = Text::clean($opts['author'] ?? '', 40) ?: (self::authorFromManifest($info['manifest']) ?? 'Anonymous');
        $category = Categories::resolve(Text::clean($opts['category'] ?? '', 40));
        $tags = Text::tags($opts['tags'] ?? null);
        $notes = Text::clean($opts['notes'] ?? '', 400, true);
        $primary = self::color($opts['primary'] ?? null) ?? self::color($info['manifest']['config']['theme']['primary'] ?? null);

        $pdo = Db::catalog();
        // A seed names its own slug: the id the site already uses for that demo.
        $wanted = is_string($opts['slug'] ?? null) && $opts['slug'] !== '' ? self::slugify($opts['slug']) : self::slugify($name);
        $slug = self::uniqueSlug($wanted);
        $dir = self::dir($slug);
        $file = 'v1.softn';
        if (!@copy($bundlePath, "$dir/$file")) throw new ApiError(500, 'Could not store the bundle.');
        $icon = self::storeIcon($dir, $info['icon']);
        $editKey = $source === 'seed' ? null : bin2hex(random_bytes(20));
        $now = time();
        $rootSlug = null;
        if ($parentSlug !== null) {
            $parent = self::row($parentSlug);
            $rootSlug = $parent['root_slug'] ?: $parent['slug'];
        }
        $pdo->beginTransaction();
        try {
            $pdo->prepare(<<<'SQL'
INSERT INTO apps (slug, name, description, author, category, tags, parent_slug, root_slug, latest_version, capabilities, execution,
  thumb, icon, primary_color, edit_key_hash, source, size, created_at, updated_at)
VALUES (:slug, :name, :description, :author, :category, :tags, :parent, :root, 1, :capabilities, :execution,
  NULL, :icon, :primary, :hash, :source, :size, :now, :now)
SQL)->execute([
                ':slug' => $slug, ':name' => $name, ':description' => $description, ':author' => $author,
                ':category' => $category, ':tags' => json_encode($tags), ':parent' => $parentSlug, ':root' => $rootSlug,
                ':capabilities' => json_encode($info['capabilities']), ':execution' => $info['execution'],
                ':icon' => $icon, ':primary' => $primary, ':hash' => $editKey === null ? null : hash('sha256', $editKey),
                ':source' => $source, ':size' => $info['size'], ':now' => $now,
            ]);
            $pdo->prepare('INSERT INTO versions (slug, version, file, size, sha256, manifest_version, notes, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?)')
                ->execute([$slug, $file, $info['size'], $info['sha256'], $info['version'], $notes, $now]);
            if ($parentSlug !== null) {
                $pdo->prepare('UPDATE apps SET remixes = remixes + 1 WHERE slug = ?')->execute([$parentSlug]);
            }
            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
        self::indexForSearch($slug);
        return ['app' => self::card(self::row($slug)), 'editKey' => $editKey];
    }

    /** @return array<string, mixed> */
    public static function addVersion(string $slug, string $bundlePath, ?string $notes): array
    {
        $row = self::row($slug, true);
        $info = Bundle::inspect($bundlePath);
        $pdo = Db::catalog();
        $next = (int) $row['latest_version'] + 1;
        if ($next > (int) Config::get('maxVersionsPerApp', 50)) throw new ApiError(400, 'This app has reached its version limit.');
        $dir = self::dir($slug);
        $file = "v$next.softn";
        if (!@copy($bundlePath, "$dir/$file")) throw new ApiError(500, 'Could not store the bundle.');
        $icon = self::storeIcon($dir, $info['icon']) ?? $row['icon'];
        $now = time();
        $pdo->beginTransaction();
        try {
            $pdo->prepare('INSERT INTO versions (slug, version, file, size, sha256, manifest_version, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                ->execute([$slug, $next, $file, $info['size'], $info['sha256'], $info['version'], Text::clean($notes, 400, true), $now]);
            $pdo->prepare('UPDATE apps SET latest_version = ?, capabilities = ?, execution = ?, icon = ?, size = ?, updated_at = ? WHERE slug = ?')
                ->execute([$next, json_encode($info['capabilities']), $info['execution'], $icon, $info['size'], $now, $slug]);
            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
        return self::detail(self::row($slug, true));
    }

    /** @param array<string, mixed> $fields @return array<string, mixed> */
    public static function patch(string $slug, array $fields): array
    {
        $row = self::row($slug, true);
        $sets = [];
        $params = [':slug' => $slug];
        if (isset($fields['name'])) {
            $name = Text::clean((string) $fields['name'], 64);
            if ($name === '') throw new ApiError(400, 'The name cannot be empty.');
            $sets[] = 'name = :name';
            $params[':name'] = $name;
        }
        if (isset($fields['description'])) {
            $sets[] = 'description = :description';
            $params[':description'] = Text::clean((string) $fields['description'], 600, true);
        }
        if (isset($fields['author'])) {
            $sets[] = 'author = :author';
            $params[':author'] = Text::clean((string) $fields['author'], 40) ?: 'Anonymous';
        }
        if (isset($fields['category'])) {
            $sets[] = 'category = :category';
            $params[':category'] = Categories::resolve(Text::clean((string) $fields['category'], 40));
        }
        if (array_key_exists('tags', $fields)) {
            $sets[] = 'tags = :tags';
            $params[':tags'] = json_encode(Text::tags(is_array($fields['tags']) ? json_encode($fields['tags']) : (string) $fields['tags']));
        }
        if (isset($fields['primary'])) {
            $sets[] = 'primary_color = :primary';
            $params[':primary'] = self::color((string) $fields['primary']);
        }
        if (array_key_exists('hidden', $fields)) {
            $sets[] = 'hidden = :hidden';
            $params[':hidden'] = $fields['hidden'] ? 1 : 0;
        }
        if (!$sets) return self::detail($row);
        $sets[] = 'updated_at = :now';
        $params[':now'] = time();
        Db::catalog()->prepare('UPDATE apps SET ' . implode(', ', $sets) . ' WHERE slug = :slug')->execute($params);
        self::indexForSearch($slug);
        return self::detail(self::row($slug, true));
    }

    /** @param array{0: string, 1: string} $image */
    public static function setThumbnail(string $slug, array $image): void
    {
        [$bytes, $mime] = $image;
        $dir = self::dir($slug);
        foreach (glob("$dir/thumb.*") ?: [] as $old) @unlink($old);
        $file = 'thumb.' . Images::extension($mime);
        if (file_put_contents("$dir/$file", $bytes, LOCK_EX) === false) throw new ApiError(500, 'Could not store the thumbnail.');
        Db::catalog()->prepare('UPDATE apps SET thumb = ?, updated_at = ? WHERE slug = ?')->execute([$file, time(), $slug]);
    }

    public static function remove(string $slug): void
    {
        $pdo = Db::catalog();
        $pdo->prepare('DELETE FROM apps WHERE slug = ?')->execute([$slug]);
        $pdo->prepare('DELETE FROM versions WHERE slug = ?')->execute([$slug]);
        $pdo->prepare('DELETE FROM comments WHERE slug = ?')->execute([$slug]);
        $pdo->prepare('DELETE FROM ratings WHERE slug = ?')->execute([$slug]);
        $pdo->prepare('DELETE FROM runs_daily WHERE slug = ?')->execute([$slug]);
        if (Db::hasFts()) $pdo->prepare('DELETE FROM apps_fts WHERE slug = ?')->execute([$slug]);
        $dir = Config::dataDir() . '/apps/' . $slug;
        if (is_dir($dir)) {
            foreach (glob("$dir/*") ?: [] as $f) @unlink($f);
            @rmdir($dir);
        }
    }

    /**
     * The edit key, or the admin key, or nothing. A seeded app has no edit key
     * and belongs to the site.
     */
    public static function requireOwner(Request $req, string $slug): void
    {
        if (Config::isAdmin($req->header('x-admin-key') ?? $req->field('adminKey'))) return;
        $row = self::row($slug, true);
        $presented = $req->header('x-edit-key') ?? $req->field('editKey');
        $hash = $row['edit_key_hash'];
        if (!is_string($presented) || $presented === '' || !is_string($hash) || !hash_equals($hash, hash('sha256', $presented))) {
            throw new ApiError(403, 'That needs the edit key this app was published with.');
        }
    }

    /** @param array<string, mixed> $manifest */
    private static function authorFromManifest(array $manifest): ?string
    {
        $a = $manifest['author'] ?? null;
        if (is_string($a)) return Text::clean($a, 40) ?: null;
        if (is_array($a) && is_string($a['name'] ?? null)) return Text::clean($a['name'], 40) ?: null;
        return null;
    }

    private static function color(mixed $value): ?string
    {
        if (!is_string($value)) return null;
        $value = trim($value);
        return preg_match('/^#[0-9a-fA-F]{6}$/', $value) ? strtolower($value) : null;
    }

    /** @param array{0: string, 1: string}|null $icon */
    private static function storeIcon(string $dir, ?array $icon): ?string
    {
        if ($icon === null) return null;
        [$bytes, $mime] = $icon;
        foreach (glob("$dir/icon.*") ?: [] as $old) @unlink($old);
        $file = 'icon.' . Images::extension($mime);
        if (file_put_contents("$dir/$file", $bytes, LOCK_EX) === false) return null;
        return $file;
    }

    // ── Images ─────────────────────────────────────────────────────────────

    public static function thumbnailResponse(string $slug): Response
    {
        $row = self::row($slug);
        $dir = Config::dataDir() . '/apps/' . $slug;
        $cache = ['Cache-Control' => 'public, max-age=600'];
        foreach ([$row['thumb'], $row['icon']] as $file) {
            if (is_string($file) && $file !== '' && is_file("$dir/$file")) {
                $ext = pathinfo($file, PATHINFO_EXTENSION);
                return Response::file("$dir/$file", Images::mimeForExtension($ext), $cache + ['ETag' => '"' . md5_file("$dir/$file") . '"']);
            }
        }
        return Response::bytes(self::placeholderSvg((string) $row['name'], $row['primary_color'] ?: null), 'image/svg+xml', $cache);
    }

    public static function iconResponse(string $slug): Response
    {
        $row = self::row($slug);
        $dir = Config::dataDir() . '/apps/' . $slug;
        $file = $row['icon'];
        if (is_string($file) && $file !== '' && is_file("$dir/$file")) {
            return Response::file("$dir/$file", Images::mimeForExtension(pathinfo($file, PATHINFO_EXTENSION)), ['Cache-Control' => 'public, max-age=600']);
        }
        return Response::bytes(self::placeholderSvg((string) $row['name'], $row['primary_color'] ?: null, true), 'image/svg+xml', ['Cache-Control' => 'public, max-age=600']);
    }

    /** A card for an app that brought no picture: its initials on a colour derived from its name. */
    public static function placeholderSvg(string $name, ?string $primary, bool $square = false): string
    {
        $hue = hexdec(substr(md5($name), 0, 2)) * 360 / 255;
        $bg = $primary ?? sprintf('hsl(%d, 48%%, 42%%)', (int) $hue);
        $bg2 = $primary ? self::shade($primary, -0.25) : sprintf('hsl(%d, 52%%, 24%%)', (int) $hue);
        $words = preg_split('/\s+/u', trim($name)) ?: [];
        $initials = '';
        foreach ($words as $w) {
            if ($w === '') continue;
            $initials .= mb_strtoupper(mb_substr($w, 0, 1));
            if (mb_strlen($initials) >= 2) break;
        }
        $initials = htmlspecialchars($initials ?: '?', ENT_QUOTES | ENT_XML1);
        $w = $square ? 256 : 640;
        $h = $square ? 256 : 400;
        $fs = $square ? 112 : 160;
        return <<<SVG
<svg xmlns="http://www.w3.org/2000/svg" width="$w" height="$h" viewBox="0 0 $w $h" role="img">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="$bg"/><stop offset="1" stop-color="$bg2"/></linearGradient></defs>
<rect width="$w" height="$h" fill="url(#g)"/>
<text x="50%" y="50%" dy="0.36em" text-anchor="middle" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-weight="800" font-size="$fs" fill="rgba(255,255,255,0.92)">$initials</text>
</svg>
SVG;
    }

    private static function shade(string $hex, float $amount): string
    {
        $r = hexdec(substr($hex, 1, 2));
        $g = hexdec(substr($hex, 3, 2));
        $b = hexdec(substr($hex, 5, 2));
        $f = fn(int $c): int => max(0, min(255, (int) round($c * (1 + $amount))));
        return sprintf('#%02x%02x%02x', $f((int) $r), $f((int) $g), $f((int) $b));
    }
}

final class Categories
{
    /** The categories the site starts with. A visitor can suggest more. */
    private const CORE = [
        ['games', 'Games', 'Things to play', '🎮', 10],
        ['tools', 'Tools', 'Utilities that do one job well', '🧰', 20],
        ['creative', 'Creative', 'Drawing, music, generators', '🎨', 30],
        ['productivity', 'Productivity', 'Notes, planners, trackers', '📝', 40],
        ['education', 'Learning', 'Teach, quiz, explain', '📚', 50],
        ['ai', 'AI', 'Apps that run a model', '🤖', 60],
        ['experiments', 'Experiments', 'Trying something out', '🧪', 70],
        ['demos', 'Examples', 'Sample apps that show what SoftN can do, not things to rely on', '🧩', 80],
        ['other', 'Other', 'Everything else', '📦', 90],
    ];

    public static function ensure(): void
    {
        // Once a request: the core rows are written in, and a core row whose
        // wording changed in a release is brought up to date, so a rename here
        // reaches a database that was seeded by an older version.
        static $done = false;
        if ($done) return;
        $done = true;
        $pdo = Db::catalog();
        $ins = $pdo->prepare(<<<'SQL'
INSERT INTO categories (id, name, description, emoji, status, sort, created_at) VALUES (?, ?, ?, ?, 'core', ?, ?)
ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, emoji = excluded.emoji, sort = excluded.sort
WHERE categories.status = 'core'
SQL);
        foreach (self::CORE as [$id, $name, $desc, $emoji, $sort]) $ins->execute([$id, $name, $desc, $emoji, $sort, time()]);
    }

    /** @return array<int, array<string, mixed>> */
    public static function all(bool $includeHidden = false): array
    {
        self::ensure();
        $pdo = Db::catalog();
        $rows = $pdo->query("SELECT c.*, (SELECT COUNT(*) FROM apps a WHERE a.category = c.id AND a.hidden = 0) AS app_count FROM categories c ORDER BY CASE c.status WHEN 'core' THEN 0 WHEN 'approved' THEN 0 ELSE 1 END, c.sort, c.name")->fetchAll();
        $out = [];
        foreach ($rows as $r) {
            if (!$includeHidden && $r['status'] === 'hidden') continue;
            $out[] = [
                'id' => $r['id'],
                'name' => $r['name'],
                'description' => $r['description'],
                'emoji' => $r['emoji'],
                'status' => $r['status'],
                'suggested' => $r['status'] === 'suggested',
                'apps' => (int) $r['app_count'],
            ];
        }
        return $out;
    }

    /** A category id the visitor gave, or 'other'. */
    public static function resolve(string $given): string
    {
        self::ensure();
        if ($given === '') return 'other';
        $id = Apps::slugify($given);
        $stmt = Db::catalog()->prepare("SELECT id FROM categories WHERE (id = ? OR name = ? COLLATE NOCASE) AND status != 'hidden'");
        $stmt->execute([$id, $given]);
        $found = $stmt->fetchColumn();
        return is_string($found) ? $found : 'other';
    }

    /**
     * A visitor's suggestion. It becomes usable at once, marked as suggested,
     * so an app can be filed under it today; the site owner approves, renames
     * or hides it later with the admin key.
     *
     * @return array<string, mixed>
     */
    public static function suggest(string $name, string $description, string $emoji): array
    {
        self::ensure();
        $name = Text::clean($name, 32);
        if (mb_strlen($name) < 2) throw new ApiError(400, 'A category name needs at least two characters.');
        $id = Apps::slugify($name);
        $pdo = Db::catalog();
        $existing = $pdo->prepare('SELECT id FROM categories WHERE id = ? OR name = ? COLLATE NOCASE');
        $existing->execute([$id, $name]);
        $found = $existing->fetchColumn();
        if (is_string($found)) return self::one($found);
        $total = (int) $pdo->query('SELECT COUNT(*) FROM categories')->fetchColumn();
        if ($total >= 200) throw new ApiError(400, 'There are already as many categories as the directory will hold.');
        $emoji = Text::clean($emoji, 4);
        if ($emoji !== '' && !preg_match('/^\p{So}\p{M}*(\x{200D}\p{So}\p{M}*)*$/u', $emoji)) $emoji = '';
        $pdo->prepare("INSERT INTO categories (id, name, description, emoji, status, sort, created_at) VALUES (?, ?, ?, ?, 'suggested', 500, ?)")
            ->execute([$id, $name, Text::clean($description, 120), $emoji ?: '🏷️', time()]);
        return self::one($id);
    }

    /** @return array<string, mixed> */
    public static function one(string $id): array
    {
        foreach (self::all(true) as $c) {
            if ($c['id'] === $id) return $c;
        }
        throw new ApiError(404, 'No such category.');
    }

    /** @param array<string, mixed> $fields @return array<string, mixed> */
    public static function update(string $id, array $fields): array
    {
        self::one($id);
        $pdo = Db::catalog();
        if (isset($fields['status']) && in_array($fields['status'], ['core', 'approved', 'suggested', 'hidden'], true)) {
            $pdo->prepare('UPDATE categories SET status = ? WHERE id = ?')->execute([$fields['status'], $id]);
        }
        if (isset($fields['name'])) {
            $name = Text::clean((string) $fields['name'], 32);
            if ($name !== '') $pdo->prepare('UPDATE categories SET name = ? WHERE id = ?')->execute([$name, $id]);
        }
        if (isset($fields['description'])) {
            $pdo->prepare('UPDATE categories SET description = ? WHERE id = ?')->execute([Text::clean((string) $fields['description'], 120), $id]);
        }
        if (isset($fields['emoji'])) {
            $pdo->prepare('UPDATE categories SET emoji = ? WHERE id = ?')->execute([Text::clean((string) $fields['emoji'], 4), $id]);
        }
        if (isset($fields['sort'])) {
            $pdo->prepare('UPDATE categories SET sort = ? WHERE id = ?')->execute([(int) $fields['sort'], $id]);
        }
        return self::one($id);
    }
}
