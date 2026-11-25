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
        } catch (ApiError $err) {
            // The site says it has no such app; mark unknown share pages noindex
            // so crawlers do not index soft-404 URLs while keeping the SPA shell.
            if ($err->status === 404) {
                $notFoundHtml = self::stripStaticHomeHead($html);
                $notFoundHtml = self::injectRootSsr($notFoundHtml, '');
                $notFoundHtml = str_replace('</head>', '<meta name="robots" content="noindex" />' . "\n  </head>", $notFoundHtml);
                return Response::html($notFoundHtml, 200, ['Cache-Control' => 'no-cache']);
            }
            return self::problem($err->getMessage(), $err->status);
        }
        $origin = self::origin();
        $name = (string) $row['name'];
        $title = "$name — SoftN";
        $desc = (string) $row['description'];
        $playUrl = Apps::playUrl($row);
        if ($desc === '') $desc = $playUrl === null ? "$name, a SoftN app. Run it in the browser, read its source, remix it." : "$name, a SoftN app. Play it at " . (parse_url($playUrl, PHP_URL_HOST) ?: 'its own site') . '.';
        // With no configured origin the picture is named by its path, which
        // a browser resolves and a scraper that cannot will ignore; the
        // canonical address and og:url are left out rather than guessed
        // from a Host header a request may carry anything in.
        $image = ($origin ?? '') . "/api/apps/$slug/thumbnail?v=" . (int) ($row['updated_at'] ?? 0);
        $url = $origin === null ? null : "$origin/app/$slug";
        $e = fn(string $s): string => htmlspecialchars($s, ENT_QUOTES | ENT_HTML5, 'UTF-8');

        $ver = null;
        if ($playUrl === null) {
            try {
                $ver = Apps::version($slug);
            } catch (ApiError) {
                $ver = null;
            }
        }
        $prerender = $ver !== null
            ? self::prerenderFor($slug, $row, $ver)
            : ['themeMode' => null, 'previewHtml' => '', 'sourceType' => 'none', 'entryFile' => null];

        $html = self::stripStaticHomeHead($html);
        $html = self::replaceOnce('#<title>.*?</title>#s', fn() => '<title>' . $e($title) . '</title>', $html);
        $replace = [
            'name="description"' => $desc,
            'property="og:title"' => $title,
            'property="og:description"' => $desc,
            'property="og:url"' => $url,
            'property="og:image"' => $image,
            'property="og:image:alt"' => "$name on SoftN",
        ];
        foreach ($replace as $attr => $value) {
            if ($value === null) {
                $html = preg_replace('#<meta\s+[^>]*' . preg_quote($attr, '#') . '[^>]*>\s*#s', '', $html, 1) ?? $html;
                continue;
            }
            $html = self::replaceOnce('#(<meta\s+[^>]*' . preg_quote($attr, '#') . '[^>]*content=")[^"]*(")#s', fn(array $m) => $m[1] . $e($value) . $m[2], $html);
        }
        $html = preg_replace('#<meta\s+property="og:image:width"[^>]*>\s*#', '', $html) ?? $html;
        $html = preg_replace('#<meta\s+property="og:image:height"[^>]*>\s*#', '', $html) ?? $html;
        $html = preg_replace('#<meta\s+property="og:type"\s+content="[^"]*"#', '<meta property="og:type" content="article"', $html, 1) ?? $html;
        $html = $url === null
            ? (preg_replace('#<link\s+rel="canonical"[^>]*>\s*#s', '', $html, 1) ?? $html)
            : self::replaceOnce('#<link\s+rel="canonical"\s+href="[^"]*"#', fn() => '<link rel="canonical" href="' . $e($url) . '"', $html);

        $playAbs = $origin === null ? null : ($playUrl ?? "$origin/play/$slug");
        $jsonLd = self::webAppJsonLd($row, $ver, $desc, $url, $origin !== null ? $image : null, $playAbs);
        $crumbsLd = self::breadcrumbJsonLd($origin, $row, $slug);
        $extraHead = '<meta name="softn:app" content="' . $e($slug) . '" />' . "\n"
            . '    <meta name="robots" content="index,follow,max-image-preview:large" />' . "\n"
            . '    <meta name="twitter:title" content="' . $e($title) . '" />' . "\n"
            . '    <meta name="twitter:description" content="' . $e($desc) . '" />' . "\n"
            . '    <meta name="twitter:image" content="' . $e($image) . '" />' . "\n"
            . '    <meta name="twitter:image:alt" content="' . $e("$name on SoftN") . '" />' . "\n"
            . ($jsonLd !== '' ? '    <script type="application/ld+json">' . $jsonLd . '</script>' . "\n" : '')
            . ($crumbsLd !== '' ? '    <script type="application/ld+json">' . $crumbsLd . '</script>' . "\n" : '')
            . '  </head>';
        $html = str_replace('</head>', $extraHead, $html);

        $ssrMain = self::renderAppBody($slug, $row, $ver, $desc, $playUrl, $prerender['previewHtml']);
        $html = self::injectRootSsr($html, $ssrMain);
        return self::conditionalResponse($html, 'text/html; charset=utf-8', 'no-cache');
    }

    /**
     * Server-rendered directory page (`/apps`) with full crawlable app links,
     * category links, and `CollectionPage` + `ItemList` + `BreadcrumbList` JSON-LD.
     */
    public static function directory(): Response
    {
        $index = dirname(__DIR__, 2) . '/index.html';
        if (!is_file($index)) return Response::html('<!doctype html><title>SoftN</title><p>The site is not built.</p>', 500);
        $html = self::stripStaticHomeHead((string) file_get_contents($index));
        $e = fn(string $s): string => htmlspecialchars($s, ENT_QUOTES | ENT_HTML5, 'UTF-8');
        $origin = self::origin();

        $category = is_string($_GET['category'] ?? null) ? trim((string) $_GET['category']) : '';
        $query = is_string($_GET['q'] ?? null) ? trim((string) $_GET['q']) : '';
        $rows = array_values(array_filter(Catalog::all(), static fn(array $r): bool => empty($r['hidden'])));
        usort($rows, static fn(array $a, array $b): int => ((int) ($b['runs'] ?? 0)) <=> ((int) ($a['runs'] ?? 0)) ?: ((int) ($b['updated_at'] ?? 0)) <=> ((int) ($a['updated_at'] ?? 0)));

        $catCounts = [];
        foreach ($rows as $r) {
            $c = trim((string) ($r['category'] ?? ''));
            if ($c !== '') $catCounts[$c] = ($catCounts[$c] ?? 0) + 1;
        }
        arsort($catCounts);

        $filtered = $rows;
        if ($category !== '') {
            $catLower = strtolower($category);
            $filtered = array_values(array_filter($filtered, static fn(array $r): bool => strtolower((string) ($r['category'] ?? '')) === $catLower));
        }
        if ($query !== '') {
            $qLower = strtolower($query);
            $filtered = array_values(array_filter($filtered, static fn(array $r): bool =>
                str_contains(strtolower((string) ($r['name'] ?? '')), $qLower)
                || str_contains(strtolower((string) ($r['description'] ?? '')), $qLower)
            ));
        }

        $total = count($filtered);
        $title = $category !== '' ? ucfirst($category) . ' Apps — SoftN' : 'Apps Directory — SoftN';
        $desc = $category !== ''
            ? "Browse $total $category apps on SoftN. Run them directly in your browser sandbox, view their source, or remix them."
            : "Browse $total apps built with SoftN: business tools, games, simulations, and interactive web apps that run safely in one .softn file.";
        $canonicalPath = $category !== '' ? '/apps?category=' . rawurlencode($category) : '/apps';
        $url = $origin === null ? null : $origin . $canonicalPath;
        $robots = ($query !== '' || ($category !== '' && $total === 0)) ? 'noindex,follow' : 'index,follow,max-image-preview:large';

        $html = self::replaceOnce('#<title>.*?</title>#s', fn() => '<title>' . $e($title) . '</title>', $html);
        foreach ([
            'name="description"' => $desc,
            'property="og:title"' => $title,
            'property="og:description"' => $desc,
            'property="og:url"' => $url,
        ] as $attr => $value) {
            if ($value === null) {
                $html = preg_replace('#<meta\s+[^>]*' . preg_quote($attr, '#') . '[^>]*>\s*#s', '', $html, 1) ?? $html;
            } else {
                $html = self::replaceOnce('#(<meta\s+[^>]*' . preg_quote($attr, '#') . '[^>]*content=")[^"]*(")#s', fn(array $m) => $m[1] . $e($value) . $m[2], $html);
            }
        }
        $html = $url === null
            ? (preg_replace('#<link\s+rel="canonical"[^>]*>\s*#s', '', $html, 1) ?? $html)
            : self::replaceOnce('#<link\s+rel="canonical"\s+href="[^"]*"#', fn() => '<link rel="canonical" href="' . $e($url) . '"', $html);

        $itemElements = [];
        $pos = 1;
        foreach (array_slice($filtered, 0, 48) as $r) {
            $slug = (string) ($r['slug'] ?? '');
            if ($slug === '' || !Catalog::validSlug($slug)) continue;
            $item = [
                '@type' => 'ListItem',
                'position' => $pos++,
                'name' => (string) ($r['name'] ?? $slug),
            ];
            if ($origin !== null) $item['url'] = "$origin/app/$slug";
            $itemElements[] = $item;
        }
        $collectionLd = [
            '@context' => 'https://schema.org',
            '@type' => 'CollectionPage',
            'name' => $title,
            'description' => $desc,
            'mainEntity' => [
                '@type' => 'ItemList',
                'numberOfItems' => count($itemElements),
                'itemListElement' => $itemElements,
            ],
        ];
        if ($url !== null) $collectionLd['url'] = $url;
        $ldJson = json_encode($collectionLd, JSON_HEX_TAG | JSON_HEX_AMP | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);

        $extraHead = '<meta name="robots" content="' . $e($robots) . '" />' . "\n"
            . '    <meta name="twitter:title" content="' . $e($title) . '" />' . "\n"
            . '    <meta name="twitter:description" content="' . $e($desc) . '" />' . "\n"
            . (is_string($ldJson) ? '    <script type="application/ld+json">' . $ldJson . '</script>' . "\n" : '')
            . '  </head>';
        $html = str_replace('</head>', $extraHead, $html);

        $lines = [
            '      <main id="boot" data-softn-ssr="directory">',
            '        <header>',
            '          <h1>' . $e($category !== '' ? ucfirst($category) . ' Apps' : 'SoftN Apps Directory') . '</h1>',
            '          <p>' . $e($desc) . '</p>',
        ];
        if ($catCounts !== []) {
            $catLinks = ['<a href="/apps">All (' . count($rows) . ')</a>'];
            foreach (array_slice($catCounts, 0, 16, true) as $catId => $cnt) {
                $catLinks[] = '<a href="/apps?category=' . $e(rawurlencode($catId)) . '">' . $e($catId) . ' (' . $cnt . ')</a>';
            }
            $lines[] = '          <nav aria-label="Categories">' . implode(' · ', $catLinks) . '</nav>';
        }
        $lines[] = '        </header>';
        $lines[] = '        <section aria-label="Published applications">';
        foreach (array_slice($filtered, 0, 48) as $r) {
            $slug = (string) ($r['slug'] ?? '');
            if ($slug === '' || !Catalog::validSlug($slug)) continue;
            $rName = (string) ($r['name'] ?? $slug);
            $rDesc = (string) ($r['description'] ?? '');
            $rCat = trim((string) ($r['category'] ?? ''));
            $lines[] = '          <article>';
            $lines[] = '            <h2><a href="' . $e("/app/$slug") . '">' . $e($rName) . '</a></h2>';
            if ($rDesc !== '') $lines[] = '            <p>' . $e($rDesc) . '</p>';
            $meta = $rCat !== '' ? $e($rCat) . ' · ' : '';
            $lines[] = '            <p>' . $meta . '<a href="' . $e("/play/$slug") . '">Play ' . $e($rName) . '</a></p>';
            $lines[] = '          </article>';
        }
        $lines[] = '        </section>';
        $lines[] = '      </main>';

        $html = self::injectRootSsr($html, implode("\n", $lines));
        return self::conditionalResponse($html, 'text/html; charset=utf-8', 'no-cache');
    }

    /**
     * Server-rendered publish page (`/publish`) with SEO metadata and SSR HTML.
     */
    public static function publishPage(): Response
    {
        $index = dirname(__DIR__, 2) . '/index.html';
        if (!is_file($index)) return Response::html('<!doctype html><title>SoftN</title><p>The site is not built.</p>', 500);
        $html = self::stripStaticHomeHead((string) file_get_contents($index));
        $e = fn(string $s): string => htmlspecialchars($s, ENT_QUOTES | ENT_HTML5, 'UTF-8');
        $origin = self::origin();
        $title = 'Publish a SoftN App — SoftN';
        $desc = 'Publish a .softn app bundle to the SoftN directory. No account required: publishing returns an edit key for updates.';
        $url = $origin === null ? null : "$origin/publish";

        $html = self::replaceOnce('#<title>.*?</title>#s', fn() => '<title>' . $e($title) . '</title>', $html);
        foreach ([
            'name="description"' => $desc,
            'property="og:title"' => $title,
            'property="og:description"' => $desc,
            'property="og:url"' => $url,
        ] as $attr => $value) {
            if ($value === null) {
                $html = preg_replace('#<meta\s+[^>]*' . preg_quote($attr, '#') . '[^>]*>\s*#s', '', $html, 1) ?? $html;
            } else {
                $html = self::replaceOnce('#(<meta\s+[^>]*' . preg_quote($attr, '#') . '[^>]*content=")[^"]*(")#s', fn(array $m) => $m[1] . $e($value) . $m[2], $html);
            }
        }
        $html = $url === null
            ? (preg_replace('#<link\s+rel="canonical"[^>]*>\s*#s', '', $html, 1) ?? $html)
            : self::replaceOnce('#<link\s+rel="canonical"\s+href="[^"]*"#', fn() => '<link rel="canonical" href="' . $e($url) . '"', $html);

        $extraHead = '<meta name="robots" content="index,follow" />' . "\n"
            . '    <meta name="twitter:title" content="' . $e($title) . '" />' . "\n"
            . '    <meta name="twitter:description" content="' . $e($desc) . '" />' . "\n"
            . '  </head>';
        $html = str_replace('</head>', $extraHead, $html);

        $body = implode("\n", [
            '      <main id="boot" data-softn-ssr="publish">',
            '        <h1>Publish a SoftN App</h1>',
            '        <p>' . $e($desc) . '</p>',
            '        <nav><a href="/apps">Browse Apps Directory</a> · <a href="/docs/">Read Documentation</a></nav>',
            '      </main>',
        ]);
        $html = self::injectRootSsr($html, $body);
        return self::conditionalResponse($html, 'text/html; charset=utf-8', 'no-cache');
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
    public static function playConfig(array $row, array $ver, bool $forceLocal = false): array
    {
        $slug = (string) $row['slug'];
        $name = (string) $row['name'];
        $caps = json_decode((string) $row['capabilities'], true) ?: [];
        $hosting = Apps::hostingInfo($row);
        // The shell holds a title to 120 characters and a loading line to 160;
        // the catalogue holds a name to 80, so neither can run over, but the
        // cut is here so that a longer limit there never breaks the page.
        $title = mb_substr($name, 0, 120);
        $directory = ['runs' => "/api/apps/$slug/runs"];
        // Only an app that declared storage has a database to reach; the
        // route refuses the rest, and the shell need not learn that by asking.
        if (in_array('storage', $caps, true)) $directory['storage'] = "/api/apps/$slug/storage";
        $useLocal = $forceLocal && $hosting['browserSupported'];
        $useServerBackend = !$useLocal && $hosting['serverHosted'] && is_string($hosting['backendUrl']);
        $bundleUrl = "/api/apps/$slug/bundle.softn?v=" . (int) $ver['version'] . '&sha256=' . $ver['sha256'];
        $bundleSha = (string) $ver['sha256'];
        if ($hosting['withholdBackend']) {
            $appDir = Catalog::path($slug);
            $srcPath = $appDir . '/' . (string) $ver['file'];
            $cachePath = $appDir . '/backend-cache/client-v' . (int) $ver['version'] . '-' . substr($bundleSha, 0, 12) . '.softn';
            Bundle::clientBundlePath($srcPath, $cachePath);
            $clientSha = Bundle::clientBundleSha256($srcPath, $cachePath, $bundleSha);
            $bundleUrl = "/api/apps/$slug/bundle.softn?v=" . (int) $ver['version'] . '&client=1&sha256=' . $clientSha;
            $bundleSha = $clientSha;
        }
        $config = [
            'version' => 1,
            'id' => $slug,
            'title' => $title,
            // Addressed by version and digest, and the digest pinned below,
            // so the shell may let the browser cache answer for it: the API
            // answers this address with these bytes or a 404. The version
            // number alone was not enough, because the bytes behind it can
            // change (see the bundle route in index.php), and a cached old
            // copy failed the pin for as long as it was kept.
            'bundle' => $bundleUrl,
            'sha256' => $bundleSha,
            'loadingText' => mb_substr('Loading ' . $name . '…', 0, 160),
            'theme' => 'dark',
            // The shell's own setting for a trusted app, which requires the
            // digest pin above: granted from the start, no bar.
            'permissionMode' => Apps::isTrusted($row) ? 'preapproved' : 'prompt',
            'directory' => $directory,
        ];
        if ($useServerBackend) {
            $bUrl = (string) $hosting['backendUrl'];
            $siteOrigin = self::origin();
            $ownBackendPrefix = "/api/apps/$slug/backend";
            $isOwnHosted = $bUrl === $ownBackendPrefix;
            $isTrustedCustom = $hosting['customBackendUrl'] !== null && Apps::isTrusted($row);
            $sameOrigin = str_starts_with($bUrl, '/');
            if (!$sameOrigin && $siteOrigin !== null) {
                $pUrl = parse_url($bUrl);
                $pSite = parse_url($siteOrigin);
                if (is_array($pUrl) && is_array($pSite) && isset($pUrl['scheme'], $pUrl['host'], $pSite['scheme'], $pSite['host'])) {
                    $norm = static function (array $p): string {
                        $sc = strtolower((string) $p['scheme']);
                        $h = strtolower(rtrim((string) $p['host'], '.'));
                        $pt = isset($p['port']) ? (int) $p['port'] : ($sc === 'https' ? 443 : 80);
                        return "$sc://$h:$pt";
                    };
                    $sameOrigin = $norm($pUrl) === $norm($pSite);
                }
            }
            if ($isOwnHosted) {
                $config['backendUrl'] = $bUrl;
            } elseif ($sameOrigin && $isTrustedCustom) {
                // Canonicalize the URL path so non-canonical paths (`/api//admin`, `/./api/...`,
                // absolute `https://<site>/api/apps/<other>/backend`) are checked accurately.
                $rawPath = (string) (parse_url($bUrl, PHP_URL_PATH) ?? '/');
                $decodedPath = rawurldecode($rawPath);
                $segs = [];
                foreach (explode('/', str_replace('\\', '/', $decodedPath)) as $seg) {
                    if ($seg === '' || $seg === '.') continue;
                    if ($seg === '..') { array_pop($segs); continue; }
                    $segs[] = $seg;
                }
                $canonPath = '/' . implode('/', $segs);
                if (!preg_match('#^/api/(?:admin(?:/|$)|apps/(?!' . preg_quote($slug, '#') . '/backend(?:/|$)))#i', $canonPath)) {
                    $config['backendUrl'] = $bUrl;
                }
            }
        }
        return $config;
    }

    public static function play(string $slugGiven, bool $forceLocal = false): Response
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
            return self::problem($err->getMessage(), $err->status);
        }
        $html = (string) file_get_contents($shell);
        $config = json_encode(self::playConfig($row, $ver, $forceLocal), JSON_HEX_TAG | JSON_HEX_AMP | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        if ($config === false) return Response::html('<!doctype html><title>SoftN</title><p>The app could not be described.</p>', 500);
        $name = (string) $row['name'];
        $desc = (string) ($row['description'] ?? '');
        if ($desc === '') $desc = "$name — run this SoftN app directly in your browser.";
        $html = self::replaceOnce('#<title>.*?</title>#s', fn() => '<title>' . $e($name) . '</title>', $html);
        // JSON_HEX_TAG has turned every < and > into \u003C and \u003E, so
        // nothing in a name or a description can close this element early.
        $origin = self::origin();
        $prerender = self::prerenderFor($slug, $row, $ver);
        $image = ($origin ?? '') . "/api/apps/$slug/thumbnail?v=" . (int) ($row['updated_at'] ?? 0);
        $canonicalUrl = $origin === null ? null : "$origin/app/$slug";
        $playPageUrl = $origin === null ? null : "$origin/play/$slug";
        $jsonLd = self::webAppJsonLd($row, $ver, $desc, $canonicalUrl, $origin !== null ? $image : null, $playPageUrl);
        // The shell draws its boot screen dark, the `theme` above. An app
        // whose project declares light is drawn light whatever that theme
        // says, so its boot screen is too, rather than opening dark and
        // turning light; the wheel takes the text colour, as the privately
        // served page's does. Every other app gets no extra style tag.
        $boot = $prerender['themeMode'] === 'light'
            ? '    <style>html,body{background:#f5f5f8;color:#171821}.wheel{border-color:color-mix(in srgb,currentColor 20%,transparent);border-top-color:currentColor}</style>' . "\n"
            : '';
        $inject = '<meta name="softn:app" content="' . $e($slug) . '" />' . "\n"
            . '    <meta name="robots" content="index,follow,max-image-preview:large" />' . "\n"
            . '    <meta name="description" content="' . $e($desc) . '" />' . "\n"
            . '    <meta property="og:type" content="website" />' . "\n"
            . '    <meta property="og:site_name" content="SoftN" />' . "\n"
            . '    <meta property="og:title" content="' . $e($name) . '" />' . "\n"
            . '    <meta property="og:description" content="' . $e($desc) . '" />' . "\n"
            . '    <meta property="og:image" content="' . $e($image) . '" />' . "\n"
            . '    <meta property="og:image:alt" content="' . $e("$name on SoftN") . '" />' . "\n"
            . ($playPageUrl === null ? '' : '    <meta property="og:url" content="' . $e($playPageUrl) . '" />' . "\n")
            . '    <meta name="twitter:card" content="summary_large_image" />' . "\n"
            . '    <meta name="twitter:title" content="' . $e($name) . '" />' . "\n"
            . '    <meta name="twitter:description" content="' . $e($desc) . '" />' . "\n"
            . '    <meta name="twitter:image" content="' . $e($image) . '" />' . "\n"
            . '    <meta name="twitter:image:alt" content="' . $e("$name on SoftN") . '" />' . "\n"
            . ($canonicalUrl === null ? '' : '    <link rel="canonical" href="' . $e($canonicalUrl) . '" />' . "\n")
            . ($jsonLd !== '' ? '    <script type="application/ld+json">' . $jsonLd . '</script>' . "\n" : '')
            . $boot
            . '    <script type="application/json" id="softn-runtime-config">' . $config . '</script>' . "\n  </head>";
        $html = str_replace('</head>', $inject, $html);

        $ssrPlay = self::renderPlayBody($slug, $row, $desc, $prerender['previewHtml']);
        if (preg_match('#<div\s+id="boot"(?=\s|>)[^>]*>[\s\S]*?</div>#i', $html) === 1) {
            $html = self::replaceOnce(
                '#(<div\s+id="boot"(?=\s|>)[^>]*>[\s\S]*?)(</div>)#i',
                fn(array $m) => $m[1] . "\n" . $ssrPlay . "\n      " . $m[2],
                $html
            );
        } else {
            $html = self::replaceOnce(
                '#<div\s+id="root"\s*>\s*</div>#i',
                fn() => '<div id="root">' . "\n      <div id=\"boot\" role=\"status\">\n" . $ssrPlay . "\n      </div>\n    </div>",
                $html
            );
        }
        // The page names the latest version, which the next publish moves.
        return self::conditionalResponse($html, 'text/html; charset=utf-8', 'no-cache');
    }

    /**
     * Dynamic XML sitemap covering the site root, directory, publish page and
     * every public app's `/app/<slug>` share page.
     */
    public static function sitemap(): Response
    {
        $origin = self::origin();
        if ($origin === null) {
            return Response::raw(404, [
                ['Content-Type', 'text/plain; charset=utf-8'],
                ['Cache-Control', 'no-cache'],
            ], 'Site origin is not configured.');
        }
        $e = fn(string $s): string => htmlspecialchars($s, ENT_QUOTES | ENT_XML1, 'UTF-8');
        $rows = array_values(array_filter(Catalog::all(), static fn(array $r): bool => empty($r['hidden'])));
        usort($rows, static fn(array $a, array $b): int => ((int) ($b['updated_at'] ?? 0)) <=> ((int) ($a['updated_at'] ?? 0)));

        $urls = [
            ['loc' => "$origin/", 'lastmod' => null, 'image' => null, 'title' => null],
            ['loc' => "$origin/apps", 'lastmod' => null, 'image' => null, 'title' => null],
            ['loc' => "$origin/publish", 'lastmod' => null, 'image' => null, 'title' => null],
        ];
        $seenCats = [];
        foreach ($rows as $row) {
            $cat = trim((string) ($row['category'] ?? ''));
            if ($cat !== '' && !isset($seenCats[strtolower($cat)])) {
                $seenCats[strtolower($cat)] = true;
                $urls[] = [
                    'loc' => "$origin/apps?category=" . rawurlencode($cat),
                    'lastmod' => null,
                    'image' => null,
                    'title' => null,
                ];
            }
        }
        foreach (array_slice($rows, 0, 49900) as $row) {
            $slug = (string) ($row['slug'] ?? '');
            if ($slug === '' || !Catalog::validSlug($slug)) continue;
            $updated = (int) ($row['updated_at'] ?? 0);
            $urls[] = [
                'loc' => "$origin/app/$slug",
                'lastmod' => $updated > 0 ? gmdate('Y-m-d', $updated) : null,
                'image' => "$origin/api/apps/$slug/thumbnail?v=$updated",
                'title' => (string) ($row['name'] ?? $slug),
            ];
        }

        $lines = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
        ];
        foreach ($urls as $u) {
            $entry = '  <url><loc>' . $e($u['loc']) . '</loc>';
            if ($u['lastmod'] !== null) $entry .= '<lastmod>' . $u['lastmod'] . '</lastmod>';
            if ($u['image'] !== null) {
                $entry .= '<image:image><image:loc>' . $e($u['image']) . '</image:loc>';
                if ($u['title'] !== null && $u['title'] !== '') {
                    $entry .= '<image:title>' . $e($u['title']) . '</image:title>';
                }
                $entry .= '</image:image>';
            }
            $entry .= '</url>';
            $lines[] = $entry;
        }
        $lines[] = '</urlset>';
        $xml = implode("\n", $lines) . "\n";
        return self::conditionalResponse($xml, 'application/xml; charset=utf-8', 'public, max-age=300');
    }

    /**
     * What a person who followed a link to an app's page or its play page is
     * told when it cannot be shown: a page, as the status the API would have
     * answered, with a way back. The API's JSON is for a script, and this
     * address is in someone's chat.
     */
    public static function problem(string $message, int $status): Response
    {
        $e = fn(string $s): string => htmlspecialchars($s, ENT_QUOTES | ENT_HTML5, 'UTF-8');
        // Worded for an operator, whose site it is; a visitor is told what it means for them first.
        $say = $status === 404 ? '<h1>' . $e($message) . '</h1>' : '<h1>This page can’t be shown right now.</h1><p>' . $e($message) . '</p>';
        return Response::html(
            '<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />'
            . '<title>' . ($status === 404 ? 'Not here' : 'Unavailable') . ' — SoftN</title><style>html,body{margin:0;background:#171821;color:#f5f5f8;font-family:system-ui}'
            . 'main{min-height:100dvh;display:grid;place-content:center;text-align:center;gap:12px;padding:24px}a{color:#acb8ff}</style></head>'
            . '<body><main>' . $say . '<p><a href="/apps">Browse the directory</a></p></main></body></html>',
            $status,
            ['Cache-Control' => 'no-cache']
        );
    }

    /**
     * The side a version's project declares: `config.theme.mode` in its
     * manifest when that is "light" or "dark", null for "system", for
     * nothing and for anything else, which is what the rule in
     * packages/@softn/components/src/theme/app-theme.ts reads. Null too when
     * the bundle cannot be read: the page is then drawn as it always was.
     *
     * @param array<string, mixed> $ver
     */
    public static function declaredSide(string $slug, array $ver): ?string
    {
        $appDir = Catalog::path($slug);
        $srcPath = $appDir . '/' . (string) ($ver['file'] ?? '');
        $sha = (string) ($ver['sha256'] ?? '');
        return Prerender::forBundle($srcPath, $sha, Config::dataDir() . '/page-cache', false)['themeMode'];
    }

    /**
     * Load cached pre-render data for a published app version, strictly reading
     * the backend-stripped client bundle whenever `withholdBackend` is active.
     *
     * @param array<string, mixed> $row
     * @param array<string, mixed> $ver
     * @return array{themeMode: ?string, previewHtml: string, sourceType: string, entryFile: ?string}
     */
    private static function prerenderFor(string $slug, array $row, array $ver): array
    {
        $hosting = Apps::hostingInfo($row);
        $appDir = Catalog::path($slug);
        $srcPath = $appDir . '/' . (string) ($ver['file'] ?? '');
        $bundleSha = (string) ($ver['sha256'] ?? '');
        $withhold = (bool) $hosting['withholdBackend'];
        $pageCache = Config::dataDir() . '/page-cache';
        $snapshotPath = $appDir . '/ssr.html';
        if ($withhold) {
            $cachePath = $appDir . '/backend-cache/client-v' . (int) ($ver['version'] ?? 0) . '-' . substr($bundleSha, 0, 12) . '.softn';
            try {
                $bundlePath = Bundle::clientBundlePath($srcPath, $cachePath);
                $sha = Bundle::clientBundleSha256($srcPath, $cachePath, $bundleSha);
            } catch (Throwable) {
                return ['themeMode' => null, 'previewHtml' => '', 'sourceType' => 'none', 'entryFile' => null];
            }
            return Prerender::forBundle($bundlePath, $sha, $pageCache, true, $snapshotPath, $bundleSha);
        }
        return Prerender::forBundle($srcPath, $bundleSha, $pageCache, false, $snapshotPath);
    }

    /**
     * Build a safe JSON-LD WebApplication schema payload for SEO.
     * Omits absolute URLs when `siteOrigin` is unset.
     *
     * @param array<string, mixed> $row
     * @param array<string, mixed>|null $ver
     */
    private static function webAppJsonLd(array $row, ?array $ver, string $desc, ?string $url, ?string $image, ?string $playUrl = null): string
    {
        $ld = [
            '@context' => 'https://schema.org',
            '@type' => 'WebApplication',
            'name' => (string) $row['name'],
            'description' => $desc,
            'applicationCategory' => (string) ($row['category'] ?: 'UtilitiesApplication'),
            'operatingSystem' => 'Any',
            'offers' => ['@type' => 'Offer', 'price' => '0', 'priceCurrency' => 'USD'],
        ];
        if ($url !== null) $ld['url'] = $url;
        if ($playUrl !== null) $ld['installUrl'] = $playUrl;
        if ($image !== null) {
            $ld['image'] = $image;
            $ld['screenshot'] = $image;
        }
        $versionStr = is_array($ver) ? (string) ($ver['version'] ?? '') : '';
        if ($versionStr !== '') $ld['softwareVersion'] = $versionStr;
        $createdAt = (int) ($row['created_at'] ?? 0);
        if ($createdAt > 0) $ld['datePublished'] = gmdate('c', $createdAt);
        $updatedAt = (int) ($row['updated_at'] ?? 0);
        if ($updatedAt > 0) $ld['dateModified'] = gmdate('c', $updatedAt);
        $ratingCount = (int) ($row['rating_count'] ?? 0);
        $ratingSum = (int) ($row['rating_sum'] ?? 0);
        if ($ratingCount > 0 && $ratingSum > 0) {
            $ld['aggregateRating'] = [
                '@type' => 'AggregateRating',
                'ratingValue' => round($ratingSum / $ratingCount, 2),
                'ratingCount' => $ratingCount,
                'bestRating' => 5,
                'worstRating' => 1,
            ];
        }
        $runCount = (int) ($row['runs'] ?? 0);
        if ($runCount > 0) {
            $ld['interactionStatistic'] = [
                '@type' => 'InteractionCounter',
                'interactionType' => 'https://schema.org/UseAction',
                'userInteractionCount' => $runCount,
            ];
        }
        $author = trim((string) ($row['author'] ?? ''));
        if ($author !== '') $ld['author'] = ['@type' => 'Person', 'name' => $author];
        $tags = json_decode((string) ($row['tags'] ?? '[]'), true);
        if (is_array($tags) && $tags !== []) {
            $cleanTags = array_values(array_filter($tags, 'is_string'));
            if ($cleanTags !== []) $ld['keywords'] = implode(', ', $cleanTags);
        }
        $encoded = json_encode($ld, JSON_HEX_TAG | JSON_HEX_AMP | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        return is_string($encoded) ? $encoded : '';
    }

    /**
     * Build `BreadcrumbList` JSON-LD for `/app/<slug>` (`SoftN -> Apps -> [Category] -> App`).
     *
     * @param array<string, mixed> $row
     */
    private static function breadcrumbJsonLd(?string $origin, array $row, string $slug): string
    {
        if ($origin === null) return '';
        $items = [
            ['@type' => 'ListItem', 'position' => 1, 'name' => 'SoftN', 'item' => "$origin/"],
            ['@type' => 'ListItem', 'position' => 2, 'name' => 'Apps', 'item' => "$origin/apps"],
        ];
        $pos = 3;
        $cat = trim((string) ($row['category'] ?? ''));
        if ($cat !== '') {
            $items[] = [
                '@type' => 'ListItem',
                'position' => $pos++,
                'name' => $cat,
                'item' => "$origin/apps?category=" . rawurlencode($cat),
            ];
        }
        $items[] = [
            '@type' => 'ListItem',
            'position' => $pos,
            'name' => (string) ($row['name'] ?? $slug),
            'item' => "$origin/app/$slug",
        ];
        $encoded = json_encode([
            '@context' => 'https://schema.org',
            '@type' => 'BreadcrumbList',
            'itemListElement' => $items,
        ], JSON_HEX_TAG | JSON_HEX_AMP | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        return is_string($encoded) ? $encoded : '';
    }

    /** Strip static homepage-only head tags before injecting route-specific SEO tags. */
    private static function stripStaticHomeHead(string $html): string
    {
        $html = preg_replace('#<script\s+type="application/ld\+json"\s+id="softn-ld-json"[^>]*>[\s\S]*?</script>\s*#i', '', $html) ?? $html;
        $html = preg_replace('#<meta\s+name="(?:twitter:(?:title|description|image|image:alt)|robots)"[^>]*>\s*#i', '', $html) ?? $html;
        return $html;
    }

    /** Inject route-specific SSR markup inside `#root`, replacing static home SSR or empty `#root`. */
    private static function injectRootSsr(string $html, string $ssrBody): string
    {
        $replacement = $ssrBody === '' ? '' : ("\n" . $ssrBody . "\n    ");
        if (str_contains($html, '<!--softn:ssr-->')) {
            return self::replaceOnce(
                '#<!--softn:ssr-->[\s\S]*?<!--/softn:ssr-->#',
                fn() => $replacement,
                $html
            );
        }
        return self::replaceOnce(
            '#<div\s+id="root"\s*>\s*</div>#i',
            fn() => '<div id="root">' . $replacement . '</div>',
            $html
        );
    }

    /**
     * Semantic View-Source SSR HTML for `/app/<slug>`.
     *
     * @param array<string, mixed> $row
     * @param array<string, mixed>|null $ver
     */
    private static function renderAppBody(string $slug, array $row, ?array $ver, string $desc, ?string $playUrl, string $previewHtml): string
    {
        $e = fn(string $s): string => htmlspecialchars($s, ENT_QUOTES | ENT_HTML5, 'UTF-8');
        $name = (string) $row['name'];
        $author = trim((string) ($row['author'] ?? ''));
        $category = trim((string) ($row['category'] ?? ''));
        $tags = json_decode((string) ($row['tags'] ?? '[]'), true);
        $metaParts = [];
        if ($author !== '') $metaParts[] = 'By ' . $e($author);
        if ($category !== '') $metaParts[] = 'Category: ' . $e($category);
        if (is_array($ver) && !empty($ver['version'])) $metaParts[] = 'v' . $e((string) $ver['version']);
        $playHref = $playUrl ?? "/play/$slug";
        $lines = [
            '      <main id="boot" data-softn-ssr="app">',
            '        <header>',
            '          <h1>' . $e($name) . '</h1>',
            '          <p>' . $e($desc) . '</p>',
        ];
        if ($metaParts !== []) {
            $lines[] = '          <p>' . implode(' · ', $metaParts) . '</p>';
        }
        if (is_array($tags) && $tags !== []) {
            $tagHtml = [];
            foreach ($tags as $t) {
                if (is_string($t) && $t !== '') $tagHtml[] = '<li>' . $e($t) . '</li>';
            }
            if ($tagHtml !== []) $lines[] = '          <ul>' . implode('', $tagHtml) . '</ul>';
        }
        $lines[] = '          <nav><a href="' . $e($playHref) . '">Open ' . $e($name) . '</a> · <a href="/apps">Browse SoftN directory</a></nav>';
        $lines[] = '        </header>';
        if ($previewHtml !== '') {
            $indented = implode("\n", array_map(static fn(string $l): string => '          ' . $l, explode("\n", $previewHtml)));
            $lines[] = '        <section data-softn-preview="rendered" aria-label="Rendered application preview">';
            $lines[] = $indented;
            $lines[] = '        </section>';
        }
        $lines[] = '      </main>';
        return implode("\n", $lines);
    }

    /**
     * Semantic View-Source SSR HTML for `/play/<slug>`.
     *
     * @param array<string, mixed> $row
     */
    private static function renderPlayBody(string $slug, array $row, string $desc, string $previewHtml): string
    {
        $e = fn(string $s): string => htmlspecialchars($s, ENT_QUOTES | ENT_HTML5, 'UTF-8');
        $name = (string) $row['name'];
        $lines = [
            '        <article class="softn-ssr" data-softn-ssr="play">',
            '          <h1>' . $e($name) . '</h1>',
            '          <p>' . $e($desc) . '</p>',
        ];
        if ($previewHtml !== '') {
            $indented = implode("\n", array_map(static fn(string $l): string => '            ' . $l, explode("\n", $previewHtml)));
            $lines[] = '          <section data-softn-preview="rendered" aria-label="Rendered application preview">';
            $lines[] = $indented;
            $lines[] = '          </section>';
        }
        $lines[] = '          <p><a href="' . $e("/app/$slug") . '">About ' . $e($name) . '</a></p>';
        $lines[] = '        </article>';
        return implode("\n", $lines);
    }

    /**
     * Emit an HTTP response with a strong ETag and 304 Not Modified support.
     */
    private static function conditionalResponse(string $body, string $contentType, string $cacheControl): Response
    {
        $etag = '"' . substr(hash('sha256', $body), 0, 24) . '"';
        $headers = [
            'Content-Type' => $contentType,
            'Cache-Control' => $cacheControl,
            'ETag' => $etag,
        ];
        $inm = $_SERVER['HTTP_IF_NONE_MATCH'] ?? null;
        if (is_string($inm) && $inm !== '') {
            foreach (explode(',', $inm) as $cand) {
                $cand = trim($cand);
                if (str_starts_with($cand, 'W/')) $cand = substr($cand, 2);
                if ($cand === '*' || $cand === $etag) {
                    return Response::notModified($headers);
                }
            }
        }
        return str_starts_with($contentType, 'text/html')
            ? Response::html($body, 200, ['Cache-Control' => $cacheControl, 'ETag' => $etag])
            : Response::bytes($body, $contentType, ['Cache-Control' => $cacheControl, 'ETag' => $etag]);
    }

    /**
     * The first match of `$pattern` replaced by what `$with` builds, taken
     * literally. A replacement string would not be: preg_replace expands
     * `$1`, `${2}` and `\0` in it, and the text here is an app's name and
     * description, which anyone publishing chooses. HTML escaping leaves `$`
     * and `\` alone, so a name such as `0;url=https://evil/$2 http-equiv=refresh x=$2`
     * pulled the matched tag's own quote into the attribute, closed it, and
     * turned the share page into a redirect.
     *
     * @param callable(array<int, string>): string $with
     */
    private static function replaceOnce(string $pattern, callable $with, string $html): string
    {
        return preg_replace_callback($pattern, $with, $html, 1) ?? $html;
    }

    /**
     * The site's own address, from `siteOrigin` in data/config.json, or null
     * when it is not set. It used to fall back to the request's Host header,
     * and a request can carry anything in that: on a host that answers for
     * every name, a forged Host produced share pages whose canonical and
     * og:url named someone else's domain, which crawlers then cached. Now a
     * page without a configured origin carries no absolute address at all,
     * and GET /api/health says so.
     */
    public static function origin(): ?string
    {
        $configured = Config::get('siteOrigin');
        if (is_string($configured) && $configured !== '') return rtrim($configured, '/');
        return null;
    }
}
