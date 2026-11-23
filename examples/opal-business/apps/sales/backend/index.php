<?php
declare(strict_types=1);

require_once __DIR__ . '/opal_micro.php';

$router = new OpalRouter('opal.sales', 'Opal Sales & Invoicing', __DIR__ . '/schema.sql');

function computeSalesLines(array $rawLines, bool $taxInclusive): array
{
    $lines = [];
    $subtotal = 0.0;
    $gst = 0.0;
    $total = 0.0;
    foreach ($rawLines as $l) {
        if (!is_array($l)) {
            continue;
        }
        $desc = trim((string) ($l['description'] ?? 'Service / Item'));
        $qty = max(0.01, (float) ($l['qty'] ?? 1));
        $unit = max(0.0, (float) ($l['unitPrice'] ?? 0));
        $taxCode = strtoupper(trim((string) ($l['taxCode'] ?? 'GST')));
        if (!in_array($taxCode, ['GST', 'FRE', 'EXP', 'N-T'], true)) {
            $taxCode = 'GST';
        }
        $calc = OpalAu::lineTax($qty * $unit, $taxCode, $taxInclusive);
        $subtotal += $calc['subtotal'];
        $gst += $calc['gst'];
        $total += $calc['total'];
        $lines[] = [
            'description' => $desc === '' ? 'Line Item' : $desc,
            'qty' => round($qty, 2),
            'unitPrice' => round($unit, 2),
            'taxCode' => $taxCode,
            'lineTotal' => $calc['total'],
        ];
    }
    return [
        'lines' => $lines,
        'subtotal' => round($subtotal, 2),
        'gst' => round($gst, 2),
        'total' => round($total, 2),
    ];
}

function hydrateDoc(?array $row): ?array
{
    if (!$row) {
        return null;
    }
    $row['lines'] = json_decode((string) ($row['lines_json'] ?? '[]'), true) ?: [];
    $row['balance_due'] = max(0.0, round((float) $row['total'] - (float) $row['paid_amount'], 2));
    return $row;
}

$router->get('/api/overview', function (PDO $pdo): array {
    $totalInvoiced = (float) OpalDb::scalar($pdo, "SELECT COALESCE(SUM(total), 0) FROM sales_docs WHERE doc_type = 'invoice'");
    $totalPaid = (float) OpalDb::scalar($pdo, "SELECT COALESCE(SUM(paid_amount), 0) FROM sales_docs WHERE doc_type = 'invoice'");
    $outstanding = (float) OpalDb::scalar($pdo, "SELECT COALESCE(SUM(total - paid_amount), 0) FROM sales_docs WHERE doc_type = 'invoice' AND status NOT IN ('Paid', 'Credited')");
    $overdueAmount = (float) OpalDb::scalar($pdo, "SELECT COALESCE(SUM(total - paid_amount), 0) FROM sales_docs WHERE doc_type = 'invoice' AND status = 'Overdue'");
    $overdueCount = (int) OpalDb::scalar($pdo, "SELECT COUNT(*) FROM sales_docs WHERE doc_type = 'invoice' AND status = 'Overdue'");
    $gstCollected = (float) OpalDb::scalar($pdo, "SELECT COALESCE(SUM(gst_amount), 0) FROM sales_docs WHERE doc_type = 'invoice' AND status != 'Credited'");
    $quotesOpen = (float) OpalDb::scalar($pdo, "SELECT COALESCE(SUM(total), 0) FROM sales_docs WHERE doc_type = 'quote' AND status NOT IN ('Converted', 'Declined')");
    $ordersOpen = (float) OpalDb::scalar($pdo, "SELECT COALESCE(SUM(total), 0) FROM sales_docs WHERE doc_type = 'order' AND status != 'Converted'");
    $openCredits = (float) OpalDb::scalar($pdo, "SELECT COALESCE(SUM(total - applied_amount), 0) FROM customer_credits WHERE status = 'Open'");
    $recurringActive = (int) OpalDb::scalar($pdo, 'SELECT COUNT(*) FROM recurring_templates WHERE active = 1');

    return [
        'totalInvoiced' => round($totalInvoiced, 2),
        'totalPaid' => round($totalPaid, 2),
        'outstanding' => round($outstanding, 2),
        'overdueAmount' => round($overdueAmount, 2),
        'overdueCount' => $overdueCount,
        'gstCollected' => round($gstCollected, 2),
        'quotesOpen' => round($quotesOpen, 2),
        'ordersOpen' => round($ordersOpen, 2),
        'openCredits' => round($openCredits, 2),
        'recurringActive' => $recurringActive,
    ];
});

