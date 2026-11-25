<?php
/**
 * The catalogue: publishing, versions, remixes, the listing and its search,
 * categories, thumbnails.
 *
 * Every published app is a JSON document beside its version files.
 * Publishing hands back an edit key; a new version, a metadata change or a
 * thumbnail needs it, and nothing else does. A remix is a new app that
 * remembers where it came from — that lineage is a first-class fact here,
 * because the point of a directory of sandboxed apps is that anyone can take
 * one apart and put it back together differently.
 */
declare(strict_types=1);

final class Apps
{
    private const SORTS = ['trending', 'newest', 'top', 'remixed', 'runs', 'name'];

    /**
     * A copy of `$from` in `$dir` under a name discovery passes over (a dot
     * file, not `*.softn`), for the caller to rename into place or delete.
     */
    private static function stageBundle(string $from, string $dir): string {
        $tmp=tempnam($dir,'.upload-');
        if($tmp===false)throw new ApiError(503,'Cannot stage bundle.');
        try { if(!copy($from,$tmp))throw new ApiError(503,'Cannot store bundle.'); }
        catch (Throwable $e) { @unlink($tmp); throw $e; }
        return $tmp;
    }

    private static function copyBundle(string $from, string $to): void {
        $tmp=self::stageBundle($from,dirname($to));
        try { if(!rename($tmp,$to))throw new ApiError(503,'Cannot store bundle.'); }
        finally { if(is_file($tmp))@unlink($tmp); }
    }

    // ── Slugs ──────────────────────────────────────────────────────────────

    /** The slug for a name; `app` when the name has nothing a slug can hold. */
    public static function slugify(string $name): string
    {
        $s = self::slugOf($name);
        return $s === '' ? 'app' : $s;
    }

