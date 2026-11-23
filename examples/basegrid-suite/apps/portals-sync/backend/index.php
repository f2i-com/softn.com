<?php
declare(strict_types=1);

require_once __DIR__ . '/micro.php';

$router = new BaseGridRouter('basegrid.portals-sync', 'BaseGrid Portals, Sync & Governance', __DIR__ . '/schema.sql');

function writeAudit(PDO $pdo, string $actor, string $category, string $action, string $target): void
{
    BaseGridDb::exec(
        $pdo,
        'INSERT INTO audit_logs (actor, category, action, target, created_at) VALUES (?, ?, ?, ?, ?)',
        [$actor, $category, $action, $target, BaseGridHttp::now()]
    );
}

$router->get('/api/state', function (PDO $pdo): array {
    $portals = BaseGridDb::all($pdo, 'SELECT * FROM portals ORDER BY id ASC');
    $guests = BaseGridDb::all($pdo, 'SELECT * FROM portal_guests ORDER BY id ASC');
    $delivs = BaseGridDb::all($pdo, 'SELECT * FROM portal_deliverables ORDER BY id ASC');
    $sources = BaseGridDb::all($pdo, 'SELECT * FROM sync_sources ORDER BY id ASC');
    $syncRuns = BaseGridDb::all($pdo, 'SELECT * FROM sync_runs ORDER BY id DESC LIMIT 30');
    $policies = BaseGridDb::all($pdo, 'SELECT * FROM rbac_policies ORDER BY id ASC');
    $gov = BaseGridDb::one($pdo, 'SELECT * FROM governance_flags WHERE id = 1') ?: [];
    $audits = BaseGridDb::all($pdo, 'SELECT * FROM audit_logs ORDER BY id DESC LIMIT 50');

    return [
        'portals' => array_map(fn($p) => [
            'id' => (int) $p['id'],
            'name' => (string) $p['name'],
            'slug' => (string) $p['slug'],
            'brand_color' => (string) $p['brand_color'],
            'welcome_text' => (string) $p['welcome_text'],
            'domain_label' => (string) $p['domain_label'],
            'is_active' => (int) $p['is_active'] === 1,
            'created_at' => (string) $p['created_at'],
        ], $portals),
        'guests' => $guests,
        'deliverables' => array_map(fn($d) => [
            'id' => (int) $d['id'],
            'portal_id' => (int) $d['portal_id'],
            'title' => (string) $d['title'],
            'milestone' => (string) $d['milestone'],
            'status' => (string) $d['status'],
            'due_date' => (string) $d['due_date'],
            'client_approved' => (int) $d['client_approved'] === 1,
            'client_feedback' => (string) $d['client_feedback'],
            'updated_at' => (string) $d['updated_at'],
        ], $delivs),
        'sources' => array_map(fn($s) => [
            'id' => (int) $s['id'],
            'name' => (string) $s['name'],
            'provider' => (string) $s['provider'],
            'direction' => (string) $s['direction'],
            'verified' => (int) $s['verified'] === 1,
            'scale_tier' => (string) $s['scale_tier'],
            'records_synced' => (int) $s['records_synced'],
            'status' => (string) $s['status'],
            'last_synced_at' => (string) $s['last_synced_at'],
        ], $sources),
        'syncRuns' => $syncRuns,
        'policies' => array_map(fn($p) => [
            'id' => (int) $p['id'],
            'role_name' => (string) $p['role_name'],
            'can_edit_schema' => (int) $p['can_edit_schema'] === 1,
            'can_edit_records' => (int) $p['can_edit_records'] === 1,
            'can_comment' => (int) $p['can_comment'] === 1,
            'can_export_csv' => (int) $p['can_export_csv'] === 1,
            'can_manage_portals' => (int) $p['can_manage_portals'] === 1,
        ], $policies),
        'governance' => [
            'saml_sso' => (int) ($gov['saml_sso'] ?? 1) === 1,
            'scim_groups' => (int) ($gov['scim_groups'] ?? 1) === 1,
            'app_sandbox' => (int) ($gov['app_sandbox'] ?? 1) === 1,
            'dlp_guard' => (int) ($gov['dlp_guard'] ?? 1) === 1,
            'data_residency' => (string) ($gov['data_residency'] ?? 'Australia (ap-southeast-2)'),
        ],
        'auditLogs' => $audits,
    ];
});

