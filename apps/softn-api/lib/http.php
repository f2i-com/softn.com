<?php
/**
 * The request/response plumbing the directory API is built on.
 *
 * One PHP script answers everything under /api/. It was written for the
 * hosting softn.com actually deploys to — a document root on Apache, uploaded
 * as a zip — so it needs nothing beyond PHP with pdo_sqlite and zip, and it
 * keeps every piece of state in files under data/. There are no accounts and
 * no session: a publisher is whoever holds the edit key handed out at publish
 * time, and everyone else is a visitor identified only by a salted hash of
 * their address, kept just long enough to rate-limit and to count one rating
 * per person.
 */
declare(strict_types=1);

final class ApiError extends RuntimeException
{
    public int $status;
    /** @var array<string, mixed> */
    public array $extra;

    /** @param array<string, mixed> $extra */
    public function __construct(int $status, string $message, array $extra = [])
    {
        parent::__construct($message);
        $this->status = $status;
        $this->extra = $extra;
    }
}

/**
 * How much of a request the API is willing to take, in one place.
 *
 * The byte limits live in data/config.json (`maxJsonBytes`, `maxBundleBytes`,
 * `maxThumbnailBytes`, `maxThumbnailSide`, `maxThumbnailPixels`); what is
 * decided here is which limit a route gets, before a byte of its body is
 * read. A route that carries no file — a comment, a storage operation, a
 * PATCH — gets the JSON limit, which is small. A route that takes a bundle
 * gets an envelope wide enough for the bundle and a thumbnail in base64
 * plus the fields; the thumbnail route, the same for one image. The raw
 * bundle body and the decoded bundle are held to `maxBundleBytes` itself,
 * whatever they arrived wrapped in.
 *
 * These are the API's own limits. PHP's `post_max_size` and
 * `upload_max_filesize`, and whatever the web server in front sets, have to
 * be at least the bundle envelope or the host refuses (or silently drops)
 * an upload the API would have taken; api/.user.ini asks for 64 MB and
 * `GET /api/health` reports whether the host agrees (`limits.hostAligned`).
 */
final class Limits
{
    /** Overhead of base64 on `$bytes`, with room for a data: URL prefix. */
    public static function base64Of(int $bytes): int
    {
        return intdiv($bytes + 2, 3) * 4 + 128;
    }

    public static function json(): int
    {
        return max(1024, (int) Config::get('maxJsonBytes', 256 * 1024));
    }

    public static function bundle(): int
    {
        return max(1024, (int) Config::get('maxBundleBytes', 32 * 1024 * 1024));
    }

    public static function thumbnail(): int
    {
        return max(1024, (int) Config::get('maxThumbnailBytes', 2 * 1024 * 1024));
    }

    /** The longest side an uploaded image may declare, in pixels. */
    public static function imageSide(): int
    {
        return max(1, (int) Config::get('maxThumbnailSide', 8192));
    }

    /** The most pixels an uploaded image may declare (width × height). */
    public static function imagePixels(): int
    {
        return max(1, (int) Config::get('maxThumbnailPixels', 16 * 1000 * 1000));
    }

    /** The JSON body of a route that takes a bundle: bundle and thumbnail in base64, and the fields. */
    public static function bundleEnvelope(): int
    {
        return self::base64Of(self::bundle()) + self::base64Of(self::thumbnail()) + self::json();
    }

    /** The JSON body of the thumbnail route: the image in base64 and the fields. */
    public static function imageEnvelope(): int
    {
        return self::base64Of(self::thumbnail()) + self::json();
    }

    /**
     * The body limit of a route, from the method and path alone. The routes
     * are matched the way index.php matches them; a route not named here is
     * one that carries fields at most.
     */
    public static function bodyLimit(string $method, string $path): int
    {
        if ($method === 'POST' && preg_match('#^/apps(?:/[^/]+/(?:versions|remix))?$#', $path)) return self::bundleEnvelope();
        if ($method === 'POST' && preg_match('#^/apps/[^/]+/thumbnail$#', $path)) return self::imageEnvelope();
        return self::json();
    }

    /** An ini size ("64M", "2G", "8388608") in bytes; null when unset or unlimited. */
    public static function iniBytes(string $key): ?int
    {
        $raw = ini_get($key);
        if (!is_string($raw)) return null;
        $raw = trim($raw);
        if ($raw === '' || $raw === '-1') return null;
        if (!preg_match('/^(\d+)\s*([kmgKMG]?)$/', $raw, $m)) return null;
        $n = (int) $m[1];
        $n *= match (strtolower($m[2])) { 'k' => 1024, 'm' => 1024 * 1024, 'g' => 1024 * 1024 * 1024, default => 1 };
        return $n > 0 ? $n : null;
    }

