<?php
declare(strict_types=1);

require_once __DIR__ . '/micro.php';

$router = new ModulaRouter('modula.pos', 'Modula POS & Rental', __DIR__ . '/schema.sql');

$router->get('/api/overview', function (PDO $pdo): array {
    $activeSession = ModulaDb::one($pdo, "SELECT * FROM pos_sessions WHERE status = 'Open' ORDER BY id DESC LIMIT 1");
    $paidSales = (float) ModulaDb::scalar($pdo, "SELECT COALESCE(SUM(total), 0) FROM pos_orders WHERE status = 'Paid'");
    $orderCount = (int) ModulaDb::scalar($pdo, "SELECT COUNT(*) FROM pos_orders WHERE status = 'Paid'");
    $avgBasket = $orderCount > 0 ? round($paidSales / $orderCount, 2) : 0.0;
    $activeRentals = (int) ModulaDb::scalar($pdo, "SELECT COUNT(*) FROM rental_bookings WHERE status IN ('Reserved', 'Picked Up')");
    $pickedUpUnits = (int) ModulaDb::scalar($pdo, "SELECT COALESCE(SUM(qty), 0) FROM rental_bookings WHERE status = 'Picked Up'");
    $rentalRevenue = (float) ModulaDb::scalar($pdo, "SELECT COALESCE(SUM(total_amount), 0) FROM rental_bookings WHERE status != 'Cancelled'");

    return [
        'activeSession' => $activeSession,
        'totalSales' => round($paidSales, 2),
        'orderCount' => $orderCount,
        'avgBasket' => $avgBasket,
        'activeRentals' => $activeRentals,
        'pickedUpUnits' => $pickedUpUnits,
        'rentalRevenue' => round($rentalRevenue, 2),
    ];
});

$router->get('/api/sessions', function (PDO $pdo): array {
    return ['sessions' => ModulaDb::all($pdo, 'SELECT * FROM pos_sessions ORDER BY id DESC')];
});

$router->post('/api/sessions/open', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $existing = ModulaDb::one($pdo, "SELECT * FROM pos_sessions WHERE status = 'Open' LIMIT 1");
    if ($existing) {
        ModulaHttp::error('A register shift is already open (' . $existing['register_name'] . '). Close it first.', 400);
    }
    $register = ModulaHttp::str($in, 'register_name', 'Main Counter #1', 120);
    $cashier = ModulaHttp::str($in, 'cashier_name', 'Maya Lin', 120);
    $floatAmt = max(0.0, ModulaHttp::float($in, 'opening_float', 200.0));
    $id = ModulaDb::exec(
        $pdo,
        "INSERT INTO pos_sessions (register_name, cashier_name, opened_at, opening_float, status, notes)
         VALUES (?, ?, ?, ?, 'Open', ?)",
        [$register, $cashier, ModulaHttp::now(), $floatAmt, ModulaHttp::str($in, 'notes', '', 400)]
    );
    return ['__status' => 201, '__body' => ['session' => ModulaDb::one($pdo, 'SELECT * FROM pos_sessions WHERE id = ?', [$id])]];
});

$router->post('/api/sessions/{id}/close', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $session = ModulaDb::one($pdo, 'SELECT * FROM pos_sessions WHERE id = ?', [$id]);
    if (!$session) {
        ModulaHttp::error('Session not found', 404);
    }
    if ($session['status'] === 'Closed') {
        ModulaHttp::error('Session already closed', 400);
    }
    $in = ModulaHttp::body();
    $notes = ModulaHttp::str($in, 'notes', 'Z-Report closed & verified', 400);
    ModulaDb::exec(
        $pdo,
        "UPDATE pos_sessions SET status = 'Closed', closed_at = ?, notes = ? WHERE id = ?",
        [ModulaHttp::now(), $notes, $id]
    );
    return ['session' => ModulaDb::one($pdo, 'SELECT * FROM pos_sessions WHERE id = ?', [$id])];
});