    /**
     * The slug a name spells, or '' when it spells none (an empty name, or
     * one with no ASCII letters or digits). `slugify` answers `app` for
     * those, which is right for naming a new app and wrong for looking one
     * up: every such name then meant whatever held the id `app`. One visitor
     * suggesting a category called "App" was thereafter the category of
     * every app published with none, and any address in another script was
     * the app whose slug is `app`.
     */
    public static function slugOf(string $name): string
    {
        $s = strtolower(trim($name));
        if (function_exists('iconv')) {
            $t = @iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $s);
            if (is_string($t) && $t !== '') $s = $t;
        }
        $s = preg_replace('/[^a-z0-9]+/', '-', $s) ?? '';
        return substr(trim($s, '-'), 0, 48);
    }

    /**
     * A slug no app has, or had: a retired one is never handed out again
     * (Catalog::retiredSlugs says why), except to the seeded demo that had it.
     */
    private static function uniqueSlug(string $base, bool $seed = false): string {
        $rows = Catalog::all(); $retired = Catalog::retiredSlugs(); $slug=$base;
        $free = static fn(string $s): bool => !isset($rows[$s]) && !Catalog::hasFolder($s)
            && (!isset($retired[$s]) || ($seed && ($retired[$s]['seed'] ?? false) === true));
        for ($n=2;$n<1000;$n++) { if ($free($slug)) return $slug; $slug=substr($base,0,44).'-'.$n; }
        // Past a thousand of one name (every name with no Latin letter in it is
        // `app`), an ending of its own: the thousandth such app could not be published.
        for ($i=0;$i<20;$i++) { $slug=substr($base,0,40).'-'.bin2hex(random_bytes(3)); if ($free($slug)) return $slug; }
        throw new ApiError(500,'Could not find a free name for the app.');
    }

    /** A slug as a visitor typed it into a URL: the manifest name works too. */
    /**
     * The slug an address names: as given, or as the slug its spelling
     * makes. Never an app's name: names are not unique and are the
     * publisher's to choose, so a name match would let one app answer for
     * another's address until that slug was taken. `resolveParent` is the
     * one place a name is accepted, for the `parent` field at publish.
     */
    public static function resolveSlug(string $given): string {
        $given=trim($given); $rows=Catalog::all();
        foreach ([$given,self::slugOf($given)] as $slug) if ($slug!=='' && isset($rows[$slug])) return $slug;
        throw new ApiError(404,'No app is published under that name.');
    }

    /** The app a publish names as its parent: a slug, or a name exactly one visible app has. */
    public static function resolveParent(string $given): string {
        try { return self::resolveSlug($given); } catch (ApiError) { /* not a slug; a name, perhaps */ }
        $given=mb_strtolower(trim($given)); $matches=[];
        // As text: PHP hands back a key that is all digits (the slug of an app called "2048") as a number.
        foreach (Catalog::all() as $slug=>$r) if (!$r['hidden'] && mb_strtolower($r['name'])===$given) $matches[]=(string)$slug;
        if (count($matches)===1) return $matches[0];
        if (count($matches)>1) throw new ApiError(404,'More than one app is published under that name; name the parent by its slug.');
        throw new ApiError(404,'No app is published under that name.');
    }

    // ── Rows ───────────────────────────────────────────────────────────────

    /** @return array<string, mixed> */
    public static function row(string $slug, bool $includeHidden = false): array {
        $row=Catalog::all()[$slug]??null;
        if (!$row || (!$includeHidden && $row['hidden'])) throw new ApiError(404,'No app is published under that name.');
        return $row;
    }

    public static function dir(string $slug): string
    {
        $dir = Catalog::path($slug);
        if (!is_dir($dir) && !@mkdir($dir, 0775, true)) throw new ApiError(500, 'Could not create the app\'s directory.');
        return $dir;
    }

    /** @return array<string, mixed> */
    public static function version(string $slug, ?int $version = null): array {
        $rows=Catalog::doc($slug)['versions']; usort($rows,fn($a,$b)=>$b['version']<=>$a['version']);
        foreach ($rows as $row) if ($version===null || (int)$row['version']===$version) return $row;
        throw new ApiError(404,'That version does not exist.');
    }

    /** The address a linked app plays at, or null for an app whose bundle is here. */
    public static function playUrl(array $row): ?string {
        $url = $row['play_url'] ?? null;
        return is_string($url) && $url !== '' ? $url : null;
    }

    /** The routes that hand out or take in bundle bytes have nothing for a linked app. */
    public static function requireBundle(string $slug): array {
        $row = self::row($slug);
        if (self::playUrl($row) !== null) throw new ApiError(404, 'This app plays on its own site; there is no bundle here to run, download, read or remix.');
        return $row;
    }

    /**
     * Whether the site owner has vouched for the app: `"trusted": true` in
     * the `app` object of its `app.json`, beside its versions. The catalogue
     * carries the field like any other, and no route sets it — publishing,
     * patching and remixing never write it — so the only way it gets there is
     * someone with access to the server putting it there. A trusted app's
     * play page runs it with every capability its permission.json declares
     * already granted, and shows no permission bar.
     *
     * `true` and nothing else: "yes", 1 and "true" are not the operator
     * saying so, they are a typo, and a typo must fail closed.
     *
     * @param array<string, mixed> $row
     */
    public static function isTrusted(array $row): bool
    {
        return ($row['trusted'] ?? false) === true;
    }

    /**
     * How this app is hosted and executed:
     * - `browser`: downloaded as a `.softn` bundle and executed completely inside the user's browser sandbox.
     * - `server`: hosted on SoftN (or a custom backend URL) with server-side execution strictly inside ZIPP `safe-sandbox`.
     * - `hybrid`: hosted on SoftN by default, AND visitors can choose to run locally in their browser sandbox (`?mode=local`).
     *
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    public static function hostingInfo(array $row): array
    {
        $slug = (string) $row['slug'];
        $playUrl = self::playUrl($row);
        $rawMode = $row['hosting'] ?? 'browser';
        $mode = is_string($rawMode) && in_array($rawMode, ['browser', 'server', 'hybrid'], true) ? $rawMode : 'browser';
        $backendRuntime = is_string($row['backend_runtime'] ?? null) && $row['backend_runtime'] !== '' ? $row['backend_runtime'] : null;
        $hasBackend = $backendRuntime !== null;
        $customUrl = is_string($row['backend_url'] ?? null) && $row['backend_url'] !== '' ? $row['backend_url'] : null;
        $serverEnabled = Config::get('allowServerHosting', true) === true;
        $serverHosted = $playUrl === null && ($mode === 'server' || $mode === 'hybrid') && ($customUrl !== null || ($hasBackend && $serverEnabled));
        $backendUrl = $serverHosted ? ($customUrl ?? "/api/apps/$slug/backend") : null;
        // Fail closed: withhold_backend on a server-hosted app stays enforced even if
        // allowServerHosting is later turned off, so withheld backend source never leaks.
        $withholdBackend = $playUrl === null && $mode === 'server' && (bool) ($row['withhold_backend'] ?? false);
        $browserSupported = $playUrl === null && !$withholdBackend && ($mode === 'browser' || $mode === 'hybrid' || !$serverHosted);
        return [
            'mode' => $serverHosted ? $mode : 'browser',
            'serverHosted' => $serverHosted,
            'browserSupported' => $browserSupported,
            'backendUrl' => $backendUrl,
            'customBackendUrl' => $customUrl,
            'withholdBackend' => $withholdBackend,
            'sandbox' => $serverHosted && $customUrl === null ? 'zipp-safe-sandbox' : ($hasBackend ? 'browser-wasm-sandbox' : null),
        ];
    }

    private static function parseHosting(mixed $value, bool $hasBackend, ?string $customUrl, bool $byAdmin = false): string
    {
        if ($value === null || $value === '') return 'browser';
        if (!is_string($value)) throw new ApiError(400, 'hosting must be browser, server, or hybrid.');
        $mode = strtolower(trim($value));
        if (!Catalog::validHosting($mode)) throw new ApiError(400, 'hosting must be browser, server, or hybrid.');
        if ($mode === 'server' || $mode === 'hybrid') {
            if (!$byAdmin && Config::get('allowPublicServerHosting', false) !== true) {
                throw new ApiError(
                    403,
                    'Server-hosted publishing is disabled on this SoftN directory. Published apps always run locally in the visitor\'s browser sandbox; the site owner can enable server hosting per app in app.json or set allowPublicServerHosting to true in data/config.json.'
                );
            }
            if ($customUrl === null && Config::get('allowServerHosting', true) !== true) {
                throw new ApiError(403, 'Server-hosted backends are disabled on this SoftN directory.');
            }
            if (!$hasBackend && $customUrl === null) {
                throw new ApiError(400, 'Server or hybrid hosting requires a bundle with a manifest backend or a custom backendUrl.');
            }
        }
        return $mode;
    }

    private static function parseBackendUrl(mixed $value, bool $byAdmin = false): ?string
    {
        if ($value === null || $value === '') return null;
        if (!is_string($value)) throw new ApiError(400, 'backendUrl must be text.');
        $url = trim($value);
        if ($url === '') return null;
        if (!Catalog::validBackendUrl($url)) {
            throw new ApiError(400, 'backendUrl must be a same-origin path (/...) or an http(s) URL of at most 300 characters.');
        }
        // Prevent non-admin publishers from pointing their play page's credentialed
        // RemoteBackendTransport at another app's backend or directory API routes
        // (via either relative `/...` paths or absolute URLs targeting this site's origin).
        if (!$byAdmin) {
            if (str_starts_with($url, '/')) {
                throw new ApiError(403, 'Only the site owner may set a custom same-origin backendUrl path.');
            }
            $parsedUrl = parse_url($url);
            if (!is_array($parsedUrl) || !isset($parsedUrl['scheme'], $parsedUrl['host'])) {
                throw new ApiError(400, 'backendUrl must be a valid http(s) URL.');
            }
            $normOrigin = static function (array $p): string {
                $scheme = strtolower((string) $p['scheme']);
                $host = strtolower(rtrim((string) $p['host'], '.'));
                $port = isset($p['port']) ? (int) $p['port'] : ($scheme === 'https' ? 443 : 80);
                return "$scheme://$host:$port";
            };
            $targetOrigin = $normOrigin($parsedUrl);
            $selfOrigins = [];
            $siteOrigin = Pages::origin();
            if ($siteOrigin !== null) $selfOrigins[] = $siteOrigin;
            foreach (['HTTP_ORIGIN', 'HTTP_HOST'] as $hdr) {
                $raw = $_SERVER[$hdr] ?? '';
                if (!is_string($raw) || trim($raw) === '') continue;
                if ($hdr === 'HTTP_HOST') {
                    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
                    $selfOrigins[] = $scheme . '://' . trim($raw);
                } else {
                    $selfOrigins[] = trim($raw);
                }
            }
            foreach (Config::allowedOrigins() as $allowed) {
                if (is_string($allowed) && trim($allowed) !== '') $selfOrigins[] = trim($allowed);
            }
            foreach ($selfOrigins as $candidate) {
                $parsedSelf = parse_url($candidate);
                if (is_array($parsedSelf) && isset($parsedSelf['scheme'], $parsedSelf['host']) && $normOrigin($parsedSelf) === $targetOrigin) {
                    throw new ApiError(403, 'Only the site owner may set a custom same-origin backendUrl.');
                }
            }
        }
        return $url;
    }

    private static function parseBoolFlag(mixed $value): int
    {
        if (is_bool($value)) return $value ? 1 : 0;
        if (is_int($value)) return $value !== 0 ? 1 : 0;
        if (is_string($value)) {
            $v = strtolower(trim($value));
            return in_array($v, ['1', 'true', 'yes', 'on'], true) ? 1 : 0;
        }
        return 0;
    }

    // ── Presentation ───────────────────────────────────────────────────────

    /**
     * @param array<string, mixed> $row
     * @param array<string, array<string, mixed>>|null $rows the catalogue by slug, when the caller
     *   already has it (a listing hands the same map to every card); Catalog::all() otherwise
     * @return array<string, mixed>
     */
    public static function card(array $row, ?array $rows = null): array
    {
        $slug = (string) $row['slug'];
        $bundle = "/api/apps/$slug/bundle.softn";
        $playUrl = self::playUrl($row);
        $external = $playUrl === null ? null : ['url' => $playUrl, 'host' => (string) (parse_url($playUrl, PHP_URL_HOST) ?: '')];
        $hosting = self::hostingInfo($row);
        $backendRuntime = is_string($row['backend_runtime'] ?? null) && $row['backend_runtime'] !== '' ? $row['backend_runtime'] : null;
        $count = (int) $row['rating_count'];
        $parent = null;
        // Any slug, `0` included, which `empty` takes for none. And only a
        // parent a visitor can open: one its owner unpublished was still
        // named here, on every remix of it.
        if (is_string($row['parent_slug'] ?? null) && $row['parent_slug'] !== '') {
            $pr = ($rows ?? Catalog::all())[$row['parent_slug']] ?? null;
            if ($pr && !$pr['hidden']) $parent = ['slug' => $pr['slug'], 'name' => $pr['name']];
        }
        $cat = (string) $row['category'];
        $sub = is_string($row['subcategory'] ?? null) && $row['subcategory'] !== '' ? $row['subcategory'] : null;
        return [
            'slug' => $slug,
            'name' => (string) $row['name'],
            'description' => (string) $row['description'],
            'author' => (string) $row['author'],
            'category' => $cat,
            'subcategory' => $sub,
            'categoryPath' => $sub !== null ? "$cat/$sub" : $cat,
            'tags' => json_decode((string) $row['tags'], true) ?: [],
            'capabilities' => json_decode((string) $row['capabilities'], true) ?: [],
            // By collection name; `*` is the default for the rest. Always an
            // object on the wire, so a page can index it without checking.
            'storagePolicies' => (object) Storage::policiesOf($row),
            'execution' => (string) $row['execution'],
            'engine' => (int) ($row['engine'] ?? 1),
            'backendRuntime' => $backendRuntime,
            'hosting' => $hosting,
            // The operator's word, from the app's app.json: the play page
            // runs a trusted app with its declared access granted, no bar.
            'trusted' => self::isTrusted($row),
            'version' => (int) $row['latest_version'],
            'size' => (int) $row['size'],
            'primary' => $row['primary_color'] ?: null,
            // Versioned by the last update, so a replaced picture is never the
            // cached one: the images are served with a ten-minute max-age.
            'thumbnail' => "/api/apps/$slug/thumbnail?v=" . (int) $row['updated_at'],
            'thumbnailKind' => $row['thumb'] ? 'image' : ($row['icon'] ? 'icon' : 'placeholder'),
            'icon' => $row['icon'] ? "/api/apps/$slug/icon?v=" . (int) $row['updated_at'] : null,
            'runs' => (int) $row['runs'],
            // Presses of Play on the directory, which need not become runs:
            // a bundle that failed to open counts here and not there.
            'launches' => (int) ($row['launches'] ?? 0),
            'remixes' => (int) $row['remixes'],
            'rating' => ['average' => $count > 0 ? round((int) $row['rating_sum'] / $count, 2) : 0, 'count' => $count],
            'comments' => (int) $row['comments'],
            'parent' => $parent,
            'source' => (string) $row['source'],
            // Set when the app lives on its own site: Play opens this address in
            // a new tab, and the bundle URLs below are null because there is none.
            'external' => $external,
            'createdAt' => gmdate('c', (int) $row['created_at']),
            'updatedAt' => gmdate('c', (int) $row['updated_at']),
            'urls' => [
                'page' => "/app/$slug",
                // Where the app plays: its own page in the single-app shell,
                // served by this API with the bundle's location, version and
                // digest written into the document — or, for a linked app,
                // the address of its own site. The full runtime, with its
                // launcher and tabs, is still reachable as `runtime`.
                'run' => $playUrl ?? "/play/$slug",
                'play' => $external ? null : "/play/$slug",
                'playLocal' => $external || !$hosting['browserSupported'] ? null : ($hosting['serverHosted'] ? "/play/$slug?mode=local" : "/play/$slug"),
                'runtime' => $external ? null : "/web/app/$slug",
                'runtimeLocal' => $external || !$hosting['browserSupported'] ? null : ($hosting['serverHosted'] ? "/web/app/$slug?mode=local" : "/web/app/$slug"),
                'backend' => $hosting['backendUrl'],
                'bundle' => $external ? null : $bundle,
                'download' => $external ? null : ($hosting['withholdBackend'] ? "$bundle?client=1&download=1" : "$bundle?download=1"),
                'studio' => $external ? null : '/studio/?open=' . rawurlencode($bundle),
                'builder' => $external ? null : '/builder/?open=' . rawurlencode($bundle),
                'remix' => $external ? null : "/publish?remix=$slug",
            ],
        ];
    }

    /** @param array<string, mixed> $row @return array<string, mixed> */
    public static function detail(array $row, bool $withStorage = true): array
    {
        $slug = (string) $row['slug'];
        $doc=Catalog::doc($slug);
        $rows=Catalog::all();
        $card = self::card($row, $rows);
        $versions = [];
        usort($doc['versions'],fn($a,$b)=>$b['version']<=>$a['version']);
        foreach ($doc['versions'] as $r) {
            $versions[] = [
                'version' => (int) $r['version'],
                'manifestVersion' => (string) $r['manifest_version'],
                'size' => (int) $r['size'],
                'sha256' => (string) $r['sha256'],
                'notes' => (string) $r['notes'],
                'createdAt' => gmdate('c', (int) $r['created_at']),
                // The address the play page uses: the digest makes it one content's, so it may be cached.
                'bundle' => "/api/apps/$slug/bundle.softn?v=" . (int) $r['version'] . '&sha256=' . $r['sha256'],
            ];
        }
        $breakdown = [1=>0,2=>0,3=>0,4=>0,5=>0];
        foreach ($doc['ratings'] as $r) $breakdown[(int)$r['stars']]++;
        $hiddenRemixes=json_decode((string)($row['hidden_remixes']??'[]'),true)?:[];
        $kids=array_values(array_filter($rows,fn($r)=>$r['parent_slug']===$slug && !$r['hidden'] && !in_array($r['slug'],$hiddenRemixes,true)));
        usort($kids,fn($a,$b)=>$b['created_at']<=>$a['created_at']);
        $remixes=[];
        foreach (array_slice($kids,0,12) as $r) $remixes[]=['slug'=>$r['slug'],'name'=>$r['name'],'author'=>$r['author'],'createdAt'=>gmdate('c',(int)$r['created_at'])];
        $lineage = [];
        $cur = $row['parent_slug'] ?? null;
        $hops = 0;
        while (is_string($cur) && $cur !== '' && $hops++ < 8) {
            $pr = $rows[$cur] ?? null;
            if (!$pr) break;
            // An ancestor nobody can open is passed over, not named; what it
            // came from is still part of this app's line.
            if (!$pr['hidden']) $lineage[] = ['slug' => $pr['slug'], 'name' => $pr['name'], 'author' => $pr['author']];
            $cur = $pr['parent_slug'];
        }
        $card['versions'] = $versions;
        $card['ratingBreakdown'] = $breakdown;
        $card['remixList'] = $remixes;
        // The remixes the owner took off this page, so the owner can put them back.
        $card['hiddenRemixes'] = array_values($hiddenRemixes);
        $card['lineage'] = $lineage;
        // An app's page is not its storage: a store that will not open
        // (see Db::open) is reported here as unavailable rather than taking
        // the app's detail, and the page built on it, down with it. The page
        // route reads it after the catalogue is let go and passes false.
        if (!$withStorage) {
            $card['storage'] = null;
        } else {
            try {
                $card['storage'] = Storage::summary($slug);
            } catch (ApiError | PDOException $e) {
                error_log("softn-api: the storage of $slug could not be summarised: " . $e->getMessage());
                $card['storage'] = ['collections' => 0, 'records' => 0, 'keys' => 0, 'bytes' => 0, 'diskBytes' => 0, 'unavailable' => true];
            }
        }
        $card['manifest'] = $card['external'] ? null : self::manifestSummary($slug, (int) $row['latest_version']);
        return $card;
    }

    /** The parts of the manifest worth showing: entry file and the file counts by kind. */
    private static function manifestSummary(string $slug, int $version): ?array
    {
        try {
            $ver = self::version($slug, $version);
            $zip = new ZipArchive();
            if ($zip->open(self::dir($slug) . '/' . $ver['file'], ZipArchive::RDONLY) !== true) return null;
            // Where the bundle keeps it: at the top, or in the folder the bundle was zipped as.
            $name = Bundle::manifestName($zip);
            $text = $name === null ? false : $zip->getFromName($name, Bundle::MAX_MANIFEST_BYTES);
            $zip->close();
            $m = is_string($text) ? json_decode(Bundle::jsonText($text), true) : null;
            if (!is_array($m)) return null;
            $files = is_array($m['files'] ?? null) ? $m['files'] : [];
            $counts = [];
            foreach ($files as $kind => $list) {
                if (is_array($list)) $counts[(string) $kind] = count($list);
            }
            return [
                'main' => is_string($m['main'] ?? null) ? $m['main'] : null,
                'version' => is_string($m['version'] ?? null) ? $m['version'] : null,
                'files' => $counts,
            ];
        } catch (Throwable) {
            return null;
        }
    }

    // ── Listing ────────────────────────────────────────────────────────────

    /** @param array<string, string> $q @return array<string, mixed> */
    public static function list(array $q): array {
        $search=Text::clean($q['q']??'',80);$rawCategory=Text::clean($q['category']??'',80);$rawSub=Text::clean($q['subcategory']??'',40);$tag=strtolower(Text::clean($q['tag']??'',24));$author=Text::clean($q['author']??'',40);$cap=Text::clean($q['cap']??'',16);$hostingFilter=strtolower(Text::clean($q['hosting']??'',16));
        $category = $rawCategory;
        $subcategory = $rawSub;
        $legacyCategory = null;
        if ($category !== '' && $category !== 'all') {
            if (str_contains($category, '/')) {
                [$cPart, $sPart] = explode('/', $category, 2);
                $category = trim($cPart);
                if ($subcategory === '' && trim($sPart) !== '') $subcategory = trim($sPart);
            } elseif ($subcategory === '' && ($alias = Categories::legacyAlias($category)) !== null) {
                $legacyCategory = strtolower($category);
                [$category, $subcategory] = $alias;
            }
        }
        if ($subcategory === 'all') $subcategory = '';
        $sort=in_array($q['sort']??'',self::SORTS,true)?$q['sort']:($search!==''?'relevance':'trending');
        $perPage=max(1,min(48,(int)($q['perPage']??24)));$page=max(1,min(500,(int)($q['page']??1)));
        $rows=[];$since=time()-7*86400;$all=Catalog::all();
        foreach ($all as $r) {
            if ($r['hidden']) continue;
            $rCat = (string) $r['category'];
            $rSub = is_string($r['subcategory'] ?? null) && $r['subcategory'] !== '' ? $r['subcategory'] : '';
            if ($category !== '' && $category !== 'all') {
                if ($legacyCategory !== null) {
                    $matchesLegacy = ($rCat === $legacyCategory) || ($rCat === $category && $rSub === $subcategory);
                    if (!$matchesLegacy) continue;
                } else {
                    if ($rCat !== $category) continue;
                    if ($subcategory !== '' && $rSub !== $subcategory) continue;
                }
            } elseif ($subcategory !== '' && $rSub !== $subcategory) {
                continue;
            }
            $tags=json_decode($r['tags'],true)?:[];$caps=json_decode($r['capabilities'],true)?:[];
            if ($tag!=='' && !in_array($tag,$tags,true)) continue;
            if ($author!=='' && mb_strtolower($r['author'])!==mb_strtolower($author)) continue;
            $hasBackend = is_string($r['backend_runtime'] ?? null) && $r['backend_runtime'] !== '';
            if (($cap==='none' && $caps) || ($cap==='nonet' && in_array('net',$caps,true)) || ($cap==='storage' && !in_array('storage',$caps,true)) || ($cap==='worker' && $r['execution']!=='worker') || ($cap==='backend' && !$hasBackend)) continue;
            if ($hostingFilter !== '') {
                $h = self::hostingInfo($r);
                if ($hostingFilter === 'browser' && !$h['browserSupported']) continue;
                if ($hostingFilter === 'server' && !$h['serverHosted']) continue;
                if ($hostingFilter === 'hybrid' && $h['mode'] !== 'hybrid') continue;
                if ($hostingFilter === 'backend' && !$hasBackend) continue;
            }
            $text=mb_strtolower($r['name'].' '.$r['description'].' '.implode(' ',$tags).' '.$r['author']);
            $words=preg_split('/\s+/u',trim(mb_strtolower($search)))?:[];
            if ($search!=='' && array_filter($words,fn($w)=>!str_contains($text,$w))) continue;
            $r['_relevance']=$search!=='' && str_contains(mb_strtolower($r['name']),mb_strtolower($search))?1:0;
            $daily=Catalog::doc($r['slug'])['runsDaily'];$runs7=0;
            // Visitors, as one client can open an app 120 times a minute. A day
            // kept before they were counted apart counted each one once.
            foreach ($daily as $d) if ($d['day']>=floor($since/86400)) $runs7+=$d['visitors']??$d['count'];
            $r['_trend']=$runs7*3+$r['remixes']*5+$r['rating_count']*2+$r['comments']+($r['created_at']>$since?4:0);
            $r['_average']=$r['rating_count']?$r['rating_sum']/$r['rating_count']:0;
            $rows[]=$r;
        }
        usort($rows,function($a,$b) use($sort) {
            if ($sort==='name') return strcasecmp($a['name'],$b['name']) ?: strcmp($a['slug'],$b['slug']);
            $keys=match($sort){'newest'=>['created_at'],'top'=>['_average','rating_count','runs'],'remixed'=>['remixes','runs'],'runs'=>['runs'],'relevance'=>['_relevance','runs'],default=>['_trend','runs','created_at']};
            foreach($keys as $k) if($a[$k]!=$b[$k])return $b[$k]<=>$a[$k];
            return strcmp($a['slug'],$b['slug']);
        });
        $total=count($rows);
        return ['apps'=>array_map(fn($r)=>self::card($r,$all),array_slice($rows,($page-1)*$perPage,$perPage)),'page'=>$page,'perPage'=>$perPage,'total'=>$total,'pages'=>max(1,(int)ceil($total/$perPage)),'sort'=>$sort,'query'=>$search,'category'=>$category,'subcategory'=>$subcategory];
    }

    // ── Publishing ─────────────────────────────────────────────────────────

    /**
     * Publish a bundle as a new app. `$opts` are the visitor's fields; the
     * bundle's own manifest fills whatever they left out. `$info` is what
     * Bundle::inspect said of the bundle, when the caller asked it before
     * taking the catalogue (a route that has to find a parent first): the
     * check reads every file in the bundle, and is not done under the lock.
     *
     * @param array<string, mixed> $opts
     * @param array<string, mixed>|null $info
     * @return array{app: array<string, mixed>, editKey: string|null}
     */
    public static function create(string $bundlePath, array $opts, string $source = 'upload', ?string $parentSlug = null, ?array $info = null, bool $byAdmin = false): array
    {
        $info ??= Bundle::inspect($bundlePath);
        $name = Text::clean($opts['name'] ?? '', 64) ?: $info['name'];
        $description = Text::clean($opts['description'] ?? '', 600, true) ?: $info['description'];
        $author = Text::clean($opts['author'] ?? '', 40) ?: (self::authorFromManifest($info['manifest']) ?? 'Anonymous');
        [$category, $subcategory] = Categories::resolvePair(
            Text::clean($opts['category'] ?? '', 80),
            Text::clean($opts['subcategory'] ?? '', 40)
        );
        $tags = Text::tags($opts['tags'] ?? null);
        $notes = Text::clean($opts['notes'] ?? '', 400, true);
        $primary = self::color($opts['primary'] ?? null) ?? self::color($info['manifest']['config']['theme']['primary'] ?? null);
        $backendRuntime = is_string($info['backendRuntime'] ?? null) && $info['backendRuntime'] !== '' ? $info['backendRuntime'] : null;
        $allowPublicHosting = $byAdmin || $source === 'seed' || Config::get('allowPublicServerHosting', false) === true;
        $backendUrl = $allowPublicHosting ? self::parseBackendUrl($opts['backendUrl'] ?? $opts['backend_url'] ?? null, $byAdmin || $source === 'seed') : null;
        if (!$allowPublicHosting && (($opts['backendUrl'] ?? $opts['backend_url'] ?? null) !== null && trim((string) ($opts['backendUrl'] ?? $opts['backend_url'])) !== '')) {
            throw new ApiError(403, 'Server-hosted publishing is disabled on this SoftN directory.');
        }
        $hosting = self::parseHosting($opts['hosting'] ?? null, $backendRuntime !== null, $backendUrl, $allowPublicHosting);
        $withholdBackend = $hosting === 'server' ? self::parseBoolFlag($opts['withholdBackend'] ?? $opts['withhold_backend'] ?? 0) : 0;

        Catalog::boot();
        self::refuseKeysOf($info, 'bundle');
        // A seed names its own slug: the id the site already uses for that demo.
        $wanted = is_string($opts['slug'] ?? null) && $opts['slug'] !== '' ? self::slugify($opts['slug']) : self::slugify($name);
        $slug = self::uniqueSlug($wanted, $source === 'seed');
        // Everything that can refuse is settled before the folder exists: a
        // parent that is hidden is a 404 here, not after the bundle is on disk.
        $rootSlug = null;
        if ($parentSlug !== null) {
            // One with a bundle: a linked app has nothing to remix, as the remix route says.
            $parent = self::requireBundle($parentSlug);
            $rootSlug = is_string($parent['root_slug']) && $parent['root_slug'] !== '' ? $parent['root_slug'] : $parent['slug'];
        }
        $editKey = $source === 'seed' ? null : bin2hex(random_bytes(20));
        Catalog::allocateDir($slug, $category, $subcategory);
        $dir = self::dir($slug);
        $file = 'v1.softn';
        try {
            self::copyBundle($bundlePath, "$dir/$file");
            $icon = self::storeIcon($dir, $info['icon']);
            $now = time();
            $app=array_replace(Catalog::defaults($slug),[
                'name'=>$name,'description'=>$description,'author'=>$author,'category'=>$category,'subcategory'=>$subcategory,'tags'=>json_encode($tags),'parent_slug'=>$parentSlug,'root_slug'=>$rootSlug,
                'capabilities'=>json_encode($info['capabilities']),'execution'=>$info['execution'],'engine'=>(int)($info['engine']??1),'backend_runtime'=>$backendRuntime,'hosting'=>$hosting,'backend_url'=>$backendUrl,'withhold_backend'=>$withholdBackend,'storage_policies'=>json_encode((object)$info['storagePolicies']),
                'icon'=>$icon,'primary_color'=>$primary,'edit_key_hash'=>$editKey===null?null:hash('sha256',$editKey),'source'=>$source,'size'=>$info['size'],'created_at'=>$now,'updated_at'=>$now
            ]);
            // Where the seed filed its demo, so that the sync can tell its own filing from the operator's later one: see Seed::ifEmpty.
            if ($source === 'seed') { $app['seed_category'] = $category; $app['seed_subcategory'] = $subcategory; }
            Catalog::put($slug,['app'=>$app,'versions'=>[['slug'=>$slug,'version'=>1,'file'=>$file,'size'=>$info['size'],'sha256'=>$info['sha256'],'manifest_version'=>$info['version'],'notes'=>$notes,'created_at'=>$now]],'comments'=>[],'ratings'=>[],'runsDaily'=>[]]);
            if (Catalog::usesCategorizedLayout($category, $subcategory)) Catalog::syncCategoryCaches();
        } catch (Throwable $e) {
            // A folder with a bundle and no app.json is discovered on the
            // next request as an app of its own, with no edit key — the
            // admin's. Retire what was written the way an unpublish does.
            try { Catalog::retire($slug); } catch (Throwable $retire) { error_log("softn-api: could not retire the half-published $slug: " . $retire->getMessage()); }
            throw $e;
        }
        // A demo the seeder retired and has filed again has its slug back. Left
        // listed as retired, the slug is still held by the app, so a failure
        // here is logged rather than unpublishing the demo.
        if ($source === 'seed') {
            try { Catalog::reclaimSlug($slug); } catch (Throwable $e) { error_log("softn-api: $slug is published again but still listed as retired: " . $e->getMessage()); }
        }
        return ['app' => self::card(self::row($slug)), 'editKey' => $editKey];
    }

    /**
     * A collection's storage policy is fixed when the app is published, and
     * a publisher's next version does not get to change it.
     *
     * The policy in force is read from the app's current row, and a new
     * version replaced that row's declaration with its own. So an app
     * published with `notes: private` — "nobody else reads them, the
     * publisher included" — could be given a version declaring `notes:
     * public`, and every visitor's private records were readable by anyone
     * from that upload on; the same move turned `append-only` and
     * `owner-write` into `public`. The comparison is of what each collection
     * comes to, named or through `*`, so re-spelling the same rules is not a
     * change. An app that had no storage made no promise and may add it; the
     * operator may change anything. `$before` is what was promised: see
     * `promisedPolicies`.
     *
     * @param array<string, string> $before
     * @param array<string, mixed> $info
     */
    private static function refuseChangedPolicies(array $before,array $info): void {
        $after=is_array($info['storagePolicies']??null)?$info['storagePolicies']:[];
        $effective=fn(array $policies,string $name):string=>$policies[$name]??$policies['*']??'public';
        $changed=[];
        foreach(array_unique(array_merge(array_keys($before),array_keys($after),['*'])) as $name){
            $name=(string)$name;
            if($effective($before,$name)!==$effective($after,$name))$changed[]=$name==='*'?'every other collection (*)':$name;
        }
        if($changed)throw new ApiError(400,'This version changes the storage policy of '.implode(', ',$changed).'. A collection\'s policy is fixed when the app is published, because people have stored records under it; keep the policies as they are, or publish the change as a new app.');
    }

    /**
     * The policies people have stored records under, which a publisher's
     * next version is held to; null for an app that has never had storage.
     *
     * While the app declares storage, that is its row's declaration. Once a
     * version has switched storage off the row says "no storage", which the
     * check used to read as "made no promise": a version with the same
     * collections and `enabled: false` passed, and the one after it could
     * declare anything over the records still in the store. So what was in
     * force is remembered (`storage_promised`, written by addVersion). An app
     * whose storage was switched off before anything was remembered is known
     * by the records in its store: they were stored under the declaration
     * the app was left with, which is the one that was in force when it was
     * switched off. A store with no record in it is no promise to anyone, and
     * such a file can sit in the folder of an app that never had storage
     * (asking for a listing used to make one), which may still add it. A
     * store that cannot be read is taken to hold records.
     *
     * @param array<string, mixed> $row
     * @return array<string, string>|null
     */
    private static function promisedPolicies(array $row): ?array {
        $caps=json_decode((string)($row['capabilities']??'[]'),true);
        if(is_array($caps)&&in_array('storage',$caps,true))return Storage::policiesOf($row);
        if(is_array($row['storage_promised']??null))return array_filter($row['storage_promised'],fn($policy)=>in_array($policy,Storage::POLICIES,true));
        try{$kept=Storage::summary((string)$row['slug'])['records']>0;}catch(ApiError|PDOException){$kept=true;}
        return $kept?Storage::policiesOf($row):null;
    }

    /**
     * Refuse a bundle that holds the edit key of any app in the directory,
     * this one or another: published, the key is public, and whoever reads
     * it holds that app. A list of keys pasted into a note has nothing else
     * to know it by. `$info` is what Bundle::inspect said of a bundle someone
     * is publishing: among the rest, the SHA-256 of every run in it shaped
     * like a key (`keyLike`), by file, which is what the directory keeps of
     * a key. A bundle the directory reads for itself has none, and passes.
     *
     * Under the catalogue, which is where the hashes are: a lookup for each
     * digest, of which a bundle has at most Secrets::MAX_KEY_LIKE, and one
     * pass over the apps, made only when there is a digest to look up.
     *
     * The refusal names the file and not the key or its app. It does tell
     * whoever sent the bundle that some run in that file is a key of an app
     * here, which they could not learn before without trying the run
     * against each app. A key cannot be guessed, 160 random bits, so that is
     * of use only to someone who holds the key already and does not know
     * what it is: see README, Secrets, which is also where the setting that
     * turns this off is. Digests are compared, never keys, so how long a
     * comparison takes says nothing of a key.
     *
     * @param array<string, mixed> $info
     * @param string $from 'commit' for a push, 'bundle' for an upload: how the refusal is worded
     */
    private static function refuseKeysOf(array $info, string $from): void {
        $found=is_array($info['keyLike']??null)?$info['keyLike']:[];
        // A site that would rather not tell anyone that a string is some app's key: "refuseAppKeys": false.
        if($found===[]||Config::get('refuseAppKeys',true)!==true)return;
        $kept=[];
        foreach(Catalog::all() as $row){$hash=$row['edit_key_hash']??null;if(is_string($hash)&&strlen($hash)===64&&ctype_xdigit($hash))$kept[(string)hex2bin($hash)]=true;}
        if($kept===[])return;
        foreach($found as $path=>$digests){
            for($at=0,$end=strlen((string)$digests);$at<$end;$at+=32){
                if(isset($kept[substr((string)$digests,$at,32)]))throw new ApiError(400,(new SecretFound((string)$path,'other-key'))->words($from));
            }
        }
    }

    /**
     * A new version. The operator's `trusted` goes with the old one unless
     * the operator is the one uploading (`$byAdmin`): trust is their word
     * about the bundle they looked at, and a publisher's next upload — new
     * code, perhaps new capabilities — is not that bundle. Left in place, it
     * ran preapproved on every visitor's machine without anyone having seen
     * it. The operator trusts the new version by setting the key again.
     *
     * The bundle takes its version's name only once app.json records the
     * version. It was copied to vN.softn first and recorded last, so an
     * upload that failed in between (an icon that would not write, a full
     * disk, a killed request) left a file that discovery listed as the
     * latest version, with the operator's trust still on the app: the write
     * that would have removed it was the one that failed. Until the rename
     * the copy is a dot file discovery passes over, and a failure removes it.
     *
     * `$info` is what Bundle::inspect said of the bundle, asked before the
     * catalogue was taken, as for create().
     *
     * `$pushed` is given for a version made by `git push`: the commit it was
     * and that commit's tree. It is kept beside the app (`pushed`, with the
     * version's number and its bundle's digest, so it is known to be of that
     * version and no other), and is how the next push is told that it is not
     * built on this one (GitRemote::publish). A version made any other way
     * takes it away: nothing is known of where its files came from. It is
     * the app's and not the version's because discovery writes a version's
     * record afresh from the bundle on disk, with the fields it knows.
     *
     * @param array<string, mixed>|null $info
     * @param array{commit: string, tree: string}|null $pushed
     * @return array<string, mixed>
     */
    public static function addVersion(string $slug, string $bundlePath, ?string $notes, bool $byAdmin = false, ?array $info = null, ?array $pushed = null): array {
        $row=self::row($slug,true);$info??=Bundle::inspect($bundlePath);$doc=Catalog::doc($slug);$before=$doc;
        self::refuseKeysOf($info,$pushed!==null?'commit':'bundle');
        $next=(int)$row['latest_version']+1;
        // What goes to make room. An app counts its versions and not their numbers, which carry on from the
        // latest, so a limit reached is a window that moves and not the end of the app. Version 1 stays: the
        // seed owns it, and it is where an app started. One goes, however far over the app is: a limit lowered
        // in config.json stops an app growing, and is not a way for its next version to delete dozens. Only a
        // bundle under the name this writes, vN.softn for version N, can go: one the operator put in the folder by
        // hand is theirs, and if it failed to be removed, discovery would give it the next number, as the newest.
        $dropped=[];
        if(count($doc['versions'])>=(int)Config::get('maxVersionsPerApp',50)){
            $spare=array_values(array_filter($doc['versions'],static fn($v)=>(int)$v['version']>1&&$v['file']==='v'.(int)$v['version'].'.softn'));
            usort($spare,static fn($a,$b)=>$a['version']<=>$b['version']);
            if(Config::get('dropOldVersions',true)!==true||$spare===[])throw new ApiError(400,'This app has reached its version limit.');
            $dropped=[$spare[0]];
            $doc['versions']=array_values(array_filter($doc['versions'],static fn($v)=>$v['version']!==$spare[0]['version']));
        }
        $promised=self::promisedPolicies($row);
        if(!$byAdmin&&$promised!==null)self::refuseChangedPolicies($promised,$info);
        $dir=self::dir($slug);$file="v$next.softn";
        $staged=self::stageBundle($bundlePath,$dir);
        // The icon is written before the record, so a version that fails to be
        // recorded puts back the icon it replaced: it served the failed one.
        $icons=self::iconFiles($dir);
        try {
            $icon=self::storeIcon($dir,$info['icon'])??$row['icon'];$now=time();
            $verEntry=['slug'=>$slug,'version'=>$next,'file'=>$file,'size'=>$info['size'],'sha256'=>$info['sha256'],'manifest_version'=>$info['version'],'notes'=>Text::clean($notes,400,true),'created_at'=>$now];
            if($pushed!==null){$verEntry['commit']=$pushed['commit'];$verEntry['tree']=$pushed['tree'];}
            $doc['versions'][]=$verEntry;
            $doc['app']=array_replace($doc['app'],['latest_version'=>$next,'capabilities'=>json_encode($info['capabilities']),'execution'=>$info['execution'],'engine'=>(int)($info['engine']??1),'backend_runtime'=>$info['backendRuntime']??null,'storage_policies'=>json_encode((object)$info['storagePolicies']),'icon'=>$icon,'size'=>$info['size'],'updated_at'=>$now]);
            // What the versions after this one are held to: this version's own
            // declaration while it has storage (the same rules, or the operator's
            // new ones), and otherwise what was in force before it, which a
            // version without storage does not erase.
            $remembered=in_array('storage',$info['capabilities'],true)?$info['storagePolicies']:$promised;
            if($remembered!==null)$doc['app']['storage_promised']=$remembered;
            if($pushed!==null)$doc['app']['pushed']=['version'=>$next,'sha256'=>$info['sha256'],'commit'=>$pushed['commit'],'tree'=>$pushed['tree']];
            else unset($doc['app']['pushed']);
            $untrusted=!$byAdmin && array_key_exists('trusted',$doc['app']);
            if($untrusted)unset($doc['app']['trusted']);
            Catalog::put($slug,$doc);
            try { if(!rename($staged,"$dir/$file"))throw new ApiError(503,'Cannot store bundle.'); }
            catch (Throwable $e) {
                // Recorded, and not on disk: the record goes back to what it
                // was. If that fails too, the next discovery drops a version
                // whose file is missing, and the trust stays off.
                try { Catalog::put($slug,$before); } catch (Throwable $undo) { error_log("softn-api: $slug records version $next, whose bundle could not be stored: " . $undo->getMessage()); }
                throw $e;
            }
        } catch (Throwable $e) {
            self::restoreIcons($dir,$icons);
            throw $e;
        } finally {
            if(is_file($staged))@unlink($staged);
        }
        if($untrusted)error_log("softn-api: $slug has a new version from its publisher; it is no longer trusted until the operator sets trusted again");
        // Only now that the new one is in place, so a failure before this keeps what there was. A file that will not
        // go is found by the next discovery under its own number, as the oldest, and the next version made takes it.
        foreach($dropped as $v)if(!@unlink("$dir/".basename($v['file'])))error_log("softn-api: $slug: version {$v['version']} is out of the record, and its file could not be removed");
        return self::detail(self::row($slug,true))+['droppedVersions'=>array_column($dropped,'version')];
    }

    /**
     * Refresh an existing seeded app from its updated bundle on disk.
     * Keeps slug, metadata, and replaces the bundle payload while refreshing version digest.
     *
     * @param array<string, mixed> $meta
     */
    public static function updateSeedApp(string $slug, string $bundlePath, array $meta = []): void
    {
        Catalog::boot();
        $info = Bundle::inspect($bundlePath);
        $name = Text::clean($meta['name'] ?? '', 64) ?: $info['name'];
        $description = Text::clean($meta['description'] ?? '', 600, true) ?: $info['description'];
        [$category, $subcategory] = Categories::resolvePair(
            Text::clean($meta['category'] ?? '', 80),
            Text::clean($meta['subcategory'] ?? '', 40)
        );
        $tags = Text::tags($meta['tags'] ?? null);
        $primary = self::color($meta['primary'] ?? null) ?? self::color($info['manifest']['config']['theme']['primary'] ?? null);

        $dir = self::dir($slug);
        $file = 'v1.softn';
        self::copyBundle($bundlePath, "$dir/$file");
        $icon = self::storeIcon($dir, $info['icon']);
        $now = time();

        $doc=Catalog::doc($slug);
        // The seed owns version 1. Once a later version has been published
        // (the site owner's, with the admin key), the app's own fields
        // describe that one: writing version 1's capabilities and storage
        // policies over them made the play page set the app up without the
        // storage its current version declares.
        // The demo is filed where its index says unless the operator has
        // filed it elsewhere since the seed last did: that filing is theirs.
        $refiled=isset($doc['app']['seed_category'])&&$doc['app']['seed_category']!==$doc['app']['category'];
        $nextCat=$refiled?$doc['app']['category']:$category;
        $nextSub=$refiled?($doc['app']['subcategory']??null):$subcategory;
        if((int)($doc['app']['latest_version']??1)===1)
        $doc['app']=array_replace($doc['app'],['name'=>$name,'description'=>$description,'category'=>$nextCat,'subcategory'=>$nextSub,'seed_category'=>$refiled?$doc['app']['seed_category']:$category,'seed_subcategory'=>$refiled?($doc['app']['seed_subcategory']??null):$subcategory,'tags'=>json_encode($tags),'capabilities'=>json_encode($info['capabilities']),'execution'=>$info['execution'],'engine'=>(int)($info['engine']??1),'backend_runtime'=>$info['backendRuntime']??null,'storage_policies'=>json_encode((object)$info['storagePolicies']),'icon'=>$icon??$doc['app']['icon'],'primary_color'=>$primary,'size'=>$info['size'],'updated_at'=>$now]);
        foreach($doc['versions'] as &$v)if((int)$v['version']===1)$v=array_replace($v,['file'=>$file,'size'=>$info['size'],'sha256'=>$info['sha256'],'manifest_version'=>$info['version'],'created_at'=>$now]);
        unset($v);Catalog::put($slug,$doc);
        if (!$refiled) Catalog::moveAppFolder($slug, $nextCat, $nextSub);
    }

    /** @param array<string, mixed> $fields @return array<string, mixed> */
    public static function patch(string $slug, array $fields, bool $byAdmin = false): array
    {
        $row = self::row($slug, true);
        // Text, before it is read as text: a list or an object in one of
        // these was "Array to string conversion", which is a 500 to the caller.
        foreach (['name', 'description', 'author', 'category', 'subcategory', 'primary', 'hosting', 'backendUrl', 'backend_url'] as $f) {
            if (isset($fields[$f]) && !is_scalar($fields[$f])) throw new ApiError(400, "$f must be text.");
        }
        $sets = [];
        $params = [':slug' => $slug];
        $moveCategory = false;
        $nextCat = (string) $row['category'];
        $nextSub = is_string($row['subcategory'] ?? null) && $row['subcategory'] !== '' ? $row['subcategory'] : null;
        if (isset($fields['name'])) {
            $name = Text::clean((string) $fields['name'], 64);
            if ($name === '') throw new ApiError(400, 'The name cannot be empty.');
            $sets[] = 'name = :name';
            $params[':name'] = $name;
        }
        if (isset($fields['description'])) {
            $sets[] = 'description = :description';
            $params[':description'] = Text::clean((string) $fields['description'], 600, true);
        }
        if (isset($fields['author'])) {
            $sets[] = 'author = :author';
            $params[':author'] = Text::clean((string) $fields['author'], 40) ?: 'Anonymous';
        }
        if (isset($fields['category']) || array_key_exists('subcategory', $fields)) {
            $rawCat = isset($fields['category']) ? Text::clean((string) $fields['category'], 80) : (string) $row['category'];
            $hasExplicitSub = array_key_exists('subcategory', $fields);
            $rawSub = $hasExplicitSub ? Text::clean((string) ($fields['subcategory'] ?? ''), 40) : '';
            if (isset($fields['category']) && str_contains($rawCat, '/')) {
                [$nextCat, $nextSub] = Categories::resolvePair($rawCat, $rawSub);
            } elseif ($hasExplicitSub) {
                [$nextCat, $nextSub] = Categories::resolvePair($rawCat, $rawSub);
            } else {
                [$resolvedCat, $resolvedSub] = Categories::resolvePair($rawCat, '');
                $nextCat = $resolvedCat;
                // Keep existing subcategory only if main category did not change and input wasn't a legacy alias.
                $nextSub = $resolvedSub ?? ($nextCat === (string) $row['category'] ? $nextSub : null);
            }
            $sets[] = 'category = :category';
            $params[':category'] = $nextCat;
            $sets[] = 'subcategory = :subcategory';
            $params[':subcategory'] = $nextSub;
            $moveCategory = true;
        }
        if (array_key_exists('tags', $fields)) {
            $sets[] = 'tags = :tags';
            $params[':tags'] = json_encode(Text::tags(is_array($fields['tags']) ? json_encode($fields['tags']) : (string) $fields['tags']));
        }
        if (isset($fields['primary'])) {
            $sets[] = 'primary_color = :primary';
            $params[':primary'] = self::color((string) $fields['primary']);
        }
        if (array_key_exists('hidden', $fields)) {
            $sets[] = 'hidden = :hidden';
            $params[':hidden'] = $fields['hidden'] ? 1 : 0;
        }
        $allowPublicHosting = $byAdmin || Config::get('allowPublicServerHosting', false) === true;
        $nextBackendUrl = $row['backend_url'] ?? null;
        if (array_key_exists('backendUrl', $fields) || array_key_exists('backend_url', $fields)) {
            $rawUrl = array_key_exists('backendUrl', $fields) ? $fields['backendUrl'] : $fields['backend_url'];
            if (!$allowPublicHosting && $rawUrl !== null && trim((string) $rawUrl) !== '') {
                throw new ApiError(403, 'Server-hosted publishing is disabled on this SoftN directory.');
            }
            $nextBackendUrl = self::parseBackendUrl($rawUrl, $byAdmin);
            $sets[] = 'backend_url = :backend_url';
            $params[':backend_url'] = $nextBackendUrl;
        }
        $nextHosting = (string) ($row['hosting'] ?? 'browser');
        if (array_key_exists('hosting', $fields)) {
            $hasBackend = is_string($row['backend_runtime'] ?? null) && $row['backend_runtime'] !== '';
            $nextHosting = self::parseHosting($fields['hosting'], $hasBackend, is_string($nextBackendUrl) ? $nextBackendUrl : null, $allowPublicHosting);
            $sets[] = 'hosting = :hosting';
            $params[':hosting'] = $nextHosting;
            if ($nextHosting !== 'server') {
                $sets[] = 'withhold_backend = :withhold_backend';
                $params[':withhold_backend'] = 0;
            }
        }
        if (array_key_exists('withholdBackend', $fields) || array_key_exists('withhold_backend', $fields)) {
            $rawWithhold = array_key_exists('withholdBackend', $fields) ? $fields['withholdBackend'] : $fields['withhold_backend'];
            if (!$allowPublicHosting && self::parseBoolFlag($rawWithhold) === 1) {
                throw new ApiError(403, 'Server-hosted publishing is disabled on this SoftN directory.');
            }
            $sets[] = 'withhold_backend = :withhold_backend';
            $params[':withhold_backend'] = $nextHosting === 'server' ? self::parseBoolFlag($rawWithhold) : 0;
        }
        // Not a change to the app itself, so its updated_at stays as it was.
        if (array_key_exists('hiddenRemixes', $fields)) {
            Catalog::patch($slug, ['hidden_remixes' => json_encode(self::hiddenRemixes($slug, $fields['hiddenRemixes']))]);
            $row = self::row($slug, true);
        }
        if (!$sets) return self::detail($row);
        $sets[] = 'updated_at = :now';
        $params[':now'] = time();
        unset($params[':slug']);$changes=[];foreach($params as $k=>$v){$field=substr($k,1);$field=match($field){'primary'=>'primary_color','now'=>'updated_at',default=>$field};$changes[$field]=$v;}Catalog::patch($slug,$changes);
        if ($moveCategory) Catalog::moveAppFolder($slug, $nextCat, $nextSub);
        return self::detail(self::row($slug, true));
    }

    /** How many remixes an owner may hide from an app's page. */
    private const MAX_HIDDEN_REMIXES = 500;

    /**
     * The remixes of `$slug` its owner takes off its page and out of its
     * count. Anyone can publish a remix of any app, under any name and
     * author, and the newest twelve were listed on the parent's page with
     * nothing its owner could do about them. The list is the whole of what is
     * hidden; a name in it that is not a remix of this app (one removed since,
     * say) is dropped, so a list the page sends back can always be saved.
     *
     * @return list<string>
     */
    private static function hiddenRemixes(string $slug, mixed $value): array
    {
        if (!is_array($value) || !array_is_list($value)) throw new ApiError(400, 'hiddenRemixes must be a list of app names.');
        $rows = Catalog::all();
        $out = [];
        foreach ($value as $child) {
            if (!is_string($child)) throw new ApiError(400, 'hiddenRemixes must be a list of app names.');
            if (($rows[$child]['parent_slug'] ?? null) === $slug) $out[$child] = true;
        }
        if (count($out) > self::MAX_HIDDEN_REMIXES) throw new ApiError(400, 'At most ' . self::MAX_HIDDEN_REMIXES . ' remixes can be hidden.');
        return array_keys($out);
    }

    /**
     * A new app's answer, with the picture sent with it stored: 201, its card,
     * the edit key and its page. The app exists by now, so a picture that
     * could not be stored (a nearly full disk answers 503; requireRoom counted
     * the bundle alone) fails nothing: the answer carrying the edit key was
     * never sent, and the retry published a second app. It is listed without
     * a picture, and the answer says so.
     *
     * @param array{app: array<string, mixed>, editKey: string|null} $result what create() answered
     * @param array{0: string, 1: string}|null $image
     */
    public static function created(array $result, ?array $image): Response
    {
        $body = ['ok' => true];
        if ($image !== null) {
            try {
                self::setThumbnail($result['app']['slug'], $image);
                $result['app'] = self::card(self::row($result['app']['slug']));
            } catch (Throwable $e) {
                error_log('[softn-api] the thumbnail of ' . $result['app']['slug'] . ' was not stored: ' . $e->getMessage());
                $body['warning'] = 'The app is published, but its picture could not be stored. Add one from its page with the edit key.';
            }
        }
        return Response::json($body + ['app' => $result['app'], 'editKey' => $result['editKey'], 'page' => $result['app']['urls']['page']], 201);
    }

    /** @param array{0: string, 1: string} $image */
    public static function setThumbnail(string $slug, array $image): void
    {
        self::row($slug,true);
        [$bytes, $mime] = $image;
        $dir = self::dir($slug);
        $file = 'thumb.' . Images::extension($mime);
        // The new picture is complete on disk before the old one goes: a full
        // disk or a killed request leaves the app with the picture it had,
        // not with none (or half of one).
        $tmp = tempnam($dir, '.upload-');
        if ($tmp === false) throw new ApiError(503, 'Could not store the thumbnail.');
        try {
            if (file_put_contents($tmp, $bytes) !== strlen($bytes) || !rename($tmp, "$dir/$file")) throw new ApiError(503, 'Could not store the thumbnail.');
        } finally {
            if (is_file($tmp)) @unlink($tmp);
        }
        foreach (glob("$dir/thumb.*") ?: [] as $old) if (basename($old) !== $file) @unlink($old);
        Catalog::patch($slug,['thumb'=>$file,'updated_at'=>time()]);
    }

    public static function remove(string $slug): void { Catalog::remove($slug);
    }

    /**
     * The edit key, or the admin key, or nothing. A seeded app has no edit key
     * and belongs to the site.
     */
    /** requireOwner's question without its refusal. */
    public static function isOwner(Request $req, string $slug): bool
    {
        try {
            self::requireOwner($req, $slug);
            return true;
        } catch (ApiError) {
            return false;
        }
    }

    public static function requireOwner(Request $req, string $slug): void
    {
        if (Config::isAdmin($req->credential('x-admin-key', 'adminKey'))) return;
        $presented = $req->credential('x-edit-key', 'editKey');
        if (!is_string($presented) || !self::keyOpens($slug, $presented)) {
            throw new ApiError(403, 'That needs the edit key this app was published with.');
        }
    }

    /** Whether a key is this app's edit key. An app with no key is the site's, and none opens it. */
    public static function keyOpens(string $slug, #[\SensitiveParameter] string $key): bool
    {
        $hash = self::row($slug, true)['edit_key_hash'];
        return $key !== '' && is_string($hash) && hash_equals($hash, hash('sha256', $key));
    }

    /**
     * Give an app a new edit key in place of the one it has, and return it.
     * Only the hash is kept, as at publication, so the old key is refused by
     * every route from the moment this is written: the owner routes and the
     * publisher's side of the app's storage alike. The caller has checked
     * the current key (or the admin key) under the same catalogue lock.
     *
     * An app with no key is the site's (a seeded demo, a folder the operator
     * dropped in) and is refused even for the admin: issuing it a key would
     * hand it to whoever receives that key. `updated_at` is left alone; a
     * replaced key is not a change anyone browsing should see.
     */
    public static function replaceKey(string $slug): string
    {
        $row = self::row($slug, true);
        if (!is_string($row['edit_key_hash']) || $row['edit_key_hash'] === '') {
            throw new ApiError(409, 'This app has no edit key to replace: it belongs to the site, and the admin key is what changes it.');
        }
        $key = bin2hex(random_bytes(20));
        Catalog::patch($slug, ['edit_key_hash' => hash('sha256', $key)]);
        return $key;
    }

    /** @param array<string, mixed> $manifest */
    private static function authorFromManifest(array $manifest): ?string
    {
        $a = $manifest['author'] ?? null;
        if (is_string($a)) return Text::clean($a, 40) ?: null;
        if (is_array($a) && is_string($a['name'] ?? null)) return Text::clean($a['name'], 40) ?: null;
        return null;
    }

    private static function color(mixed $value): ?string
    {
        if (!is_string($value)) return null;
        $value = trim($value);
        return preg_match('/^#[0-9a-fA-F]{6}$/', $value) ? strtolower($value) : null;
    }

    /** @param array{0: string, 1: string}|null $icon */
    /** @return array<string, string> The icon files an app's folder holds, by path, with their bytes (restoreIcons). */
    private static function iconFiles(string $dir): array
    {
        $files = [];
        foreach (glob("$dir/icon.*") ?: [] as $file) {
            $bytes = @file_get_contents($file);
            if ($bytes !== false) $files[$file] = $bytes;
        }
        return $files;
    }

    /** @param array<string, string> $files The icon files as iconFiles found them, put back. */
    private static function restoreIcons(string $dir, array $files): void
    {
        foreach (glob("$dir/icon.*") ?: [] as $file) if (!isset($files[$file])) @unlink($file);
        foreach ($files as $file => $bytes) @file_put_contents($file, $bytes, LOCK_EX);
    }

    private static function storeIcon(string $dir, ?array $icon): ?string
    {
        if ($icon === null) return null;
        [$bytes, $mime] = $icon;
        foreach (glob("$dir/icon.*") ?: [] as $old) @unlink($old);
        $file = 'icon.' . Images::extension($mime);
        if (file_put_contents("$dir/$file", $bytes, LOCK_EX) === false) return null;
        return $file;
    }

    // ── Images ─────────────────────────────────────────────────────────────

    public static function thumbnailResponse(string $slug, ?Request $req = null): Response
    {
        $row = self::row($slug);
        $dir = Catalog::path($slug);
        $cache = ['Cache-Control' => 'public, max-age=600'] + Response::USER_CONTENT;
        foreach ([$row['thumb'], $row['icon']] as $file) {
            if (self::servableImage($dir, $file)) return self::picture("$dir/$file", $cache, $req);
        }
        return Response::bytes(self::placeholderSvg((string) $row['name'], $row['primary_color'] ?: null), 'image/svg+xml', $cache);
    }

    public static function iconResponse(string $slug, ?Request $req = null): Response
    {
        $row = self::row($slug);
        $dir = Catalog::path($slug);
        $file = $row['icon'];
        $headers = ['Cache-Control' => 'public, max-age=600'] + Response::USER_CONTENT;
        if (self::servableImage($dir, $file)) return self::picture("$dir/$file", $headers, $req);
        return Response::bytes(self::placeholderSvg((string) $row['name'], $row['primary_color'] ?: null, true), 'image/svg+xml', $headers);
    }

    /**
     * A stored picture, or a 304 when the client already holds it. The tag
     * was computed for every request and compared with nothing, so a picture
     * a browser had was sent again each time its ten minutes were up.
     *
     * @param array<string, string> $headers
     */
    private static function picture(string $path, array $headers, ?Request $req): Response
    {
        $type = Images::mimeForExtension(pathinfo($path, PATHINFO_EXTENSION));
        $headers += ['ETag' => '"' . md5_file($path) . '"'];
        if ($req !== null && $req->ifNoneMatch($headers['ETag'])) return Response::notModified($headers + ['Content-Type' => $type]);
        return Response::file($path, $type, $headers);
    }

    /**
     * A stored picture that may be served: present, and when it is an SVG,
     * one that still passes Bundle::safeSvg. An icon extracted before that
     * check was strict is on disk already; it is held to today's rule at
     * every request and answered with the placeholder when it fails.
     */
    private static function servableImage(string $dir, mixed $file): bool
    {
        if (!is_string($file) || $file === '' || !is_file("$dir/$file")) return false;
        if (strtolower(pathinfo($file, PATHINFO_EXTENSION)) !== 'svg') return true;
        $bytes = @file_get_contents("$dir/$file", false, null, 0, Bundle::MAX_ICON_BYTES + 1);
        return is_string($bytes) && Bundle::safeSvg($bytes);
    }

    /** A card for an app that brought no picture: its initials on a colour derived from its name. */
    public static function placeholderSvg(string $name, ?string $primary, bool $square = false): string
    {
        $hue = hexdec(substr(md5($name), 0, 2)) * 360 / 255;
        $bg = $primary ?? sprintf('hsl(%d, 48%%, 42%%)', (int) $hue);
        $bg2 = $primary ? self::shade($primary, -0.25) : sprintf('hsl(%d, 52%%, 24%%)', (int) $hue);
        $words = preg_split('/\s+/u', trim($name)) ?: [];
        $initials = '';
        foreach ($words as $w) {
            if ($w === '') continue;
            $initials .= mb_strtoupper(mb_substr($w, 0, 1));
            if (mb_strlen($initials) >= 2) break;
        }
        $initials = htmlspecialchars($initials ?: '?', ENT_QUOTES | ENT_XML1);
        $w = $square ? 256 : 640;
        $h = $square ? 256 : 400;
        $fs = $square ? 112 : 160;
        return <<<SVG
<svg xmlns="http://www.w3.org/2000/svg" width="$w" height="$h" viewBox="0 0 $w $h" role="img">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="$bg"/><stop offset="1" stop-color="$bg2"/></linearGradient></defs>
<rect width="$w" height="$h" fill="url(#g)"/>
<text x="50%" y="50%" dy="0.36em" text-anchor="middle" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-weight="800" font-size="$fs" fill="rgba(255,255,255,0.92)">$initials</text>
</svg>
SVG;
    }

    private static function shade(string $hex, float $amount): string
    {
        $r = hexdec(substr($hex, 1, 2));
        $g = hexdec(substr($hex, 3, 2));
        $b = hexdec(substr($hex, 5, 2));
        $f = fn(int $c): int => max(0, min(255, (int) round($c * (1 + $amount))));
        return sprintf('#%02x%02x%02x', $f((int) $r), $f((int) $g), $f((int) $b));
    }
}

