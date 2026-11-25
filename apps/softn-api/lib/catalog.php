<?php
declare(strict_types=1);

/**
 * What the catalogue spends its time on, for this request: the wait for
 * the lock, how long it was held, the boot that reads every folder, the
 * bundles the cache had to inspect again, and the metadata files committed.
 * /api/health reports its own request's numbers; with `debugTimings` in the
 * configuration every response carries them as a Server-Timing header,
 * which is what scripts/bench/catalog-bench.mjs reads. Milliseconds from
 * hrtime, so a benchmark can add them up without reading the code. This is
 * measurement, not policy: nothing here changes what the catalogue does.
 */
final class Timings
{
    /** @var array<string, array{ms: float, n: int}> */
    private static array $t = [];
    private static ?int $acquired = null;
    private static int $apps = 0;

    /** Record the time since `$startNs` (from hrtime) under `$name`, and one more occurrence. */
    public static function add(string $name, int $startNs): void {
        $e = self::$t[$name] ?? ['ms' => 0.0, 'n' => 0];
        $e['ms'] += (hrtime(true) - $startNs) / 1e6; $e['n']++;
        self::$t[$name] = $e;
    }
    public static function acquired(): void { self::$acquired = hrtime(true); }
    public static function released(): void { if (self::$acquired !== null) { self::add('hold', self::$acquired); self::$acquired = null; } }
    public static function apps(int $n): void { self::$apps = $n; }
    /** One more bundle re-read by the periodic sweep rather than by a change. */
    public static function swept(): void { self::$swept++; }
    private static int $swept = 0;
    /**
     * What a request should stay under on a healthy host, from the 1,000-app
     * benchmark after the round-2 fix (apps/softn-api/bench/results-2026-09-11.json;
     * the README's "Thresholds" section says how they were chosen). A probe
     * compares its own request's `lockWaitMs`, `lockHoldMs` and
     * `rebuild.count` against these; the numbers describe that machine, and
     * an operator on a slower host should measure and set their own with
     * `timingThresholds` in data/config.json. No alerting lives here.
     */
    public const THRESHOLDS = ['lockWaitMsP95' => 1000.0, 'lockHoldMsP95' => 350.0, 'warmRebuildCount' => 0];
    /** @return array<string, float|int> */
    public static function thresholds(): array {
        $out = self::THRESHOLDS;
        try {
            $set = Config::get('timingThresholds', null);
            if (is_array($set)) foreach ($out as $k => $v) if (isset($set[$k]) && is_numeric($set[$k])) $out[$k] = is_int($v) ? (int) $set[$k] : (float) $set[$k];
        } catch (Throwable) {
            // The configuration's trouble is reported by the route; the defaults stand.
        }
        return $out;
    }
    private static function ms(string $name): float { return round(self::$t[$name]['ms'] ?? 0.0, 3); }
    private static function n(string $name): int { return self::$t[$name]['n'] ?? 0; }
    /** The lock hold so far: what was released plus, if it is held now, since when. */
    private static function holdMs(): float {
        $now = self::$acquired === null ? 0.0 : (hrtime(true) - self::$acquired) / 1e6;
        return round((self::$t['hold']['ms'] ?? 0.0) + $now, 3);
    }
    /** @return array<string, mixed> */
    public static function snapshot(): array {
        return [
            'lockWaitMs' => self::ms('lock'), 'lockHoldMs' => self::holdMs(), 'bootMs' => self::ms('boot'),
            'rebuild' => ['count' => self::n('rebuild'), 'ms' => self::ms('rebuild'), 'swept' => self::$swept],
            'commit' => ['count' => self::n('commit'), 'ms' => self::ms('commit')],
            'apps' => self::$apps,
            'thresholds' => self::thresholds(),
        ];
    }
    /** The same as a Server-Timing header value (W3C Server Timing). */
    public static function header(): string {
        $s = self::snapshot();
        $plural = static fn(int $n, string $w): string => "$n $w" . ($n === 1 ? '' : 's');
        return sprintf('lock;dur=%.3f, hold;dur=%.3f, boot;dur=%.3f, rebuild;dur=%.3f;desc="%s", commit;dur=%.3f;desc="%s", apps;desc="%d"',
            $s['lockWaitMs'], $s['lockHoldMs'], $s['bootMs'], $s['rebuild']['ms'], $plural($s['rebuild']['count'], 'bundle'),
            $s['commit']['ms'], $plural($s['commit']['count'], 'file'), $s['apps']);
    }
}

/** Folder catalogue. JSON is authoritative; the bundle cache can be deleted. */
final class Catalog
{
    private static $lock = null;
    private static bool $ready = false;
    private static array $docs = [];
    /** slug => relative path under data/apps/ (e.g. "games/3d/blockscape" or legacy "test-snake"). */
    private static array $paths = [];
    /** categoryId ("games" or "games/3d") => category.json metadata & folder path. */
    private static array $folderCategories = [];
    /** Whether data/apps/ contains any category/subcategory tree folders. */
    private static bool $hasCategorizedTree = false;
    /** Slugs discovered during boot that have a bundle but no thumb.* file yet. */
    private static array $missingThumbs = [];
    private static array $cache = [];
    private static bool $cacheDirty = false;
    /** all()'s answer for this request, built once; put() and remove() drop it. */
    private static ?array $rows = null;
    /**
     * How many bundles the periodic sweep may still re-read in this request.
     * The safety net for a bundle replaced with its size and timestamps
     * intact (which the API's own writes never do): a bundle whose last
     * inspection is older than `cacheSweepSeconds` (600) is read again, at
     * most `cacheSweepBatch` (200) of them per request, so a large catalogue
     * spreads its sweep over requests instead of holding the lock for all
     * of it. Before this, every bundle whose stamp was five seconds old was
     * re-read, which under load meant all of them on every request.
     */
    private static int $sweepBudget = 0;
    private static int $sweepSeconds = 600;
    /** slug => why the folder was skipped this boot; its files are untouched. */
    private static array $skipped = [];
    /** Runtime subdirectories inside an app folder that are never category/app folders. */
    private const APP_INTERNAL_DIRS = ['backend-cache' => true, 'backend-data' => true];
    /** Known main category folder names recognized automatically even before category.json exists. */
    private const KNOWN_MAIN_CATEGORIES = [
        'business' => true, 'games' => true, 'simulations' => true, 'tools' => true,
        'creative' => true, 'productivity' => true, 'education' => true, 'ai' => true,
        'experiments' => true, 'demos' => true, 'other' => true, 'story' => true, 'strategy' => true,
    ];

