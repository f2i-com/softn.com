<?php
declare(strict_types=1);

require_once __DIR__ . '/micro.php';

$router = new ModulaRouter('modula.crm', 'Modula CRM & Sales', __DIR__ . '/schema.sql');

const CRM_STAGES = ['New', 'Qualified', 'Proposition', 'Negotiation', 'Won', 'Lost'];

function computeLeadScore(float $budget, int $teamSize, string $source, string $email): int
{
    $score = 25;
    if ($budget >= 40000) {
        $score += 30;
    } elseif ($budget >= 20000) {
        $score += 20;
    } elseif ($budget >= 10000) {
        $score += 10;
    }
    if ($teamSize >= 30) {
        $score += 20;
    } elseif ($teamSize >= 10) {
        $score += 12;
    }
    if (in_array($source, ['Referral', 'Partner', 'Website'], true)) {
        $score += 15;
    } else {
        $score += 8;
    }
    if ($email !== '' && strpos($email, '@') !== false) {
        $score += 10;
    }
    return max(5, min(99, $score));
}

$router->get('/api/overview', function (PDO $pdo): array {
    $deals = ModulaDb::all($pdo, 'SELECT * FROM deals ORDER BY id DESC');
    $openValue = 0.0;
    $weightedValue = 0.0;
    $wonValue = 0.0;
    $openCount = 0;
    $wonCount = 0;
    $lostCount = 0;
    $byStage = [];
    $byOwner = [];

    foreach (CRM_STAGES as $st) {
        $byStage[$st] = ['stage' => $st, 'count' => 0, 'revenue' => 0.0];
    }

    foreach ($deals as $d) {
        $rev = (float) $d['expected_revenue'];
        $prob = (int) $d['probability'];
        $stage = (string) $d['stage'];
        $owner = (string) ($d['owner_name'] ?: 'Unassigned');

        if (isset($byStage[$stage])) {
            $byStage[$stage]['count']++;
            $byStage[$stage]['revenue'] = round($byStage[$stage]['revenue'] + $rev, 2);
        }
        if (!isset($byOwner[$owner])) {
            $byOwner[$owner] = ['owner' => $owner, 'open' => 0.0, 'won' => 0.0, 'deals' => 0];
        }
        $byOwner[$owner]['deals']++;

        if ($stage === 'Won') {
            $wonValue += $rev;
            $wonCount++;
            $byOwner[$owner]['won'] = round($byOwner[$owner]['won'] + $rev, 2);
        } elseif ($stage === 'Lost') {
            $lostCount++;
        } else {
            $openValue += $rev;
            $weightedValue += $rev * ($prob / 100.0);
            $openCount++;
            $byOwner[$owner]['open'] = round($byOwner[$owner]['open'] + $rev, 2);
        }
    }

    $closedTotal = $wonCount + $lostCount;
    $winRate = $closedTotal > 0 ? round(($wonCount / $closedTotal) * 100, 1) : 100.0;
    $contactsCount = (int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM contacts');
    $quotesCount = (int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM quotes');
    $openLeads = (int) ModulaDb::scalar($pdo, "SELECT COUNT(*) FROM crm_leads WHERE status = 'Open'");
    $activeMrr = (float) ModulaDb::scalar($pdo, "SELECT COALESCE(SUM(mrr), 0) FROM subscriptions WHERE status = 'Active'");
    $pendingActivities = (int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM activities WHERE done = 0');

    return [
        'openPipeline' => round($openValue, 2),
        'weightedForecast' => round($weightedValue, 2),
        'wonRevenue' => round($wonValue, 2),
        'winRate' => $winRate,
        'openDeals' => $openCount,
        'wonDeals' => $wonCount,
        'lostDeals' => $lostCount,
        'contactsCount' => $contactsCount,
        'quotesCount' => $quotesCount,
        'openLeads' => $openLeads,
        'activeMrr' => round($activeMrr, 2),
        'activeArr' => round($activeMrr * 12, 2),
        'pendingActivities' => $pendingActivities,
        'byStage' => array_values($byStage),
        'byOwner' => array_values($byOwner),
    ];
});

// Leads & Qualification
$router->get('/api/leads', function (PDO $pdo): array {
    return ['leads' => ModulaDb::all($pdo, 'SELECT * FROM crm_leads ORDER BY CASE WHEN status = \'Open\' THEN 0 ELSE 1 END, score DESC, id DESC')];
});

$router->post('/api/leads', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $name = ModulaHttp::str($in, 'name', '', 120);
    if ($name === '') {
        ModulaHttp::error('Lead name is required.', 422);
    }
    $budget = max(0.0, ModulaHttp::float($in, 'est_budget', 15000.0));
    $teamSize = max(1, ModulaHttp::int($in, 'team_size', 10));
    $source = ModulaHttp::str($in, 'source', 'Website', 40);
    $email = ModulaHttp::str($in, 'email', '', 140);
    $score = computeLeadScore($budget, $teamSize, $source, $email);

    $id = ModulaDb::exec(
        $pdo,
        'INSERT INTO crm_leads (name, company, email, phone, source, est_budget, team_size, score, status, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
            $name,
            ModulaHttp::str($in, 'company', '', 120),
            $email,
            ModulaHttp::str($in, 'phone', '', 40),
            $source,
            $budget,
            $teamSize,
            $score,
            'Open',
            ModulaHttp::str($in, 'notes', '', 800),
            ModulaHttp::today(),
        ]
    );
    return ['__status' => 201, '__body' => ['lead' => ModulaDb::one($pdo, 'SELECT * FROM crm_leads WHERE id = ?', [$id])]];
});

$router->post('/api/leads/{id}/convert', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $lead = ModulaDb::one($pdo, 'SELECT * FROM crm_leads WHERE id = ?', [$id]);
    if (!$lead) {
        ModulaHttp::error('Lead not found.', 404);
    }
    if ($lead['status'] === 'Converted') {
        ModulaHttp::error('Lead already converted.', 409);
    }
    $in = ModulaHttp::body();
    $owner = ModulaHttp::str($in, 'owner_name', 'Alex Rivera', 80);

    $pdo->beginTransaction();
    try {
        ModulaDb::exec($pdo, "UPDATE crm_leads SET status = 'Converted' WHERE id = ?", [$id]);
        ModulaDb::exec(
            $pdo,
            'INSERT INTO contacts (name, company, email, phone, role_title, tag, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [(string) $lead['name'], (string) $lead['company'], (string) $lead['email'], (string) $lead['phone'], 'Lead Contact', 'Prospect', ModulaHttp::today()]
        );
        $dealTitle = ($lead['company'] ?: $lead['name']) . ' — Modula Suite (' . (int) $lead['team_size'] . ' seats)';
        $priority = (int) $lead['score'] >= 80 ? 3 : ((int) $lead['score'] >= 60 ? 2 : 1);
        $dealId = ModulaDb::exec(
            $pdo,
            'INSERT INTO deals (title, company, contact_name, contact_email, stage, expected_revenue, probability, priority, owner_name, close_date, lost_reason, notes, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
                $dealTitle,
                (string) $lead['company'],
                (string) $lead['name'],
                (string) $lead['email'],
                'Qualified',
                (float) $lead['est_budget'],
                40,
                $priority,
                $owner,
                date('Y-m-d', time() + 86400 * 30),
                '',
                (string) $lead['notes'],
                ModulaHttp::today(),
            ]
        );
        ModulaDb::exec(
            $pdo,
            'INSERT INTO activities (deal_id, kind, author, summary, due_date, done, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
            [$dealId, 'Call', $owner, 'Qualified from Lead #' . $id . ' (score ' . $lead['score'] . '). Schedule discovery call.', date('Y-m-d', time() + 86400 * 2), ModulaHttp::now()]
        );
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    return [
        'lead' => ModulaDb::one($pdo, 'SELECT * FROM crm_leads WHERE id = ?', [$id]),
        'deal' => ModulaDb::one($pdo, 'SELECT * FROM deals WHERE id = ?', [$dealId]),
    ];
});

