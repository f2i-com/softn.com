<?php
declare(strict_types=1);

require_once __DIR__ . '/micro.php';

$router = new ModulaRouter('modula.inventory', 'Modula Inventory, Purchase & MRP', __DIR__ . '/schema.sql');

$router->get('/api/overview', function (PDO $pdo): array {
    $products = ModulaDb::all($pdo, 'SELECT * FROM products');
    $skuCount = count($products);
    $totalUnits = 0;
    $stockValue = 0.0;
    $lowStock = 0;
    foreach ($products as $p) {
        $qty = (int) $p['stock_on_hand'];
        $totalUnits += $qty;
        $stockValue += $qty * (float) $p['unit_cost'];
        if ($qty <= (int) $p['reorder_point']) {
            $lowStock++;
        }
    }
    $openPos = (int) ModulaDb::scalar($pdo, "SELECT COUNT(*) FROM purchase_orders WHERE status IN ('RFQ', 'Confirmed')");
    $openMos = (int) ModulaDb::scalar($pdo, "SELECT COUNT(*) FROM manufacturing_orders WHERE status != 'Done'");
    $movesCount = (int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM stock_moves');
    return [
        'skuCount' => $skuCount,
        'totalUnits' => $totalUnits,
        'stockValuation' => round($stockValue, 2),
        'lowStockCount' => $lowStock,
        'openPos' => $openPos,
        'openMos' => $openMos,
        'movesCount' => $movesCount,
    ];
});

$router->get('/api/products', function (PDO $pdo): array {
    return ['products' => ModulaDb::all($pdo, 'SELECT * FROM products ORDER BY id ASC')];
});

$router->post('/api/products', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $sku = strtoupper(ModulaHttp::str($in, 'sku', '', 40));
    $name = ModulaHttp::str($in, 'name', '', 140);
    if ($sku === '' || $name === '') {
        ModulaHttp::error('SKU and Product name are required.', 422);
    }
    $id = ModulaDb::exec(
        $pdo,
        'INSERT INTO products (sku, name, category, bin_location, vendor_name, unit_cost, sale_price, stock_on_hand, reorder_point)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
            $sku,
            $name,
            ModulaHttp::str($in, 'category', 'Hardware', 60),
            ModulaHttp::str($in, 'bin_location', 'WH/A1-01', 40),
            ModulaHttp::str($in, 'vendor_name', 'Apex Hardware Imports', 100),
            max(0.0, ModulaHttp::float($in, 'unit_cost', 0.0)),
            max(0.0, ModulaHttp::float($in, 'sale_price', 0.0)),
            max(0, ModulaHttp::int($in, 'stock_on_hand', 0)),
            max(0, ModulaHttp::int($in, 'reorder_point', 10)),
        ]
    );
    return ['__status' => 201, '__body' => ['product' => ModulaDb::one($pdo, 'SELECT * FROM products WHERE id = ?', [$id])]];
});

$router->post('/api/products/{id}/adjust', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $prod = ModulaDb::one($pdo, 'SELECT * FROM products WHERE id = ?', [$id]);
    if (!$prod) {
        ModulaHttp::error('Product not found.', 404);
    }
    $in = ModulaHttp::body();
    $delta = ModulaHttp::int($in, 'delta', 0);
    if ($delta === 0) {
        ModulaHttp::error('Adjustment delta cannot be zero.', 422);
    }
    $reason = ModulaHttp::str($in, 'reason', 'Manual adjustment', 120);
    $newQty = max(0, ((int) $prod['stock_on_hand']) + $delta);
    $actualDelta = $newQty - (int) $prod['stock_on_hand'];

    $pdo->beginTransaction();
    try {
        ModulaDb::exec($pdo, 'UPDATE products SET stock_on_hand = ? WHERE id = ?', [$newQty, $id]);
        $src = $actualDelta > 0 ? 'Virtual/Inventory-Adj' : (string) $prod['bin_location'];
        $dst = $actualDelta > 0 ? (string) $prod['bin_location'] : 'Virtual/Inventory-Adj';
        ModulaDb::exec(
            $pdo,
            'INSERT INTO stock_moves (reference, product_sku, product_name, source_loc, dest_loc, qty, move_type, moved_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            ['ADJ/' . $reason, (string) $prod['sku'], (string) $prod['name'], $src, $dst, abs($actualDelta), 'Adjustment', ModulaHttp::now()]
        );
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }
    return ['product' => ModulaDb::one($pdo, 'SELECT * FROM products WHERE id = ?', [$id])];
});

