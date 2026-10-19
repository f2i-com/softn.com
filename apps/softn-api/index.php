<?php
/**
 * The softn.com directory API.
 *
 * One script, deployed as /api/ beside the static site, answering with JSON.
 * Everything it keeps — the catalogue, the uploaded bundles, each app's own
 * database — is a file under data/. There are no accounts: publishing hands
 * back an edit key, everything else is open to anyone, within rate limits.
 * See README.md in this directory for the routes.
 */
declare(strict_types=1);

require __DIR__ . '/lib/http.php';
require __DIR__ . '/lib/db.php';
require __DIR__ . '/lib/catalog.php';
require __DIR__ . '/lib/bundle.php';
require __DIR__ . '/lib/apps.php';
require __DIR__ . '/lib/social.php';
require __DIR__ . '/lib/storage.php';
require __DIR__ . '/lib/seed.php';
require __DIR__ . '/lib/pages.php';

ini_set('display_errors', '0');
error_reporting(E_ALL);
set_error_handler(static function (int $no, string $str, string $file, int $line): bool {
    if (!(error_reporting() & $no)) return false;
    throw new ErrorException($str, 0, $no, $file, $line);
});

// The API is read from the site's own origin, from the runtime under /web/,
// and by scripts publishing from anywhere; nothing here relies on a cookie,
// so an open origin costs nothing on the routes anyone may call. The routes
// that take an edit key or the admin key answer only the site's own origin
// and the ones config.json lists (Cors in lib/http.php): a page elsewhere
// gets a 403 from them, at the preflight or at the request. Apps never call
// those routes across origins, so nothing published changes.
cors_headers();
header('X-Content-Type-Options: nosniff');

/**
 * The CORS headers for this request, before anything else is decided: they
 * must be on a reply that Request::fromGlobals cannot produce (a data
 * directory PHP cannot use), so the path is read from the request line here
 * the way fromGlobals reads it. A restricted route asked for from an origin
 * that may not use it is refused here, with the reason.
 */
function cors_headers(): void
{
    $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
    $path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
    $path = is_string($path) ? rawurldecode($path) : '/';
    $path = '/' . trim(preg_replace('#^/api(?=/|$)#', '', $path) ?? $path, '/');
    // A preflight is about the method it asks for, not about OPTIONS.
    $asked = $method === 'OPTIONS' ? strtoupper($_SERVER['HTTP_ACCESS_CONTROL_REQUEST_METHOD'] ?? 'GET') : $method;
    $origin = $_SERVER['HTTP_ORIGIN'] ?? null;
    if (!Cors::restricted($asked, $path)) {
        header('Access-Control-Allow-Origin: *');
    } elseif (is_string($origin)) {
        header('Vary: Origin');
        if (!Cors::allowed($origin, Cors::requestOrigin())) {
            Response::json(['ok' => false, 'error' => 'This route answers the site\'s own origin only. List another in allowedOrigins in data/config.json.'], 403)->send();
            exit;
        }
        header('Access-Control-Allow-Origin: ' . $origin);
    }
    header('Access-Control-Allow-Methods: GET, HEAD, POST, PATCH, DELETE, OPTIONS');
    // If-None-Match is not CORS-safelisted: without it here a page on another
    // origin revalidating a bundle is refused at the preflight and downloads the
    // archive every time.
    header('Access-Control-Allow-Headers: Content-Type, If-None-Match, X-Edit-Key, X-Admin-Key, X-Visitor-Token');
    // The same page sees only the safelisted response headers unless the rest are
    // exposed: the ETag it revalidates with, the filename a download carries, the
    // wait a rate limit names.
    header('Access-Control-Expose-Headers: ETag, Content-Disposition, Retry-After');
    header('Access-Control-Max-Age: 86400');
}

/** @return array{0: string, 1: string[]}|null */
function match_route(string $method, string $path, array $routes): ?array
{
    // HEAD is answered by whichever route answers GET, as RFC 9110 §9.3.2
    // expects of any resource that has a GET: the handler runs as for GET, and
    // Response::send() leaves the content out. Doing it here, once, is
    // smaller than a HEAD row per route and cannot drift from the GET.
    if ($method === 'HEAD') $method = 'GET';
    foreach ($routes as [$m, $pattern, $handler]) {
        if ($m !== $method && $m !== '*') continue;
        if (preg_match($pattern, $path, $matches)) {
            array_shift($matches);
            return [$handler, array_map('rawurldecode', $matches)];
        }
    }
    return null;
}