    /** Whether PHP's own upload limits cover the widest body the API accepts. */
    public static function hostAligned(): bool
    {
        $post = self::iniBytes('post_max_size');
        $upload = self::iniBytes('upload_max_filesize');
        return ($post === null || $post >= self::bundleEnvelope()) && ($upload === null || $upload >= self::bundle());
    }

    /** The limits as /api/health reports them. @return array<string, mixed> */
    public static function describe(): array
    {
        return [
            'json' => self::json(),
            'bundle' => self::bundle(),
            'thumbnail' => self::thumbnail(),
            'bundleEnvelope' => self::bundleEnvelope(),
            'imageEnvelope' => self::imageEnvelope(),
            'imageSide' => self::imageSide(),
            'imagePixels' => self::imagePixels(),
            'hostAligned' => self::hostAligned(),
        ];
    }

    public static function human(int $bytes): string
    {
        if ($bytes >= 1024 * 1024) return rtrim(rtrim(number_format($bytes / 1048576, 1, '.', ''), '0'), '.') . ' MB';
        if ($bytes >= 1024) return rtrim(rtrim(number_format($bytes / 1024, 1, '.', ''), '0'), '.') . ' KB';
        return "$bytes bytes";
    }
}

/**
 * Temporary files the request makes for itself: a raw bundle spooled from
 * the body, a decoded base64 bundle. PHP removes a multipart upload's file
 * when the request ends; these it does not know about, so every one is
 * recorded here and removed at shutdown whatever the request went on to do
 * — a refusal that throws out of a handler, a fatal, a bundle that turned
 * out not to be one. A caller that is done with one sooner discards it.
 */
final class TempFiles
{
    /** @var array<string, true> */
    private static array $paths = [];
    private static bool $registered = false;

    public static function create(): string
    {
        $tmp = tempnam(sys_get_temp_dir(), 'softn-');
        if ($tmp === false) throw new ApiError(500, 'Could not create a temporary file.');
        self::$paths[$tmp] = true;
        if (!self::$registered) {
            self::$registered = true;
            register_shutdown_function([self::class, 'cleanup']);
        }
        return $tmp;
    }

    public static function spill(string $bytes): string
    {
        $tmp = self::create();
        if (file_put_contents($tmp, $bytes) !== strlen($bytes)) {
            self::discard($tmp);
            throw new ApiError(500, 'Could not write a temporary file.');
        }
        return $tmp;
    }

    public static function discard(string $path): void
    {
        unset(self::$paths[$path]);
        if (is_file($path)) @unlink($path);
    }

    public static function cleanup(): void
    {
        foreach (array_keys(self::$paths) as $p) @unlink($p);
        self::$paths = [];
    }
}

final class Request
{
    /** The most X-Forwarded-For hops that are looked at, from the right. */
    private const MAX_FORWARDED_HOPS = 16;
    /** How much of the body is read at a time. */
    private const CHUNK = 65536;

    public string $method;
    /** The path below /api, always starting with a slash and never ending in one. */
    public string $path;
    /** @var array<string, string> */
    public array $query;
    /** @var array<string, string> lower-cased header names */
    public array $headers;
    public string $ip;
    /** The body limit of this route, settled before the body is touched. */
    private int $bodyLimit = 0;
    private ?string $rawBody = null;
    /** Whether php://input has been read, by whichever reader got there first. */
    private bool $bodyConsumed = false;
    /** @var array<string, mixed>|null */
    private ?array $jsonBody = null;
    private bool $jsonParsed = false;

    public static function fromGlobals(): self
    {
        $r = new self();
        $r->method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
        $uri = $_SERVER['REQUEST_URI'] ?? '/';
        $path = parse_url($uri, PHP_URL_PATH);
        $path = is_string($path) ? rawurldecode($path) : '/';
        // Served as /api/... on the site and as /... when the script is the
        // document root of its own host; both are accepted.
        $path = preg_replace('#^/api(?=/|$)#', '', $path) ?? $path;
        $path = '/' . trim($path, '/');
        $r->path = $path;
        $r->query = [];
        foreach ($_GET as $k => $v) {
            if (is_string($k) && is_string($v)) $r->query[$k] = $v;
        }
        $r->headers = [];
        foreach ($_SERVER as $k => $v) {
            if (str_starts_with($k, 'HTTP_') && is_string($v)) {
                $name = strtolower(str_replace('_', '-', substr($k, 5)));
                $r->headers[$name] = $v;
            }
        }
        if (isset($_SERVER['CONTENT_TYPE']) && is_string($_SERVER['CONTENT_TYPE'])) {
            $r->headers['content-type'] = $_SERVER['CONTENT_TYPE'];
        }
        if (isset($_SERVER['CONTENT_LENGTH']) && is_string($_SERVER['CONTENT_LENGTH'])) {
            $r->headers['content-length'] = $_SERVER['CONTENT_LENGTH'];
        }
        $r->ip = self::clientIp();
        $r->bodyLimit = Limits::bodyLimit($r->method, $r->path);
        return $r;
    }

