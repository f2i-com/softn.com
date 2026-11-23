<?php
declare(strict_types=1);

require_once __DIR__ . '/micro.php';

$router = new ModulaRouter('modula.hr', 'Modula HR, Attendance & Payroll', __DIR__ . '/schema.sql');

const ATS_STAGES = ['Applied', 'Screening', 'Interview', 'Offer', 'Hired'];

$router->get('/api/overview', function (PDO $pdo): array {
    $headcount = (int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM employees');
    $active = (int) ModulaDb::scalar($pdo, "SELECT COUNT(*) FROM employees WHERE status = 'Active'");
    $checkedIn = (int) ModulaDb::scalar($pdo, "SELECT COUNT(*) FROM attendances WHERE status = 'Checked In'");
    $pendingLeaves = (int) ModulaDb::scalar($pdo, "SELECT COUNT(*) FROM leave_requests WHERE status = 'Pending'");
    $openCandidates = (int) ModulaDb::scalar($pdo, "SELECT COUNT(*) FROM candidates WHERE stage != 'Hired'");
    $monthlyPayroll = (float) ModulaDb::scalar($pdo, "SELECT COALESCE(SUM(base_salary / 12.0), 0) FROM employees WHERE status != 'Terminated'");
    $openAppraisals = (int) ModulaDb::scalar($pdo, "SELECT COUNT(*) FROM appraisals WHERE status != 'Completed'");

    return [
        'headcount' => $headcount,
        'activeCount' => $active,
        'onLeaveCount' => $headcount - $active,
        'checkedInCount' => $checkedIn,
        'pendingLeaves' => $pendingLeaves,
        'openCandidates' => $openCandidates,
        'monthlyPayroll' => round($monthlyPayroll, 2),
        'openAppraisals' => $openAppraisals,
    ];
});

// Employees
$router->get('/api/employees', function (PDO $pdo): array {
    $rows = ModulaDb::all($pdo, 'SELECT * FROM employees ORDER BY id ASC');
    $openAtt = ModulaDb::all($pdo, "SELECT employee_id, id, check_in FROM attendances WHERE status = 'Checked In'");
    $clocked = [];
    foreach ($openAtt as $a) {
        $clocked[(int) $a['employee_id']] = ['attendance_id' => (int) $a['id'], 'check_in' => $a['check_in']];
    }
    foreach ($rows as &$r) {
        $eid = (int) $r['id'];
        $r['checked_in'] = isset($clocked[$eid]);
        $r['check_in_time'] = $clocked[$eid]['check_in'] ?? '';
    }
    return ['employees' => $rows];
});

$router->post('/api/employees', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $name = ModulaHttp::str($in, 'name', '', 120);
    $role = ModulaHttp::str($in, 'role_title', '', 120);
    if ($name === '' || $role === '') {
        ModulaHttp::error('Employee name and role are required.', 422);
    }
    $id = ModulaDb::exec(
        $pdo,
        'INSERT INTO employees (name, role_title, department, email, location, manager_name, employment_type, base_salary, status, leave_balance, start_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
            $name,
            $role,
            ModulaHttp::str($in, 'department', 'Engineering', 60),
            ModulaHttp::str($in, 'email', '', 140),
            ModulaHttp::str($in, 'location', 'Sydney', 60),
            ModulaHttp::str($in, 'manager_name', 'Executive', 80),
            ModulaHttp::str($in, 'employment_type', 'Full-Time', 30),
            max(0.0, ModulaHttp::float($in, 'base_salary', 105000.0)),
            'Active',
            max(0.0, ModulaHttp::float($in, 'leave_balance', 20.0)),
            ModulaHttp::str($in, 'start_date', ModulaHttp::today(), 20),
        ]
    );
    return ['__status' => 201, '__body' => ['employee' => ModulaDb::one($pdo, 'SELECT * FROM employees WHERE id = ?', [$id])]];
});