// Deals
$router->get('/api/deals', function (PDO $pdo): array {
    $q = ModulaHttp::query('q');
    $stage = ModulaHttp::query('stage');
    $sql = 'SELECT d.*, (SELECT COUNT(*) FROM activities a WHERE a.deal_id = d.id AND a.done = 0) AS pending_tasks FROM deals d WHERE 1=1';
    $params = [];
    if ($stage !== '' && $stage !== 'All') {
        $sql .= ' AND d.stage = ?';
        $params[] = $stage;
    }
    if ($q !== '') {
        $sql .= ' AND (LOWER(d.title) LIKE ? OR LOWER(d.company) LIKE ? OR LOWER(d.contact_name) LIKE ?)';
        $like = '%' . strtolower($q) . '%';
        $params[] = $like;
        $params[] = $like;
        $params[] = $like;
    }
    $sql .= ' ORDER BY d.priority DESC, d.id DESC';
    return ['deals' => ModulaDb::all($pdo, $sql, $params)];
});

$router->post('/api/deals', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $title = ModulaHttp::str($in, 'title', '', 160);
    if ($title === '') {
        ModulaHttp::error('Deal title is required.', 422);
    }
    $stage = ModulaHttp::str($in, 'stage', 'New', 40);
    if (!in_array($stage, CRM_STAGES, true)) {
        $stage = 'New';
    }
    $probMap = ['New' => 20, 'Qualified' => 40, 'Proposition' => 65, 'Negotiation' => 80, 'Won' => 100, 'Lost' => 0];
    $probability = isset($in['probability']) ? max(0, min(100, (int) $in['probability'])) : $probMap[$stage];
    $priority = max(1, min(3, ModulaHttp::int($in, 'priority', 2)));

    $id = ModulaDb::exec(
        $pdo,
        'INSERT INTO deals (title, company, contact_name, contact_email, stage, expected_revenue, probability, priority, owner_name, close_date, lost_reason, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
            $title,
            ModulaHttp::str($in, 'company', '', 120),
            ModulaHttp::str($in, 'contact_name', '', 120),
            ModulaHttp::str($in, 'contact_email', '', 140),
            $stage,
            max(0.0, ModulaHttp::float($in, 'expected_revenue', 0.0)),
            $probability,
            $priority,
            ModulaHttp::str($in, 'owner_name', 'Alex Rivera', 80),
            ModulaHttp::str($in, 'close_date', ModulaHttp::today(), 20),
            '',
            ModulaHttp::str($in, 'notes', '', 1000),
            ModulaHttp::today(),
        ]
    );

    ModulaDb::exec(
        $pdo,
        'INSERT INTO activities (deal_id, kind, author, summary, due_date, done, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
        [$id, 'Note', ModulaHttp::str($in, 'owner_name', 'Alex Rivera', 80), 'Opportunity created in stage ' . $stage . '.', '', ModulaHttp::now()]
    );

    return ['__status' => 201, '__body' => ['deal' => ModulaDb::one($pdo, 'SELECT * FROM deals WHERE id = ?', [$id])]];
});

