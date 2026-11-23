<?php
declare(strict_types=1);

require_once __DIR__ . '/micro.php';

$router = new ModulaRouter('modula.projects', 'Modula Projects & Timesheets', __DIR__ . '/schema.sql');

const TASK_STAGES = ['Backlog', 'In Progress', 'Review', 'Done'];

$router->get('/api/overview', function (PDO $pdo): array {
    $projects = ModulaDb::all($pdo, 'SELECT * FROM projects');
    $activeProjects = 0;
    $rateByProject = [];
    $costByProject = [];
    foreach ($projects as $p) {
        if ($p['status'] === 'Active') {
            $activeProjects++;
        }
        $rateByProject[(int) $p['id']] = (float) $p['hourly_rate'];
        $costByProject[(int) $p['id']] = (float) $p['cost_rate'];
    }
    $openTasks = (int) ModulaDb::scalar($pdo, "SELECT COUNT(*) FROM tasks WHERE stage != 'Done'");
    $doneTasks = (int) ModulaDb::scalar($pdo, "SELECT COUNT(*) FROM tasks WHERE stage = 'Done'");
    $milestonesTotal = (int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM milestones');
    $milestonesReached = (int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM milestones WHERE reached = 1');

    $entries = ModulaDb::all($pdo, 'SELECT project_id, employee_name, hours, billable FROM timesheets');
    $totalHours = 0.0;
    $billableHours = 0.0;
    $billableRevenue = 0.0;
    $laborCost = 0.0;
    $byEmployee = [];

    foreach ($entries as $e) {
        $h = (float) $e['hours'];
        $pid = (int) $e['project_id'];
        $emp = (string) $e['employee_name'];
        $totalHours += $h;
        $laborCost += $h * ($costByProject[$pid] ?? 75.0);
        if (!isset($byEmployee[$emp])) {
            $byEmployee[$emp] = ['employee' => $emp, 'hours' => 0.0, 'billable' => 0.0];
        }
        $byEmployee[$emp]['hours'] = round($byEmployee[$emp]['hours'] + $h, 1);
        if ((int) $e['billable'] === 1) {
            $billableHours += $h;
            $billableRevenue += $h * ($rateByProject[$pid] ?? 165.0);
            $byEmployee[$emp]['billable'] = round($byEmployee[$emp]['billable'] + $h, 1);
        }
    }

    $grossMargin = $billableRevenue > 0 ? round((($billableRevenue - $laborCost) / $billableRevenue) * 100, 1) : 0.0;

    return [
        'activeProjects' => $activeProjects,
        'openTasks' => $openTasks,
        'doneTasks' => $doneTasks,
        'milestonesTotal' => $milestonesTotal,
        'milestonesReached' => $milestonesReached,
        'totalHours' => round($totalHours, 1),
        'billableHours' => round($billableHours, 1),
        'billableRevenue' => round($billableRevenue, 2),
        'laborCost' => round($laborCost, 2),
        'grossMargin' => $grossMargin,
        'byEmployee' => array_values($byEmployee),
    ];
});

$router->get('/api/projects', function (PDO $pdo): array {
    $projects = ModulaDb::all($pdo, 'SELECT * FROM projects ORDER BY id ASC');
    foreach ($projects as &$p) {
        $pid = (int) $p['id'];
        $logged = round((float) ModulaDb::scalar($pdo, 'SELECT COALESCE(SUM(hours), 0) FROM timesheets WHERE project_id = ?', [$pid]), 1);
        $billableH = round((float) ModulaDb::scalar($pdo, 'SELECT COALESCE(SUM(hours), 0) FROM timesheets WHERE project_id = ? AND billable = 1', [$pid]), 1);
        $p['logged_hours'] = $logged;
        $p['billed_revenue'] = round($billableH * (float) $p['hourly_rate'], 2);
        $p['labor_cost'] = round($logged * (float) $p['cost_rate'], 2);
        $p['task_total'] = (int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM tasks WHERE project_id = ?', [$pid]);
        $p['task_done'] = (int) ModulaDb::scalar($pdo, "SELECT COUNT(*) FROM tasks WHERE project_id = ? AND stage = 'Done'", [$pid]);
    }
    return ['projects' => $projects];
});

$router->post('/api/projects', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $name = ModulaHttp::str($in, 'name', '', 140);
    if ($name === '') {
        ModulaHttp::error('Project name is required.', 422);
    }
    $id = ModulaDb::exec(
        $pdo,
        'INSERT INTO projects (name, client_name, status, budget_hours, hourly_rate, cost_rate, due_date, lead_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
            $name,
            ModulaHttp::str($in, 'client_name', '', 120),
            'Active',
            max(1.0, ModulaHttp::float($in, 'budget_hours', 60.0)),
            max(0.0, ModulaHttp::float($in, 'hourly_rate', 165.0)),
            max(0.0, ModulaHttp::float($in, 'cost_rate', 75.0)),
            ModulaHttp::str($in, 'due_date', date('Y-m-d', time() + 86400 * 30), 20),
            ModulaHttp::str($in, 'lead_name', 'Alex Rivera', 80),
        ]
    );
    return ['__status' => 201, '__body' => ['project' => ModulaDb::one($pdo, 'SELECT * FROM projects WHERE id = ?', [$id])]];
});

// Milestones
$router->get('/api/milestones', function (PDO $pdo): array {
    $rows = ModulaDb::all(
        $pdo,
        'SELECT m.*, p.name AS project_name FROM milestones m LEFT JOIN projects p ON p.id = m.project_id ORDER BY m.reached ASC, m.target_date ASC'
    );
    return ['milestones' => $rows];
});

$router->post('/api/milestones', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $title = ModulaHttp::str($in, 'title', '', 160);
    $pid = ModulaHttp::int($in, 'project_id', 0);
    if ($title === '' || $pid <= 0) {
        ModulaHttp::error('Project and milestone title are required.', 422);
    }
    $id = ModulaDb::exec(
        $pdo,
        'INSERT INTO milestones (project_id, title, target_date, bill_amount, reached) VALUES (?, ?, ?, ?, 0)',
        [$pid, $title, ModulaHttp::str($in, 'target_date', date('Y-m-d', time() + 86400 * 14), 20), max(0.0, ModulaHttp::float($in, 'bill_amount', 0.0))]
    );
    return ['__status' => 201, '__body' => ['milestone' => ModulaDb::one($pdo, 'SELECT * FROM milestones WHERE id = ?', [$id])]];
});