$router->put('/api/employees/{id}', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $emp = ModulaDb::one($pdo, 'SELECT * FROM employees WHERE id = ?', [$id]);
    if (!$emp) {
        ModulaHttp::error('Employee not found.', 404);
    }
    $in = ModulaHttp::body();
    ModulaDb::exec(
        $pdo,
        'UPDATE employees SET role_title = ?, department = ?, location = ?, base_salary = ?, status = ?, leave_balance = ? WHERE id = ?',
        [
            ModulaHttp::str($in, 'role_title', (string) $emp['role_title'], 120),
            ModulaHttp::str($in, 'department', (string) $emp['department'], 60),
            ModulaHttp::str($in, 'location', (string) $emp['location'], 60),
            max(0.0, ModulaHttp::float($in, 'base_salary', (float) $emp['base_salary'])),
            ModulaHttp::str($in, 'status', (string) $emp['status'], 30),
            max(0.0, ModulaHttp::float($in, 'leave_balance', (float) $emp['leave_balance'])),
            $id,
        ]
    );
    return ['employee' => ModulaDb::one($pdo, 'SELECT * FROM employees WHERE id = ?', [$id])];
});

// Attendances (Check-In / Check-Out Kiosk)
$router->get('/api/attendances', function (PDO $pdo): array {
    return ['attendances' => ModulaDb::all($pdo, 'SELECT * FROM attendances ORDER BY id DESC LIMIT 60')];
});

$router->post('/api/attendances/toggle', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $empId = ModulaHttp::int($in, 'employee_id', 0);
    $emp = ModulaDb::one($pdo, 'SELECT * FROM employees WHERE id = ?', [$empId]);
    if (!$emp) {
        ModulaHttp::error('Employee not found.', 404);
    }
    $open = ModulaDb::one($pdo, "SELECT * FROM attendances WHERE employee_id = ? AND status = 'Checked In' ORDER BY id DESC LIMIT 1", [$empId]);
    $timeNow = date('H:i');

    if ($open) {
        $inTs = strtotime('2026-11-21 ' . $open['check_in']) ?: time();
        $outTs = strtotime('2026-11-21 ' . $timeNow) ?: time();
        $diff = max(0.5, round(abs($outTs - $inTs) / 3600.0, 1));
        ModulaDb::exec(
            $pdo,
            "UPDATE attendances SET check_out = ?, worked_hours = ?, status = 'Completed' WHERE id = ?",
            [$timeNow, $diff, (int) $open['id']]
        );
        return ['action' => 'checked_out', 'attendance' => ModulaDb::one($pdo, 'SELECT * FROM attendances WHERE id = ?', [(int) $open['id']])];
    }

    $id = ModulaDb::exec(
        $pdo,
        "INSERT INTO attendances (employee_id, employee_name, work_date, check_in, check_out, worked_hours, status) VALUES (?, ?, ?, ?, '', 0, 'Checked In')",
        [$empId, (string) $emp['name'], ModulaHttp::today(), $timeNow]
    );
    return ['__status' => 201, '__body' => ['action' => 'checked_in', 'attendance' => ModulaDb::one($pdo, 'SELECT * FROM attendances WHERE id = ?', [$id])]];
});

// Leaves
$router->get('/api/leaves', function (PDO $pdo): array {
    return ['leaves' => ModulaDb::all($pdo, 'SELECT * FROM leave_requests ORDER BY id DESC')];
});

$router->post('/api/leaves', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $empId = ModulaHttp::int($in, 'employee_id', 0);
    $emp = ModulaDb::one($pdo, 'SELECT * FROM employees WHERE id = ?', [$empId]);
    if (!$emp) {
        ModulaHttp::error('Select a valid employee.', 422);
    }
    $days = round(max(0.5, ModulaHttp::float($in, 'days', 1.0)), 1);
    $id = ModulaDb::exec(
        $pdo,
        'INSERT INTO leave_requests (employee_id, employee_name, leave_type, start_date, end_date, days, reason, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
            $empId,
            (string) $emp['name'],
            ModulaHttp::str($in, 'leave_type', 'Annual Leave', 50),
            ModulaHttp::str($in, 'start_date', ModulaHttp::today(), 20),
            ModulaHttp::str($in, 'end_date', ModulaHttp::today(), 20),
            $days,
            ModulaHttp::str($in, 'reason', '', 300),
            'Pending',
        ]
    );
    return ['__status' => 201, '__body' => ['leave' => ModulaDb::one($pdo, 'SELECT * FROM leave_requests WHERE id = ?', [$id])]];
});