final class Categories
{
    /** The main categories the site starts with. A visitor can suggest more, or create folders under data/apps/. */
    private const CORE = [
        ['business', 'Business Apps', 'Full-stack business operations apps with sandboxed backends and SQLite', '🏢', 5],
        ['games', 'Games', 'Things to play across 3D, arcade, strategy, story and retro', '🎮', 10],
        ['simulations', 'Simulations', 'Interactive worlds, ecosystems and models', '🌐', 15],
        ['tools', 'Tools', 'Utilities that do one job well', '🧰', 20],
        ['creative', 'Creative', 'Drawing, music, generators', '🎨', 30],
        ['productivity', 'Productivity', 'Notes, planners, trackers', '📝', 40],
        ['education', 'Learning', 'Teach, quiz, explain', '📚', 50],
        ['ai', 'AI', 'Apps that run a model', '🤖', 60],
        ['experiments', 'Experiments', 'Trying something out', '🧪', 70],
        ['demos', 'Examples', 'Interactive apps showing what SoftN Web Containers can do', '🧩', 80],
        ['other', 'Other', 'Everything else', '📦', 90],
    ];

    /** Default subcategories nested under main categories. Folder category.json files override display fields. */
    private const CORE_SUBCATEGORIES = [
        ['games', '3d', '3D & First-Person', '3D worlds, voxel sandboxes, survival and mazes', '🧊', 10],
        ['games', 'arcade', 'Arcade & Comedy', 'Fast-paced reflexes, satire and pick-up-and-play games', '🕹️', 20],
        ['games', 'strategy', 'Strategy & Management', 'Cities, colonies, tactics and resource management', '🏗️', 30],
        ['games', 'story', 'Story & Narrative', 'Interactive dramas, mysteries and atmospheric fiction', '📖', 40],
        ['games', 'retro', 'Retro & Tabletop', 'Card games, tabletop classics and pocket-sized throwbacks', '🃏', 50],
        ['games', 'puzzle', 'Puzzle & Brain', 'Logic puzzles, riddles and brain teasers', '🧠', 60],
        ['business', 'hospitality', 'Hospitality & Events', 'Cafes, restaurants, catering, venues and short-stay ops', '☕', 10],
        ['business', 'field-trades', 'Field & Trades', 'Workshops, farms, plumbing, cleaning, pet care and site diaries', '🔧', 20],
        ['business', 'healthcare-wellness', 'Health, Beauty & Coaching', 'Clinics, salons, coaching studios and tutoring', '🩺', 30],
        ['business', 'operations', 'Operations & Fleet', 'Fleet tracking, job invoicing and device repair benches', '🚚', 40],
        ['business', 'retail-inventory', 'Retail & Inventory', 'POS workflows, stock control and purchase orders', '🛒', 50],
        ['business', 'people-support', 'People & Support', 'Reception desks, customer service and HR operations', '👥', 60],
        ['business', 'finance-compliance', 'Finance & Compliance', 'Accounting, bookkeeping, OHS and quality management', '📊', 70],
    ];

