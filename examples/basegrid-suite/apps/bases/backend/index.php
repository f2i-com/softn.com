<?php
declare(strict_types=1);

require_once __DIR__ . '/micro.php';

$router = new BaseGridRouter('basegrid.bases', 'BaseGrid Bases & Views Studio', __DIR__ . '/schema.sql');

function hydrateField(array $row): array
{
    $opts = json_decode((string) ($row['options_json'] ?? '{}'), true);
    return [
        'id' => (int) $row['id'],
        'table_id' => (int) $row['table_id'],
        'name' => (string) $row['name'],
        'field_type' => (string) $row['field_type'],
        'options' => is_array($opts) ? $opts : [],
        'is_primary' => (int) $row['is_primary'] === 1,
        'width' => (int) ($row['width'] ?? 170),
        'position' => (int) ($row['position'] ?? 0),
    ];
}

function hydrateView(array $row): array
{
    $cfg = json_decode((string) ($row['config_json'] ?? '{}'), true);
    return [
        'id' => (int) $row['id'],
        'table_id' => (int) $row['table_id'],
        'name' => (string) $row['name'],
        'view_type' => (string) $row['view_type'],
        'config' => is_array($cfg) ? $cfg : [],
        'position' => (int) ($row['position'] ?? 0),
    ];
}

function hydrateRecord(array $row): array
{
    $cells = json_decode((string) ($row['cells_json'] ?? '{}'), true);
    return [
        'id' => (int) $row['id'],
        'table_id' => (int) $row['table_id'],
        'cells' => is_array($cells) ? $cells : [],
        'created_by' => (string) ($row['created_by'] ?? 'User'),
        'created_at' => (string) ($row['created_at'] ?? ''),
        'updated_at' => (string) ($row['updated_at'] ?? ''),
    ];
}

// List all bases with table & record counts
$router->get('/api/bases', function (PDO $pdo): array {
    $bases = BaseGridDb::all($pdo, 'SELECT * FROM bases ORDER BY id ASC');
    $out = [];
    foreach ($bases as $b) {
        $bid = (int) $b['id'];
        $tableCount = (int) BaseGridDb::scalar($pdo, 'SELECT COUNT(*) FROM tables_meta WHERE base_id = ?', [$bid]);
        $recordCount = (int) BaseGridDb::scalar(
            $pdo,
            'SELECT COUNT(*) FROM records_data WHERE table_id IN (SELECT id FROM tables_meta WHERE base_id = ?)',
            [$bid]
        );
        $out[] = [
            'id' => $bid,
            'name' => (string) $b['name'],
            'description' => (string) $b['description'],
            'color' => (string) $b['color'],
            'icon' => (string) $b['icon'],
            'created_at' => (string) $b['created_at'],
            'tableCount' => $tableCount,
            'recordCount' => $recordCount,
        ];
    }
    return ['bases' => $out];
});

