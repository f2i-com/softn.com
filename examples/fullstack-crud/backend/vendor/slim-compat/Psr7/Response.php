<?php
namespace SlimCompat\Psr7;

/** Lightweight PSR-7 compatible Response with immutable status/header helpers. */
class Response
{
    private $statusCode;
    private $headers;
    private $body;

    public function __construct($statusCode = 200, array $headers = [], $body = '')
    {
        $this->statusCode = (int) $statusCode;
        $this->headers = $headers;
        $this->body = new Stream($body);
    }

    public function getStatusCode()
    {
        return $this->statusCode;
    }

    public function withStatus($code)
    {
        $clone = clone $this;
        $clone->statusCode = (int) $code;
        return $clone;
    }

    public function withHeader($name, $value)
    {
        $clone = clone $this;
        $clone->headers[(string) $name] = (string) $value;
        return $clone;
    }

    public function getHeaders()
    {
        return $this->headers;
    }

    public function getBody()
    {
        return $this->body;
    }

    public function withJson($data, $status = null)
    {
        $clone = clone $this;
        if ($status !== null) {
            $clone->statusCode = (int) $status;
        }
        $clone->headers['Content-Type'] = 'application/json; charset=utf-8';
        $clone->body = new Stream(json_encode($data, JSON_UNESCAPED_UNICODE));
        return $clone;
    }
}
