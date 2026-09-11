<?php
/**
 * Backup and restore of the directory's data folder, as a product
 * capability rather than a file copy (audit API-03 / QA-02).
 *
 *   php backup.php export  <dest.tar|dest.zip> [--data <dataDir>]
 *   php backup.php verify  <archive>
 *   php backup.php restore <archive> [--into <dataDir>] [--force]
 *
 * Export takes the catalogue lock — the same flock every API request takes,
 * so no request is reading or committing while the snapshot is made — and
 * writes every metadata file, bundle, picture and per-app database under
 * data/ into one archive, after checkpointing each SQLite file so its WAL
 * is folded in. It leaves out what is not data: the lock files, the
 * rebuildable bundle cache, the temp siblings a killed writer leaves
 * (`.json-…`, `.upload-…`), retired folders, and SQLite's shared memory.
 * The archive carries `softn-backup.json`: an inventory of every file with
 * its size and SHA-256, the apps and versions the metadata named, and a
 * digest of the inventory itself. Export verifies the archive it wrote
 * before it reports success.
 *
 * Verify reads an archive and checks every entry against that inventory:
 * a missing file, an extra file, a byte out of place or an edited manifest
 * is refused, with the first difference named.
 *
 * Restore verifies first and writes nothing when verification fails. It
 * extracts into a staging folder beside the destination, hashes what
 * landed, and only then takes the destination's catalogue lock and moves
 * the files in. The destination must be absent or empty (lock files and
 * README.txt do not count); `--force` replaces what is there instead. The
 * restored folder is then booted once, which rebuilds the bundle cache,
 * and the inventory the catalogue lists is compared with the one the
 * archive promised: every slug, every version's file and digest.
 *
 * The archive holds config.json — the admin key and the visitor-hash salt
 * — and every edit-key hash: keep it as private as data/ itself.
 *
 * Exit codes: 0 done, 1 usage or I/O failure, 2 refused (verification or a
 * destination that is not empty), 3 restored but the inventory differs.
 */
declare(strict_types=1);

foreach (['http', 'db', 'catalog', 'bundle', 'apps', 'storage', 'social'] as $lib) require __DIR__ . '/lib/' . $lib . '.php';

final class Backup
{
    public const MANIFEST = 'softn-backup.json';
    public const SCHEMA = 1;
    /** Names at the top of data/ that a restore may find in an "empty" destination. */
    private const HARMLESS = ['catalog.lock', 'config.lock', 'README.txt'];

    // ── Command line ───────────────────────────────────────────────────────

    public static function main(array $argv): int
    {
        $args = self::parse(array_slice($argv, 1));
        $command = $args['_'][0] ?? '';
        $target = $args['_'][1] ?? null;
        try {
            switch ($command) {
                case 'export':
                    if ($target === null) return self::usage();
                    return self::export(self::dataDir($args['data'] ?? null, false), $target);
                case 'verify':
                    if ($target === null) return self::usage();
                    $m = self::verify($target);
                    self::say(sprintf('%s verified: %d files, %s, %d apps, made %s', basename($target), count($m['files']), self::human($m['bytes']), count($m['apps']), $m['createdAt']));
                    return 0;
                case 'restore':
                    if ($target === null) return self::usage();
                    return self::restore($target, self::dataDir($args['into'] ?? null, true), isset($args['force']));
                default:
                    return self::usage();
            }
        } catch (Refused $e) {
            fwrite(STDERR, 'refused: ' . $e->getMessage() . "\n");
            return 2;
        } catch (Throwable $e) {
            fwrite(STDERR, 'failed: ' . $e->getMessage() . "\n");
            return 1;
        }
    }

    private static function usage(): int
    {
        fwrite(STDERR, "usage:\n  php backup.php export <dest.tar|dest.zip> [--data <dataDir>]\n  php backup.php verify <archive>\n  php backup.php restore <archive> [--into <dataDir>] [--force]\n");
        return 1;
    }

