<?php
/**
 * What the directory learns from a .softn before it agrees to keep it.
 *
 * A bundle is a zip: manifest.json with a name, a version and an entry file;
 * optionally permission.json, which is the app's own declaration of what it
 * will ask the runtime for, and an icon. The archive is read in place and
 * never extracted here. It is read the way the runtime's reader reads it
 * (see inspect), so that what the directory lists is what the browser runs;
 * the rest of the checks are about what the directory is willing to store
 * and show, not about what the bundle can do.
 */
declare(strict_types=1);

final class Bundle
{
    public const MAX_ENTRIES = 4000;
    public const MAX_UNCOMPRESSED = 128 * 1024 * 1024;
    public const MAX_ICON_BYTES = 512 * 1024;
    /**
     * The two JSON files are decoded whole, so they are capped before they
     * are read: the 128 MB expansion limit alone let a 122 KB upload carry
     * a 120 MB manifest, and decoding it exhausted memory — a fatal no
     * catch sees — on every request that inspected the bundle.
     */
    public const MAX_MANIFEST_BYTES = 256 * 1024;
    public const MAX_PERMISSION_BYTES = 64 * 1024;
    /**
     * The capability schema, as the runtime has it: one name for each thing a
     * bundle's permission.json may ask for, in the order the app page lists
     * them. This is a copy of packages/@softn/core/src/runtime/capabilities.ts
     * — PHP cannot import it — and apps/softn-web/test/capability-schema.test.ts
     * fails when the two disagree. It once did: this list lacked `accel` for
     * months, so an app asking for host acceleration was listed as asking for
     * nothing of the kind.
     */
    public const CAPABILITY_SCHEMA_VERSION = 2;
    public const CAPABILITIES = ['net', 'camera', 'mic', 'files', 'qr', 'ai', 'gpu', 'sync', 'storage', 'accel'];
    /**
     * A storage collection name, or `*` for every collection not named. `D`
     * because `$` alone also matches before a final line break: "scores\n"
     * was a name, listed beside the collection it only looked like.
     */
    private const COLLECTION_NAME = '/^(?:\*|[a-z][a-z0-9_]{0,31})$/D';

    /**
     * The runtime's own limits (packages/@softn/bundle-format/src/zip.ts). A
     * bundle past one of them does not open in the browser, so it is not
     * taken here either; where the directory's limits above are tighter,
     * they are met first.
     */
    private const RUNTIME_MAX_INPUT = 200 * 1024 * 1024;
    private const RUNTIME_MAX_ENTRIES = 10000;
    private const RUNTIME_MAX_FILE = 50 * 1024 * 1024;
    private const RUNTIME_MAX_TOTAL = 500 * 1024 * 1024;
    /**
     * How much of a compressed entry is fed to the inflater at a time while
     * it is checked. Deflate expands at most 1032 to 1, so this is also the
     * most one step can produce (about 17 MB) before the running total is
     * compared with what the entry declared.
     */
    private const INFLATE_SLICE = 16 * 1024;

