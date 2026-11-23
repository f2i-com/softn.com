<?php
declare(strict_types=1);

require_once __DIR__ . '/micro.php';

$router = new ModulaRouter('modula.fieldservice', 'Modula Field Service & Planning', __DIR__ . '/schema.sql');

$router->get('/api/overview', function (PDO $pdo): array {
    $openWorkOrders = (int) ModulaDb::scalar($pdo, "SELECT COUNT(*) FROM work_orders WHERE stage != 'Completed'");
    $urgentCount = (int) ModulaDb::scalar($pdo, "SELECT COUNT(*) FROM work_orders WHERE stage != 'Completed' AND priority = 'Urgent'");
    $completedRevenue = (float) ModulaDb::scalar($pdo, "SELECT COALESCE(SUM(labor_total + parts_total), 0) FROM work_orders WHERE stage = 'Completed'");
    $upcomingAppointments = (int) ModulaDb::scalar($pdo, "SELECT COUNT(*) FROM appointments WHERE status IN ('Confirmed', 'Checked In')");
    $plannedHours = (float) ModulaDb::scalar($pdo, 'SELECT COALESCE(SUM(hours), 0) FROM shifts');
    $draftShifts = (int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM shifts WHERE published = 0');

    return [
        'openWorkOrders' => $openWorkOrders,
        'urgentCount' => $urgentCount,
        'completedRevenue' => round($completedRevenue, 2),
        'upcomingAppointments' => $upcomingAppointments,
        'plannedHours' => round($plannedHours, 1),
        'draftShifts' => $draftShifts,
    ];
});

$router->get('/api/technicians', function (PDO $pdo): array {
    return ['technicians' => ModulaDb::all($pdo, 'SELECT * FROM technicians WHERE active = 1 ORDER BY name ASC')];
});

$router->get('/api/work-orders', function (PDO $pdo): array {
    $rows = ModulaDb::all($pdo, 'SELECT * FROM work_orders ORDER BY id DESC');
    foreach ($rows as &$r) {
        $r['parts'] = json_decode((string) ($r['parts_json'] ?? '[]'), true) ?: [];
    }
    return ['workOrders' => $rows];
});

$router->post('/api/work-orders', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $title = ModulaHttp::str($in, 'title', '', 200);
    $customer = ModulaHttp::str($in, 'customer_name', '', 160);
    $techId = ModulaHttp::int($in, 'technician_id', 1);
    if ($title === '' || $customer === '') {
        ModulaHttp::error('Work order title and customer are required', 400);
    }
    $tech = ModulaDb::one($pdo, 'SELECT * FROM technicians WHERE id = ?', [$techId]);
    $techName = $tech ? (string) $tech['name'] : 'Unassigned';
    $nextNum = (int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM work_orders') + 401;
    $woNumber = 'WO-2026-' . $nextNum;

    $id = ModulaDb::exec(
        $pdo,
        "INSERT INTO work_orders (wo_number, title, customer_name, site_address, technician_id, technician_name, priority, stage, scheduled_date, est_hours, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'Scheduled', ?, ?, ?, ?)",
        [
            $woNumber,
            $title,
            $customer,
            ModulaHttp::str($in, 'site_address', '', 220),
            $techId,
            $techName,
            ModulaHttp::str($in, 'priority', 'Normal', 20),
            ModulaHttp::str($in, 'scheduled_date', ModulaHttp::today(), 20),
            max(0.5, ModulaHttp::float($in, 'est_hours', 2.0)),
            ModulaHttp::str($in, 'notes', '', 1000),
            ModulaHttp::now(),
        ]
    );
    $row = ModulaDb::one($pdo, 'SELECT * FROM work_orders WHERE id = ?', [$id]);
    $row['parts'] = [];
    return ['__status' => 201, '__body' => ['workOrder' => $row]];
});

$router->patch('/api/work-orders/{id}/stage', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $wo = ModulaDb::one($pdo, 'SELECT * FROM work_orders WHERE id = ?', [$id]);
    if (!$wo) {
        ModulaHttp::error('Work order not found', 404);
    }
    $in = ModulaHttp::body();
    $stage = ModulaHttp::str($in, 'stage', '', 30);
    if (!in_array($stage, ['Scheduled', 'En Route', 'In Progress', 'Completed'], true)) {
        ModulaHttp::error('Invalid stage', 400);
    }
    ModulaDb::exec($pdo, 'UPDATE work_orders SET stage = ? WHERE id = ?', [$stage, $id]);
    $updated = ModulaDb::one($pdo, 'SELECT * FROM work_orders WHERE id = ?', [$id]);
    $updated['parts'] = json_decode((string) ($updated['parts_json'] ?? '[]'), true) ?: [];
    return ['workOrder' => $updated];
});