$router->get('/api/items', function (PDO $pdo): array {
    return ['items' => ModulaDb::all($pdo, 'SELECT * FROM pos_items WHERE active = 1 ORDER BY category ASC, name ASC')];
});

$router->post('/api/items', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $sku = strtoupper(ModulaHttp::str($in, 'sku', '', 40));
    $name = ModulaHttp::str($in, 'name', '', 160);
    if ($sku === '' || $name === '') {
        ModulaHttp::error('SKU and item name are required', 400);
    }
    $id = ModulaDb::exec(
        $pdo,
        'INSERT INTO pos_items (sku, name, category, price, cost, stock_qty, active) VALUES (?, ?, ?, ?, ?, ?, 1)',
        [
            $sku,
            $name,
            ModulaHttp::str($in, 'category', 'Retail', 60),
            max(0.0, ModulaHttp::float($in, 'price', 0.0)),
            max(0.0, ModulaHttp::float($in, 'cost', 0.0)),
            max(0, ModulaHttp::int($in, 'stock_qty', 20)),
        ]
    );
    return ['__status' => 201, '__body' => ['item' => ModulaDb::one($pdo, 'SELECT * FROM pos_items WHERE id = ?', [$id])]];
});

$router->get('/api/orders', function (PDO $pdo): array {
    $rows = ModulaDb::all($pdo, 'SELECT * FROM pos_orders ORDER BY id DESC');
    foreach ($rows as &$r) {
        $r['items'] = json_decode((string) ($r['items_json'] ?? '[]'), true) ?: [];
    }
    return ['orders' => $rows];
});

$router->post('/api/orders', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $session = ModulaDb::one($pdo, "SELECT * FROM pos_sessions WHERE status = 'Open' ORDER BY id DESC LIMIT 1");
    if (!$session) {
        ModulaHttp::error('No open POS shift. Open a register session first.', 400);
    }
    $cart = isset($in['items']) && is_array($in['items']) ? $in['items'] : [];
    if (count($cart) === 0) {
        ModulaHttp::error('Cart is empty', 400);
    }

    $discountPct = max(0.0, min(50.0, ModulaHttp::float($in, 'discount_pct', 0.0)));
    $paymentMethod = ModulaHttp::str($in, 'payment_method', 'Card', 30);
    if (!in_array($paymentMethod, ['Card', 'Cash', 'Split'], true)) {
        $paymentMethod = 'Card';
    }
    $orderType = ModulaHttp::str($in, 'order_type', 'Counter', 30);
    $tableLabel = ModulaHttp::str($in, 'table_label', '', 40);
    $customerName = ModulaHttp::str($in, 'customer_name', 'Walk-in Customer', 140);

    $pdo->beginTransaction();
    try {
        $normalized = [];
        $subtotal = 0.0;
        foreach ($cart as $line) {
            if (!is_array($line)) {
                continue;
            }
            $itemId = (int) ($line['itemId'] ?? 0);
            $qty = max(1, (int) ($line['qty'] ?? 1));
            $item = ModulaDb::one($pdo, 'SELECT * FROM pos_items WHERE id = ?', [$itemId]);
            if (!$item) {
                throw new RuntimeException('Product #' . $itemId . ' not found');
            }
            if ((int) $item['stock_qty'] < $qty) {
                throw new RuntimeException('Insufficient stock for ' . $item['name']);
            }
            ModulaDb::exec($pdo, 'UPDATE pos_items SET stock_qty = stock_qty - ? WHERE id = ?', [$qty, $itemId]);
            $price = (float) $item['price'];
            $subtotal += $price * $qty;
            $normalized[] = [
                'itemId' => $itemId,
                'name' => (string) $item['name'],
                'qty' => $qty,
                'price' => $price,
            ];
        }

        $afterDiscount = round($subtotal * (1 - ($discountPct / 100.0)), 2);
        $taxAmount = round($afterDiscount * 0.10, 2);
        $total = round($afterDiscount + $taxAmount, 2);
        $tendered = ModulaHttp::float($in, 'amount_tendered', $total);
        if ($paymentMethod !== 'Cash' || $tendered < $total) {
            $tendered = $total;
        }
        $changeDue = round(max(0.0, $tendered - $total), 2);

        $nextNum = (int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM pos_orders') + 1001;
        $orderNumber = 'POS-2026-' . $nextNum;

        $orderId = ModulaDb::exec(
            $pdo,
            "INSERT INTO pos_orders (order_number, session_id, customer_name, order_type, table_label, items_json, subtotal, discount_pct, tax_amount, total, payment_method, amount_tendered, change_due, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Paid', ?)",
            [
                $orderNumber,
                (int) $session['id'],
                $customerName,
                $orderType,
                $tableLabel,
                json_encode($normalized),
                round($subtotal, 2),
                $discountPct,
                $taxAmount,
                $total,
                $paymentMethod,
                $tendered,
                $changeDue,
                ModulaHttp::now(),
            ]
        );

        if ($paymentMethod === 'Cash') {
            ModulaDb::exec($pdo, 'UPDATE pos_sessions SET cash_sales = ROUND(cash_sales + ?, 2) WHERE id = ?', [$total, (int) $session['id']]);
        } elseif ($paymentMethod === 'Split') {
            $halfCash = round($total / 2.0, 2);
            $halfCard = round($total - $halfCash, 2);
            ModulaDb::exec(
                $pdo,
                'UPDATE pos_sessions SET cash_sales = ROUND(cash_sales + ?, 2), card_sales = ROUND(card_sales + ?, 2) WHERE id = ?',
                [$halfCash, $halfCard, (int) $session['id']]
            );
        } else {
            ModulaDb::exec($pdo, 'UPDATE pos_sessions SET card_sales = ROUND(card_sales + ?, 2) WHERE id = ?', [$total, (int) $session['id']]);
        }

        $pdo->commit();
        $created = ModulaDb::one($pdo, 'SELECT * FROM pos_orders WHERE id = ?', [$orderId]);
        $created['items'] = $normalized;
        return ['__status' => 201, '__body' => ['order' => $created]];
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        ModulaHttp::error($e->getMessage(), 400);
    }
});