    /**
     * Read a bundle the way the runtime reads it, and refuse what it refuses.
     *
     * The directory lists what PHP reads (the name, the capabilities, the
     * storage policies) and the browser runs what the runtime's reader reads.
     * PHP's ZipArchive is libzip, and libzip and that reader used to disagree
     * about some archives: a second end record or a ZIP64 one, a gap before
     * the end record, a count the directory's size does not hold, an entry
     * renamed by an Info-ZIP Unicode Path field, an entry flagged encrypted
     * in one header only, a stream longer than its entry declares. Each
     * could make the directory list one app while the browser ran another,
     * or ran nothing. So the archive is first walked here exactly
     * as the runtime walks it (centralDirectory below is a port of its
     * readCentralDirectory), with the same refusals; libzip must then see the
     * same entries under the same names, because the source viewer and the
     * pages still read stored bundles through it; and every file's bytes are
     * inflated and checked against its declared size and checksum, as the
     * runtime does when it reads them. The manifest, the declaration and the
     * icon are read from those checked bytes.
     *
     * @return array{
     *   manifest: array<string, mixed>, name: string, version: string, description: string,
     *   capabilities: string[], storagePolicies: array<string, string>, execution: string, icon: array{0: string, 1: string}|null,
     *   size: int, sha256: string, entries: int
     * }
     */
    public static function inspect(string $path): array
    {
        if (!class_exists('ZipArchive')) throw new ApiError(503, 'This server\'s PHP has no zip extension, which the directory needs to read bundles.');
        if (!function_exists('inflate_init')) throw new ApiError(503, 'This server\'s PHP has no zlib extension, which the directory needs to check bundles.');
        $size = (int) filesize($path);
        if ($size < 22) throw new ApiError(400, 'That is not a .softn bundle.');
        if ($size > self::RUNTIME_MAX_INPUT) throw new ApiError(400, 'The bundle is larger than 200 MB, which the runtime does not open.');
        $handle = fopen($path, 'rb');
        if ($handle === false) throw new ApiError(500, 'The bundle could not be read.');
        $zip = null;
        try {
            // The runtime's reading first, so a refusal names what the
            // runtime would refuse rather than what libzip made of it.
            $entries = self::centralDirectory($handle, $size);
            $zip = new ZipArchive();
            if ($zip->open($path, ZipArchive::RDONLY) !== true) {
                $zip = null;
                throw new ApiError(400, 'That is not a .softn bundle: the archive does not open.');
            }
            $count = $zip->numFiles;
            if ($count === 0) throw new ApiError(400, 'The bundle is empty.');
            if ($count > self::MAX_ENTRIES) throw new ApiError(400, 'The bundle has more than ' . self::MAX_ENTRIES . ' files.');
            if (count($entries) !== $count) {
                throw new ApiError(400, 'ZIP readers disagree about how many files the bundle holds (' . count($entries) . " or $count). Zip it again with an ordinary tool.");
            }
            $total = 0;
            /** @var array<string, array{name: string, crc: int, method: int, compressed: int, size: int, offset: int}> $files */
            $files = [];
            foreach ($entries as $i => $entry) {
                $name = $entry['name'];
                if (!mb_check_encoding($name, 'UTF-8')) throw new ApiError(400, 'The bundle has an entry whose name is not UTF-8 text. Zip it with a tool that writes UTF-8 names.');
                // The runtime reads a backslash as a slash; the directory has
                // always refused such names rather than store a bundle whose
                // paths read one way here and another in every other reader.
                if (str_contains($name, '\\')) throw new ApiError(400, "The bundle has an entry whose path is written with backslashes: $name. Zip the bundle with forward slashes.");
                if (self::unsafeName($name)) throw new ApiError(400, "The bundle has an entry with an unsafe path: $name");
                $stat = $zip->statIndex($i);
                if ($stat === false || (string) $stat['name'] !== $name) {
                    throw new ApiError(400, "ZIP readers disagree about the name of the bundle's entry $name. Zip it again with an ordinary tool.");
                }
                if ((int) $stat['encryption_method'] !== ZipArchive::EM_NONE) throw new ApiError(400, 'The bundle has an encrypted entry.');
                $total += $entry['size'];
                if ($total > self::MAX_UNCOMPRESSED) throw new ApiError(400, 'The bundle expands to more than 128 MB.');
                if (!str_ends_with($name, '/')) $files[$name] = $entry;
            }
            // The two JSON files are decoded whole, so they are refused by
            // their declared size before a byte of anything is inflated.
            if (!isset($files['manifest.json'])) throw new ApiError(400, 'The bundle has no manifest.json.');
            $caps = ['manifest.json' => self::MAX_MANIFEST_BYTES, 'permission.json' => self::MAX_PERMISSION_BYTES];
            foreach ($caps as $file => $max) {
                if (isset($files[$file]) && $files[$file]['size'] > $max) throw new ApiError(400, "The bundle's $file is larger than " . intdiv($max, 1024) . ' KB.');
            }
            $kept = [];
            foreach ($files as $name => $entry) {
                $bytes = self::readEntry($handle, $entry, isset($caps[$name]));
                if ($bytes !== null) $kept[$name] = $bytes;
            }
            $manifest = json_decode(self::jsonText($kept['manifest.json']), true, 32);
            if (!is_array($manifest)) throw new ApiError(400, 'The bundle\'s manifest.json is not valid JSON.');
            $name = Text::clean(is_string($manifest['name'] ?? null) ? $manifest['name'] : '', 64);
            if ($name === '') throw new ApiError(400, 'The manifest has no name.');
            $version = Text::clean(is_string($manifest['version'] ?? null) ? $manifest['version'] : '', 32);
            if ($version === '') throw new ApiError(400, 'The manifest has no version.');
            $main = is_string($manifest['main'] ?? null) ? $manifest['main'] : '';
            if ($main === '') throw new ApiError(400, 'The manifest names no entry file (main).');
            if (!isset($files[$main])) throw new ApiError(400, "The manifest's entry file is not in the bundle: $main");
            $description = Text::clean(is_string($manifest['description'] ?? null) ? $manifest['description'] : '', 600, true);

            $capabilities = [];
            $storagePolicies = [];
            if (isset($kept['permission.json'])) ['capabilities' => $capabilities, 'storagePolicies' => $storagePolicies] = self::readDeclaration($kept['permission.json']);
            else $capabilities = self::legacyCapabilities($manifest['permissions'] ?? null);
            $execution = 'main';
            $config = is_array($manifest['config'] ?? null) ? $manifest['config'] : [];
            if (($config['execution'] ?? null) === 'worker') $execution = 'worker';

            $icon = null;
            $iconPath = is_string($manifest['icon'] ?? null) ? $manifest['icon'] : '';
            if ($iconPath !== '' && isset($files[$iconPath]) && $files[$iconPath]['size'] <= self::MAX_ICON_BYTES) {
                $bytes = (string) self::readEntry($handle, $files[$iconPath], true);
                $mime = Images::sniff($bytes);
                // The icon is the card's picture when there is no
                // thumbnail, so it is held to the thumbnail's budget:
                // a few hundred bytes of PNG can claim ten gigapixels
                // to every browser that lists the app. One past it is
                // left out, as an icon that is not an image is.
                if ($mime !== null) {
                    try {
                        Images::checkBudget(@getimagesizefromstring($bytes));
                    } catch (ApiError) {
                        $mime = null;
                    }
                } elseif (preg_match('/\.svg$/i', $iconPath) && self::safeSvg($bytes)) {
                    $mime = 'image/svg+xml';
                }
                if ($mime !== null) $icon = [$bytes, $mime];
            }
        } finally {
            fclose($handle);
            $zip?->close();
        }
        return [
            'manifest' => $manifest,
            'name' => $name,
            'version' => $version,
            'description' => $description,
            'capabilities' => $capabilities,
            'storagePolicies' => $storagePolicies,
            'execution' => $execution,
            'icon' => $icon,
            'size' => $size,
            'sha256' => hash_file('sha256', $path) ?: '',
            'entries' => $count,
        ];
    }

