<?php
declare(strict_types=1);

require_once __DIR__ . '/opal_micro.php';

$router = new OpalRouter('opal.contacts', 'Opal Contacts, ABN & TPAR Directory', __DIR__ . '/schema.sql');

$router->get('/api/overview', function (PDO $pdo): array {
    $customers = (int) OpalDb::scalar($pdo, "SELECT COUNT(*) FROM contacts WHERE contact_type = 'Customer'");
    $suppliers = (int) OpalDb::scalar($pdo, "SELECT COUNT(*) FROM contacts WHERE contact_type = 'Supplier'");
    $contractors = (int) OpalDb::scalar($pdo, "SELECT COUNT(*) FROM contacts WHERE contact_type = 'Contractor'");
    $advisors = (int) OpalDb::scalar($pdo, "SELECT COUNT(*) FROM contacts WHERE contact_type = 'Advisor'");
    $tparTotal = (float) OpalDb::scalar($pdo, 'SELECT COALESCE(SUM(tpar_ytd), 0) FROM contacts WHERE tpar_reportable = 1');
    $validAbns = (int) OpalDb::scalar($pdo, 'SELECT COUNT(*) FROM contacts WHERE abn_valid = 1');

    return [
        'customers' => $customers,
        'suppliers' => $suppliers,
        'contractors' => $contractors,
        'advisors' => $advisors,
        'tparTotal' => round($tparTotal, 2),
        'validAbns' => $validAbns,
    ];
});

$router->get('/api/validate-abn', function (PDO $pdo): array {
    $abn = OpalHttp::query('abn');
    return OpalAu::validateAbn($abn);
});

$router->get('/api/contacts', function (PDO $pdo): array {
    $type = OpalHttp::query('type');
    if (in_array($type, ['Customer', 'Supplier', 'Contractor', 'Advisor'], true)) {
        $rows = OpalDb::all($pdo, 'SELECT * FROM contacts WHERE contact_type = ? ORDER BY name ASC', [$type]);
    } else {
        $rows = OpalDb::all($pdo, 'SELECT * FROM contacts ORDER BY name ASC');
    }
    foreach ($rows as &$c) {
        $c['notes'] = OpalDb::all($pdo, 'SELECT * FROM contact_notes WHERE contact_id = ? ORDER BY id DESC', [(int) $c['id']]);
    }
    return ['contacts' => $rows];
});

$router->post('/api/contacts', function (PDO $pdo): array {
    $in = OpalHttp::body();
    $name = OpalHttp::str($in, 'name', '', 160);
    if ($name === '') {
        OpalHttp::error('Business or contact name is required.', 422);
    }
    $abnRaw = OpalHttp::str($in, 'abn', '', 32);
    $abnCheck = $abnRaw !== '' ? OpalAu::validateAbn($abnRaw) : ['valid' => false, 'formatted' => ''];

    $id = OpalDb::exec(
        $pdo,
        'INSERT INTO contacts
          (name, contact_type, abn, abn_valid, primary_person, email, phone, suburb, state, postcode, payment_terms, credit_limit, balance, bsb, bank_account, tpar_reportable, tpar_ytd, default_tax_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0, ?)',
        [
            $name,
            OpalHttp::str($in, 'contact_type', 'Customer', 30),
            $abnCheck['formatted'] ?: $abnRaw,
            $abnCheck['valid'] ? 1 : 0,
            OpalHttp::str($in, 'primary_person', '', 120),
            OpalHttp::str($in, 'email', '', 160),
            OpalHttp::str($in, 'phone', '', 40),
            OpalHttp::str($in, 'suburb', '', 80),
            strtoupper(OpalHttp::str($in, 'state', 'NSW', 10)),
            OpalHttp::str($in, 'postcode', '', 10),
            OpalHttp::str($in, 'payment_terms', 'Net 14', 20),
            max(0.0, OpalHttp::float($in, 'credit_limit', 10000.0)),
            OpalHttp::str($in, 'bsb', '', 16),
            OpalHttp::str($in, 'bank_account', '', 32),
            OpalHttp::bool($in, 'tpar_reportable', false),
            strtoupper(OpalHttp::str($in, 'default_tax_code', 'GST', 10)),
        ]
    );
    $created = OpalDb::one($pdo, 'SELECT * FROM contacts WHERE id = ?', [$id]);
    if ($created) {
        $created['notes'] = [];
    }
    return ['__status' => 201, '__body' => ['contact' => $created, 'abnCheck' => $abnCheck]];
});

$router->post('/api/contacts/{id}/notes', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $c = OpalDb::one($pdo, 'SELECT * FROM contacts WHERE id = ?', [$id]);
    if (!$c) {
        OpalHttp::error('Contact not found.', 404);
    }
    $in = OpalHttp::body();
    $body = OpalHttp::str($in, 'body', '', 1000);
    if ($body === '') {
        OpalHttp::error('Note text is required.', 422);
    }
    $nid = OpalDb::exec(
        $pdo,
        'INSERT INTO contact_notes (contact_id, created_at, author, channel, body) VALUES (?, ?, ?, ?, ?)',
        [$id, OpalHttp::now(), OpalHttp::str($in, 'author', 'Chloe Nguyen', 80), OpalHttp::str($in, 'channel', 'Note', 40), $body]
    );
    return ['__status' => 201, '__body' => ['note' => OpalDb::one($pdo, 'SELECT * FROM contact_notes WHERE id = ?', [$nid])]];
});

$router->dispatch();
