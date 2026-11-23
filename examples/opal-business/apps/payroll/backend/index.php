<?php
declare(strict_types=1);

require_once __DIR__ . '/opal_micro.php';

$router = new OpalRouter('opal.payroll', 'Opal Australian Payroll, STP Phase 2 & Super', __DIR__ . '/schema.sql');

$router->get('/api/overview', function (PDO $pdo): array {
    $empCount = (int) OpalDb::scalar($pdo, 'SELECT COUNT(*) FROM employees WHERE active = 1');
    $ytdGross = (float) OpalDb::scalar($pdo, 'SELECT COALESCE(SUM(ytd_gross), 0) FROM employees');
    $ytdPayg = (float) OpalDb::scalar($pdo, 'SELECT COALESCE(SUM(ytd_payg), 0) FROM employees');
    $ytdSuper = (float) OpalDb::scalar($pdo, 'SELECT COALESCE(SUM(ytd_super), 0) FROM employees');
    $unpaidSuper = (float) OpalDb::scalar($pdo, "SELECT COALESCE(SUM(total_super), 0) FROM pay_runs WHERE super_status = 'Unpaid'");
    $pendingStp = (int) OpalDb::scalar($pdo, "SELECT COUNT(*) FROM pay_runs WHERE stp_status != 'Accepted by ATO'");
    $pendingLeave = (int) OpalDb::scalar($pdo, "SELECT COUNT(*) FROM leave_requests WHERE status = 'Pending'");
    $pendingTs = (int) OpalDb::scalar($pdo, "SELECT COUNT(*) FROM timesheets WHERE status = 'Submitted'");

    return [
        'activeEmployees' => $empCount,
        'ytdGross' => round($ytdGross, 2),
        'ytdPayg' => round($ytdPayg, 2),
        'ytdSuper' => round($ytdSuper, 2),
        'unpaidSuper' => round($unpaidSuper, 2),
        'pendingStp' => $pendingStp,
        'pendingLeave' => $pendingLeave,
        'pendingTimesheets' => $pendingTs,
        'sgRatePercent' => 12.0,
    ];
});

$router->get('/api/employees', function (PDO $pdo): array {
    return ['employees' => OpalDb::all($pdo, 'SELECT * FROM employees ORDER BY id ASC')];
});

$router->post('/api/employees', function (PDO $pdo): array {
    $in = OpalHttp::body();
    $name = OpalHttp::str($in, 'full_name', '', 140);
    $role = OpalHttp::str($in, 'role_title', '', 120);
    $rate = OpalHttp::float($in, 'pay_rate', 0.0);
    if ($name === '' || $role === '' || $rate <= 0.0) {
        OpalHttp::error('Full name, role title, and positive pay rate are required.', 422);
    }
    $count = (int) OpalDb::scalar($pdo, 'SELECT COUNT(*) FROM employees');
    $code = 'EMP-' . str_pad((string) ($count + 1), 3, '0', STR_PAD_LEFT);
    $empType = OpalHttp::str($in, 'employment_type', 'Full-Time', 30);
    $id = OpalDb::exec(
        $pdo,
        'INSERT INTO employees
          (emp_code, full_name, role_title, employment_type, stp_income_type, pay_basis, pay_rate, pay_frequency, tax_free_threshold, has_help_debt, super_fund, super_usi, annual_leave_hrs, personal_leave_hrs, ytd_gross, ytd_payg, ytd_super, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 1)',
        [
            $code,
            $name,
            $role,
            $empType,
            OpalHttp::str($in, 'stp_income_type', 'SAW', 10),
            OpalHttp::str($in, 'pay_basis', 'Salary', 20),
            round($rate, 2),
            OpalHttp::str($in, 'pay_frequency', 'Fortnightly', 20),
            OpalHttp::bool($in, 'tax_free_threshold', true),
            OpalHttp::bool($in, 'has_help_debt', false),
            OpalHttp::str($in, 'super_fund', 'AustralianSuper', 100),
            OpalHttp::str($in, 'super_usi', 'STA0100AU', 30),
            $empType === 'Casual' ? 0.0 : 15.2,
            $empType === 'Casual' ? 0.0 : 7.6,
        ]
    );
    return ['__status' => 201, '__body' => ['employee' => OpalDb::one($pdo, 'SELECT * FROM employees WHERE id = ?', [$id])]];
});

$router->get('/api/pay-runs', function (PDO $pdo): array {
    $runs = OpalDb::all($pdo, 'SELECT * FROM pay_runs ORDER BY id DESC');
    foreach ($runs as &$r) {
        $r['payslips'] = OpalDb::all($pdo, 'SELECT * FROM payslips WHERE pay_run_id = ? ORDER BY employee_id ASC', [(int) $r['id']]);
    }
    return ['payRuns' => $runs];
});

