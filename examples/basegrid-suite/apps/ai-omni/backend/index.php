<?php
declare(strict_types=1);

require_once __DIR__ . '/micro.php';

$router = new BaseGridRouter('basegrid.ai-omni', 'BaseGrid Omni AI Builder & Field Agents', __DIR__ . '/schema.sql');

function analyzeRowWithLocalAgents(array $row): array
{
    $company = (string) $row['company'];
    $text = strtolower((string) $row['source_text']);
    $arr = (float) $row['arr_value'];

    $risk = 'Low Risk';
    if (strpos($text, 'block') !== false || strpos($text, 'urgent') !== false || strpos($text, 'churn') !== false || strpos($text, 'legal') !== false || strpos($text, 'delay') !== false) {
        $risk = 'High Risk';
    } elseif (strpos($text, 'pending') !== false || strpos($text, 'complex') !== false || strpos($text, 'sync') !== false || strpos($text, 'legacy') !== false) {
        $risk = 'Medium';
    }

    $category = 'Operations';
    if (strpos($text, 'scim') !== false || strpos($text, 'security') !== false || strpos($text, 'hipaa') !== false || strpos($text, 'audit') !== false) {
        $category = 'Security';
    } elseif (strpos($text, 'portal') !== false || strpos($text, 'client') !== false || strpos($text, 'gallery') !== false) {
        $category = 'Portals';
    } elseif (strpos($text, 'airtable') !== false || strpos($text, 'migrat') !== false || strpos($text, 'seat') !== false || strpos($text, 'spreadsheet') !== false) {
        $category = 'Migration';
    } elseif (strpos($text, 'sync') !== false || strpos($text, 'dashboard') !== false || strpos($text, 'snowflake') !== false) {
        $category = 'Analytics';
    }

    $arrStr = '$' . number_format($arr, 0);
    $summary = sprintf(
        '%s (%s ARR) focuses on %s workflows; %s signal detected from field notes.',
        $company,
        $arrStr,
        strtolower($category),
        strtolower($risk)
    );

    $action = match ($category) {
        'Security' => "Share SCIM + immutable XDB audit pack with {$company} security reviewers.",
        'Portals' => "Provision white-label guest portal preview for {$company} stakeholders.",
        'Migration' => "Prepare zero-seat-fee SoftN migration plan & offline form demo for {$company}.",
        'Analytics' => "Configure executive KPI interface & two-way warehouse sync pilot for {$company}.",
        default => "Schedule 20-min workflow scoping call with {$company} lead.",
    };

    $confidence = 91 + (abs(crc32($company)) % 8);
    return [
        'ai_summary' => $summary,
        'ai_risk' => $risk,
        'ai_category' => $category,
        'ai_next_action' => $action,
        'confidence' => $confidence,
    ];
}