    public static function validSlug(string $slug): bool { return (bool) preg_match('/^[a-z0-9][a-z0-9-]{0,63}$/D', $slug); }
    public static function validCategoryPath(string $catPath): bool {
        $parts = explode('/', $catPath);
        if (count($parts) < 1 || count($parts) > 2) return false;
        foreach ($parts as $p) if (!self::validSlug($p)) return false;
        return true;
    }
    public static function relPath(string $slug): string {
        if (!self::validSlug($slug)) throw new ApiError(400, 'Invalid app folder name.');
        return self::$paths[$slug] ?? $slug;
    }
    public static function path(string $slug): string {
        if (!self::validSlug($slug)) throw new ApiError(400, 'Invalid app folder name.');
        $rel = self::$paths[$slug] ?? $slug;
        $path = Config::dataDir() . '/apps/' . $rel;
        if (is_link($path)) throw new ApiError(400, 'App folders must not be symlinks.');
        return $path;
    }
    /** @return array<string, string> slug => absolute app directory path */
    public static function allPaths(): array {
        $root = Config::dataDir() . '/apps/';
        $out = [];
        foreach (self::$paths as $slug => $rel) $out[(string) $slug] = $root . $rel;
        return $out;
    }
    /** Whether a folder already exists anywhere in the catalogue for `$slug`. */
    public static function hasFolder(string $slug): bool {
        if (!self::validSlug($slug)) return false;
        if (isset(self::$paths[$slug]) || isset(self::$docs[$slug]) || isset(self::$skipped[$slug])) return true;
        return is_dir(Config::dataDir() . '/apps/' . $slug);
    }
    /** Discovered folder-based category & subcategory metadata (id => record). */
    public static function folderCategories(): array {
        self::boot();
        return self::$folderCategories;
    }
    /** Whether new apps should be placed inside data/apps/<category>/[<subcategory>/]<slug>/. */
    public static function usesCategorizedLayout(?string $category = null, ?string $subcategory = null): bool {
        $mode = strtolower((string) Config::get('folderLayout', 'auto'));
        if ($mode === 'categorized') return true;
        if ($mode === 'flat') return false;
        if (self::$hasCategorizedTree) return true;
        if (is_string($category) && $category !== '' && self::validSlug($category)) {
            if (is_file(Config::dataDir() . "/apps/$category/category.json")) return true;
        }
        return false;
    }
    /** Allocate the on-disk folder path for a new app based on layout mode and category/subcategory. */
    public static function allocateDir(string $slug, string $category, ?string $subcategory = null): string {
        if (!self::validSlug($slug)) throw new ApiError(400, 'Invalid app folder name.');
        $root = Config::dataDir() . '/apps';
        if (self::usesCategorizedLayout($category, $subcategory) && self::validSlug($category)) {
            self::$hasCategorizedTree = true;
            $catDir = "$root/$category";
            if (!is_dir($catDir) && !@mkdir($catDir, 0775, true) && !is_dir($catDir)) {
                throw new ApiError(500, 'Could not create category directory.');
            }
            self::ensureCategoryMeta($category, null, $catDir);
            if (is_string($subcategory) && $subcategory !== '' && self::validSlug($subcategory)) {
                $subDir = "$catDir/$subcategory";
                if (!is_dir($subDir) && !@mkdir($subDir, 0775, true) && !is_dir($subDir)) {
                    throw new ApiError(500, 'Could not create subcategory directory.');
                }
                self::ensureCategoryMeta($category, $subcategory, $subDir);
                self::$paths[$slug] = "$category/$subcategory/$slug";
            } else {
                self::$paths[$slug] = "$category/$slug";
            }
        } else {
            self::$paths[$slug] = $slug;
        }
        return "$root/" . self::$paths[$slug];
    }
    /** Move an app folder when its category or subcategory changes under categorized layout. */
    public static function moveAppFolder(string $slug, string $newCategory, ?string $newSubcategory = null): void {
        self::boot();
        if (!isset(self::$paths[$slug])) return;
        $currentRel = self::$paths[$slug];
        $alreadyNested = str_contains($currentRel, '/');
        if (!$alreadyNested && !self::usesCategorizedLayout($newCategory, $newSubcategory)) return;
        if (!self::validSlug($newCategory)) return;
        $sub = (is_string($newSubcategory) && $newSubcategory !== '' && self::validSlug($newSubcategory)) ? $newSubcategory : null;
        $targetRel = $sub !== null ? "$newCategory/$sub/$slug" : "$newCategory/$slug";
        if ($targetRel === $currentRel) return;

        $root = Config::dataDir() . '/apps';
        $from = "$root/$currentRel";
        $to = "$root/$targetRel";
        if (!is_dir($from) || is_link($from) || file_exists($to)) return;

        $catDir = "$root/$newCategory";
        if (!is_dir($catDir) && !@mkdir($catDir, 0775, true) && !is_dir($catDir)) return;
        self::ensureCategoryMeta($newCategory, null, $catDir);
        if ($sub !== null) {
            $subDir = "$catDir/$sub";
            if (!is_dir($subDir) && !@mkdir($subDir, 0775, true) && !is_dir($subDir)) return;
            self::ensureCategoryMeta($newCategory, $sub, $subDir);
        }

        $quiet = @fopen(Config::dataDir() . '/storage.lock', 'c');
        if ($quiet !== false) flock($quiet, LOCK_EX);
        try {
            if (!@rename($from, $to)) return;
            self::$paths[$slug] = $targetRel;
            self::$hasCategorizedTree = true;
            // Re-key bundle cache entries so warm inspection does not re-read bundles.
            $oldPrefix = "$currentRel/";
            $newPrefix = "$targetRel/";
            $updatedCache = false;
            foreach (array_keys(self::$cache) as $k) {
                if (str_starts_with((string) $k, $oldPrefix)) {
                    $newKey = $newPrefix . substr((string) $k, strlen($oldPrefix));
                    self::$cache[$newKey] = self::$cache[$k];
                    unset(self::$cache[$k]);
                    $updatedCache = true;
                }
            }
            if ($updatedCache) {
                try { self::writeJson(Config::dataDir() . '/cache/bundles.json', self::$cache); } catch (Throwable) {}
            }
        } finally {
            if ($quiet !== false) { flock($quiet, LOCK_UN); fclose($quiet); }
        }
        self::syncCategoryCaches();
    }
    /** A stable lock inode, outside app directories, protects read-modify-write.
     * Held until response generation ends; never delete or replace this file. */
    public static function boot(): void {
        if (self::$ready) return;
        // A request that let the catalogue go (Storage::leaveCatalogue) holds
        // the stores' lock, and a backup or a retirement takes the two in the
        // other order: catalogue, then stores. Coming back for the catalogue
        // from here is how the two would wait on each other for good, with
        // nothing to say so but a request that never ends. It is a mistake in
        // the handler, and is refused where it is made.
        if (class_exists('Storage', false) && Storage::outsideCatalogue()) {
            throw new LogicException('The catalogue was let go for this request and cannot be taken again.');
        }
        $root = Config::dataDir();
        $waiting = hrtime(true);
        self::$lock = fopen("$root/catalog.lock", 'c');
        if (!self::$lock || !flock(self::$lock, LOCK_EX)) throw new ApiError(503, 'The directory is busy.');
        Timings::add('lock', $waiting); Timings::acquired();
        self::$ready = true;
        register_shutdown_function([self::class, 'release']);
        $booting = hrtime(true);
        try {
            if (!is_dir("$root/apps") && !mkdir("$root/apps", 0775, true)) throw new ApiError(503, 'Cannot create apps folder.');
            try { self::migrateLegacy(); }
            catch (Throwable $e) { error_log('softn-api: legacy import did not complete and will retry on the next request: ' . $e->getMessage()); }
            self::$cache = self::readJson("$root/cache/bundles.json", true);
            self::$sweepSeconds = max(1, (int) Config::get('cacheSweepSeconds', 600));
            self::$sweepBudget = max(0, (int) Config::get('cacheSweepBatch', 200));
            self::scanAppsTree("$root/apps");
            foreach (array_keys(self::$cache) as $key) if (!is_file("$root/apps/$key")) { unset(self::$cache[$key]); self::$cacheDirty = true; }
            if (self::$cacheDirty) { try { self::writeJson("$root/cache/bundles.json", self::$cache); } catch (Throwable $e) { error_log('softn-api: bundle cache could not be written'); } }
            Timings::apps(count(self::$docs) + count(self::$skipped));
            self::maybeScheduleAutoThumbs();
        } catch (Throwable $e) {
            self::release();
            throw $e;
        } finally {
            Timings::add('boot', $booting);
        }
    }

    /**
     * Scan data/apps/ supporting both structured category/subcategory trees
     * (`data/apps/<category>/[<subcategory>/]<slug>/`) and legacy flat folders
     * (`data/apps/<slug>/`), plus drag-and-drop loose `.softn` files at any level.
     */
    private static function scanAppsTree(string $appsRoot): void {
        $knownMains = self::KNOWN_MAIN_CATEGORIES;
        try {
            foreach (self::readJson(Config::dataDir() . '/categories.json', true) as $cid => $row) {
                if (is_string($cid) && self::validSlug($cid) && empty($row['parent'])) $knownMains[$cid] = true;
            }
        } catch (Throwable) {}

        $dropped = [];
        // Loose .softn files dropped directly in data/apps/
        foreach (self::looseBundles($appsRoot) as $bundlePath) {
            $dropped[] = [$bundlePath, null, null];
        }

        foreach (scandir($appsRoot) ?: [] as $entry) {
            if (!self::validSlug($entry)) continue;
            $dir = "$appsRoot/$entry";
            if (is_link($dir) || !is_dir($dir)) continue;

            if (!self::isCategoryFolder($entry, $dir, $knownMains)) {
                self::registerAppDir($entry, $entry, null, null);
                continue;
            }

            // Depth 1: Main category folder (data/apps/<category>/)
            self::$hasCategorizedTree = true;
            $cat = $entry;
            self::ensureCategoryMeta($cat, null, $dir);

            foreach (self::looseBundles($dir) as $bundlePath) {
                $dropped[] = [$bundlePath, $cat, null];
            }

            foreach (scandir($dir) ?: [] as $child) {
                if (!self::validSlug($child) || isset(self::APP_INTERNAL_DIRS[$child])) continue;
                $childDir = "$dir/$child";
                if (is_link($childDir) || !is_dir($childDir)) continue;

                if (!self::isSubcategoryFolder($cat, $child, $childDir)) {
                    // Depth 2: App directly inside main category (data/apps/<category>/<slug>/)
                    self::registerAppDir($child, "$cat/$child", $cat, null);
                    continue;
                }

                // Depth 2: Subcategory folder (data/apps/<category>/<subcategory>/)
                $sub = $child;
                self::ensureCategoryMeta($cat, $sub, $childDir);

                foreach (self::looseBundles($childDir) as $bundlePath) {
                    $dropped[] = [$bundlePath, $cat, $sub];
                }

                // Depth 3: Apps inside subcategory (data/apps/<category>/<subcategory>/<slug>/)
                foreach (scandir($childDir) ?: [] as $appSlug) {
                    if (!self::validSlug($appSlug) || isset(self::APP_INTERNAL_DIRS[$appSlug])) continue;
                    $appDir = "$childDir/$appSlug";
                    if (is_link($appDir) || !is_dir($appDir)) continue;
                    self::registerAppDir($appSlug, "$cat/$sub/$appSlug", $cat, $sub);
                }
            }
        }

        // Adopt any dragged-and-dropped loose .softn files after scanning existing apps
        // so updates to an existing app automatically increment its version suffix (v2.softn, v3.softn...).
        foreach ($dropped as [$bundlePath, $cat, $sub]) {
            try {
                self::adoptDroppedBundle($bundlePath, $cat, $sub);
            } catch (Throwable $e) {
                error_log('softn-api: could not adopt dropped bundle ' . basename($bundlePath) . ': ' . $e->getMessage());
            }
        }

        if (self::$hasCategorizedTree && self::$folderCategories !== []) {
            self::syncCategoryCaches();
        }
    }

