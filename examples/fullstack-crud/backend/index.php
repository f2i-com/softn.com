<?php
require_once __DIR__ . '/vendor/autoload.php';

use App\AuthMiddleware;
use App\Database;
use App\ItemController;
use App\ItemRepository;
use App\ValidationMiddleware;
use SlimCompat\App;

$pdo = Database::connect('sqlite:db/app.db');
$repo = new ItemRepository($pdo);
$controller = new ItemController($repo);

$app = new App();
$app->add(new AuthMiddleware());
$app->add(new ValidationMiddleware());

$app->get('/api/items', [$controller, 'listItems']);
$app->post('/api/items', [$controller, 'createItem']);
$app->post('/api/items/batch', [$controller, 'createBatch']);
$app->get('/api/items/{id}', [$controller, 'getItem']);
$app->patch('/api/items/{id}', [$controller, 'updateItem']);
$app->delete('/api/items/{id}', [$controller, 'deleteItem']);
$app->get('/api/admin/health', [$controller, 'adminHealth']);

$app->run();
