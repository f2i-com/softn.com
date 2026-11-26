<?php
/**
 * Safe, zero-execution server-side HTML pre-rendering and cached bundle
 * metadata for hosted SoftN apps.
 *
 * Produces clean, human-readable, semantic HTML5 for both search-engine
 * crawlers and browser "View Source" from a bundle's public UI entry
 * (Classic `.ui` or Container v2 `.html`), without ever executing guest
 * code or reading backend/server files.
 *
 * Uses only PHP core, PCRE, ZipArchive and JSON (no mbstring, DOMDocument or
 * ctype) so it runs identically on minimal shared-hosting PHP installations.
 */
declare(strict_types=1);

final class Prerender
{
    public const VERSION = 7;
    private const MAX_ENTRY_BYTES = 262144;
    private const MAX_SNAPSHOT_BYTES = 524288;
    private const MAX_IMPORT_FILES = 16;
    private const MAX_IMPORT_DEPTH = 4;
    private const MAX_OUTPUT_BYTES = 24576;
    private const MAX_NODES = 400;
    private const MAX_DEPTH = 32;
    private const MAX_PUBLIC_PAGES = 50;

    /** @var array<string, bool> */
    private const ALLOWED_HTML_TAGS = [
        'h1' => true, 'h2' => true, 'h3' => true, 'h4' => true, 'h5' => true, 'h6' => true,
        'p' => true, 'ul' => true, 'ol' => true, 'li' => true,
        'section' => true, 'article' => true, 'header' => true, 'main' => true, 'footer' => true, 'nav' => true, 'aside' => true,
        'div' => true, 'span' => true, 'a' => true, 'strong' => true, 'b' => true, 'em' => true, 'i' => true,
        'code' => true, 'pre' => true, 'blockquote' => true,
        'table' => true, 'thead' => true, 'tbody' => true, 'tr' => true, 'th' => true, 'td' => true,
        'dl' => true, 'dt' => true, 'dd' => true, 'figure' => true, 'figcaption' => true,
        'details' => true, 'summary' => true, 'time' => true, 'abbr' => true, 'mark' => true,
        'cite' => true, 'sub' => true, 'sup' => true,
        'hr' => true, 'br' => true, 'label' => true, 'button' => true,
    ];

    /** @var array<string, bool> */
    private const VOID_TAGS = ['br' => true, 'hr' => true];

    /** @var array<string, bool> */
    private const BLOCK_TAGS = [
        'h1' => true, 'h2' => true, 'h3' => true, 'h4' => true, 'h5' => true, 'h6' => true,
        'p' => true, 'ul' => true, 'ol' => true, 'li' => true,
        'section' => true, 'article' => true, 'header' => true, 'main' => true, 'footer' => true, 'nav' => true, 'aside' => true,
        'div' => true, 'pre' => true, 'blockquote' => true, 'details' => true, 'summary' => true,
        'table' => true, 'thead' => true, 'tbody' => true, 'tr' => true,
        'dl' => true, 'dt' => true, 'dd' => true, 'figure' => true, 'figcaption' => true, 'hr' => true,
    ];

    /** @var array<string, string> */
    private const UI_TAG_MAP = [
        'heading' => 'h2', 'title' => 'h2',
        'h1' => 'h2', 'h2' => 'h2', 'h3' => 'h3', 'h4' => 'h4', 'h5' => 'h5', 'h6' => 'h6',
        'text' => 'p', 'paragraph' => 'p', 'p' => 'p', 'subtitle' => 'p', 'caption' => 'p', 'description' => 'p',
        'section' => 'section', 'card' => 'section', 'panel' => 'section',
        'article' => 'article', 'header' => 'header', 'footer' => 'footer', 'nav' => 'nav', 'main' => 'section',
        'aside' => 'aside', 'alert' => 'aside', 'callout' => 'aside', 'banner' => 'aside',
        'list' => 'ul', 'ul' => 'ul', 'ol' => 'ol', 'listitem' => 'li', 'li' => 'li',
        'button' => 'button', 'link' => 'a', 'a' => 'a',
        'badge' => 'span', 'tag' => 'span', 'chip' => 'span', 'label' => 'label', 'span' => 'span',
        'strong' => 'strong', 'b' => 'strong', 'em' => 'em', 'i' => 'em',
        'code' => 'code', 'pre' => 'pre', 'blockquote' => 'blockquote',
        'table' => 'table', 'thead' => 'thead', 'tbody' => 'tbody', 'tr' => 'tr', 'th' => 'th', 'td' => 'td',
        'divider' => 'hr', 'hr' => 'hr', 'br' => 'br',
        'app' => 'div', 'page' => 'div', 'screen' => 'div', 'layout' => 'div',
        'box' => 'div', 'stack' => 'div', 'row' => 'div', 'col' => 'div', 'column' => 'div',
        'grid' => 'div', 'flex' => 'div', 'container' => 'div', 'center' => 'div', 'group' => 'div', 'view' => 'div', 'div' => 'div',
    ];

    /**
     * Load cached or freshly extracted pre-render metadata for a bundle's root page.
     *
     * @return array{themeMode: ?string, previewHtml: string, sourceType: string, entryFile: ?string, engineTier: ?string, found: bool, pageTitle: ?string, pageDescription: ?string, pageRobots: ?string, virtualPath: string, publicPages: array<int, string>, hasSsrBackend: bool}
     */
    public static function forBundle(
        string $bundlePath,
        string $bundleSha,
        ?string $cacheDir,
        bool $withholdBackend,
        ?string $snapshotPath = null,
        ?string $snapshotSha = null
    ): array {
        return self::forBundlePage($bundlePath, $bundleSha, $cacheDir, $withholdBackend, $snapshotPath, $snapshotSha, '', null);
    }

    /**
     * Load cached or freshly extracted pre-render metadata for a specific page
     * inside a bundle (root `""` or sub-page e.g. `"about.html"`, `"blog/post.html"`).
     * Optionally rewrites safe internal relative/root-relative links under `$linkBase`
     * (e.g. `"/play/<slug>"`) so View Source and crawlers can follow every page.
     *
     * @return array{themeMode: ?string, previewHtml: string, sourceType: string, entryFile: ?string, engineTier: ?string, found: bool, pageTitle: ?string, pageDescription: ?string, pageRobots: ?string, virtualPath: string, publicPages: array<int, string>, hasSsrBackend: bool}
     */
    /**
     * Load cached or freshly extracted bundle-level metadata (shared across all
     * pages of a bundle and used by `/sitemap-apps.xml` without touching per-page HTML).
     *
     * @return array{themeMode: ?string, engineTier: ?string, publicPages: array<int, string>, noindexPages: array<int, string>, hasSsrBackend: bool}
     */
    public static function bundleMetaFor(
        string $bundlePath,
        string $bundleSha,
        ?string $cacheDir,
        bool $withholdBackend
    ): array {
        $empty = [
            'themeMode' => null,
            'engineTier' => null,
            'publicPages' => [],
            'noindexPages' => [],
            'hasSsrBackend' => false,
        ];
        if (!is_file($bundlePath)) return $empty;

        $cacheFile = null;
        if ($cacheDir !== null && $bundleSha !== '') {
            $pathHash = substr(hash('sha256', $bundlePath), 0, 8);
            $suffix = ($withholdBackend ? '-client' : '') . '-' . $pathHash;
            $cacheFile = rtrim($cacheDir, '/\\') . '/bundle-meta-v' . self::VERSION . '-' . substr($bundleSha, 0, 32) . $suffix . '.json';
            $cached = @file_get_contents($cacheFile);
            if (is_string($cached)) {
                $decoded = json_decode($cached, true);
                if (is_array($decoded) && ($decoded['v'] ?? null) === self::VERSION) {
                    $tm = $decoded['themeMode'] ?? null;
                    $et = $decoded['engineTier'] ?? null;
                    return [
                        'themeMode' => ($tm === 'light' || $tm === 'dark') ? $tm : null,
                        'engineTier' => in_array($et, ['none', 'lite', 'typescript', 'full'], true) ? $et : null,
                        'publicPages' => is_array($decoded['publicPages'] ?? null)
                            ? array_values(array_filter($decoded['publicPages'], 'is_string'))
                            : [],
                        'noindexPages' => is_array($decoded['noindexPages'] ?? null)
                            ? array_values(array_filter($decoded['noindexPages'], 'is_string'))
                            : [],
                        'hasSsrBackend' => (bool) ($decoded['hasSsrBackend'] ?? false),
                    ];
                }
            }
        }

        $meta = self::extractThemeAndTierFromZip($bundlePath);
        if ($cacheFile !== null) {
            self::writeCacheFile($cacheDir, $cacheFile, ['v' => self::VERSION] + $meta);
        }
        return $meta;
    }

    /** @param array<string, mixed> $payload */
    private static function writeCacheFile(?string $cacheDir, string $cacheFile, array $payload): void
    {
        if ($cacheDir === null) return;
        try {
            if (!is_dir($cacheDir)) @mkdir($cacheDir, 0775, true);
            if (is_dir($cacheDir)) {
                $encoded = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
                if (is_string($encoded)) {
                    $tmp = $cacheFile . '.tmp.' . getmypid() . '.' . bin2hex(random_bytes(4));
                    if (@file_put_contents($tmp, $encoded) === strlen($encoded)) {
                        if (!@rename($tmp, $cacheFile)) @unlink($tmp);
                    } else {
                        @unlink($tmp);
                    }
                }
            }
        } catch (Throwable) {
            // Read-only or full cache directories never break page rendering.
        }
    }

