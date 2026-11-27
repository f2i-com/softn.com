<?php
namespace SlimCompat;

use SlimCompat\Psr7\Response;
use SlimCompat\Psr7\ServerRequest;

/**
 * Slim-compatible micro-router + PSR-7 middleware pipeline compiled directly into
 * generated bundles without runtime Composer execution.
 */
class App
{
    private $routes = [];
    private $middleware = [];

    public function add($middleware)
    {
        $this->middleware[] = $middleware;
        return $this;
    }

    public function get($pattern, $handler)
    {
        return $this->map(['GET'], $pattern, $handler);
    }

    public function post($pattern, $handler)
    {
        return $this->map(['POST'], $pattern, $handler);
    }

    public function patch($pattern, $handler)
    {
        return $this->map(['PATCH'], $pattern, $handler);
    }

    public function put($pattern, $handler)
    {
        return $this->map(['PUT'], $pattern, $handler);
    }

    public function delete($pattern, $handler)
    {
        return $this->map(['DELETE'], $pattern, $handler);
    }

    public function map(array $methods, $pattern, $handler)
    {
        $paramNames = [];
        $regex = preg_replace_callback('/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/', function ($m) use (&$paramNames) {
            $paramNames[] = $m[1];
            return '([^/]+)';
        }, (string) $pattern);
        $this->routes[] = [
            'methods' => array_map('strtoupper', $methods),
            'regex' => '#^' . $regex . '$#',
            'params' => $paramNames,
            'handler' => $handler,
        ];
        return $this;
    }

    public function handle(ServerRequest $request)
    {
        $core = function (ServerRequest $req) {
            $method = $req->getMethod();
            $path = $req->getPath();
            $allowed = [];
            foreach ($this->routes as $route) {
                if (preg_match($route['regex'], $path, $matches)) {
                    if (in_array($method, $route['methods'], true)) {
                        $args = [];
                        foreach ($route['params'] as $idx => $name) {
                            $args[$name] = isset($matches[$idx + 1]) ? urldecode($matches[$idx + 1]) : '';
                        }
                        $response = new Response(200);
                        $handler = $route['handler'];
                        return $handler($req, $response, $args);
                    }
                    foreach ($route['methods'] as $m) {
                        $allowed[$m] = true;
                    }
                }
            }
            $res = new Response();
            if (!empty($allowed)) {
                return $res
                    ->withHeader('Allow', implode(', ', array_keys($allowed)))
                    ->withJson(['error' => 'Method not allowed'], 405);
            }
            return $res->withJson(['error' => 'Route not found', 'path' => $path], 404);
        };

        $pipeline = $core;
        for ($i = count($this->middleware) - 1; $i >= 0; $i--) {
            $mw = $this->middleware[$i];
            $next = $pipeline;
            $pipeline = function (ServerRequest $req) use ($mw, $next) {
                return $mw($req, $next);
            };
        }

        try {
            return $pipeline($request);
        } catch (\PDOException $e) {
            $msg = method_exists($e, 'getMessage') ? $e->getMessage() : (isset($e->message) ? (string) $e->message : 'Database error');
            return (new Response())->withJson(['error' => $msg], 500);
        } catch (\Exception $e) {
            $msg = method_exists($e, 'getMessage') ? $e->getMessage() : (isset($e->message) ? (string) $e->message : 'Server error');
            return (new Response())->withJson(['error' => $msg], 500);
        }
    }

    public function run()
    {
        $request = ServerRequest::fromGlobals();
        $response = $this->handle($request);
        http_response_code($response->getStatusCode());
        foreach ($response->getHeaders() as $name => $value) {
            header($name . ': ' . $value);
        }
        echo (string) $response->getBody();
    }
}
