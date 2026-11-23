-- Modula Documents Vault, eSign, Approvals & Team Discuss Schema (XDB SQLite 3)

CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    folder TEXT NOT NULL DEFAULT 'Contracts',
    doc_type TEXT NOT NULL DEFAULT 'PDF / Policy',
    owner_name TEXT NOT NULL DEFAULT 'Alex Rivera',
    version_label TEXT NOT NULL DEFAULT 'v1.0',
    tags TEXT DEFAULT '',
    size_kb INTEGER NOT NULL DEFAULT 42,
    content_text TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sign_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref_code TEXT NOT NULL UNIQUE,
    document_id INTEGER NOT NULL,
    document_title TEXT NOT NULL,
    signer_name TEXT NOT NULL,
    signer_email TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Pending',
    signed_at TEXT DEFAULT '',
    signature_text TEXT DEFAULT '',
    audit_hash TEXT DEFAULT '',
    requested_by TEXT NOT NULL DEFAULT 'Alex Rivera',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref_code TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL DEFAULT 'Purchase',
    title TEXT NOT NULL,
    requester_name TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    justification TEXT DEFAULT '',
    approver_name TEXT NOT NULL DEFAULT 'Priya Nair',
    status TEXT NOT NULL DEFAULT 'Pending',
    decision_note TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    decided_at TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'Public',
    topic TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS channel_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    author_name TEXT NOT NULL,
    body TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO documents (id, title, folder, doc_type, owner_name, version_label, tags, size_kb, content_text, updated_at) VALUES
(1, 'Master Services Agreement (MSA) - Enterprise 2026', 'Contracts', 'Contract', 'Alex Rivera', 'v2.4', 'legal,enterprise,msa', 184, 'MASTER SERVICES AGREEMENT

1. Scope: Modula provides portable SoftN v2 ERP containers running React 18 + PHP 8 + XDB SQLite 3.
2. Data Ownership: Client retains 100% ownership of all exported SQLite .db files with zero vendor lock-in.
3. SLA: 99.9% uptime for optional standalone PHP managed hosting.', '2026-11-18 14:20'),
(2, 'Q4 2026 Security & Local-First Data Policy', 'Legal', 'Policy', 'Priya Nair', 'v1.2', 'security,iso27001,privacy', 96, 'SECURITY POLICY

All in-browser Modula containers execute in isolated ZIPP WASM workers with closed Shadow DOM and origin-scoped IndexedDB persistence. No credentials leave the host boundary.', '2026-11-20 09:45'),
(3, 'Employee Handbook & Remote Expense Guidelines', 'HR Policies', 'Handbook', 'Claire Bennett', 'v3.0', 'hr,expenses,onboarding', 240, 'REMOTE WORK & EXPENSES

Standard home-office equipment allowance is $1,200/year. Expense claims over $500 require department manager approval in Modula Approvals prior to payout.', '2026-11-15 16:10'),
(4, 'FY2027 Hardware Procurement Budget Sheet', 'Finance', 'Financial', 'Jordan Lee', 'v1.1', 'budget,capex,q1', 128, 'CAPEX SUMMARY

- 15x Touch POS Terminals: $2,925
- 2x Dedicated Standalone PHP Edge Nodes: $4,400
- Warehouse Barcode Scanners: $1,850', '2026-11-21 11:05');

INSERT OR IGNORE INTO sign_requests (id, ref_code, document_id, document_title, signer_name, signer_email, status, signed_at, signature_text, audit_hash, requested_by, created_at) VALUES
(1, 'SGN-2026-301', 1, 'Master Services Agreement (MSA) - Enterprise 2026', 'Marcus Vance', 'm.vance@apexmanufacturing.example', 'Pending', '', '', '', 'Alex Rivera', '2026-11-21 10:00'),
(2, 'SGN-2026-302', 2, 'Q4 2026 Security & Local-First Data Policy', 'Dr. Hannah Cho', 'h.cho@vanguardhealth.example', 'Signed', '2026-11-21 15:42', 'Dr. Hannah Cho', '7f4d91a2e8b03c11d49c6e2f8a105b4c2d9a0e6c7b5189f4e2a1d3c8b7f06e12', 'Priya Nair', '2026-11-20 13:15'),
(3, 'SGN-2026-303', 3, 'Employee Handbook & Remote Expense Guidelines', 'Devon Brooks', 'd.brooks@modula.local', 'Pending', '', '', '', 'Claire Bennett', '2026-11-22 08:20');

INSERT OR IGNORE INTO approvals (id, ref_code, category, title, requester_name, amount, justification, approver_name, status, decision_note, created_at, decided_at) VALUES
(1, 'APR-2026-501', 'Purchase', '20x Bluetooth Warehouse Barcode Scanners', 'Samira Patel', 1780.00, 'Expanding West Industrial stocktake capacity before Q1 audit.', 'Priya Nair', 'Pending', '', '2026-11-22 09:10', ''),
(2, 'APR-2026-502', 'Travel', 'Customer On-Site POS Deployment (3 days)', 'Daniel Brooks', 940.00, 'Flights & hotel for Harbor Roasters multi-store rollout.', 'Alex Rivera', 'Pending', '', '2026-11-22 09:45', ''),
(3, 'APR-2026-503', 'Budget', 'Q4 Self-Hosted PHP NVMe Cluster Upgrade', 'Jordan Lee', 3200.00, 'Doubles standalone SQLite WAL throughput for enterprise demos.', 'Priya Nair', 'Approved', 'Approved under Q4 infra allocation.', '2026-11-19 11:30', '2026-11-19 14:00');

INSERT OR IGNORE INTO channels (id, slug, name, kind, topic) VALUES
(1, 'general', '#general', 'Public', 'Company announcements, releases & cross-department updates'),
(2, 'sales-ops', '#sales-ops', 'Public', 'Enterprise deals, custom quotes & customer rollouts'),
(3, 'finance-approvals', '#finance-approvals', 'Private', 'Month-end close, bank recon & budget approvals');

INSERT OR IGNORE INTO channel_messages (id, channel_id, author_name, body, pinned, created_at) VALUES
(1, 1, 'Alex Rivera', 'Welcome to Modula Workspace! All 11 React + PHP 8 + XDB SQLite apps are now live in the parent host.', 1, '2026-11-21 09:00'),
(2, 1, 'Priya Nair', 'Reminder: please verify Q4 Security Policy eSignatures before Friday.', 0, '2026-11-22 08:45'),
(3, 2, 'Alex Rivera', 'Apex Manufacturing MSA (SGN-2026-301) is out for signature - ready to kick off Phase 1 once signed.', 0, '2026-11-22 09:30'),
(4, 3, 'Jordan Lee', 'Standalone PHP NVMe upgrade approved (APR-2026-503). Reconciling October bank statements today.', 1, '2026-11-22 10:05');