    public static function forBundlePage(
        string $bundlePath,
        string $bundleSha,
        ?string $cacheDir,
        bool $withholdBackend,
        ?string $snapshotPath = null,
        ?string $snapshotSha = null,
        string $subPath = '',
        ?string $linkBase = null
    ): array {
        $empty = [
            'themeMode' => null,
            'previewHtml' => '',
            'sourceType' => 'none',
            'entryFile' => null,
            'engineTier' => null,
            'found' => false,
            'pageTitle' => null,
            'pageDescription' => null,
            'pageRobots' => null,
            'pageLang' => null,
            'virtualPath' => '/',
            'publicPages' => [],
            'noindexPages' => [],
            'hasSsrBackend' => false,
        ];
        if (!is_file($bundlePath)) return $empty;

        $rawSlash = str_replace('\\', '/', $subPath);
        $trailingSlash = $rawSlash !== '' && str_ends_with($rawSlash, '/');
        $normSub = trim($rawSlash, '/');
        if ($normSub !== '') {
            if (
                str_contains($subPath, "\0")
                || str_contains($subPath, '\\')
                || strlen($subPath) > 512
                || preg_match('/[\x00-\x1F\x7F]/', $subPath) === 1
                || preg_match('#(?:^|/)\.\.?(?:/|$)#', $normSub) === 1
                || preg_match('#(?:^|/)\.#', $normSub) === 1
            ) {
                return $empty;
            }
        }
        $cleanLinkBase = is_string($linkBase) && $linkBase !== '' ? rtrim($linkBase, '/') : null;

        // Live-captured root ssr.html snapshot applies only to the root page.
        $activeSnapshot = $normSub === ''
            ? self::usableSnapshotPath($snapshotPath, $bundlePath, $bundleSha, $snapshotSha)
            : null;
        $snapTag = '';
        if ($activeSnapshot !== null) {
            $st = @stat($activeSnapshot);
            $snapTag = '-s' . substr(hash('sha256', (string) ($st['mtime'] ?? 0) . ':' . (string) ($st['size'] ?? 0)), 0, 8);
        }

        $cacheFile = null;
        if ($cacheDir !== null && $bundleSha !== '') {
            $routeKey = $normSub . ($trailingSlash ? '/' : '') . '|' . ($cleanLinkBase ?? '');
            $pathHash = substr(hash('sha256', $bundlePath . '|' . ($activeSnapshot ?? '') . '|' . $routeKey), 0, 12);
            $suffix = ($withholdBackend ? '-client' : '') . '-' . $pathHash . $snapTag;
            $cacheFile = rtrim($cacheDir, '/\\') . '/page-meta-v' . self::VERSION . '-' . substr($bundleSha, 0, 32) . $suffix . '.json';
            $cached = @file_get_contents($cacheFile);
            if (is_string($cached)) {
                $decoded = json_decode($cached, true);
                if (
                    is_array($decoded)
                    && ($decoded['v'] ?? null) === self::VERSION
                    && is_string($decoded['previewHtml'] ?? null)
                    && is_string($decoded['sourceType'] ?? null)
                    && is_bool($decoded['found'] ?? null)
                ) {
                    $tm = $decoded['themeMode'] ?? null;
                    $ef = $decoded['entryFile'] ?? null;
                    $et = $decoded['engineTier'] ?? null;
                    $pt = $decoded['pageTitle'] ?? null;
                    $pd = $decoded['pageDescription'] ?? null;
                    $pr = $decoded['pageRobots'] ?? null;
                    $pl = $decoded['pageLang'] ?? null;
                    $vp = $decoded['virtualPath'] ?? '/';
                    $pp = is_array($decoded['publicPages'] ?? null)
                        ? array_values(array_filter($decoded['publicPages'], 'is_string'))
                        : [];
                    $np = is_array($decoded['noindexPages'] ?? null)
                        ? array_values(array_filter($decoded['noindexPages'], 'is_string'))
                        : [];
                    return [
                        'themeMode' => ($tm === 'light' || $tm === 'dark') ? $tm : null,
                        'previewHtml' => $decoded['previewHtml'],
                        'sourceType' => $decoded['sourceType'],
                        'entryFile' => is_string($ef) ? $ef : null,
                        'engineTier' => in_array($et, ['none', 'lite', 'typescript', 'full'], true) ? $et : null,
                        'found' => (bool) $decoded['found'],
                        'pageTitle' => is_string($pt) && $pt !== '' ? $pt : null,
                        'pageDescription' => is_string($pd) && $pd !== '' ? $pd : null,
                        'pageRobots' => is_string($pr) && $pr !== '' ? $pr : null,
                        'pageLang' => is_string($pl) && $pl !== '' ? $pl : null,
                        'virtualPath' => is_string($vp) && $vp !== '' ? $vp : '/',
                        'publicPages' => $pp,
                        'noindexPages' => $np,
                        'hasSsrBackend' => (bool) ($decoded['hasSsrBackend'] ?? false),
                    ];
                }
            }
        }

        // Reuse cached bundle-level metadata (theme, tier, publicPages, noindexPages, hasSsrBackend)
        // so sub-page misses never re-scan or re-decompress every JS/HTML file in the ZIP.
        $bundleMeta = ($cacheDir !== null && $bundleSha !== '')
            ? self::bundleMetaFor($bundlePath, $bundleSha, $cacheDir, $withholdBackend)
            : null;

        if ($activeSnapshot !== null) {
            $rawSnap = @file_get_contents($activeSnapshot, false, null, 0, self::MAX_SNAPSHOT_BYTES);
            if (is_string($rawSnap) && trim($rawSnap) !== '') {
                $snapMeta = self::extractHtmlPageMeta($rawSnap);
                $sanitizedSnap = self::sanitizeHtml($rawSnap, self::MAX_SNAPSHOT_BYTES, $cleanLinkBase, '');
                if ($sanitizedSnap !== '') {
                    $meta = $bundleMeta ?? self::extractThemeAndTierFromZip($bundlePath);
                    $result = [
                        'themeMode' => $meta['themeMode'],
                        'previewHtml' => $sanitizedSnap,
                        'sourceType' => 'snapshot',
                        'entryFile' => 'ssr.html',
                        'engineTier' => $meta['engineTier'],
                        'found' => true,
                        'pageTitle' => $snapMeta['title'],
                        'pageDescription' => $snapMeta['description'],
                        'pageRobots' => $snapMeta['robots'],
                        'pageLang' => $snapMeta['lang'],
                        'virtualPath' => '/',
                        'publicPages' => $meta['publicPages'],
                        'noindexPages' => $meta['noindexPages'],
                        'hasSsrBackend' => $meta['hasSsrBackend'],
                    ];
                } else {
                    $result = self::extractFromZip($bundlePath, $normSub, $trailingSlash, $cleanLinkBase, $bundleMeta);
                }
            } else {
                $result = self::extractFromZip($bundlePath, $normSub, $trailingSlash, $cleanLinkBase, $bundleMeta);
            }
        } else {
            $result = self::extractFromZip($bundlePath, $normSub, $trailingSlash, $cleanLinkBase, $bundleMeta);
        }

        // Only cache resolved pages so arbitrary 404 probes cannot flood page-cache/.
        // Nor a page the bundle leaves to its backend: every address that is no
        // file's is one of those and is "found", so each one asked for was a
        // file of its own here, and nothing but the manifest was read to make it.
        if ($cacheFile !== null && $result['found'] && $result['sourceType'] !== 'ssr-backend') {
            self::writeCacheFile($cacheDir, $cacheFile, ['v' => self::VERSION] + $result);
        }

        return $result;
    }

    private static function usableSnapshotPath(
        ?string $snapshotPath,
        string $bundlePath,
        string $bundleSha,
        ?string $snapshotSha = null
    ): ?string {
        if ($snapshotPath === null || $snapshotPath === '' || is_link($snapshotPath) || !is_file($snapshotPath)) return null;
        $size = @filesize($snapshotPath);
        if (!is_int($size) || $size <= 0 || $size > self::MAX_SNAPSHOT_BYTES) return null;
        $head = @file_get_contents($snapshotPath, false, null, 0, 256);
        if (is_string($head) && preg_match('/<!--\s*softn-ssr-sha256:\s*([a-f0-9]{16,64})\s*-->/i', $head, $m) === 1) {
            $tag = strtolower($m[1]);
            $matchesClient = $bundleSha !== '' && str_starts_with(strtolower($bundleSha), $tag);
            $matchesSource = is_string($snapshotSha) && $snapshotSha !== '' && str_starts_with(strtolower($snapshotSha), $tag);
            if (($bundleSha !== '' || (is_string($snapshotSha) && $snapshotSha !== '')) && !$matchesClient && !$matchesSource) {
                return null;
            }
            return $snapshotPath;
        }
        $snapMtime = @filemtime($snapshotPath);
        $bundleMtime = @filemtime($bundlePath);
        if (is_int($snapMtime) && is_int($bundleMtime) && $snapMtime < $bundleMtime) {
            return null;
        }
        return $snapshotPath;
    }

    /** Whether an HTML document contains any runnable `<script>` or inline `on*` event handler. */
    private static function htmlHasRunnableScript(string $html): bool
    {
        if (preg_match('/<script\b([^>]*)>/i', $html) === 1) {
            if (preg_match_all('/<script\b([^>]*)>/i', $html, $sm) > 0) {
                foreach ($sm[1] as $attrs) {
                    $type = self::extractHtmlAttr($attrs, 'type');
                    if ($type === null || $type === '') return true;
                    $lt = strtolower(trim(explode(';', $type)[0]));
                    if (!in_array($lt, ['application/ld+json', 'application/json', 'importmap', 'speculationrules', 'text/plain'], true)) {
                        return true;
                    }
                }
            }
        }
        return preg_match('/<[a-zA-Z][^>]*\son[a-z]{2,20}\s*=/i', $html) === 1;
    }

    /**
     * Conservatively classify which frontend WASM engine tier a bundle will request
     * (`'none'`, `'lite'`, `'typescript'`, or `'full'`) so `/play/<slug>` can emit exact
     * `<link rel="preload" as="fetch">` hints without wasting bandwidth on static sites.
     */
    private static function detectEngineTierFromZip(ZipArchive $zip): string
    {
        $hasScript = false;
        $hasTs = false;
        $needsFullJs = false;
        $limit = min($zip->numFiles, 512);
        for ($i = 0; $i < $limit; $i++) {
            $name = $zip->getNameIndex($i);
            if (!is_string($name) || str_ends_with($name, '/')) continue;
            $norm = ltrim(str_replace('\\', '/', $name), './');
            if (preg_match('#^(?:backend|server|private)/#i', $norm) === 1) continue;
            $lower = strtolower($norm);
            if (str_ends_with($lower, '.py')) return 'full';
            if (preg_match('/\.(?:ts|tsx|mts)$/', $lower) === 1) {
                $hasScript = true;
                $hasTs = true;
                continue;
            }
            if (preg_match('/\.(?:html?|ui|logic|m?js|jsx|vue)$/', $lower) !== 1) continue;
            $isHtml = str_ends_with($lower, '.html') || str_ends_with($lower, '.htm');
            $isUi = str_ends_with($lower, '.ui');
            if (!$isHtml && !$isUi) $hasScript = true;

            $stat = $zip->statIndex($i);
            if ($stat === false || (int) $stat['size'] > self::MAX_ENTRY_BYTES) {
                // Large uninspected script file: stay conservative so we never preload the wrong engine.
                $hasScript = true;
                $needsFullJs = true;
                continue;
            }
            $src = $zip->getFromIndex($i, self::MAX_ENTRY_BYTES);
            if (!is_string($src)) continue;
            if ($isHtml && !$hasScript && self::htmlHasRunnableScript($src)) {
                $hasScript = true;
            } elseif ($isUi && !$hasScript && preg_match('/<(?:logic|script)\b|\bon:[a-z]+/i', $src) === 1) {
                $hasScript = true;
            }
            if (preg_match('/<script\b[^>]*\btype\s*=\s*["\']?(?:text\/)?python\b/i', $src) === 1) return 'full';
            if (preg_match('/<script\b[^>]*\btype\s*=\s*["\']?(?:text\/|module\/)?(?:ts|tsx|typescript)\b/i', $src) === 1) {
                $hasScript = true;
                $hasTs = true;
            }
            if (preg_match('/\b(?:Intl|Temporal)\b|\.(?:toLocale(?:String|DateString|TimeString|UpperCase|LowerCase)|localeCompare)\b/', $src) === 1) {
                $needsFullJs = true;
            }
        }
        if ($hasTs) return 'typescript';
        if (!$hasScript) return 'none';
        return $needsFullJs ? 'full' : 'lite';
    }

    /**
     * Fast path for bundle-level metadata: read `manifest.json` for `themeMode`,
     * classify `engineTier`, and list public HTML pages (plus any `noindex` pages)
     * without sanitizing full page previews.
     *
     * @return array{themeMode: ?string, engineTier: ?string, publicPages: array<int, string>, noindexPages: array<int, string>, hasSsrBackend: bool}
     */
    private static function extractThemeAndTierFromZip(string $bundlePath): array
    {
        $empty = ['themeMode' => null, 'engineTier' => null, 'publicPages' => [], 'noindexPages' => [], 'hasSsrBackend' => false];
        if (!class_exists('ZipArchive')) return $empty;
        $zip = new ZipArchive();
        if ($zip->open($bundlePath, ZipArchive::RDONLY) !== true) return $empty;
        try {
            $tier = self::detectEngineTierFromZip($zip);
            [$prefix, $manifest] = self::readPrefixAndManifest($zip);
            $themeMode = self::themeModeFromManifest($manifest);
            [$publicPages, $noindexPages] = self::discoverPublicPagesAndRobots($zip, $manifest, $prefix);
            $hasSsrBackend = self::hasSsrBackend($zip, $manifest, $prefix);
            return [
                'themeMode' => $themeMode,
                'engineTier' => $tier,
                'publicPages' => $publicPages,
                'noindexPages' => $noindexPages,
                'hasSsrBackend' => $hasSsrBackend,
            ];
        } catch (Throwable) {
            return $empty;
        } finally {
            $zip->close();
        }
    }