    /**
     * The visitor's address, as the configuration says it may be learned.
     *
     * `trustedProxies` in data/config.json lists the peers (addresses or
     * CIDR ranges, IPv4 and IPv6) allowed to say who a request is from; the
     * older `trustProxy: true` means "trust the peer this request came in
     * on, whoever it is", for a host that only its own edge can reach. See
     * resolveClientIp for the walk.
     */
    private static function clientIp(): string
    {
        $socket = $_SERVER['REMOTE_ADDR'] ?? '';
        $xff = $_SERVER['HTTP_X_FORWARDED_FOR'] ?? null;
        $trusted = Config::get('trustedProxies', []);
        return self::resolveClientIp(is_string($socket) ? $socket : '', is_string($xff) ? $xff : null, is_array($trusted) ? $trusted : [], Config::get('trustProxy', false) === true);
    }

    /**
     * Who a request is from, given the peer it arrived on and what it says.
     *
     * X-Forwarded-For is a list every proxy appends to, so the rightmost
     * entry is what the last proxy saw and everything to its left is what
     * the request already carried — which a client may have written itself.
     * The header is believed only when the peer is trusted: `$trustedProxies`
     * names the addresses and ranges that are, and `$trustImmediatePeer`
     * (the old boolean) counts whatever peer this request came in on as
     * trusted. The chain is then walked from the right, skipping every
     * address that is itself a trusted proxy (a hop, not a client), and the
     * first address that is not one is the client. A malformed entry met on
     * the walk, an empty header, a chain of nothing but trusted hops longer
     * than a chain has any business being: the peer's own address, which is
     * always a real one. When every hop is trusted the leftmost is the
     * client — one of our own, but the only answer there is.
     *
     * A client on an untrusted peer therefore cannot pick its identity: its
     * header is not read. A client behind a trusted edge cannot either: what
     * it prepends sits to the left of the entry the edge appended, and the
     * walk stops at that entry. A REMOTE_ADDR that is not an address at
     * all is nobody (0.0.0.0), and nobody is trusted.
     *
     * @param string[] $trustedProxies addresses and CIDR ranges; malformed entries are ignored
     */
    public static function resolveClientIp(string $remoteAddr, ?string $forwardedFor, array $trustedProxies, bool $trustImmediatePeer = false): string
    {
        $peer = Net::normalize($remoteAddr);
        if ($peer === null) return '0.0.0.0';
        $ranges = Net::ranges($trustedProxies);
        $isTrusted = static fn(string $ip): bool => Net::inRanges($ip, $ranges) || ($trustImmediatePeer && $ip === $peer);
        if (!$isTrusted($peer)) return $peer;
        if (!is_string($forwardedFor) || trim($forwardedFor) === '') return $peer;
        $hops = array_map('trim', explode(',', $forwardedFor));
        $seen = 0;
        $leftmost = null;
        for ($i = count($hops) - 1; $i >= 0; $i--) {
            if (++$seen > self::MAX_FORWARDED_HOPS) return $peer;
            $ip = Net::normalize(Net::stripPort($hops[$i]));
            if ($ip === null) return $peer;
            if (!$isTrusted($ip)) return $ip;
            $leftmost = $ip;
        }
        return $leftmost ?? $peer;
    }

    public function header(string $name): ?string
    {
        return $this->headers[strtolower($name)] ?? null;
    }

    public function contentType(): string
    {
        $ct = $this->header('content-type') ?? '';
        return strtolower(trim(explode(';', $ct)[0]));
    }

    /**
     * Whether If-None-Match names this entity tag, so a GET or HEAD can answer
     * 304 instead of sending the representation again (RFC 9110 §13.1.2).
     * The comparison is the weak one the RFC prescribes for this header: a
     * W/ prefix on either side is ignored and only the opaque tags have to be
     * identical, and `*` matches whatever the current representation is. The
     * tags are picked out by their quotes rather than split on commas, since
     * a comma is a legal character inside one.
     */
    public function ifNoneMatch(string $etag): bool
    {
        $raw = $this->header('if-none-match');
        if ($raw === null) return false;
        if (trim($raw) === '*') return true;
        $want = preg_replace('#^W/#', '', trim($etag)) ?? $etag;
        preg_match_all('#"[^"]*"#', $raw, $m);
        return in_array($want, $m[0], true);
    }

    /** The body limit this route was given; what a 413 from here names. */
    public function bodyLimit(): int
    {
        return $this->bodyLimit;
    }

    /** The Content-Length the client declared, or null when it declared none (or nonsense). */
    public function declaredLength(): ?int
    {
        $raw = $this->header('content-length');
        if ($raw === null || !preg_match('/^\d{1,18}$/', trim($raw))) return null;
        return (int) trim($raw);
    }

