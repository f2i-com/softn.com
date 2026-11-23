<?php
declare(strict_types=1);

require_once __DIR__ . '/opal_micro.php';

$router = new OpalRouter('opal.banking', 'Opal Banking, Feeds & Reconciliation', __DIR__ . '/schema.sql');

$router->get('/api/overview', function (PDO $pdo): array {
    $totalCash = (float) OpalDb::scalar($pdo, "SELECT COALESCE(SUM(balance), 0) FROM bank_accounts WHERE account_type != 'Credit Card'");
    $creditUsed = (float) OpalDb::scalar($pdo, "SELECT COALESCE(SUM(balance), 0) FROM bank_accounts WHERE account_type = 'Credit Card'");
    $unallocated = (int) OpalDb::scalar($pdo, 'SELECT COUNT(*) FROM bank_transactions WHERE allocated = 0');
    $unreconciled = (int) OpalDb::scalar($pdo, 'SELECT COUNT(*) FROM bank_transactions WHERE reconciled = 0');
    $activeRules = (int) OpalDb::scalar($pdo, 'SELECT COUNT(*) FROM bank_rules WHERE active = 1');
    $accountCount = (int) OpalDb::scalar($pdo, 'SELECT COUNT(*) FROM bank_accounts');

    return [
        'totalCash' => round($totalCash, 2),
        'creditCardBalance' => round($creditUsed, 2),
        'netPosition' => round($totalCash + $creditUsed, 2),
        'unallocatedCount' => $unallocated,
        'unreconciledCount' => $unreconciled,
        'activeRules' => $activeRules,
        'accountCount' => $accountCount,
    ];
});

$router->get('/api/accounts', function (PDO $pdo): array {
    $accounts = OpalDb::all($pdo, 'SELECT * FROM bank_accounts ORDER BY id ASC');
    foreach ($accounts as &$acc) {
        $acc['unallocated'] = (int) OpalDb::scalar($pdo, 'SELECT COUNT(*) FROM bank_transactions WHERE account_id = ? AND allocated = 0', [(int) $acc['id']]);
    }
    return ['accounts' => $accounts];
});

$router->get('/api/transactions', function (PDO $pdo): array {
    $accId = (int) OpalHttp::query('account_id', '0');
    if ($accId > 0) {
        $rows = OpalDb::all($pdo, 'SELECT * FROM bank_transactions WHERE account_id = ? ORDER BY allocated ASC, tx_date DESC, id DESC', [$accId]);
    } else {
        $rows = OpalDb::all($pdo, 'SELECT * FROM bank_transactions ORDER BY allocated ASC, tx_date DESC, id DESC');
    }
    return ['transactions' => $rows];
});

$router->post('/api/transactions/{id}/allocate', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $tx = OpalDb::one($pdo, 'SELECT * FROM bank_transactions WHERE id = ?', [$id]);
    if (!$tx) {
        OpalHttp::error('Bank transaction not found.', 404);
    }
    $in = OpalHttp::body();
    $category = OpalHttp::str($in, 'category', '', 120);
    if ($category === '') {
        OpalHttp::error('Select an account category to allocate this transaction.', 422);
    }
    $taxCode = strtoupper(OpalHttp::str($in, 'tax_code', 'GST', 10));
    $label = OpalHttp::str($in, 'label', 'Allocated', 80);

    OpalDb::exec(
        $pdo,
        'UPDATE bank_transactions SET category = ?, tax_code = ?, allocated = 1, matched_rule = ? WHERE id = ?',
        [$category, $taxCode, $label, $id]
    );
    return ['transaction' => OpalDb::one($pdo, 'SELECT * FROM bank_transactions WHERE id = ?', [$id])];
});