    /**
     * Detect a single wrapper directory prefix (if present) and parse `manifest.json`.
     *
     * @return array{0: string, 1: ?array<string, mixed>}
     */
    private static function readPrefixAndManifest(ZipArchive $zip): array
    {
        $prefix = '';
        $manifestName = null;
        if ($zip->locateName('manifest.json') !== false) {
            $manifestName = 'manifest.json';
        } elseif ($zip->numFiles > 0) {
            $first = $zip->getNameIndex(0);
            if (is_string($first)) {
                $slash = strpos($first, '/');
                if ($slash !== false && $slash > 0) {
                    $candPrefix = substr($first, 0, $slash + 1);
                    $hasWrapperEntry = $zip->locateName($candPrefix . 'manifest.json') !== false
                        || $zip->locateName($candPrefix . 'index.html') !== false
                        || $zip->locateName($candPrefix . 'app.html') !== false;
                    if ($hasWrapperEntry) {
                        $allUnder = true;
                        for ($i = 0; $i < $zip->numFiles; $i++) {
                            $n = $zip->getNameIndex($i);
                            if (!is_string($n) || !str_starts_with($n, $candPrefix)) {
                                $allUnder = false;
                                break;
                            }
                        }
                        if ($allUnder) {
                            $prefix = $candPrefix;
                            if ($zip->locateName($candPrefix . 'manifest.json') !== false) {
                                $manifestName = $candPrefix . 'manifest.json';
                            }
                        }
                    }
                }
            }
        }
        $manifest = null;
        if ($manifestName !== null) {
            $stat = $zip->statName($manifestName);
            if ($stat !== false && (int) $stat['size'] <= self::MAX_ENTRY_BYTES) {
                $raw = $zip->getFromName($manifestName, self::MAX_ENTRY_BYTES);
                if (is_string($raw)) {
                    if (str_starts_with($raw, "\xEF\xBB\xBF")) $raw = substr($raw, 3);
                    $decoded = json_decode($raw, true, 32);
                    if (is_array($decoded)) $manifest = $decoded;
                }
            }
        }
        return [$prefix, $manifest];
    }

    /** @param array<string, mixed>|null $manifest */
    private static function themeModeFromManifest(?array $manifest): ?string
    {
        if (!is_array($manifest)) return null;
        $theme = is_array($manifest['config'] ?? null) ? ($manifest['config']['theme'] ?? null) : null;
        $mode = is_array($theme) ? ($theme['mode'] ?? null) : null;
        if ($mode === 'light' || $mode === 'dark') return $mode;
        if (in_array($manifest['theme'] ?? null, ['light', 'dark'], true)) return (string) $manifest['theme'];
        return null;
    }

    /** @param array<string, mixed>|null $manifest */
    private static function frontendRootFromManifest(?array $manifest): string
    {
        if (!is_array($manifest) || !is_string($manifest['frontendRoot'] ?? null)) return '';
        $s = str_replace('\\', '/', trim($manifest['frontendRoot']));
        $s = preg_replace('#^(?:\./)+#', '', ltrim($s, '/')) ?? ltrim($s, '/');
        return trim($s, '/');
    }

    /** @param array<string, mixed>|null $manifest */
    private static function backendRootFromManifest(?array $manifest): string
    {
        if (!is_array($manifest) || !is_array($manifest['backend'] ?? null)) return '';
        $normRel = static function (mixed $v): string {
            if (!is_string($v)) return '';
            $s = str_replace('\\', '/', trim($v));
            $s = preg_replace('#^(?:\./)+#', '', ltrim($s, '/')) ?? ltrim($s, '/');
            return strtolower(trim($s, '/'));
        };
        if (is_string($manifest['backend']['root'] ?? null)) {
            return $normRel($manifest['backend']['root']);
        }
        if (is_string($manifest['backend']['entry'] ?? null)) {
            $entryClean = $normRel($manifest['backend']['entry']);
            if (str_contains($entryClean, '/')) {
                $firstDir = explode('/', $entryClean)[0];
                if ($firstDir !== '' && !in_array($firstDir, ['assets', 'css', 'js', 'public', 'static', 'dist', 'frontend', 'src'], true)) {
                    return $firstDir;
                }
            }
        }
        return '';
    }

    /**
     * Whether this bundle routes page URLs dynamically through an SSR backend
     * (e.g. root PHP app or `backend.mode === "ssr"`).
     *
     * @param array<string, mixed>|null $manifest
     */
    private static function hasSsrBackend(ZipArchive $zip, ?array $manifest, string $prefix): bool
    {
        if (is_array($manifest)) {
            if (!empty($manifest['ssrEntry'])) return true;
            $backend = is_array($manifest['backend'] ?? null) ? $manifest['backend'] : null;
            if (is_array($backend)) {
                $mode = strtolower(trim((string) ($backend['mode'] ?? '')));
                if ($mode === 'ssr') return true;
                $main = is_string($manifest['main'] ?? null) ? strtolower(trim($manifest['main'])) : '';
                if ($main !== '' && str_ends_with($main, '.php')) return true;
            }
        }
        return $zip->locateName($prefix . 'index.php') !== false
            && $zip->locateName($prefix . 'index.html') === false
            && $zip->locateName($prefix . 'app.html') === false;
    }

    /**
     * Discover all public static HTML routes inside the bundle AND identify any
     * sub-pages declaring `noindex` / `none` in `<meta name="robots">` so
     * `/sitemap-apps.xml` never submits noindex URLs.
     *
     * @param array<string, mixed>|null $manifest
     * @return array{0: array<int, string>, 1: array<int, string>}
     */
    private static function discoverPublicPagesAndRobots(ZipArchive $zip, ?array $manifest, string $prefix): array
    {
        $feRoot = self::frontendRootFromManifest($manifest);
        $fePrefix = $feRoot !== '' ? strtolower($feRoot) . '/' : '';
        $backendRoot = self::backendRootFromManifest($manifest);
        $mainRel = is_array($manifest) && is_string($manifest['main'] ?? null)
            ? ltrim(str_replace('\\', '/', $manifest['main']), '/')
            : '';
        if ($feRoot !== '' && str_starts_with(strtolower($mainRel), $fePrefix)) {
            $mainRel = substr($mainRel, strlen($fePrefix));
        }

        $pages = [];
        $routeToZip = [];
        $seen = [];
        $limit = min($zip->numFiles, 600);
        for ($i = 0; $i < $limit; $i++) {
            $name = $zip->getNameIndex($i);
            if (!is_string($name) || str_ends_with($name, '/')) continue;
            $rel = $prefix !== '' && str_starts_with($name, $prefix) ? substr($name, strlen($prefix)) : $name;
            $rel = ltrim(str_replace('\\', '/', $rel), '/');
            if ($rel === '' || !self::isSafePublicUiPath($rel)) continue;
            $lower = strtolower($rel);
            if ($backendRoot !== '' && ($lower === $backendRoot || str_starts_with($lower, $backendRoot . '/'))) continue;
            if (preg_match('#(?:^|/)\.#', $rel) === 1) continue;
            if (preg_match('#^(?:vendor|node_modules|kit|lib|libs|__softn_generated__)/#', $lower) === 1) continue;
            if (preg_match('#/(?:vendor|node_modules)/#', $lower) === 1) continue;

            $ext = strtolower((string) pathinfo($lower, PATHINFO_EXTENSION));
            if ($ext !== 'html' && $ext !== 'htm') continue;

            $route = $rel;
            if ($fePrefix !== '') {
                if (!str_starts_with($lower, $fePrefix)) continue;
                $route = substr($rel, strlen($fePrefix));
            }
            $baseLower = strtolower((string) basename($route));
            if (in_array($baseLower, ['prerender.html', '__softn_ssr__.html', '404.html', '404.htm'], true)) continue;

            if (
                strtolower($route) === 'index.html'
                || strtolower($route) === 'index.htm'
                || ($mainRel !== '' && strtolower($route) === strtolower($mainRel))
            ) {
                $route = '';
            } elseif (preg_match('#^(.+)/index\.html?$#i', $route, $dm) === 1) {
                $route = $dm[1] . '/';
            }
            $key = strtolower($route);
            if (isset($seen[$key])) continue;
            $seen[$key] = true;
            $pages[] = $route;
            $routeToZip[$route] = $name;
        }
        usort($pages, static function (string $a, string $b): int {
            if ($a === '') return -1;
            if ($b === '') return 1;
            return strcmp($a, $b);
        });
        $pages = array_slice($pages, 0, self::MAX_PUBLIC_PAGES);

        $noindexPages = [];
        if (count($pages) > 1) {
            foreach ($pages as $route) {
                $zipName = $routeToZip[$route] ?? null;
                if (!is_string($zipName)) continue;
                $headSlice = $zip->getFromName($zipName, 8192);
                if (!is_string($headSlice) || stripos($headSlice, 'robots') === false) continue;
                $meta = self::extractHtmlPageMeta($headSlice);
                $rob = $meta['robots'] ?? '';
                if ($rob !== '' && preg_match('/(?:^|,)(?:noindex|none)(?:,|$)/', $rob) === 1) {
                    $noindexPages[] = $route;
                }
            }
        }
        return [$pages, $noindexPages];
    }

    /**
     * Resolve a requested sub-path (e.g. `"about.html"`, `"about"`, `"blog/"`,
     * `"blog/sandboxed-web.html"`) to a safe public UI entry inside the ZIP.
     *
     * @param array<string, mixed>|null $manifest
     * @return array{entry: ?string, virtualPath: string, currentDir: string}
     */
    private static function resolveSubPageEntry(
        ZipArchive $zip,
        ?array $manifest,
        string $prefix,
        string $subPath,
        bool $trailingSlash
    ): array {
        $feRoot = self::frontendRootFromManifest($manifest);
        $backendRoot = self::backendRootFromManifest($manifest);
        $lowerSub = strtolower($subPath);
        if (
            preg_match('#^(?:server|backend|private|db|database|migrations|__softn_generated__/private)(?:/|$)#', $lowerSub) === 1
            || ($backendRoot !== '' && ($lowerSub === $backendRoot || str_starts_with($lowerSub, $backendRoot . '/')))
        ) {
            return ['entry' => null, 'virtualPath' => '/' . $subPath, 'currentDir' => ''];
        }

        $candidates = [];
        $push = static function (string $rel) use (&$candidates, $feRoot): void {
            if ($feRoot !== '' && !str_starts_with(strtolower($rel), strtolower($feRoot) . '/')) {
                $candidates[] = $feRoot . '/' . $rel;
            }
            $candidates[] = $rel;
        };

        $lastSeg = str_contains($subPath, '/') ? substr($subPath, (int) strrpos($subPath, '/') + 1) : $subPath;
        $hasExt = str_contains($lastSeg, '.');

        if ($hasExt) {
            $push($subPath);
        } else {
            if ($trailingSlash) {
                $push($subPath . '/index.html');
                $push($subPath . '/index.htm');
                $push($subPath . '.html');
                $push($subPath . '.htm');
            } else {
                $push($subPath . '.html');
                $push($subPath . '.htm');
                $push($subPath . '/index.html');
                $push($subPath . '/index.htm');
                $push('ui/' . $subPath . '.ui');
                $push($subPath . '.ui');
            }
        }

        foreach ($candidates as $rel) {
            if (!self::isSafePublicUiPath($rel)) continue;
            $lower = strtolower($rel);
            if ($backendRoot !== '' && ($lower === $backendRoot || str_starts_with($lower, $backendRoot . '/'))) continue;
            $zipName = $prefix . $rel;
            if ($zip->locateName($zipName) === false) continue;

            $feRel = ($feRoot !== '' && str_starts_with($lower, strtolower($feRoot) . '/'))
                ? substr($rel, strlen($feRoot) + 1)
                : $rel;
            $feLower = strtolower($feRel);
            $manifestMainRel = '';
            if (is_array($manifest) && is_string($manifest['main'] ?? null)) {
                $m = ltrim(str_replace('\\', '/', trim($manifest['main'])), '/');
                if ($feRoot !== '' && str_starts_with(strtolower($m), strtolower($feRoot) . '/')) {
                    $m = substr($m, strlen($feRoot) + 1);
                }
                $manifestMainRel = strtolower($m);
            }
            if ($feLower === 'index.html' || $feLower === 'index.htm' || ($manifestMainRel !== '' && $feLower === $manifestMainRel)) {
                $virtualPath = '/';
                $currentDir = '';
            } elseif (preg_match('#^(.+)/index\.html?$#i', $feRel, $dm) === 1) {
                $virtualPath = '/' . $dm[1] . '/';
                $currentDir = $dm[1];
            } else {
                $virtualPath = '/' . $feRel;
                $currentDir = str_contains($feRel, '/') ? substr($feRel, 0, (int) strrpos($feRel, '/')) : '';
            }
            return ['entry' => $zipName, 'virtualPath' => $virtualPath, 'currentDir' => $currentDir];
        }

        return ['entry' => null, 'virtualPath' => '/' . $subPath . ($trailingSlash ? '/' : ''), 'currentDir' => ''];
    }

