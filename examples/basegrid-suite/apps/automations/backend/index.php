<?php
declare(strict_types=1);

require_once __DIR__ . '/micro.php';

$router = new BaseGridRouter('basegrid.automations', 'BaseGrid Automations & Workflow Engine', __DIR__ . '/schema.sql');

function interpolateTemplate(string $tpl, array $rec): string
{
    $map = [
        '{title}' => (string) ($rec['title'] ?? ''),
        '{status}' => (string) ($rec['status'] ?? ''),
        '{priority}' => (string) ($rec['priority'] ?? ''),
        '{owner_name}' => (string) ($rec['owner_name'] ?? ''),
        '{amount}' => number_format((float) ($rec['amount'] ?? 0), 0),
    ];
    return str_replace(array_keys($map), array_values($map), $tpl);
}

function matchesTrigger(array $auto, array $rec): bool
{
    $cfg = json_decode((string) ($auto['trigger_config_json'] ?? '{}'), true);
    if (!is_array($cfg)) {
        return true;
    }
    $type = (string) ($auto['trigger_type'] ?? 'record_matches');
    if ($type !== 'record_matches') {
        return true;
    }
    $field = (string) ($cfg['field'] ?? 'status');
    $op = (string) ($cfg['op'] ?? 'equals');
    $expected = (string) ($cfg['value'] ?? '');
    $actual = $rec[$field] ?? '';

    if ($op === 'equals') {
        return strtolower((string) $actual) === strtolower($expected);
    }
    if ($op === 'not_equals') {
        return strtolower((string) $actual) !== strtolower($expected);
    }
    if ($op === 'gt') {
        return (float) $actual > (float) $expected;
    }
    if ($op === 'lt') {
        return (float) $actual < (float) $expected;
    }
    return stripos((string) $actual, $expected) !== false;
}

function executeAutomationOnRecord(PDO $pdo, array $auto, array $rec, bool $forceRun = false): array
{
    $started = microtime(true);
    $autoId = (int) $auto['id'];
    $recId = (int) $rec['id'];
    $now = BaseGridHttp::now();

    if (!$forceRun && !matchesTrigger($auto, $rec)) {
        return ['matched' => false];
    }

    $steps = BaseGridDb::all($pdo, 'SELECT * FROM automation_steps WHERE automation_id = ? ORDER BY position ASC, id ASC', [$autoId]);
    $trace = [];
    $currentRec = $rec;

    foreach ($steps as $st) {
        $sType = (string) $st['step_type'];
        $cfg = json_decode((string) ($st['config_json'] ?? '{}'), true);
        if (!is_array($cfg)) {
            $cfg = [];
        }

        if ($sType === 'update_record') {
            $nextStatus = isset($cfg['status']) && $cfg['status'] !== '' ? (string) $cfg['status'] : (string) $currentRec['status'];
            $nextPriority = isset($cfg['priority']) && $cfg['priority'] !== '' ? (string) $cfg['priority'] : (string) $currentRec['priority'];
            $nextEsc = isset($cfg['escalated']) ? (int) $cfg['escalated'] : (int) $currentRec['escalated'];
            BaseGridDb::exec(
                $pdo,
                'UPDATE workflow_records SET status = ?, priority = ?, escalated = ?, updated_at = ? WHERE id = ?',
                [$nextStatus, $nextPriority, $nextEsc, BaseGridHttp::today(), $recId]
            );
            $currentRec = BaseGridDb::one($pdo, 'SELECT * FROM workflow_records WHERE id = ?', [$recId]) ?: $currentRec;
            $trace[] = [
                'step' => (string) $st['label'],
                'type' => $sType,
                'outcome' => "Updated record #{$recId} (priority={$nextPriority}, status={$nextStatus}, escalated={$nextEsc})",
            ];
        } elseif ($sType === 'ai_enrich') {
            $tpl = (string) ($cfg['template'] ?? 'AI summary generated for {title}');
            $note = interpolateTemplate($tpl, $currentRec);
            BaseGridDb::exec(
                $pdo,
                'UPDATE workflow_records SET ai_note = ?, updated_at = ? WHERE id = ?',
                [$note, BaseGridHttp::today(), $recId]
            );
            $currentRec = BaseGridDb::one($pdo, 'SELECT * FROM workflow_records WHERE id = ?', [$recId]) ?: $currentRec;
            $trace[] = [
                'step' => (string) $st['label'],
                'type' => $sType,
                'outcome' => 'AI Note written: ' . $note,
            ];
        } elseif ($sType === 'send_slack' || $sType === 'send_email' || $sType === 'send_webhook') {
            $channel = $sType === 'send_slack' ? 'Slack' : ($sType === 'send_email' ? 'Email' : 'Webhook');
            $recipient = (string) ($cfg['recipient'] ?? '#general');
            $subject = interpolateTemplate((string) ($cfg['subject'] ?? 'BaseGrid Automation: {title}'), $currentRec);
            $body = interpolateTemplate((string) ($cfg['body'] ?? 'Triggered on {title}'), $currentRec);
            BaseGridDb::exec(
                $pdo,
                'INSERT INTO notification_outbox (channel, recipient, subject, body, automation_name, created_at) VALUES (?, ?, ?, ?, ?, ?)',
                [$channel, $recipient, $subject, $body, (string) $auto['name'], $now]
            );
            $trace[] = [
                'step' => (string) $st['label'],
                'type' => $sType,
                'outcome' => "{$channel} delivered to {$recipient}: {$subject}",
            ];
        }
    }

    $durationMs = max(3, (int) round((microtime(true) - $started) * 1000));
    BaseGridDb::exec(
        $pdo,
        'UPDATE automations SET run_count = run_count + 1, last_run_at = ? WHERE id = ?',
        [$now, $autoId]
    );
    $runId = BaseGridDb::exec(
        $pdo,
        'INSERT INTO automation_runs (automation_id, automation_name, record_id, record_title, status, duration_ms, trace_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [$autoId, (string) $auto['name'], $recId, (string) $currentRec['title'], 'Succeeded', $durationMs, json_encode($trace, JSON_UNESCAPED_SLASHES), $now]
    );
    return [
        'matched' => true,
        'run' => BaseGridDb::one($pdo, 'SELECT * FROM automation_runs WHERE id = ?', [$runId]),
        'record' => $currentRec,
    ];
}