    /** Legacy top-level category ids that moved into subcategories under games. */
    private const LEGACY_ALIASES = [
        'story' => ['games', 'story'],
        'strategy' => ['games', 'strategy'],
    ];

    /** @return array{0: string, 1: string}|null */
    public static function legacyAlias(string $id): ?array {
        $key = strtolower(trim($id));
        return self::LEGACY_ALIASES[$key] ?? null;
    }

    /** Built-in display metadata for a core main category (`games`) or subcategory (`games/3d`). */
    public static function defaultMetaFor(string $id): ?array {
        foreach (self::CORE as [$cid, $name, $desc, $emoji, $sort]) {
            if ($cid === $id) {
                return ['id' => $cid, 'slug' => $cid, 'parent' => null, 'name' => $name, 'description' => $desc, 'emoji' => $emoji, 'sort' => $sort, 'status' => 'core'];
            }
        }
        foreach (self::CORE_SUBCATEGORIES as [$parent, $slug, $name, $desc, $emoji, $sort]) {
            if ("$parent/$slug" === $id) {
                return ['id' => $id, 'slug' => $slug, 'parent' => $parent, 'name' => $name, 'description' => $desc, 'emoji' => $emoji, 'sort' => $sort, 'status' => 'core'];
            }
        }
        return null;
    }

