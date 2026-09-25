<?php
/**
 * What the directory learns from a .softn before it agrees to keep it.
 *
 * A bundle is a zip: manifest.json with a name, a version and an entry file;
 * optionally permission.json, which is the app's own declaration of what it
 * will ask the runtime for, and an icon. The archive is read in place and
 * never extracted here — the runtime does its own reading, with its own
 * limits, on the client — so the checks below are about what the directory
 * is willing to store and show, not about what the bundle can do.
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
    /** A storage collection name, or `*` for every collection not named. */
    private const COLLECTION_NAME = '/^(?:\*|[a-z][a-z0-9_]{0,31})$/';

    /**
     * @return array{
     *   manifest: array<string, mixed>, name: string, version: string, description: string,
     *   capabilities: string[], storagePolicies: array<string, string>, execution: string, icon: array{0: string, 1: string}|null,
     *   size: int, sha256: string, entries: int
     * }
     */
    public static function inspect(string $path): array
    {
        if (!class_exists('ZipArchive')) throw new ApiError(503, 'This server\'s PHP has no zip extension, which the directory needs to read bundles.');
        $size = (int) filesize($path);
        if ($size < 22) throw new ApiError(400, 'That is not a .softn bundle.');
        $zip = new ZipArchive();
        $opened = $zip->open($path, ZipArchive::RDONLY);
        if ($opened !== true) throw new ApiError(400, 'That is not a .softn bundle: the archive does not open.');
        try {
            $count = $zip->numFiles;
            if ($count === 0) throw new ApiError(400, 'The bundle is empty.');
            if ($count > self::MAX_ENTRIES) throw new ApiError(400, 'The bundle has more than ' . self::MAX_ENTRIES . ' files.');
            $total = 0;
            $seen = [];
            for ($i = 0; $i < $count; $i++) {
                $stat = $zip->statIndex($i);
                if ($stat === false) throw new ApiError(400, 'The bundle has an unreadable entry.');
                $name = (string) $stat['name'];
                // Two entries of one name are two answers to "what is in this
                // file": this check reads the first manifest.json, another
                // reader may take the last. The runtime's archive index and
                // softn-serve refuse such an archive, so it is refused here,
                // where the publisher is present to fix it, rather than listed
                // with a manifest the app will never run with.
                if (isset($seen[$name])) throw new ApiError(400, "The bundle has more than one entry named $name.");
                $seen[$name] = true;
                if ($name === '' || str_contains($name, '\\') || str_starts_with($name, '/') || preg_match('#(^|/)\.\.(/|$)#', $name)) {
                    throw new ApiError(400, "The bundle has an entry with an unsafe path: $name");
                }
                if ((int) $stat['encryption_method'] !== ZipArchive::EM_NONE) throw new ApiError(400, 'The bundle has an encrypted entry.');
                $total += (int) $stat['size'];
                if ($total > self::MAX_UNCOMPRESSED) throw new ApiError(400, 'The bundle expands to more than 128 MB.');
            }
            $manifestText = self::readJsonEntry($zip, 'manifest.json', self::MAX_MANIFEST_BYTES);
            if ($manifestText === null) throw new ApiError(400, 'The bundle has no manifest.json.');
            $manifest = json_decode($manifestText, true, 32);
            if (!is_array($manifest)) throw new ApiError(400, 'The bundle\'s manifest.json is not valid JSON.');
            $name = Text::clean(is_string($manifest['name'] ?? null) ? $manifest['name'] : '', 64);
            if ($name === '') throw new ApiError(400, 'The manifest has no name.');
            $version = Text::clean(is_string($manifest['version'] ?? null) ? $manifest['version'] : '', 32);
            if ($version === '') throw new ApiError(400, 'The manifest has no version.');
            $main = is_string($manifest['main'] ?? null) ? $manifest['main'] : '';
            if ($main === '') throw new ApiError(400, 'The manifest names no entry file (main).');
            if ($zip->locateName($main) === false) throw new ApiError(400, "The manifest's entry file is not in the bundle: $main");
            $description = Text::clean(is_string($manifest['description'] ?? null) ? $manifest['description'] : '', 600, true);

            $capabilities = [];
            $storagePolicies = [];
            $permText = self::readJsonEntry($zip, 'permission.json', self::MAX_PERMISSION_BYTES);
            if ($permText !== null) ['capabilities' => $capabilities, 'storagePolicies' => $storagePolicies] = self::readDeclaration($permText);
            $execution = 'main';
            $config = is_array($manifest['config'] ?? null) ? $manifest['config'] : [];
            if (($config['execution'] ?? null) === 'worker') $execution = 'worker';

            $icon = null;
            $iconPath = is_string($manifest['icon'] ?? null) ? $manifest['icon'] : '';
            if ($iconPath !== '' && $zip->locateName($iconPath) !== false) {
                $stat = $zip->statName($iconPath);
                if ($stat !== false && (int) $stat['size'] <= self::MAX_ICON_BYTES) {
                    $bytes = $zip->getFromName($iconPath);
                    if (is_string($bytes)) {
                        $mime = Images::sniff($bytes);
                        if ($mime === null && preg_match('/\.svg$/i', $iconPath) && self::safeSvg($bytes)) $mime = 'image/svg+xml';
                        if ($mime !== null) $icon = [$bytes, $mime];
                    }
                }
            }
        } finally {
            $zip->close();
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
     * One of the bundle's JSON files, or null when it has none: refused by
     * its declared size before a byte is read, and read to no more than that
     * cap in case the declaration lied.
     */
    private static function readJsonEntry(ZipArchive $zip, string $name, int $max): ?string
    {
        $stat = $zip->statName($name);
        if ($stat === false) return null;
        if ((int) $stat['size'] > $max) throw new ApiError(400, "The bundle's $name is larger than " . intdiv($max, 1024) . ' KB.');
        $text = $zip->getFromName($name, $max);
        if ($text === false) throw new ApiError(400, "The bundle's $name cannot be read.");
        return $text;
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
        $perm = json_decode($permText, true, 16);
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
