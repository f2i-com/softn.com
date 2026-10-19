<?php
/**
 * A directory with nothing in it is a poor first impression, and the site
 * already ships fifteen apps. On the first request that finds the catalogue
 * empty, the demo bundles beside the API are published as the site's own,
 * in the categories they belong to, with no edit key — they are the site
 * owner's, and the admin key updates them.
 */
declare(strict_types=1);

final class Seed
{
    /**
     * What each file hashed to when it was last hashed, by its size and
     * times, kept in cache/seed.json: `path => [size, mtime, ctime, sha256]`.
     * @var array<string, array{0:int,1:int,2:int,3:string}>
     */
    private static array $stamps = [];
    private static bool $stampsDirty = false;

    /**
     * A file's SHA-256, read from the file only when the file has changed
     * since it was last read (its size and times, as the catalogue judges a
     * bundle). Every demo and both copies of every screenshot were hashed in
     * full on each request to a seeded route, under the catalogue lock: some
     * twenty megabytes to learn that nothing had changed.
     */
    private static function sha(string $file): string
    {
        clearstatcache(true, $file);
        $stat = @stat($file);
        if ($stat === false) return '';
        $print = [(int) $stat['size'], (int) $stat['mtime'], (int) $stat['ctime']];
        $known = self::$stamps[$file] ?? null;
        if (is_array($known) && array_slice($known, 0, 3) === $print && is_string($known[3] ?? null)) return $known[3];
        $sha = (string) hash_file('sha256', $file);
        self::$stamps[$file] = [...$print, $sha];
        self::$stampsDirty = true;
        return $sha;
    }

    private static function loadStamps(string $dir): void
    {
        $read = json_decode((string) @file_get_contents("$dir/cache/seed.json"), true);
        self::$stamps = is_array($read) ? $read : [];
        self::$stampsDirty = false;
    }

    private static function saveStamps(string $dir): void
    {
        if (!self::$stampsDirty) return;
        // Only files that are still there: the cache does not grow with every
        // picture a demo ever had.
        $keep = array_filter(self::$stamps, fn($path) => is_file($path), ARRAY_FILTER_USE_KEY);
        if (!is_dir("$dir/cache")) @mkdir("$dir/cache", 0700, true);
        $tmp = "$dir/cache/.seed-" . bin2hex(random_bytes(4));
        if (@file_put_contents($tmp, json_encode($keep, JSON_UNESCAPED_SLASHES)) === false || !@rename($tmp, "$dir/cache/seed.json")) @unlink($tmp);
        self::$stampsDirty = false;
    }

    private const CATEGORY = [
        'snake-game' => 'games', 'pocket' => 'games', 'maze-escape-3d' => 'games', 'texas-holdem' => 'games',
        'promptly-unemployed' => 'games', 'the-office' => 'games', 'blockscape' => 'games', 'dead-hours' => 'games', 'twenty48' => 'games', 'blockfall' => 'games',
        'train-yard' => 'simulations', 'predator-prey' => 'simulations',
        'warble-wire' => 'tools', 'ai-chat' => 'ai', 'house-builder' => 'creative', 'sim-lives' => 'games',
        // Sample apps: they show what the runtime can do rather than being
        // things to rely on, and the directory files them as such.
        'notes' => 'demos', 'glamour-studio' => 'demos', 'device-kit' => 'demos', 'showcase' => 'demos',
        'gpu-demo' => 'demos', 'three-demo' => 'demos', 'ai-demo' => 'demos', 'foundation-fixture' => 'demos',
    ];

    private const TAGS = [
        'snake-game' => 'arcade,classic', 'pocket' => 'emulator,handheld,retro', 'maze-escape-3d' => '3d,maze',
        'texas-holdem' => 'cards,poker', 'promptly-unemployed' => 'story,comedy',
        'blockscape' => '3d,sandbox,voxel', 'dead-hours' => '3d,shooter,zombies', 'twenty48' => 'puzzle,classic', 'blockfall' => 'arcade,puzzle,classic',
        'the-office' => 'simulation', 'train-yard' => '3d,simulation,railway', 'predator-prey' => 'ecosystem,simulation,biology,3d',
        'notes' => 'notes,local-first', 'glamour-studio' => 'business,scheduling',
        'device-kit' => 'camera,qr,network', 'warble-wire' => 'audio,modem,dsp', 'ai-chat' => 'llm,chat',
        'house-builder' => '3d,floor-plan,architecture,design', 'sim-lives' => '3d,life-simulation,house,sandbox',
        'ai-demo' => 'llm', 'gpu-demo' => 'webgpu,compute', 'three-demo' => '3d,webgl', 'showcase' => 'components',
    ];

