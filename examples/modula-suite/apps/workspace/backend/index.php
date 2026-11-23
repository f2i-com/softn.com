<?php
declare(strict_types=1);

require_once __DIR__ . '/micro.php';

$router = new ModulaRouter('modula.workspace', 'Modula Documents, eSign & Discuss', __DIR__ . '/schema.sql');

$router->get('/api/overview', function (PDO $pdo): array {
    return [
        'totalDocs' => (int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM documents'),
        'pendingSigns' => (int) ModulaDb::scalar($pdo, "SELECT COUNT(*) FROM sign_requests WHERE status = 'Pending'"),
        'signedCount' => (int) ModulaDb::scalar($pdo, "SELECT COUNT(*) FROM sign_requests WHERE status = 'Signed'"),
        'pendingApprovals' => (int) ModulaDb::scalar($pdo, "SELECT COUNT(*) FROM approvals WHERE status = 'Pending'"),
        'approvedAmount' => round((float) ModulaDb::scalar($pdo, "SELECT COALESCE(SUM(amount), 0) FROM approvals WHERE status = 'Approved'"), 2),
        'totalMessages' => (int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM channel_messages'),
    ];
});

$router->get('/api/documents', function (PDO $pdo): array {
    return ['documents' => ModulaDb::all($pdo, 'SELECT * FROM documents ORDER BY id DESC')];
});

$router->post('/api/documents', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $title = ModulaHttp::str($in, 'title', '', 200);
    if ($title === '') {
        ModulaHttp::error('Document title is required', 400);
    }
    $content = ModulaHttp::str($in, 'content_text', '', 12000);
    $sizeKb = max(4, (int) ceil(strlen($content) / 64) + 18);
    $id = ModulaDb::exec(
        $pdo,
        'INSERT INTO documents (title, folder, doc_type, owner_name, version_label, tags, size_kb, content_text, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
            $title,
            ModulaHttp::str($in, 'folder', 'Contracts', 60),
            ModulaHttp::str($in, 'doc_type', 'Document', 60),
            ModulaHttp::str($in, 'owner_name', 'Alex Rivera', 100),
            ModulaHttp::str($in, 'version_label', 'v1.0', 20),
            ModulaHttp::str($in, 'tags', '', 200),
            $sizeKb,
            $content,
            ModulaHttp::now(),
        ]
    );
    return ['__status' => 201, '__body' => ['document' => ModulaDb::one($pdo, 'SELECT * FROM documents WHERE id = ?', [$id])]];
});

$router->delete('/api/documents/{id}', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    ModulaDb::exec($pdo, 'DELETE FROM documents WHERE id = ?', [$id]);
    return ['deleted' => $id];
});

$router->get('/api/signs', function (PDO $pdo): array {
    return ['signs' => ModulaDb::all($pdo, 'SELECT * FROM sign_requests ORDER BY id DESC')];
});

$router->post('/api/signs', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $docId = ModulaHttp::int($in, 'document_id', 0);
    $signerName = ModulaHttp::str($in, 'signer_name', '', 140);
    $signerEmail = ModulaHttp::str($in, 'signer_email', '', 160);
    $doc = ModulaDb::one($pdo, 'SELECT * FROM documents WHERE id = ?', [$docId]);
    if (!$doc || $signerName === '' || $signerEmail === '') {
        ModulaHttp::error('Document, signer name, and signer email are required', 400);
    }
    $nextNum = (int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM sign_requests') + 301;
    $ref = 'SGN-2026-' . $nextNum;
    $id = ModulaDb::exec(
        $pdo,
        "INSERT INTO sign_requests (ref_code, document_id, document_title, signer_name, signer_email, status, requested_by, created_at)
         VALUES (?, ?, ?, ?, ?, 'Pending', ?, ?)",
        [$ref, $docId, $doc['title'], $signerName, $signerEmail, ModulaHttp::str($in, 'requested_by', 'Alex Rivera', 100), ModulaHttp::now()]
    );
    return ['__status' => 201, '__body' => ['sign' => ModulaDb::one($pdo, 'SELECT * FROM sign_requests WHERE id = ?', [$id])]];
});

$router->post('/api/signs/{id}/sign', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $req = ModulaDb::one($pdo, 'SELECT * FROM sign_requests WHERE id = ?', [$id]);
    if (!$req) {
        ModulaHttp::error('Signature request not found', 404);
    }
    $in = ModulaHttp::body();
    $sigText = ModulaHttp::str($in, 'signature_text', '', 160);
    if ($sigText === '') {
        ModulaHttp::error('Typed signature is required', 400);
    }
    $signedAt = ModulaHttp::now();
    $auditHash = hash('sha256', $req['ref_code'] . '|' . $req['document_title'] . '|' . $sigText . '|' . $signedAt);
    ModulaDb::exec(
        $pdo,
        "UPDATE sign_requests SET status = 'Signed', signed_at = ?, signature_text = ?, audit_hash = ? WHERE id = ?",
        [$signedAt, $sigText, $auditHash, $id]
    );
    return ['sign' => ModulaDb::one($pdo, 'SELECT * FROM sign_requests WHERE id = ?', [$id])];
});