$router->get('/api/docs', function (PDO $pdo): array {
    $type = OpalHttp::query('type');
    if (in_array($type, ['invoice', 'quote', 'order'], true)) {
        $rows = OpalDb::all($pdo, 'SELECT * FROM sales_docs WHERE doc_type = ? ORDER BY id DESC', [$type]);
    } else {
        $rows = OpalDb::all($pdo, 'SELECT * FROM sales_docs ORDER BY id DESC');
    }
    return ['docs' => array_map('hydrateDoc', $rows)];
});

$router->post('/api/docs', function (PDO $pdo): array {
    $in = OpalHttp::body();
    $docType = OpalHttp::str($in, 'doc_type', 'invoice', 20);
    if (!in_array($docType, ['invoice', 'quote', 'order'], true)) {
        $docType = 'invoice';
    }
    $customer = OpalHttp::str($in, 'customer_name', '', 160);
    if ($customer === '') {
        OpalHttp::error('Customer name is required.', 422);
    }
    $rawLines = isset($in['lines']) && is_array($in['lines']) ? $in['lines'] : [];
    if (count($rawLines) === 0) {
        OpalHttp::error('Add at least one line item.', 422);
    }
    $taxMode = OpalHttp::str($in, 'tax_mode', 'exclusive', 20) === 'inclusive' ? 'inclusive' : 'exclusive';
    $calc = computeSalesLines($rawLines, $taxMode === 'inclusive');
    if (count($calc['lines']) === 0) {
        OpalHttp::error('Line items could not be parsed.', 422);
    }

    $prefix = match ($docType) {
        'quote' => 'QUO-',
        'order' => 'SO-',
        default => 'INV-',
    };
    $baseNum = match ($docType) {
        'quote' => 118,
        'order' => 84,
        default => 401,
    };
    $count = (int) OpalDb::scalar($pdo, 'SELECT COUNT(*) FROM sales_docs WHERE doc_type = ?', [$docType]);
    $docNumber = $prefix . str_pad((string) ($baseNum + $count + 1), 6, '0', STR_PAD_LEFT);
    $status = match ($docType) {
        'quote' => 'Sent',
        'order' => 'Confirmed',
        default => 'Open',
    };

    $id = OpalDb::exec(
        $pdo,
        'INSERT INTO sales_docs
          (doc_type, doc_number, customer_name, customer_abn, issue_date, due_date, status, tax_mode, subtotal, gst_amount, total, paid_amount, online_pay_enabled, reminder_count, notes, lines_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?)',
        [
            $docType,
            $docNumber,
            $customer,
            OpalHttp::str($in, 'customer_abn', '', 32),
            OpalHttp::str($in, 'issue_date', OpalHttp::today(), 20),
            OpalHttp::str($in, 'due_date', date('Y-m-d', time() + 86400 * 14), 20),
            $status,
            $taxMode,
            $calc['subtotal'],
            $calc['gst'],
            $calc['total'],
            OpalHttp::bool($in, 'online_pay_enabled', true),
            OpalHttp::str($in, 'notes', 'Payment terms: 14 days. Pay online via BPAY or EFT/OSKO.', 600),
            json_encode($calc['lines'], JSON_UNESCAPED_SLASHES),
        ]
    );

    return ['__status' => 201, '__body' => ['doc' => hydrateDoc(OpalDb::one($pdo, 'SELECT * FROM sales_docs WHERE id = ?', [$id]))]];
});