$routes = [
    ['GET', '#^/?$#', 'index'],
    ['GET', '#^/health$#', 'health'],
    ['GET', '#^/README\.md$#', 'readme'],
    ['GET', '#^/categories$#', 'categories'],
    ['POST', '#^/categories$#', 'suggestCategory'],
    ['GET', '#^/apps$#', 'listApps'],
    ['POST', '#^/apps$#', 'publish'],
    ['GET', '#^/apps/([^/]+)$#', 'appDetail'],
    ['PATCH', '#^/apps/([^/]+)$#', 'patchApp'],
    ['DELETE', '#^/apps/([^/]+)$#', 'deleteApp'],
    ['GET', '#^/apps/([^/]+)/bundle(?:\.softn)?$#', 'bundle'],
    ['GET', '#^/apps/([^/]+)/([^/]+)\.softn$#', 'bundle'],
    ['GET', '#^/apps/([^/]+)/thumbnail$#', 'thumbnail'],
    ['POST', '#^/apps/([^/]+)/thumbnail$#', 'setThumbnail'],
    ['GET', '#^/apps/([^/]+)/icon$#', 'icon'],
    ['GET', '#^/apps/([^/]+)/source$#', 'source'],
    ['POST', '#^/apps/([^/]+)/versions$#', 'addVersion'],
    ['POST', '#^/apps/([^/]+)/key$#', 'replaceKey'],
    ['POST', '#^/apps/([^/]+)/remix$#', 'remix'],
    ['GET', '#^/apps/([^/]+)/comments$#', 'comments'],
    ['POST', '#^/apps/([^/]+)/comments$#', 'addComment'],
    ['GET', '#^/apps/([^/]+)/rating$#', 'rating'],
    ['POST', '#^/apps/([^/]+)/rating$#', 'rate'],
    ['POST', '#^/apps/([^/]+)/runs$#', 'run'],
    ['POST', '#^/apps/([^/]+)/storage$#', 'storage'],
    ['GET', '#^/apps/([^/]+)/storage$#', 'storageSummary'],
    ['GET', '#^/apps/([^/]+)/storage/([a-z][a-z0-9_]{0,31})$#', 'storageList'],
    ['POST', '#^/admin/categories/([^/]+)$#', 'adminCategory'],
    ['DELETE', '#^/admin/comments/(\d+)$#', 'adminDeleteComment'],
    ['GET', '#^/admin/stats$#', 'adminStats'],
    ['GET', '#^/page/app/([^/]+)$#', 'page'],
    ['GET', '#^/page/play/([^/]+)$#', 'playPage'],
];

try {
    // Reading the request reads the configuration (whether a proxy's
    // X-Forwarded-For is believed), and that is the first thing to touch
    // data/: a directory PHP cannot write, or a config.json that is not
    // JSON, is the documented 503 below rather than a bare fatal with no
    // JSON and no CORS headers.
    $req = Request::fromGlobals();
    if ($req->method === 'OPTIONS') {
        http_response_code(204);
        exit;
    }

    // A browser navigation to /app/<slug> or /play/<slug> lands here through
    // the rewrite in .htaccess; the request path is the page's own.
    $pagePath = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
    if (is_string($pagePath) && preg_match('#^/app/([^/]+)/?$#', rawurldecode($pagePath), $pm)) {
        Pages::app($pm[1])->send();
        exit;
    }
    if (is_string($pagePath) && preg_match('#^/play/([^/]+)/?$#', rawurldecode($pagePath), $pm)) {
        Seed::ifEmpty();
        Pages::play($pm[1])->send();
        exit;
    }

    $matched = match_route($req->method, $req->path, $routes);
    if ($matched === null) throw new ApiError(404, 'No such route: ' . $req->method . ' ' . $req->path);
    [$handler, $args] = $matched;
    // A JSON body is read here, whole and within the route's limit, before
    // any handler opens the catalogue: the lock is held until the reply,
    // and a handler that resolved its slug first and then read the body
    // (a comment, a rating, a storage operation, a PATCH) held every other
    // request, reads included, for as long as one client took to send a few
    // bytes — under mod_php and Apache's FastCGI proxy PHP reads the body as
    // it arrives. Form bodies PHP has read before the script starts; a raw
    // bundle is spooled by its handler before the catalogue, likewise.
    // Only a body held to the JSON limit: the bundle and image routes read
    // theirs before the catalogue themselves, after their own checks.
    // A storage body is decoded here the way its handler needs it (the text
    // is not kept to decode twice): an object stays an object. See Json.
    if ($req->method !== 'GET' && $req->method !== 'HEAD' && $req->contentType() === 'application/json' && $req->bodyLimit() === Limits::json()) $req->json($handler === 'storage');
    $response = handle($handler, $args, $req);
    Catalog::release();
    server_timing();
    $response->send();
} catch (ApiError $e) {
    // Released here as well, so the hold the header reports is the hold
    // that ended, not one the shutdown would end after the reply is gone.
    Catalog::release();
    server_timing();
    Response::json(['ok' => false, 'error' => $e->getMessage()] + $e->extra, $e->status,
        isset($e->extra['retryAfter']) ? ['Retry-After' => (string) $e->extra['retryAfter']] : [])->send();
} catch (Throwable $e) {
    error_log('softn-api: ' . $e->getMessage() . ' at ' . $e->getFile() . ':' . $e->getLine());
    Response::json(['ok' => false, 'error' => 'The server could not complete that.'], 500)->send();
}