// Create Portal
$router->post('/api/portals', function (PDO $pdo): array {
    $in = BaseGridHttp::body();
    $name = BaseGridHttp::str($in, 'name', '', 120);
    if ($name === '') {
        BaseGridHttp::error('Portal name is required.', 422);
    }
    $slug = strtolower(trim((string) preg_replace('/[^a-zA-Z0-9]+/', '-', $name), '-')) . '-' . time();
    $id = BaseGridDb::exec(
        $pdo,
        'INSERT INTO portals (name, slug, brand_color, welcome_text, domain_label, is_active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
        [
            $name,
            $slug,
            BaseGridHttp::str($in, 'brand_color', '#2563eb', 24),
            BaseGridHttp::str($in, 'welcome_text', 'Welcome to your branded BaseGrid stakeholder portal.', 400),
            BaseGridHttp::str($in, 'domain_label', $slug . '.portal.local', 120),
            BaseGridHttp::today(),
        ]
    );
    BaseGridDb::exec(
        $pdo,
        'INSERT INTO portal_deliverables (portal_id, title, milestone, status, due_date, client_approved, client_feedback, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
        [$id, 'Kickoff Scope & Onboarding Checklist', 'Phase 1', 'In Review', date('Y-m-d', time() + 86400 * 10), '', BaseGridHttp::today()]
    );
    writeAudit($pdo, 'Maya Lin', 'Portal', 'Created white-label external portal', $name);
    return ['__status' => 201, '__body' => ['portal' => BaseGridDb::one($pdo, 'SELECT * FROM portals WHERE id = ?', [$id])]];
});

// Invite Guest (Zero Per-Guest Fee!)
$router->post('/api/portals/{id}/guests', function (PDO $pdo, array $params): array {
    $portalId = (int) $params['id'];
    $portal = BaseGridDb::one($pdo, 'SELECT * FROM portals WHERE id = ?', [$portalId]);
    if (!$portal) {
        BaseGridHttp::error('Portal not found.', 404);
    }
    $in = BaseGridHttp::body();
    $name = BaseGridHttp::str($in, 'name', '', 100);
    $email = BaseGridHttp::str($in, 'email', '', 140);
    if ($name === '' || $email === '') {
        BaseGridHttp::error('Guest name and email are required.', 422);
    }
    $role = BaseGridHttp::str($in, 'role', 'Commenter', 32);
    $id = BaseGridDb::exec(
        $pdo,
        'INSERT INTO portal_guests (portal_id, name, email, company, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [$portalId, $name, $email, BaseGridHttp::str($in, 'company', 'External Partner', 100), $role, BaseGridHttp::today()]
    );
    writeAudit($pdo, 'Maya Lin', 'Portal', "Invited external guest {$email} ({$role})", (string) $portal['name']);
    return ['__status' => 201, '__body' => ['guest' => BaseGridDb::one($pdo, 'SELECT * FROM portal_guests WHERE id = ?', [$id])]];
});

// Guest Approves or Comments on Deliverable in Live Portal Preview
$router->patch('/api/deliverables/{id}', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $existing = BaseGridDb::one($pdo, 'SELECT * FROM portal_deliverables WHERE id = ?', [$id]);
    if (!$existing) {
        BaseGridHttp::error('Deliverable not found.', 404);
    }
    $in = BaseGridHttp::body();
    $approved = BaseGridHttp::boolInt($in, 'client_approved', (int) $existing['client_approved']);
    $feedback = array_key_exists('client_feedback', $in)
        ? BaseGridHttp::str($in, 'client_feedback', (string) $existing['client_feedback'], 800)
        : (string) $existing['client_feedback'];
    $status = $approved === 1 ? 'Approved' : BaseGridHttp::str($in, 'status', (string) $existing['status'], 32);
    $actor = BaseGridHttp::str($in, 'actor', 'External Guest', 80);

    BaseGridDb::exec(
        $pdo,
        'UPDATE portal_deliverables SET status = ?, client_approved = ?, client_feedback = ?, updated_at = ? WHERE id = ?',
        [$status, $approved, $feedback, BaseGridHttp::today(), $id]
    );
    writeAudit($pdo, $actor, 'Portal', $approved === 1 ? 'Approved portal deliverable' : 'Updated deliverable feedback', (string) $existing['title']);
    return ['deliverable' => BaseGridDb::one($pdo, 'SELECT * FROM portal_deliverables WHERE id = ?', [$id])];
});

// Add Sync Connector
$router->post('/api/sync-sources', function (PDO $pdo): array {
    $in = BaseGridHttp::body();
    $name = BaseGridHttp::str($in, 'name', '', 120);
    if ($name === '') {
        BaseGridHttp::error('Connector name is required.', 422);
    }
    $provider = BaseGridHttp::str($in, 'provider', 'PostgreSQL', 60);
    $direction = BaseGridHttp::str($in, 'direction', 'Two-Way', 24);
    $id = BaseGridDb::exec(
        $pdo,
        'INSERT INTO sync_sources (name, provider, direction, verified, scale_tier, records_synced, status, last_synced_at) VALUES (?, ?, ?, 1, ?, 0, ?, ?)',
        [$name, $provider, $direction, BaseGridHttp::str($in, 'scale_tier', 'Standard', 40), 'Ready', 'Never']
    );
    writeAudit($pdo, 'Maya Lin', 'Sync', "Connected {$direction} sync source ({$provider})", $name);
    return ['__status' => 201, '__body' => ['source' => BaseGridDb::one($pdo, 'SELECT * FROM sync_sources WHERE id = ?', [$id])]];
});