// Outbound Delivery / Internal Warehouse Transfer
$router->post('/api/transfers', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $productId = ModulaHttp::int($in, 'product_id', 0);
    $qty = max(1, ModulaHttp::int($in, 'qty', 1));
    $kind = ModulaHttp::str($in, 'kind', 'Delivery', 30);
    $dest = ModulaHttp::str($in, 'dest_loc', 'Customers/Outbound', 80);
    $prod = ModulaDb::one($pdo, 'SELECT * FROM products WHERE id = ?', [$productId]);
    if (!$prod) {
        ModulaHttp::error('Product not found.', 404);
    }
    if ($kind === 'Delivery' && (int) $prod['stock_on_hand'] < $qty) {
        ModulaHttp::error('Insufficient stock on hand for delivery.', 409);
    }
    $ref = ($kind === 'Delivery' ? 'WH/OUT/' : 'WH/INT/') . str_pad((string) (((int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM stock_moves')) + 100), 4, '0', STR_PAD_LEFT);

    $pdo->beginTransaction();
    try {
        if ($kind === 'Delivery') {
            ModulaDb::exec($pdo, 'UPDATE products SET stock_on_hand = stock_on_hand - ? WHERE id = ?', [$qty, $productId]);
        } else {
            ModulaDb::exec($pdo, 'UPDATE products SET bin_location = ? WHERE id = ?', [$dest, $productId]);
        }
        ModulaDb::exec(
            $pdo,
            'INSERT INTO stock_moves (reference, product_sku, product_name, source_loc, dest_loc, qty, move_type, moved_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [$ref, (string) $prod['sku'], (string) $prod['name'], (string) $prod['bin_location'], $dest, $qty, $kind, ModulaHttp::now()]
        );
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }
    return ['__status' => 201, '__body' => ['reference' => $ref, 'product' => ModulaDb::one($pdo, 'SELECT * FROM products WHERE id = ?', [$productId])]];
});

// Purchase Orders
$router->get('/api/pos', function (PDO $pdo): array {
    return ['pos' => ModulaDb::all($pdo, 'SELECT * FROM purchase_orders ORDER BY id DESC')];
});

$router->post('/api/pos', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $productId = ModulaHttp::int($in, 'product_id', 0);
    $prod = ModulaDb::one($pdo, 'SELECT * FROM products WHERE id = ?', [$productId]);
    if (!$prod) {
        ModulaHttp::error('Select a valid product.', 422);
    }
    $qty = max(1, ModulaHttp::int($in, 'qty', 10));
    $unitCost = isset($in['unit_cost']) ? max(0.0, (float) $in['unit_cost']) : (float) $prod['unit_cost'];
    $vendor = ModulaHttp::str($in, 'vendor_name', (string) $prod['vendor_name'], 120);
    $seq = ((int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM purchase_orders')) + 81;
    $poNumber = 'PO-2026-' . str_pad((string) $seq, 3, '0', STR_PAD_LEFT);

    $id = ModulaDb::exec(
        $pdo,
        'INSERT INTO purchase_orders (po_number, vendor_name, product_id, product_sku, product_name, qty, unit_cost, total, status, expected_date, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
            $poNumber,
            $vendor ?: 'Apex Hardware Imports',
            (int) $prod['id'],
            (string) $prod['sku'],
            (string) $prod['name'],
            $qty,
            round($unitCost, 2),
            round($qty * $unitCost, 2),
            'RFQ',
            ModulaHttp::str($in, 'expected_date', date('Y-m-d', time() + 86400 * 5), 20),
            ModulaHttp::today(),
        ]
    );
    return ['__status' => 201, '__body' => ['po' => ModulaDb::one($pdo, 'SELECT * FROM purchase_orders WHERE id = ?', [$id])]];
});

$router->post('/api/pos/{id}/confirm', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $po = ModulaDb::one($pdo, 'SELECT * FROM purchase_orders WHERE id = ?', [$id]);
    if (!$po) {
        ModulaHttp::error('PO not found.', 404);
    }
    ModulaDb::exec($pdo, "UPDATE purchase_orders SET status = 'Confirmed' WHERE id = ?", [$id]);
    return ['po' => ModulaDb::one($pdo, 'SELECT * FROM purchase_orders WHERE id = ?', [$id])];
});

$router->post('/api/pos/{id}/receive', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $po = ModulaDb::one($pdo, 'SELECT * FROM purchase_orders WHERE id = ?', [$id]);
    if (!$po) {
        ModulaHttp::error('PO not found.', 404);
    }
    if ($po['status'] === 'Received') {
        ModulaHttp::error('PO already received.', 409);
    }
    $prod = ModulaDb::one($pdo, 'SELECT * FROM products WHERE id = ?', [(int) $po['product_id']]);
    $bin = $prod ? (string) $prod['bin_location'] : 'WH/Stock';

    $pdo->beginTransaction();
    try {
        ModulaDb::exec($pdo, "UPDATE purchase_orders SET status = 'Received' WHERE id = ?", [$id]);
        if ($prod) {
            ModulaDb::exec($pdo, 'UPDATE products SET stock_on_hand = stock_on_hand + ? WHERE id = ?', [(int) $po['qty'], (int) $prod['id']]);
        }
        ModulaDb::exec(
            $pdo,
            'INSERT INTO stock_moves (reference, product_sku, product_name, source_loc, dest_loc, qty, move_type, moved_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [(string) $po['po_number'], (string) $po['product_sku'], (string) $po['product_name'], 'Vendors/' . $po['vendor_name'], $bin, (int) $po['qty'], 'Receipt', ModulaHttp::now()]
        );
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }
    return ['po' => ModulaDb::one($pdo, 'SELECT * FROM purchase_orders WHERE id = ?', [$id])];
});

// Manufacturing (MRP) & Bills of Materials (BoMs)
$router->get('/api/mrp', function (PDO $pdo): array {
    $boms = ModulaDb::all($pdo, 'SELECT * FROM boms ORDER BY id ASC');
    foreach ($boms as &$b) {
        $b['components'] = json_decode((string) ($b['components_json'] ?? '[]'), true) ?: [];
    }
    $orders = ModulaDb::all($pdo, 'SELECT * FROM manufacturing_orders ORDER BY id DESC');
    return ['boms' => $boms, 'orders' => $orders];
});

$router->post('/api/mrp/orders', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $bomId = ModulaHttp::int($in, 'bom_id', 0);
    $qty = max(1, ModulaHttp::int($in, 'qty_to_produce', 1));
    $bom = ModulaDb::one($pdo, 'SELECT * FROM boms WHERE id = ?', [$bomId]);
    if (!$bom) {
        ModulaHttp::error('Select a valid Bill of Materials.', 422);
    }
    $seq = ((int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM manufacturing_orders')) + 11;
    $moNo = 'MO-2026-' . str_pad((string) $seq, 3, '0', STR_PAD_LEFT);
    $id = ModulaDb::exec(
        $pdo,
        'INSERT INTO manufacturing_orders (mo_number, bom_id, finished_sku, finished_name, qty_to_produce, work_center, status, scheduled_date, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
            $moNo,
            $bomId,
            (string) $bom['finished_sku'],
            (string) $bom['finished_name'],
            $qty,
            (string) $bom['work_center'],
            'Planned',
            ModulaHttp::str($in, 'scheduled_date', ModulaHttp::today(), 20),
            ModulaHttp::today(),
        ]
    );
    return ['__status' => 201, '__body' => ['order' => ModulaDb::one($pdo, 'SELECT * FROM manufacturing_orders WHERE id = ?', [$id])]];
});

$router->post('/api/mrp/orders/{id}/produce', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $mo = ModulaDb::one($pdo, 'SELECT * FROM manufacturing_orders WHERE id = ?', [$id]);
    if (!$mo) {
        ModulaHttp::error('Manufacturing order not found.', 404);
    }
    if ($mo['status'] === 'Done') {
        ModulaHttp::error('Manufacturing order already completed.', 409);
    }
    $bom = ModulaDb::one($pdo, 'SELECT * FROM boms WHERE id = ?', [(int) $mo['bom_id']]);
    if (!$bom) {
        ModulaHttp::error('Bill of Materials missing.', 404);
    }
    $components = json_decode((string) $bom['components_json'], true) ?: [];
    $qty = (int) $mo['qty_to_produce'];

    $pdo->beginTransaction();
    try {
        foreach ($components as $comp) {
            $cid = (int) ($comp['product_id'] ?? 0);
            $need = $qty * max(1, (int) ($comp['qty'] ?? 1));
            $p = ModulaDb::one($pdo, 'SELECT * FROM products WHERE id = ?', [$cid]);
            if (!$p) {
                throw new RuntimeException('Component SKU missing.');
            }
            if ((int) $p['stock_on_hand'] < $need) {
                throw new RuntimeException('Insufficient stock of ' . $p['sku'] . ' (need ' . $need . ', have ' . $p['stock_on_hand'] . ').');
            }
            ModulaDb::exec($pdo, 'UPDATE products SET stock_on_hand = stock_on_hand - ? WHERE id = ?', [$need, $cid]);
            ModulaDb::exec(
                $pdo,
                'INSERT INTO stock_moves (reference, product_sku, product_name, source_loc, dest_loc, qty, move_type, moved_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [(string) $mo['mo_number'], (string) $p['sku'], (string) $p['name'], (string) $p['bin_location'], 'Virtual/Production', $need, 'MRP Consume', ModulaHttp::now()]
            );
        }

        $finished = ModulaDb::one($pdo, 'SELECT * FROM products WHERE id = ?', [(int) $bom['finished_product_id']]);
        if ($finished) {
            ModulaDb::exec($pdo, 'UPDATE products SET stock_on_hand = stock_on_hand + ? WHERE id = ?', [$qty, (int) $finished['id']]);
            ModulaDb::exec(
                $pdo,
                'INSERT INTO stock_moves (reference, product_sku, product_name, source_loc, dest_loc, qty, move_type, moved_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [(string) $mo['mo_number'], (string) $finished['sku'], (string) $finished['name'], 'Virtual/Production', (string) $finished['bin_location'], $qty, 'MRP Produce', ModulaHttp::now()]
            );
        }

        ModulaDb::exec($pdo, "UPDATE manufacturing_orders SET status = 'Done' WHERE id = ?", [$id]);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        ModulaHttp::error($e->getMessage(), 409);
    }

    return ['order' => ModulaDb::one($pdo, 'SELECT * FROM manufacturing_orders WHERE id = ?', [$id])];
});

$router->get('/api/moves', function (PDO $pdo): array {
    return ['moves' => ModulaDb::all($pdo, 'SELECT * FROM stock_moves ORDER BY id DESC LIMIT 100')];
});

$router->get('/api/vendors', function (PDO $pdo): array {
    return ['vendors' => ModulaDb::all($pdo, 'SELECT * FROM vendors ORDER BY id ASC')];
});

$router->post('/api/vendors', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $name = ModulaHttp::str($in, 'name', '', 120);
    if ($name === '') {
        ModulaHttp::error('Vendor name is required.', 422);
    }
    $id = ModulaDb::exec(
        $pdo,
        'INSERT INTO vendors (name, contact, email, lead_days, terms) VALUES (?, ?, ?, ?, ?)',
        [
            $name,
            ModulaHttp::str($in, 'contact', '', 100),
            ModulaHttp::str($in, 'email', '', 140),
            max(1, ModulaHttp::int($in, 'lead_days', 5)),
            ModulaHttp::str($in, 'terms', 'Net 30', 40),
        ]
    );
    return ['__status' => 201, '__body' => ['vendor' => ModulaDb::one($pdo, 'SELECT * FROM vendors WHERE id = ?', [$id])]];
});

$router->dispatch();
