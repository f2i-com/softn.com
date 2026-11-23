<?php
declare(strict_types=1);

require_once __DIR__ . '/opal_micro.php';

$router = new OpalRouter('opal.inventory', 'Opal Inventory, Jobs & Time Billing', __DIR__ . '/schema.sql');

$router->get('/api/overview', function (PDO $pdo): array {
    $items = OpalDb::all($pdo, "SELECT * FROM items WHERE item_type = 'Inventory'");
    $valuation = 0.0;
    $lowStock = 0;
    $unitsOnHand = 0;
    foreach ($items as $it) {
        $oh = (int) $it['qty_on_hand'];
        $avail = $oh - (int) $it['qty_committed'];
        $valuation += $oh * (float) $it['buy_price'];
        $unitsOnHand += $oh;
        if ($avail <= (int) $it['reorder_level']) {
            $lowStock++;
        }
    }
    $activeJobs = (int) OpalDb::scalar($pdo, "SELECT COUNT(*) FROM jobs WHERE status = 'Active'");
    $unbilledAmt = (float) OpalDb::scalar($pdo, "SELECT COALESCE(SUM(amount), 0) FROM time_slips WHERE status = 'Unbilled'");
    $unbilledHrs = (float) OpalDb::scalar($pdo, "SELECT COALESCE(SUM(hours), 0) FROM time_slips WHERE status = 'Unbilled'");
    $jobProfit = (float) OpalDb::scalar($pdo, 'SELECT COALESCE(SUM(actual_income - actual_cost), 0) FROM jobs');

    return [
        'inventoryValuation' => round($valuation, 2),
        'unitsOnHand' => $unitsOnHand,
        'lowStockCount' => $lowStock,
        'activeJobs' => $activeJobs,
        'unbilledAmount' => round($unbilledAmt, 2),
        'unbilledHours' => round($unbilledHrs, 1),
        'jobGrossProfit' => round($jobProfit, 2),
    ];
});

$router->get('/api/items', function (PDO $pdo): array {
    $rows = OpalDb::all($pdo, 'SELECT * FROM items ORDER BY item_type ASC, sku ASC');
    foreach ($rows as &$r) {
        $r['available'] = (int) $r['qty_on_hand'] - (int) $r['qty_committed'];
        $r['low_stock'] = $r['item_type'] === 'Inventory' && $r['available'] <= (int) $r['reorder_level'];
        $r['stock_value'] = round((int) $r['qty_on_hand'] * (float) $r['buy_price'], 2);
    }
    return ['items' => $rows];
});

$router->post('/api/items', function (PDO $pdo): array {
    $in = OpalHttp::body();
    $sku = strtoupper(OpalHttp::str($in, 'sku', '', 40));
    $name = OpalHttp::str($in, 'name', '', 160);
    if ($sku === '' || $name === '') {
        OpalHttp::error('Item SKU and name are required.', 422);
    }
    $buy = max(0.0, OpalHttp::float($in, 'buy_price', 0.0));
    $retail = max(0.0, OpalHttp::float($in, 'retail_price', 0.0));
    $trade = OpalHttp::float($in, 'trade_price', round($retail * 0.85, 2));
    $whole = OpalHttp::float($in, 'wholesale_price', round($retail * 0.72, 2));

    $id = OpalDb::exec(
        $pdo,
        'INSERT INTO items (sku, name, item_type, location, buy_price, retail_price, trade_price, wholesale_price, tax_code, qty_on_hand, qty_committed, reorder_level)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)',
        [
            $sku,
            $name,
            OpalHttp::str($in, 'item_type', 'Inventory', 20),
            OpalHttp::str($in, 'location', 'Sydney HQ', 60),
            round($buy, 2),
            round($retail, 2),
            round($trade, 2),
            round($whole, 2),
            strtoupper(OpalHttp::str($in, 'tax_code', 'GST', 10)),
            max(0, OpalHttp::int($in, 'qty_on_hand', 0)),
            max(0, OpalHttp::int($in, 'reorder_level', 5)),
        ]
    );
    return ['__status' => 201, '__body' => ['item' => OpalDb::one($pdo, 'SELECT * FROM items WHERE id = ?', [$id])]];
});

$router->get('/api/adjustments', function (PDO $pdo): array {
    return ['adjustments' => OpalDb::all($pdo, 'SELECT * FROM stock_adjustments ORDER BY id DESC')];
});

