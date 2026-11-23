-- Modula Field Service, Appointments & Shift Planning Schema (XDB SQLite 3)

CREATE TABLE IF NOT EXISTS technicians (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    specialty TEXT NOT NULL DEFAULT 'General Field Tech',
    phone TEXT DEFAULT '',
    territory TEXT DEFAULT 'Metro North',
    hourly_rate REAL NOT NULL DEFAULT 125.0,
    active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS work_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wo_number TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    site_address TEXT DEFAULT '',
    technician_id INTEGER NOT NULL,
    technician_name TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'Normal',
    stage TEXT NOT NULL DEFAULT 'Scheduled',
    scheduled_date TEXT NOT NULL,
    est_hours REAL NOT NULL DEFAULT 2.0,
    actual_hours REAL NOT NULL DEFAULT 0.0,
    parts_json TEXT NOT NULL DEFAULT '[]',
    labor_total REAL NOT NULL DEFAULT 0.0,
    parts_total REAL NOT NULL DEFAULT 0.0,
    customer_signed_by TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref_code TEXT NOT NULL UNIQUE,
    service_type TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    customer_email TEXT DEFAULT '',
    customer_phone TEXT DEFAULT '',
    technician_name TEXT NOT NULL,
    appt_date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    duration_min INTEGER NOT NULL DEFAULT 45,
    status TEXT NOT NULL DEFAULT 'Confirmed',
    notes TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    technician_id INTEGER NOT NULL,
    technician_name TEXT NOT NULL,
    shift_date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    role_label TEXT NOT NULL DEFAULT 'Field Dispatch',
    location TEXT DEFAULT 'Metro HQ',
    hours REAL NOT NULL DEFAULT 8.0,
    published INTEGER NOT NULL DEFAULT 1
);

INSERT OR IGNORE INTO technicians (id, name, specialty, phone, territory, hourly_rate, active) VALUES
(1, 'Samira Patel', 'HVAC & IoT Sensors', '+1 555-0141', 'Metro North', 135.00, 1),
(2, 'Daniel Brooks', 'POS & Network Hardware', '+1 555-0142', 'CBD & Harbor', 120.00, 1),
(3, 'Kieran Walsh', 'Commercial Electrical', '+1 555-0143', 'West Industrial', 145.00, 1),
(4, 'Chloe Park', 'Preventive Maintenance', '+1 555-0144', 'South Corridor', 115.00, 1);

INSERT OR IGNORE INTO work_orders (id, wo_number, title, customer_name, site_address, technician_id, technician_name, priority, stage, scheduled_date, est_hours, actual_hours, parts_json, labor_total, parts_total, customer_signed_by, notes, created_at) VALUES
(1, 'WO-2026-401', 'Install 3x Touch POS Terminals + Kitchen KDS', 'Harbor Roasters Flagship', '114 Pier Ave, Suite 2', 2, 'Daniel Brooks', 'High', 'In Progress', '2026-11-22', 3.5, 2.0, '[{"name":"Cat6 Patch Cable 5m","qty":4,"unitPrice":14}]', 240.00, 56.00, '', 'Router VLAN 20 configured; mounting KDS bracket next.', '2026-11-20 09:00'),
(2, 'WO-2026-402', 'Quarterly Cold-Room Sensor Calibration', 'Apex Fresh Foods', '88 Logistics Pkwy', 1, 'Samira Patel', 'Urgent', 'En Route', '2026-11-22', 2.0, 0.0, '[]', 0.00, 0.00, '', 'Bring NIST reference probe & spare LoRa gateway.', '2026-11-21 11:30'),
(3, 'WO-2026-403', 'Warehouse LED High-Bay Ballast Replacement', 'Pacific Timber Co.', '412 Foundry Rd', 3, 'Kieran Walsh', 'Normal', 'Scheduled', '2026-11-23', 4.0, 0.0, '[{"name":"LED Driver 200W","qty":2,"unitPrice":85}]', 0.00, 170.00, '', 'Scissor lift confirmed on site.', '2026-11-21 15:10'),
(4, 'WO-2026-404', 'Preventive UPS Battery Swap & Load Test', 'Vanguard Health Clinic', '29 Wellness Blvd', 4, 'Chloe Park', 'High', 'Completed', '2026-11-21', 2.5, 2.5, '[{"name":"12V 9Ah AGM Battery","qty":4,"unitPrice":42}]', 287.50, 168.00, 'Dr. Hannah Cho', 'Load test passed at 98% health; old cells recycled.', '2026-11-19 10:00');

INSERT OR IGNORE INTO appointments (id, ref_code, service_type, customer_name, customer_email, customer_phone, technician_name, appt_date, start_time, duration_min, status, notes) VALUES
(1, 'APT-8801', 'Site Network Survey', 'Solstice Bakery Group', 'ops@solsticebakery.example', '+1 555-0191', 'Daniel Brooks', '2026-11-22', '14:00', 60, 'Confirmed', '3 retail counters + patio Wi-Fi coverage check'),
(2, 'APT-8802', 'HVAC Maintenance Consultation', 'Northstar Logistics', 'facilities@northstar.example', '+1 555-0192', 'Samira Patel', '2026-11-23', '10:30', 45, 'Confirmed', 'Review seasonal maintenance SLA'),
(3, 'APT-8803', 'Emergency Panel Inspection', 'Bayside Marine', 'dock@bayside.example', '+1 555-0193', 'Kieran Walsh', '2026-11-22', '09:30', 60, 'Checked In', 'Breaker #4 intermittent trip');

INSERT OR IGNORE INTO shifts (id, technician_id, technician_name, shift_date, start_time, end_time, role_label, location, hours, published) VALUES
(1, 1, 'Samira Patel', '2026-11-22', '08:00', '16:30', 'HVAC Field Dispatch', 'Metro North', 8.0, 1),
(2, 2, 'Daniel Brooks', '2026-11-22', '08:30', '17:00', 'POS Rollout Crew', 'CBD & Harbor', 8.0, 1),
(3, 3, 'Kieran Walsh', '2026-11-23', '07:30', '16:00', 'Electrical On-Call', 'West Industrial', 8.0, 1),
(4, 4, 'Chloe Park', '2026-11-23', '09:00', '17:00', 'Preventive Maintenance', 'South Corridor', 8.0, 0),
(5, 1, 'Samira Patel', '2026-11-24', '08:00', '16:30', 'HVAC Field Dispatch', 'Metro North', 8.0, 1),
(6, 2, 'Daniel Brooks', '2026-11-24', '08:30', '17:00', 'Site Surveys', 'CBD & Harbor', 8.0, 0);
