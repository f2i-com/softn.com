-- Modula Events, Surveys & eLearning Academy Schema (XDB SQLite 3)

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'Conference',
    event_date TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT 'Online / Live Stream',
    capacity INTEGER NOT NULL DEFAULT 100,
    ticket_price REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'Published',
    description TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS registrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_code TEXT NOT NULL UNIQUE,
    event_id INTEGER NOT NULL,
    attendee_name TEXT NOT NULL,
    attendee_email TEXT NOT NULL,
    company TEXT DEFAULT '',
    ticket_tier TEXT NOT NULL DEFAULT 'Standard',
    amount_paid REAL NOT NULL DEFAULT 0,
    checked_in INTEGER NOT NULL DEFAULT 0,
    checked_in_at TEXT DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS surveys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'NPS',
    status TEXT NOT NULL DEFAULT 'Live',
    prompt_text TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS survey_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    survey_id INTEGER NOT NULL,
    respondent_name TEXT NOT NULL,
    score INTEGER NOT NULL DEFAULT 10,
    comment TEXT DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS courses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'Platform',
    instructor_name TEXT NOT NULL DEFAULT 'Alex Rivera',
    level TEXT NOT NULL DEFAULT 'Beginner',
    duration_min INTEGER NOT NULL DEFAULT 45,
    published INTEGER NOT NULL DEFAULT 1,
    description TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS lessons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    course_id INTEGER NOT NULL,
    position INTEGER NOT NULL DEFAULT 1,
    title TEXT NOT NULL,
    lesson_type TEXT NOT NULL DEFAULT 'Article',
    duration_min INTEGER NOT NULL DEFAULT 15,
    content_text TEXT NOT NULL DEFAULT '',
    completed INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO events (id, title, category, event_date, location, capacity, ticket_price, status, description) VALUES
(1, 'Modula ERP Summit 2026', 'Conference', '2026-12-08', 'Harbor Convention Center + Live Stream', 120, 149.00, 'Published', 'Full-day showcase on replacing per-seat SaaS ERPs with portable SoftN v2 React + PHP + SQLite containers.'),
(2, 'Hands-On Workshop: Building Custom .softn Apps', 'Workshop', '2026-12-15', 'Online Interactive Lab', 40, 49.00, 'Published', 'Build, bundle, and deploy your first dual-mode ZIPP WASM + standalone PHP module in 90 minutes.'),
(3, 'Finance & Inventory Migration Office Hours', 'Webinar', '2026-12-20', 'Zoom / Modula Live', 200, 0.00, 'Published', 'Live Q&A on importing Odoo CSVs into Modula Accounting and Inventory.');

INSERT OR IGNORE INTO registrations (id, ticket_code, event_id, attendee_name, attendee_email, company, ticket_tier, amount_paid, checked_in, checked_in_at, created_at) VALUES
(1, 'EVT-9001', 1, 'Marcus Vance', 'm.vance@apexmanufacturing.example', 'Apex Manufacturing', 'VIP', 149.00, 1, '2026-11-22 08:50', '2026-11-18 10:15'),
(2, 'EVT-9002', 1, 'Dr. Hannah Cho', 'h.cho@vanguardhealth.example', 'Vanguard Health', 'Standard', 149.00, 0, '', '2026-11-19 14:22'),
(3, 'EVT-9003', 1, 'Elena Gomez', 'elena@harborroasters.example', 'Harbor Roasters', 'Standard', 149.00, 1, '2026-11-22 09:05', '2026-11-20 11:00'),
(4, 'EVT-9004', 2, 'Liam O''Connor', 'liam@pacifictimber.example', 'Pacific Timber Co.', 'Workshop Seat', 49.00, 0, '', '2026-11-21 16:40');

INSERT OR IGNORE INTO surveys (id, title, kind, status, prompt_text, created_at) VALUES
(1, 'Q4 Modula Customer NPS Pulse', 'NPS', 'Live', 'How likely are you (0-10) to recommend Modula on SoftN Containers to another operations team?', '2026-11-10 09:00'),
(2, 'POS & Inventory Onboarding Experience', 'CSAT', 'Live', 'Rate your onboarding speed moving from legacy per-seat ERP to Modula (0-10).', '2026-11-15 11:30');

INSERT OR IGNORE INTO survey_responses (id, survey_id, respondent_name, score, comment, created_at) VALUES
(1, 1, 'Marcus Vance', 10, 'Cutting our ERP bill to $0/seat while keeping full SQLite exports was huge.', '2026-11-14 10:20'),
(2, 1, 'Elena Gomez', 9, 'POS register + Accounting + CRM inside one parent workspace feels snappy.', '2026-11-16 13:15'),
(3, 1, 'Liam O''Connor', 8, 'Love ZIPP WASM mode for instant local demos; standalone PHP setup took 2 minutes.', '2026-11-18 09:40'),
(4, 2, 'Dr. Hannah Cho', 10, 'Imported our entire clinic catalog and trained front desk staff in one afternoon.', '2026-11-20 15:10');

INSERT OR IGNORE INTO courses (id, title, category, instructor_name, level, duration_min, published, description) VALUES
(1, 'Modula ERP Foundations for Operators', 'Operations', 'Alex Rivera', 'Beginner', 45, 1, 'Master CRM pipelines, double-entry invoicing, warehouse receiving, and team timesheets.'),
(2, 'SoftN v2 Dual-Mode PHP & XDB SQLite Architecture', 'Engineering', 'Jordan Lee', 'Intermediate', 60, 1, 'Learn how one PHP 8 backend runs inside browser ZIPP WASM and scales to standalone PHP with zero changes.');

INSERT OR IGNORE INTO lessons (id, course_id, position, title, lesson_type, duration_min, content_text, completed) VALUES
(1, 1, 1, 'Navigating the Parent Workspace & Ctrl+K Launcher', 'Article', 10, 'Use the 9-dot grid or press Ctrl+K anywhere in Modula OS to jump instantly between running keep-alive .softn apps without losing form state.', 1),
(2, 1, 2, 'Quote-to-Cash: CRM Deal -> Quotation -> Accounting Invoice', 'Lab', 20, 'Qualify a scored inbound lead, convert it to an opportunity, generate a multi-line quotation, and post balanced debit/credit journal entries upon invoice payment.', 1),
(3, 1, 3, 'Inventory Receiving & Manufacturing MRP Kit Assembly', 'Article', 15, 'Trigger a 1-click low-stock Draft PO, receive stock atomically into warehouse bins, and run a Manufacturing Order to assemble finished kits.', 0),
(4, 2, 1, 'Inside manifest.json & Portable .softn Containers', 'Article', 20, 'Every Modula app ships a Vite React build in public/, a PHP 8 API in backend/index.php, and a SQLite schema in backend/schema.sql packed into a standard ZIP archive.', 1),
(5, 2, 2, 'Switching Between ZIPP WASM and Standalone PHP Servers', 'Lab', 25, 'Toggle the topbar mode switch to route /api/* calls from in-browser zipp-php.wasm + XDB SQLite to native php -S servers backed by WAL SQLite files.', 0),
(6, 2, 3, 'Exporting & Auditing Your SQLite .db Files', 'Quiz', 15, 'Click Export SQLite .db in the Workspace topbar at any time to download a standard SQLite 3 database you can inspect in any SQL tool.', 0);
