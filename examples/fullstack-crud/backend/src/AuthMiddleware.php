<?php
namespace App;

use SlimCompat\Psr7\Response;
use SlimCompat\Psr7\ServerRequest;

/** PSR-7 authorization middleware protecting administrative routes. */
class AuthMiddleware
{
    private $requiredToken;

    public function __construct($requiredToken = 'softn-demo-admin')
    {
        $this->requiredToken = (string) $requiredToken;
    }

    public function __invoke(ServerRequest $request, callable $next)
    {
        $path = $request->getPath();
        $method = $request->getMethod();
        $auth = $request->getHeaderLine('authorization');

        if (strpos($path, '/api/admin/') === 0) {
            if ($auth !== 'Bearer ' . $this->requiredToken) {
                return (new Response())
                    ->withHeader('X-SoftN-Profile', 'react-ts-php-slim')
                    ->withJson([
                        'error' => 'Unauthorized: missing or invalid bearer token',
                    ], 401);
            }
            $request = $request->withAttribute('role', 'admin');
        } else {
            $request = $request->withAttribute('role', $auth === 'Bearer ' . $this->requiredToken ? 'admin' : 'user');
        }

        $response = $next($request);
        return $response->withHeader('X-SoftN-Profile', 'react-ts-php-slim');
    }
}
