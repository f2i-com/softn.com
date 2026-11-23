<?php
declare(strict_types=1);

require_once __DIR__ . '/opal_micro.php';

$router = new OpalRouter('opal.purchases', 'Opal Purchases, Bills & In Tray', __DIR__ . '/schema.sql');

function hydratePurchase(?array $row): ?array
{
    if (!$row) {
        return null;
    }
    $row['lines'] = json_decode((string) ($row['lines_json'] ?? '[]'), true) ?: [];
    $row['balance_due'] = max(0.0, round((float) $row['total'] - (float) $row['paid_amount'], 2));
    return $row;
}

$router->get('/api/overview', function (PDO $pdo): array {
    $openPayables = (float) OpalDb::scalar($pdo, "SELECT COALESCE(SUM(total - paid_amount), 0) FROM purchase_docs WHERE doc_type = 'bill' AND status NOT IN ('Paid', 'Debited')");
    $overdueBills = (float) OpalDb::scalar($pdo, "SELECT COALESCE(SUM(total - paid_amount), 0) FROM purchase_docs WHERE doc_type = 'bill' AND status = 'Overdue'");
    $gstPaid = (float) OpalDb::scalar($pdo, "SELECT COALESCE(SUM(gst_amount), 0) FROM purchase_docs WHERE doc_type = 'bill'");
    $intrayReady = (int) OpalDb::scalar($pdo, "SELECT COUNT(*) FROM intray_docs WHERE status = 'Ready'");
    $openPos = (float) OpalDb::scalar($pdo, "SELECT COALESCE(SUM(total), 0) FROM purchase_docs WHERE doc_type = 'po' AND status != 'Billed'");
    $pendingExpenses = (float) OpalDb::scalar($pdo, "SELECT COALESCE(SUM(amount), 0) FROM expense_claims WHERE status IN ('Submitted', 'Approved')");
    $openDebits = (float) OpalDb::scalar($pdo, "SELECT COALESCE(SUM(total), 0) FROM supplier_debits WHERE status = 'Open'");

    return [
        'openPayables' => round($openPayables, 2),
        'overdueBills' => round($overdueBills, 2),
        'gstPaid' => round($gstPaid, 2),
        'intrayReady' => $intrayReady,
        'openPos' => round($openPos, 2),
        'pendingExpenses' => round($pendingExpenses, 2),
        'openDebits' => round($openDebits, 2),
    ];
});

$router->get('/api/intray', function (PDO $pdo): array {
    return ['docs' => OpalDb::all($pdo, 'SELECT * FROM intray_docs ORDER BY status DESC, id DESC')];
});

$router->post('/api/intray', function (PDO $pdo): array {
    $in = OpalHttp::body();
    $supplier = OpalHttp::str($in, 'supplier_name', '', 160);
    if ($supplier === '') {
        OpalHttp::error('Supplier name is required.', 422);
    }
    $total = round(OpalHttp::float($in, 'total', 0.0), 2);
    if ($total <= 0.0) {
        OpalHttp::error('Document total must be greater than $0.', 422);
    }
    $taxCode = strtoupper(OpalHttp::str($in, 'tax_code', 'GST', 10));
    $calc = OpalAu::lineTax($total, $taxCode, true);

    $id = OpalDb::exec(
        $pdo,
        'INSERT INTO intray_docs
          (file_name, source, supplier_name, supplier_abn, supplier_inv_no, doc_date, category, tax_code, subtotal, gst_amount, total, ocr_confidence, status, linked_bill_number)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
            OpalHttp::str($in, 'file_name', 'receipt-' . date('Ymd-His') . '.pdf', 180),
            OpalHttp::str($in, 'source', 'Upload Drag & Drop', 60),
            $supplier,
            OpalHttp::str($in, 'supplier_abn', '', 32),
            OpalHttp::str($in, 'supplier_inv_no', 'SUP-' . substr((string) time(), -5), 50),
            OpalHttp::str($in, 'doc_date', OpalHttp::today(), 20),
            OpalHttp::str($in, 'category', '6-1400 Office Supplies', 80),
            $calc['taxCode'],
            $calc['subtotal'],
            $calc['gst'],
            $calc['total'],
            98,
            'Ready',
            '',
        ]
    );
    return ['__status' => 201, '__body' => ['doc' => OpalDb::one($pdo, 'SELECT * FROM intray_docs WHERE id = ?', [$id])]];
});