    /**
     * Extract theme mode, per-page SEO metadata, public page routes, and
     * sanitized rendered HTML directly from a bundle archive.
     *
     * @param array{themeMode: ?string, engineTier: ?string, publicPages: array<int, string>, noindexPages: array<int, string>, hasSsrBackend: bool}|null $bundleMeta
     * @return array<string, mixed>
     */
    public static function extractFromZip(
        string $bundlePath,
        string $subPath = '',
        bool $trailingSlash = false,
        ?string $linkBase = null,
        ?array $bundleMeta = null
    ): array {
        $empty = [
            'themeMode' => null,
            'previewHtml' => '',
            'sourceType' => 'none',
            'entryFile' => null,
            'engineTier' => null,
            'found' => false,
            'pageTitle' => null,
            'pageDescription' => null,
            'pageRobots' => null,
            'pageLang' => null,
            'virtualPath' => $subPath === '' ? '/' : ('/' . $subPath),
            'publicPages' => [],
            'noindexPages' => [],
            'hasSsrBackend' => false,
        ];
        if (!class_exists('ZipArchive')) return $empty;

        $zip = new ZipArchive();
        if ($zip->open($bundlePath, ZipArchive::RDONLY) !== true) return $empty;

        try {
            [$prefix, $manifest] = self::readPrefixAndManifest($zip);
            $hasSsrBackend = $bundleMeta !== null
                ? (bool) $bundleMeta['hasSsrBackend']
                : self::hasSsrBackend($zip, $manifest, $prefix);

            // Fast-fail missing sub-pages BEFORE scanning/decompressing the whole ZIP.
            $virtualPath = '/';
            $currentDir = '';
            $entryName = null;
            if ($subPath !== '') {
                $resolved = self::resolveSubPageEntry($zip, $manifest, $prefix, $subPath, $trailingSlash);
                $entryName = $resolved['entry'];
                $virtualPath = $resolved['virtualPath'];
                $currentDir = $resolved['currentDir'];
                if ($entryName === null && !$hasSsrBackend) {
                    $empty['virtualPath'] = $virtualPath;
                    return $empty;
                }
            }

            if ($bundleMeta !== null) {
                $themeMode = $bundleMeta['themeMode'];
                $engineTier = $bundleMeta['engineTier'];
                $publicPages = $bundleMeta['publicPages'];
                $noindexPages = $bundleMeta['noindexPages'];
            } else {
                $engineTier = self::detectEngineTierFromZip($zip);
                $themeMode = self::themeModeFromManifest($manifest);
                [$publicPages, $noindexPages] = self::discoverPublicPagesAndRobots($zip, $manifest, $prefix);
            }

            $base = [
                'themeMode' => $themeMode,
                'previewHtml' => '',
                'sourceType' => 'none',
                'entryFile' => null,
                'engineTier' => $engineTier,
                'found' => $subPath === '',
                'pageTitle' => null,
                'pageDescription' => null,
                'pageRobots' => null,
                'pageLang' => null,
                'virtualPath' => $virtualPath,
                'publicPages' => $publicPages,
                'noindexPages' => $noindexPages,
                'hasSsrBackend' => $hasSsrBackend,
            ];

            if ($subPath === '') {
                // 1. Prefer an explicit public pre-rendered HTML snapshot shipped inside the bundle for root.
                $bundledSnap = self::extractBundledSnapshot($zip, $manifest, $prefix, $linkBase);
                if ($bundledSnap !== null) {
                    return array_merge($base, [
                        'previewHtml' => $bundledSnap['html'],
                        'sourceType' => 'snapshot',
                        'entryFile' => $bundledSnap['file'],
                        'found' => true,
                        'pageTitle' => $bundledSnap['title'],
                        'pageDescription' => $bundledSnap['description'],
                        'pageRobots' => $bundledSnap['robots'],
                        'pageLang' => $bundledSnap['lang'],
                    ]);
                }
                $entryName = self::resolvePublicUiEntry($zip, $manifest, $prefix);
            } elseif ($entryName === null) {
                if ($hasSsrBackend && !preg_match('/\.(?:php|phtml|rs|sql|db|sqlite3?|env|ini|bak|log|sh|json|map|wasm|png|jpe?g|gif|webp|ico|woff2?|ttf|mp4|webm|mp3|wav)$/i', $subPath)) {
                    $base['found'] = true;
                    $base['sourceType'] = 'ssr-backend';
                    return $base;
                }
                $base['found'] = false;
                return $base;
            }

            if ($entryName === null) {
                return $base;
            }

            $relEntry = $prefix !== '' && str_starts_with($entryName, $prefix) ? substr($entryName, strlen($prefix)) : $entryName;
            $stat = $zip->statName($entryName);
            if ($stat === false || (int) $stat['size'] === 0 || (int) $stat['size'] > self::MAX_ENTRY_BYTES) {
                $base['found'] = true;
                $base['entryFile'] = $relEntry;
                return $base;
            }

            $content = $zip->getFromName($entryName, self::MAX_ENTRY_BYTES);
            if (!is_string($content) || trim($content) === '') {
                $base['found'] = true;
                $base['entryFile'] = $relEntry;
                return $base;
            }

            $ext = strtolower((string) pathinfo($entryName, PATHINFO_EXTENSION));
            if ($ext === 'ui') {
                $expanded = self::inlineUiImports($zip, $entryName, $content, $prefix);
                return array_merge($base, [
                    'previewHtml' => self::renderUi($expanded, $linkBase, $currentDir),
                    'sourceType' => 'ui',
                    'entryFile' => $relEntry,
                    'found' => true,
                ]);
            }
            if ($ext === 'html' || $ext === 'htm') {
                $pageMeta = self::extractHtmlPageMeta($content);
                $sanitized = self::sanitizeHtml($content, self::MAX_ENTRY_BYTES, $linkBase, $currentDir);
                $plainLen = strlen(trim(strip_tags($sanitized)));
                // When root index.html is an empty JS SPA shell (`<div id="app"></div>`), safely
                // extract static HTML templates from public frontend JS/JSX/Vue modules.
                if ($subPath === '' && $plainLen < 40) {
                    $jsHtml = self::extractHtmlFromFrontendJs($zip, $manifest, $prefix, $linkBase);
                    if ($jsHtml !== '') {
                        $sanitized = $sanitized !== '' ? ($sanitized . "\n" . $jsHtml) : $jsHtml;
                    }
                }
                // If this specific HTML page has zero runnable scripts and no inline handlers,
                // mark its per-page engineTier as 'none' so we skip preloading 2.9 MB WASM.
                $pageTier = (!self::htmlHasRunnableScript($content) && !$hasSsrBackend) ? 'none' : $engineTier;
                return array_merge($base, [
                    'previewHtml' => $sanitized,
                    'sourceType' => 'html',
                    'entryFile' => $relEntry,
                    'engineTier' => $pageTier,
                    'found' => true,
                    'pageTitle' => $pageMeta['title'],
                    'pageDescription' => $pageMeta['description'],
                    'pageRobots' => $pageMeta['robots'],
                    'pageLang' => $pageMeta['lang'],
                ]);
            }

            return $base;
        } catch (Throwable) {
            return $empty;
        } finally {
            $zip->close();
        }
    }

    /**
     * Check whether the bundle explicitly includes a pre-rendered public HTML snapshot.
     *
     * @param array<string, mixed>|null $manifest
     * @return array{html: string, file: string, title: ?string, description: ?string, robots: ?string}|null
     */
    private static function extractBundledSnapshot(ZipArchive $zip, ?array $manifest, string $prefix, ?string $linkBase = null): ?array
    {
        $candidates = [];
        if (is_array($manifest)) {
            $seo = is_array($manifest['seo'] ?? null) ? $manifest['seo'] : null;
            if (is_array($seo) && is_string($seo['prerender'] ?? null)) {
                $candidates[] = ltrim(str_replace('\\', '/', $seo['prerender']), '/');
            }
            if (is_string($manifest['prerender'] ?? null)) {
                $candidates[] = ltrim(str_replace('\\', '/', $manifest['prerender']), '/');
            }
            $feRoot = is_string($manifest['frontendRoot'] ?? null)
                ? trim(str_replace('\\', '/', $manifest['frontendRoot']), '/')
                : '';
            if ($feRoot !== '') {
                $candidates[] = $feRoot . '/prerender.html';
                $candidates[] = $feRoot . '/__softn_ssr__.html';
            }
        }
        $candidates[] = 'prerender.html';
        $candidates[] = '__softn_ssr__.html';

        foreach ($candidates as $rel) {
            if (!self::isSafePublicUiPath($rel)) continue;
            $ext = strtolower((string) pathinfo($rel, PATHINFO_EXTENSION));
            if ($ext !== 'html' && $ext !== 'htm') continue;
            $zipName = $prefix . $rel;
            $stat = $zip->statName($zipName);
            if ($stat === false || (int) $stat['size'] === 0 || (int) $stat['size'] > self::MAX_SNAPSHOT_BYTES) continue;
            $raw = $zip->getFromName($zipName, self::MAX_SNAPSHOT_BYTES);
            if (!is_string($raw) || trim($raw) === '') continue;
            $meta = self::extractHtmlPageMeta($raw);
            $sanitized = self::sanitizeHtml($raw, self::MAX_SNAPSHOT_BYTES, $linkBase, '');
            if ($sanitized !== '') {
                return [
                    'html' => $sanitized,
                    'file' => $rel,
                    'title' => $meta['title'],
                    'description' => $meta['description'],
                    'robots' => $meta['robots'],
                    'lang' => $meta['lang'],
                ];
            }
        }
        return null;
    }