$router->post('/api/work-orders/{id}/complete', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $wo = ModulaDb::one($pdo, 'SELECT * FROM work_orders WHERE id = ?', [$id]);
    if (!$wo) {
        ModulaHttp::error('Work order not found', 404);
    }
    $in = ModulaHttp::body();
    $actualHours = max(0.25, ModulaHttp::float($in, 'actual_hours', (float) $wo['est_hours']));
    $signedBy = ModulaHttp::str($in, 'customer_signed_by', '', 140);
    if ($signedBy === '') {
        ModulaHttp::error('Customer sign-off name is required to complete job', 400);
    }
    $partName = ModulaHttp::str($in, 'part_name', '', 120);
    $partQty = max(0, ModulaHttp::int($in, 'part_qty', 0));
    $partPrice = max(0.0, ModulaHttp::float($in, 'part_price', 0.0));

    $parts = json_decode((string) ($wo['parts_json'] ?? '[]'), true) ?: [];
    if ($partName !== '' && $partQty > 0) {
        $parts[] = ['name' => $partName, 'qty' => $partQty, 'unitPrice' => $partPrice];
    }
    $partsTotal = 0.0;
    foreach ($parts as $p) {
        $partsTotal += ((float) ($p['qty'] ?? 0)) * ((float) ($p['unitPrice'] ?? 0));
    }

    $tech = ModulaDb::one($pdo, 'SELECT hourly_rate FROM technicians WHERE id = ?', [(int) $wo['technician_id']]);
    $rate = $tech ? (float) $tech['hourly_rate'] : 125.0;
    $laborTotal = round($actualHours * $rate, 2);
    $notes = ModulaHttp::str($in, 'notes', (string) $wo['notes'], 1000);

    ModulaDb::exec(
        $pdo,
        "UPDATE work_orders
         SET stage = 'Completed', actual_hours = ?, parts_json = ?, labor_total = ?, parts_total = ?, customer_signed_by = ?, notes = ?
         WHERE id = ?",
        [$actualHours, json_encode($parts), $laborTotal, round($partsTotal, 2), $signedBy, $notes, $id]
    );
    $updated = ModulaDb::one($pdo, 'SELECT * FROM work_orders WHERE id = ?', [$id]);
    $updated['parts'] = $parts;
    return ['workOrder' => $updated];
});

$router->get('/api/appointments', function (PDO $pdo): array {
    return ['appointments' => ModulaDb::all($pdo, 'SELECT * FROM appointments ORDER BY appt_date ASC, start_time ASC')];
});