$router->post('/api/pay-runs', function (PDO $pdo): array {
    $in = OpalHttp::body();
    $freq = OpalHttp::str($in, 'frequency', 'Fortnightly', 20);
    $periodStart = OpalHttp::str($in, 'period_start', '2026-11-16', 20);
    $periodEnd = OpalHttp::str($in, 'period_end', '2026-11-29', 20);
    $payDate = OpalHttp::str($in, 'payment_date', '2026-11-30', 20);
    $overrides = isset($in['hours']) && is_array($in['hours']) ? $in['hours'] : [];

    $employees = OpalDb::all($pdo, 'SELECT * FROM employees WHERE active = 1 ORDER BY id ASC');
    if (count($employees) === 0) {
        OpalHttp::error('No active employees found.', 422);
    }
    $count = (int) OpalDb::scalar($pdo, 'SELECT COUNT(*) FROM pay_runs');
    $runNum = 'PR-2026-' . str_pad((string) (9 + $count), 2, '0', STR_PAD_LEFT);
    $periodsPerYear = match (strtolower($freq)) {
        'weekly' => 52.0,
        'monthly' => 12.0,
        default => 26.0,
    };

    $totGross = 0.0;
    $totPayg = 0.0;
    $totSuper = 0.0;
    $totNet = 0.0;

    $pdo->beginTransaction();
    try {
        $runId = OpalDb::exec(
            $pdo,
            'INSERT INTO pay_runs
              (run_number, frequency, period_start, period_end, payment_date, employee_count, total_gross, total_payg, total_super, total_net, stp_status, stp_receipt, super_status, super_ref)
             VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?, ?)',
            [$runNum, $freq, $periodStart, $periodEnd, $payDate, count($employees), 'Pending ATO', '', 'Unpaid', '']
        );

        foreach ($employees as $emp) {
            $eid = (int) $emp['id'];
            $ov = isset($overrides[(string) $eid]) && is_array($overrides[(string) $eid]) ? $overrides[(string) $eid] : [];
            $defaultHrs = $emp['employment_type'] === 'Part-Time' ? 60.0 : ($emp['employment_type'] === 'Casual' ? 38.0 : 76.0);
            $ordHrs = isset($ov['ordinary']) ? max(0.0, (float) $ov['ordinary']) : $defaultHrs;
            $otHrs = isset($ov['overtime']) ? max(0.0, (float) $ov['overtime']) : 0.0;
            $allow = isset($ov['allowances']) ? max(0.0, (float) $ov['allowances']) : 0.0;

            if ($emp['pay_basis'] === 'Salary') {
                $ordPay = round((float) $emp['pay_rate'] / $periodsPerYear, 2);
                $hourlyEquiv = ((float) $emp['pay_rate']) / 1976.0;
            } else {
                $hourlyEquiv = (float) $emp['pay_rate'];
                $ordPay = round($ordHrs * $hourlyEquiv, 2);
            }
            $otPay = round($otHrs * $hourlyEquiv * 1.5, 2);
            $gross = round($ordPay + $otPay + $allow, 2);
            $payg = OpalAu::calculatePayg($gross, $freq, ((int) $emp['tax_free_threshold']) === 1, ((int) $emp['has_help_debt']) === 1);
            // Australian Super Guarantee (12%) applies to Ordinary Time Earnings (OTE)
            $super = round($ordPay * OpalAu::SUPER_GUARANTEE_RATE, 2);
            $net = round($gross - $payg, 2);

            // NES leave accrual for Full-Time / Part-Time
            $annAccrual = $emp['employment_type'] === 'Casual' ? 0.0 : round(($ordHrs / 76.0) * 5.846, 2);
            $persAccrual = $emp['employment_type'] === 'Casual' ? 0.0 : round(($ordHrs / 76.0) * 2.923, 2);
            $newAnn = round((float) $emp['annual_leave_hrs'] + $annAccrual, 2);
            $newPers = round((float) $emp['personal_leave_hrs'] + $persAccrual, 2);

            OpalDb::exec(
                $pdo,
                'UPDATE employees
                 SET ytd_gross = ROUND(ytd_gross + ?, 2),
                     ytd_payg = ROUND(ytd_payg + ?, 2),
                     ytd_super = ROUND(ytd_super + ?, 2),
                     annual_leave_hrs = ?,
                     personal_leave_hrs = ?
                 WHERE id = ?',
                [$gross, $payg, $super, $newAnn, $newPers, $eid]
            );

            OpalDb::exec(
                $pdo,
                'INSERT INTO payslips
                  (pay_run_id, run_number, employee_id, employee_name, role_title, super_fund, super_usi, ordinary_hours, overtime_hours, ordinary_pay, overtime_pay, allowances, gross_pay, payg_tax, super_amount, net_pay, annual_leave_bal, personal_leave_bal, payment_date)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [
                    $runId, $runNum, $eid, (string) $emp['full_name'], (string) $emp['role_title'],
                    (string) $emp['super_fund'], (string) $emp['super_usi'], $ordHrs, $otHrs,
                    $ordPay, $otPay, $allow, $gross, $payg, $super, $net, $newAnn, $newPers, $payDate,
                ]
            );

            $totGross += $gross;
            $totPayg += $payg;
            $totSuper += $super;
            $totNet += $net;
        }

        OpalDb::exec(
            $pdo,
            'UPDATE pay_runs SET total_gross = ?, total_payg = ?, total_super = ?, total_net = ? WHERE id = ?',
            [round($totGross, 2), round($totPayg, 2), round($totSuper, 2), round($totNet, 2), $runId]
        );
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    $created = OpalDb::one($pdo, 'SELECT * FROM pay_runs WHERE id = ?', [$runId]);
    if ($created) {
        $created['payslips'] = OpalDb::all($pdo, 'SELECT * FROM payslips WHERE pay_run_id = ?', [$runId]);
    }
    return ['__status' => 201, '__body' => ['payRun' => $created]];
});