    private static function tooLarge(int $limit, string $what = 'The request body'): ApiError
    {
        return new ApiError(413, "$what is larger than this route accepts (" . Limits::human($limit) . ').', ['limit' => $limit]);
    }

    /**
     * Refuse from the declared length alone, before a byte is read: a
     * Content-Length past the route's limit, or past what PHP itself will
     * pass on. The second is the host's limit, not the API's, and the reply
     * says where to raise it — otherwise the body arrives empty and the
     * publish fails with "no bundle was sent", which is not what happened.
     */
    private function admitDeclared(int $limit, string $what): void
    {
        $declared = $this->declaredLength();
        if ($declared === null) return;
        if ($declared > $limit) throw self::tooLarge($limit, $what);
        $post = Limits::iniBytes('post_max_size');
        if ($post !== null && $declared > $post) {
            throw new ApiError(413, "The request body ($declared bytes) is larger than this host's post_max_size (" . ini_get('post_max_size') . '). Raise post_max_size and upload_max_filesize to at least ' . Limits::human(Limits::bundleEnvelope()) . ' where this host reads them (api/.user.ini, .htaccess or php.ini; see README, Limits).', ['limit' => $post]);
        }
    }

    /**
     * php://input in bounded pieces, stopping one byte past `$limit` and
     * refusing there — the rest of an oversized body is never read, whatever
     * the client declared. With `$sink`, each piece goes to the callback
     * instead of a string (a bundle spooled to a file) and the byte count
     * comes back. The count is the bytes actually read: a declared length
     * that does not match it is refused as well, since one of the two is a
     * lie and the reader cannot know which. `$what` names the thing in a
     * refusal. On the command line — the tests drive the reader there, it
     * being the one place a body can be longer than its Content-Length —
     * the body is stdin, which this PHP does not put behind php://input.
     *
     * @param callable(string): void|null $sink
     */
    private function readBounded(int $limit, ?callable $sink = null, string $what = 'The request body'): string|int
    {
        $this->admitDeclared($limit, $what);
        $declared = $this->declaredLength();
        $in = @fopen(PHP_SAPI === 'cli' ? 'php://stdin' : 'php://input', 'rb');
        if ($in === false) return $sink === null ? '' : 0;
        $total = 0;
        $buf = '';
        try {
            while (!feof($in)) {
                $chunk = fread($in, min(self::CHUNK, $limit + 1 - $total));
                if ($chunk === false || $chunk === '') break;
                $total += strlen($chunk);
                if ($total > $limit) throw self::tooLarge($limit, $what);
                if ($sink === null) $buf .= $chunk;
                else $sink($chunk);
            }
        } finally {
            fclose($in);
        }
        if ($declared !== null && $declared !== $total) {
            throw new ApiError(400, "The request body is $total bytes; its Content-Length said $declared.");
        }
        return $sink === null ? $buf : $total;
    }

    /**
     * The body as a string, within the route's limit. A JSON body that has
     * already been decoded, or a raw bundle already spooled to a file, has
     * been consumed: this returns '' rather than reading php://input twice.
     */
    public function body(): string
    {
        if ($this->rawBody === null) {
            if ($this->bodyConsumed) return '';
            $this->bodyConsumed = true;
            $this->rawBody = $this->readBounded($this->bodyLimit);
        }
        return $this->rawBody;
    }

    /**
     * The JSON body, decoded once. The text is not kept after decoding: on a
     * bundle route it is tens of megabytes of base64 that json_decode has
     * already copied into the array, and holding both is what brought the
     * peak close to memory_limit.
     *
     * @return array<string, mixed>
     */
    public function json(): array
    {
        if (!$this->jsonParsed) {
            $this->jsonParsed = true;
            if ($this->contentType() === 'application/json') {
                if ($this->bodyConsumed && $this->rawBody === null) throw new ApiError(400, 'The request body was already read as a bundle.');
                $body = $this->body();
                $this->rawBody = null;
                $decoded = json_decode($body, true, 64);
                unset($body);
                if (!is_array($decoded)) throw new ApiError(400, 'The request body is not valid JSON.');
                $this->jsonBody = $decoded;
            } else {
                $this->jsonBody = [];
            }
        }
        return $this->jsonBody ?? [];
    }

    /**
     * A field from wherever it was sent: a JSON body, a form body or the query
     * string, in that order. Publishing from a browser is a multipart form;
     * publishing from a script is usually JSON or a raw bundle with the fields
     * in the query, and none of the handlers should have to know which.
     */
    public function field(string $name): ?string
    {
        $json = $this->json();
        if (array_key_exists($name, $json)) {
            $v = $json[$name];
            if (is_string($v)) return $v;
            if (is_int($v) || is_float($v)) return (string) $v;
            if (is_bool($v)) return $v ? '1' : '0';
            if (is_array($v)) return json_encode($v, JSON_UNESCAPED_UNICODE) ?: null;
            return null;
        }
        if (isset($_POST[$name]) && is_string($_POST[$name])) return $_POST[$name];
        if (isset($this->query[$name])) return $this->query[$name];
        return null;
    }