    /**
     * Zero-execution HTML extraction for Container v2 JS/Vue/SPA bundles whose
     * `index.html` is a minimal mount point (`<div id="app"></div>`).
     * Scans only public frontend files (never server/backend/private/vendor),
     * extracts static `html\`...\`` template literals and Vue `<template>` blocks,
     * strips dynamic `${...}` expressions, and sanitizes strictly to semantic HTML5.
     *
     * @param array<string, mixed>|null $manifest
     */
    private static function extractHtmlFromFrontendJs(ZipArchive $zip, ?array $manifest, string $prefix, ?string $linkBase = null): string
    {
        $normRel = static function (mixed $v): string {
            if (!is_string($v)) return '';
            $s = str_replace('\\', '/', trim($v));
            $s = preg_replace('#^(?:\./)+#', '', ltrim($s, '/')) ?? ltrim($s, '/');
            return strtolower(trim($s, '/'));
        };
        $feRoot = is_array($manifest) ? $normRel($manifest['frontendRoot'] ?? null) : '';
        $backendRoot = '';
        if (is_array($manifest) && is_array($manifest['backend'] ?? null)) {
            if (is_string($manifest['backend']['root'] ?? null)) {
                $backendRoot = $normRel($manifest['backend']['root']);
            } elseif (is_string($manifest['backend']['entry'] ?? null)) {
                $entryClean = $normRel($manifest['backend']['entry']);
                if (str_contains($entryClean, '/')) {
                    $firstDir = explode('/', $entryClean)[0];
                    if ($firstDir !== '' && !in_array($firstDir, ['assets', 'css', 'js', 'public', 'static', 'dist', 'frontend', 'src'], true)) {
                        $backendRoot = $firstDir;
                    }
                }
            }
        }

        $candidates = [];
        for ($i = 0; $i < $zip->numFiles && $i < 600; $i++) {
            $name = $zip->getNameIndex($i);
            if (!is_string($name) || str_ends_with($name, '/')) continue;
            $rel = $prefix !== '' && str_starts_with($name, $prefix) ? substr($name, strlen($prefix)) : $name;
            if ($rel === '' || str_contains($rel, "\0") || str_contains($rel, '\\') || str_contains($rel, '..')) continue;
            $lower = strtolower(ltrim($rel, '/'));
            if ($feRoot !== '' && !str_starts_with($lower, strtolower($feRoot) . '/')) continue;
            if (preg_match('#^(?:server|backend|private|db|database|migrations|vendor|node_modules|kit|lib|libs|__softn_generated__)/#', $lower) === 1) {
                continue;
            }
            if ($backendRoot !== '' && ($lower === $backendRoot || str_starts_with($lower, $backendRoot . '/'))) {
                continue;
            }
            if (preg_match('#/(?:vendor|node_modules|chunks?)/#', $lower) === 1) continue;
            $ext = strtolower((string) pathinfo($lower, PATHINFO_EXTENSION));
            if (!in_array($ext, ['js', 'mjs', 'jsx', 'tsx', 'vue'], true)) continue;
            // Prioritize entry & view/page files before utility modules.
            $score = 50;
            if (preg_match('#(?:^|/)(?:main|app|index)\.(?:js|mjs|jsx|tsx|vue)$#', $lower) === 1) $score = 10;
            elseif (preg_match('#(?:^|/)(?:views|pages|screens|routes)/#', $lower) === 1) $score = 20;
            elseif (preg_match('#(?:^|/)(?:components|ui)/#', $lower) === 1) $score = 30;
            $candidates[] = ['score' => $score, 'zip' => $name, 'rel' => $rel, 'ext' => $ext];
        }

        usort($candidates, static fn(array $a, array $b): int => $a['score'] <=> $b['score'] ?: strcmp($a['rel'], $b['rel']));

        $chunks = [];
        $totalBytes = 0;
        $filesScanned = 0;
        foreach ($candidates as $cand) {
            if ($filesScanned >= self::MAX_IMPORT_FILES || $totalBytes >= self::MAX_ENTRY_BYTES) break;
            $stat = $zip->statName($cand['zip']);
            if ($stat === false || (int) $stat['size'] === 0 || (int) $stat['size'] > self::MAX_ENTRY_BYTES) continue;
            $src = $zip->getFromName($cand['zip'], self::MAX_ENTRY_BYTES);
            if (!is_string($src) || $src === '') continue;
            $filesScanned++;

            if ($cand['ext'] === 'vue') {
                if (preg_match('/<template\b[^>]*>([\s\S]*?)<\/template>/i', $src, $vm) === 1) {
                    $cleaned = preg_replace('/\{\{[\s\S]*?\}\}/', '', $vm[1]) ?? $vm[1];
                    $chunks[] = $cleaned;
                    $totalBytes += strlen($cleaned);
                }
                continue;
            }

            if (str_contains($src, 'html`')) {
                foreach (self::extractTaggedHtmlLiterals($src) as $frag) {
                    $chunks[] = $frag;
                    $totalBytes += strlen($frag);
                    if ($totalBytes >= self::MAX_ENTRY_BYTES) break;
                }
            }
        }

        if ($chunks === []) return '';
        return self::sanitizeHtml(implode("\n", $chunks), self::MAX_ENTRY_BYTES, $linkBase, '');
    }

    /**
     * Extract static HTML fragments from JS tagged template literals (`html\`...\``),
     * stripping `${...}` dynamic interpolations via balanced brace scanning.
     *
     * @return string[]
     */
    private static function extractTaggedHtmlLiterals(string $src, int $recursionDepth = 0): array
    {
        if ($recursionDepth >= 8) return [];
        $out = [];
        $len = strlen($src);
        $pos = 0;
        while ($pos < $len && count($out) < 120) {
            $idx = strpos($src, 'html`', $pos);
            if ($idx === false) break;
            // Ensure `html` is not the suffix of another identifier (e.g. `myhtml\``).
            if ($idx > 0 && preg_match('/[A-Za-z0-9_$]/', $src[$idx - 1]) === 1) {
                $pos = $idx + 5;
                continue;
            }
            $i = $idx + 5;
            $buf = '';
            while ($i < $len) {
                $ch = $src[$i];
                if ($ch === '\\' && $i + 1 < $len) {
                    $next = $src[$i + 1];
                    $buf .= ($next === '`' || $next === '$' || $next === '\\') ? $next : ('\\' . $next);
                    $i += 2;
                    continue;
                }
                if ($ch === '`') {
                    $i++;
                    break;
                }
                if ($ch === '$' && $i + 1 < $len && $src[$i + 1] === '{') {
                    // Skip balanced `${ ... }` expression, recursively collecting any nested `html\`...\`` inside it.
                    $depth = 1;
                    $quote = null;
                    $exprStart = $i + 2;
                    $j = $exprStart;
                    while ($j < $len && $depth > 0) {
                        $c = $src[$j];
                        if ($quote !== null) {
                            if ($c === '\\' && $j + 1 < $len) { $j += 2; continue; }
                            if ($c === $quote) $quote = null;
                        } else {
                            if ($c === '"' || $c === "'" || $c === '`') $quote = $c;
                            elseif ($c === '{') $depth++;
                            elseif ($c === '}') $depth--;
                        }
                        $j++;
                    }
                    $expr = substr($src, $exprStart, max(0, $j - $exprStart - 1));
                    if (str_contains($expr, 'html`') && $recursionDepth < 7) {
                        foreach (self::extractTaggedHtmlLiterals($expr, $recursionDepth + 1) as $nested) {
                            $buf .= ' ' . $nested . ' ';
                        }
                    } else {
                        $buf .= ' ';
                    }
                    $i = $j;
                    continue;
                }
                $buf .= $ch;
                $i++;
            }
            $pos = $i;
            if (str_contains($buf, '<') && trim($buf) !== '') {
                $out[] = $buf;
            }
        }
        return $out;
    }

    /**
     * Find the single public UI entry (`.ui` or `.html`/`.htm`) inside the archive.
     * Never returns server/backend/private paths or script files.
     *
     * @param array<string, mixed>|null $manifest
     */
    private static function resolvePublicUiEntry(ZipArchive $zip, ?array $manifest, string $prefix): ?string
    {
        $candidates = [];
        if (is_array($manifest)) {
            $frontendRoot = is_string($manifest['frontendRoot'] ?? null)
                ? trim(str_replace('\\', '/', $manifest['frontendRoot']), '/')
                : '';
            $main = is_string($manifest['main'] ?? null) ? ltrim(str_replace('\\', '/', $manifest['main']), '/') : '';
            if ($main !== '') {
                $candidates[] = $prefix . $main;
                if ($frontendRoot !== '' && !str_starts_with($main, $frontendRoot . '/')) {
                    $candidates[] = $prefix . $frontendRoot . '/' . $main;
                }
            }
            if ($frontendRoot !== '') {
                $candidates[] = $prefix . $frontendRoot . '/index.html';
            }
            $candidates[] = $prefix . 'index.html';
            $candidates[] = $prefix . 'ui/main.ui';
        } else {
            $candidates[] = $prefix . 'index.html';
            $candidates[] = $prefix . 'app.html';
            for ($i = 0; $i < $zip->numFiles && $i < 200; $i++) {
                $n = $zip->getNameIndex($i);
                if (!is_string($n) || str_ends_with($n, '/')) continue;
                $rel = $prefix !== '' && str_starts_with($n, $prefix) ? substr($n, strlen($prefix)) : $n;
                if (!str_contains($rel, '/') && preg_match('/\.html?$/i', $rel) === 1) {
                    $candidates[] = $n;
                }
            }
        }

        foreach ($candidates as $cand) {
            $rel = $prefix !== '' && str_starts_with($cand, $prefix) ? substr($cand, strlen($prefix)) : $cand;
            if (!self::isSafePublicUiPath($rel)) continue;
            if ($zip->locateName($cand) !== false) return $cand;
        }
        return null;
    }

    private static function isSafePublicUiPath(string $rel): bool
    {
        if ($rel === '' || str_contains($rel, "\0") || str_contains($rel, '\\') || str_contains($rel, '..')) return false;
        $lower = strtolower(ltrim($rel, '/'));
        if (preg_match('#^(?:server|backend|private|db|database|migrations|__softn_generated__/private)/#', $lower) === 1) {
            return false;
        }
        $ext = strtolower((string) pathinfo($lower, PATHINFO_EXTENSION));
        return in_array($ext, ['ui', 'html', 'htm'], true);
    }

    /**
     * Resolve relative `<import Name from="./sub.ui" />` references inside a
     * `.ui` file so multi-file SoftN apps produce rich View-Source semantic HTML.
     * Strictly bounded by depth, file count, and total expanded bytes.
     *
     * @param array<string, bool> $ancestors
     */
    private static function inlineUiImports(
        ZipArchive $zip,
        string $entryName,
        string $content,
        string $prefix,
        int $depth = 0,
        array $ancestors = [],
        int &$fileBudget = self::MAX_IMPORT_FILES
    ): string {
        if ($depth >= self::MAX_IMPORT_DEPTH || $fileBudget <= 0) return $content;
        if (!str_contains($content, '<import')) return $content;

        $ancestors[$entryName] = true;
        $baseRel = $prefix !== '' && str_starts_with($entryName, $prefix)
            ? substr($entryName, strlen($prefix))
            : $entryName;
        $baseDir = str_contains($baseRel, '/') ? substr($baseRel, 0, (int) strrpos($baseRel, '/')) : '';

        if (preg_match_all('/<import\s+([A-Z][A-Za-z0-9_]*)\s+from\s*=\s*(?:"([^"]+)"|\'([^\']+)\')\s*\/?>/', $content, $matches, PREG_SET_ORDER) < 1) {
            return $content;
        }

        $imports = [];
        foreach ($matches as $m) {
            if ($fileBudget <= 0) break;
            $comp = $m[1];
            $rawTarget = $m[2] !== '' ? $m[2] : ($m[3] ?? '');
            $resolvedRel = self::resolveRelativeUiPath($baseDir, $rawTarget);
            if ($resolvedRel === null) continue;
            if (!self::isSafePublicUiPath($resolvedRel) || strtolower((string) pathinfo($resolvedRel, PATHINFO_EXTENSION)) !== 'ui') {
                continue;
            }
            $zipName = $prefix . $resolvedRel;
            if (isset($ancestors[$zipName])) continue;
            $stat = $zip->statName($zipName);
            if ($stat === false || (int) $stat['size'] === 0 || (int) $stat['size'] > self::MAX_ENTRY_BYTES) continue;
            $child = $zip->getFromName($zipName, self::MAX_ENTRY_BYTES);
            if (!is_string($child) || trim($child) === '') continue;
            $fileBudget--;
            $imports[$comp] = self::inlineUiImports($zip, $zipName, $child, $prefix, $depth + 1, $ancestors, $fileBudget);
        }

        if ($imports === []) return $content;

        foreach ($imports as $comp => $body) {
            if (strlen($content) >= self::MAX_ENTRY_BYTES) break;
            $pattern = '/<' . preg_quote($comp, '/') . '(?:\s[^<>]*?)?\/>/';
            $runningLen = strlen($content);
            $expanded = preg_replace_callback(
                $pattern,
                static function (array $m) use ($body, &$runningLen): string {
                    $delta = strlen($body) + 2 - strlen($m[0]);
                    if ($runningLen + $delta > self::MAX_ENTRY_BYTES) return $m[0];
                    $runningLen += $delta;
                    return "\n" . $body . "\n";
                },
                $content,
                2
            );
            if (is_string($expanded) && strlen($expanded) <= self::MAX_ENTRY_BYTES) {
                $content = $expanded;
            }
        }
        return $content;
    }