$router->post('/api/feeds/sync', function (PDO $pdo): array {
    $samples = [
        [1, 'OSKO-' . rand(10000, 99999), 'OSKO KANGAROO VALLEY ORGANICS INV-000403', 'Kangaroo Valley Organics', 6820.00, 'Match Overdue Invoice INV-000403 ($6,820.00)'],
        [1, 'DD-' . rand(10000, 99999), 'DIRECT DEBIT TELSTRA FIBRE SYDNEY', 'Telstra Business Australia', -242.00, ''],
        [3, 'VISA-' . rand(1000, 9999), 'BUNNINGS TRADE ALEXANDRIA NSW', 'Bunnings Trade Pty Ltd', -189.20, ''],
    ];
    $count = (int) OpalDb::scalar($pdo, 'SELECT COUNT(*) FROM bank_transactions');
    $pick = $samples[$count % count($samples)];

    $pdo->beginTransaction();
    try {
        $txId = OpalDb::exec(
            $pdo,
            'INSERT INTO bank_transactions (account_id, tx_date, bank_ref, description, counterparty, amount, category, tax_code, allocated, reconciled, matched_rule, suggested_match)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)',
            [$pick[0], OpalHttp::today(), $pick[1], $pick[2], $pick[3], $pick[4], '', 'GST', '', $pick[5]]
        );
        OpalDb::exec($pdo, 'UPDATE bank_accounts SET balance = ROUND(balance + ?, 2), statement_balance = ROUND(statement_balance + ?, 2), last_synced = ? WHERE id = ?', [$pick[4], $pick[4], OpalHttp::now(), $pick[0]]);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    return ['__status' => 201, '__body' => ['transaction' => OpalDb::one($pdo, 'SELECT * FROM bank_transactions WHERE id = ?', [$txId])]];
});

$router->post('/api/money', function (PDO $pdo): array {
    $in = OpalHttp::body();
    $kind = OpalHttp::str($in, 'kind', 'spend', 20);
    $accountId = OpalHttp::int($in, 'account_id', 1);
    $amount = round(abs(OpalHttp::float($in, 'amount', 0.0)), 2);
    if ($amount <= 0.0) {
        OpalHttp::error('Amount must be greater than $0.', 422);
    }

    if ($kind === 'transfer') {
        $toAccountId = OpalHttp::int($in, 'to_account_id', 2);
        if ($toAccountId === $accountId) {
            OpalHttp::error('Source and destination bank accounts must differ.', 422);
        }
        $fromAcc = OpalDb::one($pdo, 'SELECT * FROM bank_accounts WHERE id = ?', [$accountId]);
        $toAcc = OpalDb::one($pdo, 'SELECT * FROM bank_accounts WHERE id = ?', [$toAccountId]);
        if (!$fromAcc || !$toAcc) {
            OpalHttp::error('Bank account not found.', 404);
        }
        $ref = 'TRF-' . substr((string) time(), -5);
        $pdo->beginTransaction();
        try {
            OpalDb::exec($pdo, 'UPDATE bank_accounts SET balance = ROUND(balance - ?, 2), statement_balance = ROUND(statement_balance - ?, 2) WHERE id = ?', [$amount, $amount, $accountId]);
            OpalDb::exec($pdo, 'UPDATE bank_accounts SET balance = ROUND(balance + ?, 2), statement_balance = ROUND(statement_balance + ?, 2) WHERE id = ?', [$amount, $amount, $toAccountId]);
            OpalDb::exec(
                $pdo,
                'INSERT INTO bank_transactions (account_id, tx_date, bank_ref, description, counterparty, amount, category, tax_code, allocated, reconciled, matched_rule)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)',
                [$accountId, OpalHttp::today(), $ref, 'Transfer to ' . $toAcc['name'], (string) $toAcc['name'], -$amount, '1-1900 Inter-Account Transfer', 'N-T', 'Transfer']
            );
            OpalDb::exec(
                $pdo,
                'INSERT INTO bank_transactions (account_id, tx_date, bank_ref, description, counterparty, amount, category, tax_code, allocated, reconciled, matched_rule)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)',
                [$toAccountId, OpalHttp::today(), $ref, 'Transfer from ' . $fromAcc['name'], (string) $fromAcc['name'], $amount, '1-1900 Inter-Account Transfer', 'N-T', 'Transfer']
            );
            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
        return ['__status' => 201, '__body' => ['ok' => true, 'reference' => $ref]];
    }

    $signed = $kind === 'receive' ? $amount : -$amount;
    $desc = OpalHttp::str($in, 'description', $kind === 'receive' ? 'Receive Money' : 'Spend Money', 180);
    $counterparty = OpalHttp::str($in, 'counterparty', '', 140);
    $category = OpalHttp::str($in, 'category', $kind === 'receive' ? '4-1100 Sales Revenue' : '6-1400 Office Supplies', 100);
    $taxCode = strtoupper(OpalHttp::str($in, 'tax_code', 'GST', 10));
    $ref = ($kind === 'receive' ? 'RCV-' : 'SPD-') . substr((string) time(), -5);

    $pdo->beginTransaction();
    try {
        $txId = OpalDb::exec(
            $pdo,
            'INSERT INTO bank_transactions (account_id, tx_date, bank_ref, description, counterparty, amount, category, tax_code, allocated, reconciled, matched_rule)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)',
            [$accountId, OpalHttp::today(), $ref, $desc, $counterparty, $signed, $category, $taxCode, $kind === 'receive' ? 'Receive Money' : 'Spend Money']
        );
        OpalDb::exec($pdo, 'UPDATE bank_accounts SET balance = ROUND(balance + ?, 2), statement_balance = ROUND(statement_balance + ?, 2) WHERE id = ?', [$signed, $signed, $accountId]);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    return ['__status' => 201, '__body' => ['transaction' => OpalDb::one($pdo, 'SELECT * FROM bank_transactions WHERE id = ?', [$txId])]];
});

$router->get('/api/rules', function (PDO $pdo): array {
    return ['rules' => OpalDb::all($pdo, 'SELECT * FROM bank_rules ORDER BY id DESC')];
});

$router->post('/api/rules', function (PDO $pdo): array {
    $in = OpalHttp::body();
    $name = OpalHttp::str($in, 'rule_name', '', 120);
    $match = strtoupper(OpalHttp::str($in, 'match_text', '', 120));
    $cat = OpalHttp::str($in, 'category', '', 120);
    if ($name === '' || $match === '' || $cat === '') {
        OpalHttp::error('Rule name, match text, and category are required.', 422);
    }
    $id = OpalDb::exec(
        $pdo,
        'INSERT INTO bank_rules (rule_name, match_text, direction, category, tax_code, contact_name, times_applied, active)
         VALUES (?, ?, ?, ?, ?, ?, 0, 1)',
        [
            $name,
            $match,
            OpalHttp::str($in, 'direction', 'spend', 20),
            $cat,
            strtoupper(OpalHttp::str($in, 'tax_code', 'GST', 10)),
            OpalHttp::str($in, 'contact_name', '', 120),
        ]
    );
    return ['__status' => 201, '__body' => ['rule' => OpalDb::one($pdo, 'SELECT * FROM bank_rules WHERE id = ?', [$id])]];
});

$router->post('/api/rules/apply', function (PDO $pdo): array {
    $rules = OpalDb::all($pdo, 'SELECT * FROM bank_rules WHERE active = 1');
    $unallocated = OpalDb::all($pdo, 'SELECT * FROM bank_transactions WHERE allocated = 0');
    $applied = 0;

    $pdo->beginTransaction();
    try {
        foreach ($unallocated as $tx) {
            $descUpper = strtoupper((string) $tx['description']);
            $amt = (float) $tx['amount'];
            foreach ($rules as $rule) {
                $needle = strtoupper((string) $rule['match_text']);
                if ($needle === '') continue;
                $dirOk = ($rule['direction'] === 'spend' && $amt < 0) || ($rule['direction'] === 'receive' && $amt > 0);
                if ($dirOk && strpos($descUpper, $needle) !== false) {
                    OpalDb::exec(
                        $pdo,
                        'UPDATE bank_transactions SET category = ?, tax_code = ?, allocated = 1, matched_rule = ? WHERE id = ?',
                        [(string) $rule['category'], (string) $rule['tax_code'], 'Rule: ' . $rule['rule_name'], (int) $tx['id']]
                    );
                    OpalDb::exec($pdo, 'UPDATE bank_rules SET times_applied = times_applied + 1 WHERE id = ?', [(int) $rule['id']]);
                    $applied++;
                    break;
                }
            }
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    return ['appliedCount' => $applied];
});

$router->get('/api/reconciliations', function (PDO $pdo): array {
    return ['reconciliations' => OpalDb::all($pdo, 'SELECT * FROM reconciliations ORDER BY id DESC')];
});

$router->post('/api/reconcile', function (PDO $pdo): array {
    $in = OpalHttp::body();
    $accountId = OpalHttp::int($in, 'account_id', 1);
    $acc = OpalDb::one($pdo, 'SELECT * FROM bank_accounts WHERE id = ?', [$accountId]);
    if (!$acc) {
        OpalHttp::error('Bank account not found.', 404);
    }
    $txIds = isset($in['transaction_ids']) && is_array($in['transaction_ids']) ? $in['transaction_ids'] : [];
    $stmtDate = OpalHttp::str($in, 'statement_date', OpalHttp::today(), 20);
    $stmtBal = round(OpalHttp::float($in, 'statement_balance', (float) $acc['balance']), 2);

    $pdo->beginTransaction();
    try {
        $cleared = 0;
        foreach ($txIds as $tid) {
            OpalDb::exec($pdo, 'UPDATE bank_transactions SET reconciled = 1 WHERE id = ? AND account_id = ?', [(int) $tid, $accountId]);
            $cleared++;
        }
        $recId = OpalDb::exec(
            $pdo,
            'INSERT INTO reconciliations (account_id, account_name, statement_date, statement_balance, cleared_count, reconciled_at)
             VALUES (?, ?, ?, ?, ?, ?)',
            [$accountId, (string) $acc['name'], $stmtDate, $stmtBal, $cleared, OpalHttp::now()]
        );
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    return ['__status' => 201, '__body' => ['reconciliation' => OpalDb::one($pdo, 'SELECT * FROM reconciliations WHERE id = ?', [$recId])]];
});

$router->dispatch();