$router->post('/api/orders/{id}/refund', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $order = ModulaDb::one($pdo, 'SELECT * FROM pos_orders WHERE id = ?', [$id]);
    if (!$order) {
        ModulaHttp::error('Order not found', 404);
    }
    if ($order['status'] === 'Refunded') {
        ModulaHttp::error('Order is already refunded', 400);
    }

    $pdo->beginTransaction();
    try {
        $items = json_decode((string) $order['items_json'], true) ?: [];
        foreach ($items as $line) {
            if (is_array($line) && isset($line['itemId'], $line['qty'])) {
                ModulaDb::exec(
                    $pdo,
                    'UPDATE pos_items SET stock_qty = stock_qty + ? WHERE id = ?',
                    [(int) $line['qty'], (int) $line['itemId']]
                );
            }
        }
        ModulaDb::exec($pdo, "UPDATE pos_orders SET status = 'Refunded' WHERE id = ?", [$id]);
        $total = (float) $order['total'];
        if ($order['payment_method'] === 'Cash') {
            ModulaDb::exec($pdo, 'UPDATE pos_sessions SET cash_sales = MAX(0, ROUND(cash_sales - ?, 2)) WHERE id = ?', [$total, (int) $order['session_id']]);
        } else {
            ModulaDb::exec($pdo, 'UPDATE pos_sessions SET card_sales = MAX(0, ROUND(card_sales - ?, 2)) WHERE id = ?', [$total, (int) $order['session_id']]);
        }
        $pdo->commit();
        $updated = ModulaDb::one($pdo, 'SELECT * FROM pos_orders WHERE id = ?', [$id]);
        $updated['items'] = $items;
        return ['order' => $updated];
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        ModulaHttp::error($e->getMessage(), 500);
    }
});