function synthesizeBlueprintFromPrompt(string $prompt): array
{
    $low = strtolower($prompt);
    if (strpos($low, 'event') !== false || strpos($low, 'conference') !== false || strpos($low, 'speaker') !== false) {
        return [
            'name' => 'Event & Speaker Operations Hub',
            'domain' => 'Events & Marketing',
            'tables' => [
                ['name' => 'Sessions & Agenda', 'fields' => ['Session Title', 'Track', 'Stage', 'Start Time', 'Speaker (Link)', 'AI Abstract']],
                ['name' => 'Speakers & VIPs', 'fields' => ['Full Name', 'Company', 'Bio', 'Travel Confirmed', 'AI Intro Script']],
                ['name' => 'Sponsors & Booths', 'fields' => ['Sponsor', 'Tier', 'Sponsorship ($)', 'Booth #', 'Deliverables Rollup']],
            ],
            'views' => ['Agenda Calendar', 'Speaker Gallery', 'Session Schedule Gantt', 'Speaker Intake Form'],
            'automations' => ['Notify #event-ops when VIP travel status changes (Paused for review)'],
        ];
    }
    if (strpos($low, 'contract') !== false || strpos($low, 'legal') !== false || strpos($low, 'vendor') !== false || strpos($low, 'renewal') !== false) {
        return [
            'name' => 'Contract Renewal & Legal Risk Base',
            'domain' => 'Finance & Legal',
            'tables' => [
                ['name' => 'Contracts', 'fields' => ['Vendor / Client', 'Annual Value ($)', 'Renewal Date', 'Auto-Renew', 'AI Clause Risk']],
                ['name' => 'Legal Reviews', 'fields' => ['Contract (Link)', 'Reviewer', 'Status', 'Redline Notes', 'SLA Days (Formula)']],
                ['name' => 'Vendors', 'fields' => ['Vendor Name', 'SOC 2 Verified', 'Total Spend (Rollup)', 'Security Owner']],
            ],
            'views' => ['Renewal Calendar', 'Risk Grid', 'Legal Triage Inbox', 'Exec Spend Interface'],
            'automations' => ['Alert Finance 60 days before Renewal Date (Paused for review)'],
        ];
    }
    if (strpos($low, 'feedback') !== false || strpos($low, 'support') !== false || strpos($low, 'ticket') !== false || strpos($low, 'customer') !== false) {
        return [
            'name' => 'Customer Feedback Intelligence Base',
            'domain' => 'Product & CX',
            'tables' => [
                ['name' => 'Feedback Stream', 'fields' => ['Submission', 'Account (Link)', 'Channel', 'AI Sentiment', 'AI Theme Tag']],
                ['name' => 'Feature Themes', 'fields' => ['Theme', 'Linked Mentions (Rollup)', 'ARR Influenced (Rollup)', 'Roadmap Status']],
                ['name' => 'Accounts', 'fields' => ['Account Name', 'Tier', 'ARR ($)', 'Health Score (Formula)']],
            ],
            'views' => ['Triage Inbox', 'Theme Priority Kanban', 'ARR Impact Dashboard', 'Public Feedback Form'],
            'automations' => ['Escalate Negative Sentiment from Tier 1 Accounts to #cx-urgent (Paused for review)'],
        ];
    }

    $cleanTitle = trim(substr(preg_replace('/[^a-zA-Z0-9\s&-]/', '', $prompt) ?: 'Custom Operations Base', 0, 44));
    return [
        'name' => ucfirst($cleanTitle) . ' Base',
        'domain' => 'Custom Workflow',
        'tables' => [
            ['name' => 'Primary Records', 'fields' => ['Name', 'Status', 'Priority', 'Owner', 'Budget ($)', 'Target Date', 'AI Summary']],
            ['name' => 'Linked Tasks', 'fields' => ['Task', 'Parent Record (Link)', 'Assignee', 'Est Hours', 'Done (Checkbox)']],
            ['name' => 'Stakeholders', 'fields' => ['Contact Name', 'Role', 'Email', 'Assigned Count (Rollup)']],
        ],
        'views' => ['Master Grid', 'Status Kanban', 'Delivery Timeline (Gantt)', 'Intake Form', 'Exec Summary Interface'],
        'automations' => ['Notify team when Priority = P0 and Status = At Risk (Paused for review)'],
    ];
}