$router->get('/api/state', function (PDO $pdo): array {
    $autos = BaseGridDb::all($pdo, 'SELECT * FROM automations ORDER BY id ASC');
    $steps = BaseGridDb::all($pdo, 'SELECT * FROM automation_steps ORDER BY position ASC, id ASC');
    $records = BaseGridDb::all($pdo, 'SELECT * FROM workflow_records ORDER BY id ASC');
    $runs = BaseGridDb::all($pdo, 'SELECT * FROM automation_runs ORDER BY id DESC LIMIT 40');
    $outbox = BaseGridDb::all($pdo, 'SELECT * FROM notification_outbox ORDER BY id DESC LIMIT 40');

    return [
        'automations' => array_map(fn($a) => [
            'id' => (int) $a['id'],
            'name' => (string) $a['name'],
            'description' => (string) $a['description'],
            'enabled' => (int) $a['enabled'] === 1,
            'trigger_type' => (string) $a['trigger_type'],
            'trigger_config' => json_decode((string) $a['trigger_config_json'], true) ?: [],
            'run_count' => (int) $a['run_count'],
            'last_run_at' => (string) $a['last_run_at'],
            'created_at' => (string) $a['created_at'],
        ], $autos),
        'steps' => array_map(fn($s) => [
            'id' => (int) $s['id'],
            'automation_id' => (int) $s['automation_id'],
            'step_type' => (string) $s['step_type'],
            'label' => (string) $s['label'],
            'config' => json_decode((string) $s['config_json'], true) ?: [],
            'position' => (int) $s['position'],
        ], $steps),
        'records' => array_map(fn($r) => [
            'id' => (int) $r['id'],
            'title' => (string) $r['title'],
            'status' => (string) $r['status'],
            'priority' => (string) $r['priority'],
            'owner_name' => (string) $r['owner_name'],
            'amount' => (float) $r['amount'],
            'escalated' => (int) $r['escalated'] === 1,
            'ai_note' => (string) $r['ai_note'],
            'updated_at' => (string) $r['updated_at'],
        ], $records),
        'runs' => array_map(fn($r) => [
            'id' => (int) $r['id'],
            'automation_id' => (int) $r['automation_id'],
            'automation_name' => (string) $r['automation_name'],
            'record_id' => $r['record_id'] !== null ? (int) $r['record_id'] : null,
            'record_title' => (string) $r['record_title'],
            'status' => (string) $r['status'],
            'duration_ms' => (int) $r['duration_ms'],
            'trace' => json_decode((string) $r['trace_json'], true) ?: [],
            'created_at' => (string) $r['created_at'],
        ], $runs),
        'outbox' => $outbox,
    ];
});

$router->post('/api/automations', function (PDO $pdo): array {
    $in = BaseGridHttp::body();
    $name = BaseGridHttp::str($in, 'name', '', 120);
    if ($name === '') {
        BaseGridHttp::error('Automation name is required.', 422);
    }
    $triggerCfg = isset($in['trigger_config']) && is_array($in['trigger_config'])
        ? $in['trigger_config']
        : ['field' => 'status', 'op' => 'equals', 'value' => 'At Risk'];
    $id = BaseGridDb::exec(
        $pdo,
        'INSERT INTO automations (name, description, enabled, trigger_type, trigger_config_json, run_count, last_run_at, created_at) VALUES (?, ?, 0, ?, ?, 0, ?, ?)',
        [
            $name,
            BaseGridHttp::str($in, 'description', 'Created paused for human review.', 300),
            BaseGridHttp::str($in, 'trigger_type', 'record_matches', 32),
            json_encode($triggerCfg, JSON_UNESCAPED_SLASHES),
            '',
            BaseGridHttp::today(),
        ]
    );
    BaseGridDb::exec(
        $pdo,
        'INSERT INTO automation_steps (automation_id, step_type, label, config_json, position) VALUES (?, ?, ?, ?, 0)',
        [$id, 'send_slack', 'Send Slack Notification', json_encode(['recipient' => '#ops', 'subject' => 'Triggered: {title}', 'body' => 'Automation fired on {title} ({status}).']), ]
    );
    return ['__status' => 201, '__body' => ['automation' => BaseGridDb::one($pdo, 'SELECT * FROM automations WHERE id = ?', [$id])]];
});

