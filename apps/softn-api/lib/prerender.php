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
    public const VERSION = 4;
    private const MAX_ENTRY_BYTES = 262144;
    private const MAX_SNAPSHOT_BYTES = 524288;
    private const MAX_IMPORT_FILES = 16;
    private const MAX_IMPORT_DEPTH = 4;
    private const MAX_OUTPUT_BYTES = 24576;
    private const MAX_NODES = 400;
    private const MAX_DEPTH = 32;

    /** @var array<string, bool> */
    private const ALLOWED_HTML_TAGS = [
        'h1' => true, 'h2' => true, 'h3' => true, 'h4' => true, 'h5' => true, 'h6' => true,
        'p' => true, 'ul' => true, 'ol' => true, 'li' => true,
        'section' => true, 'article' => true, 'header' => true, 'main' => true, 'footer' => true, 'nav' => true, 'aside' => true,
        'div' => true, 'span' => true, 'a' => true, 'strong' => true, 'b' => true, 'em' => true, 'i' => true,
        'code' => true, 'pre' => true, 'blockquote' => true,
        'table' => true, 'thead' => true, 'tbody' => true, 'tr' => true, 'th' => true, 'td' => true,
        'dl' => true, 'dt' => true, 'dd' => true, 'figure' => true, 'figcaption' => true,
        'hr' => true, 'br' => true, 'label' => true, 'button' => true,
    ];

    /** @var array<string, bool> */
    private const VOID_TAGS = ['br' => true, 'hr' => true];

    /** @var array<string, bool> */
    private const BLOCK_TAGS = [
        'h1' => true, 'h2' => true, 'h3' => true, 'h4' => true, 'h5' => true, 'h6' => true,
        'p' => true, 'ul' => true, 'ol' => true, 'li' => true,
        'section' => true, 'article' => true, 'header' => true, 'main' => true, 'footer' => true, 'nav' => true, 'aside' => true,
        'div' => true, 'pre' => true, 'blockquote' => true,
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
     * Load cached or freshly extracted pre-render metadata for a bundle.
     * Optionally uses a live-captured `$snapshotPath` (e.g. `data/apps/<slug>/ssr.html`)
     * when fresh, always passing it through `sanitizeHtml()`.
     *
     * @return array{themeMode: ?string, previewHtml: string, sourceType: string, entryFile: ?string}
     */
    public static function forBundle(
        string $bundlePath,
        string $bundleSha,
        ?string $cacheDir,
        bool $withholdBackend,
        ?string $snapshotPath = null,
        ?string $snapshotSha = null
    ): array {
        $empty = ['themeMode' => null, 'previewHtml' => '', 'sourceType' => 'none', 'entryFile' => null];
        if (!is_file($bundlePath)) return $empty;

        $activeSnapshot = self::usableSnapshotPath($snapshotPath, $bundlePath, $bundleSha, $snapshotSha);
        $snapTag = '';
        if ($activeSnapshot !== null) {
            $st = @stat($activeSnapshot);
            $snapTag = '-s' . substr(hash('sha256', (string) ($st['mtime'] ?? 0) . ':' . (string) ($st['size'] ?? 0)), 0, 8);
        }

        $cacheFile = null;
        if ($cacheDir !== null && $bundleSha !== '') {
            $pathHash = substr(hash('sha256', $bundlePath . '|' . ($activeSnapshot ?? '')), 0, 8);
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
                ) {
                    $tm = $decoded['themeMode'] ?? null;
                    $ef = $decoded['entryFile'] ?? null;
                    return [
                        'themeMode' => ($tm === 'light' || $tm === 'dark') ? $tm : null,
                        'previewHtml' => $decoded['previewHtml'],
                        'sourceType' => $decoded['sourceType'],
                        'entryFile' => is_string($ef) ? $ef : null,
                    ];
                }
            }
        }

        $result = self::extractFromZip($bundlePath);
        if ($activeSnapshot !== null) {
            $rawSnap = @file_get_contents($activeSnapshot, false, null, 0, self::MAX_SNAPSHOT_BYTES);
            if (is_string($rawSnap) && trim($rawSnap) !== '') {
                $sanitizedSnap = self::sanitizeHtml($rawSnap, self::MAX_SNAPSHOT_BYTES);
                if ($sanitizedSnap !== '') {
                    $result['previewHtml'] = $sanitizedSnap;
                    $result['sourceType'] = 'snapshot';
                    $result['entryFile'] = 'ssr.html';
                }
            }
        }

        if ($cacheFile !== null) {
            try {
                if (!is_dir($cacheDir)) @mkdir($cacheDir, 0775, true);
                if (is_dir($cacheDir)) {
                    $encoded = json_encode(['v' => self::VERSION] + $result, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
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

        return $result;
    }

    private static function usableSnapshotPath(
        ?string $snapshotPath,
        string $bundlePath,
        string $bundleSha,
        ?string $snapshotSha = null
    ): ?string {
        if ($snapshotPath === null || $snapshotPath === '' || !is_file($snapshotPath)) return null;
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

    /**
     * Extract theme mode and sanitized rendered HTML directly from a bundle archive.
     *
     * @return array{themeMode: ?string, previewHtml: string, sourceType: string, entryFile: ?string}
     */
    public static function extractFromZip(string $bundlePath): array
    {
        $empty = ['themeMode' => null, 'previewHtml' => '', 'sourceType' => 'none', 'entryFile' => null];
        if (!class_exists('ZipArchive')) return $empty;

        $zip = new ZipArchive();
        if ($zip->open($bundlePath, ZipArchive::RDONLY) !== true) return $empty;

        try {
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
                        if ($zip->locateName($candPrefix . 'manifest.json') !== false) {
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
                                $manifestName = $candPrefix . 'manifest.json';
                            }
                        }
                    }
                }
            }

            $manifest = null;
            $themeMode = null;
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

            if (is_array($manifest)) {
                $theme = is_array($manifest['config'] ?? null) ? ($manifest['config']['theme'] ?? null) : null;
                $mode = is_array($theme) ? ($theme['mode'] ?? null) : null;
                if ($mode === 'light' || $mode === 'dark') {
                    $themeMode = $mode;
                } elseif (in_array($manifest['theme'] ?? null, ['light', 'dark'], true)) {
                    $themeMode = (string) $manifest['theme'];
                }
            }

            // 1. Prefer an explicit public pre-rendered HTML snapshot shipped inside the bundle.
            $bundledSnap = self::extractBundledSnapshot($zip, $manifest, $prefix);
            if ($bundledSnap !== null) {
                return [
                    'themeMode' => $themeMode,
                    'previewHtml' => $bundledSnap['html'],
                    'sourceType' => 'snapshot',
                    'entryFile' => $bundledSnap['file'],
                ];
            }

            $entryName = self::resolvePublicUiEntry($zip, $manifest, $prefix);
            if ($entryName === null) {
                return ['themeMode' => $themeMode, 'previewHtml' => '', 'sourceType' => 'none', 'entryFile' => null];
            }

            $stat = $zip->statName($entryName);
            if ($stat === false || (int) $stat['size'] === 0 || (int) $stat['size'] > self::MAX_ENTRY_BYTES) {
                return ['themeMode' => $themeMode, 'previewHtml' => '', 'sourceType' => 'none', 'entryFile' => $entryName];
            }

            $content = $zip->getFromName($entryName, self::MAX_ENTRY_BYTES);
            if (!is_string($content) || trim($content) === '') {
                return ['themeMode' => $themeMode, 'previewHtml' => '', 'sourceType' => 'none', 'entryFile' => $entryName];
            }

            $ext = strtolower((string) pathinfo($entryName, PATHINFO_EXTENSION));
            if ($ext === 'ui') {
                $expanded = self::inlineUiImports($zip, $entryName, $content, $prefix);
                return [
                    'themeMode' => $themeMode,
                    'previewHtml' => self::renderUi($expanded),
                    'sourceType' => 'ui',
                    'entryFile' => $prefix !== '' && str_starts_with($entryName, $prefix) ? substr($entryName, strlen($prefix)) : $entryName,
                ];
            }
            if ($ext === 'html' || $ext === 'htm') {
                $sanitized = self::sanitizeHtml($content);
                $plainLen = strlen(trim(strip_tags($sanitized)));
                // When index.html is an empty JS SPA shell (`<div id="app"></div>`), safely
                // extract static HTML templates from public frontend JS/JSX/Vue modules.
                if ($plainLen < 40) {
                    $jsHtml = self::extractHtmlFromFrontendJs($zip, $manifest, $prefix);
                    if ($jsHtml !== '') {
                        $sanitized = $sanitized !== '' ? ($sanitized . "\n" . $jsHtml) : $jsHtml;
                    }
                }
                return [
                    'themeMode' => $themeMode,
                    'previewHtml' => $sanitized,
                    'sourceType' => 'html',
                    'entryFile' => $prefix !== '' && str_starts_with($entryName, $prefix) ? substr($entryName, strlen($prefix)) : $entryName,
                ];
            }

            return ['themeMode' => $themeMode, 'previewHtml' => '', 'sourceType' => 'none', 'entryFile' => null];
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
     * @return array{html: string, file: string}|null
     */
    private static function extractBundledSnapshot(ZipArchive $zip, ?array $manifest, string $prefix): ?array
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
            $sanitized = self::sanitizeHtml($raw, self::MAX_SNAPSHOT_BYTES);
            if ($sanitized !== '') {
                return ['html' => $sanitized, 'file' => $rel];
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
    private static function extractHtmlFromFrontendJs(ZipArchive $zip, ?array $manifest, string $prefix): string
    {
        $feRoot = is_array($manifest) && is_string($manifest['frontendRoot'] ?? null)
            ? trim(str_replace('\\', '/', $manifest['frontendRoot']), '/')
            : '';
        $backendRoot = '';
        if (is_array($manifest) && is_array($manifest['backend'] ?? null)) {
            if (is_string($manifest['backend']['root'] ?? null)) {
                $backendRoot = strtolower(trim(str_replace('\\', '/', $manifest['backend']['root']), '/'));
            } elseif (is_string($manifest['backend']['entry'] ?? null) && str_contains($manifest['backend']['entry'], '/')) {
                $firstDir = strtolower(explode('/', trim(str_replace('\\', '/', $manifest['backend']['entry']), '/'))[0]);
                if (!in_array($firstDir, ['assets', 'css', 'js', 'public', 'static', 'dist', 'frontend', 'src'], true)) {
                    $backendRoot = $firstDir;
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
        return self::sanitizeHtml(implode("\n", $chunks));
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
     * Sanitize static HTML (from a Container v2 entry) into safe, balanced,
     * nicely formatted semantic HTML5 suitable for search engines and View Source.
     */
    public static function sanitizeHtml(string $raw, int $maxBytes = self::MAX_ENTRY_BYTES): string
    {
        if (strlen($raw) > $maxBytes) {
            $raw = substr($raw, 0, $maxBytes);
        }
        // Strip comments, doctype, and non-content / active / embedded subtrees BEFORE
        // locating <body> so a literal `<body>...</body>` inside a <script> or comment cannot
        // hijack extraction.
        $raw = preg_replace('/<!--[\s\S]*?-->/', '', $raw) ?? $raw;
        $raw = preg_replace('/<!DOCTYPE[^>]*>/i', '', $raw) ?? $raw;
        $raw = preg_replace('/<(script|style|noscript|template|iframe|object|embed|svg|math|form|textarea|select|canvas|audio|video)\b[^>]*>[\s\S]*?<\/\1\s*>/i', '', $raw) ?? $raw;
        $raw = preg_replace('/<(script|style|noscript|template|iframe|object|embed|svg|math|form|textarea|select|input|meta|link|base|canvas|audio|video)\b[^>]*\/?>/i', '', $raw) ?? $raw;
        // Extract body contents when a full document is supplied.
        if (preg_match('/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i', $raw, $m) === 1) {
            $raw = $m[1];
        } else {
            $raw = preg_replace('/<head\b[^>]*>[\s\S]*?<\/head\s*>/i', '', $raw) ?? $raw;
        }

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
                    // Pop up to matching tag (by original source tag name, so downgraded h1->h2, main->section or a->span closes cleanly).
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
                    $selfClosing = ($om[3] ?? '') === '/' || isset(self::VOID_TAGS[$tag]);
                    if (!isset(self::ALLOWED_HTML_TAGS[$tag])) continue;
                    if (count($stack) - 1 >= self::MAX_DEPTH) continue;

                    // Downgrade h1 inside app preview to h2 so the page retains a single h1,
                    // and map <main> to <section> so the outer page never has nested <main> landmarks.
                    if ($tag === 'h1') $tag = 'h2';
                    elseif ($tag === 'main') $tag = 'section';

                    $attrs = '';
                    if ($tag === 'a') {
                        $href = self::extractSafeHref($rawAttrs);
                        if ($href !== null) {
                            $attrs = ' href="' . self::esc($href) . '" rel="nofollow ugc noopener noreferrer"';
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
    public static function renderUi(string $raw): string
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
                    $href = self::extractSafeHref($rawAttrs);
                    if ($href !== null) {
                        $attrs = ' href="' . self::esc($href) . '" rel="nofollow ugc noopener noreferrer"';
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

    private static function extractSafeHref(string $rawAttrs): ?string
    {
        if (preg_match('/\bhref\s*=\s*(?:"([^"]*)"|\'([^\']*)\')/i', $rawAttrs, $m) !== 1) return null;
        $raw = $m[1] !== '' ? $m[1] : ($m[2] ?? '');
        $decoded = trim(html_entity_decode($raw, ENT_QUOTES | ENT_HTML5, 'UTF-8'));
        if ($decoded === '' || strlen($decoded) > 512) return null;
        if (preg_match('/[\x00-\x20\x7F"\'<>]/', $decoded) === 1) return null;
        if (preg_match('#^https?://[A-Za-z0-9.\-\[\]:]+(?:/.*)?$#i', $decoded) !== 1) return null;
        return $decoded;
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
