<?php
declare(strict_types=1);

require_once __DIR__ . '/opal_micro.php';

$router = new OpalRouter('opal.reporting', 'Opal Financial Reports & Multi-Currency', __DIR__ . '/schema.sql');

$router->get('/api/statements', function (PDO $pdo): array {
    $basis = strtolower(OpalHttp::query('basis', 'accrual')) === 'cash' ? 'cash' : 'accrual';
    $col = $basis === 'cash' ? 'cash_amount' : 'accrual_amount';
    $rows = OpalDb::all($pdo, 'SELECT * FROM ledger_summary ORDER BY code ASC');

    $income = [];
    $cogs = [];
    $expenses = [];
    $assets = [];
    $liabilities = [];
    $equity = [];

    $sum = fn (array $list): float => round(array_reduce($list, fn (float $c, array $r) => $c + (float) $r['amount'], 0.0), 2);
    $sumPrior = fn (array $list): float => round(array_reduce($list, fn (float $c, array $r) => $c + (float) $r['prior_amount'], 0.0), 2);

    foreach ($rows as $r) {
        $amt = round((float) $r[$col], 2);
        $prior = round((float) $r['prior_amount'], 2);
        $varAmt = round($amt - $prior, 2);
        $varPct = $prior != 0.0 ? round(($varAmt / abs($prior)) * 100, 1) : 0.0;
        $item = [
            'code' => $r['code'],
            'name' => $r['name'],
            'section' => $r['section'],
            'amount' => $amt,
            'prior_amount' => $prior,
            'variance' => $varAmt,
            'variance_pct' => $varPct,
        ];
        switch ($r['section']) {
            case 'Income': $income[] = $item; break;
            case 'COGS': $cogs[] = $item; break;
            case 'Expense': $expenses[] = $item; break;
            case 'Asset': $assets[] = $item; break;
            case 'Liability': $liabilities[] = $item; break;
            case 'Equity': $equity[] = $item; break;
        }
    }

    $totIncome = $sum($income);
    $totCogs = $sum($cogs);
    $grossProfit = round($totIncome - $totCogs, 2);
    $totExpenses = $sum($expenses);
    $netProfit = round($grossProfit - $totExpenses, 2);

    $priorNet = round($sumPrior($income) - $sumPrior($cogs) - $sumPrior($expenses), 2);

    $totAssets = $sum($assets);
    $totLiab = $sum($liabilities);
    $totBaseEquity = $sum($equity);
    $currentEarnings = round($totAssets - $totLiab - $totBaseEquity, 2);
    $totEquity = round($totBaseEquity + $currentEarnings, 2);

    // Build Trial Balance (always Accrual double-entry check)
    $tbRows = [];
    $tbDr = 0.0;
    $tbCr = 0.0;
    foreach ($rows as $r) {
        $amt = round((float) $r['accrual_amount'], 2);
        $isDebit = in_array($r['section'], ['Asset', 'COGS', 'Expense'], true);
        $dr = $isDebit ? $amt : 0.0;
        $cr = $isDebit ? 0.0 : $amt;
        $tbDr += $dr;
        $tbCr += $cr;
        $tbRows[] = ['code' => $r['code'], 'name' => $r['name'], 'section' => $r['section'], 'debit' => $dr, 'credit' => $cr];
    }

    $monthly = OpalDb::all($pdo, 'SELECT * FROM monthly_cashflow ORDER BY id ASC');
    $opCash = round(array_reduce($monthly, fn ($c, $m) => $c + (float) $m['operating_cash'], 0.0), 2);
    $invCash = round(array_reduce($monthly, fn ($c, $m) => $c + (float) $m['investing_cash'], 0.0), 2);
    $finCash = round(array_reduce($monthly, fn ($c, $m) => $c + (float) $m['financing_cash'], 0.0), 2);

    $agedAr = OpalDb::all($pdo, "SELECT * FROM aged_items WHERE side = 'receivable' ORDER BY id ASC");
    $agedAp = OpalDb::all($pdo, "SELECT * FROM aged_items WHERE side = 'payable' ORDER BY id ASC");

    $fxRows = OpalDb::all($pdo, 'SELECT * FROM fx_positions ORDER BY currency ASC');
    $totFxAud = 0.0;
    $totFxGain = 0.0;
    foreach ($fxRows as &$fx) {
        $bal = (float) $fx['foreign_balance'];
        $bookedAud = round($bal * (float) $fx['booked_rate'], 2);
        $currentAud = round($bal * (float) $fx['current_rate'], 2);
        $gain = round($currentAud - $bookedAud, 2);
        $fx['booked_aud'] = $bookedAud;
        $fx['current_aud'] = $currentAud;
        $fx['unrealised_gain'] = $gain;
        $totFxAud += $currentAud;
        $totFxGain += $gain;
    }

    return [
        'basis' => ucfirst($basis),
        'pnl' => [
            'income' => $income,
            'cogs' => $cogs,
            'expenses' => $expenses,
            'totalIncome' => $totIncome,
            'totalCogs' => $totCogs,
            'grossProfit' => $grossProfit,
            'grossMarginPct' => $totIncome > 0 ? round(($grossProfit / $totIncome) * 100, 1) : 0.0,
            'totalExpenses' => $totExpenses,
            'netProfit' => $netProfit,
            'netMarginPct' => $totIncome > 0 ? round(($netProfit / $totIncome) * 100, 1) : 0.0,
            'priorNetProfit' => $priorNet,
        ],
        'balanceSheet' => [
            'assets' => $assets,
            'liabilities' => $liabilities,
            'equity' => $equity,
            'currentYearEarnings' => $currentEarnings,
            'totalAssets' => $totAssets,
            'totalLiabilities' => $totLiab,
            'totalEquity' => $totEquity,
            'balanced' => abs($totAssets - ($totLiab + $totEquity)) < 0.02,
        ],
        'trialBalance' => [
            'rows' => $tbRows,
            'totalDebit' => round($tbDr, 2),
            'totalCredit' => round($tbCr, 2),
            'balanced' => abs($tbDr - $tbCr) < 0.02,
        ],
        'cashFlow' => [
            'monthly' => $monthly,
            'operating' => $opCash,
            'investing' => $invCash,
            'financing' => $finCash,
            'netChange' => round($opCash + $invCash + $finCash, 2),
            'openingCash' => 161220.50,
            'closingCash' => round(161220.50 + $opCash + $invCash + $finCash, 2),
        ],
        'aged' => [
            'receivables' => $agedAr,
            'payables' => $agedAp,
        ],
        'fx' => [
            'positions' => $fxRows,
            'totalAudEquivalent' => round($totFxAud, 2),
            'totalUnrealisedGain' => round($totFxGain, 2),
        ],
        'savedPacks' => OpalDb::all($pdo, 'SELECT * FROM saved_packs ORDER BY id DESC'),
    ];
});

