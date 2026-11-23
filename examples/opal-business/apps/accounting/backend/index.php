<?php
declare(strict_types=1);

require_once __DIR__ . '/opal_micro.php';

$router = new OpalRouter('opal.accounting', 'Opal Accounting, Journals & GST/BAS', __DIR__ . '/schema.sql');

function computeBasSnapshot(PDO $pdo): array
{
    $txs = OpalDb::all($pdo, "SELECT * FROM tax_transactions WHERE period = 'Q2 FY2026-27' ORDER BY id DESC");
    $g1 = 0.0;
    $g2 = 0.0;
    $g3 = 0.0;
    $g10 = 0.0;
    $g11 = 0.0;
    $gst1a = 0.0;
    $gst1b = 0.0;
    $anomalies = [];

    foreach ($txs as $t) {
        $gross = (float) $t['gross_amount'];
        $gst = (float) $t['gst_amount'];
        $tc = strtoupper((string) $t['tax_code']);
        if ($t['direction'] === 'sale') {
            $g1 += $gross;
            if ($tc === 'EXP') {
                $g2 += $gross;
            } elseif ($tc === 'FRE') {
                $g3 += $gross;
            }
            $gst1a += $gst;
        } else {
            if ($tc === 'CAP') {
                $g10 += $gross;
            } else {
                $g11 += $gross;
            }
            $gst1b += $gst;
        }
        if (trim((string) $t['anomaly_flag']) !== '' && (int) $t['resolved'] === 0) {
            $anomalies[] = $t;
        }
    }

    $w1 = (float) OpalDb::scalar($pdo, "SELECT COALESCE(balance, 0) FROM accounts WHERE code = '6-3100'");
    $w2 = (float) OpalDb::scalar($pdo, "SELECT COALESCE(balance, 0) FROM accounts WHERE code = '2-1400'");
    $netGst = round($gst1a - $gst1b, 2);
    $netBas = round($netGst + $w2, 2);

    return [
        'period' => 'Q2 FY2026-27',
        'dateRange' => '1 Oct 2026 - 31 Dec 2026',
        'dueDate' => '2027-02-28',
        'G1' => round($g1, 2),
        'G2' => round($g2, 2),
        'G3' => round($g3, 2),
        'G10' => round($g10, 2),
        'G11' => round($g11, 2),
        '1A' => round($gst1a, 2),
        '1B' => round($gst1b, 2),
        'netGst' => $netGst,
        'W1' => round($w1, 2),
        'W2' => round($w2, 2),
        'netBasPayable' => $netBas,
        'anomalies' => $anomalies,
        'transactions' => $txs,
    ];
}

function applyAccountDelta(PDO $pdo, string $code, float $debit, float $credit): ?array
{
    $acc = OpalDb::one($pdo, 'SELECT * FROM accounts WHERE code = ?', [$code]);
    if (!$acc) {
        return null;
    }
    $cls = (string) $acc['classification'];
    $debitNormal = in_array($cls, ['Asset', 'Expense', 'Cost of Sales', 'Other Expense'], true);
    $delta = $debitNormal ? ($debit - $credit) : ($credit - $debit);
    OpalDb::exec($pdo, 'UPDATE accounts SET balance = ROUND(balance + ?, 2) WHERE code = ?', [$delta, $code]);
    return $acc;
}

$router->get('/api/overview', function (PDO $pdo): array {
    $assets = (float) OpalDb::scalar($pdo, "SELECT COALESCE(SUM(balance), 0) FROM accounts WHERE classification = 'Asset'");
    $liab = (float) OpalDb::scalar($pdo, "SELECT COALESCE(SUM(balance), 0) FROM accounts WHERE classification = 'Liability'");
    $income = (float) OpalDb::scalar($pdo, "SELECT COALESCE(SUM(balance), 0) FROM accounts WHERE classification IN ('Income', 'Other Income')");
    $expenses = (float) OpalDb::scalar($pdo, "SELECT COALESCE(SUM(balance), 0) FROM accounts WHERE classification IN ('Cost of Sales', 'Expense', 'Other Expense')");
    $bas = computeBasSnapshot($pdo);
    $accountCount = (int) OpalDb::scalar($pdo, 'SELECT COUNT(*) FROM accounts');
    $journalCount = (int) OpalDb::scalar($pdo, 'SELECT COUNT(*) FROM journal_entries');

    return [
        'totalAssets' => round($assets, 2),
        'totalLiabilities' => round($liab, 2),
        'netProfit' => round($income - $expenses, 2),
        'netBasPayable' => $bas['netBasPayable'],
        'anomalyCount' => count($bas['anomalies']),
        'accountCount' => $accountCount,
        'journalCount' => $journalCount,
    ];
});