$router->post('/api/intray/{id}/to-bill', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $doc = OpalDb::one($pdo, 'SELECT * FROM intray_docs WHERE id = ?', [$id]);
    if (!$doc || $doc['status'] !== 'Ready') {
        OpalHttp::error('In Tray document not found or already linked.', 404);
    }
    $count = (int) OpalDb::scalar($pdo, "SELECT COUNT(*) FROM purchase_docs WHERE doc_type = 'bill'");
    $billNo = 'BILL-' . str_pad((string) (211 + $count), 6, '0', STR_PAD_LEFT);
    $lines = [[
        'description' => $doc['category'] . ' - ' . $doc['file_name'],
        'qty' => 1,
        'unitPrice' => (float) $doc['subtotal'],
        'taxCode' => (string) $doc['tax_code'],
    ]];

    $pdo->beginTransaction();
    try {
        $billId = OpalDb::exec(
            $pdo,
            'INSERT INTO purchase_docs
              (doc_type, doc_number, supplier_name, supplier_abn, supplier_inv_no, issue_date, due_date, status, category, subtotal, gst_amount, total, paid_amount, attachment_name, lines_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
            [
                'bill',
                $billNo,
                (string) $doc['supplier_name'],
                (string) $doc['supplier_abn'],
                (string) $doc['supplier_inv_no'],
                (string) $doc['doc_date'],
                date('Y-m-d', time() + 86400 * 14),
                'Open',
                (string) $doc['category'],
                (float) $doc['subtotal'],
                (float) $doc['gst_amount'],
                (float) $doc['total'],
                (string) $doc['file_name'],
                json_encode($lines, JSON_UNESCAPED_SLASHES),
            ]
        );
        OpalDb::exec($pdo, "UPDATE intray_docs SET status = 'Linked', linked_bill_number = ? WHERE id = ?", [$billNo, $id]);
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
            'bill' => hydratePurchase(OpalDb::one($pdo, 'SELECT * FROM purchase_docs WHERE id = ?', [$billId])),
            'intrayDoc' => OpalDb::one($pdo, 'SELECT * FROM intray_docs WHERE id = ?', [$id]),
        ],
    ];
});

$router->get('/api/docs', function (PDO $pdo): array {
    $type = OpalHttp::query('type');
    if ($type === 'bill' || $type === 'po') {
        $rows = OpalDb::all($pdo, 'SELECT * FROM purchase_docs WHERE doc_type = ? ORDER BY id DESC', [$type]);
    } else {
        $rows = OpalDb::all($pdo, 'SELECT * FROM purchase_docs ORDER BY id DESC');
    }
    return ['docs' => array_map('hydratePurchase', $rows)];
});