$router->post('/api/pay-runs/{id}/lodge-stp', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $run = OpalDb::one($pdo, 'SELECT * FROM pay_runs WHERE id = ?', [$id]);
    if (!$run) {
        OpalHttp::error('Pay run not found.', 404);
    }
    $receipt = 'ATO-STP2-' . date('Ymd') . '-' . rand(1000, 9999);
    OpalDb::exec($pdo, "UPDATE pay_runs SET stp_status = 'Accepted by ATO', stp_receipt = ? WHERE id = ?", [$receipt, $id]);
    return ['payRun' => OpalDb::one($pdo, 'SELECT * FROM pay_runs WHERE id = ?', [$id])];
});

$router->post('/api/pay-runs/{id}/pay-super', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $run = OpalDb::one($pdo, 'SELECT * FROM pay_runs WHERE id = ?', [$id]);
    if (!$run) {
        OpalHttp::error('Pay run not found.', 404);
    }
    $ref = 'SBSCH-' . rand(100000, 999999);
    OpalDb::exec($pdo, "UPDATE pay_runs SET super_status = 'Paid', super_ref = ? WHERE id = ?", [$ref, $id]);
    return ['payRun' => OpalDb::one($pdo, 'SELECT * FROM pay_runs WHERE id = ?', [$id])];
});

$router->get('/api/timesheets', function (PDO $pdo): array {
    return ['timesheets' => OpalDb::all($pdo, 'SELECT * FROM timesheets ORDER BY id DESC')];
});

$router->post('/api/timesheets', function (PDO $pdo): array {
    $in = OpalHttp::body();
    $empId = OpalHttp::int($in, 'employee_id', 1);
    $emp = OpalDb::one($pdo, 'SELECT * FROM employees WHERE id = ?', [$empId]);
    if (!$emp) {
        OpalHttp::error('Employee not found.', 404);
    }
    $id = OpalDb::exec(
        $pdo,
        'INSERT INTO timesheets (employee_id, employee_name, week_ending, ordinary_hours, overtime_hours, job_code, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
            $empId,
            (string) $emp['full_name'],
            OpalHttp::str($in, 'week_ending', OpalHttp::today(), 20),
            max(0.0, OpalHttp::float($in, 'ordinary_hours', 38.0)),
            max(0.0, OpalHttp::float($in, 'overtime_hours', 0.0)),
            OpalHttp::str($in, 'job_code', 'INTERNAL', 40),
            'Submitted',
        ]
    );
    return ['__status' => 201, '__body' => ['timesheet' => OpalDb::one($pdo, 'SELECT * FROM timesheets WHERE id = ?', [$id])]];
});

$router->patch('/api/timesheets/{id}/approve', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    OpalDb::exec($pdo, "UPDATE timesheets SET status = 'Approved' WHERE id = ?", [$id]);
    return ['timesheet' => OpalDb::one($pdo, 'SELECT * FROM timesheets WHERE id = ?', [$id])];
});

$router->get('/api/leave', function (PDO $pdo): array {
    return ['leaveRequests' => OpalDb::all($pdo, 'SELECT * FROM leave_requests ORDER BY id DESC')];
});

$router->patch('/api/leave/{id}/decide', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $req = OpalDb::one($pdo, 'SELECT * FROM leave_requests WHERE id = ?', [$id]);
    if (!$req || $req['status'] !== 'Pending') {
        OpalHttp::error('Pending leave request not found.', 404);
    }
    $in = OpalHttp::body();
    $decision = OpalHttp::str($in, 'status', 'Approved', 20);
    if (!in_array($decision, ['Approved', 'Declined'], true)) {
        OpalHttp::error('Invalid leave decision.', 422);
    }

    $pdo->beginTransaction();
    try {
        OpalDb::exec($pdo, 'UPDATE leave_requests SET status = ? WHERE id = ?', [$decision, $id]);
        if ($decision === 'Approved') {
            $col = stripos((string) $req['leave_type'], 'Annual') !== false ? 'annual_leave_hrs' : 'personal_leave_hrs';
            OpalDb::exec($pdo, "UPDATE employees SET {$col} = MAX(0, ROUND({$col} - ?, 2)) WHERE id = ?", [(float) $req['hours'], (int) $req['employee_id']]);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    return ['leaveRequest' => OpalDb::one($pdo, 'SELECT * FROM leave_requests WHERE id = ?', [$id])];
});

$router->dispatch();