    /** `--name value`, `--flag`, and the positional rest under `_`. */
    private static function parse(array $argv): array
    {
        $out = ['_' => []];
        for ($i = 0; $i < count($argv); $i++) {
            $a = $argv[$i];
            if (str_starts_with($a, '--')) {
                $key = substr($a, 2);
                if ($key === 'force') { $out['force'] = true; continue; }
                $next = $argv[$i + 1] ?? null;
                if ($next === null || str_starts_with($next, '--')) throw new RuntimeException("--$key needs a value");
                $out[$key] = $next; $i++;
            } else $out['_'][] = $a;
        }
        return $out;
    }

    /**
     * The data directory: the option, else SOFTN_DATA_DIR, else data/ beside
     * api/ — the same default lib/http.php uses. Absolute, with forward
     * slashes; it need not exist for a restore.
     */
    private static function dataDir(?string $given, bool $mayBeMissing): string
    {
        $env = getenv('SOFTN_DATA_DIR');
        $dir = $given ?? (is_string($env) && $env !== '' ? $env : dirname(__DIR__) . '/data');
        if (!self::isAbsolute($dir)) $dir = getcwd() . '/' . $dir;
        $dir = rtrim(str_replace('\\', '/', $dir), '/');
        if (!$mayBeMissing && !is_dir($dir)) throw new RuntimeException("no data directory at $dir");
        return $dir;
    }

    private static function isAbsolute(string $p): bool
    {
        return str_starts_with($p, '/') || str_starts_with($p, '\\') || (bool) preg_match('#^[A-Za-z]:[/\\\\]#', $p);
    }

    private static function say(string $line): void { fwrite(STDOUT, $line . "\n"); }

    private static function human(int $bytes): string
    {
        if ($bytes >= 1048576) return sprintf('%.1f MB', $bytes / 1048576);
        if ($bytes >= 1024) return sprintf('%.0f KB', $bytes / 1024);
        return "$bytes bytes";
    }

    // ── Export ─────────────────────────────────────────────────────────────

    public static function export(string $dataDir, string $dest): int
    {
        $format = self::format($dest);
        if (!self::isAbsolute($dest)) $dest = getcwd() . '/' . $dest;
        if (file_exists($dest)) throw new Refused("$dest exists; choose another name or remove it first");
        $parent = dirname($dest);
        if (!is_dir($parent)) throw new RuntimeException("no folder to write into at $parent");
        $lock = self::lock($dataDir);
        try {
            self::checkpointDatabases($dataDir);
            $files = self::walk($dataDir);
            if (!$files) throw new Refused("nothing to back up under $dataDir");
            $manifest = self::manifest($dataDir, $files);
            // A temp sibling with the same extension (PharData insists), renamed
            // over the name asked for only once it is complete and verified.
            $tmp = "$parent/." . basename($dest) . '.partial-' . bin2hex(random_bytes(4)) . ".$format";
            try {
                self::writeArchive($tmp, $format, $dataDir, $files, $manifest);
                self::verify($tmp, $manifest);
                if (!rename($tmp, $dest)) throw new RuntimeException("cannot move the archive to $dest");
            } finally {
                if (is_file($tmp)) @unlink($tmp);
            }
        } finally {
            self::unlock($lock);
        }
        self::say(sprintf('exported %s: %d files, %s, %d apps', $dest, count($manifest['files']), self::human($manifest['bytes']), count($manifest['apps'])));
        return 0;
    }

    private static function format(string $path): string
    {
        $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
        if ($ext === 'tar' || $ext === 'zip') return $ext;
        throw new RuntimeException('the archive name must end in .tar or .zip');
    }

    /** @return array{0: resource, 1: resource} the catalogue lock and the configuration lock */
    private static function lock(string $dataDir): array
    {
        if (!is_dir($dataDir) && !mkdir($dataDir, 0775, true)) throw new RuntimeException("cannot create $dataDir");
        $out = [];
        foreach (['catalog.lock', 'config.lock'] as $name) {
            $f = fopen("$dataDir/$name", 'c');
            if (!$f || !flock($f, LOCK_EX)) throw new RuntimeException("cannot take $name in $dataDir");
            $out[] = $f;
        }
        return $out;
    }

    private static function unlock(array $locks): void
    {
        foreach ($locks as $f) { flock($f, LOCK_UN); fclose($f); }
    }

