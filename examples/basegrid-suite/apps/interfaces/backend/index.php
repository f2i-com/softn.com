<?php
declare(strict_types=1);

require_once __DIR__ . '/micro.php';

$router = new BaseGridRouter('basegrid.interfaces', 'BaseGrid Interface Designer & Reporting', __DIR__ . '/schema.sql');

function hydrateWidget(array $row): array
{
    $cfg = json_decode((string) ($row['config_json'] ?? '{}'), true);
    return [
        'id' => (int) $row['id'],
        'page_id' => (int) $row['page_id'],
        'widget_type' => (string) $row['widget_type'],
        'title' => (string) $row['title'],
        'span' => (string) $row['span'],
        'config' => is_array($cfg) ? $cfg : [],
        'position' => (int) $row['position'],
    ];
}

$router->get('/api/state', function (PDO $pdo): array {
    $pages = BaseGridDb::all($pdo, 'SELECT * FROM interface_pages ORDER BY id ASC');
    $widgets = BaseGridDb::all($pdo, 'SELECT * FROM interface_widgets ORDER BY position ASC, id ASC');
    $records = BaseGridDb::all($pdo, 'SELECT * FROM portfolio_records ORDER BY id ASC');

    return [
        'pages' => array_map(fn($p) => [
            'id' => (int) $p['id'],
            'name' => (string) $p['name'],
            'description' => (string) $p['description'],
            'audience' => (string) $p['audience'],
            'accent_color' => (string) $p['accent_color'],
            'is_public' => (int) $p['is_public'] === 1,
            'created_at' => (string) $p['created_at'],
        ], $pages),
        'widgets' => array_map('hydrateWidget', $widgets),
        'records' => array_map(fn($r) => [
            'id' => (int) $r['id'],
            'title' => (string) $r['title'],
            'department' => (string) $r['department'],
            'status' => (string) $r['status'],
            'quarter' => (string) $r['quarter'],
            'owner_name' => (string) $r['owner_name'],
            'budget' => (float) $r['budget'],
            'projected_arr' => (float) $r['projected_arr'],
            'progress' => (int) $r['progress'],
            'approved' => (int) $r['approved'] === 1,
            'priority' => (string) $r['priority'],
            'summary' => (string) $r['summary'],
            'updated_at' => (string) $r['updated_at'],
        ], $records),
    ];
});

$router->post('/api/pages', function (PDO $pdo): array {
    $in = BaseGridHttp::body();
    $name = BaseGridHttp::str($in, 'name', '', 120);
    if ($name === '') {
        BaseGridHttp::error('Interface page name is required.', 422);
    }
    $id = BaseGridDb::exec(
        $pdo,
        'INSERT INTO interface_pages (name, description, audience, accent_color, is_public, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [
            $name,
            BaseGridHttp::str($in, 'description', 'Custom role-specific dashboard', 240),
            BaseGridHttp::str($in, 'audience', 'Team', 60),
            BaseGridHttp::str($in, 'accent_color', '#2563eb', 24),
            BaseGridHttp::boolInt($in, 'is_public', 0),
            BaseGridHttp::today(),
        ]
    );
    BaseGridDb::exec(
        $pdo,
        'INSERT INTO interface_widgets (page_id, widget_type, title, span, config_json, position) VALUES (?, ?, ?, ?, ?, 0)',
        [$id, 'kpi_strip', 'Exec Summary Cards', 'full', '{}']
    );
    BaseGridDb::exec(
        $pdo,
        'INSERT INTO interface_widgets (page_id, widget_type, title, span, config_json, position) VALUES (?, ?, ?, ?, ?, 1)',
        [$id, 'bar_chart', 'Projected ARR by Department', 'half', '{"groupBy":"department","metric":"projected_arr"}']
    );
    BaseGridDb::exec(
        $pdo,
        'INSERT INTO interface_widgets (page_id, widget_type, title, span, config_json, position) VALUES (?, ?, ?, ?, ?, 2)',
        [$id, 'donut_chart', 'Status Breakdown', 'half', '{"groupBy":"status","metric":"count"}']
    );
    return ['__status' => 201, '__body' => ['page' => BaseGridDb::one($pdo, 'SELECT * FROM interface_pages WHERE id = ?', [$id])]];
});

$router->patch('/api/pages/{id}', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $existing = BaseGridDb::one($pdo, 'SELECT * FROM interface_pages WHERE id = ?', [$id]);
    if (!$existing) {
        BaseGridHttp::error('Page not found.', 404);
    }
    $in = BaseGridHttp::body();
    BaseGridDb::exec(
        $pdo,
        'UPDATE interface_pages SET is_public = ? WHERE id = ?',
        [BaseGridHttp::boolInt($in, 'is_public', (int) $existing['is_public']), $id]
    );
    $row = BaseGridDb::one($pdo, 'SELECT * FROM interface_pages WHERE id = ?', [$id]);
    return ['page' => $row];
});