    /** `$rows` with the main categories the site starts with. @param array<string, array<string, mixed>> $rows */
    private static function withCore(array $rows): array {
        foreach (array_keys(self::LEGACY_ALIASES) as $legacy) {
            if (isset($rows[$legacy]) && ($rows[$legacy]['status'] ?? '') === 'core' && empty($rows[$legacy]['parent'])) {
                unset($rows[$legacy]);
            }
        }
        foreach(self::CORE as [$id,$name,$desc,$emoji,$sort]) {
            if(isset($rows[$id]) && ($rows[$id]['status']??'')!=='core')continue;
            $rows[$id]=['id'=>$id,'name'=>$name,'description'=>$desc,'emoji'=>$emoji,'status'=>'core','sort'=>$sort,'created_at'=>$rows[$id]['created_at']??time()];
        }
        return $rows;
    }

    public static function ensure(): void {
        // Nothing to bring up to date in a file that cannot be read: writing
        // over it would lose what it holds, which readable() below goes without.
        try { $rows=Catalog::categories(); } catch (ApiError) { return; }
        $next=self::withCore($rows);
        if($next!==$rows)Catalog::saveCategories($next);
    }

    /**
     * The categories, for reading. A categories.json that cannot be read is
     * the owner's to mend and is kept as it is, but the site's own categories
     * are built in, and a file of labels is no reason to take the listing and
     * every play page down: what suggested and renamed categories it held wait
     * for it, and writing to them is refused meanwhile (Catalog::categories).
     *
     * @return array<string, array<string, mixed>>
     */
    private static function readable(): array {
        try { return Catalog::categories(); }
        catch (ApiError $e) {
            error_log('softn-api: going on with the built-in categories: ' . $e->getMessage());
            return self::withCore([]);
        }
    }

