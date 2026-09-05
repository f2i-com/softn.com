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
    private const CATEGORY = [
        'snake-game' => 'games', 'pocket' => 'games', 'maze-escape-3d' => 'games', 'texas-holdem' => 'games',
        'promptly-unemployed' => 'games', 'the-office' => 'games', 'blockscape' => 'games', 'dead-hours' => 'games', 'twenty48' => 'games', 'blockfall' => 'games',
        'last-sound-3d' => 'games',
        'train-yard' => 'simulations', 'predator-prey' => 'simulations',
        'warble-wire' => 'tools', 'ai-chat' => 'ai', 'house-builder' => 'creative', 'sim-lives' => 'games',
        // Sample apps: they show what the runtime can do rather than being
        // things to rely on, and the directory files them as such.
        'notes' => 'demos', 'glamour-studio' => 'demos', 'device-kit' => 'demos', 'showcase' => 'demos',
        'gpu-demo' => 'demos', 'three-demo' => 'demos', 'ai-demo' => 'demos', 'foundation-fixture' => 'demos',
    ];

    private const TAGS = [
        'snake-game' => 'arcade,classic', 'pocket' => 'emulator,handheld,retro', 'maze-escape-3d' => '3d,maze',
        'texas-holdem' => 'cards,poker', 'promptly-unemployed' => 'story,comedy', 'last-sound-3d' => '3d,story,horror,voiced',
        'blockscape' => '3d,sandbox,voxel', 'dead-hours' => '3d,shooter,zombies', 'twenty48' => 'puzzle,classic', 'blockfall' => 'arcade,puzzle,classic',
        'the-office' => 'simulation', 'train-yard' => '3d,simulation,railway', 'predator-prey' => 'ecosystem,simulation,biology,3d',
        'notes' => 'notes,local-first', 'glamour-studio' => 'business,scheduling',
        'device-kit' => 'camera,qr,network', 'warble-wire' => 'audio,modem,dsp', 'ai-chat' => 'llm,chat',
        'house-builder' => '3d,floor-plan,architecture,design', 'sim-lives' => '3d,life-simulation,house,sandbox',
        'ai-demo' => 'llm', 'gpu-demo' => 'webgpu,compute', 'three-demo' => '3d,webgl', 'showcase' => 'components',
    ];

    public static function ifEmpty(): void
    {
        if (!Config::get('seedDemos', true)) return;
        $dir = Config::dataDir();
        $flag = "$dir/seeded";
        $pdo = Db::catalog();
        Categories::ensure();
        $demos = dirname(__DIR__, 2) . '/demos';
        if (!is_dir($demos)) {
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
            $pdo->prepare('UPDATE apps SET category = ? WHERE slug = ? AND category != ?')->execute([$cat, $slug, $cat]);
        }

        $existing = $pdo->query(<<<'SQL'
SELECT a.slug, a.name, v.size, v.sha256
FROM apps a
LEFT JOIN versions v ON a.slug = v.slug AND a.latest_version = v.version
SQL)->fetchAll(PDO::FETCH_ASSOC);

        $existingMap = [];
        foreach ($existing as $r) {
            $existingMap[$r['slug']] = $r;
        }

        // A second request arriving while this one seeds must not seed too.
        $lock = fopen("$dir/seed.lock", 'c');
        if ($lock === false || !flock($lock, LOCK_EX | LOCK_NB)) return;
        try {
            foreach ($index as $entry) {
                if (!is_array($entry) || !is_string($entry['file'] ?? null)) continue;
                $file = "$demos/" . basename($entry['file']);
                if (!is_file($file)) continue;
                $id = is_string($entry['id'] ?? null) ? $entry['id'] : Apps::slugify((string) ($entry['name'] ?? $entry['file']));
                $currentMeta = [
                    'slug' => $id,
                    'name' => is_string($entry['name'] ?? null) ? $entry['name'] : null,
                    'description' => is_string($entry['description'] ?? null) ? $entry['description'] : null,
                    'author' => 'SoftN',
                    'category' => self::CATEGORY[$id] ?? 'demos',
                    'tags' => self::TAGS[$id] ?? '',
                    'primary' => is_string($entry['primary'] ?? null) ? $entry['primary'] : null,
                ];

                if (isset($existingMap[$id])) {
                    // Check if bundle on disk was updated (size or sha256 changed)
                    $diskSize = filesize($file);
                    $dbSize = (int) ($existingMap[$id]['size'] ?? 0);
                    $dbSha = (string) ($existingMap[$id]['sha256'] ?? '');
                    if ($diskSize !== $dbSize || hash_file('sha256', $file) !== $dbSha) {
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
            $seeded = $pdo->query("SELECT slug FROM apps WHERE source = 'seed'")->fetchAll(PDO::FETCH_COLUMN);
            foreach ($seeded as $slug) {
                if (isset($indexed[$slug])) continue;
                try {
                    Apps::remove((string) $slug);
                } catch (Throwable $e) {
                    error_log("softn-api: could not retire seed app $slug: " . $e->getMessage());
                }
            }
            @touch($flag);
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }

    /**
     * A screenshot beside the bundle, taken by the build, is the demo's
     * picture: a card with the app on it, not an icon. It is stored when the
     * app is seeded and again whenever the file beside the bundle changes, so
     * a retaken screenshot shows up without the bundle having to change.
     */
    private static function refreshThumbnail(string $slug, string $demos, string $bundleFile): void
    {
        $base = preg_replace('/\.softn$/', '', $bundleFile);
        foreach (['webp', 'png', 'jpg'] as $ext) {
            $shot = "$demos/thumbs/$base.$ext";
            if (!is_file($shot)) continue;
            $current = glob(Apps::dir($slug) . '/thumb.*') ?: [];
            if ($current !== [] && hash_file('sha256', $current[0]) === hash_file('sha256', $shot)) return;
            try {
                $bytes = (string) file_get_contents($shot);
                $mime = Images::sniff($bytes);
                if ($mime !== null) Apps::setThumbnail($slug, [$bytes, $mime]);
            } catch (Throwable $e) {
                error_log("softn-api: could not store the screenshot for $slug: " . $e->getMessage());
            }
            return;
        }
    }
}