    /**
     * A key — the edit key or the admin key — from its header or from the
     * body, and never from the query string, unlike field(): a URL is what
     * ends up in access logs, browser history and Referer headers.
     */
    public function credential(string $header, string $field): ?string
    {
        $v = $this->header($header);
        if ($v !== null) return $v;
        $json = $this->json();
        if (is_string($json[$field] ?? null)) return $json[$field];
        if (isset($_POST[$field]) && is_string($_POST[$field])) return $_POST[$field];
        return null;
    }

    /**
     * The uploaded bundle, as a path to a temporary file. Three ways in: a
     * multipart field named `bundle`, a raw zip as the whole body, or a JSON
     * body with the bytes in `bundleBase64`. Returns null when none was sent.
     * Each way is held to `maxBundleBytes` before the bytes exist in full: a
     * multipart file by its size on disk, a raw body as it is spooled to a
     * file, chunk by chunk, and a base64 field by what its length would
     * decode to, before it is decoded.
     */
    public function bundleFile(): ?string
    {
        $max = Limits::bundle();
        // A multipart body PHP would not read — past post_max_size — arrives
        // here with no file at all, and "no bundle was sent" would be the
        // wrong story. The declared length tells it.
        if ($this->contentType() === 'multipart/form-data' && !isset($_FILES['bundle'])) $this->admitDeclared(Limits::bundleEnvelope(), 'The upload');
        if (isset($_FILES['bundle']) && is_array($_FILES['bundle'])) {
            $f = $_FILES['bundle'];
            $err = (int) ($f['error'] ?? UPLOAD_ERR_NO_FILE);
            if ($err === UPLOAD_ERR_INI_SIZE || $err === UPLOAD_ERR_FORM_SIZE) {
                throw new ApiError(413, 'The bundle is larger than this host accepts (upload_max_filesize is ' . ini_get('upload_max_filesize') . '). Raise it in api/.user.ini or wherever this host reads it; see README, Limits.', ['limit' => Limits::iniBytes('upload_max_filesize')]);
            }
            if ($err !== UPLOAD_ERR_OK) throw new ApiError(400, 'The bundle upload did not complete.');
            $tmp = $f['tmp_name'] ?? '';
            if (!is_string($tmp) || !is_uploaded_file($tmp)) throw new ApiError(400, 'The bundle upload is not readable.');
            if (filesize($tmp) > $max) throw self::tooLarge($max, 'The bundle');
            return $tmp;
        }
        $ct = $this->contentType();
        if ($ct === 'application/octet-stream' || $ct === 'application/zip' || $ct === 'application/x-softn') {
            if ($this->bodyConsumed) return null;
            $this->bodyConsumed = true;
            $tmp = TempFiles::create();
            try {
                $out = fopen($tmp, 'wb');
                if ($out === false) throw new ApiError(500, 'Could not write a temporary file.');
                try {
                    $n = $this->readBounded($max, static function (string $chunk) use ($out): void {
                        if (fwrite($out, $chunk) !== strlen($chunk)) throw new ApiError(500, 'Could not write a temporary file.');
                    }, 'The bundle');
                } finally {
                    fclose($out);
                }
            } catch (Throwable $e) {
                TempFiles::discard($tmp);
                throw $e;
            }
            if ($n === 0) {
                TempFiles::discard($tmp);
                return null;
            }
            return $tmp;
        }
        if ($ct === 'application/json') {
            $json = $this->json();
            $b64 = $json['bundleBase64'] ?? null;
            if (is_string($b64) && $b64 !== '') {
                // The array's copy goes as soon as this one exists; the
                // decoded bytes are on their way and nothing needs it again.
                unset($this->jsonBody['bundleBase64'], $json);
                // A data: URL prefix is tolerated; a browser hands one over.
                $b64 = preg_replace('#^data:[^,]*,#', '', $b64) ?? $b64;
                if (self::decodedUpperBound($b64) > $max) throw self::tooLarge($max, 'The bundle');
                $bytes = base64_decode($b64, true);
                unset($b64);
                if ($bytes === false) throw new ApiError(400, 'bundleBase64 is not valid base64.');
                if (strlen($bytes) > $max) throw self::tooLarge($max, 'The bundle');
                return TempFiles::spill($bytes);
            }
        }
        return null;
    }

    /** The most bytes a base64 text can decode to, from its length alone. */
    private static function decodedUpperBound(string $b64): int
    {
        return intdiv(strlen(rtrim($b64, "=\r\n\t ")) * 3, 4);
    }