    /**
     * A bundle's JSON file as the text to decode. An editor may put a UTF-8
     * byte order mark in front of it; the runtime's TextDecoder drops one,
     * and json_decode refused the file for it, so the directory refused a
     * bundle every browser runs. One is dropped here too, and only one, as
     * there.
     */
    public static function jsonText(string $bytes): string
    {
        return str_starts_with($bytes, "\xEF\xBB\xBF") ? substr($bytes, 3) : $bytes;
    }

    /**
     * What a bundle with no permission.json asks for in the older
     * `permissions` block of its manifest, read as the runtime reads it
     * (extractPermissions in packages/@softn/core/src/bundle/manifest.ts):
     * `network` is net and `filesystem` is files, each when its value is
     * one JavaScript counts as true; the other names there gated nothing and
     * are dropped. The directory read none of it, and listed such an app as
     * asking for nothing while its play page asked for the network.
     *
     * @return string[]
     */
    private static function legacyCapabilities(mixed $legacy): array
    {
        if (!is_array($legacy)) return [];
        $truthy = static fn(mixed $v): bool => $v !== null && $v !== false && $v !== 0 && $v !== 0.0 && $v !== '';
        $capabilities = [];
        if ($truthy($legacy['network'] ?? null)) $capabilities[] = 'net';
        if ($truthy($legacy['filesystem'] ?? null)) $capabilities[] = 'files';
        return $capabilities;
    }