    /**
     * Fold each app database's WAL into its main file, so the copy of the
     * main file is the whole database. Under the catalogue lock no request
     * is writing, so the checkpoint completes; a database that will not
     * open is copied as it is, WAL beside it.
     */
    private static function checkpointDatabases(string $dataDir): void
    {
        foreach (glob("$dataDir/apps/*/storage.sqlite") ?: [] as $db) {
            if (is_link($db)) continue;
            try {
                $pdo = new PDO('sqlite:' . $db, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
                $pdo->exec('PRAGMA busy_timeout=5000');
                $pdo->query('PRAGMA wal_checkpoint(TRUNCATE)')->fetchAll();
                $pdo = null;
            } catch (Throwable $e) {
                fwrite(STDERR, "note: could not checkpoint $db (" . $e->getMessage() . "); copying it as it is\n");
            }
        }
    }

    /** What an export leaves out, by top-level or basename. */
    private static function excluded(string $rel, string $name, bool $isDir): bool
    {
        if ($rel === 'catalog.lock' || $rel === 'config.lock' || $rel === self::MANIFEST) return true;
        if ($rel === 'cache' && $isDir) return true;
        if (preg_match('/^\.(json|upload|retired)-/', $name)) return true;
        if (str_ends_with($name, '-shm') || str_ends_with($name, '-journal')) return true;
        return false;
    }

    /**
     * Every regular file under the data directory, as `path => bytes`, paths
     * relative with forward slashes, sorted. Symlinks are left out and said.
     * @return array<string, int>
     */
    private static function walk(string $dataDir): array
    {
        $out = [];
        $visit = function (string $dir, string $prefix) use (&$visit, &$out): void {
            foreach (scandir($dir) ?: [] as $name) {
                if ($name === '.' || $name === '..') continue;
                $path = "$dir/$name"; $rel = $prefix === '' ? $name : "$prefix/$name";
                if (is_link($path)) { fwrite(STDERR, "note: skipping symlink $rel\n"); continue; }
                $isDir = is_dir($path);
                if (self::excluded($rel, $name, $isDir)) continue;
                if ($isDir) { $visit($path, $rel); continue; }
                if (!is_file($path)) continue;
                if (str_ends_with($name, '-wal') && filesize($path) === 0) continue;
                self::checkPath($rel);
                $out[$rel] = (int) filesize($path);
            }
        };
        $visit($dataDir, '');
        ksort($out, SORT_STRING);
        return $out;
    }

    /** A path an archive may carry: relative, forward slashes, no `..`, no drive, no control characters. */
    private static function checkPath(string $rel): void
    {
        if ($rel === '' || str_starts_with($rel, '/') || str_contains($rel, '\\') || preg_match('/[\x00-\x1f\x7f]/', $rel) || preg_match('#^[A-Za-z]:#', $rel)) throw new Refused("unsafe path in inventory: $rel");
        foreach (explode('/', $rel) as $segment) if ($segment === '' || $segment === '.' || $segment === '..') throw new Refused("unsafe path in inventory: $rel");
    }

    /**
     * The inventory: every file with its size and digest, the apps and
     * versions app.json names, and a digest over the file list so an edit
     * to the manifest itself is caught.
     * @param array<string, int> $files
     */
    private static function manifest(string $dataDir, array $files): array
    {
        $list = []; $bytes = 0;
        foreach ($files as $rel => $size) {
            $sha = hash_file('sha256', "$dataDir/$rel");
            if ($sha === false) throw new RuntimeException("cannot read $rel");
            $list[] = ['path' => $rel, 'bytes' => $size, 'sha256' => $sha];
            $bytes += $size;
        }
        $apps = [];
        foreach ($files as $rel => $size) {
            if (!preg_match('#^apps/([^/]+)/([^/]+)$#', $rel, $m)) continue;
            [, $slug, $name] = $m;
            $apps[$slug] ??= ['slug' => $slug, 'versions' => []];
            if ($name === 'app.json') {
                $doc = json_decode((string) file_get_contents("$dataDir/$rel"), true);
                foreach (is_array($doc['versions'] ?? null) ? $doc['versions'] : [] as $v) {
                    if (is_array($v) && isset($v['version'], $v['file'], $v['sha256'])) $apps[$slug]['versions'][] = ['version' => (int) $v['version'], 'file' => (string) $v['file'], 'sha256' => (string) $v['sha256']];
                }
            }
        }
        ksort($apps, SORT_STRING);
        return [
            'schemaVersion' => self::SCHEMA,
            'createdAt' => gmdate('c'),
            'php' => PHP_VERSION,
            'files' => $list,
            'bytes' => $bytes,
            'apps' => array_values($apps),
            'digest' => self::digest($list),
        ];
    }

    /** sha256 over "sha256  bytes  path" lines in path order, like a checksum file. */
    private static function digest(array $list): string
    {
        usort($list, fn($a, $b) => strcmp($a['path'], $b['path']));
        $text = '';
        foreach ($list as $f) $text .= "{$f['sha256']}  {$f['bytes']}  {$f['path']}\n";
        return hash('sha256', $text);
    }

    /** @param array<string, int> $files */
    private static function writeArchive(string $path, string $format, string $dataDir, array $files, array $manifest): void
    {
        $json = json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR) . "\n";
        if ($format === 'zip') {
            $zip = new ZipArchive();
            if ($zip->open($path, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) throw new RuntimeException("cannot create $path");
            foreach (array_keys($files) as $rel) if (!$zip->addFile("$dataDir/$rel", $rel)) throw new RuntimeException("cannot add $rel");
            $zip->addFromString(self::MANIFEST, $json);
            if (!$zip->close()) throw new RuntimeException("cannot finish $path");
            return;
        }
        $tar = new PharData($path);
        foreach (array_keys($files) as $rel) $tar->addFile("$dataDir/$rel", $rel);
        $tar->addFromString(self::MANIFEST, $json);
        unset($tar);
    }

    // ── Verify ─────────────────────────────────────────────────────────────

    /**
     * Read an archive and check it against its own inventory, or against
     * the one just written. Returns the manifest. Throws Refused on the
     * first difference; nothing is written.
     */
    public static function verify(string $archive, ?array $expected = null): array
    {
        if (!is_file($archive)) throw new RuntimeException("no archive at $archive");
        $format = self::format($archive);
        $reader = new Reader($archive, $format);
        $entries = $reader->entries();
        if (!isset($entries[self::MANIFEST])) throw new Refused('the archive has no ' . self::MANIFEST);
        $manifest = json_decode($reader->read(self::MANIFEST), true);
        if (!is_array($manifest) || ($manifest['schemaVersion'] ?? null) !== self::SCHEMA || !is_array($manifest['files'] ?? null) || !is_string($manifest['digest'] ?? null)) throw new Refused('the manifest is not a softn backup manifest');
        if ($expected !== null && $expected['digest'] !== $manifest['digest']) throw new Refused('the manifest written is not the manifest read back');
        $list = [];
        foreach ($manifest['files'] as $f) {
            if (!is_array($f) || !is_string($f['path'] ?? null) || !is_int($f['bytes'] ?? null) || !is_string($f['sha256'] ?? null) || !preg_match('/^[0-9a-f]{64}$/', $f['sha256'])) throw new Refused('the manifest lists a file badly');
            self::checkPath($f['path']);
            if (isset($list[$f['path']])) throw new Refused("the manifest lists {$f['path']} twice");
            $list[$f['path']] = $f;
        }
        if (self::digest(array_values($list)) !== $manifest['digest']) throw new Refused('the manifest has been altered: its digest does not match its file list');
        unset($entries[self::MANIFEST]);
        foreach ($entries as $name => $size) {
            if (!isset($list[$name])) throw new Refused("the archive holds $name, which the manifest does not list");
        }
        foreach ($list as $name => $f) {
            if (!isset($entries[$name])) throw new Refused("the manifest lists $name, which the archive does not hold");
            if ($entries[$name] !== $f['bytes']) throw new Refused("$name is {$entries[$name]} bytes; the manifest says {$f['bytes']}");
            if ($reader->sha256($name) !== $f['sha256']) throw new Refused("$name does not match its digest");
        }
        $manifest['files'] = array_values($list);
        $manifest['bytes'] = (int) ($manifest['bytes'] ?? array_sum(array_column($list, 'bytes')));
        $manifest['apps'] = is_array($manifest['apps'] ?? null) ? $manifest['apps'] : [];
        $manifest['createdAt'] = is_string($manifest['createdAt'] ?? null) ? $manifest['createdAt'] : '?';
        return $manifest;
    }

    // ── Restore ────────────────────────────────────────────────────────────

    public static function restore(string $archive, string $dest, bool $force): int
    {
        $manifest = self::verify($archive);
        $reader = new Reader($archive, self::format($archive));
        $parent = dirname($dest);
        if (!is_dir($parent) && !mkdir($parent, 0775, true)) throw new RuntimeException("cannot create $parent");
        if (is_file($dest)) throw new Refused("$dest is a file");
        if (is_dir($dest) && !$force) {
            $present = array_values(array_diff(scandir($dest) ?: [], ['.', '..', ...self::HARMLESS]));
            if ($present) throw new Refused("$dest is not empty (" . implode(', ', array_slice($present, 0, 5)) . (count($present) > 5 ? ', …' : '') . "); pass --force to replace its contents");
        }
        // Stage beside the destination, so the final step is renames on one volume.
        $staging = "$parent/.softn-restore-" . bin2hex(random_bytes(4));
        if (!mkdir($staging, 0775, true)) throw new RuntimeException("cannot create $staging");
        try {
            foreach ($manifest['files'] as $f) {
                $to = "$staging/{$f['path']}";
                if (!is_dir(dirname($to)) && !mkdir(dirname($to), 0775, true)) throw new RuntimeException("cannot create " . dirname($to));
                $reader->extract($f['path'], $to);
                if (filesize($to) !== $f['bytes'] || hash_file('sha256', $to) !== $f['sha256']) throw new Refused("{$f['path']} did not extract as the manifest says");
            }
            $locks = self::lock($dest);
            try {
                if ($force) self::clear($dest);
                foreach (scandir($staging) ?: [] as $name) {
                    if ($name === '.' || $name === '..') continue;
                    if (file_exists("$dest/$name")) throw new RuntimeException("$dest/$name appeared while restoring; the staged files are at $staging");
                    if (!rename("$staging/$name", "$dest/$name")) throw new RuntimeException("cannot move $name into $dest; the staged files are at $staging");
                }
            } finally {
                self::unlock($locks);
            }
            @rmdir($staging);
        } catch (Throwable $e) {
            self::removeTree($staging, false);
            throw $e;
        }
        self::say(sprintf('restored %d files (%s) into %s', count($manifest['files']), self::human($manifest['bytes']), $dest));
        return self::rebuild($dest, $manifest);
    }

    /** Empty a destination for --force: everything but the lock files and README.txt. */
    private static function clear(string $dest): void
    {
        foreach (scandir($dest) ?: [] as $name) {
            if ($name === '.' || $name === '..' || in_array($name, self::HARMLESS, true)) continue;
            self::removeTree("$dest/$name", true);
        }
    }

    private static function removeTree(string $path, bool $strict): void
    {
        if (is_link($path) || is_file($path)) { if (!@unlink($path) && $strict) throw new RuntimeException("cannot remove $path"); return; }
        if (!is_dir($path)) return;
        foreach (scandir($path) ?: [] as $name) if ($name !== '.' && $name !== '..') self::removeTree("$path/$name", $strict);
        if (!@rmdir($path) && $strict) throw new RuntimeException("cannot remove $path");
    }

    /**
     * Boot the restored catalogue once — the bundle cache is rebuilt and any
     * app.json completed — and compare what it lists with what the archive
     * promised: the same slugs, and for each, the same version files with
     * the same digests.
     */
    private static function rebuild(string $dest, array $manifest): int
    {
        putenv('SOFTN_DATA_DIR=' . $dest);
        Catalog::boot();
        $rows = Catalog::all();
        $skipped = Catalog::skipped();
        $hashes = [];
        foreach ($manifest['files'] as $f) $hashes[$f['path']] = $f['sha256'];
        $problems = [];
        foreach ($manifest['apps'] as $app) {
            $slug = (string) ($app['slug'] ?? '');
            if (!isset($rows[$slug])) {
                if (isset($skipped[$slug])) $problems[] = "$slug was skipped: {$skipped[$slug]}";
                elseif ($app['versions'] ?? []) $problems[] = "$slug is not listed";
                continue;
            }
            $doc = Catalog::doc($slug);
            $have = [];
            foreach ($doc['versions'] as $v) $have[(int) $v['version']] = $v;
            foreach ($app['versions'] as $v) {
                $number = (int) $v['version'];
                if (!isset($have[$number])) { $problems[] = "$slug version $number is missing"; continue; }
                if ($have[$number]['file'] !== $v['file'] || $have[$number]['sha256'] !== $v['sha256']) $problems[] = "$slug version $number differs from the archive's metadata";
                $archived = $hashes["apps/$slug/{$v['file']}"] ?? null;
                if ($archived !== $have[$number]['sha256']) $problems[] = "$slug/{$v['file']} on disk is not the archived bundle";
            }
        }
        $versions = 0;
        foreach ($rows as $slug => $row) $versions += count(Catalog::doc($slug)['versions']);
        Catalog::release();
        self::say(sprintf('rebuilt: %d apps listed, %d versions, %d folders skipped', count($rows), $versions, count($skipped)));
        foreach ($problems as $p) fwrite(STDERR, "inventory: $p\n");
        if ($problems) { fwrite(STDERR, "the restored catalogue does not list what the archive promised\n"); return 3; }
        self::say('inventory matches the archive');
        return 0;
    }
}

/** A verification failure or a refusal to overwrite: exit 2, nothing written. */
final class Refused extends RuntimeException {}

/** One way to read entries from either archive format. */
final class Reader
{
    private ?ZipArchive $zip = null;
    private string $phar = '';