    /**
     * An uploaded image: the multipart field `thumbnail`, or `thumbnailBase64`
     * in a JSON body. Returns [bytes, mime] once validated, or null. The bytes
     * are held to `maxThumbnailBytes` before they exist in full, the same
     * three ways as a bundle; then the header is read for the dimensions the
     * image declares, and one past the side or pixel budget is refused
     * before anything would decode it. The directory decodes no image today
     * — it stores and serves the file — but a thumbnail is shown by every
     * browser that lists the app, and a header claiming ten gigapixels is
     * not a picture.
     *
     * @return array{0: string, 1: string}|null
     */
    public function imageUpload(string $field = 'thumbnail'): ?array
    {
        $max = Limits::thumbnail();
        $bytes = null;
        if ($this->contentType() === 'multipart/form-data' && !isset($_FILES[$field]) && $_FILES === [] && $_POST === []) $this->admitDeclared(Limits::imageEnvelope(), 'The upload');
        if (isset($_FILES[$field]) && is_array($_FILES[$field])) {
            $f = $_FILES[$field];
            $err = (int) ($f['error'] ?? UPLOAD_ERR_NO_FILE);
            if ($err === UPLOAD_ERR_NO_FILE) return null;
            if ($err === UPLOAD_ERR_INI_SIZE || $err === UPLOAD_ERR_FORM_SIZE) throw self::tooLarge($max, 'The image');
            if ($err !== UPLOAD_ERR_OK) throw new ApiError(400, 'The image upload did not complete.');
            $tmp = $f['tmp_name'] ?? '';
            if (!is_string($tmp) || !is_uploaded_file($tmp)) throw new ApiError(400, 'The image upload is not readable.');
            if (filesize($tmp) > $max) throw self::tooLarge($max, 'The image');
            // The header first, from the file, before its bytes are in memory.
            $head = (string) file_get_contents($tmp, false, null, 0, 4096);
            $mime = Images::sniff($head);
            if ($mime === null) throw new ApiError(400, 'The image must be a PNG, JPEG, WebP or GIF.');
            Images::checkBudget(@getimagesize($tmp));
            $bytes = (string) file_get_contents($tmp);
        } else {
            $b64 = $this->json()[$field . 'Base64'] ?? null;
            if (!is_string($b64) || $b64 === '') return null;
            unset($this->jsonBody[$field . 'Base64']);
            $b64 = preg_replace('#^data:[^,]*,#', '', $b64) ?? $b64;
            if (self::decodedUpperBound($b64) > $max) throw self::tooLarge($max, 'The image');
            $decoded = base64_decode($b64, true);
            unset($b64);
            if ($decoded === false) throw new ApiError(400, "{$field}Base64 is not valid base64.");
            if (strlen($decoded) > $max) throw self::tooLarge($max, 'The image');
            $mime = Images::sniff($decoded);
            if ($mime === null) throw new ApiError(400, 'The image must be a PNG, JPEG, WebP or GIF.');
            Images::checkBudget(@getimagesizefromstring($decoded));
            $bytes = $decoded;
        }
        return [$bytes, $mime];
    }
}

/**
 * Addresses and ranges, for the trusted-proxy policy: IPv4 and IPv6 alike,
 * compared as the bytes inet_pton gives.
 */
final class Net
{
    /**
     * An address in canonical form, or null for anything that is not one.
     * An IPv4 address carried inside IPv6 (::ffff:10.0.0.7, what a
     * dual-stack listener reports) is folded to the IPv4 it is, so a range
     * written for IPv4 matches it.
     */
    public static function normalize(string $ip): ?string
    {
        $ip = trim($ip);
        if ($ip === '') return null;
        if (str_starts_with($ip, '[') && str_ends_with($ip, ']')) $ip = substr($ip, 1, -1);
        $packed = @inet_pton($ip);
        if ($packed === false) return null;
        if (strlen($packed) === 16 && substr($packed, 0, 12) === "\0\0\0\0\0\0\0\0\0\0\xff\xff") $packed = substr($packed, 12);
        $text = inet_ntop($packed);
        return is_string($text) ? strtolower($text) : null;
    }

    /** `1.2.3.4:5678` and `[2001:db8::1]:443` without their ports; anything else as it was. */
    public static function stripPort(string $entry): string
    {
        $entry = trim($entry);
        if (preg_match('/^(\[[0-9a-fA-F:.]+\]):\d{1,5}$/', $entry, $m)) return $m[1];
        if (preg_match('/^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/', $entry, $m)) return $m[1];
        return $entry;
    }

    /**
     * Ranges as [packed network, prefix bits], from addresses and CIDR
     * strings. An entry that is not one is skipped: a typo in the list must
     * not open the policy, and must not close the rest of it either.
     *
     * @param mixed[] $list
     * @return array<int, array{0: string, 1: int}>
     */
    public static function ranges(array $list): array
    {
        $out = [];
        foreach ($list as $entry) {
            if (!is_string($entry)) continue;
            $entry = trim($entry);
            $bits = null;
            if (str_contains($entry, '/')) {
                [$entry, $suffix] = explode('/', $entry, 2);
                if (!preg_match('/^\d{1,3}$/', $suffix)) continue;
                $bits = (int) $suffix;
            }
            $ip = self::normalize($entry);
            if ($ip === null) continue;
            $packed = inet_pton($ip);
            if ($packed === false) continue;
            $width = strlen($packed) * 8;
            if ($bits === null) $bits = $width;
            if ($bits < 0 || $bits > $width) continue;
            $out[] = [$packed, $bits];
        }
        return $out;
    }