    /**
     * `$from` names a folder of apps to seed from instead of the bundles
     * beside the API — the offline seed (seed-folder.php) writing a data/
     * ahead of a site's first request.
     */
    public static function ifEmpty(?string $from = null): void
    {
        if ($from === null && !Config::get('seedDemos', true)) return;
        $dir = Config::dataDir();
        $flag = "$dir/seeded";
        Catalog::boot();
        Categories::ensure();
        // A built site keeps its example bundles beside the API, at
        // dist/demos; a build without them (the default) has no directory
        // there and seeds nothing. Only the API run from its source tree
        // (apps/softn-api, in dev and the tests) may reach for the runtime's
        // fetched bundles or a built dist/ instead — a built site tested
        // inside the checkout must not pick up the developer's bundles.
        $demos = $from ?? dirname(__DIR__, 2) . '/demos';
        if ($from === null && !is_dir($demos) && basename(dirname(__DIR__)) === 'softn-api') {
            $candidate = dirname(__DIR__, 3) . '/apps/softn-web/public/demos';
            if (is_dir($candidate)) $demos = $candidate;
            else {
                $candidate = dirname(__DIR__, 3) . '/dist/demos';
                if (is_dir($candidate)) $demos = $candidate;
            }
        }
        $indexPath = "$demos/index.json";
        if (!is_file($indexPath)) return;
        $index = json_decode((string) file_get_contents($indexPath), true);
        if (!is_array($index)) return;

        // Bring seeded app categories up to date
        foreach (self::CATEGORY as $slug => $cat) {
            // Seeded rows only: a visitor's app that happens to hold one of
            // these slugs keeps the category its publisher chose.
            $row=Catalog::all()[$slug]??null;
            if($row===null || $row['source']!=='seed')continue;
            // And only a filing that is the seed's own. The operator files a
            // demo elsewhere with the admin key, and it was put back here on
            // the next request; `seed_category` is where the seed last put
            // it, and a category that differs from that is theirs. A demo
            // from before this was recorded was held to the table on every
            // request, so the category it has is the seed's.
            if(($row['seed_category']??$row['category'])!==$row['category'])continue;
            if($row['category']!==$cat || !isset($row['seed_category']))Catalog::patch($slug,['category'=>$cat,'seed_category'=>$cat]);
        }

        $existing=array_values(Catalog::all());
        // A linked app (play_url, no bundle) has no version to compare and is
        // never an index entry; asking it for one threw, and one such folder
        // took every seeded route down with "That version does not exist".
        // Version 1 is the one the seed wrote and the one a demo is compared
        // with. Compared with the latest, a demo whose owner had published a
        // version 2 never matched: every request replaced v1.softn, moved the
        // app's dates and wrote version 1's capabilities over the app.
        foreach($existing as &$r){
            if(Apps::playUrl($r)!==null){$r['size']=0;$r['sha256']='';continue;}
            try{$v=Apps::version($r['slug'],1);}catch(ApiError){$v=Apps::version($r['slug']);}
            $r['size']=$v['size'];$r['sha256']=$v['sha256'];
        }unset($r);

        $existingMap = [];
        foreach ($existing as $r) {
            $existingMap[$r['slug']] = $r;
        }
        // A folder the catalogue skipped this boot is not listed, but it is
        // still there: seeding over it would publish the demo again as
        // `<slug>-2`, and the sweep below would retire that copy as one the
        // index does not name — on every request until the folder is fixed.
        $skipped = Catalog::skipped();

        // A second request arriving while this one seeds must not seed too.
        $lock = fopen("$dir/seed.lock", 'c');
        if ($lock === false || !flock($lock, LOCK_EX | LOCK_NB)) return;
        self::loadStamps($dir);
        try {
            foreach ($index as $entry) {
                if (!is_array($entry) || !is_string($entry['file'] ?? null)) continue;
                $file = "$demos/" . basename($entry['file']);
                if (!is_file($file)) continue;
                $id = is_string($entry['id'] ?? null) ? $entry['id'] : Apps::slugify((string) ($entry['name'] ?? $entry['file']));
                if (isset($skipped[$id])) continue;
                // The same for a folder the catalogue passed over without
                // skipping it: one whose bundles are all unreadable (cut off,
                // or removed by hand), which is not listed and still holds the
                // name. The path is put together here rather than asked of
                // Catalog::path, which throws for a link and would take the
                // listing down with it.
                if (!isset($existingMap[$id]) && Catalog::validSlug($id) && is_dir("$dir/apps/$id")) continue;
                $currentMeta = [
                    'slug' => $id,
                    'name' => is_string($entry['name'] ?? null) ? $entry['name'] : null,
                    'description' => is_string($entry['description'] ?? null) ? $entry['description'] : null,
                    // An index can name these itself (the softn-apps folder does,
                    // for games from their own repositories); the built-in
                    // examples keep their tables.
                    'author' => is_string($entry['author'] ?? null) && $entry['author'] !== '' ? $entry['author'] : 'SoftN',
                    'category' => self::CATEGORY[$id] ?? (is_string($entry['category'] ?? null) && $entry['category'] !== '' ? $entry['category'] : 'demos'),
                    'tags' => self::TAGS[$id] ?? (is_string($entry['tags'] ?? null) ? $entry['tags'] : ''),
                    'primary' => is_string($entry['primary'] ?? null) ? $entry['primary'] : null,
                ];

                // The slug belongs to an app the seed did not create: a
                // visitor published under a plain name (`notes`, `snake`)
                // before a release added a demo with that id. Updating it
                // replaced their bundle and description with the demo's and
                // left their edit key on it. It is theirs; the demo goes
                // unseeded here until the operator makes room for it.
                if (isset($existingMap[$id]) && $existingMap[$id]['source'] !== 'seed') continue;

                if (isset($existingMap[$id])) {
                    // Check if bundle on disk was updated (size or sha256 changed)
                    $diskSize = filesize($file);
                    $dbSize = (int) ($existingMap[$id]['size'] ?? 0);
                    $dbSha = (string) ($existingMap[$id]['sha256'] ?? '');
                    if ($diskSize !== $dbSize || self::sha($file) !== $dbSha) {
                        try {
                            Apps::updateSeedApp($id, $file, $currentMeta);
                        } catch (Throwable $e) {
                            error_log("softn-api: could not update seed app $file: " . $e->getMessage());
                        }
                    }
                    // The picture is refreshed on its own: a screenshot retaken
                    // for an unchanged bundle still reaches the directory.
                    self::refreshThumbnail($id, $demos, basename($entry['file']));
                    continue;
                }

                try {
                    $created = Apps::create($file, $currentMeta, 'seed');
                    self::refreshThumbnail($created['app']['slug'], $demos, basename($entry['file']));
                } catch (Throwable $e) {
                    error_log("softn-api: could not seed $file: " . $e->getMessage());
                }
            }
            // A seeded demo that has left the index is retired with it: the
            // rows it owns go, and so does its bundle on disk. Only rows the
            // seed created are touched; anything published by a person stays.
            $indexed = [];
            foreach ($index as $entry) {
                if (!is_array($entry)) continue;
                $id = is_string($entry['id'] ?? null) ? $entry['id'] : Apps::slugify((string) ($entry['name'] ?? $entry['file'] ?? ''));
                if ($id !== '') $indexed[$id] = true;
            }
            $seeded=array_keys(array_filter(Catalog::all(),fn($a)=>$a['source']==='seed'));
            foreach ($seeded as $slug) {
                if (isset($indexed[$slug]) || isset($skipped[$slug])) continue;
                try {
                    Apps::remove((string) $slug);
                } catch (Throwable $e) {
                    error_log("softn-api: could not retire seed app $slug: " . $e->getMessage());
                }
            }
            @touch($flag);
        } finally {
            self::saveStamps($dir);
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }

    /**
     * A screenshot beside the bundle, taken by the build, is the demo's
     * picture: a card with the app on it, not an icon. It is stored when the
     * app is seeded and again whenever the file beside the bundle changes, so
     * a retaken screenshot shows up without the bundle having to change.
     *
     * Only over a picture the seed itself stored. The operator gives a demo
     * a picture of their own with the admin key, and the screenshot was put
     * back over it on the next request; `seed_thumb` is the digest of what
     * the seed last stored, and a picture that is not that one is theirs. A
     * demo from before this was recorded had the screenshot put back on every
     * request, so the picture it has is the seed's.
     */
    private static function refreshThumbnail(string $slug, string $demos, string $bundleFile): void
    {
        $base = preg_replace('/\.softn$/', '', $bundleFile);
        foreach (['webp', 'png', 'jpg'] as $ext) {
            $shot = "$demos/thumbs/$base.$ext";
            if (!is_file($shot)) continue;
            $current = glob(Apps::dir($slug) . '/thumb.*') ?: [];
            $shipped = self::sha($shot);
            $stored = Catalog::all()[$slug]['seed_thumb'] ?? null;
            if ($current !== []) {
                $have = self::sha($current[0]);
                if ($stored !== null && $have !== $stored) return;
                if ($have === $shipped) {
                    if ($stored !== $shipped) Catalog::patch($slug, ['seed_thumb' => $shipped]);
                    return;
                }
            }
            try {
                $bytes = (string) file_get_contents($shot);
                $mime = Images::sniff($bytes);
                if ($mime !== null) {
                    Apps::setThumbnail($slug, [$bytes, $mime]);
                    Catalog::patch($slug, ['seed_thumb' => $shipped]);
                }
            } catch (Throwable $e) {
                error_log("softn-api: could not store the screenshot for $slug: " . $e->getMessage());
            }
            return;
        }
    }
}
