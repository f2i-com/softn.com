<?php
namespace SlimCompat\Psr7;

/** Lightweight PSR-7 compatible ServerRequest for Slim-style routes and middleware. */
class ServerRequest
{
    private $method;
    private $path;
    private $queryParams;
    private $headers;
    private $body;
    private $parsedBody;
    private $attributes = [];

    public function __construct($method, $path, array $queryParams, array $headers, $rawBody)
    {
        $this->method = strtoupper((string) $method);
        $this->path = (string) $path;
        $this->queryParams = $queryParams;
        $normalized = [];
        foreach ($headers as $k => $v) {
            $normalized[strtolower((string) $k)] = (string) $v;
        }
        $this->headers = $normalized;
        $this->body = new Stream($rawBody);
        $this->parsedBody = null;
        $ct = strtolower($this->getHeaderLine('content-type'));
        if ($rawBody !== '' && strpos($ct, 'application/json') !== false) {
            $decoded = json_decode($rawBody, true);
            if (is_array($decoded)) {
                $this->parsedBody = $decoded;
            }
        }
    }

    public static function fromGlobals()
    {
        $method = isset($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : 'GET';
        $uri = isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '/';
        $path = parse_url($uri, PHP_URL_PATH);
        if (!is_string($path) || $path === '') {
            $path = '/';
        }
        $headers = [];
        foreach ($_SERVER as $key => $val) {
            if (strpos($key, 'HTTP_') === 0) {
                $name = strtolower(str_replace('_', '-', substr($key, 5)));
                $headers[$name] = (string) $val;
            } elseif ($key === 'CONTENT_TYPE') {
                $headers['content-type'] = (string) $val;
            } elseif ($key === 'CONTENT_LENGTH') {
                $headers['content-length'] = (string) $val;
            }
        }
        $rawBody = file_get_contents('php://input');
        if (!is_string($rawBody)) {
            $rawBody = '';
        }
        return new self($method, $path, $_GET, $headers, $rawBody);
    }

    public function getMethod()
    {
        return $this->method;
    }

    public function getPath()
    {
        return $this->path;
    }

    public function getQueryParams()
    {
        return $this->queryParams;
    }

    public function getHeaderLine($name)
    {
        $key = strtolower((string) $name);
        return isset($this->headers[$key]) ? $this->headers[$key] : '';
    }

    public function getBody()
    {
        return $this->body;
    }

    public function getParsedBody()
    {
        return $this->parsedBody;
    }

    public function withAttribute($name, $value)
    {
        $clone = clone $this;
        $clone->attributes[(string) $name] = $value;
        return $clone;
    }

    public function getAttribute($name, $default = null)
    {
        $key = (string) $name;
        return array_key_exists($key, $this->attributes) ? $this->attributes[$key] : $default;
    }
}