    /**
     * Merge built-in categories/subcategories, categories.json overrides/suggestions,
     * and folder-discovered category.json metadata into one normalized map keyed by id.
     *
     * @return array<string, array<string, mixed>>
     */
    private static function merged(): array {
        $rows = [];
        foreach (self::readable() as $id => $r) {
            if (!is_array($r)) continue;
            $cid = (string) ($r['id'] ?? $id);
            $parent = is_string($r['parent'] ?? null) && $r['parent'] !== '' ? $r['parent'] : (str_contains($cid, '/') ? explode('/', $cid, 2)[0] : null);
            $slug = is_string($r['slug'] ?? null) && $r['slug'] !== '' ? $r['slug'] : ($parent !== null ? substr($cid, strlen($parent) + 1) : $cid);
            $rows[$cid] = [
                'id' => $cid,
                'slug' => $slug,
                'parent' => $parent,
                'name' => (string) ($r['name'] ?? $slug),
                'description' => (string) ($r['description'] ?? ''),
                'emoji' => (string) ($r['emoji'] ?? ($parent !== null ? '📂' : '📁')),
                'status' => (string) ($r['status'] ?? 'approved'),
                'sort' => (int) ($r['sort'] ?? 100),
                'created_at' => (int) ($r['created_at'] ?? 0),
            ];
        }
        foreach (self::CORE_SUBCATEGORIES as [$parent, $slug, $name, $desc, $emoji, $sort]) {
            $id = "$parent/$slug";
            if (!isset($rows[$id])) {
                $rows[$id] = [
                    'id' => $id,
                    'slug' => $slug,
                    'parent' => $parent,
                    'name' => $name,
                    'description' => $desc,
                    'emoji' => $emoji,
                    'status' => 'core',
                    'sort' => $sort,
                    'created_at' => 0,
                ];
            }
        }
        // Folder category.json takes precedence for display name/description/emoji/sort/status
        // so operators can customize a category's full name directly inside its folder.
        foreach (Catalog::folderCategories() as $id => $meta) {
            $rows[$id] = [
                'id' => (string) $meta['id'],
                'slug' => (string) $meta['slug'],
                'parent' => $meta['parent'],
                'name' => (string) $meta['name'],
                'description' => (string) $meta['description'],
                'emoji' => (string) $meta['emoji'],
                'status' => (string) $meta['status'],
                'sort' => (int) $meta['sort'],
                'created_at' => $rows[$id]['created_at'] ?? 0,
            ];
        }
        return $rows;
    }