    /**
     * The archive's entries, walked as the runtime's reader walks them
     * (readCentralDirectory in packages/@softn/bundle-format/src/zip.ts), and
     * refused where it refuses, in the same order, with the reason in words.
     * Keep the two together: a check added there needs its line here.
     *
     * @param resource $handle
     * @return list<array{name: string, crc: int, method: int, compressed: int, size: int, offset: int}>
     *   in central-directory order; `name` as written, `offset` where the entry's bytes begin
     */
    private static function centralDirectory($handle, int $fileSize): array
    {
        // The end record is the last signature in the final 64 KB whose
        // directory fits in front of it. The scan goes on past it, because
        // libzip weighs every record there and may take another: two records
        // that each name a directory with entries are two archives in one.
        $tailStart = max(0, $fileSize - (22 + 0xffff));
        $tail = self::bytesAt($handle, $tailStart, $fileSize - $tailStart);
        $end = -1;
        for ($i = strlen($tail) - 22; $i >= 0; $i--) {
            if ($tail[$i] !== 'P' || substr_compare($tail, "PK\x05\x06", $i, 4) !== 0) continue;
            $at = $tailStart + $i;
            $dirSize = self::u32($tail, $i + 12);
            $dirOffset = self::u32($tail, $i + 16);
            if ($dirOffset + $dirSize > $at) continue;
            if ($end < 0) {
                $end = $at;
                continue;
            }
            if (self::u16($tail, $i + 10) > 0 && $dirOffset + 4 <= $at && self::bytesAt($handle, $dirOffset, 4) === "PK\x01\x02") {
                throw new ApiError(400, 'The bundle has more than one end record naming a central directory, so ZIP readers differ on which files it holds.');
            }
        }
        if ($end < 0) throw new ApiError(400, 'That is not a .softn bundle: the archive has no end record.');
        if ($end >= 20 && self::bytesAt($handle, $end - 20, 4) === "PK\x06\x07") {
            throw new ApiError(400, 'The bundle carries a ZIP64 end record, which the runtime does not read, and readers that do take their directory from it. Zip it without ZIP64.');
        }
        $record = self::bytesAt($handle, $end, 22);
        $count = self::u16($record, 8);
        if ($count !== self::u16($record, 10)) throw new ApiError(400, 'The bundle\'s end record gives two different counts of its entries.');
        $dirOffset = self::u32($record, 16);
        $dirEnd = $dirOffset + self::u32($record, 12);
        if ($dirEnd !== $end) {
            throw new ApiError(400, 'The bundle\'s central directory does not end where its end record begins. Some ZIP readers move every entry by the gap, so they read other files from it.');
        }
        if ($count > self::RUNTIME_MAX_ENTRIES) throw new ApiError(400, 'The bundle has more than ' . self::RUNTIME_MAX_ENTRIES . ' entries, which the runtime does not open.');
        $dir = self::bytesAt($handle, $dirOffset, $dirEnd - $dirOffset);
        $length = strlen($dir);
        $countAndSize = 'The bundle\'s central directory does not hold the number of entries its end record gives.';
        $entries = [];
        $localHeaders = [];
        $names = [];
        $totalCompressed = 0;
        $totalSize = 0;
        $at = 0;
        for ($n = 0; $n < $count; $n++) {
            if ($at + 46 > $length) throw new ApiError(400, $countAndSize);
            if (substr_compare($dir, "PK\x01\x02", $at, 4) !== 0) throw new ApiError(400, 'The bundle\'s central directory is damaged.');
            $flags = self::u16($dir, $at + 8);
            $method = self::u16($dir, $at + 10);
            $crc = self::u32($dir, $at + 16);
            $compressed = self::u32($dir, $at + 20);
            $declared = self::u32($dir, $at + 24);
            $nameLength = self::u16($dir, $at + 28);
            $extraLength = self::u16($dir, $at + 30);
            $recordEnd = $at + 46 + $nameLength + $extraLength + self::u16($dir, $at + 32);
            $local = self::u32($dir, $at + 42);
            if ($recordEnd > $length) throw new ApiError(400, $countAndSize);
            $written = substr($dir, $at + 46, $nameLength);
            if ($compressed === 0xffffffff || $declared === 0xffffffff) throw new ApiError(400, 'The bundle is a ZIP64 archive, which the runtime does not read. Zip it without ZIP64.');
            if ($flags & 1) throw new ApiError(400, 'The bundle has an encrypted entry.');
            if ($method !== 0 && $method !== 8) throw new ApiError(400, "The bundle's entry $written is compressed with method $method; the runtime reads stored and deflated entries only.");
            if ($method === 0 && $compressed !== $declared) throw new ApiError(400, "The bundle's entry $written is stored, but declares two different sizes.");
            if ($declared > self::RUNTIME_MAX_FILE) throw new ApiError(400, "The bundle's entry $written is larger than 50 MB, which the runtime does not read.");
            if (isset($localHeaders[$local])) throw new ApiError(400, 'Two of the bundle\'s entries point at the same bytes.');
            $localHeaders[$local] = true;
            $totalCompressed += $compressed;
            if ($totalCompressed > $fileSize) throw new ApiError(400, 'The bundle\'s entries claim more data than the file holds.');
            $totalSize += $declared;
            if ($totalSize > self::RUNTIME_MAX_TOTAL) throw new ApiError(400, 'The bundle expands to more than 500 MB, which the runtime does not open.');
            if ($local + 30 > $fileSize) throw new ApiError(400, "The bundle's entry $written has no local header.");
            $header = self::bytesAt($handle, $local, 30);
            if (substr($header, 0, 4) !== "PK\x03\x04") throw new ApiError(400, "The bundle's entry $written has no local header.");
            if (self::u16($header, 6) & 1) throw new ApiError(400, 'The bundle has an encrypted entry.');
            $data = $local + 30 + self::u16($header, 26) + self::u16($header, 28);
            if ($data + $compressed > $fileSize) throw new ApiError(400, "The bundle's entry $written runs past the end of the file.");
            $name = str_replace('\\', '/', $written);
            $unicode = self::unicodePath(substr($dir, $at + 46 + $nameLength, $extraLength), $written);
            if ($unicode !== null && $unicode !== $name) {
                throw new ApiError(400, "The bundle's entry $name is also named $unicode, in an Info-ZIP Unicode Path field, and ZIP readers differ on which name it has.");
            }
            // Two records under one name are two answers to "what is in this
            // file": readers differ on which they take. The runtime refuses
            // such an archive, and so does this.
            if (isset($names[$name])) throw new ApiError(400, "The bundle has more than one entry named $name.");
            $names[$name] = true;
            $entries[] = ['name' => $written, 'crc' => $crc, 'method' => $method, 'compressed' => $compressed, 'size' => $declared, 'offset' => $data];
            $at = $recordEnd;
        }
        if ($at !== $length) throw new ApiError(400, $countAndSize);
        return $entries;
    }