$router->get('/api/state', function (PDO $pdo): array {
    $blueprints = BaseGridDb::all($pdo, 'SELECT * FROM omni_blueprints ORDER BY id DESC');
    $messages = BaseGridDb::all($pdo, 'SELECT * FROM omni_messages ORDER BY id ASC');
    $agents = BaseGridDb::all($pdo, 'SELECT * FROM field_agents ORDER BY id ASC');
    $rows = BaseGridDb::all($pdo, 'SELECT * FROM agent_rows ORDER BY id ASC');
    $settings = BaseGridDb::one($pdo, 'SELECT * FROM mcp_settings WHERE id = 1') ?: [];
    $logs = BaseGridDb::all($pdo, 'SELECT * FROM mcp_call_logs ORDER BY id DESC LIMIT 30');

    return [
        'blueprints' => array_map(fn($b) => [
            'id' => (int) $b['id'],
            'name' => (string) $b['name'],
            'prompt' => (string) $b['prompt'],
            'domain' => (string) $b['domain'],
            'tables' => json_decode((string) $b['tables_json'], true) ?: [],
            'views' => json_decode((string) $b['views_json'], true) ?: [],
            'automations' => json_decode((string) $b['automations_json'], true) ?: [],
            'created_at' => (string) $b['created_at'],
        ], $blueprints),
        'messages' => $messages,
        'agents' => array_map(fn($a) => [
            'id' => (int) $a['id'],
            'name' => (string) $a['name'],
            'output_column' => (string) $a['output_column'],
            'model_name' => (string) $a['model_name'],
            'temperature' => (float) $a['temperature'],
            'web_search' => (int) $a['web_search'] === 1,
            'prompt_template' => (string) $a['prompt_template'],
            'runs_completed' => (int) $a['runs_completed'],
        ], $agents),
        'rows' => array_map(fn($r) => [
            'id' => (int) $r['id'],
            'company' => (string) $r['company'],
            'source_text' => (string) $r['source_text'],
            'arr_value' => (float) $r['arr_value'],
            'ai_summary' => (string) $r['ai_summary'],
            'ai_risk' => (string) $r['ai_risk'],
            'ai_category' => (string) $r['ai_category'],
            'ai_next_action' => (string) $r['ai_next_action'],
            'confidence' => (int) $r['confidence'],
            'updated_at' => (string) $r['updated_at'],
        ], $rows),
        'mcpSettings' => [
            'mcp_enabled' => (int) ($settings['mcp_enabled'] ?? 1) === 1,
            'zero_retention' => (int) ($settings['zero_retention'] ?? 1) === 1,
            'pause_ai_automations' => (int) ($settings['pause_ai_automations'] ?? 1) === 1,
            'monthly_credit_cap' => (int) ($settings['monthly_credit_cap'] ?? 50000),
            'credits_used' => (int) ($settings['credits_used'] ?? 0),
        ],
        'mcpLogs' => $logs,
    ];
});

// Omni Conversational App Generation
$router->post('/api/omni/generate', function (PDO $pdo): array {
    $in = BaseGridHttp::body();
    $prompt = BaseGridHttp::str($in, 'prompt', '', 1200);
    if ($prompt === '') {
        BaseGridHttp::error('Describe the app you want Omni to build.', 422);
    }
    $now = BaseGridHttp::now();
    $spec = synthesizeBlueprintFromPrompt($prompt);

    $pdo->beginTransaction();
    try {
        $bpId = BaseGridDb::exec(
            $pdo,
            'INSERT INTO omni_blueprints (name, prompt, domain, tables_json, views_json, automations_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [
                $spec['name'],
                $prompt,
                $spec['domain'],
                json_encode($spec['tables'], JSON_UNESCAPED_SLASHES),
                json_encode($spec['views'], JSON_UNESCAPED_SLASHES),
                json_encode($spec['automations'], JSON_UNESCAPED_SLASHES),
                $now,
            ]
        );
        BaseGridDb::exec(
            $pdo,
            'INSERT INTO omni_messages (role, content, blueprint_id, created_at) VALUES (?, ?, ?, ?)',
            ['user', $prompt, $bpId, $now]
        );
        $reply = sprintf(
            'Built "%s" (%s) with %d relational tables, %d views, AI Field Agents, and %d automation(s) created paused for review.',
            $spec['name'],
            $spec['domain'],
            count($spec['tables']),
            count($spec['views']),
            count($spec['automations'])
        );
        BaseGridDb::exec(
            $pdo,
            'INSERT INTO omni_messages (role, content, blueprint_id, created_at) VALUES (?, ?, ?, ?)',
            ['assistant', $reply, $bpId, $now]
        );
        BaseGridDb::exec($pdo, 'UPDATE mcp_settings SET credits_used = credits_used + 45 WHERE id = 1');
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    return ['__status' => 201, '__body' => ['blueprintId' => $bpId, 'name' => $spec['name']]];
});

