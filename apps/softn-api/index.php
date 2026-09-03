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
// so an open origin costs nothing.
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-Edit-Key, X-Admin-Key');
header('Access-Control-Max-Age: 86400');
header('X-Content-Type-Options: nosniff');

$req = Request::fromGlobals();
if ($req->method === 'OPTIONS') {
    http_response_code(204);
    exit;
}

/** @return array{0: string, 1: string[]}|null */
function match_route(string $method, string $path, array $routes): ?array
{
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
];

try {
    // A browser navigation to /app/<slug> lands here through the rewrite in
    // .htaccess; the request path is the page's own.
    $pagePath = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
    if (is_string($pagePath) && preg_match('#^/app/([^/]+)/?$#', rawurldecode($pagePath), $pm)) {
        Pages::app($pm[1])->send();
        exit;
    }

    $matched = match_route($req->method, $req->path, $routes);
    if ($matched === null) throw new ApiError(404, 'No such route: ' . $req->method . ' ' . $req->path);
    [$handler, $args] = $matched;
    $response = handle($handler, $args, $req);
    $response->send();
} catch (ApiError $e) {
    Response::json(['ok' => false, 'error' => $e->getMessage()] + $e->extra, $e->status,
        isset($e->extra['retryAfter']) ? ['Retry-After' => (string) $e->extra['retryAfter']] : [])->send();
} catch (Throwable $e) {
    error_log('softn-api: ' . $e->getMessage() . ' at ' . $e->getFile() . ':' . $e->getLine());
    Response::json(['ok' => false, 'error' => 'The server could not complete that.'], 500)->send();
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
                    'GET /api/apps/{slug}/bundle.softn?v=&download=1',
                    'GET /api/apps/{slug}/thumbnail',
                    'GET /api/apps/{slug}/source?v=',
                    'GET /api/apps/{slug}/comments?page=',
                    'GET /api/apps/{slug}/rating',
                    'GET /api/categories',
                    'POST /api/apps  (multipart bundle=@file, or raw zip body, or JSON {bundleBase64}; fields: name, description, author, category, tags, notes, primary, parent, thumbnail)',
                    'POST /api/apps/{slug}/versions  (X-Edit-Key)',
                    'PATCH /api/apps/{slug}  (X-Edit-Key; JSON fields)',
                    'POST /api/apps/{slug}/thumbnail  (X-Edit-Key)',
                    'DELETE /api/apps/{slug}  (X-Edit-Key)',
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
            $fts = false;
            $sqlite = null;
            $writable = false;
            try {
                $sqlite = (string) Db::catalog()->query('select sqlite_version()')->fetchColumn();
                $fts = Db::hasFts();
                $writable = is_writable(Config::dataDir());
            } catch (ApiError $e) {
                return Response::json(['ok' => false, 'error' => $e->getMessage(), 'php' => PHP_VERSION], 503);
            }
            return Response::json([
                'ok' => $writable,
                'php' => PHP_VERSION,
                'sqlite' => $sqlite,
                'fts5' => $fts,
                'zip' => class_exists('ZipArchive'),
                'dataWritable' => $writable,
                'uploadMax' => ini_get('upload_max_filesize'),
                'postMax' => ini_get('post_max_size'),
            ]);
        }

        case 'categories':
            Seed::ifEmpty();
            return Response::json(['ok' => true, 'categories' => Categories::all()]);

        case 'suggestCategory': {
            if (($req->field('website') ?? '') !== '') throw new ApiError(400, 'The suggestion was not accepted.');
            Db::rateLimit('suggest', Config::visitorHash($req->ip));
            $c = Categories::suggest((string) $req->field('name'), (string) ($req->field('description') ?? ''), (string) ($req->field('emoji') ?? ''));
            return Response::json(['ok' => true, 'category' => $c], 201);
        }

        case 'listApps':
            Seed::ifEmpty();
            return Response::json(['ok' => true] + Apps::list($req->query));

        case 'publish': {
            if (($req->field('website') ?? '') !== '') throw new ApiError(400, 'The bundle was not accepted.');
            Db::rateLimit('publish', Config::visitorHash($req->ip));
            $file = $req->bundleFile();
            if ($file === null) throw new ApiError(400, 'No bundle was sent. Upload a .softn as the multipart field "bundle", as the raw request body, or as JSON {"bundleBase64": ...}.');
            $parent = $req->field('parent');
            $parentSlug = is_string($parent) && $parent !== '' ? Apps::resolveSlug($parent) : null;
            $result = Apps::create($file, [
                'name' => $req->field('name'), 'description' => $req->field('description'), 'author' => $req->field('author'),
                'category' => $req->field('category'), 'tags' => $req->field('tags'), 'notes' => $req->field('notes'),
                'primary' => $req->field('primary'),
            ], $parentSlug !== null ? 'remix' : ($req->contentType() === 'multipart/form-data' ? 'upload' : 'api'), $parentSlug);
            $image = $req->imageUpload();
            if ($image !== null) {
                Apps::setThumbnail($result['app']['slug'], $image);
                $result['app'] = Apps::card(Apps::row($result['app']['slug']));
            }
            return Response::json(['ok' => true, 'app' => $result['app'], 'editKey' => $result['editKey'], 'page' => $result['app']['urls']['page']], 201);
        }

        case 'appDetail': {
            Seed::ifEmpty();
            $slug = Apps::resolveSlug($args[0]);
            return Response::json(['ok' => true, 'app' => Apps::detail(Apps::row($slug))]);
        }

        case 'patchApp': {
            $slug = Apps::resolveSlug($args[0]);
            Apps::requireOwner($req, $slug);
            $fields = $req->json();
            foreach (['name', 'description', 'author', 'category', 'tags', 'primary'] as $f) {
                $v = $req->field($f);
                if ($v !== null && !array_key_exists($f, $fields)) $fields[$f] = $v;
            }
            if (!Config::isAdmin($req->header('x-admin-key') ?? $req->field('adminKey'))) unset($fields['hidden']);
            return Response::json(['ok' => true, 'app' => Apps::patch($slug, $fields)]);
        }

        case 'deleteApp': {
            $slug = Apps::resolveSlug($args[0]);
            Apps::requireOwner($req, $slug);
            if (Config::isAdmin($req->header('x-admin-key') ?? $req->field('adminKey')) && ($req->query['purge'] ?? '') === '1') {
                Apps::remove($slug);
            } else {
                Apps::patch($slug, ['hidden' => true]);
            }
            return Response::noContent();
        }

        case 'bundle': {
            $slug = Apps::resolveSlug($args[0]);
            $row = Apps::row($slug);
            $v = isset($req->query['v']) ? max(1, (int) $req->query['v']) : null;
            $ver = Apps::version($slug, $v);
            $path = Config::dataDir() . '/apps/' . $slug . '/' . $ver['file'];
            if (!is_file($path)) throw new ApiError(404, 'The bundle file is missing.');
            $headers = ['Cache-Control' => 'public, max-age=300', 'ETag' => '"' . $ver['sha256'] . '"'];
            if (($req->query['download'] ?? '') === '1') {
                $headers['Content-Disposition'] = 'attachment; filename="' . $slug . '.softn"';
            }
            return Response::file($path, 'application/octet-stream', $headers);
        }

        case 'thumbnail':
            return Apps::thumbnailResponse(Apps::resolveSlug($args[0]));

        case 'setThumbnail': {
            $slug = Apps::resolveSlug($args[0]);
            Apps::requireOwner($req, $slug);
            $image = $req->imageUpload();
            if ($image === null) throw new ApiError(400, 'No image was sent: use the multipart field "thumbnail" or JSON {"thumbnailBase64"}.');
            Apps::setThumbnail($slug, $image);
            return Response::json(['ok' => true, 'app' => Apps::card(Apps::row($slug))]);
        }

        case 'icon':
            return Apps::iconResponse(Apps::resolveSlug($args[0]));

        case 'source': {
            $slug = Apps::resolveSlug($args[0]);
            Apps::row($slug);
            $v = isset($req->query['v']) ? max(1, (int) $req->query['v']) : null;
            $ver = Apps::version($slug, $v);
            $path = Config::dataDir() . '/apps/' . $slug . '/' . $ver['file'];
            return Response::json(['ok' => true, 'version' => (int) $ver['version']] + Bundle::listSource($path), 200, ['Cache-Control' => 'public, max-age=300']);
        }

        case 'addVersion': {
            $slug = Apps::resolveSlug($args[0]);
            Apps::requireOwner($req, $slug);
            $file = $req->bundleFile();
            if ($file === null) throw new ApiError(400, 'No bundle was sent.');
            return Response::json(['ok' => true, 'app' => Apps::addVersion($slug, $file, $req->field('notes'))], 201);
        }

        case 'remix': {
            if (($req->field('website') ?? '') !== '') throw new ApiError(400, 'The remix was not accepted.');
            Db::rateLimit('publish', Config::visitorHash($req->ip));
            $parentSlug = Apps::resolveSlug($args[0]);
            $parent = Apps::row($parentSlug);
            $file = $req->bundleFile();
            $copied = false;
            if ($file === null) {
                // No bundle: the remix starts as an exact copy, to be edited later.
                $ver = Apps::version($parentSlug);
                $file = Config::dataDir() . '/apps/' . $parentSlug . '/' . $ver['file'];
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
            ], 'remix', $parentSlug);
            $image = $req->imageUpload();
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
            Social::recordRun($req, $slug);
            return Response::noContent();
        }

        case 'storage': {
            $slug = Apps::resolveSlug($args[0]);
            $row = Apps::row($slug);
            $caps = json_decode((string) $row['capabilities'], true) ?: [];
            if (!in_array('storage', $caps, true)) {
                throw new ApiError(403, 'This app did not declare storage in its permission.json, so it has no server storage.');
            }
            $body = $req->json();
            return Response::json(['ok' => true, 'result' => Storage::run($req, $slug, $body)]);
        }

        case 'storageSummary': {
            $slug = Apps::resolveSlug($args[0]);
            Apps::row($slug);
            return Response::json(['ok' => true, 'storage' => Storage::summary($slug)]);
        }

        case 'storageList': {
            // The read shape of the query op, as a GET for curiosity and debugging.
            $slug = Apps::resolveSlug($args[0]);
            Apps::row($slug);
            $body = ['op' => 'query', 'collection' => $args[1], 'limit' => (int) ($req->query['limit'] ?? 50), 'offset' => (int) ($req->query['offset'] ?? 0)];
            if (isset($req->query['orderBy'])) $body['orderBy'] = [$req->query['orderBy'], $req->query['dir'] ?? 'asc'];
            if (isset($req->query['where'])) {
                $w = json_decode($req->query['where'], true);
                if (is_array($w)) $body['where'] = $w;
            }
            return Response::json(['ok' => true, 'result' => Storage::run($req, $slug, $body)]);
        }

        case 'adminCategory': {
            if (!Config::isAdmin($req->header('x-admin-key') ?? $req->field('adminKey'))) throw new ApiError(403, 'That needs the admin key.');
            return Response::json(['ok' => true, 'category' => Categories::update($args[0], $req->json())]);
        }

        case 'adminDeleteComment': {
            if (!Config::isAdmin($req->header('x-admin-key') ?? $req->field('adminKey'))) throw new ApiError(403, 'That needs the admin key.');
            Social::hideComment((int) $args[0]);
            return Response::noContent();
        }

        case 'adminStats': {
            if (!Config::isAdmin($req->header('x-admin-key') ?? $req->field('adminKey'))) throw new ApiError(403, 'That needs the admin key.');
            $pdo = Db::catalog();
            return Response::json([
                'ok' => true,
                'apps' => (int) $pdo->query('SELECT COUNT(*) FROM apps WHERE hidden = 0')->fetchColumn(),
                'hidden' => (int) $pdo->query('SELECT COUNT(*) FROM apps WHERE hidden = 1')->fetchColumn(),
                'versions' => (int) $pdo->query('SELECT COUNT(*) FROM versions')->fetchColumn(),
                'comments' => (int) $pdo->query('SELECT COUNT(*) FROM comments')->fetchColumn(),
                'ratings' => (int) $pdo->query('SELECT COUNT(*) FROM ratings')->fetchColumn(),
                'runs' => (int) $pdo->query('SELECT COALESCE(SUM(runs), 0) FROM apps')->fetchColumn(),
                'suggestedCategories' => array_values(array_filter(Categories::all(true), fn($c) => $c['status'] === 'suggested')),
                'dataDir' => Config::dataDir(),
            ]);
        }

        case 'page':
            return Pages::app($args[0]);
    }
    throw new ApiError(404, 'No such route.');
}