    private static function resolveRelativeUiPath(string $baseDir, string $target): ?string
    {
        $clean = str_replace('\\', '/', trim($target));
        if ($clean === '' || str_contains($clean, "\0") || str_starts_with($clean, '/')) return null;
        $combined = $baseDir !== '' ? ($baseDir . '/' . $clean) : $clean;
        $parts = [];
        foreach (explode('/', $combined) as $seg) {
            if ($seg === '' || $seg === '.') continue;
            if ($seg === '..') {
                if ($parts === []) return null;
                array_pop($parts);
            } else {
                $parts[] = $seg;
            }
        }
        return $parts === [] ? null : implode('/', $parts);
    }

    /**
     * Extract safe per-page `<title>`, `<meta name="description">` (or `og:description`),
     * `<meta name="robots">`, and `<html lang="...">` from an HTML document without
     * executing anything or trusting `<script>`/`<style>`/comment contents.
     *
     * @return array{title: ?string, description: ?string, robots: ?string, lang: ?string}
     */
    public static function extractHtmlPageMeta(string $raw): array
    {
        $slice = strlen($raw) > 65536 ? substr($raw, 0, 65536) : $raw;
        $clean = self::stripNonContentHtml($slice, true);

        $lang = null;
        $htmlTags = self::scanOpenTagAttrs($clean, 'html', 1);
        if ($htmlTags !== []) {
            $rawLang = self::extractHtmlAttr($htmlTags[0], 'lang');
            if ($rawLang !== null) {
                $candLang = trim($rawLang);
                if (preg_match('/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8}){0,3}$/', $candLang) === 1) {
                    $lang = $candLang;
                }
            }
        }

        $head = $clean;
        if (preg_match('/<head\b[^>]*>([\s\S]*?)<\/head\s*>/i', $clean, $hm) === 1) {
            $head = $hm[1];
        } elseif (($bodyPos = stripos($clean, '<body')) !== false) {
            $head = substr($clean, 0, $bodyPos);
        }

        $title = null;
        if (preg_match('/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i', $head, $tm) === 1) {
            $t = self::cleanTextNode($tm[1]);
            if ($t !== '') {
                $title = self::clipUtf8($t, 160);
            }
        }

        $description = null;
        $ogDesc = null;
        $robots = null;
        foreach (self::scanOpenTagAttrs($head, 'meta', 64) as $attrStr) {
            $name = self::extractHtmlAttr($attrStr, 'name');
            $prop = self::extractHtmlAttr($attrStr, 'property');
            $content = self::extractHtmlAttr($attrStr, 'content');
            if ($content === null) continue;
            $key = strtolower(trim($name ?? $prop ?? ''));
            if ($key === 'description' && $description === null) {
                $d = self::cleanTextNode($content);
                if ($d !== '') $description = self::clipUtf8($d, 320);
            } elseif ($key === 'og:description' && $ogDesc === null) {
                $d = self::cleanTextNode($content);
                if ($d !== '') $ogDesc = self::clipUtf8($d, 320);
            } elseif ($key === 'robots' && $robots === null) {
                $robots = self::sanitizeRobotsDirective($content);
            }
        }

        return [
            'title' => $title,
            'description' => $description ?? $ogDesc,
            'robots' => $robots,
            'lang' => $lang,
        ];
    }

    /**
     * Linear O(N) quote-aware scanner that returns the raw attribute string of
     * opening `<$tagName ...>` tags without PCRE quantifier blowup or backtracking.
     *
     * @return array<int, string>
     */
    private static function scanOpenTagAttrs(string $html, string $tagName, int $maxTags = 64): array
    {
        $out = [];
        $len = strlen($html);
        $needle = '<' . strtolower($tagName);
        $nLen = strlen($needle);
        $pos = 0;
        while ($pos < $len && count($out) < $maxTags) {
            $lt = stripos($html, $needle, $pos);
            if ($lt === false) break;
            $after = $lt + $nLen;
            if ($after >= $len) break;
            $boundary = $html[$after];
            if ($boundary !== ' ' && $boundary !== "\t" && $boundary !== "\n" && $boundary !== "\r" && $boundary !== '/' && $boundary !== '>') {
                $pos = $after;
                continue;
            }
            $q = null;
            $gt = null;
            $scanEnd = min($len, $after + 2048);
            for ($k = $after; $k < $scanEnd; $k++) {
                $ch = $html[$k];
                if ($q !== null) {
                    if ($ch === $q) $q = null;
                } elseif ($ch === '"' || $ch === "'") {
                    $q = $ch;
                } elseif ($ch === '>') {
                    $gt = $k;
                    break;
                }
            }
            if ($gt === null) {
                $pos = $after;
                continue;
            }
            $attrs = substr($html, $after, $gt - $after);
            $out[] = rtrim($attrs, "/ \t\r\n");
            $pos = $gt + 1;
        }
        return $out;
    }

    private static function extractHtmlAttr(string $attrs, string $name): ?string
    {
        if (preg_match('/(?:^|\s)' . preg_quote($name, '/') . '\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s"\'=<>`]+))/i', $attrs, $m) !== 1) {
            return null;
        }
        if ($m[1] !== '') return $m[1];
        if (($m[2] ?? '') !== '') return $m[2];
        return $m[3] ?? '';
    }

    private static function sanitizeRobotsDirective(string $raw): ?string
    {
        $parts = preg_split('/\s*,\s*/', strtolower(trim($raw))) ?: [];
        $kept = [];
        foreach ($parts as $p) {
            if ($p === '') continue;
            if (in_array($p, ['index', 'noindex', 'follow', 'nofollow', 'noarchive', 'nosnippet', 'noimageindex', 'none', 'all'], true)
                || preg_match('/^max-image-preview:(?:none|standard|large)$/', $p) === 1
                || preg_match('/^max-snippet:(?:-1|[0-9]{1,4})$/', $p) === 1) {
                $kept[$p] = $p;
            }
        }
        return $kept === [] ? null : implode(',', array_values($kept));
    }

    private static function clipUtf8(string $text, int $maxChars): string
    {
        $clipped = preg_replace('/^(.{0,' . $maxChars . '})[\s\S]*$/u', '$1', $text);
        if (is_string($clipped) && $clipped !== '') return trim($clipped);
        return trim(substr($text, 0, $maxChars));
    }

    /**
     * Linear O(N) stripper for HTML comments, DOCTYPE, and active/non-content
     * subtrees (`<script>`, `<style>`, `<iframe>`, `<svg>`, etc.), handling
     * unclosed tags to EOF without quadratic PCRE backtracking.
     */
    private static function stripNonContentHtml(string $raw, bool $keepMeta = false): string
    {
        static $dropSubtree = [
            'script' => true, 'style' => true, 'noscript' => true, 'template' => true,
            'iframe' => true, 'object' => true, 'embed' => true, 'svg' => true, 'math' => true,
            'form' => true, 'textarea' => true, 'select' => true, 'canvas' => true,
            'audio' => true, 'video' => true,
        ];
        static $dropSingle = [
            'input' => true, 'meta' => true, 'link' => true, 'base' => true,
        ];
        $out = '';
        $len = strlen($raw);
        $i = 0;
        while ($i < $len) {
            $lt = strpos($raw, '<', $i);
            if ($lt === false) {
                $out .= substr($raw, $i);
                break;
            }
            if ($lt > $i) $out .= substr($raw, $i, $lt - $i);
            // HTML comment <!-- ... --> (unclosed comment drops through EOF)
            if (substr_compare($raw, '<!--', $lt, 4) === 0) {
                $end = strpos($raw, '-->', $lt + 4);
                if ($end === false) break;
                $i = $end + 3;
                continue;
            }
            // DOCTYPE / declaration <! ... >
            if ($lt + 1 < $len && $raw[$lt + 1] === '!') {
                $gt = strpos($raw, '>', $lt + 2);
                if ($gt === false) break;
                $i = $gt + 1;
                continue;
            }
            // Scan tag end respecting quoted attributes
            $gt = null;
            $q = null;
            for ($k = $lt + 1; $k < $len; $k++) {
                $ch = $raw[$k];
                if ($q !== null) {
                    if ($ch === $q) $q = null;
                } elseif ($ch === '"' || $ch === "'") {
                    $q = $ch;
                } elseif ($ch === '>') {
                    $gt = $k;
                    break;
                }
            }
            if ($gt === null) break;
            $tagSlice = substr($raw, $lt, $gt - $lt + 1);
            if (preg_match('/^<\s*([a-zA-Z][a-zA-Z0-9:-]*)(?=[\s\/>])/', $tagSlice, $tm) === 1) {
                $tag = strtolower($tm[1]);
                $selfClosing = str_ends_with(rtrim(substr($tagSlice, 0, -1)), '/');
                if (isset($dropSingle[$tag]) && !($keepMeta && $tag === 'meta')) {
                    $i = $gt + 1;
                    continue;
                }
                if (isset($dropSubtree[$tag])) {
                    $i = $gt + 1;
                    if (!$selfClosing) {
                        // Advance past matching closing tag; unclosed drops through EOF.
                        $closePos = null;
                        $searchFrom = $i;
                        while ($searchFrom < $len) {
                            $cand = stripos($raw, '</' . $tag, $searchFrom);
                            if ($cand === false) break;
                            $after = $cand + 2 + strlen($tag);
                            while ($after < $len && ($raw[$after] === ' ' || $raw[$after] === "\t" || $raw[$after] === "\n" || $raw[$after] === "\r")) {
                                $after++;
                            }
                            if ($after < $len && $raw[$after] === '>') {
                                $closePos = $after + 1;
                                break;
                            }
                            $searchFrom = $cand + 2;
                        }
                        if ($closePos === null) break;
                        $i = $closePos;
                    }
                    continue;
                }
            }
            $out .= $tagSlice;
            $i = $gt + 1;
        }
        return $out;
    }