$router->post('/api/docs/{id}/convert', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $src = OpalDb::one($pdo, 'SELECT * FROM sales_docs WHERE id = ?', [$id]);
    if (!$src) {
        OpalHttp::error('Document not found.', 404);
    }
    if ($src['doc_type'] === 'invoice') {
        OpalHttp::error('Document is already a Tax Invoice.', 409);
    }
    $in = OpalHttp::body();
    $targetType = OpalHttp::str($in, 'target_type', 'invoice', 20);
    if (!in_array($targetType, ['invoice', 'order'], true)) {
        $targetType = 'invoice';
    }
    $prefix = $targetType === 'order' ? 'SO-' : 'INV-';
    $baseNum = $targetType === 'order' ? 84 : 401;
    $count = (int) OpalDb::scalar($pdo, 'SELECT COUNT(*) FROM sales_docs WHERE doc_type = ?', [$targetType]);
    $newNum = $prefix . str_pad((string) ($baseNum + $count + 1), 6, '0', STR_PAD_LEFT);
    $newStatus = $targetType === 'order' ? 'Confirmed' : 'Open';

    $pdo->beginTransaction();
    try {
        OpalDb::exec($pdo, "UPDATE sales_docs SET status = 'Converted' WHERE id = ?", [$id]);
        $newId = OpalDb::exec(
            $pdo,
            'INSERT INTO sales_docs
              (doc_type, doc_number, customer_name, customer_abn, issue_date, due_date, status, tax_mode, subtotal, gst_amount, total, paid_amount, online_pay_enabled, reminder_count, notes, lines_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 0, ?, ?)',
            [
                $targetType,
                $newNum,
                (string) $src['customer_name'],
                (string) $src['customer_abn'],
                OpalHttp::today(),
                date('Y-m-d', time() + 86400 * 14),
                $newStatus,
                (string) $src['tax_mode'],
                (float) $src['subtotal'],
                (float) $src['gst_amount'],
                (float) $src['total'],
                'Converted from ' . $src['doc_number'] . '. ' . (string) $src['notes'],
                (string) $src['lines_json'],
            ]
        );
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    return [
        '__status' => 201,
        '__body' => [
            'source' => hydrateDoc(OpalDb::one($pdo, 'SELECT * FROM sales_docs WHERE id = ?', [$id])),
            'created' => hydrateDoc(OpalDb::one($pdo, 'SELECT * FROM sales_docs WHERE id = ?', [$newId])),
        ],
    ];
});

$router->post('/api/docs/{id}/pay', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $doc = OpalDb::one($pdo, 'SELECT * FROM sales_docs WHERE id = ?', [$id]);
    if (!$doc || $doc['doc_type'] !== 'invoice') {
        OpalHttp::error('Tax invoice not found.', 404);
    }
    $remaining = round((float) $doc['total'] - (float) $doc['paid_amount'], 2);
    if ($remaining <= 0.0) {
        OpalHttp::error('Invoice is already paid in full.', 409);
    }
    $in = OpalHttp::body();
    $amount = isset($in['amount']) && (float) $in['amount'] > 0
        ? min($remaining, round((float) $in['amount'], 2))
        : $remaining;
    $method = OpalHttp::str($in, 'method', 'EFT / OSKO', 60);
    $ref = OpalHttp::str($in, 'reference', 'PAY-' . substr((string) time(), -6), 60);

    $newPaid = round((float) $doc['paid_amount'] + $amount, 2);
    $newStatus = $newPaid >= ((float) $doc['total'] - 0.01) ? 'Paid' : 'Partial';

    $pdo->beginTransaction();
    try {
        OpalDb::exec($pdo, 'UPDATE sales_docs SET paid_amount = ?, status = ? WHERE id = ?', [$newPaid, $newStatus, $id]);
        OpalDb::exec(
            $pdo,
            'INSERT INTO customer_payments (doc_id, doc_number, customer_name, payment_date, method, reference, amount)
             VALUES (?, ?, ?, ?, ?, ?, ?)',
            [$id, (string) $doc['doc_number'], (string) $doc['customer_name'], OpalHttp::today(), $method, $ref, $amount]
        );
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    return ['doc' => hydrateDoc(OpalDb::one($pdo, 'SELECT * FROM sales_docs WHERE id = ?', [$id]))];
});