    /**
     * The name an Info-ZIP Unicode Path extra field (0x7075) gives an entry,
     * or null when there is none a reader would act on: libzip takes the
     * field's path only when its version is 1 and its CRC is the CRC of the
     * header name in front of it, and the runtime reads it the same way.
     */
    private static function unicodePath(string $extra, string $headerName): ?string
    {
        $length = strlen($extra);
        for ($at = 0; $at + 4 <= $length;) {
            $id = self::u16($extra, $at);
            $size = self::u16($extra, $at + 2);
            if ($at + 4 + $size > $length) return null;
            if ($id === 0x7075 && $size >= 5) {
                if (ord($extra[$at + 4]) !== 1 || self::u32($extra, $at + 5) !== crc32($headerName)) return null;
                return str_replace('\\', '/', substr($extra, $at + 9, $size - 5));
            }
            $at += 4 + $size;
        }
        return null;
    }

    /**
     * A name that cannot be a file inside a bundle, by the runtime's rules:
     * absolute, climbing (`..` anywhere in it), cut short by a NUL, on a
     * drive, or, for a file, with an empty or `.` segment. The runtime drops
     * such an entry and runs the rest; the directory refuses the bundle.
     * A folder entry is held to the first four only.
     */
    private static function unsafeName(string $name): bool
    {
        $escapes = str_starts_with($name, '/') || str_contains($name, '..') || str_contains($name, "\0") || preg_match('/^[a-zA-Z]:/', $name) === 1;
        if ($escapes || str_ends_with($name, '/')) return $escapes;
        foreach (explode('/', $name) as $segment) {
            if ($segment === '' || $segment === '.') return true;
        }
        return false;
    }