// Undo / Revert an Omni Blueprint
$router->delete('/api/omni/blueprints/{id}', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    BaseGridDb::exec($pdo, 'DELETE FROM omni_messages WHERE blueprint_id = ?', [$id]);
    BaseGridDb::exec($pdo, 'DELETE FROM omni_blueprints WHERE id = ?', [$id]);
    return ['reverted' => $id];
});

// Add new row to Field Agents dataset
$router->post('/api/agent-rows', function (PDO $pdo): array {
    $in = BaseGridHttp::body();
    $company = BaseGridHttp::str($in, 'company', '', 120);
    $source = BaseGridHttp::str($in, 'source_text', '', 1200);
    if ($company === '' || $source === '') {
        BaseGridHttp::error('Company and unstructured notes are required.', 422);
    }
    $id = BaseGridDb::exec(
        $pdo,
        'INSERT INTO agent_rows (company, source_text, arr_value, ai_summary, ai_risk, ai_category, ai_next_action, confidence, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)',
        [$company, $source, max(0.0, BaseGridHttp::float($in, 'arr_value', 50000.0)), '', '', '', '', BaseGridHttp::today()]
    );
    return ['__status' => 201, '__body' => ['row' => BaseGridDb::one($pdo, 'SELECT * FROM agent_rows WHERE id = ?', [$id])]];
});

// Batch-run ALL Field Agents across all rows (or a single rowId)
$router->post('/api/field-agents/run', function (PDO $pdo): array {
    $in = BaseGridHttp::body();
    $onlyRowId = BaseGridHttp::int($in, 'row_id', 0);
    $rows = $onlyRowId > 0
        ? BaseGridDb::all($pdo, 'SELECT * FROM agent_rows WHERE id = ?', [$onlyRowId])
        : BaseGridDb::all($pdo, 'SELECT * FROM agent_rows ORDER BY id ASC');

    $processed = 0;
    $today = BaseGridHttp::today();
    $pdo->beginTransaction();
    try {
        foreach ($rows as $r) {
            $out = analyzeRowWithLocalAgents($r);
            BaseGridDb::exec(
                $pdo,
                'UPDATE agent_rows SET ai_summary = ?, ai_risk = ?, ai_category = ?, ai_next_action = ?, confidence = ?, updated_at = ? WHERE id = ?',
                [$out['ai_summary'], $out['ai_risk'], $out['ai_category'], $out['ai_next_action'], $out['confidence'], $today, (int) $r['id']]
            );
            $processed++;
        }
        BaseGridDb::exec($pdo, 'UPDATE field_agents SET runs_completed = runs_completed + ?', [$processed]);
        BaseGridDb::exec($pdo, 'UPDATE mcp_settings SET credits_used = credits_used + ? WHERE id = 1', [$processed * 12]);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }
    return ['processed' => $processed];
});

// Update Field Agent configuration
$router->patch('/api/field-agents/{id}', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $existing = BaseGridDb::one($pdo, 'SELECT * FROM field_agents WHERE id = ?', [$id]);
    if (!$existing) {
        BaseGridHttp::error('Field agent not found.', 404);
    }
    $in = BaseGridHttp::body();
    BaseGridDb::exec(
        $pdo,
        'UPDATE field_agents SET model_name = ?, temperature = ?, web_search = ?, prompt_template = ? WHERE id = ?',
        [
            BaseGridHttp::str($in, 'model_name', (string) $existing['model_name'], 80),
            max(0.0, min(1.0, BaseGridHttp::float($in, 'temperature', (float) $existing['temperature']))),
            BaseGridHttp::boolInt($in, 'web_search', (int) $existing['web_search']),
            BaseGridHttp::str($in, 'prompt_template', (string) $existing['prompt_template'], 600),
            $id,
        ]
    );
    return ['agent' => BaseGridDb::one($pdo, 'SELECT * FROM field_agents WHERE id = ?', [$id])];
});

