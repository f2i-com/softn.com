<?php
declare(strict_types=1);

require_once __DIR__ . '/micro.php';

$router = new ModulaRouter('modula.helpdesk', 'Modula Helpdesk & Knowledge', __DIR__ . '/schema.sql');

const TICKET_STAGES = ['New', 'In Progress', 'Waiting', 'Solved'];

$router->get('/api/overview', function (PDO $pdo): array {
    $open = (int) ModulaDb::scalar($pdo, "SELECT COUNT(*) FROM tickets WHERE stage != 'Solved'");
    $urgent = (int) ModulaDb::scalar($pdo, "SELECT COUNT(*) FROM tickets WHERE stage != 'Solved' AND priority IN ('Urgent', 'High')");
    $solved = (int) ModulaDb::scalar($pdo, "SELECT COUNT(*) FROM tickets WHERE stage = 'Solved'");
    $kbCount = (int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM kb_articles');
    $ratedCount = (int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM tickets WHERE csat_rating > 0');
    $avgCsat = $ratedCount > 0
        ? round((float) ModulaDb::scalar($pdo, 'SELECT AVG(csat_rating) FROM tickets WHERE csat_rating > 0'), 2)
        : 5.0;
    return [
        'openTickets' => $open,
        'highPriority' => $urgent,
        'solvedTickets' => $solved,
        'kbArticles' => $kbCount,
        'avgCsat' => $avgCsat,
        'ratedCount' => $ratedCount,
    ];
});

$router->get('/api/tickets', function (PDO $pdo): array {
    return ['tickets' => ModulaDb::all($pdo, 'SELECT * FROM tickets ORDER BY id DESC')];
});

$router->post('/api/tickets', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $subject = ModulaHttp::str($in, 'subject', '', 180);
    $customer = ModulaHttp::str($in, 'customer_name', '', 120);
    if ($subject === '' || $customer === '') {
        ModulaHttp::error('Subject and customer name are required.', 422);
    }
    $seq = ((int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM tickets')) + 1041;
    $num = 'HD-' . $seq;
    $priority = ModulaHttp::str($in, 'priority', 'Normal', 20);
    $id = ModulaDb::exec(
        $pdo,
        'INSERT INTO tickets (ticket_number, subject, customer_name, customer_email, stage, priority, assignee, sla_status, tags, csat_rating, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)',
        [
            $num,
            $subject,
            $customer,
            ModulaHttp::str($in, 'customer_email', '', 140),
            'New',
            $priority,
            ModulaHttp::str($in, 'assignee', 'Samira Khan', 80),
            $priority === 'Urgent' ? 'Due in 2h' : 'On Track',
            ModulaHttp::str($in, 'tags', 'Support', 100),
            ModulaHttp::now(),
        ]
    );
    $body = ModulaHttp::str($in, 'body', '', 2000);
    if ($body !== '') {
        ModulaDb::exec(
            $pdo,
            'INSERT INTO ticket_messages (ticket_id, author, is_internal, body, created_at) VALUES (?, ?, 0, ?, ?)',
            [$id, $customer, $body, ModulaHttp::now()]
        );
    }
    return ['__status' => 201, '__body' => ['ticket' => ModulaDb::one($pdo, 'SELECT * FROM tickets WHERE id = ?', [$id])]];
});

$router->patch('/api/tickets/{id}', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $ticket = ModulaDb::one($pdo, 'SELECT * FROM tickets WHERE id = ?', [$id]);
    if (!$ticket) {
        ModulaHttp::error('Ticket not found.', 404);
    }
    $in = ModulaHttp::body();
    $stage = isset($in['stage']) && in_array($in['stage'], TICKET_STAGES, true) ? (string) $in['stage'] : (string) $ticket['stage'];
    $priority = isset($in['priority']) ? ModulaHttp::str($in, 'priority', (string) $ticket['priority'], 20) : (string) $ticket['priority'];
    $assignee = isset($in['assignee']) ? ModulaHttp::str($in, 'assignee', (string) $ticket['assignee'], 80) : (string) $ticket['assignee'];
    $csat = isset($in['csat_rating']) ? max(0, min(5, (int) $in['csat_rating'])) : (int) $ticket['csat_rating'];
    $sla = $stage === 'Solved' ? 'Met' : (string) $ticket['sla_status'];
    ModulaDb::exec(
        $pdo,
        'UPDATE tickets SET stage = ?, priority = ?, assignee = ?, sla_status = ?, csat_rating = ? WHERE id = ?',
        [$stage, $priority, $assignee, $sla, $csat, $id]
    );
    return ['ticket' => ModulaDb::one($pdo, 'SELECT * FROM tickets WHERE id = ?', [$id])];
});

$router->get('/api/tickets/{id}/messages', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    return ['messages' => ModulaDb::all($pdo, 'SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY id ASC', [$id])];
});

$router->post('/api/tickets/{id}/messages', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $in = ModulaHttp::body();
    $body = ModulaHttp::str($in, 'body', '', 2000);
    if ($body === '') {
        ModulaHttp::error('Message body is required.', 422);
    }
    $msgId = ModulaDb::exec(
        $pdo,
        'INSERT INTO ticket_messages (ticket_id, author, is_internal, body, created_at) VALUES (?, ?, ?, ?, ?)',
        [$id, ModulaHttp::str($in, 'author', 'Samira Khan', 80), !empty($in['is_internal']) ? 1 : 0, $body, ModulaHttp::now()]
    );
    return ['__status' => 201, '__body' => ['message' => ModulaDb::one($pdo, 'SELECT * FROM ticket_messages WHERE id = ?', [$msgId])]];
});