/**
 * The catalogue's timings for this request as a Server-Timing header, when
 * the configuration asks for them (`debugTimings`). A configuration that
 * cannot be read is the 503 the caller is already sending; it is not
 * worth a second failure here.
 */
function server_timing(): void
{
    try {
        if (Config::get('debugTimings', false) === true) header('Server-Timing: ' . Timings::header());
    } catch (Throwable) {
        // The reply in flight says what went wrong with the configuration.
    }
}

/**
 * The slug of a published app that declared storage, for every storage
 * route alike: the GET routes used to skip the check the POST made, and a
 * query through them created storage.sqlite in any app's folder.
 */
/**
 * The version a request names with `?v=`, or null for the latest.
 *
 * `?v=`, `?v=latest` and `?v=0` used to be read as version 1 (an integer
 * cast, then at least 1) and answered with the one-day public cache a
 * numbered version then got: an old bundle, served as the pinned one, under
 * a URL the caller meant as "the current one". An empty value is no version
 * named; anything else that is not a whole number from 1 is refused.
 */
function requested_version(Request $req): ?int
{
    $v = $req->query['v'] ?? null;
    if ($v === null || $v === '') return null;
    if (!is_string($v) || !ctype_digit($v) || strlen($v) > 9 || (int) $v < 1) {
        throw new ApiError(400, 'v must be a version number, 1 or more; leave it out for the latest.');
    }
    return (int) $v;
}

/**
 * The digest a request pins its bundle to with `?sha256=`, or null when it
 * names none. An empty value is none; anything but the 64 lower-case hex
 * digits the API hands out is refused, so one content has one address.
 */
function requested_digest(Request $req): ?string
{
    $d = $req->query['sha256'] ?? null;
    if ($d === null || $d === '') return null;
    if (!is_string($d) || !preg_match('/^[0-9a-f]{64}$/D', $d)) {
        throw new ApiError(400, 'sha256 must be the bundle\'s digest as the API gives it: 64 lower-case hex digits.');
    }
    return $d;
}

/**
 * What a remix sent with no bundle starts from: its parent's latest bundle,
 * copied to a file of the request's own and checked before the catalogue is
 * taken, as an uploaded one is. [path, what Bundle::inspect said], or null
 * when the folder cannot be read that way (no app.json yet, no version, a
 * bundle that does not pass), and the remix is then made from the parent's
 * file under the lock, as it always was.
 *
 * The folder is read without the lock. app.json is only ever replaced whole,
 * by a rename, so what is read is a version of it, if perhaps not the latest:
 * the route uses the copy only when its digest is the one the catalogue
 * names for the parent's latest version once the lock is held.
 *
 * @return array{0: string, 1: array<string, mixed>}|null
 */
function remix_source(string $given): ?array
{
    foreach (array_unique([trim($given), Apps::slugOf($given)]) as $slug) {
        $dir = Config::dataDir() . '/apps/' . $slug;
        if (!Catalog::validSlug($slug) || is_link($dir) || !is_file("$dir/app.json")) continue;
        $doc = json_decode((string) @file_get_contents("$dir/app.json"), true);
        $latest = null;
        foreach (is_array($doc['versions'] ?? null) ? $doc['versions'] : [] as $v) {
            if (is_array($v) && is_int($v['version'] ?? null) && is_string($v['file'] ?? null) && ($latest === null || $v['version'] > $latest['version'])) $latest = $v;
        }
        if ($latest === null || basename($latest['file']) !== $latest['file']) return null;
        try {
            $copy = TempFiles::create();
            if (!@copy("$dir/{$latest['file']}", $copy)) return null;
            return [$copy, Bundle::inspect($copy)];
        } catch (Throwable) {
            return null;
        }
    }
    return null;
}

