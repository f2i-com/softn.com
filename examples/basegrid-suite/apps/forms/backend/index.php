<?php
declare(strict_types=1);

require_once __DIR__ . '/micro.php';

$router = new BaseGridRouter('basegrid.forms', 'BaseGrid Forms Builder & Intake Hub', __DIR__ . '/schema.sql');

function hydrateFormField(array $r): array
{
    $opts = json_decode((string) ($r['options_json'] ?? '[]'), true);
    $cond = json_decode((string) ($r['condition_json'] ?? '{}'), true);
    return [
        'id' => (int) $r['id'],
        'form_id' => (int) $r['form_id'],
        'field_key' => (string) $r['field_key'],
        'label' => (string) $r['label'],
        'field_type' => (string) $r['field_type'],
        'required' => (int) $r['required'] === 1,
        'placeholder' => (string) $r['placeholder'],
        'help_text' => (string) $r['help_text'],
        'options' => is_array($opts) ? $opts : [],
        'condition' => is_array($cond) ? $cond : [],
        'position' => (int) $r['position'],
    ];
}

function hydrateSubmission(array $r): array
{
    $ans = json_decode((string) ($r['answers_json'] ?? '{}'), true);
    return [
        'id' => (int) $r['id'],
        'form_id' => (int) $r['form_id'],
        'status' => (string) $r['status'],
        'submitter_name' => (string) $r['submitter_name'],
        'submitter_email' => (string) $r['submitter_email'],
        'answers' => is_array($ans) ? $ans : [],
        'reviewer_note' => (string) $r['reviewer_note'],
        'created_at' => (string) $r['created_at'],
    ];
}

$router->get('/api/state', function (PDO $pdo): array {
    $forms = BaseGridDb::all($pdo, 'SELECT * FROM forms ORDER BY id ASC');
    $fields = BaseGridDb::all($pdo, 'SELECT * FROM form_fields ORDER BY position ASC, id ASC');
    $subs = BaseGridDb::all($pdo, 'SELECT * FROM form_submissions ORDER BY id DESC');
    return [
        'forms' => array_map(fn($f) => [
            'id' => (int) $f['id'],
            'slug' => (string) $f['slug'],
            'title' => (string) $f['title'],
            'description' => (string) $f['description'],
            'cover_gradient' => (string) $f['cover_gradient'],
            'submit_label' => (string) $f['submit_label'],
            'target_table' => (string) $f['target_table'],
            'is_open' => (int) $f['is_open'] === 1,
            'created_at' => (string) $f['created_at'],
        ], $forms),
        'fields' => array_map('hydrateFormField', $fields),
        'submissions' => array_map('hydrateSubmission', $subs),
    ];
});

$router->post('/api/forms', function (PDO $pdo): array {
    $in = BaseGridHttp::body();
    $title = BaseGridHttp::str($in, 'title', '', 140);
    if ($title === '') {
        BaseGridHttp::error('Form title is required.', 422);
    }
    $slugBase = strtolower(trim((string) preg_replace('/[^a-zA-Z0-9]+/', '-', $title), '-'));
    $slug = ($slugBase ?: 'form') . '-' . time();
    $id = BaseGridDb::exec(
        $pdo,
        'INSERT INTO forms (slug, title, description, cover_gradient, submit_label, target_table, is_open, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
        [
            $slug,
            $title,
            BaseGridHttp::str($in, 'description', 'Collect structured submissions straight into XDB SQLite.', 400),
            BaseGridHttp::str($in, 'cover_gradient', 'linear-gradient(135deg,#2563eb,#7c3aed)', 120),
            BaseGridHttp::str($in, 'submit_label', 'Submit Form', 60),
            BaseGridHttp::str($in, 'target_table', 'Intake Table', 60),
            BaseGridHttp::today(),
        ]
    );
    BaseGridDb::exec(
        $pdo,
        'INSERT INTO form_fields (form_id, field_key, label, field_type, required, placeholder, help_text, options_json, condition_json, position) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 0)',
        [$id, 'title', 'Request Summary', 'text', 'Short title...', '', '[]', '{}']
    );
    BaseGridDb::exec(
        $pdo,
        'INSERT INTO form_fields (form_id, field_key, label, field_type, required, placeholder, help_text, options_json, condition_json, position) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 1)',
        [$id, 'priority', 'Priority', 'single_select', '', '', json_encode(['Low', 'Medium', 'High', 'Urgent']), '{}']
    );
    return ['__status' => 201, '__body' => ['form' => BaseGridDb::one($pdo, 'SELECT * FROM forms WHERE id = ?', [$id])]];
});

$router->patch('/api/forms/{id}', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $existing = BaseGridDb::one($pdo, 'SELECT * FROM forms WHERE id = ?', [$id]);
    if (!$existing) {
        BaseGridHttp::error('Form not found.', 404);
    }
    $in = BaseGridHttp::body();
    BaseGridDb::exec(
        $pdo,
        'UPDATE forms SET title = ?, description = ?, cover_gradient = ?, submit_label = ?, is_open = ? WHERE id = ?',
        [
            BaseGridHttp::str($in, 'title', (string) $existing['title'], 140),
            BaseGridHttp::str($in, 'description', (string) $existing['description'], 400),
            BaseGridHttp::str($in, 'cover_gradient', (string) $existing['cover_gradient'], 120),
            BaseGridHttp::str($in, 'submit_label', (string) $existing['submit_label'], 60),
            BaseGridHttp::boolInt($in, 'is_open', (int) $existing['is_open']),
            $id,
        ]
    );
    return ['form' => BaseGridDb::one($pdo, 'SELECT * FROM forms WHERE id = ?', [$id])];
});