    private static function titleize(string $slug): string {
        $parts = array_filter(explode('-', $slug), static fn($p) => $p !== '');
        if ($parts === []) return 'Category';
        return implode(' ', array_map(static fn($p) => strlen($p) <= 2 && ctype_alnum($p) ? strtoupper($p) : ucfirst($p), $parts));
    }

    /** @return array<int, array<string, mixed>> */
    public static function all(bool $includeHidden = false): array
    {
        self::ensure();
        $merged = self::merged();
        $apps = Catalog::all();

        $mainTotal = [];
        $mainDirect = [];
        $subCount = [];
        foreach ($apps as $a) {
            if (!empty($a['hidden'])) continue;
            $c = (string) ($a['category'] ?? 'other');
            $s = is_string($a['subcategory'] ?? null) && $a['subcategory'] !== '' ? $a['subcategory'] : null;
            $mainTotal[$c] = ($mainTotal[$c] ?? 0) + 1;
            if ($s !== null) {
                $sid = "$c/$s";
                $subCount[$sid] = ($subCount[$sid] ?? 0) + 1;
                if (!isset($merged[$sid])) {
                    $def = self::defaultMetaFor($sid);
                    $merged[$sid] = $def ?? ['id' => $sid, 'slug' => $s, 'parent' => $c, 'name' => self::titleize($s), 'description' => '', 'emoji' => '📂', 'status' => 'approved', 'sort' => 200, 'created_at' => 0];
                }
            } else {
                $mainDirect[$c] = ($mainDirect[$c] ?? 0) + 1;
            }
        }

        $mains = [];
        $subsByParent = [];
        foreach ($merged as $r) {
            if (!$includeHidden && $r['status'] === 'hidden') continue;
            if ($r['parent'] !== null) {
                $subsByParent[$r['parent']][] = $r;
            } else {
                $mains[] = $r;
            }
        }

        $cmp = static fn($a, $b) => [in_array($a['status'], ['core', 'approved'], true) ? 0 : 1, $a['sort'], $a['name']] <=> [in_array($b['status'], ['core', 'approved'], true) ? 0 : 1, $b['sort'], $b['name']];
        usort($mains, $cmp);

        $out = [];
        foreach ($mains as $r) {
            $id = $r['id'];
            $subRows = $subsByParent[$id] ?? [];
            usort($subRows, $cmp);
            $subs = [];
            foreach ($subRows as $sr) {
                $subs[] = [
                    'id' => $sr['id'],
                    'slug' => $sr['slug'],
                    'parent' => $id,
                    'name' => $sr['name'],
                    'description' => $sr['description'],
                    'emoji' => $sr['emoji'],
                    'status' => $sr['status'],
                    'suggested' => $sr['status'] === 'suggested',
                    'apps' => (int) ($subCount[$sr['id']] ?? 0),
                ];
            }
            $out[] = [
                'id' => $id,
                'slug' => $r['slug'],
                'parent' => null,
                'name' => $r['name'],
                'description' => $r['description'],
                'emoji' => $r['emoji'],
                'status' => $r['status'],
                'suggested' => $r['status'] === 'suggested',
                'apps' => (int) ($mainTotal[$id] ?? 0),
                'directApps' => (int) ($mainDirect[$id] ?? 0),
                'subcategories' => $subs,
            ];
        }
        return $out;
    }