    public function __construct(string $path, string $format)
    {
        if ($format === 'zip') {
            $this->zip = new ZipArchive();
            if ($this->zip->open($path, ZipArchive::RDONLY) !== true) throw new Refused("$path does not open as a zip archive");
            return;
        }
        $real = realpath($path);
        if ($real === false) throw new RuntimeException("no archive at $path");
        try { new PharData($real); } catch (Throwable $e) { throw new Refused("$path does not open as a tar archive: " . $e->getMessage()); }
        $this->phar = 'phar://' . str_replace('\\', '/', $real);
    }

    /** Every file entry as `path => bytes`; directory entries are not files. @return array<string, int> */
    public function entries(): array
    {
        $out = [];
        if ($this->zip !== null) {
            for ($i = 0; $i < $this->zip->numFiles; $i++) {
                $st = $this->zip->statIndex($i);
                if ($st === false || str_ends_with($st['name'], '/')) continue;
                $out[str_replace('\\', '/', $st['name'])] = (int) $st['size'];
            }
            return $out;
        }
        $it = new RecursiveIteratorIterator(new PharData(substr($this->phar, 7)));
        $base = $this->phar . '/';
        foreach ($it as $file) {
            if (!$file->isFile()) continue;
            $name = substr(str_replace('\\', '/', $file->getPathname()), strlen($base));
            $out[$name] = (int) $file->getSize();
        }
        return $out;
    }

    /** @return resource */
    private function stream(string $name)
    {
        $s = $this->zip !== null ? $this->zip->getStream($name) : @fopen("{$this->phar}/$name", 'rb');
        if (!$s) throw new Refused("cannot read $name from the archive");
        return $s;
    }

    public function read(string $name): string
    {
        $s = $this->stream($name);
        try { return (string) stream_get_contents($s); } finally { fclose($s); }
    }

    public function sha256(string $name): string
    {
        $s = $this->stream($name);
        try { $h = hash_init('sha256'); hash_update_stream($h, $s); return hash_final($h); } finally { fclose($s); }
    }

    public function extract(string $name, string $to): void
    {
        $in = $this->stream($name);
        try {
            $out = fopen($to, 'wb');
            if (!$out) throw new RuntimeException("cannot write $to");
            try { if (stream_copy_to_stream($in, $out) === false) throw new RuntimeException("cannot write $to"); } finally { fclose($out); }
        } finally { fclose($in); }
    }
}

if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
exit(Backup::main($argv));
