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
                $notFoundHtml = preg_replace('#<link\s+rel="canonical"[^>]*>\s*#s', '', $notFoundHtml, 1) ?? $notFoundHtml;
                $notFoundHtml = preg_replace('#<meta\s+[^>]*name="description"[^>]*>\s*#s', '', $notFoundHtml, 1) ?? $notFoundHtml;
                $notFoundHtml = preg_replace('#<meta\s+[^>]*property="og:(?:url|title|description)"[^>]*>\s*#s', '', $notFoundHtml) ?? $notFoundHtml;
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
        $appDir = null;
        if ($playUrl === null) {
            try {
                $ver = Apps::version($slug);
                $appDir = Catalog::path($slug);
            } catch (ApiError) {
                $ver = null;
            }
        }
        // Hold storage.lock (LOCK_SH) before releasing catalog.lock so a concurrent
        // retire/move cannot remove `$appDir` mid-prerender or create zombie folders.
        $storageLock = self::holdStorageAndReleaseCatalog();
        try {
            $prerender = $ver !== null
                ? self::prerenderFor($slug, $row, $ver, null, '', "/play/$slug", $appDir)
                : ['themeMode' => null, 'previewHtml' => '', 'sourceType' => 'none', 'entryFile' => null, 'publicPages' => []];
        } finally {
            self::releaseStorageLock($storageLock);
        }

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

        $rawQuery = [];
        foreach (['q', 'category', 'subcategory', 'tag', 'author', 'cap', 'hosting', 'sort', 'page'] as $k) {
            if (is_string($_GET[$k] ?? null)) $rawQuery[$k] = (string) $_GET[$k];
        }
        $rawQuery['perPage'] = '24';
        $listed = Apps::list($rawQuery);
        $category = strtolower((string) ($listed['category'] ?? ''));
        if ($category === 'all') $category = '';
        $subcategory = strtolower((string) ($listed['subcategory'] ?? ''));
        if ($subcategory === 'all') $subcategory = '';
        $query = trim((string) ($listed['query'] ?? ''));
        $tag = strtolower(trim($rawQuery['tag'] ?? ''));
        $author = trim($rawQuery['author'] ?? '');
        $cap = strtolower(trim($rawQuery['cap'] ?? ''));
        $hostingFilter = strtolower(trim($rawQuery['hosting'] ?? ''));
        $rawPage = $rawQuery['page'] ?? '1';
        $page = ctype_digit($rawPage) ? max(1, min(500, (int) $rawPage)) : 1;

        $allVisible = array_values(array_filter(Catalog::all(), static fn(array $r): bool => empty($r['hidden'])));
        $catCounts = [];
        foreach ($allVisible as $r) {
            $c = strtolower(trim((string) ($r['category'] ?? '')));
            if ($c !== '') $catCounts[$c] = ($catCounts[$c] ?? 0) + 1;
        }
        arsort($catCounts);

        $perPage = (int) $listed['perPage'];
        $total = (int) $listed['total'];
        $totalPages = max(1, (int) $listed['pages']);
        $slice = $page <= $totalPages && is_array($listed['apps'] ?? null) ? $listed['apps'] : [];
        $rows = $allVisible;

        $labelParts = [];
        if ($category !== '') $labelParts[] = ucfirst($category);
        if ($subcategory !== '') $labelParts[] = ucfirst(str_replace('-', ' ', $subcategory));
        $headingLabel = $labelParts !== [] ? implode(' · ', $labelParts) . ' Apps' : 'SoftN Apps Directory';
        $title = ($labelParts !== [] ? implode(' — ', $labelParts) . ' Apps' : 'Apps Directory')
            . ($page > 1 ? " (Page $page)" : '') . ' — SoftN';
        $desc = $category !== ''
            ? "Browse $total " . implode(' / ', $labelParts) . " apps on SoftN. Run them directly in your browser sandbox, view their source, or remix them."
            : "Browse $total apps built with SoftN: business tools, games, simulations, and interactive web apps that run safely in one .softn file.";

        $buildDirUrl = static function (int $targetPage) use ($category, $subcategory): string {
            $params = [];
            if ($category !== '') $params['category'] = $category;
            if ($subcategory !== '') $params['subcategory'] = $subcategory;
            if ($targetPage > 1) $params['page'] = (string) $targetPage;
            return '/apps' . ($params !== [] ? '?' . http_build_query($params, '', '&', PHP_QUERY_RFC3986) : '');
        };
        $canonicalPath = $buildDirUrl(min($page, $totalPages));
        $hasDynamicFilter = $query !== '' || $tag !== '' || $author !== '' || $cap !== '' || $hostingFilter !== '';
        $isNoindex = $hasDynamicFilter || $page > $totalPages || (($category !== '' || $subcategory !== '') && $total === 0);
        $robots = $isNoindex ? 'noindex,follow' : 'index,follow,max-image-preview:large';
        // Avoid conflicting `noindex` + cross-URL `<link rel="canonical">` signals.
        $url = ($origin === null || $isNoindex) ? null : ($origin . $canonicalPath);

        $ogImg = $origin !== null ? "$origin/og.png" : null;
        $html = self::replaceOnce('#<title>.*?</title>#s', fn() => '<title>' . $e($title) . '</title>', $html);
        foreach ([
            'name="description"' => $desc,
            'property="og:title"' => $title,
            'property="og:description"' => $desc,
            'property="og:url"' => $url,
            ...($ogImg !== null ? ['property="og:image"' => $ogImg] : []),
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
        $pos = ($page - 1) * $perPage + 1;
        foreach ($slice as $r) {
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

        $crumbsJson = '';
        if ($origin !== null) {
            $crumbItems = [
                ['@type' => 'ListItem', 'position' => 1, 'name' => 'SoftN', 'item' => "$origin/"],
                ['@type' => 'ListItem', 'position' => 2, 'name' => 'Apps', 'item' => "$origin/apps"],
            ];
            if ($category !== '') {
                $crumbItems[] = ['@type' => 'ListItem', 'position' => 3, 'name' => ucfirst($category), 'item' => "$origin/apps?category=" . rawurlencode($category)];
                if ($subcategory !== '') {
                    $crumbItems[] = ['@type' => 'ListItem', 'position' => 4, 'name' => ucfirst(str_replace('-', ' ', $subcategory)), 'item' => "$origin/apps?category=" . rawurlencode($category) . '&subcategory=' . rawurlencode($subcategory)];
                }
            }
            $encodedCrumbs = json_encode([
                '@context' => 'https://schema.org',
                '@type' => 'BreadcrumbList',
                'itemListElement' => $crumbItems,
            ], JSON_HEX_TAG | JSON_HEX_AMP | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
            if (is_string($encodedCrumbs)) $crumbsJson = $encodedCrumbs;
        }

        $relLinks = '';
        if (!$hasDynamicFilter && $origin !== null) {
            if ($page > 1 && $page <= $totalPages) {
                $relLinks .= '    <link rel="prev" href="' . $e($origin . $buildDirUrl($page - 1)) . '" />' . "\n";
            }
            if ($page < $totalPages) {
                $relLinks .= '    <link rel="next" href="' . $e($origin . $buildDirUrl($page + 1)) . '" />' . "\n";
            }
        }

        $extraHead = '<meta name="robots" content="' . $e($robots) . '" />' . "\n"
            . '    <meta name="twitter:title" content="' . $e($title) . '" />' . "\n"
            . '    <meta name="twitter:description" content="' . $e($desc) . '" />' . "\n"
            . ($ogImg !== null ? '    <meta name="twitter:image" content="' . $e($ogImg) . '" />' . "\n" . '    <meta name="twitter:image:alt" content="SoftN apps directory" />' . "\n" : '')
            . $relLinks
            . (is_string($ldJson) ? '    <script type="application/ld+json">' . $ldJson . '</script>' . "\n" : '')
            . ($crumbsJson !== '' ? '    <script type="application/ld+json">' . $crumbsJson . '</script>' . "\n" : '')
            . '  </head>';
        $html = str_replace('</head>', $extraHead, $html);

        $lines = [
            '      <main id="boot" data-softn-ssr="directory">',
            '        <header>',
            '          <h1>' . $e($headingLabel) . '</h1>',
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
        foreach ($slice as $r) {
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
        if ($totalPages > 1 && !$hasDynamicFilter) {
            $pager = [];
            if ($page > 1 && $page <= $totalPages) $pager[] = '<a rel="prev" href="' . $e($buildDirUrl($page - 1)) . '">Previous page</a>';
            $pager[] = 'Page ' . $page . ' of ' . $totalPages;
            if ($page < $totalPages) $pager[] = '<a rel="next" href="' . $e($buildDirUrl($page + 1)) . '">Next page</a>';
            $lines[] = '        <nav aria-label="Pagination">' . implode(' · ', $pager) . '</nav>';
        }
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
        $isParameterizedPublish = (is_string($_GET['remix'] ?? null) && trim($_GET['remix']) !== '')
            || (is_string($_GET['update'] ?? null) && trim($_GET['update']) !== '');
        $title = 'Publish a SoftN App — SoftN';
        $desc = 'Publish a .softn app bundle to the SoftN directory. No account required: publishing returns an edit key for updates.';
        $url = ($origin === null || $isParameterizedPublish) ? null : "$origin/publish";
        $robots = $isParameterizedPublish ? 'noindex,follow' : 'index,follow';

        $ogImg = $origin !== null ? "$origin/og.png" : null;
        $html = self::replaceOnce('#<title>.*?</title>#s', fn() => '<title>' . $e($title) . '</title>', $html);
        foreach ([
            'name="description"' => $desc,
            'property="og:title"' => $title,
            'property="og:description"' => $desc,
            'property="og:url"' => $url,
            ...($ogImg !== null ? ['property="og:image"' => $ogImg] : []),
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

        $extraHead = '<meta name="robots" content="' . $e($robots) . '" />' . "\n"
            . '    <meta name="twitter:title" content="' . $e($title) . '" />' . "\n"
            . '    <meta name="twitter:description" content="' . $e($desc) . '" />' . "\n"
            . ($ogImg !== null ? '    <meta name="twitter:image" content="' . $e($ogImg) . '" />' . "\n" . '    <meta name="twitter:image:alt" content="Publish a SoftN app" />' . "\n" : '')
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
        // Which backend an app's frontend is pointed at is hostingInfo's to say, by the one
        // rule this page and the API the web app reads both follow (Apps::honouredBackendUrl).
        // This page gives out what of it is a path on this origin, which is the app's own
        // hosted backend: its shell refuses the whole configuration for a location anywhere
        // else, so a backend elsewhere is the web app's to reach (/web/app/<slug>). This
        // page kept a rule of its own here before, which also gave out a path on this site
        // for an app the owner trusts.
        if ($useServerBackend && $hosting['backendUrl'] === "/api/apps/$slug/backend") {
            $config['backendUrl'] = $hosting['backendUrl'];
        }
        return $config;
    }

    public static function play(string $slugGiven, bool $forceLocal = false, string $subPath = ''): Response
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
            $appDir = Catalog::path($slug);
        } catch (ApiError $err) {
            // A real 404 with a way back, not the shell failing to load
            // something: a shared link to an app since unpublished should say so.
            return self::problem($err->getMessage(), $err->status);
        }
        $cfg = self::playConfig($row, $ver, $forceLocal);
        // Hold storage.lock (LOCK_SH) before releasing catalog.lock so a concurrent
        // retire/move cannot remove `$appDir` while reading/caching bundle entries.
        $storageLock = self::holdStorageAndReleaseCatalog();
        $html = (string) file_get_contents($shell);
        $appName = (string) $row['name'];
        $appDesc = (string) ($row['description'] ?? '');
        $origin = self::origin();
        $linkBase = "/play/$slug";
        try {
            $prerender = self::prerenderFor(
                $slug,
                $row,
                $ver,
                is_string($cfg['sha256'] ?? null) ? $cfg['sha256'] : null,
                $subPath,
                $linkBase,
                $appDir
            );
        } finally {
            self::releaseStorageLock($storageLock);
        }

        $cleanSub = trim(str_replace('\\', '/', $subPath), '/');
        if ($cleanSub !== '' && !($prerender['found'] ?? false)) {
            return self::problem(
                'That page does not exist in ' . $appName . '.',
                404,
                $linkBase,
                'Back to ' . $appName
            );
        }

        $virtualPath = is_string($prerender['virtualPath'] ?? null) && $prerender['virtualPath'] !== ''
            ? $prerender['virtualPath']
            : '/';
        $publicPages = is_array($prerender['publicPages'] ?? null) ? $prerender['publicPages'] : [];
        $hasSsrBackend = (bool) ($prerender['hasSsrBackend'] ?? false);
        $isMultiPage = count($publicPages) > 1;
        $isSubPage = $virtualPath !== '/';
        $isDynamicSsrFallback = ($prerender['sourceType'] ?? '') === 'ssr-backend' && $isSubPage;

        if ($isMultiPage || $isSubPage || $hasSsrBackend) {
            $cfg['basePath'] = $linkBase;
            $cfg['initialPath'] = $virtualPath;
        }

        $config = json_encode($cfg, JSON_HEX_TAG | JSON_HEX_AMP | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        if ($config === false) return Response::html('<!doctype html><title>SoftN</title><p>The app could not be described.</p>', 500);

        $pageTitle = ($isMultiPage || $isSubPage)
            && is_string($prerender['pageTitle'] ?? null)
            && $prerender['pageTitle'] !== ''
            ? $prerender['pageTitle']
            : $appName;
        $desc = ($isMultiPage || $isSubPage)
            && is_string($prerender['pageDescription'] ?? null)
            && $prerender['pageDescription'] !== ''
            ? $prerender['pageDescription']
            : ($appDesc !== '' ? $appDesc : "$appName — run this SoftN app directly in your browser.");
        $robots = is_string($prerender['pageRobots'] ?? null) && $prerender['pageRobots'] !== ''
            ? $prerender['pageRobots']
            : ($isDynamicSsrFallback ? 'noindex,follow' : 'index,follow,max-image-preview:large');
        $pageIsNoindex = preg_match('/(?:^|,)(?:noindex|none)(?:,|$)/', $robots) === 1;

        $pageLang = is_string($prerender['pageLang'] ?? null) && $prerender['pageLang'] !== '' ? $prerender['pageLang'] : null;
        if ($pageLang !== null) {
            if (preg_match('#<html\b[^>]*\blang="[^"]*"#i', $html) === 1) {
                $html = self::replaceOnce('#(<html\b[^>]*\blang=")[^"]*(")#i', fn(array $m) => $m[1] . $e($pageLang) . $m[2], $html);
            } else {
                $html = self::replaceOnce('#<html(?=\s|>)#i', fn() => '<html lang="' . $e($pageLang) . '"', $html);
            }
        }
        $html = self::replaceOnce('#<title>.*?</title>#s', fn() => '<title>' . $e($pageTitle) . '</title>', $html);
        // JSON_HEX_TAG has turned every < and > into \u003C and \u003E, so
        // nothing in a name or a description can close this element early.
        $image = ($origin ?? '') . "/api/apps/$slug/thumbnail?v=" . (int) ($row['updated_at'] ?? 0);
        $playPagePath = $isSubPage ? ($linkBase . $virtualPath) : $linkBase;
        $playPageUrl = $origin === null ? null : ($origin . $playPagePath);
        // Sub-pages and multi-page websites are self-canonical at their live URL;
        // single-page apps keep `/app/<slug>` as their canonical share address.
        // Omit canonical on noindex/dynamic-SSR fallback pages so signals never conflict.
        $canonicalUrl = ($origin === null || $pageIsNoindex)
            ? null
            : (($isSubPage || $isMultiPage) ? $playPageUrl : "$origin/app/$slug");
        $ogUrl = ($origin === null || $pageIsNoindex)
            ? null
            : (($isSubPage || $isMultiPage) ? $playPageUrl : "$origin/app/$slug");

        $jsonLdBlocks = [];
        if ($isSubPage || $isMultiPage) {
            $pageLd = self::webPageJsonLd($row, $slug, $pageTitle, $desc, $playPageUrl, $origin !== null ? $image : null, $origin);
            if ($pageLd !== '') $jsonLdBlocks[] = $pageLd;
            $crumbsLd = self::playBreadcrumbJsonLd($origin, $row, $slug, $isSubPage ? $pageTitle : null, $playPageUrl);
            if ($crumbsLd !== '') $jsonLdBlocks[] = $crumbsLd;
        } else {
            $appLd = self::webAppJsonLd($row, $ver, $desc, $canonicalUrl, $origin !== null ? $image : null, $playPageUrl);
            if ($appLd !== '') $jsonLdBlocks[] = $appLd;
        }
        $jsonLdHtml = '';
        foreach ($jsonLdBlocks as $ldBlock) {
            $jsonLdHtml .= '    <script type="application/ld+json">' . $ldBlock . '</script>' . "\n";
        }

        $preloadBundle = is_string($cfg['bundle'] ?? null) && $cfg['bundle'] !== ''
            ? '    <link rel="preload" href="' . $e($cfg['bundle']) . '" as="fetch" crossorigin="anonymous" fetchpriority="high" />' . "\n"
            : '';
        $isWebContainer = ($prerender['sourceType'] ?? '') === 'html'
            || ($prerender['sourceType'] ?? '') === 'ssr-backend'
            || (is_string($row['backend_runtime'] ?? null) && trim($row['backend_runtime']) !== '');
        $preloadEngines = self::preloadContainerEngineLinks($row, $cfg, $e, $prerender['engineTier'] ?? null, $isWebContainer);
        // The shell draws its boot screen dark, the `theme` above. An app
        // whose project declares light is drawn light whatever that theme
        // says, so its boot screen is too, rather than opening dark and
        // turning light; the wheel takes the text colour, as the privately
        // served page's does. Every other app gets no extra style tag.
        $boot = $prerender['themeMode'] === 'light'
            ? '    <style>html,body{background:#f5f5f8;color:#171821}.wheel{border-color:color-mix(in srgb,currentColor 20%,transparent);border-top-color:currentColor}</style>' . "\n"
            : '';
        $inject = '<meta name="softn:app" content="' . $e($slug) . '" />' . "\n"
            . ($isSubPage ? '    <meta name="softn:page" content="' . $e($virtualPath) . '" />' . "\n" : '')
            . '    <meta name="robots" content="' . $e($robots) . '" />' . "\n"
            . '    <meta name="description" content="' . $e($desc) . '" />' . "\n"
            . '    <meta property="og:type" content="' . ($isSubPage ? 'article' : 'website') . '" />' . "\n"
            . '    <meta property="og:site_name" content="' . $e($isMultiPage ? $appName : 'SoftN') . '" />' . "\n"
            . '    <meta property="og:title" content="' . $e($pageTitle) . '" />' . "\n"
            . '    <meta property="og:description" content="' . $e($desc) . '" />' . "\n"
            . '    <meta property="og:image" content="' . $e($image) . '" />' . "\n"
            . '    <meta property="og:image:alt" content="' . $e("$pageTitle on SoftN") . '" />' . "\n"
            . ($ogUrl === null ? '' : '    <meta property="og:url" content="' . $e($ogUrl) . '" />' . "\n")
            . '    <meta name="twitter:card" content="summary_large_image" />' . "\n"
            . '    <meta name="twitter:title" content="' . $e($pageTitle) . '" />' . "\n"
            . '    <meta name="twitter:description" content="' . $e($desc) . '" />' . "\n"
            . '    <meta name="twitter:image" content="' . $e($image) . '" />' . "\n"
            . '    <meta name="twitter:image:alt" content="' . $e("$pageTitle on SoftN") . '" />' . "\n"
            . ($canonicalUrl === null ? '' : '    <link rel="canonical" href="' . $e($canonicalUrl) . '" />' . "\n")
            . $preloadBundle
            . $preloadEngines
            . $jsonLdHtml
            . $boot
            . '    <script type="application/json" id="softn-runtime-config">' . $config . '</script>' . "\n  </head>";
        $html = str_replace('</head>', $inject, $html);

        $noindexPages = is_array($prerender['noindexPages'] ?? null) ? $prerender['noindexPages'] : [];
        $indexablePages = $noindexPages === []
            ? $publicPages
            : array_values(array_diff($publicPages, $noindexPages));
        $ssrPlay = self::renderPlayBody($slug, $row, $pageTitle, $desc, $prerender['previewHtml'], $virtualPath, $indexablePages);
        // Place the semantic SSR <main id="softn-ssr-view"> OUTSIDE React's `#root` so
        // client boot does not wipe crawlable SSR content before the runtime is ready
        // (and preserves it if a crawler blocks bundle fetches).
        if (preg_match('#<div\s+id="boot"(?=\s|>)[^>]*>[\s\S]*?</div>\s*</div>#i', $html) === 1) {
            $html = self::replaceOnce(
                '#(<div\s+id="boot"(?=\s|>)[^>]*>[\s\S]*?</div>\s*</div>)#i',
                fn(array $m) => $m[1] . "\n" . $ssrPlay,
                $html
            );
        } else {
            $html = self::replaceOnce(
                '#<div\s+id="root"\s*>\s*</div>#i',
                fn() => '<div id="root"><div id="boot" role="status"><span>Loading…</span></div></div>' . "\n" . $ssrPlay,
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
        $allRows = Catalog::all();
        $rows = array_values(array_filter($allRows, static fn(array $r): bool => empty($r['hidden'])));
        usort($rows, static fn(array $a, array $b): int => ((int) ($b['updated_at'] ?? 0)) <=> ((int) ($a['updated_at'] ?? 0)));

        // Compute a lightweight fingerprint over the visible catalogue so warm sitemap requests
        // serve directly from disk cache (~1 ms) without touching per-app bundles.
        $fpParts = [$origin, 'v' . Prerender::VERSION, (string) count($rows)];
        foreach (array_slice($rows, 0, 49900) as $r) {
            $fpParts[] = ((string) ($r['slug'] ?? '')) . ':' . ((int) ($r['updated_at'] ?? 0)) . ':' . ((string) ($r['category'] ?? '')) . '/' . ((string) ($r['subcategory'] ?? ''));
        }
        $fpHash = substr(hash('sha256', implode('|', $fpParts)), 0, 20);
        $cacheDir = Config::dataDir() . '/cache';
        $sitemapCacheFile = $cacheDir . '/sitemap-apps-' . $fpHash . '.xml';
        $cachedXml = @file_get_contents($sitemapCacheFile);
        if (is_string($cachedXml) && str_starts_with($cachedXml, '<?xml')) {
            Catalog::release();
            return self::conditionalResponse($cachedXml, 'application/xml; charset=utf-8', 'public, max-age=300, stale-while-revalidate=3600');
        }

        // Snapshot version & appDir paths before releasing the global catalogue lock.
        $snapshots = [];
        foreach (array_slice($rows, 0, 49900) as $row) {
            $slug = (string) ($row['slug'] ?? '');
            if ($slug === '' || !Catalog::validSlug($slug)) continue;
            $ver = null;
            $appDir = null;
            if (Apps::playUrl($row) === null) {
                try {
                    $ver = Apps::version($slug);
                    $appDir = Catalog::path($slug);
                } catch (Throwable) {
                    $ver = null;
                }
            }
            $snapshots[] = ['row' => $row, 'slug' => $slug, 'ver' => $ver, 'appDir' => $appDir];
        }
        $storageLock = self::holdStorageAndReleaseCatalog();
        try {
        $urls = [
            ['loc' => "$origin/", 'lastmod' => null, 'image' => null, 'title' => null],
            ['loc' => "$origin/apps", 'lastmod' => null, 'image' => null, 'title' => null],
            ['loc' => "$origin/publish", 'lastmod' => null, 'image' => null, 'title' => null],
        ];
        $seenCats = [];
        $seenSubs = [];
        foreach ($snapshots as $item) {
            $cat = strtolower(trim((string) ($item['row']['category'] ?? '')));
            if ($cat !== '') {
                if (!isset($seenCats[$cat])) {
                    $seenCats[$cat] = true;
                    $urls[] = [
                        'loc' => "$origin/apps?category=" . rawurlencode($cat),
                        'lastmod' => null,
                        'image' => null,
                        'title' => null,
                    ];
                }
                $sub = strtolower(trim((string) ($item['row']['subcategory'] ?? '')));
                if ($sub !== '' && !isset($seenSubs["$cat/$sub"])) {
                    $seenSubs["$cat/$sub"] = true;
                    $urls[] = [
                        'loc' => "$origin/apps?category=" . rawurlencode($cat) . '&subcategory=' . rawurlencode($sub),
                        'lastmod' => null,
                        'image' => null,
                        'title' => null,
                    ];
                }
            }
        }
        foreach ($snapshots as $item) {
            if (count($urls) >= 49950) break;
            $row = $item['row'];
            $slug = $item['slug'];
            $updated = (int) ($row['updated_at'] ?? 0);
            $lastmod = $updated > 0 ? gmdate('Y-m-d', $updated) : null;
            $urls[] = [
                'loc' => "$origin/app/$slug",
                'lastmod' => $lastmod,
                'image' => "$origin/api/apps/$slug/thumbnail?v=$updated",
                'title' => (string) ($row['name'] ?? $slug),
            ];
            if ($item['ver'] !== null && is_string($item['appDir'])) {
                try {
                    $meta = self::bundleMetaFor($slug, $row, $item['ver'], $item['appDir']);
                    $pages = is_array($meta['publicPages'] ?? null) ? $meta['publicPages'] : [];
                    $noindexSet = array_fill_keys(
                        is_array($meta['noindexPages'] ?? null) ? $meta['noindexPages'] : [],
                        true
                    );
                    if (count($pages) > 1) {
                        foreach ($pages as $p) {
                            if (isset($noindexSet[$p])) continue;
                            if (count($urls) >= 49950) break;
                            $urls[] = [
                                'loc' => $p === '' ? "$origin/play/$slug" : "$origin/play/$slug/$p",
                                'lastmod' => $lastmod,
                                'image' => null,
                                'title' => null,
                            ];
                        }
                    }
                } catch (Throwable) {
                    // Unreadable version never breaks sitemap generation.
                }
            }
        }
        } finally {
            self::releaseStorageLock($storageLock);
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
        try {
            if (!is_dir($cacheDir)) @mkdir($cacheDir, 0775, true);
            // Kept only while the disk has the room every other write is held to
            // (Config::hasRoom): the sitemap is the whole catalogue, written again
            // after each change to it, and it is served from here either way.
            if (is_dir($cacheDir) && Config::hasRoom(strlen($xml))) {
                $tmp = $sitemapCacheFile . '.tmp.' . getmypid() . '.' . bin2hex(random_bytes(4));
                if (@file_put_contents($tmp, $xml) === strlen($xml)) {
                    if (!@rename($tmp, $sitemapCacheFile)) @unlink($tmp);
                    // The ones before it are of a catalogue that has changed since and are
                    // never read again: left, every publish and every edit added one for good.
                    else foreach (scandir($cacheDir) ?: [] as $name) {
                        if ($name !== basename($sitemapCacheFile) && preg_match('/^sitemap-apps-[0-9a-f]{20}\.xml$/D', $name)) @unlink("$cacheDir/$name");
                    }
                } else {
                    @unlink($tmp);
                }
            }
        } catch (Throwable) {
            // Read-only cache dir never breaks sitemap output.
        }
        return self::conditionalResponse($xml, 'application/xml; charset=utf-8', 'public, max-age=300, stale-while-revalidate=3600');
    }

    /**
     * What a person who followed a link to an app's page or its play page is
     * told when it cannot be shown: a page, as the status the API would have
     * answered, with a way back. The API's JSON is for a script, and this
     * address is in someone's chat.
     */
    public static function problem(string $message, int $status, ?string $backHref = null, ?string $backLabel = null): Response
    {
        $e = fn(string $s): string => htmlspecialchars($s, ENT_QUOTES | ENT_HTML5, 'UTF-8');
        // Worded for an operator, whose site it is; a visitor is told what it means for them first.
        $say = $status === 404 ? '<h1>' . $e($message) . '</h1>' : '<h1>This page can’t be shown right now.</h1><p>' . $e($message) . '</p>';
        $links = [];
        if (is_string($backHref) && $backHref !== '' && is_string($backLabel) && $backLabel !== '') {
            $links[] = '<a href="' . $e($backHref) . '">' . $e($backLabel) . '</a>';
        }
        $links[] = '<a href="/apps">Browse the directory</a>';
        return Response::html(
            '<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />'
            . '<meta name="robots" content="noindex" />'
            . '<title>' . ($status === 404 ? 'Not here' : 'Unavailable') . ' — SoftN</title><style>html,body{margin:0;background:#171821;color:#f5f5f8;font-family:system-ui}'
            . 'main{min-height:100dvh;display:grid;place-content:center;text-align:center;gap:12px;padding:24px}a{color:#acb8ff}</style></head>'
            . '<body><main>' . $say . '<p>' . implode(' · ', $links) . '</p></main></body></html>',
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
        try {
            $row = Apps::row($slug);
        } catch (ApiError) {
            return null;
        }
        return self::prerenderFor($slug, $row, $ver)['themeMode'];
    }

    /**
     * Read build-emitted `play/runtime-manifest.json` (with scandir fallback for test harnesses).
     *
     * @return array{runtimeBase: string, fullEngineUrl: ?string, containerMountUrl: ?string}
     */
    private static function playRuntimeManifest(): array
    {
        static $cached = null;
        if ($cached !== null) return $cached;
        $docRoot = dirname(__DIR__, 2);
        $manifestPath = $docRoot . '/play/runtime-manifest.json';
        if (is_file($manifestPath)) {
            $decoded = json_decode((string) @file_get_contents($manifestPath), true);
            if (is_array($decoded) && is_string($decoded['runtimeBase'] ?? null)) {
                $safePath = static fn(mixed $v): ?string => (is_string($v) && str_starts_with($v, '/') && !str_starts_with($v, '//')) ? $v : null;
                $cached = [
                    'runtimeBase' => $safePath($decoded['runtimeBase']) ?? '',
                    'fullEngineUrl' => $safePath($decoded['fullEngineUrl'] ?? null),
                    'containerMountUrl' => $safePath($decoded['containerMountUrl'] ?? null),
                ];
                return $cached;
            }
        }
        $runtimeBase = '';
        $sharedDir = $docRoot . '/shared/container-runtime';
        if (is_dir($sharedDir)) {
            foreach (scandir($sharedDir) ?: [] as $entry) {
                if (preg_match('/^[0-9a-f]{12}$/', $entry) === 1 && is_dir("$sharedDir/$entry/engines")) {
                    $runtimeBase = "/shared/container-runtime/$entry/engines/";
                    break;
                }
            }
        }
        $cached = ['runtimeBase' => $runtimeBase, 'fullEngineUrl' => null, 'containerMountUrl' => null];
        return $cached;
    }

    /**
     * Emit `<link rel="modulepreload">` / `<link rel="preload" as="fetch">` hints for
     * v2 Web Container mount chunks and required WASM engines, skipping WASM preloads
     * entirely for scriptless static HTML/CSS pages (`engineTier === 'none'`).
     *
     * @param array<string, mixed> $row
     * @param array<string, mixed> $cfg
     * @param callable(string): string $e
     */
    private static function preloadContainerEngineLinks(
        array $row,
        array $cfg,
        callable $e,
        ?string $engineTier = null,
        bool $isWebContainer = false
    ): string {
        $manifest = self::playRuntimeManifest();
        $docRoot = dirname(__DIR__, 2);
        $out = '';

        // Preload `@softn/container/mount` chunk in parallel with `bundle.softn` for v2 apps.
        if ($isWebContainer && is_string($manifest['containerMountUrl']) && $manifest['containerMountUrl'] !== '') {
            $out .= '    <link rel="modulepreload" crossorigin href="' . $e($manifest['containerMountUrl']) . '" />' . "\n";
        }

        $hasServerBackend = isset($cfg['backendUrl']);
        $rt = !$hasServerBackend && is_string($row['backend_runtime'] ?? null)
            ? strtolower(trim($row['backend_runtime']))
            : '';
        $engineFile = null;
        $needsXdb = false;
        $needsFullCore = false;
        if ($rt !== '') {
            $engineFile = match ($rt) {
                'php' => 'zipp-php.wasm',
                'rust' => 'zipp-rust.wasm',
                'typescript' => 'zipp-typescript.wasm',
                default => null,
            };
            $needsFullCore = in_array($rt, ['javascript', 'python'], true);
            $needsXdb = $engineFile !== null || $needsFullCore;
        } elseif ($engineTier === 'none') {
            return $out;
        } elseif ($engineTier === 'lite') {
            $engineFile = 'zipp-javascript-lite.wasm';
        } elseif ($engineTier === 'typescript') {
            $engineFile = 'zipp-typescript.wasm';
        } elseif ($engineTier === 'full') {
            $needsFullCore = true;
        }

        $runtimeBase = $manifest['runtimeBase'];
        if ($runtimeBase !== '' && $engineFile !== null) {
            if (is_file($docRoot . $runtimeBase . $engineFile)) {
                $out .= '    <link rel="preload" href="' . $e($runtimeBase . $engineFile) . '" as="fetch" crossorigin="anonymous" />' . "\n";
            }
        }
        if ($needsFullCore && is_string($manifest['fullEngineUrl']) && $manifest['fullEngineUrl'] !== '') {
            if (is_file($docRoot . $manifest['fullEngineUrl'])) {
                $out .= '    <link rel="preload" href="' . $e($manifest['fullEngineUrl']) . '" as="fetch" crossorigin="anonymous" />' . "\n";
            }
        }
        if ($needsXdb && $runtimeBase !== '') {
            if (is_file($docRoot . $runtimeBase . 'xdb-wasm.wasm')) {
                $out .= '    <link rel="preload" href="' . $e($runtimeBase . 'xdb-wasm.wasm') . '" as="fetch" crossorigin="anonymous" />' . "\n";
            }
        }
        return $out;
    }

    /**
     * Acquire `storage.lock` (LOCK_SH) before releasing `catalog.lock` so a concurrent
     * retire/purge or folder move cannot delete or relocate `$appDir` while pages read
     * bundles or update `backend-cache/`.
     *
     * @return resource|false
     */
    private static function holdStorageAndReleaseCatalog()
    {
        $lock = @fopen(Config::dataDir() . '/storage.lock', 'c');
        if ($lock !== false) {
            flock($lock, LOCK_SH);
        }
        Catalog::release();
        return $lock;
    }

    /** @param resource|false $lock */
    private static function releaseStorageLock($lock): void
    {
        if (is_resource($lock)) {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }

    /**
     * Where what the pages were rendered to is kept: a file for each page of
     * each app's current version, named for the app and for the bundle
     * (Prerender::cacheKey). An app's files of a version before go when its
     * next one is first rendered, and all of them with the app.
     */
    private static function pageCache(): string
    {
        return Config::dataDir() . '/page-cache';
    }

    /** A removed app's rendered pages: no address asks for them again. */
    public static function forget(string $slug): void
    {
        Prerender::forget(self::pageCache(), $slug);
    }

    /**
     * Load lightweight bundle-level metadata (theme, tier, publicPages, noindexPages)
     * for `/sitemap-apps.xml` without touching per-page HTML previews.
     *
     * @param array<string, mixed> $row
     * @param array<string, mixed> $ver
     * @return array{themeMode: ?string, engineTier: ?string, publicPages: array<int, string>, noindexPages: array<int, string>, hasSsrBackend: bool}
     */
    private static function bundleMetaFor(string $slug, array $row, array $ver, ?string $appDir = null): array
    {
        $hosting = Apps::hostingInfo($row);
        $dir = $appDir ?? Catalog::path($slug);
        $srcPath = $dir . '/' . (string) ($ver['file'] ?? '');
        $bundleSha = (string) ($ver['sha256'] ?? '');
        $withhold = (bool) $hosting['withholdBackend'];
        $pageCache = self::pageCache();
        if ($withhold) {
            $cachePath = $dir . '/backend-cache/client-v' . (int) ($ver['version'] ?? 0) . '-' . substr($bundleSha, 0, 12) . '.softn';
            try {
                $bundlePath = Bundle::clientBundlePath($srcPath, $cachePath);
                $sha = Bundle::clientBundleSha256($srcPath, $cachePath, $bundleSha);
            } catch (Throwable) {
                return ['themeMode' => null, 'engineTier' => null, 'publicPages' => [], 'noindexPages' => [], 'hasSsrBackend' => false];
            }
            return Prerender::bundleMetaFor($bundlePath, $sha, $pageCache, true, $slug);
        }
        return Prerender::bundleMetaFor($srcPath, $bundleSha, $pageCache, false, $slug);
    }

    /**
     * Load cached pre-render data for a published app version and optional sub-page,
     * strictly reading the backend-stripped client bundle whenever `withholdBackend` is active.
     *
     * @param array<string, mixed> $row
     * @param array<string, mixed> $ver
     * @return array<string, mixed>
     */
    private static function prerenderFor(
        string $slug,
        array $row,
        array $ver,
        ?string $resolvedClientSha = null,
        string $subPath = '',
        ?string $linkBase = null,
        ?string $resolvedAppDir = null
    ): array {
        $hosting = Apps::hostingInfo($row);
        $appDir = $resolvedAppDir ?? Catalog::path($slug);
        $srcPath = $appDir . '/' . (string) ($ver['file'] ?? '');
        $bundleSha = (string) ($ver['sha256'] ?? '');
        $withhold = (bool) $hosting['withholdBackend'];
        $pageCache = self::pageCache();
        $snapshotPath = $appDir . '/ssr.html';
        if ($withhold) {
            $cachePath = $appDir . '/backend-cache/client-v' . (int) ($ver['version'] ?? 0) . '-' . substr($bundleSha, 0, 12) . '.softn';
            try {
                if ($resolvedClientSha !== null && is_file($cachePath)) {
                    $bundlePath = $cachePath;
                    $sha = $resolvedClientSha;
                } else {
                    $bundlePath = Bundle::clientBundlePath($srcPath, $cachePath);
                    $sha = Bundle::clientBundleSha256($srcPath, $cachePath, $bundleSha);
                }
            } catch (Throwable) {
                return [
                    'themeMode' => null,
                    'previewHtml' => '',
                    'sourceType' => 'none',
                    'entryFile' => null,
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
            }
            return Prerender::forBundlePage($bundlePath, $sha, $pageCache, true, $snapshotPath, $bundleSha, $subPath, $linkBase, $slug);
        }
        return Prerender::forBundlePage($srcPath, $bundleSha, $pageCache, false, $snapshotPath, null, $subPath, $linkBase, $slug);
    }

    /** Map SoftN category IDs to valid Schema.org SoftwareApplication categories. */
    private static function schemaCategory(string $category): string
    {
        return match (strtolower(trim($category))) {
            'business', 'productivity' => 'BusinessApplication',
            'games' => 'GameApplication',
            'education', 'simulations' => 'EducationalApplication',
            'creative' => 'MultimediaApplication',
            'ai', 'experiments', 'demos' => 'DeveloperApplication',
            'tools', 'other', '' => 'UtilitiesApplication',
            default => 'UtilitiesApplication',
        };
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
            'applicationCategory' => self::schemaCategory((string) ($row['category'] ?? '')),
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
     * Build `WebPage` JSON-LD for a page of a multi-page SoftN hosted website.
     *
     * @param array<string, mixed> $row
     */
    private static function webPageJsonLd(
        array $row,
        string $slug,
        string $pageTitle,
        string $desc,
        ?string $pageUrl,
        ?string $image,
        ?string $origin
    ): string {
        $siteName = (string) ($row['name'] ?? $slug);
        $siteObj = [
            '@type' => 'WebSite',
            'name' => $siteName,
        ];
        if ($origin !== null) $siteObj['url'] = "$origin/play/$slug";
        $ld = [
            '@context' => 'https://schema.org',
            '@type' => 'WebPage',
            'name' => $pageTitle,
            'description' => $desc,
            'isPartOf' => $siteObj,
        ];
        if ($pageUrl !== null) $ld['url'] = $pageUrl;
        if ($image !== null) $ld['primaryImageOfPage'] = $image;
        $updatedAt = (int) ($row['updated_at'] ?? 0);
        if ($updatedAt > 0) $ld['dateModified'] = gmdate('c', $updatedAt);
        $encoded = json_encode($ld, JSON_HEX_TAG | JSON_HEX_AMP | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        return is_string($encoded) ? $encoded : '';
    }

    /**
     * Build `BreadcrumbList` JSON-LD for a multi-page hosted website under `/play/<slug>`.
     *
     * @param array<string, mixed> $row
     */
    private static function playBreadcrumbJsonLd(
        ?string $origin,
        array $row,
        string $slug,
        ?string $subPageTitle,
        ?string $subPageUrl
    ): string {
        if ($origin === null) return '';
        $items = [
            ['@type' => 'ListItem', 'position' => 1, 'name' => 'SoftN', 'item' => "$origin/"],
            ['@type' => 'ListItem', 'position' => 2, 'name' => 'Apps', 'item' => "$origin/apps"],
            ['@type' => 'ListItem', 'position' => 3, 'name' => (string) ($row['name'] ?? $slug), 'item' => "$origin/play/$slug"],
        ];
        if ($subPageTitle !== null && $subPageTitle !== '' && $subPageUrl !== null) {
            $items[] = [
                '@type' => 'ListItem',
                'position' => 4,
                'name' => $subPageTitle,
                'item' => $subPageUrl,
            ];
        }
        $encoded = json_encode([
            '@context' => 'https://schema.org',
            '@type' => 'BreadcrumbList',
            'itemListElement' => $items,
        ], JSON_HEX_TAG | JSON_HEX_AMP | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        return is_string($encoded) ? $encoded : '';
    }

    /**
     * Semantic View-Source SSR HTML for `/play/<slug>` and `/play/<slug>/<subpath>`.
     *
     * @param array<string, mixed> $row
     * @param array<int, string> $publicPages
     */
    private static function renderPlayBody(
        string $slug,
        array $row,
        string $pageTitle,
        string $desc,
        string $previewHtml,
        string $virtualPath = '/',
        array $publicPages = []
    ): string {
        $e = fn(string $s): string => htmlspecialchars($s, ENT_QUOTES | ENT_HTML5, 'UTF-8');
        $name = (string) $row['name'];
        $lines = [
            '    <main id="softn-ssr-view" class="softn-ssr" data-softn-ssr="play" data-softn-page="' . $e($virtualPath) . '">',
            '      <article>',
            '        <h1>' . $e($pageTitle) . '</h1>',
            '        <p>' . $e($desc) . '</p>',
        ];
        if ($previewHtml !== '') {
            $indented = implode("\n", array_map(static fn(string $l): string => '          ' . $l, explode("\n", $previewHtml)));
            $lines[] = '        <section data-softn-preview="rendered" aria-label="Rendered application preview">';
            $lines[] = $indented;
            $lines[] = '        </section>';
        }
        if (count($publicPages) > 1) {
            $pageLinks = [];
            foreach ($publicPages as $p) {
                $href = $p === '' ? "/play/$slug" : "/play/$slug/$p";
                $label = $p === '' ? 'Home' : $p;
                $pageLinks[] = '<a href="' . $e($href) . '">' . $e($label) . '</a>';
            }
            $lines[] = '        <nav aria-label="Site pages">' . implode(' · ', $pageLinks) . '</nav>';
        }
        $lines[] = '        <p><a href="' . $e("/app/$slug") . '">About ' . $e($name) . '</a></p>';
        $lines[] = '      </article>';
        $lines[] = '    </main>';
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
            if (trim($inm) === '*') {
                return Response::notModified($headers);
            }
            if (preg_match_all('/"[^"]*"/', $inm, $m) > 0) {
                foreach ($m[0] as $cand) {
                    $norm = preg_replace('/-(?:gzip|br|zstd|deflate)"$/i', '"', $cand) ?? $cand;
                    if ($cand === $etag || $norm === $etag) {
                        return Response::notModified($headers);
                    }
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