$router->post('/api/docs', function (PDO $pdo): array {
    $in = OpalHttp::body();
    $docType = OpalHttp::str($in, 'doc_type', 'bill', 10) === 'po' ? 'po' : 'bill';
    $supplier = OpalHttp::str($in, 'supplier_name', '', 160);
    if ($supplier === '') {
        OpalHttp::error('Supplier name is required.', 422);
    }
    $rawLines = isset($in['lines']) && is_array($in['lines']) ? $in['lines'] : [];
    if (count($rawLines) === 0) {
        OpalHttp::error('Add at least one line item.', 422);
    }
    $lines = [];
    $sub = 0.0;
    $gst = 0.0;
    $tot = 0.0;
    foreach ($rawLines as $l) {
        if (!is_array($l)) continue;
        $qty = max(0.01, (float) ($l['qty'] ?? 1));
        $unit = max(0.0, (float) ($l['unitPrice'] ?? 0));
        $tc = strtoupper(trim((string) ($l['taxCode'] ?? 'GST')));
        $calc = OpalAu::lineTax($qty * $unit, $tc, false);
        $sub += $calc['subtotal'];
        $gst += $calc['gst'];
        $tot += $calc['total'];
        $lines[] = [
            'description' => trim((string) ($l['description'] ?? 'Item')),
            'qty' => round($qty, 2),
            'unitPrice' => round($unit, 2),
            'taxCode' => $calc['taxCode'],
        ];
    }

    $count = (int) OpalDb::scalar($pdo, 'SELECT COUNT(*) FROM purchase_docs WHERE doc_type = ?', [$docType]);
    $docNum = $docType === 'po'
        ? 'PO-' . str_pad((string) (91 + $count), 6, '0', STR_PAD_LEFT)
        : 'BILL-' . str_pad((string) (211 + $count), 6, '0', STR_PAD_LEFT);

    $id = OpalDb::exec(
        $pdo,
        'INSERT INTO purchase_docs
          (doc_type, doc_number, supplier_name, supplier_abn, supplier_inv_no, issue_date, due_date, status, category, subtotal, gst_amount, total, paid_amount, attachment_name, lines_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
        [
            $docType,
            $docNum,
            $supplier,
            OpalHttp::str($in, 'supplier_abn', '', 32),
            OpalHttp::str($in, 'supplier_inv_no', '', 50),
            OpalHttp::str($in, 'issue_date', OpalHttp::today(), 20),
            OpalHttp::str($in, 'due_date', date('Y-m-d', time() + 86400 * 14), 20),
            $docType === 'po' ? 'Issued' : 'Open',
            OpalHttp::str($in, 'category', '6-1200 Cloud & Software', 80),
            round($sub, 2),
            round($gst, 2),
            round($tot, 2),
            '',
            json_encode($lines, JSON_UNESCAPED_SLASHES),
        ]
    );
    return ['__status' => 201, '__body' => ['doc' => hydratePurchase(OpalDb::one($pdo, 'SELECT * FROM purchase_docs WHERE id = ?', [$id]))]];
});

$router->post('/api/docs/{id}/pay', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $doc = OpalDb::one($pdo, "SELECT * FROM purchase_docs WHERE id = ? AND doc_type = 'bill'", [$id]);
    if (!$doc) {
        OpalHttp::error('Supplier bill not found.', 404);
    }
    $rem = round((float) $doc['total'] - (float) $doc['paid_amount'], 2);
    if ($rem <= 0.0) {
        OpalHttp::error('Bill is already paid.', 409);
    }
    $in = OpalHttp::body();
    $amt = isset($in['amount']) && (float) $in['amount'] > 0 ? min($rem, round((float) $in['amount'], 2)) : $rem;
    $newPaid = round((float) $doc['paid_amount'] + $amt, 2);
    $status = $newPaid >= ((float) $doc['total'] - 0.01) ? 'Paid' : 'Partial';
    OpalDb::exec($pdo, 'UPDATE purchase_docs SET paid_amount = ?, status = ? WHERE id = ?', [$newPaid, $status, $id]);
    return ['doc' => hydratePurchase(OpalDb::one($pdo, 'SELECT * FROM purchase_docs WHERE id = ?', [$id]))];
});

