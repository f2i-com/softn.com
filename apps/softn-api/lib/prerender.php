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
    public const VERSION = 1;
    private const MAX_ENTRY_BYTES = 262144;
    private const MAX_OUTPUT_BYTES = 12288;
    private const MAX_NODES = 200;
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
     *
     * @return array{themeMode: ?string, previewHtml: string, sourceType: string, entryFile: ?string}
     */
    public static function forBundle(string $bundlePath, string $bundleSha, ?string $cacheDir, bool $withholdBackend): array
    {
        $empty = ['themeMode' => null, 'previewHtml' => '', 'sourceType' => 'none', 'entryFile' => null];
        if (!is_file($bundlePath)) return $empty;

        $cacheFile = null;
        if ($cacheDir !== null && $bundleSha !== '') {
            $suffix = $withholdBackend ? '-client' : '';
            $cacheFile = rtrim($cacheDir, '/\\') . '/page-meta-v' . self::VERSION . '-' . substr($bundleSha, 0, 16) . $suffix . '.json';
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
                return [
                    'themeMode' => $themeMode,
                    'previewHtml' => self::renderUi($content),
                    'sourceType' => 'ui',
                    'entryFile' => $prefix !== '' && str_starts_with($entryName, $prefix) ? substr($entryName, strlen($prefix)) : $entryName,
                ];
            }
            if ($ext === 'html' || $ext === 'htm') {
                return [
                    'themeMode' => $themeMode,
                    'previewHtml' => self::sanitizeHtml($content),
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
     * Sanitize static HTML (from a Container v2 entry) into safe, balanced,
     * nicely formatted semantic HTML5 suitable for search engines and View Source.
     */
    public static function sanitizeHtml(string $raw): string
    {
        if (strlen($raw) > self::MAX_ENTRY_BYTES) {
            $raw = substr($raw, 0, self::MAX_ENTRY_BYTES);
        }
        // Extract body contents when a full document is supplied.
        if (preg_match('/<body\b[^>]*>([\s\S]*?)<\/body>/i', $raw, $m) === 1) {
            $raw = $m[1];
        } else {
            $raw = preg_replace('/<head\b[^>]*>[\s\S]*?<\/head>/i', '', $raw) ?? $raw;
        }
        // Strip non-content / active / embedded subtrees completely.
        $raw = preg_replace('/<!--[\s\S]*?-->/', '', $raw) ?? $raw;
        $raw = preg_replace('/<!DOCTYPE[^>]*>/i', '', $raw) ?? $raw;
        $raw = preg_replace('/<(script|style|noscript|template|iframe|object|embed|svg|math|form|textarea|select|canvas|audio|video)\b[^>]*>[\s\S]*?<\/\1>/i', '', $raw) ?? $raw;
        $raw = preg_replace('/<(script|style|noscript|template|iframe|object|embed|svg|math|form|textarea|select|input|meta|link|base|canvas|audio|video)\b[^>]*\/?>/i', '', $raw) ?? $raw;

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
                    // Pop up to matching tag (by original source tag name, so downgraded h1->h2 or a->span closes cleanly).
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

                    // Downgrade h1 inside app preview to h2 so the page retains a single h1.
                    if ($tag === 'h1') $tag = 'h2';

                    $attrs = '';
                    if ($tag === 'a') {
                        $href = self::extractSafeHref($rawAttrs);
                        if ($href !== null) {
                            $attrs = ' href="' . self::esc($href) . '" rel="noopener noreferrer"';
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
        $raw = preg_replace('/<(logic|script|style|data|import)\b[^>]*>[\s\S]*?<\/\1>/i', '', $raw) ?? $raw;
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
                        $attrs = ' href="' . self::esc($href) . '" rel="noopener noreferrer"';
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
        return self::cleanTextNode($out);
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
        // Collapse redundant nested <div> wrappers that hold only a single element child.
        if ($tag === 'div' && $attrs === '' && count($rawChildren) === 1 && is_array($rawChildren[0])) {
            return self::serializeNode($rawChildren[0], $indent, $bytes);
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