    /**
     * One entry's bytes, checked as the runtime checks them on reading: a
     * deflate stream is inflated a slice at a time and refused the moment it
     * produces more than the entry declares (the size and the checksum are
     * both the archive's to declare, so a stream could declare its first
     * bytes and their checksum and be read here as those bytes alone), a
     * stream that does not reach its end is refused, bytes after its end are
     * ignored, and what came out must be the declared size with the declared
     * CRC-32. The bytes are returned when `$keep`, and otherwise only counted.
     *
     * @param resource $handle
     * @param array{name: string, crc: int, method: int, compressed: int, size: int, offset: int} $entry
     */
    private static function readEntry($handle, array $entry, bool $keep): ?string
    {
        $name = $entry['name'];
        $crc = hash_init('crc32b');
        $out = '';
        $produced = 0;
        $left = $entry['compressed'];
        if (fseek($handle, $entry['offset']) !== 0) throw new ApiError(400, "The bundle's entry $name runs past the end of the file.");
        $take = static function (string $bytes) use (&$produced, &$out, $crc, $keep): void {
            $produced += strlen($bytes);
            hash_update($crc, $bytes);
            if ($keep) $out .= $bytes;
        };
        if ($entry['method'] === 0) {
            while ($left > 0) {
                $piece = fread($handle, min($left, 1024 * 1024));
                if ($piece === false || $piece === '') throw new ApiError(400, "The bundle's entry $name runs past the end of the file.");
                $left -= strlen($piece);
                $take($piece);
            }
        } else {
            $inflater = inflate_init(ZLIB_ENCODING_RAW);
            $ended = false;
            while ($left > 0 && !$ended) {
                $piece = fread($handle, min($left, self::INFLATE_SLICE));
                if ($piece === false || $piece === '') throw new ApiError(400, "The bundle's entry $name runs past the end of the file.");
                $left -= strlen($piece);
                $chunk = @inflate_add($inflater, $piece, ZLIB_SYNC_FLUSH);
                if ($chunk === false) throw new ApiError(400, "The bundle's entry $name does not decompress.");
                if ($produced + strlen($chunk) > $entry['size']) throw new ApiError(400, "The bundle's entry $name inflates to more than the size it declares.");
                $take($chunk);
                $ended = inflate_get_status($inflater) === ZLIB_STREAM_END;
            }
            if (!$ended) throw new ApiError(400, "The bundle's entry $name does not decompress: its stream stops short.");
        }
        if ($produced !== $entry['size']) throw new ApiError(400, "The bundle's entry $name is not the size it declares.");
        if (hash_final($crc) !== sprintf('%08x', $entry['crc'])) throw new ApiError(400, "The bundle's entry $name does not match its checksum.");
        return $keep ? $out : null;
    }

    /** @param resource $handle */
    private static function bytesAt($handle, int $offset, int $length): string
    {
        if ($length === 0) return '';
        if (fseek($handle, $offset) !== 0) return '';
        $bytes = '';
        while (strlen($bytes) < $length) {
            $piece = fread($handle, $length - strlen($bytes));
            if ($piece === false || $piece === '') break;
            $bytes .= $piece;
        }
        return $bytes;
    }

    private static function u16(string $bytes, int $at): int
    {
        return strlen($bytes) >= $at + 2 ? unpack('v', $bytes, $at)[1] : -1;
    }

    private static function u32(string $bytes, int $at): int
    {
        return strlen($bytes) >= $at + 4 ? unpack('V', $bytes, $at)[1] : -1;
    }

    /**
     * What a permission.json asks for, held to the schema.
     *
     * The declaration is what the listing shows a visitor before they press
     * Play, so it has to be read the way the runtime reads it. A name the
     * runtime would never enforce (`network` for `net`), an entry that is not
     * an object, or an `enabled` that is not a boolean used to fall out of the
     * loop silently and publish as an app that asks for nothing. Each is now
     * refused at publication with the name in the message, which is the one
     * moment the author is there to fix it.
     *
     * The storage entry may name a policy per collection (`collections`), the
     * same five as the runtime's STORAGE_POLICIES; a collection or a policy the
     * schema does not know is refused the same way.
     *
     * @return array{capabilities: string[], storagePolicies: array<string, string>}
     *   the capabilities declared with `enabled: true`, in schema order, and the policies by collection
     */
    public static function readDeclaration(string $permText): array
    {
        $perm = json_decode(self::jsonText($permText), true, 16);
        if (!is_array($perm) || (array_is_list($perm) && $perm !== [])) {
            throw new ApiError(400, "The bundle's permission.json is not a JSON object.");
        }
        $declared = $perm['permissions'] ?? null;
        if ($declared === null) return ['capabilities' => [], 'storagePolicies' => []];
        if (!is_array($declared) || (array_is_list($declared) && $declared !== [])) {
            throw new ApiError(400, "The bundle's permission.json: \"permissions\" must be an object.");
        }
        $unknown = [];
        $malformed = [];
        foreach ($declared as $name => $entry) {
            $name = (string) $name;
            if (!in_array($name, self::CAPABILITIES, true)) {
                $unknown[] = $name;
                continue;
            }
            if (!is_array($entry) || (array_is_list($entry) && $entry !== [])) {
                $malformed[] = $name;
                continue;
            }
            if (array_key_exists('enabled', $entry) && !is_bool($entry['enabled'])) $malformed[] = $name;
        }
        if ($unknown !== []) {
            throw new ApiError(400, "The bundle's permission.json names capabilities the runtime does not have: " . implode(', ', $unknown)
                . '. The capabilities are ' . implode(', ', self::CAPABILITIES) . '.');
        }
        if ($malformed !== []) {
            throw new ApiError(400, "The bundle's permission.json: a capability is an object with a boolean \"enabled\". Not so for: " . implode(', ', $malformed) . '.');
        }
        $capabilities = [];
        foreach (self::CAPABILITIES as $cap) {
            $entry = $declared[$cap] ?? null;
            if (is_array($entry) && ($entry['enabled'] ?? null) === true) $capabilities[] = $cap;
        }
        return ['capabilities' => $capabilities, 'storagePolicies' => self::readStoragePolicies($declared['storage'] ?? null)];
    }

