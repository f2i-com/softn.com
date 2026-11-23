CREATE TABLE IF NOT EXISTS automations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  trigger_type TEXT NOT NULL DEFAULT 'record_matches',
  trigger_config_json TEXT NOT NULL DEFAULT '{}',
  run_count INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  automation_id INTEGER NOT NULL,
  step_type TEXT NOT NULL,
  label TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS workflow_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'In Progress',
  priority TEXT NOT NULL DEFAULT 'P1',
  owner_name TEXT NOT NULL DEFAULT 'Maya Lin',
  amount REAL NOT NULL DEFAULT 0,
  escalated INTEGER NOT NULL DEFAULT 0,
  ai_note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  automation_id INTEGER NOT NULL,
  automation_name TEXT NOT NULL,
  record_id INTEGER,
  record_title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Succeeded',
  duration_ms INTEGER NOT NULL DEFAULT 12,
  trace_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  automation_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO automations (id, name, description, enabled, trigger_type, trigger_config_json, run_count, last_run_at, created_at) VALUES
  (1, 'Auto-Escalate At-Risk Initiatives', 'When any record enters At Risk status, elevate to P0, mark escalated, and alert #exec-alerts.', 1, 'record_matches', '{"field":"status","op":"equals","value":"At Risk"}', 14, '2026-11-21 09:12:00', '2026-10-10'),
  (2, 'Launch Celebration & Release Webhook', 'When an initiative reaches Launched, fire release webhook and notify Slack #launches.', 1, 'record_matches', '{"field":"status","op":"equals","value":"Launched"}', 9, '2026-11-18 17:06:00', '2026-10-15'),
  (3, 'High-Value Deal AI Triage', 'When deal amount exceeds $75,000, run AI risk brief and email VP Operations.', 1, 'record_matches', '{"field":"amount","op":"gt","value":"75000"}', 6, '2026-11-20 14:22:00', '2026-10-28'),
  (4, 'Inbound Webhook Lead Enricher', 'Created paused for human review: enriches incoming webhook payloads before writing records.', 0, 'webhook_received', '{"endpoint":"/api/hooks/inbound-lead"}', 0, '', '2026-11-19');

INSERT OR IGNORE INTO automation_steps (id, automation_id, step_type, label, config_json, position) VALUES
  (1, 1, 'update_record', 'Escalate Priority to P0 & Flag Record', '{"priority":"P0","escalated":1}', 0),
  (2, 1, 'ai_enrich', 'Generate AI Mitigation Summary', '{"template":"Escalation triggered for {title} ({owner_name}): unblock compliance dependencies immediately."}', 1),
  (3, 1, 'send_slack', 'Post Alert to #exec-alerts', '{"recipient":"#exec-alerts","subject":"At-Risk Escalation: {title}","body":"Initiative {title} owned by {owner_name} (${amount}) moved to At Risk and was auto-elevated to P0."}', 2),
  (4, 2, 'send_webhook', 'Dispatch Release Webhook Payload', '{"recipient":"https://hooks.release.local/shipped","subject":"Shipped: {title}","body":"{\"event\":\"launched\",\"record\":\"{title}\",\"owner\":\"{owner_name}\"}"}', 0),
  (5, 2, 'send_slack', 'Announce in #product-launches', '{"recipient":"#product-launches","subject":"Launched: {title}","body":"{title} is now LIVE! Huge shoutout to {owner_name}."}', 1),
  (6, 3, 'ai_enrich', 'Synthesize Executive Deal Brief', '{"template":"High-value record {title} (${amount}): recommend executive sponsor call with {owner_name}."}', 0),
  (7, 3, 'send_email', 'Email VP Operations Digest', '{"recipient":"vp-ops@basegrid.local","subject":"High-Value Alert: {title}","body":"Record {title} reached ${amount}. Priority: {priority}, Status: {status}."}', 1),
  (8, 4, 'update_record', 'Normalize Lead Priority to P1', '{"priority":"P1"}', 0);

INSERT OR IGNORE INTO workflow_records (id, title, status, priority, owner_name, amount, escalated, ai_note, updated_at) VALUES
  (1, 'Enterprise SCIM & Audit Governance', 'At Risk', 'P1', 'Arjun Mehta', 83000, 0, 'Pending IdP group sync verification.', '2026-11-21'),
  (2, 'Omni AI App Builder & Field Agents', 'In Review', 'P0', 'Devon Brooks', 92000, 0, 'Ready for GA launch sign-off.', '2026-11-20'),
  (3, 'ZIPP WASM Relational Engine 2.0', 'Launched', 'P0', 'Maya Lin', 68000, 0, 'Shipped ahead of target.', '2026-11-18'),
  (4, 'White-Label External Guest Portals', 'In Progress', 'P1', 'Chloe Alvarez', 56000, 0, 'Custom domain branding in progress.', '2026-11-20'),
  (5, 'Helios Robotics Global Expansion', 'In Progress', 'P1', 'Jordan Patel', 145000, 0, 'High-value enterprise deployment.', '2026-11-21');

INSERT OR IGNORE INTO automation_runs (id, automation_id, automation_name, record_id, record_title, status, duration_ms, trace_json, created_at) VALUES
  (1, 2, 'Launch Celebration & Release Webhook', 3, 'ZIPP WASM Relational Engine 2.0', 'Succeeded', 14, '[{"step":"Dispatch Release Webhook Payload","type":"send_webhook","outcome":"200 OK queued"},{"step":"Announce in #product-launches","type":"send_slack","outcome":"Delivered to #product-launches"}]', '2026-11-18 17:06:00');

INSERT OR IGNORE INTO notification_outbox (id, channel, recipient, subject, body, automation_name, created_at) VALUES
  (1, 'Slack', '#product-launches', 'Launched: ZIPP WASM Relational Engine 2.0', 'ZIPP WASM Relational Engine 2.0 is now LIVE! Huge shoutout to Maya Lin.', 'Launch Celebration & Release Webhook', '2026-11-18 17:06:00');
