CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  external_ref_id TEXT NOT NULL DEFAULT '9007199254740993',
  unit_price TEXT NOT NULL DEFAULT '0.00',
  quantity INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO items (id, sku, title, external_ref_id, unit_price, quantity, status) VALUES
  (1, 'INV-1001', 'Precision Torque Sensor', '9007199254740993', '12450.7500', 12, 'active'),
  (2, 'INV-1002', 'Hydraulic Control Valve', '9223372036854775807', '890.5000', 4, 'active');
