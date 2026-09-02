<?php
/**
 * The one HTML page the API renders: an app's share page.
 *
 * The site is a single-page app and /app/<slug> is one of its routes, so a
 * browser gets the site's index.html and the page draws itself. A link
 * pasted into a chat or a social network is fetched by a scraper that runs no
 * JavaScript and reads the <meta> tags; for it, the same index.html is served
 * with the app's own title, description and thumbnail in those tags — so a
 * shared app unfurls as itself rather than as the site.
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
        if ($desc === '') $desc = "$name, a SoftN app. Run it in the browser, read its source, remix it.";
        $image = "$origin/api/apps/$slug/thumbnail";
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

    private static function origin(): string
    {
        $configured = Config::get('siteOrigin');
        if (is_string($configured) && $configured !== '') return rtrim($configured, '/');
        $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
        $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https';
        return ($https ? 'https' : 'http') . '://' . (is_string($host) ? $host : 'localhost');
    }
}