    /** @return array<string, string> */
    private static function readStoragePolicies(mixed $storage): array
    {
        if (!is_array($storage) || !array_key_exists('collections', $storage)) return [];
        $collections = $storage['collections'];
        if (!is_array($collections) || (array_is_list($collections) && $collections !== [])) {
            throw new ApiError(400, "The bundle's permission.json: storage.collections must be an object of collection name to policy.");
        }
        if (count($collections) > 64) throw new ApiError(400, "The bundle's permission.json: storage.collections names more than 64 collections.");
        $bad = [];
        $policies = [];
        foreach ($collections as $name => $policy) {
            $name = (string) $name;
            if (!preg_match(self::COLLECTION_NAME, $name) || !is_string($policy) || !in_array($policy, Storage::POLICIES, true)) {
                $bad[] = $name . '=' . (is_string($policy) ? $policy : gettype($policy));
                continue;
            }
            $policies[$name] = $policy;
        }
        if ($bad !== []) {
            throw new ApiError(400, "The bundle's permission.json: storage.collections names a collection or a policy the directory does not accept: " . implode(', ', $bad)
                . '. A collection is lowercase letters, digits and underscores (or * for the rest); the policies are ' . implode(', ', Storage::POLICIES) . '.');
        }
        return $policies;
    }

    /** SVG elements an icon may use: shapes, text, paint servers, filters. */
    private const SVG_ELEMENTS = [
        'svg', 'g', 'defs', 'title', 'desc', 'metadata', 'symbol', 'use', 'switch', 'style',
        'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'image', 'marker',
        'text', 'tspan', 'textpath', 'lineargradient', 'radialgradient', 'stop', 'pattern', 'clippath', 'mask',
        'filter', 'feblend', 'fecolormatrix', 'fecomponenttransfer', 'fecomposite', 'feconvolvematrix',
        'fediffuselighting', 'fedisplacementmap', 'fedistantlight', 'fedropshadow', 'feflood', 'fefunca',
        'fefuncb', 'fefuncg', 'fefuncr', 'fegaussianblur', 'feimage', 'femerge', 'femergenode', 'femorphology',
        'feoffset', 'fepointlight', 'fespecularlighting', 'fespotlight', 'fetile', 'feturbulence',
    ];

    /**
     * An SVG is served back as an image from the directory's own origin, so it
     * has to be one, and one that can do nothing but be drawn.
     *
     * This used to be a list of words to look for, and a list is always one
     * spelling short: `<x:script xmlns:x="http://www.w3.org/2000/svg">` is a
     * script element that `<script` never matches, and `&#106;avascript:` is
     * a `javascript:` link that the pattern never saw. Now the file is parsed
     * the way a browser parses it and judged by what the parse produced:
     *
     * - it must be well-formed XML with an `<svg>` root in the SVG namespace,
     *   with no DOCTYPE (so no entities of its own) and no processing
     *   instructions (so no stylesheet or transform pulled in);
     * - every element in the SVG namespace must be one of SVG_ELEMENTS, and
     *   none may be in the XHTML or MathML namespace, whatever its prefix;
     *   elements in other namespaces (an editor's metadata) are inert and kept;
     * - no attribute may be an event handler (`on…`), and no attribute value,
     *   entity-decoded as the parser gives it, may name a `javascript:`,
     *   `vbscript:` or non-image `data:` URL once whitespace is taken out;
     * - a `<style>` may not import or name a script URL.
     *
     * An icon that fails is not an error: the app is published without it and
     * shows the placeholder. The served response carries a sandboxing CSP as
     * well (Response::USER_CONTENT), so this is the first of two walls.
     */
    public static function safeSvg(string $bytes): bool
    {
        if ($bytes === '' || strlen($bytes) > self::MAX_ICON_BYTES) return false;
        if (!preg_match('/<svg[\s>]/i', substr($bytes, 0, 2048))) return false;
        if (preg_match('/<!DOCTYPE|<!ENTITY/i', $bytes)) return false;
        if (!class_exists('DOMDocument')) return false;
        $previous = libxml_use_internal_errors(true);
        try {
            $doc = new DOMDocument();
            $parsed = $doc->loadXML($bytes, LIBXML_NONET | LIBXML_COMPACT);
            libxml_clear_errors();
        } finally {
            libxml_use_internal_errors($previous);
        }
        if (!$parsed || $doc->doctype !== null) return false;
        $root = $doc->documentElement;
        if ($root === null || $root->localName !== 'svg' || $root->namespaceURI !== 'http://www.w3.org/2000/svg') return false;
        $pending = [$doc];
        while ($pending !== []) {
            $node = array_pop($pending);
            foreach ($node->childNodes ?? [] as $child) {
                if ($child->nodeType === XML_PI_NODE || $child->nodeType === XML_ENTITY_REF_NODE || $child->nodeType === XML_DOCUMENT_TYPE_NODE) return false;
                if ($child->nodeType !== XML_ELEMENT_NODE) continue;
                /** @var DOMElement $child */
                if (!self::safeSvgElement($child)) return false;
                $pending[] = $child;
            }
        }
        return true;
    }