    /**
     * Resolve a main category and optional subcategory (supporting `"games/3d"`,
     * `("games", "3d")`, display names, folder categories, and legacy aliases).
     *
     * @return array{0: string, 1: string|null}
     */
    public static function resolvePair(string $category, string $subcategory = ''): array {
        self::ensure();
        $catText = trim($category);
        $subText = trim($subcategory);
        if (str_contains($catText, '/')) {
            [$cPart, $sPart] = explode('/', $catText, 2);
            $catText = trim($cPart);
            if ($subText === '') $subText = trim($sPart);
        }
        if ($catText === '') return ['other', null];
        if (($alias = self::legacyAlias($catText)) !== null) {
            return [$alias[0], $subText !== '' ? (Apps::slugOf($subText) ?: $alias[1]) : $alias[1]];
        }
        $merged = self::merged();
        $catSlug = Apps::slugOf($catText);
        $catLower = mb_strtolower($catText);
        $resolvedCat = 'other';
        foreach ($merged as $r) {
            if ($r['parent'] !== null || $r['status'] === 'hidden') continue;
            if (($catSlug !== '' && $r['id'] === $catSlug) || mb_strtolower($r['name']) === $catLower) {
                $resolvedCat = $r['id'];
                break;
            }
        }
        if ($subText === '') return [$resolvedCat, null];

        $subSlug = Apps::slugOf($subText);
        $subLower = mb_strtolower($subText);
        $resolvedSub = null;
        foreach ($merged as $r) {
            if ($r['parent'] !== $resolvedCat || $r['status'] === 'hidden') continue;
            if (($subSlug !== '' && ($r['slug'] === $subSlug || $r['id'] === "$resolvedCat/$subSlug")) || mb_strtolower($r['name']) === $subLower) {
                $resolvedSub = $r['slug'];
                break;
            }
        }
        return [$resolvedCat, $resolvedSub];
    }

    /** A main category id the visitor gave, or 'other'. */
    public static function resolve(string $given): string {
        return self::resolvePair($given)[0];
    }

    /**
     * A visitor's suggestion (for a main category or, when `$parent` is given,
     * a subcategory under that main category). It becomes usable at once,
     * marked as suggested; the site owner approves, renames or hides it later.
     *
     * @return array<string, mixed>
     */
    public static function suggest(string $name, string $description, string $emoji, ?string $parent = null): array
    {
        self::ensure();
        $name = Text::clean($name, 32);
        if (mb_strlen($name) < 2) throw new ApiError(400, 'A category name needs at least two characters.');
        $parentId = null;
        if ($parent !== null && trim($parent) !== '') {
            $merged = self::merged();
            $pSlug = Apps::slugOf($parent);
            $pLower = mb_strtolower(trim($parent));
            foreach ($merged as $r) {
                if ($r['parent'] !== null || $r['status'] === 'hidden') continue;
                if (($pSlug !== '' && $r['id'] === $pSlug) || mb_strtolower($r['name']) === $pLower) {
                    $parentId = $r['id'];
                    break;
                }
            }
            if ($parentId === null) throw new ApiError(400, 'No such parent category.');
        }
        $slug = Apps::slugOf($name);
        if ($slug === '') $slug = 'c-' . substr(hash('sha256', mb_strtolower($name)), 0, 12);
        $id = $parentId !== null ? "$parentId/$slug" : $slug;
        $rows = Catalog::categories();
        $allMerged = self::merged();
        foreach ($allMerged as $r) {
            if ($r['parent'] !== $parentId) continue;
            if ($r['id'] === $id || mb_strtolower($r['name']) === mb_strtolower($name)) return self::one($r['id']);
        }
        // Only those that show count: hidden ones filled the room for good, with no way to delete them.
        if (count(array_filter($rows, static fn($r) => ($r['status'] ?? '') !== 'hidden')) >= 200) throw new ApiError(400, 'There are already as many categories as the directory will hold.');
        $emoji = Text::clean($emoji, 4);
        if ($emoji !== '' && !preg_match('/^\p{So}\p{M}*(\x{200D}\p{So}\p{M}*)*$/u', $emoji)) $emoji = '';
        $entry = [
            'id' => $id,
            'slug' => $slug,
            'parent' => $parentId,
            'name' => $name,
            'description' => Text::clean($description, 120),
            'emoji' => $emoji ?: ($parentId !== null ? '📂' : '🏷️'),
            'status' => 'suggested',
            'sort' => 500,
            'created_at' => time(),
        ];
        // Refuse category names that collide with an existing app folder on disk so
        // an unauthenticated suggestion can never hijack or hide an app directory.
        $targetDir = Config::dataDir() . '/apps/' . $id;
        if (is_file("$targetDir/app.json") || (is_dir($targetDir) && (glob("$targetDir/*.softn") ?: []) !== [])) {
            throw new ApiError(409, 'That category name is already used by an app.');
        }
        $rows[$id] = $entry;
        Catalog::saveCategories($rows);
        if (Config::get('folderLayout', 'flat') === 'categorized') {
            Catalog::writeCategoryMeta($parentId ?? $slug, $parentId !== null ? $slug : null, $entry);
        }
        return self::one($id);
    }

    /** @return array<string, mixed> */
    public static function one(string $id): array
    {
        foreach (self::all(true) as $c) {
            if ($c['id'] === $id) return $c;
            foreach ($c['subcategories'] ?? [] as $sub) {
                if ($sub['id'] === $id) return $sub;
            }
        }
        throw new ApiError(404, 'No such category.');
    }

    /** @param array<string, mixed> $fields @return array<string, mixed> */
    public static function update(string $id, array $fields): array {
        $existing = self::one($id);
        $rows = Catalog::categories();
        $r = $rows[$id] ?? [
            'id' => $existing['id'],
            'slug' => $existing['slug'],
            'parent' => $existing['parent'],
            'name' => $existing['name'],
            'description' => $existing['description'],
            'emoji' => $existing['emoji'],
            'status' => $existing['status'],
            'sort' => 100,
            'created_at' => time(),
        ];
        if (isset($fields['status']) && in_array($fields['status'], ['core', 'approved', 'suggested', 'hidden'], true)) $r['status'] = $fields['status'];
        foreach (['name' => 32, 'description' => 120, 'emoji' => 4] as $k => $max) {
            if (isset($fields[$k])) {
                if (!is_scalar($fields[$k])) throw new ApiError(400, "$k must be text.");
                $v = Text::clean((string) $fields[$k], $max);
                if ($k !== 'name' || $v !== '') $r[$k] = $v;
            }
        }
        if (isset($fields['sort'])) $r['sort'] = (int) $fields['sort'];
        $rows[$id] = $r;
        Catalog::saveCategories($rows);
        $parent = $existing['parent'];
        $catSlug = $parent ?? $existing['slug'];
        $subSlug = $parent !== null ? $existing['slug'] : null;
        if (Catalog::usesCategorizedLayout($catSlug, $subSlug) || isset(Catalog::folderCategories()[$id])) {
            Catalog::writeCategoryMeta($catSlug, $subSlug, $r);
        }
        return self::one($id);
    }
}
