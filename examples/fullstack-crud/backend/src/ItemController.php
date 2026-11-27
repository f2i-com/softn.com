<?php
namespace App;

use SlimCompat\Psr7\Response;
use SlimCompat\Psr7\ServerRequest;

/** RESTful CRUD controller for `/api/items` and `/api/admin/*`. */
class ItemController
{
    private $repo;

    public function __construct(ItemRepository $repo)
    {
        $this->repo = $repo;
    }

    public function listItems(ServerRequest $request, Response $response)
    {
        $query = $request->getQueryParams();
        $search = isset($query['q']) ? trim((string) $query['q']) : '';
        $status = isset($query['status']) ? trim((string) $query['status']) : '';
        $items = $this->repo->listAll($search, $status);
        return $response->withJson(['items' => $items, 'count' => count($items)]);
    }

    public function getItem(ServerRequest $request, Response $response, array $args)
    {
        $item = $this->repo->findById($args['id']);
        if (!$item) {
            return $response->withJson(['error' => 'Item not found'], 404);
        }
        return $response->withJson(['item' => $item]);
    }

    public function createItem(ServerRequest $request, Response $response)
    {
        $body = $request->getParsedBody();
        if (!is_array($body)) {
            return $response->withJson(['error' => 'JSON body required'], 422);
        }
        $sku = isset($body['sku']) ? trim((string) $body['sku']) : '';
        $title = isset($body['title']) ? trim((string) $body['title']) : '';
        if ($sku === '' || $title === '') {
            return $response->withJson(['error' => 'Both sku and title are required'], 422);
        }
        if (isset($body['unit_price']) && !preg_match('/^-?\d+(?:\.\d{1,6})?$/', (string) $body['unit_price'])) {
            return $response->withJson(['error' => 'unit_price must be a valid decimal string'], 422);
        }
        $body['sku'] = $sku;
        $body['title'] = $title;
        try {
            $created = $this->repo->create($body);
            return $response->withJson(['item' => $created], 201);
        } catch (\PDOException $e) {
            return $response->withJson(['error' => Database::errorMessage($e)], 409);
        } catch (\Exception $e) {
            return $response->withJson(['error' => Database::errorMessage($e)], 409);
        }
    }

    public function updateItem(ServerRequest $request, Response $response, array $args)
    {
        $body = $request->getParsedBody();
        if (!is_array($body)) {
            return $response->withJson(['error' => 'JSON body required'], 422);
        }
        $updated = $this->repo->update($args['id'], $body);
        if (!$updated) {
            return $response->withJson(['error' => 'Item not found'], 404);
        }
        return $response->withJson(['item' => $updated]);
    }

    public function deleteItem(ServerRequest $request, Response $response, array $args)
    {
        $deleted = $this->repo->delete($args['id']);
        if (!$deleted) {
            return $response->withJson(['error' => 'Item not found'], 404);
        }
        return $response->withJson(['deleted' => true, 'id' => (string) $args['id']]);
    }

    public function createBatch(ServerRequest $request, Response $response)
    {
        $body = $request->getParsedBody();
        if (!is_array($body) || !isset($body['items']) || !is_array($body['items'])) {
            return $response->withJson(['error' => 'items array is required'], 422);
        }
        try {
            $created = $this->repo->createBatch($body['items']);
            return $response->withJson(['items' => $created, 'count' => count($created)], 201);
        } catch (\PDOException $e) {
            return $response->withJson(['error' => Database::errorMessage($e), 'rolledBack' => true], 409);
        } catch (\Exception $e) {
            return $response->withJson(['error' => Database::errorMessage($e), 'rolledBack' => true], 409);
        }
    }

    public function adminHealth(ServerRequest $request, Response $response)
    {
        $items = $this->repo->listAll();
        return $response->withJson([
            'ok' => true,
            'role' => $request->getAttribute('role'),
            'itemCount' => count($items),
        ]);
    }
}