$router->patch('/api/milestones/{id}/toggle', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $m = ModulaDb::one($pdo, 'SELECT * FROM milestones WHERE id = ?', [$id]);
    if (!$m) {
        ModulaHttp::error('Milestone not found.', 404);
    }
    $next = ((int) $m['reached']) === 1 ? 0 : 1;
    ModulaDb::exec($pdo, 'UPDATE milestones SET reached = ? WHERE id = ?', [$next, $id]);
    return ['milestone' => ModulaDb::one($pdo, 'SELECT * FROM milestones WHERE id = ?', [$id])];
});

// Tasks + Subtasks
$router->get('/api/tasks', function (PDO $pdo): array {
    $pid = ModulaHttp::query('project_id');
    $sql = 'SELECT t.*, p.name AS project_name FROM tasks t LEFT JOIN projects p ON p.id = t.project_id';
    $params = [];
    if ($pid !== '' && ctype_digit($pid)) {
        $sql .= ' WHERE t.project_id = ?';
        $params[] = (int) $pid;
    }
    $sql .= ' ORDER BY t.id DESC';
    $rows = ModulaDb::all($pdo, $sql, $params);
    foreach ($rows as &$r) {
        $r['subtasks'] = json_decode((string) ($r['subtasks_json'] ?? '[]'), true) ?: [];
    }
    return ['tasks' => $rows];
});