$router->post('/api/items/{id}/adjust', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $item = OpalDb::one($pdo, 'SELECT * FROM items WHERE id = ?', [$id]);
    if (!$item) {
        OpalHttp::error('Item not found.', 404);
    }
    $in = OpalHttp::body();
    $delta = OpalHttp::int($in, 'qty_delta', 0);
    if ($delta === 0) {
        OpalHttp::error('Adjustment quantity delta cannot be zero.', 422);
    }
    $newQty = max(0, (int) $item['qty_on_hand'] + $delta);
    $reason = OpalHttp::str($in, 'reason', 'Stocktake Adjustment', 60);
    $memo = OpalHttp::str($in, 'memo', '', 200);

    $pdo->beginTransaction();
    try {
        OpalDb::exec($pdo, 'UPDATE items SET qty_on_hand = ? WHERE id = ?', [$newQty, $id]);
        OpalDb::exec(
            $pdo,
            'INSERT INTO stock_adjustments (item_id, sku, item_name, adj_date, reason, location, qty_delta, unit_cost, memo)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [$id, (string) $item['sku'], (string) $item['name'], OpalHttp::today(), $reason, (string) $item['location'], $delta, (float) $item['buy_price'], $memo]
        );
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    return ['item' => OpalDb::one($pdo, 'SELECT * FROM items WHERE id = ?', [$id])];
});

$router->get('/api/jobs', function (PDO $pdo): array {
    $rows = OpalDb::all($pdo, 'SELECT * FROM jobs ORDER BY job_code ASC');
    foreach ($rows as &$j) {
        $inc = (float) $j['actual_income'];
        $cost = (float) $j['actual_cost'];
        $j['gross_profit'] = round($inc - $cost, 2);
        $j['margin_pct'] = $inc > 0 ? round((($inc - $cost) / $inc) * 100, 1) : 0.0;
    }
    return ['jobs' => $rows];
});

$router->post('/api/jobs', function (PDO $pdo): array {
    $in = OpalHttp::body();
    $code = strtoupper(OpalHttp::str($in, 'job_code', '', 30));
    $name = OpalHttp::str($in, 'job_name', '', 140);
    $cust = OpalHttp::str($in, 'customer_name', '', 140);
    if ($code === '' || $name === '' || $cust === '') {
        OpalHttp::error('Job code, name, and customer are required.', 422);
    }
    $id = OpalDb::exec(
        $pdo,
        'INSERT INTO jobs (job_code, parent_code, job_name, customer_name, status, budget_income, actual_income, budget_cost, actual_cost)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0)',
        [
            $code,
            strtoupper(OpalHttp::str($in, 'parent_code', '', 30)),
            $name,
            $cust,
            'Active',
            max(0.0, OpalHttp::float($in, 'budget_income', 0.0)),
            max(0.0, OpalHttp::float($in, 'budget_cost', 0.0)),
        ]
    );
    return ['__status' => 201, '__body' => ['job' => OpalDb::one($pdo, 'SELECT * FROM jobs WHERE id = ?', [$id])]];
});

$router->get('/api/time-slips', function (PDO $pdo): array {
    return ['timeSlips' => OpalDb::all($pdo, 'SELECT * FROM time_slips ORDER BY id DESC')];
});

$router->post('/api/time-slips', function (PDO $pdo): array {
    $in = OpalHttp::body();
    $staff = OpalHttp::str($in, 'staff_name', '', 100);
    $jobCode = strtoupper(OpalHttp::str($in, 'job_code', 'JOB-101', 30));
    $hours = round(max(0.25, OpalHttp::float($in, 'hours', 1.0)), 2);
    $rate = round(max(0.0, OpalHttp::float($in, 'hourly_rate', 200.0)), 2);
    if ($staff === '') {
        OpalHttp::error('Staff name is required.', 422);
    }
    $job = OpalDb::one($pdo, 'SELECT * FROM jobs WHERE job_code = ?', [$jobCode]);
    $customer = $job ? (string) $job['customer_name'] : OpalHttp::str($in, 'customer_name', 'General Client', 140);
    $amount = round($hours * $rate, 2);

    $id = OpalDb::exec(
        $pdo,
        'INSERT INTO time_slips (slip_date, staff_name, customer_name, job_code, activity, hours, hourly_rate, amount, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
            OpalHttp::str($in, 'slip_date', OpalHttp::today(), 20),
            $staff,
            $customer,
            $jobCode,
            OpalHttp::str($in, 'activity', 'Billable Advisory & Delivery', 200),
            $hours,
            $rate,
            $amount,
            'Unbilled',
        ]
    );
    return ['__status' => 201, '__body' => ['timeSlip' => OpalDb::one($pdo, 'SELECT * FROM time_slips WHERE id = ?', [$id])]];
});

$router->post('/api/time-slips/{id}/bill', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $slip = OpalDb::one($pdo, 'SELECT * FROM time_slips WHERE id = ?', [$id]);
    if (!$slip || $slip['status'] === 'Billed') {
        OpalHttp::error('Unbilled time slip not found.', 404);
    }
    $pdo->beginTransaction();
    try {
        OpalDb::exec($pdo, "UPDATE time_slips SET status = 'Billed' WHERE id = ?", [$id]);
        OpalDb::exec(
            $pdo,
            'UPDATE jobs SET actual_income = ROUND(actual_income + ?, 2) WHERE job_code = ?',
            [(float) $slip['amount'], (string) $slip['job_code']]
        );
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }
    return ['timeSlip' => OpalDb::one($pdo, 'SELECT * FROM time_slips WHERE id = ?', [$id])];
});

$router->dispatch();