$router->post('/api/pages/{pageId}/widgets', function (PDO $pdo, array $params): array {
    $pageId = (int) $params['pageId'];
    $in = BaseGridHttp::body();
    $wType = BaseGridHttp::str($in, 'widget_type', 'bar_chart', 40);
    $title = BaseGridHttp::str($in, 'title', 'New Widget', 120);
    $span = BaseGridHttp::str($in, 'span', 'half', 12);
    $cfg = isset($in['config']) && is_array($in['config']) ? $in['config'] : [];
    $pos = (int) BaseGridDb::scalar($pdo, 'SELECT COUNT(*) FROM interface_widgets WHERE page_id = ?', [$pageId]);

    $id = BaseGridDb::exec(
        $pdo,
        'INSERT INTO interface_widgets (page_id, widget_type, title, span, config_json, position) VALUES (?, ?, ?, ?, ?, ?)',
        [$pageId, $wType, $title, $span, json_encode($cfg, JSON_UNESCAPED_SLASHES), $pos]
    );
    return ['__status' => 201, '__body' => ['widget' => hydrateWidget(BaseGridDb::one($pdo, 'SELECT * FROM interface_widgets WHERE id = ?', [$id]))]];
});

$router->patch('/api/widgets/{id}', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $existing = BaseGridDb::one($pdo, 'SELECT * FROM interface_widgets WHERE id = ?', [$id]);
    if (!$existing) {
        BaseGridHttp::error('Widget not found.', 404);
    }
    $in = BaseGridHttp::body();
    $title = array_key_exists('title', $in) ? BaseGridHttp::str($in, 'title', (string) $existing['title'], 120) : (string) $existing['title'];
    $span = array_key_exists('span', $in) ? BaseGridHttp::str($in, 'span', (string) $existing['span'], 12) : (string) $existing['span'];
    $pos = array_key_exists('position', $in) ? BaseGridHttp::int($in, 'position', (int) $existing['position']) : (int) $existing['position'];
    $cfg = isset($in['config']) && is_array($in['config'])
        ? json_encode($in['config'], JSON_UNESCAPED_SLASHES)
        : (string) $existing['config_json'];

    BaseGridDb::exec(
        $pdo,
        'UPDATE interface_widgets SET title = ?, span = ?, config_json = ?, position = ? WHERE id = ?',
        [$title, $span, $cfg, $pos, $id]
    );
    return ['widget' => hydrateWidget(BaseGridDb::one($pdo, 'SELECT * FROM interface_widgets WHERE id = ?', [$id]))];
});

$router->delete('/api/widgets/{id}', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    BaseGridDb::exec($pdo, 'DELETE FROM interface_widgets WHERE id = ?', [$id]);
    return ['deleted' => $id];
});

$router->patch('/api/records/{id}', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $existing = BaseGridDb::one($pdo, 'SELECT * FROM portfolio_records WHERE id = ?', [$id]);
    if (!$existing) {
        BaseGridHttp::error('Record not found.', 404);
    }
    $in = BaseGridHttp::body();
    $status = array_key_exists('status', $in) ? BaseGridHttp::str($in, 'status', (string) $existing['status'], 40) : (string) $existing['status'];
    $approved = array_key_exists('approved', $in) ? BaseGridHttp::boolInt($in, 'approved', (int) $existing['approved']) : (int) $existing['approved'];
    $progress = array_key_exists('progress', $in) ? max(0, min(100, BaseGridHttp::int($in, 'progress', (int) $existing['progress']))) : (int) $existing['progress'];
    $summary = array_key_exists('summary', $in) ? BaseGridHttp::str($in, 'summary', (string) $existing['summary'], 600) : (string) $existing['summary'];

    BaseGridDb::exec(
        $pdo,
        'UPDATE portfolio_records SET status = ?, approved = ?, progress = ?, summary = ?, updated_at = ? WHERE id = ?',
        [$status, $approved, $progress, $summary, BaseGridHttp::today(), $id]
    );
    $r = BaseGridDb::one($pdo, 'SELECT * FROM portfolio_records WHERE id = ?', [$id]);
    return [
        'record' => [
            'id' => (int) $r['id'],
            'title' => (string) $r['title'],
            'department' => (string) $r['department'],
            'status' => (string) $r['status'],
            'quarter' => (string) $r['quarter'],
            'owner_name' => (string) $r['owner_name'],
            'budget' => (float) $r['budget'],
            'projected_arr' => (float) $r['projected_arr'],
            'progress' => (int) $r['progress'],
            'approved' => (int) $r['approved'] === 1,
            'priority' => (string) $r['priority'],
            'summary' => (string) $r['summary'],
            'updated_at' => (string) $r['updated_at'],
        ],
    ];
});

$router->dispatch();