    /** @return list<string> */
    private static function looseBundles(string $dir): array {
        $out = [];
        foreach (scandir($dir) ?: [] as $name) {
            if ($name === '.' || $name === '..' || str_starts_with($name, '.')) continue;
            if (!preg_match('/^[a-zA-Z0-9][a-zA-Z0-9 ._-]*\.softn$/D', $name)) continue;
            $full = "$dir/$name";
            if (!is_link($full) && is_file($full)) $out[] = $full;
        }
        natsort($out);
        return array_values($out);
    }

    /** Whether `$dir` contains any non-runtime subdirectories (ignoring backend-cache / backend-data / dotfiles). */
    private static function hasChildDirs(string $dir): bool {
        foreach (scandir($dir) ?: [] as $name) {
            if ($name === '.' || $name === '..' || str_starts_with($name, '.') || isset(self::APP_INTERNAL_DIRS[$name])) continue;
            $full = "$dir/$name";
            if (!is_link($full) && is_dir($full) && self::validSlug($name)) return true;
        }
        return false;
    }

    /** @param array<string, true> $knownMains */
    private static function isCategoryFolder(string $name, string $dir, array $knownMains): bool {
        // An existing app folder (`app.json`) MUST NEVER be reclassified as a category folder,
        // even if an orphan/colliding `category.json` exists inside it.
        if (is_file("$dir/app.json")) return false;
        if (is_file("$dir/category.json")) return true;
        if (self::hasChildDirs($dir)) return true;
        // A legacy flat app folder with v1.softn directly inside stays an app folder even if named after a category.
        foreach (self::looseBundles($dir) as $b) {
            if (preg_match('/^v[1-9][0-9]*\.softn$/D', basename($b))) return false;
        }
        return isset($knownMains[$name]);
    }

    private static function isSubcategoryFolder(string $cat, string $name, string $dir): bool {
        if (is_file("$dir/app.json")) return false;
        if (is_file("$dir/category.json")) return true;
        if (self::hasChildDirs($dir)) return true;
        $bundles = self::looseBundles($dir);
        if ($bundles === []) return true;
        foreach ($bundles as $b) {
            $base = basename($b);
            if (preg_match('/^v[1-9][0-9]*\.softn$/D', $base)) return false;
            if (strtolower($base) === 'bundle.softn') return false;
            $stem = self::stripVersionSuffix(preg_replace('/\.softn$/i', '', $base) ?? $base);
            if (self::slugifyFilename($stem) === $name) return false;
        }
        return true;
    }

    private static function registerAppDir(string $slug, string $relPath, ?string $folderCategory, ?string $folderSubcategory): void {
        if (isset(self::$paths[$slug])) {
            error_log("softn-api: duplicate app slug $slug at $relPath (already loaded from " . self::$paths[$slug] . '); skipped');
            return;
        }
        self::$paths[$slug] = $relPath;
        // One folder's trouble is that folder's alone: a malformed or
        // invalid app.json, an unreadable bundle or an unwritable
        // directory skips the app, logs why, leaves its files exactly
        // as they are, and the rest of the directory is served. The
        // folder still occupies its slug, so nothing publishes over it.
        try {
            self::load($slug, $folderCategory, $folderSubcategory);
        } catch (Throwable $e) {
            unset(self::$docs[$slug]);
            self::$skipped[$slug] = $e->getMessage();
            error_log("softn-api: skipping app folder $relPath: " . $e->getMessage());
        }
    }

    private static function stripVersionSuffix(string $raw): string {
        return preg_replace('/(?:[-_ ]+v?[0-9]+(?:\.[0-9]+)*)+$/i', '', trim($raw)) ?? trim($raw);
    }

    private static function slugifyFilename(string $raw): string {
        $s = strtolower(trim($raw));
        $s = preg_replace('/[^a-z0-9]+/', '-', $s) ?? '';
        $s = substr(trim($s, '-'), 0, 48);
        return $s === '' ? 'app' : $s;
    }

    private static function titleFromSlug(string $slug): string {
        $parts = array_filter(explode('-', $slug), static fn($p) => $p !== '');
        if ($parts === []) return 'Category';
        return implode(' ', array_map(static fn($p) => strlen($p) <= 2 && ctype_alnum($p) ? strtoupper($p) : ucfirst($p), $parts));
    }

    /** Ensure category.json metadata is loaded in memory (and prepared for auto-creation). */
    private static function ensureCategoryMeta(string $cat, ?string $sub, string $dir): void {
        $id = $sub !== null ? "$cat/$sub" : $cat;
        $slug = $sub ?? $cat;
        $file = "$dir/category.json";
        $existing = is_file($file) ? self::readJson($file, true) : [];
        $defaults = class_exists('Categories', false) ? Categories::defaultMetaFor($id) : null;
        $name = is_string($existing['name'] ?? null) && trim($existing['name']) !== ''
            ? trim($existing['name'])
            : ($defaults['name'] ?? self::titleFromSlug($slug));
        $description = is_string($existing['description'] ?? null)
            ? $existing['description']
            : ($defaults['description'] ?? ($sub !== null ? "Apps in $name" : "Apps in $name"));
        $emoji = is_string($existing['emoji'] ?? null) && trim($existing['emoji']) !== ''
            ? trim($existing['emoji'])
            : ($defaults['emoji'] ?? ($sub !== null ? '📂' : '📁'));
        $sort = is_int($existing['sort'] ?? null) ? $existing['sort'] : ($defaults['sort'] ?? 100);
        $status = is_string($existing['status'] ?? null) && in_array($existing['status'], ['core', 'approved', 'suggested', 'hidden'], true)
            ? $existing['status']
            : ($defaults['status'] ?? 'approved');
        self::$folderCategories[$id] = [
            'schemaVersion' => 1,
            'id' => $id,
            'slug' => $slug,
            'parent' => $sub !== null ? $cat : null,
            'name' => $name,
            'description' => $description,
            'emoji' => $emoji,
            'sort' => $sort,
            'status' => $status,
            'updatedAt' => is_string($existing['updatedAt'] ?? null) ? $existing['updatedAt'] : gmdate('c'),
            'cache' => is_array($existing['cache'] ?? null) ? $existing['cache'] : null,
            '_dir' => $dir,
            '_disk' => is_file($file) ? $existing : null,
        ];
    }