$router->post('/api/docs/{id}/remind', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $doc = OpalDb::one($pdo, 'SELECT * FROM sales_docs WHERE id = ?', [$id]);
    if (!$doc) {
        OpalHttp::error('Invoice not found.', 404);
    }
    OpalDb::exec($pdo, 'UPDATE sales_docs SET reminder_count = reminder_count + 1 WHERE id = ?', [$id]);
    return ['doc' => hydrateDoc(OpalDb::one($pdo, 'SELECT * FROM sales_docs WHERE id = ?', [$id]))];
});

$router->get('/api/payments', function (PDO $pdo): array {
    return ['payments' => OpalDb::all($pdo, 'SELECT * FROM customer_payments ORDER BY id DESC')];
});

$router->get('/api/credits', function (PDO $pdo): array {
    return ['credits' => OpalDb::all($pdo, 'SELECT * FROM customer_credits ORDER BY id DESC')];
});

$router->post('/api/credits', function (PDO $pdo): array {
    $in = OpalHttp::body();
    $customer = OpalHttp::str($in, 'customer_name', '', 160);
    if ($customer === '') {
        OpalHttp::error('Customer name is required.', 422);
    }
    $amount = round(OpalHttp::float($in, 'amount', 0.0), 2);
    if ($amount <= 0.0) {
        OpalHttp::error('Credit amount must be greater than $0.', 422);
    }
    $taxCode = OpalHttp::str($in, 'tax_code', 'GST', 10);
    $calc = OpalAu::lineTax($amount, $taxCode, true);
    $count = (int) OpalDb::scalar($pdo, 'SELECT COUNT(*) FROM customer_credits');
    $creditNumber = 'CN-' . str_pad((string) (22 + $count), 6, '0', STR_PAD_LEFT);

    $id = OpalDb::exec(
        $pdo,
        'INSERT INTO customer_credits (credit_number, customer_name, issue_date, reason, subtotal, gst_amount, total, applied_amount, status, applied_doc_number)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
        [
            $creditNumber,
            $customer,
            OpalHttp::today(),
            OpalHttp::str($in, 'reason', 'Customer return / adjustment note', 300),
            $calc['subtotal'],
            $calc['gst'],
            $calc['total'],
            'Open',
            '',
        ]
    );
    return ['__status' => 201, '__body' => ['credit' => OpalDb::one($pdo, 'SELECT * FROM customer_credits WHERE id = ?', [$id])]];
});