$router->post('/api/tasks', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $title = ModulaHttp::str($in, 'title', '', 160);
    $projectId = ModulaHttp::int($in, 'project_id', 0);
    if ($title === '' || $projectId <= 0) {
        ModulaHttp::error('Project and task title are required.', 422);
    }
    $stage = ModulaHttp::str($in, 'stage', 'Backlog', 30);
    if (!in_array($stage, TASK_STAGES, true)) {
        $stage = 'Backlog';
    }
    $id = ModulaDb::exec(
        $pdo,
        'INSERT INTO tasks (project_id, title, stage, priority, assignee, estimate_hours, logged_hours, due_date, subtasks_json)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)',
        [
            $projectId,
            $title,
            $stage,
            ModulaHttp::str($in, 'priority', 'Medium', 20),
            ModulaHttp::str($in, 'assignee', 'Alex Rivera', 80),
            max(0.5, ModulaHttp::float($in, 'estimate_hours', 4.0)),
            ModulaHttp::str($in, 'due_date', date('Y-m-d', time() + 86400 * 7), 20),
            '[]',
        ]
    );
    $task = ModulaDb::one($pdo, 'SELECT * FROM tasks WHERE id = ?', [$id]);
    if ($task) {
        $task['subtasks'] = [];
    }
    return ['__status' => 201, '__body' => ['task' => $task]];
});

$router->patch('/api/tasks/{id}/stage', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $in = ModulaHttp::body();
    $stage = ModulaHttp::str($in, 'stage', '', 30);
    if (!in_array($stage, TASK_STAGES, true)) {
        ModulaHttp::error('Invalid stage.', 422);
    }
    ModulaDb::exec($pdo, 'UPDATE tasks SET stage = ? WHERE id = ?', [$stage, $id]);
    return ['task' => ModulaDb::one($pdo, 'SELECT * FROM tasks WHERE id = ?', [$id])];
});

$router->patch('/api/tasks/{id}/subtasks', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $in = ModulaHttp::body();
    $subs = isset($in['subtasks']) && is_array($in['subtasks']) ? $in['subtasks'] : [];
    $clean = [];
    foreach ($subs as $s) {
        if (!is_array($s)) {
            continue;
        }
        $txt = trim((string) ($s['text'] ?? ''));
        if ($txt !== '') {
            $clean[] = ['text' => $txt, 'done' => !empty($s['done'])];
        }
    }
    ModulaDb::exec($pdo, 'UPDATE tasks SET subtasks_json = ? WHERE id = ?', [json_encode($clean, JSON_UNESCAPED_SLASHES), $id]);
    $task = ModulaDb::one($pdo, 'SELECT * FROM tasks WHERE id = ?', [$id]);
    if ($task) {
        $task['subtasks'] = $clean;
    }
    return ['task' => $task];
});

$router->get('/api/timesheets', function (PDO $pdo): array {
    $rows = ModulaDb::all(
        $pdo,
        'SELECT ts.*, p.name AS project_name, p.hourly_rate, t.title AS task_title
         FROM timesheets ts
         LEFT JOIN projects p ON p.id = ts.project_id
         LEFT JOIN tasks t ON t.id = ts.task_id
         ORDER BY ts.id DESC LIMIT 100'
    );
    return ['timesheets' => $rows];
});

$router->post('/api/timesheets', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $taskId = ModulaHttp::int($in, 'task_id', 0);
    $hours = round(max(0.25, ModulaHttp::float($in, 'hours', 0.0)), 2);
    $task = ModulaDb::one($pdo, 'SELECT * FROM tasks WHERE id = ?', [$taskId]);
    if (!$task) {
        ModulaHttp::error('Select a valid task.', 422);
    }
    $billable = !isset($in['billable']) || (bool) $in['billable'] ? 1 : 0;

    $pdo->beginTransaction();
    try {
        $id = ModulaDb::exec(
            $pdo,
            'INSERT INTO timesheets (project_id, task_id, employee_name, work_date, hours, billable, note)
             VALUES (?, ?, ?, ?, ?, ?, ?)',
            [
                (int) $task['project_id'],
                $taskId,
                ModulaHttp::str($in, 'employee_name', (string) $task['assignee'], 80),
                ModulaHttp::str($in, 'work_date', ModulaHttp::today(), 20),
                $hours,
                $billable,
                ModulaHttp::str($in, 'note', '', 400),
            ]
        );
        ModulaDb::exec($pdo, 'UPDATE tasks SET logged_hours = ROUND(logged_hours + ?, 2) WHERE id = ?', [$hours, $taskId]);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    return ['__status' => 201, '__body' => ['entry' => ModulaDb::one($pdo, 'SELECT * FROM timesheets WHERE id = ?', [$id])]];
});

$router->dispatch();