$router->patch('/api/fx/{currency}', function (PDO $pdo, array $params): array {
    $curr = strtoupper(trim((string) $params['currency']));
    $pos = OpalDb::one($pdo, 'SELECT * FROM fx_positions WHERE currency = ?', [$curr]);
    if (!$pos) {
        OpalHttp::error('Currency position not found.', 404);
    }
    $in = OpalHttp::body();
    $rate = OpalHttp::float($in, 'current_rate', 0.0);
    if ($rate <= 0.0) {
        OpalHttp::error('FX rate must be positive.', 422);
    }
    OpalDb::exec($pdo, 'UPDATE fx_positions SET current_rate = ?, updated_at = ? WHERE currency = ?', [round($rate, 4), OpalHttp::today(), $curr]);
    return ['position' => OpalDb::one($pdo, 'SELECT * FROM fx_positions WHERE currency = ?', [$curr])];
});

$router->post('/api/packs', function (PDO $pdo): array {
    $in = OpalHttp::body();
    $name = OpalHttp::str($in, 'pack_name', '', 140);
    if ($name === '') {
        OpalHttp::error('Report pack name is required.', 422);
    }
    $id = OpalDb::exec(
        $pdo,
        'INSERT INTO saved_packs (pack_name, basis, period_label, includes, created_at) VALUES (?, ?, ?, ?, ?)',
        [
            $name,
            OpalHttp::str($in, 'basis', 'Accrual', 20),
            OpalHttp::str($in, 'period_label', 'FY2026-27 YTD', 40),
            OpalHttp::str($in, 'includes', 'P&L, Balance Sheet, Cash Flow, Trial Balance', 240),
            OpalHttp::today(),
        ]
    );
    return ['__status' => 201, '__body' => ['pack' => OpalDb::one($pdo, 'SELECT * FROM saved_packs WHERE id = ?', [$id])]];
});

$router->dispatch();