$router->patch('/api/deals/{id}/stage', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $in = ModulaHttp::body();
    $stage = ModulaHttp::str($in, 'stage', '', 40);
    if (!in_array($stage, CRM_STAGES, true)) {
        ModulaHttp::error('Invalid stage.', 422);
    }
    $existing = ModulaDb::one($pdo, 'SELECT * FROM deals WHERE id = ?', [$id]);
    if (!$existing) {
        ModulaHttp::error('Deal not found.', 404);
    }
    $probMap = ['New' => 20, 'Qualified' => 40, 'Proposition' => 65, 'Negotiation' => 80, 'Won' => 100, 'Lost' => 0];
    $prob = isset($in['probability']) ? max(0, min(100, (int) $in['probability'])) : $probMap[$stage];
    $lostReason = $stage === 'Lost' ? ModulaHttp::str($in, 'lost_reason', 'Not specified', 120) : '';

    ModulaDb::exec($pdo, 'UPDATE deals SET stage = ?, probability = ?, lost_reason = ? WHERE id = ?', [$stage, $prob, $lostReason, $id]);
    $msg = 'Moved from ' . $existing['stage'] . ' to ' . $stage . ($lostReason !== '' ? ' (' . $lostReason . ')' : '') . '.';
    ModulaDb::exec(
        $pdo,
        'INSERT INTO activities (deal_id, kind, author, summary, due_date, done, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
        [$id, 'Stage', 'Pipeline', $msg, '', ModulaHttp::now()]
    );
    return ['deal' => ModulaDb::one($pdo, 'SELECT * FROM deals WHERE id = ?', [$id])];
});

$router->delete('/api/deals/{id}', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    ModulaDb::exec($pdo, 'DELETE FROM activities WHERE deal_id = ?', [$id]);
    ModulaDb::exec($pdo, 'DELETE FROM deals WHERE id = ?', [$id]);
    return ['deleted' => true, 'id' => $id];
});

$router->get('/api/deals/{id}/activities', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    return ['activities' => ModulaDb::all($pdo, 'SELECT * FROM activities WHERE deal_id = ? ORDER BY done ASC, id DESC', [$id])];
});