$router->post('/api/signs/{id}/decline', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    ModulaDb::exec($pdo, "UPDATE sign_requests SET status = 'Declined', signed_at = ? WHERE id = ?", [ModulaHttp::now(), $id]);
    return ['sign' => ModulaDb::one($pdo, 'SELECT * FROM sign_requests WHERE id = ?', [$id])];
});

$router->get('/api/approvals', function (PDO $pdo): array {
    return ['approvals' => ModulaDb::all($pdo, 'SELECT * FROM approvals ORDER BY id DESC')];
});

$router->post('/api/approvals', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $title = ModulaHttp::str($in, 'title', '', 200);
    $requester = ModulaHttp::str($in, 'requester_name', 'Alex Rivera', 120);
    if ($title === '') {
        ModulaHttp::error('Approval title is required', 400);
    }
    $nextNum = (int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM approvals') + 501;
    $ref = 'APR-2026-' . $nextNum;
    $id = ModulaDb::exec(
        $pdo,
        "INSERT INTO approvals (ref_code, category, title, requester_name, amount, justification, approver_name, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending', ?)",
        [
            $ref,
            ModulaHttp::str($in, 'category', 'Purchase', 50),
            $title,
            $requester,
            max(0.0, ModulaHttp::float($in, 'amount', 0.0)),
            ModulaHttp::str($in, 'justification', '', 1000),
            ModulaHttp::str($in, 'approver_name', 'Priya Nair', 120),
            ModulaHttp::now(),
        ]
    );
    return ['__status' => 201, '__body' => ['approval' => ModulaDb::one($pdo, 'SELECT * FROM approvals WHERE id = ?', [$id])]];
});

$router->patch('/api/approvals/{id}/decide', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $in = ModulaHttp::body();
    $status = ModulaHttp::str($in, 'status', '', 20);
    if (!in_array($status, ['Approved', 'Refused'], true)) {
        ModulaHttp::error('Status must be Approved or Refused', 400);
    }
    ModulaDb::exec(
        $pdo,
        'UPDATE approvals SET status = ?, decision_note = ?, decided_at = ? WHERE id = ?',
        [$status, ModulaHttp::str($in, 'decision_note', '', 400), ModulaHttp::now(), $id]
    );
    return ['approval' => ModulaDb::one($pdo, 'SELECT * FROM approvals WHERE id = ?', [$id])];
});

$router->get('/api/channels', function (PDO $pdo): array {
    $channels = ModulaDb::all(
        $pdo,
        'SELECT c.*, (SELECT COUNT(*) FROM channel_messages m WHERE m.channel_id = c.id) AS message_count FROM channels c ORDER BY c.id ASC'
    );
    return ['channels' => $channels];
});

$router->post('/api/channels', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $rawName = trim(ModulaHttp::str($in, 'name', '', 60));
    if ($rawName === '') {
        ModulaHttp::error('Channel name is required', 400);
    }
    $slug = strtolower(preg_replace('/[^a-z0-9]+/i', '-', ltrim($rawName, '#')) ?? 'channel');
    $name = '#' . trim($slug, '-');
    $id = ModulaDb::exec(
        $pdo,
        'INSERT INTO channels (slug, name, kind, topic) VALUES (?, ?, ?, ?)',
        [$slug, $name, ModulaHttp::str($in, 'kind', 'Public', 20), ModulaHttp::str($in, 'topic', '', 240)]
    );
    return ['__status' => 201, '__body' => ['channel' => ModulaDb::one($pdo, 'SELECT * FROM channels WHERE id = ?', [$id])]];
});

$router->get('/api/channels/{id}/messages', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    return ['messages' => ModulaDb::all($pdo, 'SELECT * FROM channel_messages WHERE channel_id = ? ORDER BY id ASC', [$id])];
});

$router->post('/api/channels/{id}/messages', function (PDO $pdo, array $params): array {
    $channelId = (int) $params['id'];
    $in = ModulaHttp::body();
    $body = ModulaHttp::str($in, 'body', '', 2000);
    if ($body === '') {
        ModulaHttp::error('Message body cannot be empty', 400);
    }
    $id = ModulaDb::exec(
        $pdo,
        'INSERT INTO channel_messages (channel_id, author_name, body, pinned, created_at) VALUES (?, ?, ?, 0, ?)',
        [$channelId, ModulaHttp::str($in, 'author_name', 'Alex Rivera', 100), $body, ModulaHttp::now()]
    );
    return ['__status' => 201, '__body' => ['message' => ModulaDb::one($pdo, 'SELECT * FROM channel_messages WHERE id = ?', [$id])]];
});

$router->patch('/api/messages/{id}/pin', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    ModulaDb::exec($pdo, 'UPDATE channel_messages SET pinned = CASE WHEN pinned = 1 THEN 0 ELSE 1 END WHERE id = ?', [$id]);
    return ['message' => ModulaDb::one($pdo, 'SELECT * FROM channel_messages WHERE id = ?', [$id])];
});

$router->dispatch();