    private static function safeSvgElement(DOMElement $el): bool
    {
        $ns = $el->namespaceURI;
        $name = strtolower((string) $el->localName);
        if ($ns === 'http://www.w3.org/1999/xhtml' || $ns === 'http://www.w3.org/1998/Math/MathML') return false;
        if ($ns === 'http://www.w3.org/2000/svg' && !in_array($name, self::SVG_ELEMENTS, true)) return false;
        // An element with no namespace inside an SVG document is inert XML, as
        // is an editor's own vocabulary; neither needs a name check, but their
        // attributes are read like any other.
        foreach ($el->attributes ?? [] as $attr) {
            if (str_starts_with(strtolower((string) $attr->localName), 'on')) return false;
            if (self::scriptUrl((string) $attr->value)) return false;
        }
        if ($name === 'style') {
            $css = strtolower((string) $el->textContent);
            if (str_contains($css, '@import') || self::scriptUrl($css)) return false;
        }
        return true;
    }

    /** Whether text names a URL that runs or embeds something other than an image. */
    private static function scriptUrl(string $value): bool
    {
        // The browser ignores whitespace and control characters inside a
        // scheme (`java\tscript:`), so they are taken out before looking.
        $flat = strtolower((string) preg_replace('/[\x00-\x20\x7f]+/', '', $value));
        if (str_contains($flat, 'javascript:') || str_contains($flat, 'vbscript:')) return true;
        if (preg_match_all('/data:([^,;)\'"]*)/', $flat, $m)) {
            foreach ($m[1] as $type) {
                if (!str_starts_with($type, 'image/') || str_starts_with($type, 'image/svg')) return true;
            }
        }
        return false;
    }

    /**
     * The bundle's files, for reading on the app page: every path, with the
     * text of the ones a person would read. Binary files and anything past
     * the size caps are listed without content.
     *
     * @return array{files: array<int, array{path: string, size: int, text: string|null}>, truncated: bool}
     */
    public static function listSource(string $path): array
    {
        $zip = new ZipArchive();
        if ($zip->open($path, ZipArchive::RDONLY) !== true) throw new ApiError(500, 'The stored bundle does not open.');
        $files = [];
        $budget = 2 * 1024 * 1024;
        $truncated = false;
        try {
            for ($i = 0; $i < $zip->numFiles; $i++) {
                $stat = $zip->statIndex($i);
                if ($stat === false) continue;
                $name = (string) $stat['name'];
                if ($name === '' || str_ends_with($name, '/')) continue;
                $size = (int) $stat['size'];
                $text = null;
                if (preg_match('/\.(ui|logic|json|md|txt|css|js|ts|html|svg|csv|xml|yml|yaml|toml|ini)$/i', $name) && $size <= 256 * 1024 && $budget > 0) {
                    $bytes = $zip->getFromIndex($i);
                    if (is_string($bytes) && mb_check_encoding($bytes, 'UTF-8')) {
                        $text = $bytes;
                        $budget -= strlen($bytes);
                    }
                } elseif ($size > 256 * 1024 || $budget <= 0) {
                    $truncated = true;
                }
                $files[] = ['path' => $name, 'size' => $size, 'text' => $text];
            }
        } finally {
            $zip->close();
        }
        usort($files, fn($a, $b) => strcmp($a['path'], $b['path']));
        return ['files' => $files, 'truncated' => $truncated];
    }
}