$router->get('/api/rentals', function (PDO $pdo): array {
    return [
        'assets' => ModulaDb::all($pdo, 'SELECT * FROM rental_assets ORDER BY id ASC'),
        'bookings' => ModulaDb::all($pdo, 'SELECT * FROM rental_bookings ORDER BY id DESC'),
    ];
});

$router->post('/api/rentals/bookings', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $assetId = ModulaHttp::int($in, 'asset_id', 0);
    $customer = ModulaHttp::str($in, 'customer_name', '', 140);
    $qty = max(1, ModulaHttp::int($in, 'qty', 1));
    $days = max(1, ModulaHttp::int($in, 'days', 2));
    $startDate = ModulaHttp::str($in, 'start_date', ModulaHttp::today(), 30);
    $endDate = ModulaHttp::str($in, 'end_date', $startDate, 30);

    $asset = ModulaDb::one($pdo, 'SELECT * FROM rental_assets WHERE id = ?', [$assetId]);
    if (!$asset || $customer === '') {
        ModulaHttp::error('Valid rental asset and customer name are required', 400);
    }
    if ((int) $asset['available_qty'] < $qty) {
        ModulaHttp::error('Only ' . $asset['available_qty'] . ' unit(s) currently available', 400);
    }

    $nextNum = (int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM rental_bookings') + 201;
    $bookingNumber = 'RNT-2026-' . $nextNum;
    $dailyRate = (float) $asset['daily_rate'];
    $deposit = round((float) $asset['deposit_amount'] * $qty, 2);
    $total = round($dailyRate * $qty * $days, 2);

    $id = ModulaDb::exec(
        $pdo,
        "INSERT INTO rental_bookings (booking_number, asset_id, asset_name, customer_name, qty, start_date, end_date, daily_rate, deposit_amount, total_amount, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Reserved', ?)",
        [$bookingNumber, $assetId, $asset['name'], $customer, $qty, $startDate, $endDate, $dailyRate, $deposit, $total, ModulaHttp::now()]
    );

    return ['__status' => 201, '__body' => ['booking' => ModulaDb::one($pdo, 'SELECT * FROM rental_bookings WHERE id = ?', [$id])]];
});

$router->patch('/api/rentals/bookings/{id}/status', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $booking = ModulaDb::one($pdo, 'SELECT * FROM rental_bookings WHERE id = ?', [$id]);
    if (!$booking) {
        ModulaHttp::error('Rental booking not found', 404);
    }
    $in = ModulaHttp::body();
    $nextStatus = ModulaHttp::str($in, 'status', '', 30);
    if (!in_array($nextStatus, ['Reserved', 'Picked Up', 'Returned', 'Cancelled'], true)) {
        ModulaHttp::error('Invalid rental status', 400);
    }

    $prev = (string) $booking['status'];
    $assetId = (int) $booking['asset_id'];
    $qty = (int) $booking['qty'];

    $pdo->beginTransaction();
    try {
        if ($prev !== 'Picked Up' && $nextStatus === 'Picked Up') {
            $asset = ModulaDb::one($pdo, 'SELECT * FROM rental_assets WHERE id = ?', [$assetId]);
            if (!$asset || (int) $asset['available_qty'] < $qty) {
                throw new RuntimeException('Insufficient available units to check out');
            }
            ModulaDb::exec($pdo, 'UPDATE rental_assets SET available_qty = available_qty - ? WHERE id = ?', [$qty, $assetId]);
        } elseif ($prev === 'Picked Up' && ($nextStatus === 'Returned' || $nextStatus === 'Cancelled')) {
            ModulaDb::exec($pdo, 'UPDATE rental_assets SET available_qty = MIN(total_qty, available_qty + ?) WHERE id = ?', [$qty, $assetId]);
        }
        ModulaDb::exec($pdo, 'UPDATE rental_bookings SET status = ? WHERE id = ?', [$nextStatus, $id]);
        $pdo->commit();
        return ['booking' => ModulaDb::one($pdo, 'SELECT * FROM rental_bookings WHERE id = ?', [$id])];
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        ModulaHttp::error($e->getMessage(), 400);
    }
});

$router->dispatch();