$router->post('/api/credits/{id}/apply', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $credit = OpalDb::one($pdo, 'SELECT * FROM customer_credits WHERE id = ?', [$id]);
    if (!$credit || $credit['status'] !== 'Open') {
        OpalHttp::error('Open customer credit not found.', 404);
    }
    $in = OpalHttp::body();
    $mode = OpalHttp::str($in, 'mode', 'apply', 20);
    $docId = OpalHttp::int($in, 'doc_id', 0);

    $pdo->beginTransaction();
    try {
        if ($mode === 'refund') {
            OpalDb::exec(
                $pdo,
                "UPDATE customer_credits SET status = 'Refunded', applied_amount = total, applied_doc_number = 'REFUND-EFT' WHERE id = ?",
                [$id]
            );
        } else {
            $inv = $docId > 0
                ? OpalDb::one($pdo, "SELECT * FROM sales_docs WHERE id = ? AND doc_type = 'invoice'", [$docId])
                : OpalDb::one(
                    $pdo,
                    "SELECT * FROM sales_docs WHERE doc_type = 'invoice' AND customer_name = ? AND status NOT IN ('Paid', 'Credited') ORDER BY id ASC LIMIT 1",
                    [(string) $credit['customer_name']]
                );
            if (!$inv) {
                OpalHttp::error('No open invoice found to apply this credit note.', 409);
            }
            $rem = max(0.0, round((float) $inv['total'] - (float) $inv['paid_amount'], 2));
            $applyAmt = min($rem, (float) $credit['total']);
            $newPaid = round((float) $inv['paid_amount'] + $applyAmt, 2);
            $newStatus = $newPaid >= ((float) $inv['total'] - 0.01) ? 'Paid' : 'Partial';
            OpalDb::exec($pdo, 'UPDATE sales_docs SET paid_amount = ?, status = ? WHERE id = ?', [$newPaid, $newStatus, (int) $inv['id']]);
            OpalDb::exec(
                $pdo,
                "UPDATE customer_credits SET status = 'Applied', applied_amount = ?, applied_doc_number = ? WHERE id = ?",
                [$applyAmt, (string) $inv['doc_number'], $id]
            );
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    return ['credit' => OpalDb::one($pdo, 'SELECT * FROM customer_credits WHERE id = ?', [$id])];
});

$router->get('/api/recurring', function (PDO $pdo): array {
    $rows = OpalDb::all($pdo, 'SELECT * FROM recurring_templates ORDER BY id DESC');
    foreach ($rows as &$r) {
        $r['lines'] = json_decode((string) ($r['lines_json'] ?? '[]'), true) ?: [];
    }
    return ['recurring' => $rows];
});

$router->post('/api/recurring/{id}/run', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $tpl = OpalDb::one($pdo, 'SELECT * FROM recurring_templates WHERE id = ?', [$id]);
    if (!$tpl) {
        OpalHttp::error('Recurring template not found.', 404);
    }
    $count = (int) OpalDb::scalar($pdo, "SELECT COUNT(*) FROM sales_docs WHERE doc_type = 'invoice'");
    $docNumber = 'INV-' . str_pad((string) (402 + $count), 6, '0', STR_PAD_LEFT);
    $days = match ((string) $tpl['frequency']) {
        'Fortnightly' => 14,
        'Quarterly' => 90,
        default => 30,
    };
    $nextDate = date('Y-m-d', strtotime((string) $tpl['next_run_date'] . " +{$days} days") ?: (time() + 86400 * $days));

    $pdo->beginTransaction();
    try {
        $docId = OpalDb::exec(
            $pdo,
            'INSERT INTO sales_docs
              (doc_type, doc_number, customer_name, customer_abn, issue_date, due_date, status, tax_mode, subtotal, gst_amount, total, paid_amount, online_pay_enabled, reminder_count, notes, lines_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 0, ?, ?)',
            [
                'invoice',
                $docNumber,
                (string) $tpl['customer_name'],
                (string) $tpl['customer_abn'],
                OpalHttp::today(),
                date('Y-m-d', time() + 86400 * 14),
                'Open',
                'exclusive',
                (float) $tpl['subtotal'],
                (float) $tpl['gst_amount'],
                (float) $tpl['total'],
                'Auto-generated from recurring schedule: ' . $tpl['template_name'],
                (string) $tpl['lines_json'],
            ]
        );
        OpalDb::exec($pdo, 'UPDATE recurring_templates SET next_run_date = ? WHERE id = ?', [$nextDate, $id]);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    return ['__status' => 201, '__body' => ['doc' => hydrateDoc(OpalDb::one($pdo, 'SELECT * FROM sales_docs WHERE id = ?', [$docId]))]];
});

$router->dispatch();