    /**
     * Sanitize static HTML (from a Container v2 entry) into safe, balanced,
     * nicely formatted semantic HTML5 suitable for search engines and View Source.
     * When `$linkBase` is given (e.g. `"/play/<slug>"`), safe relative and
     * root-relative links are rewritten under `$linkBase` so crawlers and
     * View Source show navigable multi-page links.
     */
    public static function sanitizeHtml(
        string $raw,
        int $maxBytes = self::MAX_ENTRY_BYTES,
        ?string $linkBase = null,
        string $currentDir = ''
    ): string {
        if (strlen($raw) > $maxBytes) {
            $raw = substr($raw, 0, $maxBytes);
        }
        // Strip comments, doctype, and non-content / active / embedded subtrees in O(N)
        // BEFORE locating <body> so a literal `<body>...</body>` inside a <script> or comment
        // cannot hijack extraction and unclosed tags fail closed to EOF.
        $raw = self::stripNonContentHtml($raw);
        // Extract body contents when a full document is supplied.
        $bodyMatch = preg_match('/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i', $raw, $m);
        if ($bodyMatch === false) return '';
        if ($bodyMatch === 1) {
            $raw = $m[1];
        } else {
            $strippedHead = preg_replace('/<head\b[^>]*>[\s\S]*?<\/head\s*>/i', '', $raw);
            if ($strippedHead === null) return '';
            $raw = $strippedHead;
        }

        $hasH1 = preg_match('/<h1(?:\s|>)/i', $raw) === 1;
        $root = ['tag' => '#root', 'attrs' => '', 'children' => []];
        $stack = [&$root];
        $nodes = 0;

        $tokens = preg_split('/(<\/?[a-zA-Z][a-zA-Z0-9:-]*(?:\s[^<>]*?)?\/?>)/', $raw, -1, PREG_SPLIT_DELIM_CAPTURE | PREG_SPLIT_NO_EMPTY);
        if (!is_array($tokens)) return '';

        foreach ($tokens as $tok) {
            if ($nodes >= self::MAX_NODES) break;
            if ($tok[0] === '<' && str_ends_with($tok, '>')) {
                if (preg_match('/^<\/([a-zA-Z][a-zA-Z0-9:-]*)\s*>$/', $tok, $cm) === 1) {
                    $closeTag = strtolower($cm[1]);
                    if (!isset(self::ALLOWED_HTML_TAGS[$closeTag]) || isset(self::VOID_TAGS[$closeTag])) continue;
                    // Pop up to matching tag (by original source tag name, so shifted h1..h5, main->section or a->span closes cleanly).
                    for ($idx = count($stack) - 1; $idx >= 1; $idx--) {
                        if (($stack[$idx]['orig'] ?? $stack[$idx]['tag']) === $closeTag) {
                            while (count($stack) > $idx) array_pop($stack);
                            break;
                        }
                    }
                    continue;
                }
                if (preg_match('/^<([a-zA-Z][a-zA-Z0-9:-]*)(\s[^<>]*?)?(\/?)>$/', $tok, $om) === 1) {
                    $origTag = strtolower($om[1]);
                    $tag = $origTag;
                    $rawAttrs = $om[2] ?? '';
                    // Preserve meaningful <img alt="..."> text without making external image requests.
                    if ($origTag === 'img') {
                        $rawAlt = self::extractHtmlAttr($rawAttrs, 'alt');
                        if ($rawAlt !== null) {
                            $altText = self::cleanTextNode($rawAlt);
                            if ($altText !== '' && count($stack) - 1 < self::MAX_DEPTH) {
                                $nodes++;
                                $parent = &$stack[count($stack) - 1];
                                $parent['children'][] = ['tag' => 'span', 'orig' => 'img', 'attrs' => '', 'children' => [$altText]];
                            }
                        }
                        continue;
                    }
                    $selfClosing = ($om[3] ?? '') === '/' || isset(self::VOID_TAGS[$tag]);
                    if (!isset(self::ALLOWED_HTML_TAGS[$tag])) continue;
                    if (count($stack) - 1 >= self::MAX_DEPTH) continue;

                    // Preserve a clean single-<h1> outline: when the preview contains <h1>, shift
                    // heading levels down (h1->h2, h2->h3, ..., h5->h6), and map <main> to <section>.
                    if ($hasH1 && strlen($tag) === 2 && $tag[0] === 'h' && $tag[1] >= '1' && $tag[1] <= '5') {
                        $tag = 'h' . ((int) $tag[1] + 1);
                    } elseif ($tag === 'main') {
                        $tag = 'section';
                    }

                    $attrs = '';
                    if ($tag === 'a') {
                        $link = self::extractSafeHref($rawAttrs, $linkBase, $currentDir);
                        if ($link !== null) {
                            $rel = $link['external'] ? ' rel="nofollow ugc noopener noreferrer"' : '';
                            $attrs = ' href="' . self::esc($link['href']) . '"' . $rel;
                        } else {
                            $tag = 'span';
                        }
                    } elseif ($tag === 'button') {
                        $attrs = ' type="button"';
                    }

                    $node = ['tag' => $tag, 'orig' => $origTag, 'attrs' => $attrs, 'children' => []];
                    $nodes++;
                    $parent = &$stack[count($stack) - 1];
                    $parent['children'][] = $node;
                    if (!$selfClosing) {
                        $lastIdx = count($parent['children']) - 1;
                        $stack[] = &$parent['children'][$lastIdx];
                    }
                }
                continue;
            }

            $text = self::cleanTextNode($tok);
            if ($text !== '') {
                $parent = &$stack[count($stack) - 1];
                $parent['children'][] = $text;
            }
        }

        return self::serializeChildren($root['children'], 0);
    }

    /**
     * Render static semantic HTML5 from a Classic SoftN `.ui` document.
     * Strips `<logic>`, `<data>`, `<style>`, `<script>` and dynamic `{expr}`
     * interpolations so only safe static content and structure are rendered.
     */
    public static function renderUi(string $raw, ?string $linkBase = null, string $currentDir = ''): string
    {
        if (strlen($raw) > self::MAX_ENTRY_BYTES) {
            $raw = substr($raw, 0, self::MAX_ENTRY_BYTES);
        }
        $raw = preg_replace('/<!--[\s\S]*?-->/', '', $raw) ?? $raw;
        $raw = preg_replace('/^\s*\/\/[^\n]*$/m', '', $raw) ?? $raw;
        $raw = preg_replace('/<(logic|script|style|data|import)\b[^>]*>[\s\S]*?<\/\1\s*>/i', '', $raw) ?? $raw;
        $raw = preg_replace('/<(logic|script|style|data|import)\b[^>]*\/?>/i', '', $raw) ?? $raw;
        // Remove SoftN template control directives (#if, #else, #each, #end, /if, /each).
        $raw = preg_replace('/^\s*[#\/](?:if|else|elseif|elif|each|for|end|slot)\b[^\n]*$/mi', '', $raw) ?? $raw;

        $root = ['tag' => '#root', 'attrs' => '', 'children' => []];
        $stack = [&$root];
        $nodes = 0;

        $len = strlen($raw);
        $pos = 0;
        while ($pos < $len && $nodes < self::MAX_NODES) {
            $lt = strpos($raw, '<', $pos);
            if ($lt === false) {
                $chunk = substr($raw, $pos);
                $text = self::extractStaticUiText($chunk);
                if ($text !== '') {
                    $parent = &$stack[count($stack) - 1];
                    $parent['children'][] = $text;
                }
                break;
            }
            if ($lt > $pos) {
                $chunk = substr($raw, $pos, $lt - $pos);
                $text = self::extractStaticUiText($chunk);
                if ($text !== '') {
                    $parent = &$stack[count($stack) - 1];
                    $parent['children'][] = $text;
                }
            }

            $tagEnd = self::findUiTagEnd($raw, $lt);
            if ($tagEnd === null) break;
            $tagSlice = substr($raw, $lt, $tagEnd - $lt + 1);
            $pos = $tagEnd + 1;

            if (preg_match('/^<\/([A-Za-z][A-Za-z0-9_.:-]*)\s*>$/', $tagSlice, $cm) === 1) {
                $orig = strtolower($cm[1]);
                for ($idx = count($stack) - 1; $idx >= 1; $idx--) {
                    if (($stack[$idx]['orig'] ?? '') === $orig) {
                        while (count($stack) > $idx) array_pop($stack);
                        break;
                    }
                }
                continue;
            }

            if (preg_match('/^<([A-Za-z][A-Za-z0-9_.:-]*)([\s\S]*?)(\/?)>$/', $tagSlice, $om) === 1) {
                $orig = strtolower($om[1]);
                $rawAttrs = $om[2];
                $selfClosing = $om[3] === '/';

                // Map SoftN component name to safe semantic HTML5 tag.
                $htmlTag = self::UI_TAG_MAP[$orig] ?? null;
                if ($htmlTag === null) {
                    // For unknown input-like controls, extract static label/placeholder text if present.
                    if (in_array($orig, ['input', 'textarea', 'select', 'checkbox', 'switch', 'toggle', 'slider'], true)) {
                        $labelText = self::extractStaticUiProp($rawAttrs, ['label', 'placeholder', 'title']);
                        if ($labelText !== null && count($stack) - 1 < self::MAX_DEPTH) {
                            $nodes++;
                            $parent = &$stack[count($stack) - 1];
                            $parent['children'][] = ['tag' => 'label', 'orig' => $orig, 'attrs' => '', 'children' => [$labelText]];
                        }
                    }
                    continue;
                }

                if ($orig === 'heading' && preg_match('/\blevel\s*=\s*(?:\{\s*([1-6])\s*\}|["\']([1-6])["\'])/i', $rawAttrs, $lm) === 1) {
                    $lvl = (int) ($lm[1] !== '' ? $lm[1] : $lm[2]);
                    // Keep app page <h1> unique; map heading levels 1..5 to h2..h6.
                    $htmlTag = 'h' . min(6, max(2, $lvl + 1));
                }

                $isVoid = isset(self::VOID_TAGS[$htmlTag]);
                if (count($stack) - 1 >= self::MAX_DEPTH) continue;

                $attrs = '';
                if ($htmlTag === 'a') {
                    $link = self::extractSafeHref($rawAttrs, $linkBase, $currentDir);
                    if ($link !== null) {
                        $rel = $link['external'] ? ' rel="nofollow ugc noopener noreferrer"' : '';
                        $attrs = ' href="' . self::esc($link['href']) . '"' . $rel;
                    } else {
                        $htmlTag = 'span';
                    }
                } elseif ($htmlTag === 'button') {
                    $attrs = ' type="button"';
                }

                $children = [];
                $titleProp = self::extractStaticUiProp($rawAttrs, ['title']);
                $subtitleProp = self::extractStaticUiProp($rawAttrs, ['subtitle', 'description']);
                $labelProp = self::extractStaticUiProp($rawAttrs, ['label', 'text', 'value']);

                if ($htmlTag === 'section' || $htmlTag === 'aside' || $htmlTag === 'article') {
                    if ($titleProp !== null) $children[] = ['tag' => 'h3', 'orig' => 'h3', 'attrs' => '', 'children' => [$titleProp]];
                    if ($subtitleProp !== null) $children[] = ['tag' => 'p', 'orig' => 'p', 'attrs' => '', 'children' => [$subtitleProp]];
                } elseif ($labelProp !== null) {
                    $children[] = $labelProp;
                } elseif ($titleProp !== null) {
                    $children[] = $titleProp;
                }

                $node = ['tag' => $htmlTag, 'orig' => $orig, 'attrs' => $attrs, 'children' => $children];
                $nodes++;
                $parent = &$stack[count($stack) - 1];
                $parent['children'][] = $node;
                if (!$selfClosing && !$isVoid) {
                    $lastIdx = count($parent['children']) - 1;
                    $stack[] = &$parent['children'][$lastIdx];
                }
            }
        }

        return self::serializeChildren($root['children'], 0);
    }