function storage_app(string $given): string
{
    $slug = Apps::resolveSlug($given);
    $caps = json_decode((string) Apps::row($slug)['capabilities'], true) ?: [];
    if (!in_array('storage', $caps, true)) {
        throw new ApiError(403, 'This app did not declare storage in its permission.json, so it has no server storage.');
    }
    return $slug;
}

/** @param string[] $args */
function handle(string $handler, array $args, Request $req): Response
{
    switch ($handler) {
        case 'index':
            return Response::json([
                'ok' => true,
                'name' => Config::get('siteName', 'SoftN') . ' directory API',
                'docs' => '/api/README.md',
                'routes' => [
                    'GET /api/apps?q=&category=&tag=&author=&cap=nonet|none|storage|worker&sort=trending|newest|top|remixed|runs|name&page=&perPage=',
                    'GET /api/apps/{slug}',
                    'GET /api/apps/{slug}/bundle.softn?v=&sha256=&download=1',
                    'GET /api/apps/{slug}/thumbnail',
                    'GET /api/apps/{slug}/source?v=',
                    'GET /api/apps/{slug}/comments?page=',
                    'GET /api/apps/{slug}/rating',
                    'GET /api/categories',
                    'POST /api/apps  (multipart bundle=@file, or raw zip body, or JSON {bundleBase64}; fields: name, description, author, category, tags, notes, primary, parent, thumbnail; X-Admin-Key lifts the hourly limit)',
                    'POST /api/apps/{slug}/versions  (X-Edit-Key)',
                    'PATCH /api/apps/{slug}  (X-Edit-Key; JSON fields)',
                    'POST /api/apps/{slug}/thumbnail  (X-Edit-Key)',
                    'DELETE /api/apps/{slug}  (X-Edit-Key)',
                    'POST /api/apps/{slug}/key  (X-Edit-Key; answers with a new edit key, and the old one stops working)',
                    'POST /api/apps/{slug}/remix  (same fields as publish; bundle optional)',
                    'POST /api/apps/{slug}/comments  {name, body}',
                    'POST /api/apps/{slug}/rating  {stars}',
                    'POST /api/apps/{slug}/runs',
                    'POST /api/apps/{slug}/storage  {op, ...}',
                    'POST /api/categories  {name, description, emoji}',
                ],
            ]);

        case 'readme':
            // The docs the index route points at, served as the markdown they are.
            return Response::file(__DIR__ . '/README.md', 'text/markdown; charset=utf-8');

        case 'health': {
            $sqlite = null;
            $writable = false;
            // What each extension is for, so a host without one learns it
            // here and not from a bare 500 on the first request that needs it.
            $extensions = [];
            $warnings = [];
            foreach ([
                'zip' => 'reading bundles: nothing can be published',
                'zlib' => 'checking a bundle\'s compressed files: nothing can be published or listed',
                'mbstring' => 'text handling: most routes fail',
                'pdo_sqlite' => 'per-app storage and the legacy import',
                'dom' => 'checking SVG icons: every SVG icon is dropped',
            ] as $ext => $for) {
                $extensions[$ext] = extension_loaded($ext);
                if (!$extensions[$ext]) $warnings[] = "The PHP extension $ext is not loaded; it is needed for $for.";
            }
            // Without these the catalogue cannot even be read; say so rather
            // than fail on the first bundle it inspects.
            if (!$extensions['zip'] || !$extensions['zlib'] || !$extensions['mbstring']) {
                return Response::json(['ok' => false, 'error' => 'A PHP extension the directory needs is missing.', 'php' => PHP_VERSION, 'extensions' => $extensions, 'warnings' => $warnings], 503);
            }
            try {
                Catalog::boot();
                $writable = is_writable(Config::dataDir());
            } catch (ApiError $e) {
                return Response::json(['ok' => false, 'error' => $e->getMessage(), 'php' => PHP_VERSION, 'extensions' => $extensions], 503);
            }
            $trusted = Config::get('trustedProxies', []);
            $siteOrigin = Pages::origin();
            // What an operator should know before the site is public. The
            // site works without either; what it cannot do is said here.
            if ($siteOrigin === null) {
                $warnings[] = 'siteOrigin is not set in data/config.json: share pages carry no canonical address or og:url, and only this host\'s own pages may use the owner routes, until it is.';
            }
            $forwardedUntrusted = isset($_SERVER['HTTP_X_FORWARDED_FOR']) && count(is_array($trusted) ? Net::ranges($trusted) : []) === 0 && Config::get('trustProxy', false) !== true;
            if ($forwardedUntrusted) {
                $warnings[] = 'This request carried X-Forwarded-For but no proxy is trusted, so every visitor behind the proxy shares one address for rate limits and ratings. List the proxy in trustedProxies (see README, Trusted proxies).';
            }
            return Response::json([
                'ok' => $writable,
                'siteOrigin' => $siteOrigin,
                'warnings' => $warnings,
                'php' => PHP_VERSION,
                'sqlite' => $sqlite,
                'fts5' => false,
                'catalog' => 'folder-json',
                'cache' => 'rebuildable-json',
                'zip' => class_exists('ZipArchive'),
                'extensions' => $extensions,
                'dataWritable' => $writable,
                'uploadMax' => ini_get('upload_max_filesize'),
                'postMax' => ini_get('post_max_size'),
                'memoryLimit' => ini_get('memory_limit'),
                // The API's own request limits, and whether the host's
                // post_max_size and upload_max_filesize cover them.
                'limits' => Limits::describe(),
                // How many proxies are trusted and whether the old boolean
                // is in force — not which addresses: this route is public.
                'proxy' => ['trustedProxies' => is_array($trusted) ? count(Net::ranges($trusted)) : 0, 'legacyTrustProxy' => Config::get('trustProxy', false) === true, 'forwardedButUntrusted' => $forwardedUntrusted],
                // This request's own catalogue timings: the boot above.
                'timings' => Timings::snapshot(),
            ]);
        }

        case 'categories':
            Seed::ifEmpty();
            return Response::json(['ok' => true, 'categories' => Categories::all()]);

        case 'suggestCategory': {
            if (($req->field('website') ?? '') !== '') throw new ApiError(400, 'The suggestion was not accepted.');
            Db::rateLimit('suggest', Config::limitKey($req->ip));
            $c = Categories::suggest((string) $req->field('name'), (string) ($req->field('description') ?? ''), (string) ($req->field('emoji') ?? ''));
            return Response::json(['ok' => true, 'category' => $c], 201);
        }

        case 'listApps':
            Seed::ifEmpty();
            return Response::json(['ok' => true] + Apps::list($req->query));

        case 'publish': {
            if (($req->field('website') ?? '') !== '') throw new ApiError(400, 'The bundle was not accepted.');
            // The hourly limit is for visitors. The site owner, who has the
            // admin key from data/config.json, fills a fresh directory in one
            // batch — a whole folder of bundles dropped on the publish page.
            if (!Config::isAdmin($req->credential('x-admin-key', 'adminKey'))) {
                Db::rateLimit('publish', Config::limitKey($req->ip));
            }
            $file = $req->bundleFile();
            if ($file === null) throw new ApiError(400, 'No bundle was sent. Upload a .softn as the multipart field "bundle", as the raw request body, or as JSON {"bundleBase64": ...}.');
            // The picture is checked before the app exists. Read afterwards,
            // a picture that was refused (not an image, too large) answered
            // 400 for a publish that had already happened: the app was
            // listed, its edit key was never sent to anyone, and the retry
            // published a second one.
            $image = $req->imageUpload();
            // The bundle is checked before the parent is looked up: finding
            // the parent takes the catalogue lock, and the check reads every
            // file in the bundle, which held every other request meanwhile.
            $info = Bundle::inspect($file);
            $parent = $req->field('parent');
            $parentSlug = is_string($parent) && $parent !== '' ? Apps::resolveParent($parent) : null;
            $result = Apps::create($file, [
                'name' => $req->field('name'), 'description' => $req->field('description'), 'author' => $req->field('author'),
                'category' => $req->field('category'), 'tags' => $req->field('tags'), 'notes' => $req->field('notes'),
                'primary' => $req->field('primary'),
            ], $parentSlug !== null ? 'remix' : ($req->contentType() === 'multipart/form-data' ? 'upload' : 'api'), $parentSlug, $info);
            if ($image !== null) {
                Apps::setThumbnail($result['app']['slug'], $image);
                $result['app'] = Apps::card(Apps::row($result['app']['slug']));
            }
            return Response::json(['ok' => true, 'app' => $result['app'], 'editKey' => $result['editKey'], 'page' => $result['app']['urls']['page']], 201);
        }

        case 'appDetail': {
            Seed::ifEmpty();
            $slug = Apps::resolveSlug($args[0]);
            $app = Apps::detail(Apps::row($slug), false);
            // The app's own database is read once the catalogue is let go
            // (Storage::leaveCatalogue): a count over a large store used to
            // hold the directory's one lock for every app page. Who is
            // asking is settled first, since that is the catalogue's to say.
            $app['storage'] = Storage::summaryOutsideCatalogue($slug, Storage::actor($req, $slug));
            return Response::json(['ok' => true, 'app' => $app]);
        }

        case 'patchApp': {
            $slug = Apps::resolveSlug($args[0]);
            Apps::requireOwner($req, $slug);
            $fields = $req->json();
            foreach (['name', 'description', 'author', 'category', 'tags', 'primary'] as $f) {
                $v = $req->field($f);
                if ($v !== null && !array_key_exists($f, $fields)) $fields[$f] = $v;
            }
            if (!Config::isAdmin($req->credential('x-admin-key', 'adminKey'))) unset($fields['hidden']);
            return Response::json(['ok' => true, 'app' => Apps::patch($slug, $fields)]);
        }

        case 'deleteApp': {
            $slug = Apps::resolveSlug($args[0]);
            Apps::requireOwner($req, $slug);
            if (Config::isAdmin($req->credential('x-admin-key', 'adminKey')) && ($req->query['purge'] ?? '') === '1') {
                Apps::remove($slug);
            } else {
                Apps::patch($slug, ['hidden' => true]);
            }
            return Response::noContent();
        }

        case 'bundle': {
            Seed::ifEmpty();
            $slug = Apps::resolveSlug($args[0]);
            $row = Apps::requireBundle($slug);
            $v = requested_version($req);
            $pinned = requested_digest($req);
            $ver = Apps::version($slug, $v);
            $path = Config::dataDir() . '/apps/' . $slug . '/' . $ver['file'];
            if (!is_file($path)) throw new ApiError(404, 'The bundle file is missing.');
            // An address with the digest in it is answered with those bytes
            // or not at all, so it never names two contents and a cache may
            // hold it for a day. A day rather than immutable for a year,
            // because an unpublish or a purge must reach every cache within
            // a day. Without the digest an address can name other bytes
            // tomorrow, the version number included: the seed rewrites a
            // demo's v1 in place, and a purged app's name can be published
            // again from v1. Held for a day, a cache answered with the old
            // bytes, and the play page, which pins the digest, refused the
            // app. So it is revalidated, which the ETag makes cheap.
            if ($pinned !== null && $pinned !== $ver['sha256']) {
                throw new ApiError(404, 'That version of the bundle has been replaced; ask the app for its current address.');
            }
            $type = 'application/octet-stream';
            $headers = [
                'Cache-Control' => $pinned !== null ? 'public, max-age=86400' : 'no-cache, must-revalidate',
                'ETag' => '"' . $ver['sha256'] . '"',
            ] + Response::USER_CONTENT;
            // The validator is the archive's own digest, so a client holding
            // these bytes is told so without them being sent again. Only the
            // headers a cache refreshes from go with the 304: the attachment
            // disposition belongs to a download that is actually happening.
            if ($req->ifNoneMatch($headers['ETag'])) {
                return Response::notModified($headers + ['Content-Type' => $type]);
            }
            if (($req->query['download'] ?? '') === '1') {
                $headers['Content-Disposition'] = 'attachment; filename="' . $slug . '.softn"';
            }
            // Ranges are not implemented, and the response says so rather than
            // leaving it to the host: Apache would otherwise slice this whole
            // output into a 206 by itself, which nginx and the built-in server
            // do not, and a client must not be led to expect a resume that
            // works on one host and not another.
            $headers['Accept-Ranges'] = 'none';
            return Response::file($path, $type, $headers);
        }

        case 'thumbnail':
            return Apps::thumbnailResponse(Apps::resolveSlug($args[0]), $req);

        case 'setThumbnail': {
            // The upload is read before the catalogue is opened, as a new
            // version's is: see addVersion.
            $image = $req->imageUpload();
            $slug = Apps::resolveSlug($args[0]);
            Apps::requireOwner($req, $slug);
            if ($image === null) throw new ApiError(400, 'No image was sent: use the multipart field "thumbnail" or JSON {"thumbnailBase64"}.');
            Apps::setThumbnail($slug, $image);
            return Response::json(['ok' => true, 'app' => Apps::card(Apps::row($slug))]);
        }

        case 'icon':
            return Apps::iconResponse(Apps::resolveSlug($args[0]), $req);

        case 'source': {
            $slug = Apps::resolveSlug($args[0]);
            Apps::requireBundle($slug);
            $v = requested_version($req);
            $ver = Apps::version($slug, $v);
            $path = Config::dataDir() . '/apps/' . $slug . '/' . $ver['file'];
            return Response::json(['ok' => true, 'version' => (int) $ver['version']] + Bundle::listSource($path), 200, ['Cache-Control' => 'public, max-age=300']);
        }

        case 'addVersion': {
            // The upload is read before the catalogue is opened. Resolving
            // the slug takes the catalogue lock, and the lock is held until
            // the request ends; with the body read after it, one client
            // trickling a bundle in held the whole directory, every read
            // included, for as long as its upload took. The bytes are
            // bounded the same way on the publish route, which needs no
            // key at all, so reading them first costs nothing new.
            //
            // The bundle is checked before the catalogue is opened as well:
            // the check reads every file in it, and under the lock it held
            // every other request meanwhile. Since the key is not known to be
            // good until the catalogue is open, the window below is counted
            // first, as publishing's is, so that a request with no key cannot
            // have bundles checked without end. A wrong key is counted, and a
            // request with a wrong key and a bundle that is not one is told
            // about the bundle (400) before the key (403).
            //
            // Its own window, wider than publishing's: an owner iterating on
            // one app is not ten new apps an hour, but a stolen key must not
            // be a way to fill a folder to its version limit in a minute.
            $byAdmin = Config::isAdmin($req->credential('x-admin-key', 'adminKey'));
            if (!$byAdmin) {
                Db::rateLimit('version', Config::limitKey($req->ip));
            }
            $file = $req->bundleFile();
            if ($file === null) throw new ApiError(400, 'No bundle was sent.');
            $info = Bundle::inspect($file);
            $slug = Apps::resolveSlug($args[0]);
            Apps::requireOwner($req, $slug);
            // A linked app takes no bundle: remove play_url from its app.json first.
            Apps::requireBundle($slug);
            return Response::json(['ok' => true, 'app' => Apps::addVersion($slug, $file, $req->field('notes'), $byAdmin, $info)], 201);
        }

        case 'replaceKey': {
            // A key is the only proof of ownership and a bearer secret: one
            // that may have been copied stays good until it is replaced. The
            // check and the write are under the one catalogue lock this
            // request holds from resolveSlug to the reply, so two requests
            // with the same key cannot both replace it. Counted like a new
            // version: after the key is checked, and not for the admin, who
            // uses this to hand an owner who lost theirs a new one.
            $slug = Apps::resolveSlug($args[0]);
            Apps::requireOwner($req, $slug);
            if (!Config::isAdmin($req->credential('x-admin-key', 'adminKey'))) {
                Db::rateLimit('rekey', Config::limitKey($req->ip));
            }
            $key = Apps::replaceKey($slug);
            return Response::json(['ok' => true, 'editKey' => $key, 'app' => Apps::card(Apps::row($slug, true))]);
        }

        case 'remix': {
            if (($req->field('website') ?? '') !== '') throw new ApiError(400, 'The remix was not accepted.');
            Db::rateLimit('publish', Config::limitKey($req->ip));
            // Read before the catalogue is opened; see addVersion. The
            // picture too, and before the remix exists: see publish.
            $file = $req->bundleFile();
            $image = $req->imageUpload();
            // And checked before it, as on the publish route; with no bundle
            // sent, the parent's is copied and checked instead (remix_source).
            $info = $file === null ? null : Bundle::inspect($file);
            $source = $file === null ? remix_source($args[0]) : null;
            $parentSlug = Apps::resolveSlug($args[0]);
            $parent = Apps::requireBundle($parentSlug);
            $copied = false;
            if ($file === null) {
                // No bundle: the remix starts as an exact copy, to be edited later.
                $ver = Apps::version($parentSlug);
                if ($source !== null && $source[1]['sha256'] === $ver['sha256']) [$file, $info] = $source;
                else $file = Config::dataDir() . '/apps/' . $parentSlug . '/' . $ver['file'];
                $copied = true;
            }
            $result = Apps::create($file, [
                'name' => $req->field('name') ?: ($parent['name'] . ' remix'),
                'description' => $req->field('description') ?: $parent['description'],
                'author' => $req->field('author'),
                'category' => $req->field('category') ?: $parent['category'],
                'tags' => $req->field('tags') ?? json_encode(json_decode((string) $parent['tags'], true) ?: []),
                'notes' => $req->field('notes') ?: ($copied ? 'Remixed from ' . $parent['name'] : ''),
                'primary' => $req->field('primary') ?: $parent['primary_color'],
            ], 'remix', $parentSlug, $info);
            if ($image !== null) {
                Apps::setThumbnail($result['app']['slug'], $image);
                $result['app'] = Apps::card(Apps::row($result['app']['slug']));
            }
            return Response::json(['ok' => true, 'app' => $result['app'], 'editKey' => $result['editKey'], 'page' => $result['app']['urls']['page']], 201);
        }

        case 'comments': {
            $slug = Apps::resolveSlug($args[0]);
            return Response::json(['ok' => true] + Social::comments($slug, (int) ($req->query['page'] ?? 1), (int) ($req->query['perPage'] ?? 20)));
        }

        case 'addComment': {
            $slug = Apps::resolveSlug($args[0]);
            Apps::row($slug);
            return Response::json(['ok' => true, 'comment' => Social::addComment($req, $slug)], 201);
        }

        case 'rating':
            return Response::json(['ok' => true, 'rating' => Social::rating($req, Apps::resolveSlug($args[0]))]);

        case 'rate':
            return Response::json(['ok' => true, 'rating' => Social::rate($req, Apps::resolveSlug($args[0]))]);

        case 'run': {
            $slug = Apps::resolveSlug($args[0]);
            Apps::row($slug);
            Social::recordRun($req, $slug, $req->field('stage') === 'launch' ? 'launch' : 'open');
            return Response::noContent();
        }

        case 'storage': {
            $slug = storage_app($args[0]);
            $body = $req->json(true);
            return Response::json(['ok' => true, 'result' => Storage::run($req, $slug, $body)]);
        }

        case 'storageSummary': {
            $slug = storage_app($args[0]);
            $viewer = Storage::actor($req, $slug);
            Storage::leaveCatalogue();
            return Response::json(['ok' => true, 'storage' => Storage::summary($slug, $viewer)]);
        }

        case 'storageList': {
            // The read shape of the query op, as a GET for curiosity and debugging.
            $slug = storage_app($args[0]);
            $body = ['op' => 'query', 'collection' => $args[1], 'limit' => (int) ($req->query['limit'] ?? 50), 'offset' => (int) ($req->query['offset'] ?? 0)];
            if (isset($req->query['orderBy'])) $body['orderBy'] = [$req->query['orderBy'], $req->query['dir'] ?? 'asc'];
            if (isset($req->query['where'])) {
                $w = json_decode($req->query['where'], true);
                if (is_array($w)) $body['where'] = $w;
            }
            return Response::json(['ok' => true, 'result' => Storage::run($req, $slug, $body)]);
        }

        case 'adminCategory': {
            if (!Config::isAdmin($req->credential('x-admin-key', 'adminKey'))) throw new ApiError(403, 'That needs the admin key.');
            return Response::json(['ok' => true, 'category' => Categories::update($args[0], $req->json())]);
        }

        case 'adminDeleteComment': {
            if (!Config::isAdmin($req->credential('x-admin-key', 'adminKey'))) throw new ApiError(403, 'That needs the admin key.');
            Social::hideComment((int) $args[0]);
            return Response::noContent();
        }

        case 'adminStats': {
            if (!Config::isAdmin($req->credential('x-admin-key', 'adminKey'))) throw new ApiError(403, 'That needs the admin key.');
            $rows=Catalog::all();$docs=array_map(fn($a)=>Catalog::doc($a['slug']),$rows);
            return Response::json([
                'ok' => true,
                'apps' => count(array_filter($rows,fn($a)=>!$a['hidden'])),
                'hidden' => count(array_filter($rows,fn($a)=>(bool)$a['hidden'])),
                'versions' => array_sum(array_map(fn($d)=>count($d['versions']),$docs)),
                'comments' => array_sum(array_map(fn($d)=>count($d['comments']),$docs)),
                'ratings' => array_sum(array_map(fn($d)=>count($d['ratings']),$docs)),
                'runs' => array_sum(array_column($rows,'runs')),
                'suggestedCategories' => array_values(array_filter(Categories::all(true), fn($c) => $c['status'] === 'suggested')),
                'dataDir' => Config::dataDir(),
            ]);
        }

        case 'page':
            return Pages::app($args[0]);

        case 'playPage':
            Seed::ifEmpty();
            return Pages::play($args[0]);
    }
    throw new ApiError(404, 'No such route.');
}
