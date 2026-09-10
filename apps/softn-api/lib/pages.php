<?php
/**
 * The HTML pages the API renders: an app's share page and its play page.
 *
 * The site is a single-page app and /app/<slug> is one of its routes, so a
 * browser gets the site's index.html and the page draws itself. A link
 * pasted into a chat or a social network is fetched by a scraper that runs no
 * JavaScript and reads the <meta> tags; for it, the same index.html is served
 * with the app's own title, description and thumbnail in those tags — so a
 * shared app unfurls as itself rather than as the site.
 *
 * /play/<slug> is where the app runs. It is the single-app shell — the small
 * runtime under /play/ that carries no launcher, catalogue or cache — with
 * the app's configuration written into the document: the bundle's
 * version-addressed URL and digest, the endpoints it reports to, and whether
 * the operator has marked it trusted. The shell then fetches the bundle and
 * nothing else before the app is on screen.
 */
declare(strict_types=1);

final class Pages
{
    public static function app(string $slugGiven): Response
    {
        $index = dirname(__DIR__, 2) . '/index.html';
        if (!is_file($index)) return Response::html('<!doctype html><title>SoftN</title><p>The site is not built.</p>', 500);
        $html = (string) file_get_contents($index);
        try {
            $slug = Apps::resolveSlug($slugGiven);
            $row = Apps::row($slug);
        } catch (ApiError) {
            return Response::html($html, 200, ['Cache-Control' => 'no-cache']);
        }
        $origin = self::origin();
        $name = (string) $row['name'];
        $title = "$name — SoftN";
        $desc = (string) $row['description'];
        $playUrl = Apps::playUrl($row);
        if ($desc === '') $desc = $playUrl === null ? "$name, a SoftN app. Run it in the browser, read its source, remix it." : "$name, a SoftN app. Play it at " . (parse_url($playUrl, PHP_URL_HOST) ?: 'its own site') . '.';
        $image = "$origin/api/apps/$slug/thumbnail?v=" . (int) ($row['updated_at'] ?? 0);
        $url = "$origin/app/$slug";
        $e = fn(string $s): string => htmlspecialchars($s, ENT_QUOTES | ENT_HTML5, 'UTF-8');
        $html = preg_replace('#<title>.*?</title>#s', '<title>' . $e($title) . '</title>', $html, 1) ?? $html;
        $replace = [
            'name="description"' => $desc,
            'property="og:title"' => $title,
            'property="og:description"' => $desc,
            'property="og:url"' => $url,
            'property="og:image"' => $image,
            'property="og:image:alt"' => "$name on SoftN",
        ];
        foreach ($replace as $attr => $value) {
            $html = preg_replace('#(<meta\s+[^>]*' . preg_quote($attr, '#') . '[^>]*content=")[^"]*(")#s', '${1}' . $e($value) . '${2}', $html, 1) ?? $html;
        }
        $html = preg_replace('#<meta\s+property="og:image:width"[^>]*>\s*#', '', $html) ?? $html;
        $html = preg_replace('#<meta\s+property="og:image:height"[^>]*>\s*#', '', $html) ?? $html;
        $html = preg_replace('#<meta\s+property="og:type"\s+content="[^"]*"#', '<meta property="og:type" content="article"', $html, 1) ?? $html;
        $html = preg_replace('#<link\s+rel="canonical"\s+href="[^"]*"#', '<link rel="canonical" href="' . $e($url) . '"', $html, 1) ?? $html;
        $html = str_replace('</head>', '<meta name="softn:app" content="' . $e($slug) . '" />' . "\n  </head>", $html);
        return Response::html($html, 200, ['Cache-Control' => 'no-cache']);
    }