    /**
     * Find the closing `>` of a SoftN `.ui` tag while respecting quoted strings
     * and nested `{ ... }` attribute expressions (e.g. `style={{ gap: "8px" }}`).
     */
    private static function findUiTagEnd(string $src, int $start): ?int
    {
        $len = strlen($src);
        $braceDepth = 0;
        $quote = null;
        for ($i = $start + 1; $i < $len; $i++) {
            $ch = $src[$i];
            if ($quote !== null) {
                if ($ch === '\\' && $i + 1 < $len) { $i++; continue; }
                if ($ch === $quote) $quote = null;
                continue;
            }
            if ($ch === '"' || $ch === "'" || $ch === '`') {
                $quote = $ch;
                continue;
            }
            if ($ch === '{') { $braceDepth++; continue; }
            if ($ch === '}') { if ($braceDepth > 0) $braceDepth--; continue; }
            if ($ch === '>' && $braceDepth === 0) return $i;
        }
        return null;
    }

    /**
     * Extract static text from a `.ui` text segment. Static string literals
     * inside `{ "Hello" }` are included; dynamic expressions `{count}` are omitted.
     */
    private static function extractStaticUiText(string $chunk): string
    {
        $out = '';
        $len = strlen($chunk);
        $i = 0;
        while ($i < $len) {
            $brace = strpos($chunk, '{', $i);
            if ($brace === false) {
                $out .= substr($chunk, $i);
                break;
            }
            $out .= substr($chunk, $i, $brace - $i);
            // Match balanced `{ ... }` expression.
            $depth = 1;
            $quote = null;
            $j = $brace + 1;
            while ($j < $len && $depth > 0) {
                $ch = $chunk[$j];
                if ($quote !== null) {
                    if ($ch === '\\' && $j + 1 < $len) { $j += 2; continue; }
                    if ($ch === $quote) $quote = null;
                } else {
                    if ($ch === '"' || $ch === "'" || $ch === '`') $quote = $ch;
                    elseif ($ch === '{') $depth++;
                    elseif ($ch === '}') $depth--;
                }
                $j++;
            }
            $expr = trim(substr($chunk, $brace + 1, max(0, $j - $brace - 2)));
            // Only emit purely static quoted string literals.
            if (preg_match('/^(?:"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"|\'([^\'\\\\]*(?:\\\\.[^\'\\\\]*)*)\')$/s', $expr, $sm) === 1) {
                $lit = $sm[1] !== '' ? $sm[1] : ($sm[2] ?? '');
                $out .= stripcslashes($lit);
            }
            $i = $j;
        }
        // Strip SoftN template directives (#if(...), #else, #each(...), #end, /if, /each),
        // including inline directives right after tags or with nested parentheses.
        $out = self::stripUiDirectives($out);
        return self::cleanTextNode($out);
    }

    private static function stripUiDirectives(string $text): string
    {
        if (!str_contains($text, '#') && !str_contains($text, '/')) return $text;
        $out = '';
        $len = strlen($text);
        $i = 0;
        while ($i < $len) {
            if (preg_match('/\G#(else\s+if|elseif|elif|if|each|for)\b/i', $text, $m, 0, $i) === 1) {
                $i += strlen($m[0]);
                while ($i < $len && ($text[$i] === ' ' || $text[$i] === "\t")) $i++;
                if ($i < $len && $text[$i] === '(') {
                    $depth = 1;
                    $q = null;
                    $i++;
                    while ($i < $len && $depth > 0) {
                        $c = $text[$i];
                        if ($q !== null) {
                            if ($c === '\\' && $i + 1 < $len) { $i += 2; continue; }
                            if ($c === $q) $q = null;
                        } else {
                            if ($c === '"' || $c === "'" || $c === '`') $q = $c;
                            elseif ($c === '(') $depth++;
                            elseif ($c === ')') $depth--;
                        }
                        $i++;
                    }
                }
                // Consume optional trailing `key=...` clause on #each
                if (preg_match('/\G\s+key\s*=\s*\S*/i', $text, $km, 0, $i) === 1) {
                    $i += strlen($km[0]);
                }
                $out .= ' ';
                continue;
            }
            if (preg_match('/\G(?:#(?:else|end|slot)|\/(?:if|each|for))\b/i', $text, $m, 0, $i) === 1) {
                $i += strlen($m[0]);
                $out .= ' ';
                continue;
            }
            $out .= $text[$i++];
        }
        return $out;
    }

    /** @param string[] $names */
    private static function extractStaticUiProp(string $attrs, array $names): ?string
    {
        foreach ($names as $name) {
            if (preg_match('/\b' . preg_quote($name, '/') . '\s*=\s*(?:"([^"]*)"|\'([^\']*)\')/i', $attrs, $m) === 1) {
                $val = $m[1] !== '' ? $m[1] : ($m[2] ?? '');
                $cleaned = self::cleanTextNode($val);
                if ($cleaned !== '') return $cleaned;
            }
        }
        return null;
    }

    /** @return array{href: string, external: bool}|null */
    private static function extractSafeHref(string $rawAttrs, ?string $linkBase = null, string $currentDir = ''): ?array
    {
        if (preg_match('/\bhref\s*=\s*(?:"([^"]*)"|\'([^\']*)\')/i', $rawAttrs, $m) !== 1) return null;
        $raw = $m[1] !== '' ? $m[1] : ($m[2] ?? '');
        $decoded = trim(html_entity_decode($raw, ENT_QUOTES | ENT_HTML5, 'UTF-8'));
        if ($decoded === '' || strlen($decoded) > 512) return null;
        if (preg_match('/[\x00-\x20\x7F"\'<>]/', $decoded) === 1) return null;
        if (preg_match('#^https?://[A-Za-z0-9.\-\[\]:]+(?:/.*)?$#i', $decoded) === 1) {
            return ['href' => $decoded, 'external' => true];
        }
        if ($linkBase === null || $linkBase === '') return null;

        // Same-page fragment link (`#faq`)
        if ($decoded[0] === '#') {
            return preg_match('/^#[A-Za-z0-9._~:%+-]{1,128}$/', $decoded) === 1
                ? ['href' => $decoded, 'external' => false]
                : null;
        }
        // Reject protocol-relative (`//evil.test`), backslashes, or any URI scheme (`javascript:`, `data:`, `mailto:`).
        if (str_starts_with($decoded, '//') || str_contains($decoded, '\\')) return null;
        $pathEnd = strcspn($decoded, '?#');
        $pathPart = substr($decoded, 0, $pathEnd);
        $rest = substr($decoded, $pathEnd);
        if (str_contains($pathPart, ':')) return null;

        $isRootRel = str_starts_with($pathPart, '/');
        $trailingSlash = str_ends_with($pathPart, '/');
        $combined = $isRootRel
            ? ltrim($pathPart, '/')
            : ($currentDir !== '' ? ($currentDir . '/' . $pathPart) : $pathPart);
        $parts = [];
        foreach (explode('/', $combined) as $seg) {
            if ($seg === '' || $seg === '.') continue;
            if ($seg === '..') {
                if ($parts === []) return null;
                array_pop($parts);
                continue;
            }
            if (str_starts_with($seg, '.')) return null;
            $parts[] = $seg;
        }
        $normPath = implode('/', $parts);
        $lowerNorm = strtolower($normPath);
        if (preg_match('#^(?:server|backend|private|db|database|migrations|__softn_generated__/private)(?:/|$)#', $lowerNorm) === 1) {
            return null;
        }
        $base = rtrim($linkBase, '/');
        if ($normPath === '' || $lowerNorm === 'index.html' || $lowerNorm === 'index.htm') {
            return ['href' => $base . $rest, 'external' => false];
        }
        if (preg_match('#^(.+)/index\.html?$#i', $normPath, $dm) === 1) {
            return ['href' => $base . '/' . $dm[1] . '/' . $rest, 'external' => false];
        }
        $suffix = ($trailingSlash && !str_contains($parts[count($parts) - 1], '.')) ? '/' : '';
        return ['href' => $base . '/' . $normPath . $suffix . $rest, 'external' => false];
    }

    private static function cleanTextNode(string $raw): string
    {
        $decoded = html_entity_decode($raw, ENT_QUOTES | ENT_HTML5, 'UTF-8');
        $clean = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/', '', $decoded) ?? '';
        $clean = preg_replace('/\s+/', ' ', $clean) ?? '';
        return trim($clean);
    }

    /**
     * Serialize pruned AST children into indented, bounded semantic HTML5.
     *
     * @param array<int, string|array<string, mixed>> $children
     */
    private static function serializeChildren(array $children, int $indent): string
    {
        $bytes = 0;
        $parts = [];
        foreach ($children as $child) {
            if ($bytes >= self::MAX_OUTPUT_BYTES) break;
            $chunk = self::serializeNode($child, $indent, $bytes);
            if ($chunk !== '') $parts[] = $chunk;
        }
        return implode("\n", $parts);
    }

    /** @param string|array<string, mixed> $node */
    private static function serializeNode(string|array $node, int $indent, int &$bytes): string
    {
        if ($bytes >= self::MAX_OUTPUT_BYTES) return '';
        $pad = str_repeat('  ', min($indent, 8));
        if (is_string($node)) {
            $escaped = self::esc($node);
            if ($escaped === '') return '';
            $bytes += strlen($escaped);
            return $pad . $escaped;
        }

        $tag = (string) $node['tag'];
        $attrs = (string) ($node['attrs'] ?? '');
        if (isset(self::VOID_TAGS[$tag])) {
            $out = $pad . '<' . $tag . ' />';
            $bytes += strlen($out);
            return $out;
        }

        $rawChildren = is_array($node['children'] ?? null) ? $node['children'] : [];
        // Collapse redundant wrapper <div> elements that hold no attributes and no direct
        // inline text, so View Source stays crisp and semantic instead of deep div ladders.
        if ($tag === 'div' && $attrs === '') {
            $hasDirectText = false;
            foreach ($rawChildren as $rc) {
                if (is_string($rc) && trim($rc) !== '') {
                    $hasDirectText = true;
                    break;
                }
            }
            if (!$hasDirectText) {
                $unwrapped = [];
                foreach ($rawChildren as $rc) {
                    if ($bytes >= self::MAX_OUTPUT_BYTES) break;
                    $s = self::serializeNode($rc, $indent, $bytes);
                    if ($s !== '') $unwrapped[] = $s;
                }
                return implode("\n", $unwrapped);
            }
        }

        $innerParts = [];
        $hasElementChild = false;
        foreach ($rawChildren as $child) {
            if ($bytes >= self::MAX_OUTPUT_BYTES) break;
            if (is_array($child)) {
                $s = self::serializeNode($child, $indent + 1, $bytes);
                if ($s !== '') {
                    $innerParts[] = $s;
                    $hasElementChild = true;
                }
            } else {
                $escaped = self::esc($child);
                if ($escaped !== '') {
                    $bytes += strlen($escaped);
                    $innerParts[] = $escaped;
                }
            }
        }

        // Prune completely empty containers.
        if ($innerParts === []) return '';

        if (!$hasElementChild) {
            $inline = implode(' ', $innerParts);
            $out = $pad . '<' . $tag . $attrs . '>' . $inline . '</' . $tag . '>';
            $bytes += strlen($tag) * 2 + strlen($attrs) + 5;
            return $out;
        }

        $lines = [$pad . '<' . $tag . $attrs . '>'];
        foreach ($innerParts as $part) {
            $lines[] = str_starts_with($part, '  ') ? $part : ($pad . '  ' . $part);
        }
        $lines[] = $pad . '</' . $tag . '>';
        $bytes += strlen($tag) * 2 + strlen($attrs) + 7;
        return implode("\n", $lines);
    }

    private static function esc(string $value): string
    {
        return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML5, 'UTF-8');
    }
}