// Execute Live Delta Sync on a Connector
$router->post('/api/sync-sources/{id}/sync', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $src = BaseGridDb::one($pdo, 'SELECT * FROM sync_sources WHERE id = ?', [$id]);
    if (!$src) {
        BaseGridHttp::error('Sync source not found.', 404);
    }
    $isHyper = stripos((string) $src['scale_tier'], 'hyperdb') !== false;
    $added = $isHyper ? 640 : (12 + ($id * 7) % 35);
    $updated = $isHyper ? 410 : (8 + ($id * 5) % 24);
    $duration = $isHyper ? 48 : 19;
    $now = BaseGridHttp::now();

    $pdo->beginTransaction();
    try {
        BaseGridDb::exec(
            $pdo,
            'UPDATE sync_sources SET records_synced = records_synced + ?, status = ?, last_synced_at = ? WHERE id = ?',
            [$added, 'Synced', $now, $id]
        );
        $runId = BaseGridDb::exec(
            $pdo,
            'INSERT INTO sync_runs (source_id, source_name, rows_added, rows_updated, duration_ms, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [$id, (string) $src['name'], $added, $updated, $duration, 'Succeeded', $now]
        );
        writeAudit($pdo, 'Sync Worker', 'Sync', "Synced +{$added} added / {$updated} updated rows ({$src['direction']})", (string) $src['name']);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    return [
        'source' => BaseGridDb::one($pdo, 'SELECT * FROM sync_sources WHERE id = ?', [$id]),
        'run' => BaseGridDb::one($pdo, 'SELECT * FROM sync_runs WHERE id = ?', [$runId]),
    ];
});

// Toggle RBAC Policy Permission
$router->patch('/api/rbac/{id}', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $pol = BaseGridDb::one($pdo, 'SELECT * FROM rbac_policies WHERE id = ?', [$id]);
    if (!$pol) {
        BaseGridHttp::error('Policy not found.', 404);
    }
    $in = BaseGridHttp::body();
    BaseGridDb::exec(
        $pdo,
        'UPDATE rbac_policies SET can_edit_schema = ?, can_edit_records = ?, can_comment = ?, can_export_csv = ?, can_manage_portals = ? WHERE id = ?',
        [
            BaseGridHttp::boolInt($in, 'can_edit_schema', (int) $pol['can_edit_schema']),
            BaseGridHttp::boolInt($in, 'can_edit_records', (int) $pol['can_edit_records']),
            BaseGridHttp::boolInt($in, 'can_comment', (int) $pol['can_comment']),
            BaseGridHttp::boolInt($in, 'can_export_csv', (int) $pol['can_export_csv']),
            BaseGridHttp::boolInt($in, 'can_manage_portals', (int) $pol['can_manage_portals']),
            $id,
        ]
    );
    writeAudit($pdo, 'Arjun Mehta', 'Governance', 'Updated RBAC matrix permissions', (string) $pol['role_name']);
    return ['ok' => true];
});

// Update Enterprise Governance Flags
$router->patch('/api/governance', function (PDO $pdo): array {
    $cur = BaseGridDb::one($pdo, 'SELECT * FROM governance_flags WHERE id = 1') ?: [];
    $in = BaseGridHttp::body();
    $residency = BaseGridHttp::str($in, 'data_residency', (string) ($cur['data_residency'] ?? 'Australia (ap-southeast-2)'), 80);
    BaseGridDb::exec(
        $pdo,
        'UPDATE governance_flags SET saml_sso = ?, scim_groups = ?, app_sandbox = ?, dlp_guard = ?, data_residency = ? WHERE id = 1',
        [
            BaseGridHttp::boolInt($in, 'saml_sso', (int) ($cur['saml_sso'] ?? 1)),
            BaseGridHttp::boolInt($in, 'scim_groups', (int) ($cur['scim_groups'] ?? 1)),
            BaseGridHttp::boolInt($in, 'app_sandbox', (int) ($cur['app_sandbox'] ?? 1)),
            BaseGridHttp::boolInt($in, 'dlp_guard', (int) ($cur['dlp_guard'] ?? 1)),
            $residency,
        ]
    );
    writeAudit($pdo, 'Arjun Mehta', 'Governance', 'Updated security & residency configuration', $residency);
    return ['ok' => true];
});

$router->dispatch();