// Canned Response Macros
$router->get('/api/macros', function (PDO $pdo): array {
    return ['macros' => ModulaDb::all($pdo, 'SELECT * FROM canned_responses ORDER BY id ASC')];
});

$router->post('/api/macros', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $shortcut = ModulaHttp::str($in, 'shortcut', '', 40);
    $title = ModulaHttp::str($in, 'title', '', 120);
    $body = ModulaHttp::str($in, 'body', '', 2000);
    if ($shortcut === '' || $title === '' || $body === '') {
        ModulaHttp::error('Shortcut, title, and template body are required.', 422);
    }
    if ($shortcut[0] !== '/') {
        $shortcut = '/' . $shortcut;
    }
    $id = ModulaDb::exec(
        $pdo,
        'INSERT INTO canned_responses (shortcut, title, body) VALUES (?, ?, ?)',
        [$shortcut, $title, $body]
    );
    return ['__status' => 201, '__body' => ['macro' => ModulaDb::one($pdo, 'SELECT * FROM canned_responses WHERE id = ?', [$id])]];
});

$router->delete('/api/macros/{id}', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    ModulaDb::exec($pdo, 'DELETE FROM canned_responses WHERE id = ?', [$id]);
    return ['deleted' => true, 'id' => $id];
});

// Knowledge Base Wiki (Full CRUD)
$router->get('/api/kb', function (PDO $pdo): array {
    return ['articles' => ModulaDb::all($pdo, 'SELECT * FROM kb_articles ORDER BY helpful_votes DESC, id DESC')];
});

$router->post('/api/kb', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $title = ModulaHttp::str($in, 'title', '', 180);
    $body = ModulaHttp::str($in, 'body', '', 6000);
    if ($title === '' || $body === '') {
        ModulaHttp::error('Article title and body are required.', 422);
    }
    $id = ModulaDb::exec(
        $pdo,
        'INSERT INTO kb_articles (title, category, body, helpful_votes, updated_at) VALUES (?, ?, ?, 1, ?)',
        [$title, ModulaHttp::str($in, 'category', 'Operations', 60), $body, ModulaHttp::today()]
    );
    return ['__status' => 201, '__body' => ['article' => ModulaDb::one($pdo, 'SELECT * FROM kb_articles WHERE id = ?', [$id])]];
});

$router->put('/api/kb/{id}', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $art = ModulaDb::one($pdo, 'SELECT * FROM kb_articles WHERE id = ?', [$id]);
    if (!$art) {
        ModulaHttp::error('Article not found.', 404);
    }
    $in = ModulaHttp::body();
    ModulaDb::exec(
        $pdo,
        'UPDATE kb_articles SET title = ?, category = ?, body = ?, updated_at = ? WHERE id = ?',
        [
            ModulaHttp::str($in, 'title', (string) $art['title'], 180),
            ModulaHttp::str($in, 'category', (string) $art['category'], 60),
            ModulaHttp::str($in, 'body', (string) $art['body'], 6000),
            ModulaHttp::today(),
            $id,
        ]
    );
    return ['article' => ModulaDb::one($pdo, 'SELECT * FROM kb_articles WHERE id = ?', [$id])];
});

$router->delete('/api/kb/{id}', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    ModulaDb::exec($pdo, 'DELETE FROM kb_articles WHERE id = ?', [$id]);
    return ['deleted' => true, 'id' => $id];
});

$router->post('/api/kb/{id}/vote', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    ModulaDb::exec($pdo, 'UPDATE kb_articles SET helpful_votes = helpful_votes + 1 WHERE id = ?', [$id]);
    return ['article' => ModulaDb::one($pdo, 'SELECT * FROM kb_articles WHERE id = ?', [$id])];
});

$router->dispatch();