// Create a brand new base with starter table, fields, views & sample rows
$router->post('/api/bases', function (PDO $pdo): array {
    $in = BaseGridHttp::body();
    $name = BaseGridHttp::str($in, 'name', '', 120);
    if ($name === '') {
        BaseGridHttp::error('Base name is required.', 422);
    }
    $desc = BaseGridHttp::str($in, 'description', 'Custom relational workspace', 300);
    $color = BaseGridHttp::str($in, 'color', '#2563eb', 24);
    $icon = strtoupper(substr(preg_replace('/[^a-zA-Z0-9]/', '', $name) ?: 'BG', 0, 2));
    $today = BaseGridHttp::today();

    $pdo->beginTransaction();
    try {
        $baseId = BaseGridDb::exec(
            $pdo,
            'INSERT INTO bases (name, description, color, icon, created_at) VALUES (?, ?, ?, ?, ?)',
            [$name, $desc, $color, $icon, $today]
        );
        $tableId = BaseGridDb::exec(
            $pdo,
            'INSERT INTO tables_meta (base_id, name, description, position) VALUES (?, ?, ?, 0)',
            [$baseId, 'Items', 'Primary table for ' . $name]
        );
        $fName = BaseGridDb::exec(
            $pdo,
            'INSERT INTO fields_meta (table_id, name, field_type, options_json, is_primary, width, position) VALUES (?, ?, ?, ?, 1, 240, 0)',
            [$tableId, 'Name', 'text', '{}']
        );
        $fStatus = BaseGridDb::exec(
            $pdo,
            'INSERT INTO fields_meta (table_id, name, field_type, options_json, is_primary, width, position) VALUES (?, ?, ?, ?, 0, 140, 1)',
            [$tableId, 'Status', 'single_select', json_encode(['choices' => ['Planned', 'In Progress', 'In Review', 'Done']])]
        );
        $fOwner = BaseGridDb::exec(
            $pdo,
            'INSERT INTO fields_meta (table_id, name, field_type, options_json, is_primary, width, position) VALUES (?, ?, ?, ?, 0, 150, 2)',
            [$tableId, 'Owner', 'text', '{}']
        );
        $fDue = BaseGridDb::exec(
            $pdo,
            'INSERT INTO fields_meta (table_id, name, field_type, options_json, is_primary, width, position) VALUES (?, ?, ?, ?, 0, 130, 3)',
            [$tableId, 'Due Date', 'date', '{}']
        );
        $fBudget = BaseGridDb::exec(
            $pdo,
            'INSERT INTO fields_meta (table_id, name, field_type, options_json, is_primary, width, position) VALUES (?, ?, ?, ?, 0, 125, 4)',
            [$tableId, 'Budget', 'currency', '{"symbol":"$"}']
        );

        BaseGridDb::exec(
            $pdo,
            'INSERT INTO views_meta (table_id, name, view_type, config_json, position) VALUES (?, ?, ?, ?, 0)',
            [$tableId, 'Grid View', 'grid', '{"rowHeight":"medium"}']
        );
        BaseGridDb::exec(
            $pdo,
            'INSERT INTO views_meta (table_id, name, view_type, config_json, position) VALUES (?, ?, ?, ?, 1)',
            [$tableId, 'Status Kanban', 'kanban', json_encode(['groupFieldId' => $fStatus])]
        );
        BaseGridDb::exec(
            $pdo,
            'INSERT INTO views_meta (table_id, name, view_type, config_json, position) VALUES (?, ?, ?, ?, 2)',
            [$tableId, 'Calendar', 'calendar', json_encode(['dateFieldId' => $fDue, 'statusFieldId' => $fStatus])]
        );

        $sample1 = [
            (string) $fName => 'Kickoff & Architecture Plan',
            (string) $fStatus => 'In Progress',
            (string) $fOwner => 'Maya Lin',
            (string) $fDue => date('Y-m-d', time() + 86400 * 7),
            (string) $fBudget => 12000,
        ];
        $sample2 = [
            (string) $fName => 'Stakeholder Review Milestone',
            (string) $fStatus => 'Planned',
            (string) $fOwner => 'Devon Brooks',
            (string) $fDue => date('Y-m-d', time() + 86400 * 18),
            (string) $fBudget => 8500,
        ];
        BaseGridDb::exec(
            $pdo,
            'INSERT INTO records_data (table_id, cells_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
            [$tableId, json_encode($sample1), 'You', $today, $today]
        );
        BaseGridDb::exec(
            $pdo,
            'INSERT INTO records_data (table_id, cells_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
            [$tableId, json_encode($sample2), 'You', $today, $today]
        );
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    return ['__status' => 201, '__body' => ['base' => BaseGridDb::one($pdo, 'SELECT * FROM bases WHERE id = ?', [$baseId])]];
});

// Load entire relational base workspace (tables, fields, views, all records for cross-table links/rollups)
$router->get('/api/bases/{baseId}/workspace', function (PDO $pdo, array $params): array {
    $baseId = (int) $params['baseId'];
    $base = BaseGridDb::one($pdo, 'SELECT * FROM bases WHERE id = ?', [$baseId]);
    if (!$base) {
        BaseGridHttp::error('Base not found.', 404);
    }

    $tables = BaseGridDb::all($pdo, 'SELECT * FROM tables_meta WHERE base_id = ? ORDER BY position ASC, id ASC', [$baseId]);
    $tableIds = array_map(fn($t) => (int) $t['id'], $tables);

    $fields = [];
    $views = [];
    $records = [];

    if (count($tableIds) > 0) {
        $inClause = implode(',', array_fill(0, count($tableIds), '?'));
        $rawFields = BaseGridDb::all($pdo, "SELECT * FROM fields_meta WHERE table_id IN ($inClause) ORDER BY position ASC, id ASC", $tableIds);
        foreach ($rawFields as $f) {
            $fields[] = hydrateField($f);
        }
        $rawViews = BaseGridDb::all($pdo, "SELECT * FROM views_meta WHERE table_id IN ($inClause) ORDER BY position ASC, id ASC", $tableIds);
        foreach ($rawViews as $v) {
            $views[] = hydrateView($v);
        }
        $rawRecords = BaseGridDb::all($pdo, "SELECT * FROM records_data WHERE table_id IN ($inClause) ORDER BY id ASC", $tableIds);
        foreach ($rawRecords as $r) {
            $records[] = hydrateRecord($r);
        }
    }

    return [
        'base' => [
            'id' => (int) $base['id'],
            'name' => (string) $base['name'],
            'description' => (string) $base['description'],
            'color' => (string) $base['color'],
            'icon' => (string) $base['icon'],
            'created_at' => (string) $base['created_at'],
        ],
        'tables' => array_map(fn($t) => [
            'id' => (int) $t['id'],
            'base_id' => (int) $t['base_id'],
            'name' => (string) $t['name'],
            'description' => (string) $t['description'],
            'position' => (int) $t['position'],
        ], $tables),
        'fields' => $fields,
        'views' => $views,
        'records' => $records,
    ];
});

// Create a new table inside a base
$router->post('/api/bases/{baseId}/tables', function (PDO $pdo, array $params): array {
    $baseId = (int) $params['baseId'];
    $in = BaseGridHttp::body();
    $name = BaseGridHttp::str($in, 'name', '', 80);
    if ($name === '') {
        BaseGridHttp::error('Table name is required.', 422);
    }
    $desc = BaseGridHttp::str($in, 'description', '', 240);
    $pos = (int) BaseGridDb::scalar($pdo, 'SELECT COUNT(*) FROM tables_meta WHERE base_id = ?', [$baseId]);

    $pdo->beginTransaction();
    try {
        $tableId = BaseGridDb::exec(
            $pdo,
            'INSERT INTO tables_meta (base_id, name, description, position) VALUES (?, ?, ?, ?)',
            [$baseId, $name, $desc, $pos]
        );
        $fPrimary = BaseGridDb::exec(
            $pdo,
            'INSERT INTO fields_meta (table_id, name, field_type, options_json, is_primary, width, position) VALUES (?, ?, ?, ?, 1, 220, 0)',
            [$tableId, 'Name', 'text', '{}']
        );
        $fStatus = BaseGridDb::exec(
            $pdo,
            'INSERT INTO fields_meta (table_id, name, field_type, options_json, is_primary, width, position) VALUES (?, ?, ?, ?, 0, 140, 1)',
            [$tableId, 'Status', 'single_select', json_encode(['choices' => ['New', 'In Progress', 'Done']])]
        );
        BaseGridDb::exec(
            $pdo,
            'INSERT INTO fields_meta (table_id, name, field_type, options_json, is_primary, width, position) VALUES (?, ?, ?, ?, 0, 220, 2)',
            [$tableId, 'Notes', 'long_text', '{}']
        );
        BaseGridDb::exec(
            $pdo,
            'INSERT INTO views_meta (table_id, name, view_type, config_json, position) VALUES (?, ?, ?, ?, 0)',
            [$tableId, 'Grid View', 'grid', '{"rowHeight":"medium"}']
        );
        BaseGridDb::exec(
            $pdo,
            'INSERT INTO views_meta (table_id, name, view_type, config_json, position) VALUES (?, ?, ?, ?, 1)',
            [$tableId, 'Board View', 'kanban', json_encode(['groupFieldId' => $fStatus])]
        );
        $today = BaseGridHttp::today();
        BaseGridDb::exec(
            $pdo,
            'INSERT INTO records_data (table_id, cells_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
            [$tableId, json_encode([(string) $fPrimary => 'First ' . $name . ' record', (string) $fStatus => 'New']), 'You', $today, $today]
        );
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    return ['__status' => 201, '__body' => ['table' => BaseGridDb::one($pdo, 'SELECT * FROM tables_meta WHERE id = ?', [$tableId])]];
});

// Add a new field (column) to a table
$router->post('/api/tables/{tableId}/fields', function (PDO $pdo, array $params): array {
    $tableId = (int) $params['tableId'];
    $in = BaseGridHttp::body();
    $name = BaseGridHttp::str($in, 'name', '', 80);
    $type = BaseGridHttp::str($in, 'field_type', 'text', 32);
    if ($name === '') {
        BaseGridHttp::error('Field name is required.', 422);
    }
    $options = isset($in['options']) && is_array($in['options']) ? $in['options'] : [];
    $pos = (int) BaseGridDb::scalar($pdo, 'SELECT COUNT(*) FROM fields_meta WHERE table_id = ?', [$tableId]);
    $width = max(90, min(360, BaseGridHttp::int($in, 'width', 165)));

    $id = BaseGridDb::exec(
        $pdo,
        'INSERT INTO fields_meta (table_id, name, field_type, options_json, is_primary, width, position) VALUES (?, ?, ?, ?, 0, ?, ?)',
        [$tableId, $name, $type, json_encode($options, JSON_UNESCAPED_SLASHES), $width, $pos]
    );
    $row = BaseGridDb::one($pdo, 'SELECT * FROM fields_meta WHERE id = ?', [$id]);
    return ['__status' => 201, '__body' => ['field' => hydrateField($row)]];
});

$router->delete('/api/fields/{fieldId}', function (PDO $pdo, array $params): array {
    $fieldId = (int) $params['fieldId'];
    $row = BaseGridDb::one($pdo, 'SELECT * FROM fields_meta WHERE id = ?', [$fieldId]);
    if (!$row) {
        BaseGridHttp::error('Field not found.', 404);
    }
    if ((int) $row['is_primary'] === 1) {
        BaseGridHttp::error('Primary field cannot be deleted.', 400);
    }
    BaseGridDb::exec($pdo, 'DELETE FROM fields_meta WHERE id = ?', [$fieldId]);
    return ['deleted' => $fieldId];
});

// Create a record
$router->post('/api/tables/{tableId}/records', function (PDO $pdo, array $params): array {
    $tableId = (int) $params['tableId'];
    $in = BaseGridHttp::body();
    $cells = isset($in['cells']) && is_array($in['cells']) ? $in['cells'] : [];
    $actor = BaseGridHttp::str($in, 'created_by', 'You', 80);
    $today = BaseGridHttp::today();

    $id = BaseGridDb::exec(
        $pdo,
        'INSERT INTO records_data (table_id, cells_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        [$tableId, json_encode($cells, JSON_UNESCAPED_SLASHES), $actor, $today, $today]
    );
    BaseGridDb::exec(
        $pdo,
        'INSERT INTO record_history (record_id, actor, field_name, old_value, new_value, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [$id, $actor, 'Record', '', 'Created', BaseGridHttp::now()]
    );
    $row = BaseGridDb::one($pdo, 'SELECT * FROM records_data WHERE id = ?', [$id]);
    return ['__status' => 201, '__body' => ['record' => hydrateRecord($row)]];
});

// Patch a record's cells (and append exact diff entries into record_history)
$router->patch('/api/records/{recordId}', function (PDO $pdo, array $params): array {
    $recordId = (int) $params['recordId'];
    $existing = BaseGridDb::one($pdo, 'SELECT * FROM records_data WHERE id = ?', [$recordId]);
    if (!$existing) {
        BaseGridHttp::error('Record not found.', 404);
    }
    $in = BaseGridHttp::body();
    $patch = isset($in['cells']) && is_array($in['cells']) ? $in['cells'] : [];
    $actor = BaseGridHttp::str($in, 'actor', 'You', 80);

    $current = json_decode((string) $existing['cells_json'], true);
    if (!is_array($current)) {
        $current = [];
    }

    $tableFields = BaseGridDb::all($pdo, 'SELECT id, name FROM fields_meta WHERE table_id = ?', [(int) $existing['table_id']]);
    $fieldNames = [];
    foreach ($tableFields as $tf) {
        $fieldNames[(string) $tf['id']] = (string) $tf['name'];
    }

    $now = BaseGridHttp::now();
    $pdo->beginTransaction();
    try {
        foreach ($patch as $fieldKey => $newVal) {
            $k = (string) $fieldKey;
            $oldVal = $current[$k] ?? null;
            $oldStr = is_array($oldVal) ? json_encode($oldVal) : (is_bool($oldVal) ? ($oldVal ? 'true' : 'false') : (string) ($oldVal ?? ''));
            $newStr = is_array($newVal) ? json_encode($newVal) : (is_bool($newVal) ? ($newVal ? 'true' : 'false') : (string) ($newVal ?? ''));
            if ($oldStr !== $newStr) {
                $fname = $fieldNames[$k] ?? ('Field #' . $k);
                BaseGridDb::exec(
                    $pdo,
                    'INSERT INTO record_history (record_id, actor, field_name, old_value, new_value, created_at) VALUES (?, ?, ?, ?, ?, ?)',
                    [$recordId, $actor, $fname, substr($oldStr, 0, 200), substr($newStr, 0, 200), $now]
                );
            }
            $current[$k] = $newVal;
        }
        BaseGridDb::exec(
            $pdo,
            'UPDATE records_data SET cells_json = ?, updated_at = ? WHERE id = ?',
            [json_encode($current, JSON_UNESCAPED_SLASHES), BaseGridHttp::today(), $recordId]
        );
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    $updated = BaseGridDb::one($pdo, 'SELECT * FROM records_data WHERE id = ?', [$recordId]);
    return ['record' => hydrateRecord($updated)];
});

// Duplicate record
$router->post('/api/records/{recordId}/duplicate', function (PDO $pdo, array $params): array {
    $recordId = (int) $params['recordId'];
    $existing = BaseGridDb::one($pdo, 'SELECT * FROM records_data WHERE id = ?', [$recordId]);
    if (!$existing) {
        BaseGridHttp::error('Record not found.', 404);
    }
    $cells = json_decode((string) $existing['cells_json'], true);
    if (!is_array($cells)) {
        $cells = [];
    }
    $primaryField = BaseGridDb::one($pdo, 'SELECT id FROM fields_meta WHERE table_id = ? AND is_primary = 1', [(int) $existing['table_id']]);
    if ($primaryField) {
        $pk = (string) $primaryField['id'];
        $cells[$pk] = trim((string) ($cells[$pk] ?? 'Record')) . ' (Copy)';
    }
    $today = BaseGridHttp::today();
    $newId = BaseGridDb::exec(
        $pdo,
        'INSERT INTO records_data (table_id, cells_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        [(int) $existing['table_id'], json_encode($cells, JSON_UNESCAPED_SLASHES), 'You', $today, $today]
    );
    $row = BaseGridDb::one($pdo, 'SELECT * FROM records_data WHERE id = ?', [$newId]);
    return ['__status' => 201, '__body' => ['record' => hydrateRecord($row)]];
});

// Delete record
$router->delete('/api/records/{recordId}', function (PDO $pdo, array $params): array {
    $recordId = (int) $params['recordId'];
    BaseGridDb::exec($pdo, 'DELETE FROM record_comments WHERE record_id = ?', [$recordId]);
    BaseGridDb::exec($pdo, 'DELETE FROM record_history WHERE record_id = ?', [$recordId]);
    BaseGridDb::exec($pdo, 'DELETE FROM records_data WHERE id = ?', [$recordId]);
    return ['deleted' => $recordId];
});

// Bulk CSV import into a table
$router->post('/api/tables/{tableId}/import-csv', function (PDO $pdo, array $params): array {
    $tableId = (int) $params['tableId'];
    $in = BaseGridHttp::body();
    $rows = isset($in['rows']) && is_array($in['rows']) ? $in['rows'] : [];
    if (count($rows) === 0) {
        BaseGridHttp::error('No CSV rows supplied.', 422);
    }
    $today = BaseGridHttp::today();
    $inserted = [];
    $pdo->beginTransaction();
    try {
        foreach ($rows as $cells) {
            if (!is_array($cells)) {
                continue;
            }
            $id = BaseGridDb::exec(
                $pdo,
                'INSERT INTO records_data (table_id, cells_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
                [$tableId, json_encode($cells, JSON_UNESCAPED_SLASHES), 'CSV Import', $today, $today]
            );
            $inserted[] = hydrateRecord(BaseGridDb::one($pdo, 'SELECT * FROM records_data WHERE id = ?', [$id]));
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }
    return ['__status' => 201, '__body' => ['imported' => count($inserted), 'records' => $inserted]];
});

// Views CRUD
$router->post('/api/tables/{tableId}/views', function (PDO $pdo, array $params): array {
    $tableId = (int) $params['tableId'];
    $in = BaseGridHttp::body();
    $name = BaseGridHttp::str($in, 'name', '', 80);
    $type = BaseGridHttp::str($in, 'view_type', 'grid', 24);
    if ($name === '') {
        BaseGridHttp::error('View name is required.', 422);
    }
    $config = isset($in['config']) && is_array($in['config']) ? $in['config'] : [];
    $pos = (int) BaseGridDb::scalar($pdo, 'SELECT COUNT(*) FROM views_meta WHERE table_id = ?', [$tableId]);
    $id = BaseGridDb::exec(
        $pdo,
        'INSERT INTO views_meta (table_id, name, view_type, config_json, position) VALUES (?, ?, ?, ?, ?)',
        [$tableId, $name, $type, json_encode($config, JSON_UNESCAPED_SLASHES), $pos]
    );
    return ['__status' => 201, '__body' => ['view' => hydrateView(BaseGridDb::one($pdo, 'SELECT * FROM views_meta WHERE id = ?', [$id]))]];
});

$router->patch('/api/views/{viewId}', function (PDO $pdo, array $params): array {
    $viewId = (int) $params['viewId'];
    $existing = BaseGridDb::one($pdo, 'SELECT * FROM views_meta WHERE id = ?', [$viewId]);
    if (!$existing) {
        BaseGridHttp::error('View not found.', 404);
    }
    $in = BaseGridHttp::body();
    $name = array_key_exists('name', $in) ? BaseGridHttp::str($in, 'name', (string) $existing['name'], 80) : (string) $existing['name'];
    $config = isset($in['config']) && is_array($in['config'])
        ? $in['config']
        : (json_decode((string) $existing['config_json'], true) ?: []);
    BaseGridDb::exec(
        $pdo,
        'UPDATE views_meta SET name = ?, config_json = ? WHERE id = ?',
        [$name, json_encode($config, JSON_UNESCAPED_SLASHES), $viewId]
    );
    return ['view' => hydrateView(BaseGridDb::one($pdo, 'SELECT * FROM views_meta WHERE id = ?', [$viewId]))];
});

$router->delete('/api/views/{viewId}', function (PDO $pdo, array $params): array {
    $viewId = (int) $params['viewId'];
    BaseGridDb::exec($pdo, 'DELETE FROM views_meta WHERE id = ?', [$viewId]);
    return ['deleted' => $viewId];
});

// Record Comments & Revision History
$router->get('/api/records/{recordId}/activity', function (PDO $pdo, array $params): array {
    $recordId = (int) $params['recordId'];
    $comments = BaseGridDb::all($pdo, 'SELECT * FROM record_comments WHERE record_id = ? ORDER BY id ASC', [$recordId]);
    $history = BaseGridDb::all($pdo, 'SELECT * FROM record_history WHERE record_id = ? ORDER BY id DESC LIMIT 40', [$recordId]);
    return ['comments' => $comments, 'history' => $history];
});

$router->post('/api/records/{recordId}/comments', function (PDO $pdo, array $params): array {
    $recordId = (int) $params['recordId'];
    $in = BaseGridHttp::body();
    $body = BaseGridHttp::str($in, 'body', '', 1500);
    if ($body === '') {
        BaseGridHttp::error('Comment body is required.', 422);
    }
    $author = BaseGridHttp::str($in, 'author', 'You', 80);
    $id = BaseGridDb::exec(
        $pdo,
        'INSERT INTO record_comments (record_id, author, body, created_at) VALUES (?, ?, ?, ?)',
        [$recordId, $author, $body, BaseGridHttp::now()]
    );
    return ['__status' => 201, '__body' => ['comment' => BaseGridDb::one($pdo, 'SELECT * FROM record_comments WHERE id = ?', [$id])]];
});

$router->dispatch();