$router->post('/api/deals/{id}/activities', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $in = ModulaHttp::body();
    $summary = ModulaHttp::str($in, 'summary', '', 1000);
    if ($summary === '') {
        ModulaHttp::error('Activity summary is required.', 422);
    }
    $kind = ModulaHttp::str($in, 'kind', 'Note', 30);
    $author = ModulaHttp::str($in, 'author', 'Alex Rivera', 80);
    $due = ModulaHttp::str($in, 'due_date', '', 20);
    $done = $due !== '' ? 0 : 1;
    $actId = ModulaDb::exec(
        $pdo,
        'INSERT INTO activities (deal_id, kind, author, summary, due_date, done, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [$id, $kind, $author, $summary, $due, $done, ModulaHttp::now()]
    );
    return ['__status' => 201, '__body' => ['activity' => ModulaDb::one($pdo, 'SELECT * FROM activities WHERE id = ?', [$actId])]];
});

$router->patch('/api/activities/{id}/toggle', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $act = ModulaDb::one($pdo, 'SELECT * FROM activities WHERE id = ?', [$id]);
    if (!$act) {
        ModulaHttp::error('Activity not found.', 404);
    }
    $next = ((int) $act['done']) === 1 ? 0 : 1;
    ModulaDb::exec($pdo, 'UPDATE activities SET done = ? WHERE id = ?', [$next, $id]);
    return ['activity' => ModulaDb::one($pdo, 'SELECT * FROM activities WHERE id = ?', [$id])];
});

// Contacts
$router->get('/api/contacts', function (PDO $pdo): array {
    $q = ModulaHttp::query('q');
    if ($q !== '') {
        $like = '%' . strtolower($q) . '%';
        $rows = ModulaDb::all(
            $pdo,
            'SELECT * FROM contacts WHERE LOWER(name) LIKE ? OR LOWER(company) LIKE ? OR LOWER(email) LIKE ? ORDER BY id DESC',
            [$like, $like, $like]
        );
    } else {
        $rows = ModulaDb::all($pdo, 'SELECT * FROM contacts ORDER BY id DESC');
    }
    return ['contacts' => $rows];
});

$router->post('/api/contacts', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $name = ModulaHttp::str($in, 'name', '', 120);
    if ($name === '') {
        ModulaHttp::error('Contact name is required.', 422);
    }
    $id = ModulaDb::exec(
        $pdo,
        'INSERT INTO contacts (name, company, email, phone, role_title, tag, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
            $name,
            ModulaHttp::str($in, 'company', '', 120),
            ModulaHttp::str($in, 'email', '', 140),
            ModulaHttp::str($in, 'phone', '', 40),
            ModulaHttp::str($in, 'role_title', '', 100),
            ModulaHttp::str($in, 'tag', 'Prospect', 40),
            ModulaHttp::today(),
        ]
    );
    return ['__status' => 201, '__body' => ['contact' => ModulaDb::one($pdo, 'SELECT * FROM contacts WHERE id = ?', [$id])]];
});

$router->delete('/api/contacts/{id}', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    ModulaDb::exec($pdo, 'DELETE FROM contacts WHERE id = ?', [$id]);
    return ['deleted' => true, 'id' => $id];
});

// Quotes
$router->get('/api/quotes', function (PDO $pdo): array {
    $rows = ModulaDb::all($pdo, 'SELECT * FROM quotes ORDER BY id DESC');
    foreach ($rows as &$r) {
        $decoded = json_decode((string) ($r['items_json'] ?? '[]'), true);
        $r['items'] = is_array($decoded) ? $decoded : [];
    }
    return ['quotes' => $rows];
});

$router->post('/api/quotes', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $customer = ModulaHttp::str($in, 'customer_name', '', 140);
    if ($customer === '') {
        ModulaHttp::error('Customer name is required.', 422);
    }
    $rawItems = isset($in['items']) && is_array($in['items']) ? $in['items'] : [];
    if (count($rawItems) === 0) {
        ModulaHttp::error('Add at least one line item.', 422);
    }
    $items = [];
    $subtotal = 0.0;
    foreach ($rawItems as $line) {
        if (!is_array($line)) {
            continue;
        }
        $desc = trim((string) ($line['description'] ?? 'Service'));
        $qty = max(1.0, (float) ($line['qty'] ?? 1));
        $price = max(0.0, (float) ($line['unitPrice'] ?? 0));
        $subtotal += $qty * $price;
        $items[] = ['description' => $desc, 'qty' => $qty, 'unitPrice' => $price];
    }
    $taxRate = max(0.0, min(50.0, ModulaHttp::float($in, 'tax_rate', 10.0)));
    $total = round($subtotal * (1.0 + ($taxRate / 100.0)), 2);
    $seq = ((int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM quotes')) + 1;
    $quoteNum = 'SO-2026-' . str_pad((string) $seq, 3, '0', STR_PAD_LEFT);
    $dealId = isset($in['deal_id']) && (int) $in['deal_id'] > 0 ? (int) $in['deal_id'] : null;

    $id = ModulaDb::exec(
        $pdo,
        'INSERT INTO quotes (quote_number, deal_id, customer_name, status, subtotal, tax_rate, total, valid_until, items_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
            $quoteNum,
            $dealId,
            $customer,
            'Draft',
            round($subtotal, 2),
            $taxRate,
            $total,
            ModulaHttp::str($in, 'valid_until', date('Y-m-d', time() + 86400 * 30), 20),
            json_encode($items, JSON_UNESCAPED_SLASHES),
            ModulaHttp::today(),
        ]
    );
    $row = ModulaDb::one($pdo, 'SELECT * FROM quotes WHERE id = ?', [$id]);
    if ($row) {
        $row['items'] = $items;
    }
    return ['__status' => 201, '__body' => ['quote' => $row]];
});