    /** Refresh cached app counts & child lists in each category.json; writes only when changed or missing. */
    public static function syncCategoryCaches(): void {
        $apps = self::all();
        $byMain = [];
        $bySub = [];
        $subsOf = [];
        foreach (self::$folderCategories as $id => $meta) {
            if ($meta['parent'] !== null) {
                $subsOf[$meta['parent']][] = $meta['slug'];
            }
        }
        foreach ($apps as $slug => $row) {
            if (!empty($row['hidden'])) continue;
            $c = (string) ($row['category'] ?? 'other');
            $s = is_string($row['subcategory'] ?? null) && $row['subcategory'] !== '' ? $row['subcategory'] : null;
            if ($s !== null) $bySub["$c/$s"][] = (string) $slug;
            else $byMain[$c][] = (string) $slug;
        }
        foreach (self::$folderCategories as $id => &$meta) {
            $dir = (string) $meta['_dir'];
            $disk = $meta['_disk'];
            $isSub = $meta['parent'] !== null;
            if ($isSub) {
                $direct = $bySub[$id] ?? [];
                sort($direct, SORT_STRING);
                $cache = ['appCount' => count($direct), 'directAppCount' => count($direct), 'subcategories' => [], 'apps' => $direct];
            } else {
                $direct = $byMain[$id] ?? [];
                sort($direct, SORT_STRING);
                $subSlugs = array_values(array_unique($subsOf[$id] ?? []));
                sort($subSlugs, SORT_STRING);
                $total = count($direct);
                foreach ($subSlugs as $ss) $total += count($bySub["$id/$ss"] ?? []);
                $cache = ['appCount' => $total, 'directAppCount' => count($direct), 'subcategories' => $subSlugs, 'apps' => $direct];
            }
            $meta['cache'] = $cache;
            $needsWrite = $disk === null
                || ($disk['schemaVersion'] ?? null) !== 1
                || ($disk['id'] ?? null) !== $meta['id']
                || ($disk['slug'] ?? null) !== $meta['slug']
                || ($disk['parent'] ?? null) !== $meta['parent']
                || ($disk['name'] ?? null) !== $meta['name']
                || ($disk['cache'] ?? null) !== $cache;
            if ($needsWrite) {
                $out = [
                    'schemaVersion' => 1,
                    'id' => $meta['id'],
                    'slug' => $meta['slug'],
                    'parent' => $meta['parent'],
                    'name' => $meta['name'],
                    'description' => $meta['description'],
                    'emoji' => $meta['emoji'],
                    'sort' => $meta['sort'],
                    'status' => $meta['status'],
                    'updatedAt' => gmdate('c'),
                    'cache' => $cache,
                ];
                try {
                    self::writeJson("$dir/category.json", $out);
                    $meta['_disk'] = $out;
                    $meta['updatedAt'] = $out['updatedAt'];
                } catch (Throwable $e) {
                    error_log("softn-api: category.json for $id could not be written: " . $e->getMessage());
                }
            }
        }
        unset($meta);
    }

    /** Create or update a category/subcategory folder's `category.json` (used when suggesting or editing categories). */
    public static function writeCategoryMeta(string $cat, ?string $sub, array $fields): void {
        self::boot();
        if (!self::validSlug($cat)) return;
        if ($sub !== null && $sub !== '' && !self::validSlug($sub)) return;
        $sub = ($sub !== null && $sub !== '') ? $sub : null;
        $id = $sub !== null ? "$cat/$sub" : $cat;
        $dir = Config::dataDir() . '/apps/' . ($sub !== null ? "$cat/$sub" : $cat);
        // Never overwrite or hijack an existing app directory with a category.json.
        if (is_dir($dir) && (is_file("$dir/app.json") || self::looseBundles($dir) !== [])) {
            return;
        }
        if (!is_dir($dir)) {
            if (!self::usesCategorizedLayout($cat, $sub)) return;
            if (!@mkdir($dir, 0775, true) && !is_dir($dir)) return;
            if ($sub !== null && !isset(self::$folderCategories[$cat])) {
                self::ensureCategoryMeta($cat, null, Config::dataDir() . "/apps/$cat");
            }
        }
        self::$hasCategorizedTree = true;
        self::ensureCategoryMeta($cat, $sub, $dir);
        $meta = self::$folderCategories[$id];
        foreach (['name', 'description', 'emoji', 'status'] as $k) {
            if (isset($fields[$k]) && is_string($fields[$k])) $meta[$k] = $fields[$k];
        }
        if (isset($fields['sort']) && is_int($fields['sort'])) $meta['sort'] = $fields['sort'];
        $meta['_disk'] = null; // Force write of updated display fields.
        self::$folderCategories[$id] = $meta;
        self::syncCategoryCaches();
    }

    /**
     * Adopt a loose `.softn` file dragged directly into `data/apps/`,
     * `data/apps/<category>/`, or `data/apps/<category>/<subcategory>/`.
     * Creates `<slug>/v1.softn` (or bumps to `v<N>.softn` when updating an
     * existing app), extracts its icon, writes `app.json`, and keeps history.
     */
    private static function adoptDroppedBundle(string $bundlePath, ?string $folderCat, ?string $folderSub): void {
        if (!is_file($bundlePath) || is_link($bundlePath)) return;
        $info = Bundle::inspect($bundlePath);
        $base = preg_replace('/\.softn$/i', '', basename($bundlePath)) ?? basename($bundlePath);
        $stem = self::stripVersionSuffix($base);
        $slugFromFile = self::slugifyFilename($stem);
        $slugFromName = self::slugifyFilename((string) ($info['name'] ?? ''));
        $slug = (isset(self::$docs[$slugFromFile]) || isset(self::$paths[$slugFromFile]))
            ? $slugFromFile
            : ((isset(self::$docs[$slugFromName]) || isset(self::$paths[$slugFromName]))
                ? $slugFromName
                : ($slugFromName !== 'app' ? $slugFromName : $slugFromFile));

        // Existing app: add as next version suffix (v2.softn, v3.softn...) unless identical bytes already exist.
        if (isset(self::$docs[$slug])) {
            $doc = self::$docs[$slug];
            foreach ($doc['versions'] as $v) {
                if (($v['sha256'] ?? '') === $info['sha256']) {
                    @unlink($bundlePath);
                    return;
                }
            }
            $maxV = 0;
            foreach ($doc['versions'] as $v) $maxV = max($maxV, (int) ($v['version'] ?? 0));
            $nextV = max($maxV, (int) ($doc['app']['latest_version'] ?? 0)) + 1;
            $appDir = self::path($slug);
            $dest = "$appDir/v$nextV.softn";
            if (!@rename($bundlePath, $dest)) {
                if (!@copy($bundlePath, $dest)) throw new ApiError(503, 'Could not move dropped bundle into app folder.');
                @unlink($bundlePath);
            }
            $rel = self::relPath($slug);
            $parts = explode('/', $rel);
            $fCat = count($parts) >= 2 ? $parts[0] : null;
            $fSub = count($parts) === 3 ? $parts[1] : null;
            self::load($slug, $fCat, $fSub);
            return;
        }

        // New app: determine category/subcategory from drop folder (or manifest when dropped at root).
        $targetCat = $folderCat;
        $targetSub = $folderSub;
        if ($targetCat === null) {
            $mCat = is_string($info['manifest']['category'] ?? null) ? trim($info['manifest']['category']) : '';
            $mSub = is_string($info['manifest']['subcategory'] ?? null) ? trim($info['manifest']['subcategory']) : '';
            if (class_exists('Categories', false)) {
                [$targetCat, $targetSub] = Categories::resolvePair($mCat, $mSub);
            } else {
                $targetCat = $mCat !== '' && self::validSlug($mCat) ? $mCat : 'other';
                $targetSub = $mSub !== '' && self::validSlug($mSub) ? $mSub : null;
            }
        }

        $root = Config::dataDir() . '/apps';
        if ($folderCat !== null || self::usesCategorizedLayout($targetCat, $targetSub)) {
            self::$hasCategorizedTree = true;
            $catDir = "$root/$targetCat";
            if (!is_dir($catDir) && !@mkdir($catDir, 0775, true) && !is_dir($catDir)) return;
            self::ensureCategoryMeta($targetCat, null, $catDir);
            if ($targetSub !== null && $targetSub !== '' && self::validSlug($targetSub)) {
                $subDir = "$catDir/$targetSub";
                if (!is_dir($subDir) && !@mkdir($subDir, 0775, true) && !is_dir($subDir)) return;
                self::ensureCategoryMeta($targetCat, $targetSub, $subDir);
                $rel = "$targetCat/$targetSub/$slug";
            } else {
                $rel = "$targetCat/$slug";
                $targetSub = null;
            }
        } else {
            $rel = $slug;
        }

        $appDir = "$root/$rel";
        if (!is_dir($appDir) && !@mkdir($appDir, 0775, true) && !is_dir($appDir)) return;
        $dest = "$appDir/v1.softn";
        if (!@rename($bundlePath, $dest)) {
            if (!@copy($bundlePath, $dest)) throw new ApiError(503, 'Could not move dropped bundle into app folder.');
            @unlink($bundlePath);
        }
        self::registerAppDir($slug, $rel, $folderCat ?? (str_contains($rel, '/') ? $targetCat : null), $targetSub);
    }

