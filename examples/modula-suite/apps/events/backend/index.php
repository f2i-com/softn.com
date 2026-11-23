<?php
declare(strict_types=1);

require_once __DIR__ . '/micro.php';

$router = new ModulaRouter('modula.events', 'Modula Events, Surveys & eLearning', __DIR__ . '/schema.sql');

$router->get('/api/overview', function (PDO $pdo): array {
    $publishedEvents = (int) ModulaDb::scalar($pdo, "SELECT COUNT(*) FROM events WHERE status = 'Published'");
    $totalRegs = (int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM registrations');
    $checkedIn = (int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM registrations WHERE checked_in = 1');
    $ticketRevenue = (float) ModulaDb::scalar($pdo, 'SELECT COALESCE(SUM(amount_paid), 0) FROM registrations');

    $responses = ModulaDb::all($pdo, 'SELECT score FROM survey_responses');
    $respCount = count($responses);
    $promoters = 0;
    $detractors = 0;
    foreach ($responses as $r) {
        $sc = (int) $r['score'];
        if ($sc >= 9) {
            $promoters++;
        } elseif ($sc <= 6) {
            $detractors++;
        }
    }
    $nps = $respCount > 0 ? (int) round((($promoters - $detractors) / $respCount) * 100) : 0;

    $totalLessons = (int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM lessons');
    $doneLessons = (int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM lessons WHERE completed = 1');
    $completionRate = $totalLessons > 0 ? (int) round(($doneLessons / $totalLessons) * 100) : 0;

    return [
        'publishedEvents' => $publishedEvents,
        'totalRegistrations' => $totalRegs,
        'checkedInCount' => $checkedIn,
        'ticketRevenue' => round($ticketRevenue, 2),
        'npsScore' => $nps,
        'responseCount' => $respCount,
        'coursesCount' => (int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM courses'),
        'completionRate' => $completionRate,
    ];
});

$router->get('/api/events', function (PDO $pdo): array {
    $events = ModulaDb::all(
        $pdo,
        'SELECT e.*,
            (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id) AS registered_count,
            (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id AND r.checked_in = 1) AS checked_in_count
         FROM events e ORDER BY e.event_date ASC'
    );
    return ['events' => $events];
});

$router->post('/api/events', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $title = ModulaHttp::str($in, 'title', '', 200);
    if ($title === '') {
        ModulaHttp::error('Event title is required', 400);
    }
    $id = ModulaDb::exec(
        $pdo,
        "INSERT INTO events (title, category, event_date, location, capacity, ticket_price, status, description)
         VALUES (?, ?, ?, ?, ?, ?, 'Published', ?)",
        [
            $title,
            ModulaHttp::str($in, 'category', 'Conference', 60),
            ModulaHttp::str($in, 'event_date', ModulaHttp::today(), 20),
            ModulaHttp::str($in, 'location', 'Online Live Stream', 160),
            max(1, ModulaHttp::int($in, 'capacity', 100)),
            max(0.0, ModulaHttp::float($in, 'ticket_price', 0.0)),
            ModulaHttp::str($in, 'description', '', 1000),
        ]
    );
    return ['__status' => 201, '__body' => ['event' => ModulaDb::one($pdo, 'SELECT * FROM events WHERE id = ?', [$id])]];
});

$router->get('/api/events/{id}/registrations', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    return ['registrations' => ModulaDb::all($pdo, 'SELECT * FROM registrations WHERE event_id = ? ORDER BY id DESC', [$id])];
});

$router->post('/api/events/{id}/registrations', function (PDO $pdo, array $params): array {
    $eventId = (int) $params['id'];
    $event = ModulaDb::one($pdo, 'SELECT * FROM events WHERE id = ?', [$eventId]);
    if (!$event) {
        ModulaHttp::error('Event not found', 404);
    }
    $currentCount = (int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM registrations WHERE event_id = ?', [$eventId]);
    if ($currentCount >= (int) $event['capacity']) {
        ModulaHttp::error('Event has reached full capacity', 400);
    }
    $in = ModulaHttp::body();
    $name = ModulaHttp::str($in, 'attendee_name', '', 140);
    $email = ModulaHttp::str($in, 'attendee_email', '', 160);
    if ($name === '' || $email === '') {
        ModulaHttp::error('Attendee name and email are required', 400);
    }
    $nextCode = (int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM registrations') + 9001;
    $ticketCode = 'EVT-' . $nextCode;
    $id = ModulaDb::exec(
        $pdo,
        "INSERT INTO registrations (ticket_code, event_id, attendee_name, attendee_email, company, ticket_tier, amount_paid, checked_in, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)",
        [
            $ticketCode,
            $eventId,
            $name,
            $email,
            ModulaHttp::str($in, 'company', '', 140),
            ModulaHttp::str($in, 'ticket_tier', 'Standard', 40),
            (float) $event['ticket_price'],
            ModulaHttp::now(),
        ]
    );
    return ['__status' => 201, '__body' => ['registration' => ModulaDb::one($pdo, 'SELECT * FROM registrations WHERE id = ?', [$id])]];
});

$router->patch('/api/registrations/{id}/checkin', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $reg = ModulaDb::one($pdo, 'SELECT * FROM registrations WHERE id = ?', [$id]);
    if (!$reg) {
        ModulaHttp::error('Registration not found', 404);
    }
    $next = ((int) $reg['checked_in']) === 1 ? 0 : 1;
    $ts = $next === 1 ? ModulaHttp::now() : '';
    ModulaDb::exec($pdo, 'UPDATE registrations SET checked_in = ?, checked_in_at = ? WHERE id = ?', [$next, $ts, $id]);
    return ['registration' => ModulaDb::one($pdo, 'SELECT * FROM registrations WHERE id = ?', [$id])];
});

$router->get('/api/surveys', function (PDO $pdo): array {
    $surveys = ModulaDb::all($pdo, 'SELECT * FROM surveys ORDER BY id DESC');
    foreach ($surveys as &$s) {
        $rows = ModulaDb::all($pdo, 'SELECT score FROM survey_responses WHERE survey_id = ?', [(int) $s['id']]);
        $cnt = count($rows);
        $sum = 0;
        $prom = 0;
        $det = 0;
        foreach ($rows as $r) {
            $sc = (int) $r['score'];
            $sum += $sc;
            if ($sc >= 9) {
                $prom++;
            } elseif ($sc <= 6) {
                $det++;
            }
        }
        $s['response_count'] = $cnt;
        $s['avg_score'] = $cnt > 0 ? round($sum / $cnt, 1) : 0.0;
        $s['nps'] = $cnt > 0 ? (int) round((($prom - $det) / $cnt) * 100) : 0;
    }
    return ['surveys' => $surveys];
});

$router->post('/api/surveys', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $title = ModulaHttp::str($in, 'title', '', 200);
    if ($title === '') {
        ModulaHttp::error('Survey title is required', 400);
    }
    $id = ModulaDb::exec(
        $pdo,
        "INSERT INTO surveys (title, kind, status, prompt_text, created_at) VALUES (?, ?, 'Live', ?, ?)",
        [
            $title,
            ModulaHttp::str($in, 'kind', 'NPS', 40),
            ModulaHttp::str($in, 'prompt_text', 'How satisfied are you (0-10)?', 600),
            ModulaHttp::now(),
        ]
    );
    return ['__status' => 201, '__body' => ['survey' => ModulaDb::one($pdo, 'SELECT * FROM surveys WHERE id = ?', [$id])]];
});

$router->get('/api/surveys/{id}/responses', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    return ['responses' => ModulaDb::all($pdo, 'SELECT * FROM survey_responses WHERE survey_id = ? ORDER BY id DESC', [$id])];
});

$router->post('/api/surveys/{id}/responses', function (PDO $pdo, array $params): array {
    $surveyId = (int) $params['id'];
    $in = ModulaHttp::body();
    $name = ModulaHttp::str($in, 'respondent_name', 'Anonymous', 120);
    $score = max(0, min(10, ModulaHttp::int($in, 'score', 9)));
    $id = ModulaDb::exec(
        $pdo,
        'INSERT INTO survey_responses (survey_id, respondent_name, score, comment, created_at) VALUES (?, ?, ?, ?, ?)',
        [$surveyId, $name, $score, ModulaHttp::str($in, 'comment', '', 800), ModulaHttp::now()]
    );
    return ['__status' => 201, '__body' => ['response' => ModulaDb::one($pdo, 'SELECT * FROM survey_responses WHERE id = ?', [$id])]];
});

$router->get('/api/courses', function (PDO $pdo): array {
    $courses = ModulaDb::all(
        $pdo,
        'SELECT c.*,
            (SELECT COUNT(*) FROM lessons l WHERE l.course_id = c.id) AS lesson_count,
            (SELECT COUNT(*) FROM lessons l WHERE l.course_id = c.id AND l.completed = 1) AS completed_count
         FROM courses c ORDER BY c.id ASC'
    );
    return ['courses' => $courses];
});

$router->post('/api/courses', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $title = ModulaHttp::str($in, 'title', '', 200);
    if ($title === '') {
        ModulaHttp::error('Course title is required', 400);
    }
    $id = ModulaDb::exec(
        $pdo,
        'INSERT INTO courses (title, category, instructor_name, level, duration_min, published, description) VALUES (?, ?, ?, ?, ?, 1, ?)',
        [
            $title,
            ModulaHttp::str($in, 'category', 'Operations', 60),
            ModulaHttp::str($in, 'instructor_name', 'Alex Rivera', 100),
            ModulaHttp::str($in, 'level', 'Beginner', 30),
            max(10, ModulaHttp::int($in, 'duration_min', 30)),
            ModulaHttp::str($in, 'description', '', 800),
        ]
    );
    ModulaDb::exec(
        $pdo,
        "INSERT INTO lessons (course_id, position, title, lesson_type, duration_min, content_text, completed) VALUES (?, 1, 'Course Introduction & Learning Objectives', 'Article', 10, ?, 0)",
        [$id, ModulaHttp::str($in, 'description', 'Welcome to this Modula Academy module.', 800)]
    );
    return ['__status' => 201, '__body' => ['course' => ModulaDb::one($pdo, 'SELECT * FROM courses WHERE id = ?', [$id])]];
});

$router->get('/api/courses/{id}/lessons', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    return ['lessons' => ModulaDb::all($pdo, 'SELECT * FROM lessons WHERE course_id = ? ORDER BY position ASC, id ASC', [$id])];
});

$router->patch('/api/lessons/{id}/toggle', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    ModulaDb::exec($pdo, 'UPDATE lessons SET completed = CASE WHEN completed = 1 THEN 0 ELSE 1 END WHERE id = ?', [$id]);
    return ['lesson' => ModulaDb::one($pdo, 'SELECT * FROM lessons WHERE id = ?', [$id])];
});

$router->dispatch();