$router->patch('/api/leaves/{id}/decision', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $in = ModulaHttp::body();
    $status = ModulaHttp::str($in, 'status', '', 20);
    if ($status !== 'Approved' && $status !== 'Rejected') {
        ModulaHttp::error('Status must be Approved or Rejected.', 422);
    }
    $req = ModulaDb::one($pdo, 'SELECT * FROM leave_requests WHERE id = ?', [$id]);
    if (!$req) {
        ModulaHttp::error('Leave request not found.', 404);
    }

    $pdo->beginTransaction();
    try {
        ModulaDb::exec($pdo, 'UPDATE leave_requests SET status = ? WHERE id = ?', [$status, $id]);
        if ($status === 'Approved' && $req['status'] !== 'Approved') {
            ModulaDb::exec(
                $pdo,
                'UPDATE employees SET leave_balance = MAX(0, ROUND(leave_balance - ?, 1)) WHERE id = ?',
                [(float) $req['days'], (int) $req['employee_id']]
            );
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    return ['leave' => ModulaDb::one($pdo, 'SELECT * FROM leave_requests WHERE id = ?', [$id])];
});

// Recruitment ATS
$router->get('/api/candidates', function (PDO $pdo): array {
    return ['candidates' => ModulaDb::all($pdo, 'SELECT * FROM candidates ORDER BY rating DESC, id DESC')];
});

$router->post('/api/candidates', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $name = ModulaHttp::str($in, 'name', '', 120);
    $role = ModulaHttp::str($in, 'role_applied', '', 120);
    if ($name === '' || $role === '') {
        ModulaHttp::error('Candidate name and role are required.', 422);
    }
    $id = ModulaDb::exec(
        $pdo,
        'INSERT INTO candidates (name, role_applied, department, email, stage, rating, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
            $name,
            $role,
            ModulaHttp::str($in, 'department', 'Engineering', 60),
            ModulaHttp::str($in, 'email', '', 140),
            'Applied',
            max(1, min(5, ModulaHttp::int($in, 'rating', 3))),
            ModulaHttp::str($in, 'notes', '', 400),
        ]
    );
    return ['__status' => 201, '__body' => ['candidate' => ModulaDb::one($pdo, 'SELECT * FROM candidates WHERE id = ?', [$id])]];
});

$router->patch('/api/candidates/{id}/stage', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $in = ModulaHttp::body();
    $stage = ModulaHttp::str($in, 'stage', '', 30);
    if (!in_array($stage, ATS_STAGES, true)) {
        ModulaHttp::error('Invalid recruitment stage.', 422);
    }
    $cand = ModulaDb::one($pdo, 'SELECT * FROM candidates WHERE id = ?', [$id]);
    if (!$cand) {
        ModulaHttp::error('Candidate not found.', 404);
    }

    $hiredEmployee = null;
    $pdo->beginTransaction();
    try {
        ModulaDb::exec($pdo, 'UPDATE candidates SET stage = ? WHERE id = ?', [$stage, $id]);
        if ($stage === 'Hired' && $cand['stage'] !== 'Hired') {
            $empId = ModulaDb::exec(
                $pdo,
                'INSERT INTO employees (name, role_title, department, email, location, manager_name, employment_type, base_salary, status, leave_balance, start_date)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 115000, ?, 20, ?)',
                [(string) $cand['name'], (string) $cand['role_applied'], (string) $cand['department'], (string) $cand['email'], 'Sydney', 'Department Lead', 'Full-Time', 'Active', ModulaHttp::today()]
            );
            $hiredEmployee = ModulaDb::one($pdo, 'SELECT * FROM employees WHERE id = ?', [$empId]);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    return ['candidate' => ModulaDb::one($pdo, 'SELECT * FROM candidates WHERE id = ?', [$id]), 'hiredEmployee' => $hiredEmployee];
});

// Performance Appraisals
$router->get('/api/appraisals', function (PDO $pdo): array {
    return ['appraisals' => ModulaDb::all($pdo, 'SELECT * FROM appraisals ORDER BY id DESC')];
});

$router->post('/api/appraisals', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $empId = ModulaHttp::int($in, 'employee_id', 0);
    $emp = ModulaDb::one($pdo, 'SELECT * FROM employees WHERE id = ?', [$empId]);
    if (!$emp) {
        ModulaHttp::error('Select a valid employee.', 422);
    }
    $id = ModulaDb::exec(
        $pdo,
        'INSERT INTO appraisals (employee_id, employee_name, cycle, goals, self_rating, manager_rating, status, review_date)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
        [
            $empId,
            (string) $emp['name'],
            ModulaHttp::str($in, 'cycle', '2026 Q4', 30),
            ModulaHttp::str($in, 'goals', 'Quarterly objectives & OKRs', 500),
            max(1, min(5, ModulaHttp::int($in, 'self_rating', 4))),
            'Scheduled',
            ModulaHttp::str($in, 'review_date', date('Y-m-d', time() + 86400 * 14), 20),
        ]
    );
    return ['__status' => 201, '__body' => ['appraisal' => ModulaDb::one($pdo, 'SELECT * FROM appraisals WHERE id = ?', [$id])]];
});

