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
        'notes' => 'productivity', 'glamour-studio' => 'productivity',
        'device-kit' => 'tools', 'warble-wire' => 'tools',
        'ai-chat' => 'ai', 'ai-demo' => 'ai',
        'gpu-demo' => 'experiments', 'three-demo' => 'experiments',
        'showcase' => 'demos', 'foundation-fixture' => 'demos',
    ];

    private const TAGS = [
        'snake-game' => 'arcade,classic', 'pocket' => 'emulator,handheld,retro', 'maze-escape-3d' => '3d,maze',
        'texas-holdem' => 'cards,poker', 'promptly-unemployed' => 'story,comedy',
        'blockscape' => '3d,sandbox,voxel', 'dead-hours' => '3d,shooter,zombies', 'twenty48' => 'puzzle,classic', 'blockfall' => 'arcade,puzzle,classic',
        'the-office' => 'simulation', 'notes' => 'notes,local-first', 'glamour-studio' => 'business,scheduling',
        'device-kit' => 'camera,qr,network', 'warble-wire' => 'audio,modem,dsp', 'ai-chat' => 'llm,chat',
        'ai-demo' => 'llm', 'gpu-demo' => 'webgpu,compute', 'three-demo' => '3d,webgl', 'showcase' => 'components',
    ];

    public static function ifEmpty(): void
    {
        if (!Config::get('seedDemos', true)) return;
        $dir = Config::dataDir();
        $flag = "$dir/seeded";
        if (is_file($flag)) return;
        $pdo = Db::catalog();
        Categories::ensure();
        if ((int) $pdo->query('SELECT COUNT(*) FROM apps')->fetchColumn() > 0) {
            @touch($flag);
            return;
        }
        $demos = dirname(__DIR__, 2) . '/demos';
        $indexPath = "$demos/index.json";
        if (!is_file($indexPath)) return;
        $index = json_decode((string) file_get_contents($indexPath), true);
        if (!is_array($index)) return;
        // A second request arriving while this one seeds must not seed too.
        $lock = fopen("$dir/seed.lock", 'c');
        if ($lock === false || !flock($lock, LOCK_EX | LOCK_NB)) return;
        try {
            if ((int) $pdo->query('SELECT COUNT(*) FROM apps')->fetchColumn() > 0) return;
            foreach ($index as $entry) {
                if (!is_array($entry) || !is_string($entry['file'] ?? null)) continue;
                $file = "$demos/" . basename($entry['file']);
                if (!is_file($file)) continue;
                $id = is_string($entry['id'] ?? null) ? $entry['id'] : Apps::slugify((string) ($entry['name'] ?? $entry['file']));
                try {
                    $created = Apps::create($file, [
                        'slug' => $id,
                        'name' => is_string($entry['name'] ?? null) ? $entry['name'] : null,
                        'description' => is_string($entry['description'] ?? null) ? $entry['description'] : null,
                        'author' => 'SoftN',
                        'category' => self::CATEGORY[$id] ?? 'demos',
                        'tags' => self::TAGS[$id] ?? '',
                        'primary' => is_string($entry['primary'] ?? null) ? $entry['primary'] : null,
                    ], 'seed');
                    // A screenshot beside the bundle, taken by the build, is the
                    // demo's picture: a card with the app on it, not an icon.
                    $base = preg_replace('/\.softn$/', '', basename($entry['file']));
                    foreach (['webp', 'png', 'jpg'] as $ext) {
                        $shot = "$demos/thumbs/$base.$ext";
                        if (is_file($shot)) {
                            $bytes = (string) file_get_contents($shot);
                            $mime = Images::sniff($bytes);
                            if ($mime !== null) Apps::setThumbnail($created['app']['slug'], [$bytes, $mime]);
                            break;
                        }
                    }
                } catch (Throwable $e) {
                    error_log("softn-api: could not seed $file: " . $e->getMessage());
                }
            }
            @touch($flag);
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }
}