    /** @param array<int, array{0: string, 1: int}> $ranges */
    public static function inRanges(string $ip, array $ranges): bool
    {
        $packed = @inet_pton($ip);
        if ($packed === false) return false;
        foreach ($ranges as [$net, $bits]) {
            if (strlen($net) !== strlen($packed)) continue;
            if (self::prefixMatches($packed, $net, $bits)) return true;
        }
        return false;
    }

    private static function prefixMatches(string $a, string $b, int $bits): bool
    {
        $bytes = intdiv($bits, 8);
        if ($bytes > 0 && substr($a, 0, $bytes) !== substr($b, 0, $bytes)) return false;
        $rest = $bits % 8;
        if ($rest === 0) return true;
        $mask = (0xff << (8 - $rest)) & 0xff;
        return (ord($a[$bytes]) & $mask) === (ord($b[$bytes]) & $mask);
    }
}

final class Response
{
    public int $status;
    /** @var array<string, string> */
    public array $headers;
    public string $body;
    /** When set, the body is streamed from this file instead. */
    public ?string $file = null;
    /** The file, open since the response was built. @var resource|null */
    private $handle = null;

    /** @param array<string, string> $headers */
    private function __construct(int $status, array $headers, string $body)
    {
        $this->status = $status;
        $this->headers = $headers;
        $this->body = $body;
    }

    /** @param array<string, string> $headers */
    public static function json(mixed $data, int $status = 200, array $headers = []): self
    {
        $encoded = json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        if ($encoded === false) $encoded = '{"ok":false,"error":"The response could not be encoded."}';
        return new self($status, $headers + ['Content-Type' => 'application/json; charset=utf-8', 'Cache-Control' => 'no-store'], $encoded);
    }

    public static function noContent(): self
    {
        return new self(204, ['Cache-Control' => 'no-store'], '');
    }

    /** @param array<string, string> $headers */
    public static function html(string $html, int $status = 200, array $headers = []): self
    {
        // Cross-origin isolation, as the deployed .htaccess also sets it, so a
        // page served through the API (an app's share page) is isolated too:
        // the runtime in its popup then gets SharedArrayBuffer, and a model
        // on the CPU provider uses every core.
        return new self($status, $headers + [
            'Content-Type' => 'text/html; charset=utf-8',
            'Cross-Origin-Opener-Policy' => 'same-origin',
            'Cross-Origin-Embedder-Policy' => 'credentialless',
        ], $html);
    }

    /** @param array<string, string> $headers */
    public static function bytes(string $bytes, string $contentType, array $headers = []): self
    {
        return new self(200, $headers + ['Content-Type' => $contentType], $bytes);
    }

    /** @param array<string, string> $headers */
    public static function file(string $path, string $contentType, array $headers = []): self
    {
        // Opened now, under the catalogue lock, not in send() after it is
        // released: an unpublish or a seed replacing the file in between
        // would otherwise send a body that does not match the length, or
        // none. What the handle is open on is what the length was taken from.
        $fh = @fopen($path, 'rb');
        if ($fh === false) throw new ApiError(404, 'The file is missing.');
        $size = fstat($fh)['size'] ?? filesize($path);
        $r = new self(200, $headers + ['Content-Type' => $contentType, 'Content-Length' => (string) $size], '');
        $r->file = $path;
        $r->handle = $fh;
        return $r;
    }

    /**
     * A 304 for a conditional GET whose validator matched: the headers a
     * cache refreshes its stored copy from and no content, so no
     * Content-Length either — the cache keeps the length it stored. The
     * representation's Content-Type belongs among the headers: PHP adds its
     * text/html default to any response that names none, header_remove()
     * does not stop it, and a cache replaces the headers it holds with the
     * ones a 304 carries (RFC 9111 §4.3.4), so a 304 without one would
     * relabel a stored archive as HTML.
     *
     * @param array<string, string> $headers
     */
    public static function notModified(array $headers): self
    {
        return new self(304, $headers, '');
    }