$router->get('/api/accounts', function (PDO $pdo): array {
    return ['accounts' => OpalDb::all($pdo, 'SELECT * FROM accounts ORDER BY code ASC')];
});

$router->post('/api/accounts', function (PDO $pdo): array {
    $in = OpalHttp::body();
    $code = OpalHttp::str($in, 'code', '', 20);
    $name = OpalHttp::str($in, 'name', '', 140);
    $cls = OpalHttp::str($in, 'classification', 'Expense', 40);
    if ($code === '' || $name === '') {
        OpalHttp::error('Account code (e.g. 6-2900) and name are required.', 422);
    }
    $id = OpalDb::exec(
        $pdo,
        'INSERT INTO accounts (code, name, classification, account_type, default_tax_code, balance, is_system)
         VALUES (?, ?, ?, ?, ?, ?, 0)',
        [
            $code,
            $name,
            $cls,
            OpalHttp::str($in, 'account_type', $cls, 50),
            strtoupper(OpalHttp::str($in, 'default_tax_code', 'GST', 10)),
            round(OpalHttp::float($in, 'balance', 0.0), 2),
        ]
    );
    return ['__status' => 201, '__body' => ['account' => OpalDb::one($pdo, 'SELECT * FROM accounts WHERE id = ?', [$id])]];
});

$router->get('/api/journals', function (PDO $pdo): array {
    $entries = OpalDb::all($pdo, 'SELECT * FROM journal_entries ORDER BY id DESC');
    foreach ($entries as &$e) {
        $e['lines'] = OpalDb::all($pdo, 'SELECT * FROM journal_lines WHERE journal_id = ? ORDER BY id ASC', [(int) $e['id']]);
    }
    return ['journals' => $entries];
});