    /** Trigger a detached background auto-thumbnail capture for apps missing a thumb.* image. */
    private static function maybeScheduleAutoThumbs(): void {
        if (self::$missingThumbs === []) return;
        $enabled = Config::get('autoThumbnail', false) === true || getenv('SOFTN_AUTO_THUMB') === '1';
        if (!$enabled) return;
        $script = dirname(__DIR__, 3) . '/scripts/demos/auto-thumb.mjs';
        if (!is_file($script)) return;
        $dataDir = Config::dataDir();
        $lockFile = "$dataDir/.auto-thumb.lock";
        // Debounce: wait at least 20 seconds between spawns.
        if (is_file($lockFile) && (time() - (int) @filemtime($lockFile)) < 20) return;

        // Filter out slugs already attempted for their current latest bundle sha256.
        $pending = [];
        foreach (array_unique(self::$missingThumbs) as $slug) {
            $doc = self::$docs[$slug] ?? null;
            if ($doc === null || empty($doc['versions'])) continue;
            if (!empty($doc['app']['thumb'])) continue;
            $latestSha = (string) ($doc['versions'][0]['sha256'] ?? '');
            $marker = self::path($slug) . '/.auto-thumb.json';
            if (is_file($marker)) {
                $m = json_decode((string) @file_get_contents($marker), true);
                if (is_array($m) && ($m['sha256'] ?? '') === $latestSha) continue;
            }
            $pending[] = $slug;
        }
        if ($pending === []) return;
        @file_put_contents($lockFile, (string) time());

        $baseUrl = (string) (Config::get('autoThumbnailBaseUrl') ?: getenv('SOFTN_SITE_URL') ?: 'http://localhost:1420');
        $nodeBin = (string) (Config::get('hostedBackend.nodeBin') ?: getenv('SOFTN_NODE_BIN') ?: 'node');
        $args = [$nodeBin, $script, '--missing', '--data', $dataDir, '--base', $baseUrl, '--limit', '4'];

        try {
            if (PHP_OS_FAMILY === 'Windows') {
                $cmd = 'start /B "" ' . implode(' ', array_map('escapeshellarg', $args)) . ' >NUL 2>&1';
                @pclose(@popen($cmd, 'r'));
            } else {
                $cmd = implode(' ', array_map('escapeshellarg', $args)) . ' >/dev/null 2>&1 &';
                @pclose(@popen($cmd, 'r'));
            }
        } catch (Throwable) {
            // Best-effort background capture; never fail a request.
        }
    }