    public function send(): void
    {
        http_response_code($this->status);
        foreach ($this->headers as $k => $v) header("$k: $v");
        if ($this->status === 304) return;
        // HEAD is GET without the content: the same status and headers,
        // Content-Length included, since the length is what HEAD is usually
        // asked for. Apache and nginx would discard the content themselves;
        // PHP's built-in server passes through whatever is printed, so the
        // content is simply never printed. A file response already carries its
        // length; a string body gets one here, where it is known.
        $head = ($_SERVER['REQUEST_METHOD'] ?? '') === 'HEAD';
        if ($this->file !== null) {
            if (!$head && is_resource($this->handle)) fpassthru($this->handle);
            if (is_resource($this->handle)) fclose($this->handle);
            $this->handle = null;
            return;
        }
        if ($head) {
            if (!in_array('content-length', array_map('strtolower', array_keys($this->headers)), true)) {
                header('Content-Length: ' . strlen($this->body));
            }
            return;
        }
        echo $this->body;
    }
}

final class Images
{
    /** The image's MIME type from its bytes, for the four types a thumbnail may be. */
    public static function sniff(string $bytes): ?string
    {
        if (str_starts_with($bytes, "\x89PNG\r\n\x1a\n")) return 'image/png';
        if (str_starts_with($bytes, "\xFF\xD8\xFF")) return 'image/jpeg';
        if (str_starts_with($bytes, 'GIF87a') || str_starts_with($bytes, 'GIF89a')) return 'image/gif';
        if (str_starts_with($bytes, 'RIFF') && substr($bytes, 8, 4) === 'WEBP') return 'image/webp';
        return null;
    }

    /**
     * Refuse an image whose header declares more than the budget: more
     * pixels on a side than `maxThumbnailSide`, or more in all than
     * `maxThumbnailPixels`. `$info` is what getimagesize read from the
     * header — a few bytes, before any decoder would have allocated the
     * width × height × 4 the picture claims. A header getimagesize cannot
     * read is refused too: a file that is not a picture to PHP is not one
     * to the browsers that would show it.
     *
     * @param array<int|string, mixed>|false $info
     */
    public static function checkBudget(array|false $info): void
    {
        if (!is_array($info) || !isset($info[0], $info[1]) || !is_int($info[0]) || !is_int($info[1]) || $info[0] < 1 || $info[1] < 1) {
            throw new ApiError(400, 'The image cannot be read: its header does not say what size it is.');
        }
        [$w, $h] = [$info[0], $info[1]];
        $side = Limits::imageSide();
        $pixels = Limits::imagePixels();
        if ($w > $side || $h > $side || $w * $h > $pixels) {
            throw new ApiError(422, "The image declares itself $w × $h pixels; the directory accepts up to $side on a side and " . number_format($pixels / 1000000, 1) . ' megapixels.', ['width' => $w, 'height' => $h, 'maxSide' => $side, 'maxPixels' => $pixels]);
        }
    }

    public static function extension(string $mime): string
    {
        return match ($mime) {
            'image/png' => 'png',
            'image/jpeg' => 'jpg',
            'image/gif' => 'gif',
            'image/webp' => 'webp',
            'image/svg+xml' => 'svg',
            default => 'bin',
        };
    }

    public static function mimeForExtension(string $ext): string
    {
        return match (strtolower($ext)) {
            'png' => 'image/png',
            'jpg', 'jpeg' => 'image/jpeg',
            'gif' => 'image/gif',
            'webp' => 'image/webp',
            'svg' => 'image/svg+xml',
            default => 'application/octet-stream',
        };
    }
}

/**
 * Plain text as the API keeps it: trimmed, control characters removed, cut to
 * a length. Everything a visitor types passes through here before it is
 * stored, and everything stored is returned as JSON for a client that renders
 * it as text — nothing here is ever interpolated into HTML.
 */
final class Text
{
    public static function clean(?string $value, int $max, bool $multiline = false): string
    {
        if ($value === null) return '';
        $value = str_replace(["\r\n", "\r"], "\n", $value);
        $value = preg_replace($multiline ? '/[^\P{C}\n\t]/u' : '/\p{C}/u', '', $value) ?? '';
        if (!mb_check_encoding($value, 'UTF-8')) $value = mb_convert_encoding($value, 'UTF-8', 'UTF-8');
        $value = trim($value);
        if (mb_strlen($value) > $max) $value = mb_substr($value, 0, $max);
        return $value;
    }

    /** @return string[] */
    public static function tags(?string $raw, int $maxTags = 8, int $maxLen = 24): array
    {
        if ($raw === null || $raw === '') return [];
        $list = null;
        if (str_starts_with(trim($raw), '[')) {
            $decoded = json_decode($raw, true);
            if (is_array($decoded)) $list = $decoded;
        }
        if ($list === null) $list = explode(',', $raw);
        $out = [];
        foreach ($list as $t) {
            if (!is_string($t)) continue;
            $t = strtolower(self::clean($t, $maxLen));
            $t = preg_replace('/[^a-z0-9][^a-z0-9-]*/', '-', $t) ?? '';
            $t = trim($t, '-');
            if ($t === '' || in_array($t, $out, true)) continue;
            $out[] = $t;
            if (count($out) >= $maxTags) break;
        }
        return $out;
    }
}