$router->post('/api/docs/{id}/to-bill', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $po = OpalDb::one($pdo, "SELECT * FROM purchase_docs WHERE id = ? AND doc_type = 'po'", [$id]);
    if (!$po || $po['status'] === 'Billed') {
        OpalHttp::error('Open Purchase Order not found.', 404);
    }
    $count = (int) OpalDb::scalar($pdo, "SELECT COUNT(*) FROM purchase_docs WHERE doc_type = 'bill'");
    $billNum = 'BILL-' . str_pad((string) (211 + $count), 6, '0', STR_PAD_LEFT);

    $pdo->beginTransaction();
    try {
        OpalDb::exec($pdo, "UPDATE purchase_docs SET status = 'Billed' WHERE id = ?", [$id]);
        $billId = OpalDb::exec(
            $pdo,
            'INSERT INTO purchase_docs
              (doc_type, doc_number, supplier_name, supplier_abn, supplier_inv_no, issue_date, due_date, status, category, subtotal, gst_amount, total, paid_amount, attachment_name, lines_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
            [
                'bill',
                $billNum,
                (string) $po['supplier_name'],
                (string) $po['supplier_abn'],
                'FROM-' . $po['doc_number'],
                OpalHttp::today(),
                date('Y-m-d', time() + 86400 * 14),
                'Open',
                (string) $po['category'],
                (float) $po['subtotal'],
                (float) $po['gst_amount'],
                (float) $po['total'],
                '',
                (string) $po['lines_json'],
            ]
        );
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    return ['__status' => 201, '__body' => ['bill' => hydratePurchase(OpalDb::one($pdo, 'SELECT * FROM purchase_docs WHERE id = ?', [$billId]))]];
});

$router->get('/api/debits', function (PDO $pdo): array {
    return ['debits' => OpalDb::all($pdo, 'SELECT * FROM supplier_debits ORDER BY id DESC')];
});

$router->post('/api/debits', function (PDO $pdo): array {
    $in = OpalHttp::body();
    $supplier = OpalHttp::str($in, 'supplier_name', '', 160);
    $amount = round(OpalHttp::float($in, 'amount', 0.0), 2);
    if ($supplier === '' || $amount <= 0.0) {
        OpalHttp::error('Supplier name and positive debit amount are required.', 422);
    }
    $calc = OpalAu::lineTax($amount, 'GST', true);
    $count = (int) OpalDb::scalar($pdo, 'SELECT COUNT(*) FROM supplier_debits');
    $dn = 'DN-' . str_pad((string) (15 + $count), 6, '0', STR_PAD_LEFT);
    $id = OpalDb::exec(
        $pdo,
        'INSERT INTO supplier_debits (debit_number, supplier_name, issue_date, reason, subtotal, gst_amount, total, status, applied_bill_number)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [$dn, $supplier, OpalHttp::today(), OpalHttp::str($in, 'reason', 'Supplier return / debit note', 250), $calc['subtotal'], $calc['gst'], $calc['total'], 'Open', '']
    );
    return ['__status' => 201, '__body' => ['debit' => OpalDb::one($pdo, 'SELECT * FROM supplier_debits WHERE id = ?', [$id])]];
});

$router->post('/api/debits/{id}/apply', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $debit = OpalDb::one($pdo, 'SELECT * FROM supplier_debits WHERE id = ?', [$id]);
    if (!$debit || $debit['status'] !== 'Open') {
        OpalHttp::error('Open supplier debit not found.', 404);
    }
    $bill = OpalDb::one(
        $pdo,
        "SELECT * FROM purchase_docs WHERE doc_type = 'bill' AND supplier_name = ? AND status NOT IN ('Paid') ORDER BY id ASC LIMIT 1",
        [(string) $debit['supplier_name']]
    );
    $pdo->beginTransaction();
    try {
        if ($bill) {
            $rem = max(0.0, round((float) $bill['total'] - (float) $bill['paid_amount'], 2));
            $apply = min($rem, (float) $debit['total']);
            $newPaid = round((float) $bill['paid_amount'] + $apply, 2);
            $newStatus = $newPaid >= ((float) $bill['total'] - 0.01) ? 'Paid' : 'Partial';
            OpalDb::exec($pdo, 'UPDATE purchase_docs SET paid_amount = ?, status = ? WHERE id = ?', [$newPaid, $newStatus, (int) $bill['id']]);
            OpalDb::exec($pdo, "UPDATE supplier_debits SET status = 'Applied', applied_bill_number = ? WHERE id = ?", [(string) $bill['doc_number'], $id]);
        } else {
            OpalDb::exec($pdo, "UPDATE supplier_debits SET status = 'Refunded', applied_bill_number = 'REFUND-EFT' WHERE id = ?", [$id]);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }
    return ['debit' => OpalDb::one($pdo, 'SELECT * FROM supplier_debits WHERE id = ?', [$id])];
});

$router->get('/api/expenses', function (PDO $pdo): array {
    return ['expenses' => OpalDb::all($pdo, 'SELECT * FROM expense_claims ORDER BY id DESC')];
});

$router->post('/api/expenses', function (PDO $pdo): array {
    $in = OpalHttp::body();
    $emp = OpalHttp::str($in, 'employee_name', '', 120);
    $merchant = OpalHttp::str($in, 'merchant', '', 120);
    $amt = round(OpalHttp::float($in, 'amount', 0.0), 2);
    if ($emp === '' || $merchant === '' || $amt <= 0.0) {
        OpalHttp::error('Employee, merchant and amount are required.', 422);
    }
    $tc = strtoupper(OpalHttp::str($in, 'tax_code', 'GST', 10));
    $calc = OpalAu::lineTax($amt, $tc, true);
    $id = OpalDb::exec(
        $pdo,
        'INSERT INTO expense_claims (employee_name, merchant, category, expense_date, tax_code, amount, gst_amount, billable_customer, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
            $emp,
            $merchant,
            OpalHttp::str($in, 'category', '6-2400 Travel & Accommodation', 80),
            OpalHttp::str($in, 'expense_date', OpalHttp::today(), 20),
            $calc['taxCode'],
            $calc['total'],
            $calc['gst'],
            OpalHttp::str($in, 'billable_customer', '', 120),
            'Submitted',
        ]
    );
    return ['__status' => 201, '__body' => ['expense' => OpalDb::one($pdo, 'SELECT * FROM expense_claims WHERE id = ?', [$id])]];
});

$router->patch('/api/expenses/{id}/status', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $in = OpalHttp::body();
    $status = OpalHttp::str($in, 'status', 'Approved', 20);
    if (!in_array($status, ['Submitted', 'Approved', 'Reimbursed', 'Rejected'], true)) {
        OpalHttp::error('Invalid status.', 422);
    }
    OpalDb::exec($pdo, 'UPDATE expense_claims SET status = ? WHERE id = ?', [$status, $id]);
    return ['expense' => OpalDb::one($pdo, 'SELECT * FROM expense_claims WHERE id = ?', [$id])];
});

$router->dispatch();