$router->post('/api/journals', function (PDO $pdo): array {
    $in = OpalHttp::body();
    $memo = OpalHttp::str($in, 'memo', '', 240);
    $entryDate = OpalHttp::str($in, 'entry_date', OpalHttp::today(), 20);
    $rawLines = isset($in['lines']) && is_array($in['lines']) ? $in['lines'] : [];
    if ($memo === '' || count($rawLines) < 2) {
        OpalHttp::error('General journal requires a memo and at least two lines.', 422);
    }

    $totDr = 0.0;
    $totCr = 0.0;
    $parsed = [];
    foreach ($rawLines as $l) {
        if (!is_array($l)) continue;
        $code = trim((string) ($l['account_code'] ?? ''));
        $dr = round(max(0.0, (float) ($l['debit'] ?? 0)), 2);
        $cr = round(max(0.0, (float) ($l['credit'] ?? 0)), 2);
        if ($code === '' || ($dr == 0.0 && $cr == 0.0)) continue;
        $totDr += $dr;
        $totCr += $cr;
        $parsed[] = [
            'account_code' => $code,
            'tax_code' => strtoupper(trim((string) ($l['tax_code'] ?? 'N-T'))),
            'debit' => $dr,
            'credit' => $cr,
            'line_memo' => trim((string) ($l['line_memo'] ?? '')),
        ];
    }
    $totDr = round($totDr, 2);
    $totCr = round($totCr, 2);
    if ($totDr <= 0.0 || abs($totDr - $totCr) > 0.01) {
        OpalHttp::error("Journal entry is out of balance (Debits: \${$totDr}, Credits: \${$totCr}).", 422);
    }

    $count = (int) OpalDb::scalar($pdo, 'SELECT COUNT(*) FROM journal_entries');
    $jno = 'GJ-' . str_pad((string) (101 + $count + 1), 6, '0', STR_PAD_LEFT);

    $pdo->beginTransaction();
    try {
        $jid = OpalDb::exec(
            $pdo,
            'INSERT INTO journal_entries (journal_number, entry_date, memo, source, total_debit, total_credit, reversed)
             VALUES (?, ?, ?, ?, ?, ?, 0)',
            [$jno, $entryDate, $memo, 'General Journal', $totDr, $totCr]
        );
        foreach ($parsed as $pl) {
            $acc = applyAccountDelta($pdo, $pl['account_code'], $pl['debit'], $pl['credit']);
            if (!$acc) {
                throw new RuntimeException('Unknown account code: ' . $pl['account_code']);
            }
            OpalDb::exec(
                $pdo,
                'INSERT INTO journal_lines (journal_id, account_code, account_name, tax_code, debit, credit, line_memo)
                 VALUES (?, ?, ?, ?, ?, ?, ?)',
                [$jid, $pl['account_code'], (string) $acc['name'], $pl['tax_code'], $pl['debit'], $pl['credit'], $pl['line_memo']]
            );
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    $created = OpalDb::one($pdo, 'SELECT * FROM journal_entries WHERE id = ?', [$jid]);
    if ($created) {
        $created['lines'] = OpalDb::all($pdo, 'SELECT * FROM journal_lines WHERE journal_id = ?', [$jid]);
    }
    return ['__status' => 201, '__body' => ['journal' => $created]];
});

$router->post('/api/journals/{id}/reverse', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $orig = OpalDb::one($pdo, 'SELECT * FROM journal_entries WHERE id = ?', [$id]);
    if (!$orig || (int) $orig['reversed'] === 1) {
        OpalHttp::error('Journal entry not found or already reversed.', 404);
    }
    $lines = OpalDb::all($pdo, 'SELECT * FROM journal_lines WHERE journal_id = ?', [$id]);
    $count = (int) OpalDb::scalar($pdo, 'SELECT COUNT(*) FROM journal_entries');
    $jno = 'GJ-' . str_pad((string) (101 + $count + 1), 6, '0', STR_PAD_LEFT);

    $pdo->beginTransaction();
    try {
        OpalDb::exec($pdo, 'UPDATE journal_entries SET reversed = 1 WHERE id = ?', [$id]);
        $revId = OpalDb::exec(
            $pdo,
            'INSERT INTO journal_entries (journal_number, entry_date, memo, source, total_debit, total_credit, reversed)
             VALUES (?, ?, ?, ?, ?, ?, 0)',
            [$jno, OpalHttp::today(), 'Reversal of ' . $orig['journal_number'] . ': ' . $orig['memo'], 'Reversal', (float) $orig['total_credit'], (float) $orig['total_debit']]
        );
        foreach ($lines as $l) {
            $newDr = (float) $l['credit'];
            $newCr = (float) $l['debit'];
            applyAccountDelta($pdo, (string) $l['account_code'], $newDr, $newCr);
            OpalDb::exec(
                $pdo,
                'INSERT INTO journal_lines (journal_id, account_code, account_name, tax_code, debit, credit, line_memo)
                 VALUES (?, ?, ?, ?, ?, ?, ?)',
                [$revId, (string) $l['account_code'], (string) $l['account_name'], (string) $l['tax_code'], $newDr, $newCr, 'Reversal']
            );
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    return ['__status' => 201, '__body' => ['reversal' => OpalDb::one($pdo, 'SELECT * FROM journal_entries WHERE id = ?', [$revId])]];
});

$router->get('/api/bas', function (PDO $pdo): array {
    return [
        'bas' => computeBasSnapshot($pdo),
        'lodgements' => OpalDb::all($pdo, 'SELECT * FROM bas_lodgements ORDER BY id DESC'),
    ];
});

$router->post('/api/bas/anomalies/{id}/resolve', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $tx = OpalDb::one($pdo, 'SELECT * FROM tax_transactions WHERE id = ?', [$id]);
    if (!$tx) {
        OpalHttp::error('Tax transaction not found.', 404);
    }
    $in = OpalHttp::body();
    $newCode = strtoupper(OpalHttp::str($in, 'tax_code', (string) $tx['tax_code'], 10));
    OpalDb::exec($pdo, 'UPDATE tax_transactions SET tax_code = ?, resolved = 1 WHERE id = ?', [$newCode, $id]);
    return ['bas' => computeBasSnapshot($pdo)];
});

$router->post('/api/bas/lodge', function (PDO $pdo): array {
    $bas = computeBasSnapshot($pdo);
    $receipt = 'ATO-BAS-2026Q2-' . rand(100000, 999999);
    $id = OpalDb::exec(
        $pdo,
        'INSERT INTO bas_lodgements
          (period, date_range, g1_sales, g2_exports, g3_gst_free, g10_capital, g11_non_capital, gst_1a, gst_1b, w1_wages, w2_payg, net_payable, status, ato_receipt, lodged_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
            $bas['period'],
            $bas['dateRange'],
            $bas['G1'],
            $bas['G2'],
            $bas['G3'],
            $bas['G10'],
            $bas['G11'],
            $bas['1A'],
            $bas['1B'],
            $bas['W1'],
            $bas['W2'],
            $bas['netBasPayable'],
            'Lodged',
            $receipt,
            OpalHttp::now(),
        ]
    );
    return ['__status' => 201, '__body' => ['lodgement' => OpalDb::one($pdo, 'SELECT * FROM bas_lodgements WHERE id = ?', [$id])]];
});

$router->dispatch();