$router->patch('/api/appraisals/{id}', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $ap = ModulaDb::one($pdo, 'SELECT * FROM appraisals WHERE id = ?', [$id]);
    if (!$ap) {
        ModulaHttp::error('Appraisal not found.', 404);
    }
    $in = ModulaHttp::body();
    $status = ModulaHttp::str($in, 'status', (string) $ap['status'], 30);
    $mgrRating = isset($in['manager_rating']) ? max(0, min(5, (int) $in['manager_rating'])) : (int) $ap['manager_rating'];
    ModulaDb::exec($pdo, 'UPDATE appraisals SET status = ?, manager_rating = ? WHERE id = ?', [$status, $mgrRating, $id]);
    return ['appraisal' => ModulaDb::one($pdo, 'SELECT * FROM appraisals WHERE id = ?', [$id])];
});

// Payroll Runs & Payslips
$router->get('/api/payslips', function (PDO $pdo): array {
    return ['payslips' => ModulaDb::all($pdo, 'SELECT * FROM payslips ORDER BY id DESC')];
});

$router->post('/api/payroll/run', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $period = ModulaHttp::str($in, 'pay_period', date('Y-m'), 20);
    $emps = ModulaDb::all($pdo, "SELECT * FROM employees WHERE status != 'Terminated'");
    $created = 0;

    $pdo->beginTransaction();
    try {
        foreach ($emps as $e) {
            $slipNo = 'PAY-' . $period . '-' . str_pad((string) $e['id'], 3, '0', STR_PAD_LEFT);
            $exists = ModulaDb::one($pdo, 'SELECT id FROM payslips WHERE slip_number = ?', [$slipNo]);
            if ($exists) {
                continue;
            }
            $gross = round(((float) $e['base_salary']) / 12.0, 2);
            $tax = round($gross * 0.22, 2);
            $super = round($gross * 0.115, 2);
            $net = round($gross - $tax, 2);
            ModulaDb::exec(
                $pdo,
                'INSERT INTO payslips (slip_number, employee_id, employee_name, pay_period, gross_pay, tax_withheld, super_contrib, net_pay, status, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [$slipNo, (int) $e['id'], (string) $e['name'], $period, $gross, $tax, $super, $net, 'Draft', ModulaHttp::today()]
            );
            $created++;
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    return ['__status' => 201, '__body' => ['created' => $created, 'pay_period' => $period]];
});

$router->patch('/api/payslips/{id}/pay', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    ModulaDb::exec($pdo, "UPDATE payslips SET status = 'Paid' WHERE id = ?", [$id]);
    return ['payslip' => ModulaDb::one($pdo, 'SELECT * FROM payslips WHERE id = ?', [$id])];
});

$router->dispatch();
