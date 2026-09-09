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

final class Request
{
    public string $method;
    /** The path below /api, always starting with a slash and never ending in one. */
    public string $path;
    /** @var array<string, string> */
    public array $query;
    /** @var array<string, string> lower-cased header names */
    public array $headers;
    public string $ip;
    private ?string $rawBody = null;
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
        return $r;
    }

    /**
     * The visitor's address. X-Forwarded-For is believed only when the
     * configuration says a proxy stands in front of this host; otherwise a
     * client could name any address it liked and escape every limit.
     */
    private static function clientIp(): string
    {
        $socket = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
        if (!is_string($socket)) $socket = '0.0.0.0';
        if (Config::get('trustProxy', false)) {
            $xff = $_SERVER['HTTP_X_FORWARDED_FOR'] ?? '';
            if (is_string($xff) && $xff !== '') {
                // The last hop is the one the proxy itself appended.
                $parts = array_map('trim', explode(',', $xff));
                $last = end($parts);
                if (is_string($last) && filter_var($last, FILTER_VALIDATE_IP)) return $last;
            }
        }
        return $socket;
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

    public function body(): string
    {
        if ($this->rawBody === null) {
            $this->rawBody = (string) file_get_contents('php://input');
        }
        return $this->rawBody;
    }

    /** @return array<string, mixed> */
    public function json(): array
    {
        if (!$this->jsonParsed) {
            $this->jsonParsed = true;
            if ($this->contentType() === 'application/json') {
                $body = $this->body();
                if (strlen($body) > Config::get('maxJsonBytes', 48 * 1024 * 1024)) {
                    throw new ApiError(413, 'The request body is too large.');
                }
                $decoded = json_decode($body, true, 64);
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
     */
    public function bundleFile(): ?string
    {
        $max = (int) Config::get('maxBundleBytes', 32 * 1024 * 1024);
        if (isset($_FILES['bundle']) && is_array($_FILES['bundle'])) {
            $f = $_FILES['bundle'];
            $err = (int) ($f['error'] ?? UPLOAD_ERR_NO_FILE);
            if ($err === UPLOAD_ERR_INI_SIZE || $err === UPLOAD_ERR_FORM_SIZE) {
                throw new ApiError(413, 'The bundle is larger than this server accepts. See api/.user.ini.');
            }
            if ($err !== UPLOAD_ERR_OK) throw new ApiError(400, 'The bundle upload did not complete.');
            $tmp = $f['tmp_name'] ?? '';
            if (!is_string($tmp) || !is_uploaded_file($tmp)) throw new ApiError(400, 'The bundle upload is not readable.');
            if (filesize($tmp) > $max) throw new ApiError(413, "The bundle is larger than the " . self::mb($max) . " limit.");
            return $tmp;
        }
        $ct = $this->contentType();
        if ($ct === 'application/octet-stream' || $ct === 'application/zip' || $ct === 'application/x-softn') {
            $len = (int) ($this->header('content-length') ?? 0);
            if ($len > $max) throw new ApiError(413, "The bundle is larger than the " . self::mb($max) . " limit.");
            $body = $this->body();
            if ($body === '') return null;
            if (strlen($body) > $max) throw new ApiError(413, "The bundle is larger than the " . self::mb($max) . " limit.");
            return self::spill($body);
        }
        if ($ct === 'application/json') {
            $json = $this->json();
            $b64 = $json['bundleBase64'] ?? null;
            if (is_string($b64) && $b64 !== '') {
                // A data: URL prefix is tolerated; a browser hands one over.
                $b64 = preg_replace('#^data:[^,]*,#', '', $b64) ?? $b64;
                $bytes = base64_decode($b64, true);
                if ($bytes === false) throw new ApiError(400, 'bundleBase64 is not valid base64.');
                if (strlen($bytes) > $max) throw new ApiError(413, "The bundle is larger than the " . self::mb($max) . " limit.");
                return self::spill($bytes);
            }
        }
        return null;
    }

    /**
     * An uploaded image: the multipart field `thumbnail`, or `thumbnailBase64`
     * in a JSON body. Returns [bytes, mime] once validated, or null.
     *
     * @return array{0: string, 1: string}|null
     */
    public function imageUpload(string $field = 'thumbnail'): ?array
    {
        $max = (int) Config::get('maxThumbnailBytes', 2 * 1024 * 1024);
        $bytes = null;
        if (isset($_FILES[$field]) && is_array($_FILES[$field])) {
            $f = $_FILES[$field];
            $err = (int) ($f['error'] ?? UPLOAD_ERR_NO_FILE);
            if ($err === UPLOAD_ERR_NO_FILE) return null;
            if ($err !== UPLOAD_ERR_OK) throw new ApiError(400, 'The image upload did not complete.');
            $tmp = $f['tmp_name'] ?? '';
            if (!is_string($tmp) || !is_uploaded_file($tmp)) throw new ApiError(400, 'The image upload is not readable.');
            if (filesize($tmp) > $max) throw new ApiError(413, 'The image is larger than ' . self::mb($max) . '.');
            $bytes = (string) file_get_contents($tmp);
        } else {
            $b64 = $this->json()[$field . 'Base64'] ?? null;
            if (!is_string($b64) || $b64 === '') return null;
            $b64 = preg_replace('#^data:[^,]*,#', '', $b64) ?? $b64;
            $decoded = base64_decode($b64, true);
            if ($decoded === false) throw new ApiError(400, "{$field}Base64 is not valid base64.");
            if (strlen($decoded) > $max) throw new ApiError(413, 'The image is larger than ' . self::mb($max) . '.');
            $bytes = $decoded;
        }
        $mime = Images::sniff($bytes);
        if ($mime === null) throw new ApiError(400, 'The image must be a PNG, JPEG, WebP or GIF.');
        return [$bytes, $mime];
    }

    private static function spill(string $bytes): string
    {
        $tmp = tempnam(sys_get_temp_dir(), 'softn-');
        if ($tmp === false) throw new ApiError(500, 'Could not create a temporary file.');
        // PHP removes a multipart upload's file when the request ends; this
        // one it does not know about, so it is removed here, whatever the
        // request went on to do with it.
        register_shutdown_function(static fn() => @unlink($tmp));
        file_put_contents($tmp, $bytes);
        return $tmp;
    }

    private static function mb(int $bytes): string
    {
        return round($bytes / 1048576) . ' MB';
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
