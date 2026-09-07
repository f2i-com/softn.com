<?php
/**
 * A ready-made data/ from a folder of apps, without a web server.
 *
 *   php apps/softn-api/seed-folder.php --from <folder> --out <data dir>
 *
 * Runs the directory's own seeder over a folder in the shape scripts/softn-apps
 * builds (index.json beside the bundles, thumbs/ beside them) and writes what a
 * site's first request would have written: directory.sqlite with every app's
 * rows, apps/<slug>/v1.softn and thumb.* for each, config.json with a fresh
 * admin key and salt, the rules that keep the folder unserved. Upload the result
 * as data/ beside api/ and the directory is populated before its first visitor.
 * Run it again over the same output to bring it up to date with the folder.
 *
 * Command line only: the deployed API never executes this.
 */
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

$args = array_slice($argv, 1);
$opt = static function (string $name) use ($args): ?string {
    $i = array_search($name, $args, true);
    return $i !== false && isset($args[$i + 1]) ? (string) $args[$i + 1] : null;
};
$from = $opt('--from');
$out = $opt('--out');
if ($from === null || $out === null) {
    fwrite(STDERR, "Usage: php seed-folder.php --from <folder with index.json> --out <data directory>\n");
    exit(2);
}
$from = rtrim(str_replace('\\', '/', $from), '/');
if (!is_file("$from/index.json")) {
    fwrite(STDERR, "$from has no index.json: not a folder of apps (scripts/softn-apps builds one).\n");
    exit(2);
}
if (!is_dir($out) && !@mkdir($out, 0775, true)) {
    fwrite(STDERR, "cannot create $out\n");
    exit(1);
}
$out = realpath($out);
if ($out === false) {
    fwrite(STDERR, "cannot resolve the output directory\n");
    exit(1);
}

// The API keeps its state where SOFTN_DATA_DIR says; everything below is the
// API's own code, so what it writes is exactly what a first request writes.
putenv("SOFTN_DATA_DIR=$out");

require __DIR__ . '/lib/http.php';
require __DIR__ . '/lib/db.php';
require __DIR__ . '/lib/bundle.php';
require __DIR__ . '/lib/apps.php';
require __DIR__ . '/lib/social.php';
require __DIR__ . '/lib/storage.php';
require __DIR__ . '/lib/seed.php';
require __DIR__ . '/lib/pages.php';

try {
    Config::get('siteName'); // writes config.json, admin key and salt included, when absent
    Seed::ifEmpty($from);
    @unlink("$out/seed.lock");
    // The rules the site build ships beside a fresh data/: never served, and a note saying so.
    foreach (['.htaccess', 'README.txt'] as $name) {
        $src = __DIR__ . "/data/$name";
        if (is_file($src) && !is_file("$out/$name")) copy($src, "$out/$name");
    }
    $pdo = Db::catalog();
    $apps = (int) $pdo->query("SELECT COUNT(*) FROM apps WHERE source = 'seed'")->fetchColumn();
    $others = (int) $pdo->query("SELECT COUNT(*) FROM apps WHERE source != 'seed'")->fetchColumn();
    $pictures = 0;
    foreach ($pdo->query("SELECT slug FROM apps WHERE source = 'seed'")->fetchAll(PDO::FETCH_COLUMN) as $slug) {
        if (glob(Apps::dir((string) $slug) . '/thumb.*')) $pictures++;
    }
    $config = json_decode((string) file_get_contents("$out/config.json"), true);
    echo "$apps apps seeded into $out ($pictures with a picture" . ($others > 0 ? ", $others published by visitors kept" : '') . ")\n";
    echo "admin key: " . (is_array($config) && is_string($config['adminKey'] ?? null) ? $config['adminKey'] : '(see config.json)') . "\n";
    echo "Upload the folder as data/ beside api/ — never over a data/ that already holds visitors' apps.\n";
} catch (Throwable $e) {
    fwrite(STDERR, 'seed failed: ' . $e->getMessage() . "\n");
    exit(1);
}