// MCP Settings toggle
$router->patch('/api/mcp/settings', function (PDO $pdo): array {
    $cur = BaseGridDb::one($pdo, 'SELECT * FROM mcp_settings WHERE id = 1') ?: [];
    $in = BaseGridHttp::body();
    BaseGridDb::exec(
        $pdo,
        'UPDATE mcp_settings SET mcp_enabled = ?, zero_retention = ?, pause_ai_automations = ? WHERE id = 1',
        [
            BaseGridHttp::boolInt($in, 'mcp_enabled', (int) ($cur['mcp_enabled'] ?? 1)),
            BaseGridHttp::boolInt($in, 'zero_retention', (int) ($cur['zero_retention'] ?? 1)),
            BaseGridHttp::boolInt($in, 'pause_ai_automations', (int) ($cur['pause_ai_automations'] ?? 1)),
        ]
    );
    return ['ok' => true];
});

// Live MCP Tool Execution Endpoint
$router->post('/api/mcp/call', function (PDO $pdo): array {
    $settings = BaseGridDb::one($pdo, 'SELECT * FROM mcp_settings WHERE id = 1');
    if ($settings && (int) $settings['mcp_enabled'] !== 1) {
        BaseGridHttp::error('MCP Server is disabled by Workspace Admin governance.', 403);
    }
    $in = BaseGridHttp::body();
    $tool = BaseGridHttp::str($in, 'tool', 'list_blueprints', 64);
    $args = isset($in['args']) && is_array($in['args']) ? $in['args'] : [];
    $started = microtime(true);

    $payload = [];
    $preview = '';
    if ($tool === 'list_blueprints') {
        $bps = BaseGridDb::all($pdo, 'SELECT id, name, domain, created_at FROM omni_blueprints ORDER BY id DESC');
        $payload = ['blueprints' => $bps];
        $preview = 'Returned ' . count($bps) . ' relational blueprint(s)';
    } elseif ($tool === 'query_agent_rows') {
        $risk = isset($args['risk']) ? trim((string) $args['risk']) : '';
        $rows = $risk !== ''
            ? BaseGridDb::all($pdo, 'SELECT id, company, arr_value, ai_risk, ai_category, ai_next_action FROM agent_rows WHERE ai_risk = ?', [$risk])
            : BaseGridDb::all($pdo, 'SELECT id, company, arr_value, ai_risk, ai_category, ai_next_action FROM agent_rows ORDER BY arr_value DESC');
        $payload = ['count' => count($rows), 'rows' => $rows];
        $preview = 'Returned ' . count($rows) . ' dataset row(s)';
    } elseif ($tool === 'get_schema_summary') {
        $bpCount = (int) BaseGridDb::scalar($pdo, 'SELECT COUNT(*) FROM omni_blueprints');
        $rowCount = (int) BaseGridDb::scalar($pdo, 'SELECT COUNT(*) FROM agent_rows');
        $agentCount = (int) BaseGridDb::scalar($pdo, 'SELECT COUNT(*) FROM field_agents');
        $payload = ['blueprints' => $bpCount, 'agentRows' => $rowCount, 'fieldAgents' => $agentCount, 'engine' => BaseGridDb::mode()];
        $preview = "Schema summary: {$bpCount} blueprints, {$agentCount} field agents, {$rowCount} rows";
    } else {
        BaseGridHttp::error('Unknown MCP tool: ' . $tool, 400);
    }

    $ms = max(2, (int) round((microtime(true) - $started) * 1000));
    BaseGridDb::exec(
        $pdo,
        'INSERT INTO mcp_call_logs (tool_name, args_json, result_preview, duration_ms, created_at) VALUES (?, ?, ?, ?, ?)',
        [$tool, json_encode($args, JSON_UNESCAPED_SLASHES), $preview, $ms, BaseGridHttp::now()]
    );
    return ['tool' => $tool, 'duration_ms' => $ms, 'result' => $payload];
});

$router->dispatch();