$router->post('/api/appointments', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $service = ModulaHttp::str($in, 'service_type', '', 140);
    $customer = ModulaHttp::str($in, 'customer_name', '', 140);
    $techName = ModulaHttp::str($in, 'technician_name', 'Daniel Brooks', 120);
    $date = ModulaHttp::str($in, 'appt_date', ModulaHttp::today(), 20);
    $time = ModulaHttp::str($in, 'start_time', '10:00', 10);
    if ($service === '' || $customer === '') {
        ModulaHttp::error('Service type and customer name are required', 400);
    }

    $conflict = ModulaDb::one(
        $pdo,
        "SELECT id, ref_code FROM appointments WHERE technician_name = ? AND appt_date = ? AND start_time = ? AND status != 'Cancelled'",
        [$techName, $date, $time]
    );
    if ($conflict) {
        ModulaHttp::error($techName . ' already has appointment ' . $conflict['ref_code'] . ' at ' . $date . ' ' . $time, 409);
    }

    $nextNum = (int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM appointments') + 8801;
    $ref = 'APT-' . $nextNum;
    $id = ModulaDb::exec(
        $pdo,
        "INSERT INTO appointments (ref_code, service_type, customer_name, customer_email, customer_phone, technician_name, appt_date, start_time, duration_min, status, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Confirmed', ?)",
        [
            $ref,
            $service,
            $customer,
            ModulaHttp::str($in, 'customer_email', '', 140),
            ModulaHttp::str($in, 'customer_phone', '', 50),
            $techName,
            $date,
            $time,
            max(15, ModulaHttp::int($in, 'duration_min', 45)),
            ModulaHttp::str($in, 'notes', '', 400),
        ]
    );
    return ['__status' => 201, '__body' => ['appointment' => ModulaDb::one($pdo, 'SELECT * FROM appointments WHERE id = ?', [$id])]];
});

$router->patch('/api/appointments/{id}/status', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $in = ModulaHttp::body();
    $status = ModulaHttp::str($in, 'status', '', 30);
    if (!in_array($status, ['Confirmed', 'Checked In', 'Completed', 'Cancelled'], true)) {
        ModulaHttp::error('Invalid status', 400);
    }
    ModulaDb::exec($pdo, 'UPDATE appointments SET status = ? WHERE id = ?', [$status, $id]);
    return ['appointment' => ModulaDb::one($pdo, 'SELECT * FROM appointments WHERE id = ?', [$id])];
});

$router->get('/api/shifts', function (PDO $pdo): array {
    return ['shifts' => ModulaDb::all($pdo, 'SELECT * FROM shifts ORDER BY shift_date ASC, start_time ASC')];
});

$router->post('/api/shifts', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $techId = ModulaHttp::int($in, 'technician_id', 1);
    $tech = ModulaDb::one($pdo, 'SELECT * FROM technicians WHERE id = ?', [$techId]);
    if (!$tech) {
        ModulaHttp::error('Technician not found', 404);
    }
    $id = ModulaDb::exec(
        $pdo,
        'INSERT INTO shifts (technician_id, technician_name, shift_date, start_time, end_time, role_label, location, hours, published)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)',
        [
            $techId,
            $tech['name'],
            ModulaHttp::str($in, 'shift_date', ModulaHttp::today(), 20),
            ModulaHttp::str($in, 'start_time', '08:00', 10),
            ModulaHttp::str($in, 'end_time', '16:30', 10),
            ModulaHttp::str($in, 'role_label', 'Field Dispatch', 80),
            ModulaHttp::str($in, 'location', (string) $tech['territory'], 100),
            max(1.0, ModulaHttp::float($in, 'hours', 8.0)),
        ]
    );
    return ['__status' => 201, '__body' => ['shift' => ModulaDb::one($pdo, 'SELECT * FROM shifts WHERE id = ?', [$id])]];
});

$router->patch('/api/shifts/{id}/publish', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    ModulaDb::exec($pdo, 'UPDATE shifts SET published = 1 WHERE id = ?', [$id]);
    return ['shift' => ModulaDb::one($pdo, 'SELECT * FROM shifts WHERE id = ?', [$id])];
});

$router->post('/api/shifts/publish-all', function (PDO $pdo): array {
    ModulaDb::exec($pdo, 'UPDATE shifts SET published = 1 WHERE published = 0');
    return ['ok' => true, 'shifts' => ModulaDb::all($pdo, 'SELECT * FROM shifts ORDER BY shift_date ASC, start_time ASC')];
});

$router->dispatch();