    /**
     * The configuration the play page writes into the shell: the same shape
     * as a standalone deployment's runtime.config.json, which is what the
     * shell validates it against, plus the two directory endpoints. Every
     * location is a path on this origin — the shell refuses anything else.
     *
     * @param array<string, mixed> $row @param array<string, mixed> $ver
     * @return array<string, mixed>
     */
    public static function playConfig(array $row, array $ver): array
    {
        $slug = (string) $row['slug'];
        $name = (string) $row['name'];
        $caps = json_decode((string) $row['capabilities'], true) ?: [];
        // The shell holds a title to 120 characters and a loading line to 160;
        // the catalogue holds a name to 80, so neither can run over, but the
        // cut is here so that a longer limit there never breaks the page.
        $title = mb_substr($name, 0, 120);
        $directory = ['runs' => "/api/apps/$slug/runs"];
        // Only an app that declared storage has a database to reach; the
        // route refuses the rest, and the shell need not learn that by asking.
        if (in_array('storage', $caps, true)) $directory['storage'] = "/api/apps/$slug/storage";
        return [
            'version' => 1,
            'id' => $slug,
            'title' => $title,
            // Version-addressed and digest-pinned, so the shell may let the
            // browser cache answer for it: the bytes behind ?v=N never change,
            // and a new version is a new URL.
            'bundle' => "/api/apps/$slug/bundle.softn?v=" . (int) $ver['version'],
            'sha256' => (string) $ver['sha256'],
            'loadingText' => mb_substr('Loading ' . $name . '…', 0, 160),
            'theme' => 'dark',
            // The shell's own setting for a trusted app, which requires the
            // digest pin above: granted from the start, no bar.
            'permissionMode' => Apps::isTrusted($row) ? 'preapproved' : 'prompt',
            'directory' => $directory,
        ];
    }

    public static function play(string $slugGiven): Response
    {
        $shell = dirname(__DIR__, 2) . '/play/index.html';
        if (!is_file($shell)) {
            return Response::html('<!doctype html><title>SoftN</title><p>The play shell is not built: this site has no play/ directory.</p>', 500);
        }
        $e = fn(string $s): string => htmlspecialchars($s, ENT_QUOTES | ENT_HTML5, 'UTF-8');
        try {
            $slug = Apps::resolveSlug($slugGiven);
            $row = Apps::row($slug);
            // A linked app plays on its own site: a shared play link goes there.
            $playUrl = Apps::playUrl($row);
            if ($playUrl !== null) return Response::html('', 302, ['Location' => $playUrl, 'Cache-Control' => 'no-cache']);
            $ver = Apps::version($slug);
        } catch (ApiError $err) {
            // A real 404 with a way back, not the shell failing to load
            // something: a shared link to an app since unpublished should say so.
            return Response::html(
                '<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />'
                . '<title>Not here — SoftN</title><style>html,body{margin:0;background:#171821;color:#f5f5f8;font-family:system-ui}'
                . 'main{min-height:100dvh;display:grid;place-content:center;text-align:center;gap:12px;padding:24px}a{color:#acb8ff}</style></head>'
                . '<body><main><h1>' . $e($err->getMessage()) . '</h1><p><a href="/apps">Browse the directory</a></p></main></body></html>',
                $err->status === 404 ? 404 : $err->status,
                ['Cache-Control' => 'no-cache']
            );
        }
        $html = (string) file_get_contents($shell);
        $config = json_encode(self::playConfig($row, $ver), JSON_HEX_TAG | JSON_HEX_AMP | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        if ($config === false) return Response::html('<!doctype html><title>SoftN</title><p>The app could not be described.</p>', 500);
        $name = (string) $row['name'];
        $html = preg_replace('#<title>.*?</title>#s', '<title>' . $e($name) . '</title>', $html, 1) ?? $html;
        // JSON_HEX_TAG has turned every < and > into \u003C and \u003E, so
        // nothing in a name or a description can close this element early.
        $inject = '<meta name="softn:app" content="' . $e($slug) . '" />' . "\n"
            . '    <link rel="canonical" href="' . $e(self::origin() . "/app/$slug") . '" />' . "\n"
            . '    <script type="application/json" id="softn-runtime-config">' . $config . '</script>' . "\n  </head>";
        $html = str_replace('</head>', $inject, $html);
        // The page names the latest version, which the next publish moves.
        return Response::html($html, 200, ['Cache-Control' => 'no-cache']);
    }

    private static function origin(): string
    {
        $configured = Config::get('siteOrigin');
        if (is_string($configured) && $configured !== '') return rtrim($configured, '/');
        $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
        $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https';
        return ($https ? 'https' : 'http') . '://' . (is_string($host) ? $host : 'localhost');
    }
}