$router->patch('/api/quotes/{id}/status', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $in = ModulaHttp::body();
    $status = ModulaHttp::str($in, 'status', '', 30);
    if (!in_array($status, ['Draft', 'Sent', 'Accepted', 'Declined'], true)) {
        ModulaHttp::error('Invalid quote status.', 422);
    }
    $quote = ModulaDb::one($pdo, 'SELECT * FROM quotes WHERE id = ?', [$id]);
    if (!$quote) {
        ModulaHttp::error('Quote not found.', 404);
    }
    ModulaDb::exec($pdo, 'UPDATE quotes SET status = ? WHERE id = ?', [$status, $id]);
    if ($status === 'Accepted' && !empty($quote['deal_id'])) {
        $dealId = (int) $quote['deal_id'];
        ModulaDb::exec($pdo, 'UPDATE deals SET stage = ?, probability = 100 WHERE id = ?', ['Won', $dealId]);
        ModulaDb::exec(
            $pdo,
            'INSERT INTO activities (deal_id, kind, author, summary, due_date, done, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
            [$dealId, 'Quote', 'Sales', 'Quotation ' . $quote['quote_number'] . ' accepted. Deal marked Won.', '', ModulaHttp::now()]
        );
    }
    $updated = ModulaDb::one($pdo, 'SELECT * FROM quotes WHERE id = ?', [$id]);
    if ($updated) {
        $updated['items'] = json_decode((string) $updated['items_json'], true) ?: [];
    }
    return ['quote' => $updated];
});

// Subscriptions (Recurring Revenue)
$router->get('/api/subscriptions', function (PDO $pdo): array {
    return ['subscriptions' => ModulaDb::all($pdo, 'SELECT * FROM subscriptions ORDER BY id DESC')];
});

$router->post('/api/subscriptions', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $customer = ModulaHttp::str($in, 'customer_name', '', 140);
    $plan = ModulaHttp::str($in, 'plan_name', '', 120);
    if ($customer === '' || $plan === '') {
        ModulaHttp::error('Customer and plan name are required.', 422);
    }
    $seq = ((int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM subscriptions')) + 1;
    $subNo = 'SUB-2026-' . str_pad((string) $seq, 2, '0', STR_PAD_LEFT);
    $id = ModulaDb::exec(
        $pdo,
        'INSERT INTO subscriptions (sub_number, customer_name, plan_name, billing_cycle, mrr, seats, status, next_billing_date, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
            $subNo,
            $customer,
            $plan,
            ModulaHttp::str($in, 'billing_cycle', 'Monthly', 20),
            max(0.0, round(ModulaHttp::float($in, 'mrr', 290.0), 2)),
            max(1, ModulaHttp::int($in, 'seats', 10)),
            'Active',
            ModulaHttp::str($in, 'next_billing_date', date('Y-m-d', time() + 86400 * 30), 20),
            ModulaHttp::today(),
        ]
    );
    return ['__status' => 201, '__body' => ['subscription' => ModulaDb::one($pdo, 'SELECT * FROM subscriptions WHERE id = ?', [$id])]];
});

$router->patch('/api/subscriptions/{id}/status', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $in = ModulaHttp::body();
    $status = ModulaHttp::str($in, 'status', '', 20);
    if (!in_array($status, ['Active', 'Paused', 'Churned'], true)) {
        ModulaHttp::error('Invalid status.', 422);
    }
    ModulaDb::exec($pdo, 'UPDATE subscriptions SET status = ? WHERE id = ?', [$status, $id]);
    return ['subscription' => ModulaDb::one($pdo, 'SELECT * FROM subscriptions WHERE id = ?', [$id])];
});

$router->dispatch();