$router->post('/api/forms/{formId}/fields', function (PDO $pdo, array $params): array {
    $formId = (int) $params['formId'];
    $in = BaseGridHttp::body();
    $label = BaseGridHttp::str($in, 'label', '', 120);
    if ($label === '') {
        BaseGridHttp::error('Field label is required.', 422);
    }
    $key = strtolower(trim((string) preg_replace('/[^a-zA-Z0-9]+/', '_', $label), '_')) ?: ('field_' . time());
    $opts = isset($in['options']) && is_array($in['options']) ? $in['options'] : [];
    $cond = isset($in['condition']) && is_array($in['condition']) ? $in['condition'] : [];
    $pos = (int) BaseGridDb::scalar($pdo, 'SELECT COUNT(*) FROM form_fields WHERE form_id = ?', [$formId]);

    $id = BaseGridDb::exec(
        $pdo,
        'INSERT INTO form_fields (form_id, field_key, label, field_type, required, placeholder, help_text, options_json, condition_json, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
            $formId,
            $key,
            $label,
            BaseGridHttp::str($in, 'field_type', 'text', 32),
            BaseGridHttp::boolInt($in, 'required', 0),
            BaseGridHttp::str($in, 'placeholder', '', 160),
            BaseGridHttp::str($in, 'help_text', '', 240),
            json_encode($opts, JSON_UNESCAPED_SLASHES),
            json_encode($cond, JSON_UNESCAPED_SLASHES),
            $pos,
        ]
    );
    return ['__status' => 201, '__body' => ['field' => hydrateFormField(BaseGridDb::one($pdo, 'SELECT * FROM form_fields WHERE id = ?', [$id]))]];
});

$router->delete('/api/form-fields/{id}', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    BaseGridDb::exec($pdo, 'DELETE FROM form_fields WHERE id = ?', [$id]);
    return ['deleted' => $id];
});

$router->post('/api/forms/{formId}/submissions', function (PDO $pdo, array $params): array {
    $formId = (int) $params['formId'];
    $form = BaseGridDb::one($pdo, 'SELECT * FROM forms WHERE id = ?', [$formId]);
    if (!$form) {
        BaseGridHttp::error('Form not found.', 404);
    }
    if ((int) $form['is_open'] !== 1) {
        BaseGridHttp::error('This form is currently closed for submissions.', 403);
    }
    $in = BaseGridHttp::body();
    $answers = isset($in['answers']) && is_array($in['answers']) ? $in['answers'] : [];
    $name = BaseGridHttp::str($in, 'submitter_name', 'External Contributor', 100);
    $email = BaseGridHttp::str($in, 'submitter_email', '', 140);

    // Server-side conditional required validation
    $fields = BaseGridDb::all($pdo, 'SELECT * FROM form_fields WHERE form_id = ?', [$formId]);
    foreach ($fields as $f) {
        $cond = json_decode((string) $f['condition_json'], true);
        $visible = true;
        if (is_array($cond) && !empty($cond['fieldKey']) && isset($cond['equals'])) {
            $visible = (string) ($answers[$cond['fieldKey']] ?? '') === (string) $cond['equals'];
        }
        if ($visible && (int) $f['required'] === 1) {
            $v = $answers[$f['field_key']] ?? '';
            if (is_string($v) && trim($v) === '' || $v === null || $v === 0) {
                BaseGridHttp::error('Required field missing: ' . $f['label'], 422);
            }
        }
    }

    $id = BaseGridDb::exec(
        $pdo,
        'INSERT INTO form_submissions (form_id, status, submitter_name, submitter_email, answers_json, reviewer_note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [$formId, 'New', $name, $email, json_encode($answers, JSON_UNESCAPED_SLASHES), '', BaseGridHttp::now()]
    );
    return ['__status' => 201, '__body' => ['submission' => hydrateSubmission(BaseGridDb::one($pdo, 'SELECT * FROM form_submissions WHERE id = ?', [$id]))]];
});

$router->patch('/api/submissions/{id}', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $existing = BaseGridDb::one($pdo, 'SELECT * FROM form_submissions WHERE id = ?', [$id]);
    if (!$existing) {
        BaseGridHttp::error('Submission not found.', 404);
    }
    $in = BaseGridHttp::body();
    BaseGridDb::exec(
        $pdo,
        'UPDATE form_submissions SET status = ?, reviewer_note = ? WHERE id = ?',
        [
            BaseGridHttp::str($in, 'status', (string) $existing['status'], 32),
            BaseGridHttp::str($in, 'reviewer_note', (string) $existing['reviewer_note'], 600),
            $id,
        ]
    );
    return ['submission' => hydrateSubmission(BaseGridDb::one($pdo, 'SELECT * FROM form_submissions WHERE id = ?', [$id]))];
});

$router->dispatch();