$router->patch('/api/automations/{id}', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $existing = BaseGridDb::one($pdo, 'SELECT * FROM automations WHERE id = ?', [$id]);
    if (!$existing) {
        BaseGridHttp::error('Automation not found.', 404);
    }
    $in = BaseGridHttp::body();
    $enabled = BaseGridHttp::boolInt($in, 'enabled', (int) $existing['enabled']);
    $triggerCfg = isset($in['trigger_config']) && is_array($in['trigger_config'])
        ? json_encode($in['trigger_config'], JSON_UNESCAPED_SLASHES)
        : (string) $existing['trigger_config_json'];

    BaseGridDb::exec(
        $pdo,
        'UPDATE automations SET enabled = ?, trigger_config_json = ? WHERE id = ?',
        [$enabled, $triggerCfg, $id]
    );
    return ['automation' => BaseGridDb::one($pdo, 'SELECT * FROM automations WHERE id = ?', [$id])];
});

$router->post('/api/automations/{id}/steps', function (PDO $pdo, array $params): array {
    $autoId = (int) $params['id'];
    $in = BaseGridHttp::body();
    $sType = BaseGridHttp::str($in, 'step_type', 'send_slack', 32);
    $label = BaseGridHttp::str($in, 'label', 'New Action Step', 120);
    $cfg = isset($in['config']) && is_array($in['config']) ? $in['config'] : [];
    $pos = (int) BaseGridDb::scalar($pdo, 'SELECT COUNT(*) FROM automation_steps WHERE automation_id = ?', [$autoId]);
    $id = BaseGridDb::exec(
        $pdo,
        'INSERT INTO automation_steps (automation_id, step_type, label, config_json, position) VALUES (?, ?, ?, ?, ?)',
        [$autoId, $sType, $label, json_encode($cfg, JSON_UNESCAPED_SLASHES), $pos]
    );
    return ['__status' => 201, '__body' => ['step' => BaseGridDb::one($pdo, 'SELECT * FROM automation_steps WHERE id = ?', [$id])]];
});

$router->delete('/api/steps/{id}', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    BaseGridDb::exec($pdo, 'DELETE FROM automation_steps WHERE id = ?', [$id]);
    return ['deleted' => $id];
});

// Run a specific automation immediately on a chosen record
$router->post('/api/automations/{id}/run', function (PDO $pdo, array $params): array {
    $autoId = (int) $params['id'];
    $auto = BaseGridDb::one($pdo, 'SELECT * FROM automations WHERE id = ?', [$autoId]);
    if (!$auto) {
        BaseGridHttp::error('Automation not found.', 404);
    }
    $in = BaseGridHttp::body();
    $recId = BaseGridHttp::int($in, 'record_id', 1);
    $rec = BaseGridDb::one($pdo, 'SELECT * FROM workflow_records WHERE id = ?', [$recId]);
    if (!$rec) {
        $rec = BaseGridDb::one($pdo, 'SELECT * FROM workflow_records ORDER BY id ASC LIMIT 1');
    }
    if (!$rec) {
        BaseGridHttp::error('No workflow records available to test.', 400);
    }
    $res = executeAutomationOnRecord($pdo, $auto, $rec, true);
    return ['ok' => true, 'run' => $res['run'], 'record' => $res['record']];
});

// Mutating a sandbox record automatically triggers all matching ENABLED automations!
$router->patch('/api/workflow-records/{id}', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $rec = BaseGridDb::one($pdo, 'SELECT * FROM workflow_records WHERE id = ?', [$id]);
    if (!$rec) {
        BaseGridHttp::error('Record not found.', 404);
    }
    $in = BaseGridHttp::body();
    BaseGridDb::exec(
        $pdo,
        'UPDATE workflow_records SET status = ?, priority = ?, amount = ?, updated_at = ? WHERE id = ?',
        [
            BaseGridHttp::str($in, 'status', (string) $rec['status'], 40),
            BaseGridHttp::str($in, 'priority', (string) $rec['priority'], 20),
            BaseGridHttp::float($in, 'amount', (float) $rec['amount']),
            BaseGridHttp::today(),
            $id,
        ]
    );
    $updated = BaseGridDb::one($pdo, 'SELECT * FROM workflow_records WHERE id = ?', [$id]);
    $enabledAutos = BaseGridDb::all($pdo, 'SELECT * FROM automations WHERE enabled = 1 ORDER BY id ASC');
    $fired = [];
    foreach ($enabledAutos as $auto) {
        $res = executeAutomationOnRecord($pdo, $auto, $updated, false);
        if (!empty($res['matched'])) {
            $fired[] = (string) $auto['name'];
            $updated = $res['record'];
        }
    }
    return ['record' => $updated, 'firedAutomations' => $fired];
});

$router->dispatch();
