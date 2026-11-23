<?php
declare(strict_types=1);

require_once __DIR__ . '/micro.php';

$router = new ModulaRouter('modula.accounting', 'Modula Accounting & Invoicing', __DIR__ . '/schema.sql');

function postJournal(PDO $pdo, string $ref, string $code, float $debit, float $credit, string $memo): void
{
    $acc = ModulaDb::one($pdo, 'SELECT * FROM accounts WHERE code = ?', [$code]);
    if (!$acc) {
        return;
    }
    $kind = (string) $acc['kind'];
    $delta = ($kind === 'Asset' || $kind === 'Expense') ? ($debit - $credit) : ($credit - $debit);
    ModulaDb::exec($pdo, 'UPDATE accounts SET balance = ROUND(balance + ?, 2) WHERE code = ?', [$delta, $code]);
    ModulaDb::exec(
        $pdo,
        'INSERT INTO journal_entries (entry_date, reference, account_code, account_name, debit, credit, memo)
         VALUES (?, ?, ?, ?, ?, ?, ?)',
        [ModulaHttp::today(), $ref, $code, (string) $acc['name'], round($debit, 2), round($credit, 2), $memo]
    );
}

$router->get('/api/overview', function (PDO $pdo): array {
    $bank = (float) ModulaDb::scalar($pdo, "SELECT COALESCE(balance, 0) FROM accounts WHERE code = '1000'");
    $ar = (float) ModulaDb::scalar($pdo, "SELECT COALESCE(SUM(total - paid_amount), 0) FROM invoices WHERE kind = 'customer' AND status NOT IN ('Paid', 'Credited')");
    $ap = (float) ModulaDb::scalar($pdo, "SELECT COALESCE(SUM(total - paid_amount), 0) FROM invoices WHERE kind = 'vendor' AND status NOT IN ('Paid', 'Credited')");
    $revenue = (float) ModulaDb::scalar($pdo, "SELECT COALESCE(SUM(balance), 0) FROM accounts WHERE kind = 'Revenue'");
    $expenses = (float) ModulaDb::scalar($pdo, "SELECT COALESCE(SUM(balance), 0) FROM accounts WHERE kind = 'Expense'");
    $overdueCount = (int) ModulaDb::scalar($pdo, "SELECT COUNT(*) FROM invoices WHERE kind = 'customer' AND status = 'Overdue'");
    $pendingExpenses = (int) ModulaDb::scalar($pdo, "SELECT COUNT(*) FROM expenses WHERE status = 'Submitted'");
    $unreconciledBank = (int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM bank_transactions WHERE reconciled = 0');

    return [
        'bankBalance' => round($bank, 2),
        'receivables' => round($ar, 2),
        'payables' => round($ap, 2),
        'revenue' => round($revenue, 2),
        'expenses' => round($expenses, 2),
        'netProfit' => round($revenue - $expenses, 2),
        'overdueCount' => $overdueCount,
        'pendingExpenses' => $pendingExpenses,
        'unreconciledBank' => $unreconciledBank,
    ];
});

$router->get('/api/reports', function (PDO $pdo): array {
    $accounts = ModulaDb::all($pdo, 'SELECT * FROM accounts ORDER BY code ASC');
    $assets = [];
    $liabilities = [];
    $equity = [];
    $revenues = [];
    $expenses = [];
    $totAssets = 0.0;
    $totLiab = 0.0;
    $totEq = 0.0;
    $totRev = 0.0;
    $totExp = 0.0;

    foreach ($accounts as $a) {
        $bal = round((float) $a['balance'], 2);
        $a['balance'] = $bal;
        switch ($a['kind']) {
            case 'Asset': $assets[] = $a; $totAssets += $bal; break;
            case 'Liability': $liabilities[] = $a; $totLiab += $bal; break;
            case 'Equity': $equity[] = $a; $totEq += $bal; break;
            case 'Revenue': $revenues[] = $a; $totRev += $bal; break;
            case 'Expense': $expenses[] = $a; $totExp += $bal; break;
        }
    }
    $netIncome = round($totRev - $totExp, 2);

    // Aged Receivables buckets
    $todayTs = strtotime(ModulaHttp::today()) ?: time();
    $openCustomer = ModulaDb::all($pdo, "SELECT * FROM invoices WHERE kind = 'customer' AND status NOT IN ('Paid', 'Credited')");
    $aging = ['current' => 0.0, 'days_1_30' => 0.0, 'days_31_60' => 0.0, 'days_60_plus' => 0.0];
    foreach ($openCustomer as $inv) {
        $dueAmt = max(0.0, round((float) $inv['total'] - (float) $inv['paid_amount'], 2));
        $dueTs = strtotime((string) $inv['due_date']) ?: $todayTs;
        $daysOver = (int) floor(($todayTs - $dueTs) / 86400);
        if ($daysOver <= 0) {
            $aging['current'] = round($aging['current'] + $dueAmt, 2);
        } elseif ($daysOver <= 30) {
            $aging['days_1_30'] = round($aging['days_1_30'] + $dueAmt, 2);
        } elseif ($daysOver <= 60) {
            $aging['days_31_60'] = round($aging['days_31_60'] + $dueAmt, 2);
        } else {
            $aging['days_60_plus'] = round($aging['days_60_plus'] + $dueAmt, 2);
        }
    }

    return [
        'pnl' => [
            'revenues' => $revenues,
            'expenses' => $expenses,
            'totalRevenue' => round($totRev, 2),
            'totalExpense' => round($totExp, 2),
            'netIncome' => $netIncome,
        ],
        'balanceSheet' => [
            'assets' => $assets,
            'liabilities' => $liabilities,
            'equity' => $equity,
            'totalAssets' => round($totAssets, 2),
            'totalLiabilities' => round($totLiab, 2),
            'retainedEarnings' => $netIncome,
            'totalLiabAndEquity' => round($totLiab + $totEq + $netIncome, 2),
        ],
        'agedReceivables' => $aging,
    ];
});

$router->get('/api/invoices', function (PDO $pdo): array {
    $kind = ModulaHttp::query('kind');
    if ($kind === 'customer' || $kind === 'vendor') {
        $rows = ModulaDb::all($pdo, 'SELECT * FROM invoices WHERE kind = ? ORDER BY id DESC', [$kind]);
    } else {
        $rows = ModulaDb::all($pdo, 'SELECT * FROM invoices ORDER BY id DESC');
    }
    foreach ($rows as &$r) {
        $r['lines'] = json_decode((string) ($r['lines_json'] ?? '[]'), true) ?: [];
    }
    return ['invoices' => $rows];
});

$router->post('/api/invoices', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $kind = ModulaHttp::str($in, 'kind', 'customer', 20);
    if ($kind !== 'customer' && $kind !== 'vendor') {
        $kind = 'customer';
    }
    $party = ModulaHttp::str($in, 'party_name', '', 140);
    if ($party === '') {
        ModulaHttp::error('Customer or vendor name is required.', 422);
    }
    $rawLines = isset($in['lines']) && is_array($in['lines']) ? $in['lines'] : [];
    if (count($rawLines) === 0) {
        ModulaHttp::error('Add at least one line item.', 422);
    }
    $lines = [];
    $subtotal = 0.0;
    foreach ($rawLines as $l) {
        if (!is_array($l)) {
            continue;
        }
        $qty = max(1.0, (float) ($l['qty'] ?? 1));
        $unit = max(0.0, (float) ($l['unitPrice'] ?? 0));
        $subtotal += $qty * $unit;
        $lines[] = [
            'description' => trim((string) ($l['description'] ?? 'Line Item')),
            'qty' => $qty,
            'unitPrice' => $unit,
        ];
    }
    $taxRate = max(0.0, min(50.0, ModulaHttp::float($in, 'tax_rate', 10.0)));
    $subtotal = round($subtotal, 2);
    $taxAmount = round($subtotal * ($taxRate / 100.0), 2);
    $total = round($subtotal + $taxAmount, 2);
    $count = ((int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM invoices WHERE kind = ?', [$kind])) + 101;
    $prefix = $kind === 'customer' ? 'INV-2026-' : 'BILL-2026-';
    $invNumber = $prefix . $count;

    $pdo->beginTransaction();
    try {
        $id = ModulaDb::exec(
            $pdo,
            'INSERT INTO invoices (invoice_number, kind, party_name, issue_date, due_date, status, subtotal, tax_amount, total, paid_amount, lines_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)',
            [
                $invNumber,
                $kind,
                $party,
                ModulaHttp::str($in, 'issue_date', ModulaHttp::today(), 20),
                ModulaHttp::str($in, 'due_date', date('Y-m-d', time() + 86400 * 30), 20),
                'Sent',
                $subtotal,
                $taxAmount,
                $total,
                json_encode($lines, JSON_UNESCAPED_SLASHES),
            ]
        );
        if ($kind === 'customer') {
            postJournal($pdo, $invNumber, '1200', $total, 0.0, 'Invoice issued to ' . $party);
            postJournal($pdo, $invNumber, '4000', 0.0, $subtotal, 'Revenue recognized - ' . $party);
            if ($taxAmount > 0) {
                postJournal($pdo, $invNumber, '2100', 0.0, $taxAmount, 'Sales tax collected');
            }
        } else {
            postJournal($pdo, $invNumber, '5000', $subtotal, 0.0, 'Vendor bill from ' . $party);
            if ($taxAmount > 0) {
                postJournal($pdo, $invNumber, '2100', $taxAmount, 0.0, 'Input tax credit');
            }
            postJournal($pdo, $invNumber, '2000', 0.0, $total, 'Accounts Payable - ' . $party);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    $row = ModulaDb::one($pdo, 'SELECT * FROM invoices WHERE id = ?', [$id]);
    if ($row) {
        $row['lines'] = $lines;
    }
    return ['__status' => 201, '__body' => ['invoice' => $row]];
});

$router->post('/api/invoices/{id}/pay', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $inv = ModulaDb::one($pdo, 'SELECT * FROM invoices WHERE id = ?', [$id]);
    if (!$inv) {
        ModulaHttp::error('Invoice not found.', 404);
    }
    $remaining = round((float) $inv['total'] - (float) $inv['paid_amount'], 2);
    if ($remaining <= 0) {
        ModulaHttp::error('Invoice is already fully paid.', 409);
    }
    $in = ModulaHttp::body();
    $amount = isset($in['amount']) && (float) $in['amount'] > 0
        ? min($remaining, round((float) $in['amount'], 2))
        : $remaining;

    $newPaid = round((float) $inv['paid_amount'] + $amount, 2);
    $newStatus = $newPaid >= ((float) $inv['total'] - 0.01) ? 'Paid' : 'Partial';
    $payRef = 'PAY-' . $inv['invoice_number'];

    $pdo->beginTransaction();
    try {
        ModulaDb::exec($pdo, 'UPDATE invoices SET paid_amount = ?, status = ? WHERE id = ?', [$newPaid, $newStatus, $id]);
        if ($inv['kind'] === 'customer') {
            postJournal($pdo, $payRef, '1000', $amount, 0.0, 'Customer payment - ' . $inv['party_name']);
            postJournal($pdo, $payRef, '1200', 0.0, $amount, 'Receivable settled - ' . $inv['invoice_number']);
        } else {
            postJournal($pdo, $payRef, '2000', $amount, 0.0, 'Vendor bill paid - ' . $inv['party_name']);
            postJournal($pdo, $payRef, '1000', 0.0, $amount, 'Bank disbursement - ' . $inv['invoice_number']);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    $updated = ModulaDb::one($pdo, 'SELECT * FROM invoices WHERE id = ?', [$id]);
    if ($updated) {
        $updated['lines'] = json_decode((string) $updated['lines_json'], true) ?: [];
    }
    return ['invoice' => $updated];
});

// Credit Note (Odoo Invoice Reversal)
$router->post('/api/invoices/{id}/credit-note', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $inv = ModulaDb::one($pdo, 'SELECT * FROM invoices WHERE id = ?', [$id]);
    if (!$inv || $inv['kind'] !== 'customer') {
        ModulaHttp::error('Customer invoice not found.', 404);
    }
    if ($inv['status'] === 'Credited') {
        ModulaHttp::error('Invoice already credited.', 409);
    }
    $ref = 'CN-' . $inv['invoice_number'];
    $sub = (float) $inv['subtotal'];
    $tax = (float) $inv['tax_amount'];
    $tot = (float) $inv['total'];

    $pdo->beginTransaction();
    try {
        ModulaDb::exec($pdo, "UPDATE invoices SET status = 'Credited', paid_amount = total WHERE id = ?", [$id]);
        postJournal($pdo, $ref, '4000', $sub, 0.0, 'Credit Note reversal - ' . $inv['party_name']);
        if ($tax > 0) {
            postJournal($pdo, $ref, '2100', $tax, 0.0, 'Credit Note tax reversal');
        }
        postJournal($pdo, $ref, '1200', 0.0, $tot, 'AR reversed via ' . $ref);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }
    return ['invoice' => ModulaDb::one($pdo, 'SELECT * FROM invoices WHERE id = ?', [$id])];
});

// Bank Feed & Smart Reconciliation
$router->get('/api/bank', function (PDO $pdo): array {
    $txs = ModulaDb::all($pdo, 'SELECT * FROM bank_transactions ORDER BY reconciled ASC, id DESC');
    $openInvoices = ModulaDb::all($pdo, "SELECT * FROM invoices WHERE status NOT IN ('Paid', 'Credited')");
    foreach ($txs as &$tx) {
        $suggested = null;
        if ((int) $tx['reconciled'] === 0) {
            $amt = (float) $tx['amount'];
            $wantKind = $amt >= 0 ? 'customer' : 'vendor';
            $absAmt = abs($amt);
            foreach ($openInvoices as $inv) {
                if ($inv['kind'] !== $wantKind) {
                    continue;
                }
                $due = round((float) $inv['total'] - (float) $inv['paid_amount'], 2);
                if (abs($due - $absAmt) < 0.05 || stripos((string) $inv['party_name'], (string) $tx['counterparty']) !== false) {
                    $suggested = [
                        'id' => (int) $inv['id'],
                        'invoice_number' => $inv['invoice_number'],
                        'party_name' => $inv['party_name'],
                        'balance_due' => $due,
                    ];
                    break;
                }
            }
        }
        $tx['suggested'] = $suggested;
    }
    return ['transactions' => $txs];
});

$router->post('/api/bank', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $party = ModulaHttp::str($in, 'counterparty', '', 120);
    $amount = round(ModulaHttp::float($in, 'amount', 0.0), 2);
    if ($party === '' || $amount == 0.0) {
        ModulaHttp::error('Counterparty and non-zero amount are required.', 422);
    }
    $id = ModulaDb::exec(
        $pdo,
        'INSERT INTO bank_transactions (tx_date, bank_ref, counterparty, memo, amount, reconciled, matched_invoice_id)
         VALUES (?, ?, ?, ?, ?, 0, NULL)',
        [
            ModulaHttp::str($in, 'tx_date', ModulaHttp::today(), 20),
            ModulaHttp::str($in, 'bank_ref', 'TX-' . time(), 40),
            $party,
            ModulaHttp::str($in, 'memo', '', 200),
            $amount,
        ]
    );
    return ['__status' => 201, '__body' => ['transaction' => ModulaDb::one($pdo, 'SELECT * FROM bank_transactions WHERE id = ?', [$id])]];
});

$router->post('/api/bank/{id}/reconcile', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $tx = ModulaDb::one($pdo, 'SELECT * FROM bank_transactions WHERE id = ?', [$id]);
    if (!$tx) {
        ModulaHttp::error('Bank transaction not found.', 404);
    }
    if ((int) $tx['reconciled'] === 1) {
        ModulaHttp::error('Transaction already reconciled.', 409);
    }
    $in = ModulaHttp::body();
    $invoiceId = ModulaHttp::int($in, 'invoice_id', 0);
    $absAmt = round(abs((float) $tx['amount']), 2);
    $isInflow = (float) $tx['amount'] >= 0;

    $pdo->beginTransaction();
    try {
        if ($invoiceId > 0) {
            $inv = ModulaDb::one($pdo, 'SELECT * FROM invoices WHERE id = ?', [$invoiceId]);
            if (!$inv) {
                throw new RuntimeException('Matched invoice not found.');
            }
            $remaining = round((float) $inv['total'] - (float) $inv['paid_amount'], 2);
            $apply = min($remaining, $absAmt);
            $newPaid = round((float) $inv['paid_amount'] + $apply, 2);
            $newStatus = $newPaid >= ((float) $inv['total'] - 0.01) ? 'Paid' : 'Partial';
            ModulaDb::exec($pdo, 'UPDATE invoices SET paid_amount = ?, status = ? WHERE id = ?', [$newPaid, $newStatus, $invoiceId]);
            $ref = 'REC-' . $tx['bank_ref'];
            if ($inv['kind'] === 'customer') {
                postJournal($pdo, $ref, '1000', $apply, 0.0, 'Bank reconciled - ' . $tx['counterparty']);
                postJournal($pdo, $ref, '1200', 0.0, $apply, 'Reconciled against ' . $inv['invoice_number']);
            } else {
                postJournal($pdo, $ref, '2000', $apply, 0.0, 'Vendor bill reconciled - ' . $inv['invoice_number']);
                postJournal($pdo, $ref, '1000', 0.0, $apply, 'Bank outflow - ' . $tx['bank_ref']);
            }
            ModulaDb::exec($pdo, 'UPDATE bank_transactions SET reconciled = 1, matched_invoice_id = ? WHERE id = ?', [$invoiceId, $id]);
        } else {
            $ref = 'REC-' . $tx['bank_ref'];
            if ($isInflow) {
                postJournal($pdo, $ref, '1000', $absAmt, 0.0, 'Direct bank receipt - ' . $tx['counterparty']);
                postJournal($pdo, $ref, '4100', 0.0, $absAmt, (string) ($tx['memo'] ?: 'Direct revenue'));
            } else {
                postJournal($pdo, $ref, '6100', $absAmt, 0.0, 'Direct bank expense - ' . $tx['counterparty']);
                postJournal($pdo, $ref, '1000', 0.0, $absAmt, (string) ($tx['memo'] ?: 'Operating outflow'));
            }
            ModulaDb::exec($pdo, 'UPDATE bank_transactions SET reconciled = 1 WHERE id = ?', [$id]);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        ModulaHttp::error($e->getMessage(), 400);
    }

    return ['transaction' => ModulaDb::one($pdo, 'SELECT * FROM bank_transactions WHERE id = ?', [$id])];
});

// Expenses
$router->get('/api/expenses', function (PDO $pdo): array {
    return ['expenses' => ModulaDb::all($pdo, 'SELECT * FROM expenses ORDER BY id DESC')];
});

$router->post('/api/expenses', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $employee = ModulaHttp::str($in, 'employee_name', '', 100);
    $desc = ModulaHttp::str($in, 'description', '', 240);
    $amount = round(max(0.01, ModulaHttp::float($in, 'amount', 0.0)), 2);
    if ($employee === '' || $desc === '') {
        ModulaHttp::error('Employee name and description are required.', 422);
    }
    $id = ModulaDb::exec(
        $pdo,
        'INSERT INTO expenses (employee_name, category, description, amount, expense_date, status) VALUES (?, ?, ?, ?, ?, ?)',
        [
            $employee,
            ModulaHttp::str($in, 'category', 'Travel', 60),
            $desc,
            $amount,
            ModulaHttp::str($in, 'expense_date', ModulaHttp::today(), 20),
            'Submitted',
        ]
    );
    return ['__status' => 201, '__body' => ['expense' => ModulaDb::one($pdo, 'SELECT * FROM expenses WHERE id = ?', [$id])]];
});

$router->patch('/api/expenses/{id}/status', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $in = ModulaHttp::body();
    $status = ModulaHttp::str($in, 'status', '', 30);
    if (!in_array($status, ['Submitted', 'Approved', 'Reimbursed', 'Rejected'], true)) {
        ModulaHttp::error('Invalid expense status.', 422);
    }
    $exp = ModulaDb::one($pdo, 'SELECT * FROM expenses WHERE id = ?', [$id]);
    if (!$exp) {
        ModulaHttp::error('Expense not found.', 404);
    }
    $pdo->beginTransaction();
    try {
        ModulaDb::exec($pdo, 'UPDATE expenses SET status = ? WHERE id = ?', [$status, $id]);
        if ($status === 'Reimbursed' && $exp['status'] !== 'Reimbursed') {
            $amt = (float) $exp['amount'];
            postJournal($pdo, 'EXP-' . $id, '6100', $amt, 0.0, $exp['employee_name'] . ': ' . $exp['description']);
            postJournal($pdo, 'EXP-' . $id, '1000', 0.0, $amt, 'Expense reimbursement paid');
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }
    return ['expense' => ModulaDb::one($pdo, 'SELECT * FROM expenses WHERE id = ?', [$id])];
});

// Ledger & Manual Balanced Journal
$router->get('/api/ledger', function (PDO $pdo): array {
    return [
        'accounts' => ModulaDb::all($pdo, 'SELECT * FROM accounts ORDER BY code ASC'),
        'entries' => ModulaDb::all($pdo, 'SELECT * FROM journal_entries ORDER BY id DESC LIMIT 80'),
    ];
});

$router->post('/api/journal', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $ref = ModulaHttp::str($in, 'reference', 'JE-' . time(), 40);
    $debitCode = ModulaHttp::str($in, 'debit_account', '', 20);
    $creditCode = ModulaHttp::str($in, 'credit_account', '', 20);
    $amount = round(ModulaHttp::float($in, 'amount', 0.0), 2);
    $memo = ModulaHttp::str($in, 'memo', 'Manual journal adjustment', 200);
    if ($debitCode === '' || $creditCode === '' || $debitCode === $creditCode || $amount <= 0) {
        ModulaHttp::error('Choose two distinct accounts and a positive amount.', 422);
    }
    $pdo->beginTransaction();
    try {
        postJournal($pdo, $ref, $debitCode, $amount, 0.0, $memo);
        postJournal($pdo, $ref, $creditCode, 0.0, $amount, $memo);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }
    return ['__status' => 201, '__body' => ['posted' => true, 'reference' => $ref]];
});

$router->dispatch();