    private static function load(string $slug, ?string $folderCategory = null, ?string $folderSubcategory = null): void {
        $path = self::path($slug) . '/app.json';
        $doc = is_file($path) ? self::readJson($path) : null;
        if ($doc !== null) {
            if (($doc['schemaVersion'] ?? 1) !== 1 || !is_array($doc['app'] ?? null) || ($doc['app']['slug'] ?? $slug) !== $slug)
                throw new ApiError(503, "Invalid app.json in $slug; the app is not listed until it is repaired.");
            $doc['schemaVersion']=1;
            if (array_key_exists('playUrl',$doc['app'])) { if (!array_key_exists('play_url',$doc['app'])) $doc['app']['play_url']=$doc['app']['playUrl']; unset($doc['app']['playUrl']); }
            if (array_key_exists('backendUrl',$doc['app'])) { if (!array_key_exists('backend_url',$doc['app'])) $doc['app']['backend_url']=$doc['app']['backendUrl']; unset($doc['app']['backendUrl']); }
            if (array_key_exists('withholdBackend',$doc['app'])) { if (!array_key_exists('withhold_backend',$doc['app'])) $doc['app']['withhold_backend']=$doc['app']['withholdBackend']; unset($doc['app']['withholdBackend']); }
            if (array_key_exists('backendRuntime',$doc['app'])) { if (!array_key_exists('backend_runtime',$doc['app'])) $doc['app']['backend_runtime']=$doc['app']['backendRuntime']; unset($doc['app']['backendRuntime']); }
            if (array_key_exists('subcategory', $doc['app']) && $doc['app']['subcategory'] === '') $doc['app']['subcategory'] = null;
            $doc['app']=array_replace(self::defaults($slug),$doc['app']);
            foreach(['versions','comments','ratings','runsDaily'] as $field)if(!array_key_exists($field,$doc))$doc[$field]=[];
            foreach(['thumb','icon'] as $field)if($doc['app'][$field]!==null && (!is_string($doc['app'][$field]) || basename($doc['app'][$field])!==$doc['app'][$field] || str_contains($doc['app'][$field],'\\')))throw new ApiError(503,"Invalid image filename in $slug/app.json.");
            foreach (['tags','capabilities','storage_policies','hidden_remixes'] as $field) if (is_array($doc['app'][$field] ?? null)) $doc['app'][$field] = json_encode($field==='storage_policies'?(object)$doc['app'][$field]:$doc['app'][$field]);
            foreach (['versions','comments','ratings','runsDaily'] as $field) if (!is_array($doc[$field] ?? null)) throw new ApiError(503, "Invalid $field in $slug/app.json.");
            self::validate($slug,$doc);
            self::$docs[$slug] = $doc;
        }
        self::discover($slug, $folderCategory, $folderSubcategory);
    }
    /** Folders skipped by this boot, slug => reason. Empty when every folder loaded. */
    public static function skipped(): array { self::boot(); return self::$skipped; }
    private static function validate(string $slug, array $doc): void {
        $fail=static function() use($slug): never {throw new ApiError(503,"Invalid metadata fields in $slug/app.json. The file has been preserved.");};
        $app=$doc['app'];
        foreach(['name','description','author','category','execution','source','hosting'] as $field)if(!is_string($app[$field]))$fail();
        foreach(['subcategory','parent_slug','root_slug','edit_key_hash','primary_color','backend_runtime'] as $field)if($app[$field]!==null&&!is_string($app[$field]))$fail();
        if($app['subcategory']!==null && !self::validSlug($app['subcategory']))$fail();
        // A linked app: Play opens this address instead of the runtime. Only a
        // web address will do; anything else is a folder that is not listed.
        if($app['play_url']!==null && !self::validPlayUrl($app['play_url']))throw new ApiError(503,"Invalid play_url in $slug/app.json: it must be an http(s) address of at most 300 characters.");
        if(!self::validHosting($app['hosting']))throw new ApiError(503,"Invalid hosting mode in $slug/app.json: must be browser, server, or hybrid.");
        if($app['backend_url']!==null && !self::validBackendUrl($app['backend_url']))throw new ApiError(503,"Invalid backend_url in $slug/app.json: must be a same-origin path or http(s) address of at most 300 characters.");
        if(!in_array($app['withhold_backend'],[0,1,false,true],true))$fail();
        if(!in_array($app['engine'],[1,2],true))$fail();
        foreach(['runs','launches','remixes','rating_sum','rating_count','comments','size','created_at','updated_at','latest_version'] as $field)if(!is_int($app[$field])||$app[$field]<0)$fail();
        if(!in_array($app['hidden'],[0,1,false,true],true))$fail();
        foreach(['tags','capabilities','storage_policies','hidden_remixes'] as $field)if(!is_string($app[$field])||!is_array(json_decode($app[$field],true)))$fail();
        foreach(['versions','comments','ratings','runsDaily'] as $field)if(!array_is_list($doc[$field]))$fail();
        foreach($doc['versions'] as $v)if(!is_array($v)||!is_int($v['version']??null)||$v['version']<1||!is_string($v['file']??null)||basename($v['file'])!==$v['file']||str_contains($v['file'],'\\'))$fail();
        foreach($doc['comments'] as $c)if(!self::validComment($c))$fail();
        foreach($doc['ratings'] as $r)if(!is_array($r)||!is_string($r['visitor']??null)||!in_array($r['stars']??null,[1,2,3,4,5],true))$fail();
        foreach($doc['runsDaily'] as $r)if(!is_array($r)||!is_int($r['day']??null)||!is_int($r['count']??null)||$r['count']<0||!is_int($r['visitors']??0)||($r['visitors']??0)<0)$fail();
    }
    private static function validComment(mixed $c): bool {
        return is_array($c) && is_int($c['id'] ?? null) && is_string($c['name'] ?? null) && is_string($c['body'] ?? null) && is_string($c['visitor'] ?? null) && isset($c['created_at'], $c['hidden']);
    }
    /**
     * An app's comments, oldest first. They are a file of their own beside
     * app.json, read only where comments are: every request decodes every
     * app.json, under the one catalogue lock, and comments kept there made
     * the whole directory pay for them. A few thousand comments a visitor
     * could post at the rate limit's pace were tens of megabytes read by
     * every request, then more than PHP's memory, and every route failed.
     * An app whose comments are still in its app.json (written before) has
     * them read from there until its next comment moves them out.
     *
     * @return list<array<string, mixed>>
     */
    public static function comments(string $slug): array {
        $doc = self::doc($slug);
        $path = self::path($slug) . '/comments.json';
        if (!is_file($path)) return $doc['comments'];
        $rows = self::readJson($path);
        if (!array_is_list($rows)) throw new ApiError(503, "Invalid comments.json in $slug. The file has been preserved.");
        foreach ($rows as $c) if (!self::validComment($c)) throw new ApiError(503, "Invalid comment in $slug/comments.json. The file has been preserved.");
        return $rows;
    }
    /** Store an app's comments, and its count of the ones a visitor sees. Written before app.json gives up its own copy. */
    public static function putComments(string $slug, array $comments): void {
        $comments = array_values($comments);
        self::writeJson(self::path($slug) . '/comments.json', $comments);
        $doc = self::doc($slug);
        $doc['comments'] = [];
        $doc['app']['comments'] = count(array_filter($comments, fn($c) => !$c['hidden']));
        self::put($slug, $doc);
    }
    public static function validPlayUrl(mixed $url): bool {
        if(!is_string($url)||$url===''||strlen($url)>300||$url!==trim($url))return false;
        if(!preg_match('#^https?://[^\s/?\#]+#i',$url)||filter_var($url,FILTER_VALIDATE_URL)===false)return false;
        return !preg_match('/[\x00-\x20"<>\\\'`]/',$url);
    }
    public static function validHosting(mixed $mode): bool {
        return is_string($mode) && in_array($mode, ['browser', 'server', 'hybrid'], true);
    }
    public static function validBackendUrl(mixed $url): bool {
        if(!is_string($url)||$url===''||strlen($url)>300||$url!==trim($url))return false;
        if(preg_match('/[\x00-\x20"<>\\\'`]/',$url))return false;
        if(str_starts_with($url,'/')){
            if(str_starts_with($url,'//')||str_contains($url,'..')||str_contains($url,'\\'))return false;
            return true;
        }
        return self::validPlayUrl($url);
    }
    public static function release(): void {
        if (is_resource(self::$lock)) { flock(self::$lock, LOCK_UN); fclose(self::$lock); Timings::released(); }
        self::$lock = null; self::$ready=false; self::$docs=[]; self::$paths=[]; self::$folderCategories=[]; self::$hasCategorizedTree=false; self::$missingThumbs=[]; self::$cache=[]; self::$cacheDirty=false; self::$skipped=[]; self::$rows=null;
    }
    public static function readJson(string $path, bool $cache = false): array {
        if (is_link($path)) throw new ApiError(503, 'JSON metadata must not be a symlink.');
        if (!is_file($path)) {
            // Not there is nothing yet. A folder of that name is the same file
            // that will not read, and read as nothing it was then written to.
            if (!$cache && is_dir($path)) throw new ApiError(503, 'JSON metadata must be a regular file.');
            return [];
        }
        try {
            $value = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
            if (!is_array($value)) throw new RuntimeException('Expected a JSON object.');
            return $value;
        } catch (Throwable $e) {
            if ($cache) return [];
            throw new ApiError(503, 'Invalid JSON metadata: ' . basename($path) . '. The file has been preserved.');
        }
    }
    /** Write a complete sibling, flush it, then atomically replace the old file. */
    public static function writeJson(string $path, array $value): void {
        clearstatcache(true, $path);
        if (is_link($path)) throw new ApiError(503, 'JSON metadata must not be a symlink.');
        // A shared host may list these in disable_functions, and a disabled function is an Error in
        // PHP 8 that @ does not stop: every play and comment would fail on a nicety.
        $previous = function_exists('lstat') ? @lstat($path) : false;
        if ($previous !== false && ($previous['mode'] & 0170000) !== 0100000)
            throw new ApiError(503, 'JSON metadata must be a regular file.');
        $mode = $previous !== false ? ($previous['mode'] & 0777) : 0600;
        $dir = dirname($path);
        if (!is_dir($dir) && !mkdir($dir, 0775, true)) throw new ApiError(503, 'Cannot create metadata folder.');
        $bytes = json_encode($value, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR) . "\n";
        $tmp = tempnam($dir, '.json-');
        if ($tmp === false) throw new ApiError(503, 'Cannot stage metadata.');
        $committing = hrtime(true);
        try {
            $f = fopen($tmp, 'wb');
            if (!$f) throw new ApiError(503, 'Cannot write metadata.');
            try {
                $offset = 0;
                while ($offset < strlen($bytes)) { $n = fwrite($f, substr($bytes, $offset)); if (!$n) throw new ApiError(503, 'Incomplete metadata write.'); $offset += $n; }
                if (!fflush($f)) throw new ApiError(503, 'Cannot flush metadata.');
                if (function_exists('fsync') && !fsync($f)) throw new ApiError(503, 'Cannot sync metadata.');
            } finally { fclose($f); }
            // rename() keeps the staged file's mode/group, not the old target's.
            // Keep new metadata private, and preserve existing ordinary access bits.
            // Neither is worth a visitor's play or comment: a file owned by a
            // group PHP isn't in would refuse every write to it, in silence for
            // a play. Said in the log, and the staged file is no more open.
            clearstatcache(true, $tmp);
            // Only asked in order to keep the group, so a miss doesn't cost the write: on Windows it
            // came back false now and then with PHP processes racing on one record.
            $staged = function_exists('stat') ? @stat($tmp) : false;
            if ($staged !== false && $previous !== false && $staged['gid'] !== $previous['gid'] && !(function_exists('chgrp') && @chgrp($tmp, $previous['gid'])))
                error_log("softn-api: $path could not keep its group; check the PHP service account and shared group");
            if (!(function_exists('chmod') && @chmod($tmp, $mode))) error_log("softn-api: $path could not keep its permissions");
            if (!rename($tmp, $path)) throw new ApiError(503, 'Cannot replace metadata.');
        } finally { if (is_file($tmp)) @unlink($tmp); Timings::add('commit', $committing); }
    }
    /**
     * Every listable app's row, keyed by slug, with its remix count. Built
     * once per request: the listing asked for it again for every card with
     * a parent and for every row lookup, and each build counted remixes
     * with a pass over every document per row, which at 1,000 apps was the
     * larger part of a list request. A write through put() or remove()
     * discards it, so a row read after a commit is the committed one.
     */
    public static function all(): array {
        self::boot();
        if (self::$rows !== null) return self::$rows;
        $out = [];
        foreach (self::$docs as $slug => $doc) {
            // A doc with no versions is a folder still being filled, unless it names an address to play at.
            if (!$doc['versions'] && empty($doc['app']['play_url'])) continue;
            $out[$slug] = $doc['app'];
        }
        // A remix counts for its parent while a visitor can open it. Every
        // folder naming the parent used to be counted, so an app kept the
        // remixes their owners had unpublished: a count, and a place in the
        // "most remixed" order, with nothing in the list beside it. Nor does
        // one the parent's owner hid from its page (`hidden_remixes`): anyone
        // can publish a remix of any app, and each counted five in trending.
        $remixes = [];
        $hiddenBy = [];
        foreach ($out as $slug => $row) $hiddenBy[$slug] = array_flip(json_decode((string) $row['hidden_remixes'], true) ?: []);
        foreach ($out as $slug => $row) { $p = $row['parent_slug'] ?? null; if (is_string($p) && !$row['hidden'] && !isset($hiddenBy[$p][$slug])) $remixes[$p] = ($remixes[$p] ?? 0) + 1; }
        foreach ($out as $slug => $row) $out[$slug]['remixes'] = $remixes[$slug] ?? 0;
        return self::$rows = $out;
    }
    public static function doc(string $slug): array {
        self::boot();
        if (!isset(self::$docs[$slug])) throw new ApiError(404, 'No app is published under that name.');
        return self::$docs[$slug];
    }
    public static function put(string $slug, array $doc): void {
        self::boot();
        $doc['schemaVersion'] = 1;
        $disk = $doc;
        foreach (['tags','capabilities','storage_policies'] as $field) if (is_string($disk['app'][$field] ?? null)) $disk['app'][$field] = $field==='storage_policies'?(object)(json_decode($disk['app'][$field],true)?:[]):(json_decode($disk['app'][$field],true)?:[]);
        self::writeJson(self::path($slug) . '/app.json', $disk);
        self::$docs[$slug] = $doc; self::$rows = null;
    }
    public static function patch(string $slug, array $fields): void { $d = self::doc($slug); $d['app'] = array_replace($d['app'], $fields); self::put($slug, $d); }
    public static function remove(string $slug): void {
        $seed = (self::doc($slug)['app']['source'] ?? null) === 'seed';
        // Kept from every later publish first: if that cannot be written, the
        // app stays where it is rather than leaving its slug to be handed out.
        self::retireSlug($slug, $seed);
        self::retire($slug);
        unset(self::$docs[$slug], self::$paths[$slug]); self::$rows = null;
        if (self::$hasCategorizedTree && self::$folderCategories !== []) {
            self::syncCategoryCaches();
        }
        // What was remixed from it has no parent now. Left naming the slug,
        // those remixes were handed to whichever app was published under it
        // next, as that app's own: its count, its list, its lineage.
        foreach (self::$docs as $other => $doc) {
            $orphaned = false;
            foreach (['parent_slug', 'root_slug'] as $field) if (($doc['app'][$field] ?? null) === $slug) { $doc['app'][$field] = null; $orphaned = true; }
            if (!$orphaned) continue;
            // The key is a slug, and text: PHP makes a number of one that is all digits.
            try { self::put((string) $other, $doc); }
            catch (Throwable $e) { error_log("softn-api: $other could not be told its parent $slug is gone: " . $e->getMessage()); self::$docs[$other] = $doc; }
        }
    }
    /**
     * Slugs no app is published under again, each with when it was retired
     * and whether a seeded demo had it: slug => ['at' => int, 'seed' => bool].
     *
     * A slug is an address its visitors' browsers keep the app's own data
     * under: `/play/<slug>` stores the app's records and settings by that
     * address (single-shell's app id). Handed to the next app published with
     * the same name, every earlier visitor's records were that app's from its
     * first open. So a removed app's slug is kept, and the demo the seeder
     * retired is the one app that may take it back.
     *
     * @return array<string, array{at: int, seed: bool}>
     */
    public static function retiredSlugs(): array {
        self::boot();
        return self::readJson(Config::dataDir() . '/retired-slugs.json');
    }
    private static function retireSlug(string $slug, bool $seed): void {
        $all = self::retiredSlugs();
        $all[$slug] = ['at' => time(), 'seed' => $seed];
        self::writeJson(Config::dataDir() . '/retired-slugs.json', $all);
    }
    /** A seeded demo back under the slug it had: its own visitors' data is its own again. */
    public static function reclaimSlug(string $slug): void {
        $all = self::retiredSlugs();
        if (!isset($all[$slug])) return;
        unset($all[$slug]);
        self::writeJson(Config::dataDir() . '/retired-slugs.json', $all);
    }
    /** Atomically retire the entire directory, listed or not; recovery never rediscovers it. */
    public static function retire(string $slug): void {
        $from = self::path($slug); $trash = Config::dataDir() . '/.retired-' . $slug . '-' . bin2hex(random_bytes(6));
        // Storage requests work in an app's database after they have let the
        // catalogue go (Storage::leaveCatalogue). The ones in flight finish
        // first and no other begins while the folder goes: none is left
        // writing into a store that is being deleted under it.
        $quiet = @fopen(Config::dataDir() . '/storage.lock', 'c');
        if ($quiet !== false) flock($quiet, LOCK_EX);
        try {
            if (!rename($from, $trash)) throw new ApiError(503, 'Cannot retire app folder.');
            unset(self::$paths[$slug]);
            self::removeTree($trash);
        } finally {
            if ($quiet !== false) { flock($quiet, LOCK_UN); fclose($quiet); }
        }
    }
    /** Delete a retired folder and everything under it. A leftover is logged, not thrown over: the app is already gone from the catalogue. */
    private static function removeTree(string $dir): void {
        foreach (scandir($dir) ?: [] as $name) {
            if ($name === '.' || $name === '..') continue;
            $path = "$dir/$name";
            if (is_dir($path) && !is_link($path)) self::removeTree($path); else @unlink($path);
        }
        if (!@rmdir($dir)) error_log("softn-api: retired folder $dir could not be removed");
    }
    public static function categories(): array { self::boot(); return self::readJson(Config::dataDir() . '/categories.json'); }
    public static function saveCategories(array $rows): void { self::boot(); self::writeJson(Config::dataDir() . '/categories.json', $rows); }
    public static function defaults(string $slug): array {
        return ['slug'=>$slug,'name'=>$slug,'description'=>'','author'=>'Anonymous','category'=>'other','subcategory'=>null,'tags'=>'[]','parent_slug'=>null,'root_slug'=>null,'latest_version'=>1,'capabilities'=>'[]','execution'=>'main','engine'=>1,'backend_runtime'=>null,'hosting'=>'browser','backend_url'=>null,'withhold_backend'=>0,'storage_policies'=>'{}','hidden_remixes'=>'[]','thumb'=>null,'icon'=>null,'primary_color'=>null,'edit_key_hash'=>null,'play_url'=>null,'source'=>'folder','runs'=>0,'launches'=>0,'remixes'=>0,'rating_sum'=>0,'rating_count'=>0,'comments'=>0,'size'=>0,'hidden'=>0,'created_at'=>time(),'updated_at'=>time()];
    }
    /** Extract a numeric version suffix from filenames like `v2.softn`, `game-v3.softn`, or (when multiple bundles exist) `game-2.softn`. */
    private static function parseVersionNumber(string $file, bool $allowBareNumber = false): ?int {
        if (preg_match('/^v([1-9][0-9]{0,3})\.softn$/D', $file, $m)) return (int) $m[1];
        if (preg_match('/[-_]v([1-9][0-9]{0,3})\.softn$/iD', $file, $m)) return (int) $m[1];
        if ($allowBareNumber && preg_match('/[-_]([1-9][0-9]{0,2})\.softn$/D', $file, $m)) return (int) $m[1];
        return null;
    }
    /** Find an existing image file (`thumb.*` or `icon.*`) in `$dir`, preferring webp/svg/png. */
    private static function findImageFile(string $dir, string $stem): ?string {
        $exts = $stem === 'icon' ? ['svg', 'png', 'webp', 'jpg', 'jpeg', 'gif'] : ['webp', 'png', 'jpg', 'jpeg', 'gif'];
        foreach ($exts as $ext) {
            $name = "$stem.$ext";
            $full = "$dir/$name";
            if (!is_link($full) && is_file($full)) return $name;
        }
        return null;
    }
    private static function discover(string $slug, ?string $folderCategory = null, ?string $folderSubcategory = null): void {
        $dir = self::path($slug); $rel = self::relPath($slug); $old = self::$docs[$slug] ?? null;
        $doc = $old ?? ['schemaVersion'=>1,'app'=>self::defaults($slug),'versions'=>[],'comments'=>[],'ratings'=>[],'runsDaily'=>[]];
        // When an app lives inside data/apps/<category>/[<subcategory>/]<slug>/,
        // the folder hierarchy is authoritative so moving folders updates the listing automatically.
        if ($folderCategory !== null) {
            $doc['app']['category'] = $folderCategory;
            $doc['app']['subcategory'] = $folderSubcategory;
        }
        $versions = []; $infos=[]; $used = []; $files = glob("$dir/*.softn") ?: []; natsort($files);
        foreach ($doc['versions'] as $v) $used[basename($v['file'])] = (int)$v['version'];
        foreach ($files as $path) {
            if (is_link($path)) continue;
            $file = basename($path);
            if (!preg_match('/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.softn$/D', $file)) continue;
            $key = "$rel/$file"; $stat = @stat($path);
            if ($stat === false) { error_log("softn-api: unreadable bundle $rel/$file"); continue; }
            $fingerprint = [$stat['size'],$stat['mtime'],$stat['ctime']];
            $cached = self::$cache[$key] ?? null;
            // The icon is only needed the first time a folder is met, so it is only cached then; an entry without one is re-read if the need arises.
            if(!is_array($cached) || !is_array($cached['info']??null) || array_diff(['author','name','version','description','capabilities','storagePolicies','execution','engine','backendRuntime','size','sha256'],array_keys($cached['info'])) || (!$old && !array_key_exists('icon',$cached['info'])))$cached=null;
            // Changed on disk, or unknown: read it. Otherwise it is read again
            // only by the sweep, when its stamp is old and the request still
            // has sweep budget; an unchanged bundle is never re-read for time alone.
            $changed = !$cached || ($cached['stat'] ?? []) !== $fingerprint;
            $sweep = !$changed && self::$sweepBudget > 0 && time() - ($cached['checked'] ?? 0) >= self::$sweepSeconds;
            if ($changed || $sweep) {
                if ($sweep) { self::$sweepBudget--; Timings::swept(); }
                // Any failure to read one bundle skips that bundle, not the
                // app and not the directory: a truncated upload, a zip the
                // extension refuses, a manifest that is not JSON.
                $inspecting = hrtime(true);
                try { $full = Bundle::inspect($path); }
                catch (Throwable $e) { Timings::add('rebuild', $inspecting); error_log("softn-api: invalid bundle in $rel/$file: " . $e->getMessage()); if (isset(self::$cache[$key])) { unset(self::$cache[$key]); self::$cacheDirty = true; } continue; }
                Timings::add('rebuild', $inspecting);
                // Only what this function reads is cached. The whole manifest
                // (and every icon) went in once, and cache/bundles.json is
                // read back on every request, for every bundle.
                $author = $full['manifest']['author'] ?? null;
                if (is_array($author)) $author = $author['name'] ?? null;
                $info = ['author'=>is_string($author) ? (Text::clean($author, 40) ?: 'Anonymous') : 'Anonymous'];
                foreach (['name','version','description','capabilities','storagePolicies','execution','engine','backendRuntime','size','sha256'] as $field) $info[$field] = $full[$field];
                if (!$old || $doc['app']['icon'] === null) $info['icon'] = $full['icon'] ? [base64_encode($full['icon'][0]), $full['icon'][1]] : null;
                unset($full);
                self::$cache[$key] = ['stat'=>$fingerprint,'checked'=>time(),'info'=>$info]; self::$cacheDirty = true;
            } else $info = $cached['info'];
            if (!isset($info)) $info = self::$cache[$key]['info'];
            $parsedNum = self::parseVersionNumber($file, count($files) > 1 || $used !== []);
            $number = $used[$file] ?? ($parsedNum ?? (max([0,...array_values($used)])+1));
            if (isset($versions[$number])) { error_log("softn-api: $rel/$file would be version $number, already taken by {$versions[$number]['file']}; skipped"); continue; }
            $used[$file]=$number;$infos[$number]=$info;
            $previous = null; foreach ($doc['versions'] as $v) if ($v['file']===$file) $previous=$v;
            $verRow = ['slug'=>$slug,'version'=>$number,'file'=>$file,'size'=>$info['size'],'sha256'=>$info['sha256'],'manifest_version'=>$info['version'],'notes'=>$previous['notes']??'','created_at'=>$previous['created_at']??$stat['mtime']];
            if (is_string($previous['commit'] ?? null) && $previous['commit'] !== '') $verRow['commit'] = $previous['commit'];
            if (is_string($previous['tree'] ?? null) && $previous['tree'] !== '') $verRow['tree'] = $previous['tree'];
            $versions[$number] = $verRow;
            if (!$old || $number >= (int)$doc['app']['latest_version']) {
                if (!$old) { $doc['app']['name']=$info['name']; $doc['app']['description']=$info['description']; $doc['app']['author']=$info['author']; }
                $doc['app']['latest_version']=$number; $doc['app']['size']=$info['size'];
                $doc['app']['capabilities']=json_encode($info['capabilities']); $doc['app']['execution']=$info['execution']; $doc['app']['engine']=(int)($info['engine']??1); $doc['app']['backend_runtime']=$info['backendRuntime']??null; $doc['app']['storage_policies']=json_encode((object)$info['storagePolicies']);
                if ((!$old || $doc['app']['icon'] === null) && !empty($info['icon'])) {
                    $icon='icon.'.Images::extension($info['icon'][1]);
                    if (@file_put_contents("$dir/$icon",base64_decode($info['icon'][0]),LOCK_EX) !== false) $doc['app']['icon']=$icon;
                    else error_log("softn-api: icon for $slug could not be written");
                }
            }
            unset($info);
        }
        krsort($versions); $doc['versions']=array_values($versions);
        // Reconcile icon.* and thumb.* files dropped or generated directly in the app folder.
        if ($doc['app']['icon'] !== null && !is_file("$dir/" . $doc['app']['icon'])) $doc['app']['icon'] = null;
        if ($doc['app']['icon'] === null) {
            $foundIcon = self::findImageFile($dir, 'icon');
            if ($foundIcon !== null) $doc['app']['icon'] = $foundIcon;
        }
        if ($doc['app']['thumb'] !== null && !is_file("$dir/" . $doc['app']['thumb'])) $doc['app']['thumb'] = null;
        if ($doc['app']['thumb'] === null) {
            $foundThumb = self::findImageFile($dir, 'thumb');
            if ($foundThumb !== null) $doc['app']['thumb'] = $foundThumb;
        }
        if (!$versions) {
            // No bundle. A folder that names a play_url is a linked app: listed
            // with its picture and description, played on its own site, with
            // nothing here to run, download, read or remix.
            if (!$old || empty($doc['app']['play_url'])) { unset(self::$docs[$slug]); return; }
            $doc['app']['latest_version']=0;$doc['app']['size']=0;$doc['app']['capabilities']='[]';$doc['app']['execution']='main';$doc['app']['engine']=1;$doc['app']['backend_runtime']=null;$doc['app']['storage_policies']='{}';
            if ($old !== $doc) {
                try { self::put($slug,$doc); }
                catch (Throwable $e) { error_log("softn-api: metadata for $slug could not be written: " . $e->getMessage()); self::$docs[$slug] = $doc; }
            }
            return;
        }
        $latest=$doc['versions'][0];$info=$infos[$latest['version']];
        $doc['app']['latest_version']=$latest['version'];$doc['app']['size']=$info['size'];
        $doc['app']['capabilities']=json_encode($info['capabilities']);$doc['app']['execution']=$info['execution'];$doc['app']['engine']=(int)($info['engine']??1);$doc['app']['backend_runtime']=$info['backendRuntime']??null;$doc['app']['storage_policies']=json_encode((object)$info['storagePolicies']);
        if ($doc['app']['thumb'] === null) self::$missingThumbs[] = $slug;
        if($old && ($old['versions']!==$doc['versions'] || ($old['app']['thumb']??null)!==$doc['app']['thumb'] || ($old['app']['icon']??null)!==$doc['app']['icon']))$doc['app']['updated_at']=time();
        if ($old !== $doc) {
            // A folder that cannot take its app.json is still served from what
            // was read; the write is retried on the next request.
            try { self::put($slug,$doc); }
            catch (Throwable $e) { error_log("softn-api: metadata for $slug could not be written: " . $e->getMessage()); self::$docs[$slug] = $doc; }
        }
    }
    /** One-time, restartable import. Keep the original database as a backup. */
    private static function migrateLegacy(): void {
        $root=Config::dataDir(); $path="$root/directory.sqlite";
        if (!is_file($path) || is_file("$root/directory-migrated.json")) return;
        $pdo = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION,PDO::ATTR_DEFAULT_FETCH_MODE=>PDO::FETCH_ASSOC]);
        $pdo->exec('PRAGMA query_only=ON'); $pdo->beginTransaction();
        foreach ($pdo->query('SELECT * FROM apps')->fetchAll() as $app) {
            $slug=$app['slug']; if (!self::validSlug($slug)) throw new ApiError(503,'Legacy directory has an invalid slug.');
            if (is_file(self::path($slug).'/app.json')) continue;
            $doc=['schemaVersion'=>1,'app'=>array_replace(self::defaults($slug),$app)];
            foreach (['versions'=>'versions','comments'=>'comments','ratings'=>'ratings','runsDaily'=>'runs_daily'] as $key=>$table) { $s=$pdo->prepare("SELECT * FROM $table WHERE slug=?");$s->execute([$slug]);$doc[$key]=$s->fetchAll(); }
            self::put($slug,$doc);
        }
        if (!is_file("$root/categories.json")) self::writeJson("$root/categories.json",array_column($pdo->query('SELECT * FROM categories')->fetchAll(),null,'id'));
        $pdo->commit();
        self::writeJson("$root/directory-migrated.json",['schemaVersion'=>1,'migratedAt'=>gmdate('c'),'source'=>'directory.sqlite']);
    }
}
