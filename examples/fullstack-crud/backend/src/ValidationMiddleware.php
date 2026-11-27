<?php
namespace App;

use SlimCompat\Psr7\Response;
use SlimCompat\Psr7\ServerRequest;

/** PSR-7 request validation middleware for JSON mutations. */
class ValidationMiddleware
{
    public function __invoke(ServerRequest $request, callable $next)
    {
        $method = $request->getMethod();
        if ($method === 'POST' || $method === 'PATCH' || $method === 'PUT') {
            $raw = trim($request->getBody()->getContents());
            if ($raw !== '' && $request->getParsedBody() === null) {
                return (new Response())->withJson([
                    'error' => 'Invalid JSON request body (ensure Content-Type: application/json)',
                ], 422);
            }
        }
        return $next($request);
    }
}
