CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  item_type TEXT NOT NULL DEFAULT 'Inventory',
  location TEXT NOT NULL DEFAULT 'Sydney HQ',
  buy_price REAL NOT NULL DEFAULT 0,
  retail_price REAL NOT NULL DEFAULT 0,
  trade_price REAL NOT NULL DEFAULT 0,
  wholesale_price REAL NOT NULL DEFAULT 0,
  tax_code TEXT NOT NULL DEFAULT 'GST',
  qty_on_hand INTEGER NOT NULL DEFAULT 0,
  qty_committed INTEGER NOT NULL DEFAULT 0,
  reorder_level INTEGER NOT NULL DEFAULT 5
);

CREATE TABLE IF NOT EXISTS stock_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  sku TEXT NOT NULL,
  item_name TEXT NOT NULL,
  adj_date TEXT NOT NULL,
  reason TEXT NOT NULL,
  location TEXT NOT NULL,
  qty_delta INTEGER NOT NULL,
  unit_cost REAL NOT NULL DEFAULT 0,
  memo TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_code TEXT NOT NULL UNIQUE,
  parent_code TEXT NOT NULL DEFAULT '',
  job_name TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Active',
  budget_income REAL NOT NULL DEFAULT 0,
  actual_income REAL NOT NULL DEFAULT 0,
  budget_cost REAL NOT NULL DEFAULT 0,
  actual_cost REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS time_slips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slip_date TEXT NOT NULL,
  staff_name TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  job_code TEXT NOT NULL,
  activity TEXT NOT NULL,
  hours REAL NOT NULL,
  hourly_rate REAL NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'Unbilled'
);

INSERT OR IGNORE INTO items
  (id, sku, name, item_type, location, buy_price, retail_price, trade_price, wholesale_price, tax_code, qty_on_hand, qty_committed, reorder_level)
VALUES
  (1, 'HW-SCAN-2D', 'Rugged 2D Bluetooth Barcode Scanner', 'Inventory', 'Sydney HQ', 380.00, 925.00, 790.00, 680.00, 'GST', 24, 8, 10),
  (2, 'HW-PRNT-80', '80mm Thermal POS Receipt Printer', 'Inventory', 'Sydney HQ', 300.00, 740.00, 640.00, 560.00, 'GST', 14, 4, 8),
  (3, 'HW-CRADLE-USB', 'Smart Charging & Sync Dock', 'Inventory', 'Melbourne Hub', 95.00, 240.00, 205.00, 175.00, 'GST', 4, 2, 10),
  (4, 'HW-TERM-EFT', 'Countertop EFTPOS Tap Stand (AU)', 'Inventory', 'Brisbane Depot', 140.00, 345.00, 295.00, 260.00, 'GST', 19, 0, 6),
  (5, 'HW-LBL-500', 'Thermal Label Roll Pack (12 Rolls)', 'Inventory', 'Sydney HQ', 42.00, 115.00, 95.00, 82.00, 'GST', 3, 2, 12),
  (6, 'SRV-IMPL-HR', 'Senior Implementation & Data Migration', 'Service', 'Sydney HQ', 0.00, 220.00, 195.00, 180.00, 'GST', 0, 0, 0);

INSERT OR IGNORE INTO stock_adjustments (id, item_id, sku, item_name, adj_date, reason, location, qty_delta, unit_cost, memo) VALUES
  (1, 1, 'HW-SCAN-2D', 'Rugged 2D Bluetooth Barcode Scanner', '2026-11-12', 'Supplier Receipt', 'Sydney HQ', 15, 380.00, 'Received from Apex POS Hardware'),
  (2, 3, 'HW-CRADLE-USB', 'Smart Charging & Sync Dock', '2026-11-18', 'Stocktake Count', 'Melbourne Hub', -2, 95.00, 'November cycle count variance');

INSERT OR IGNORE INTO jobs (id, job_code, parent_code, job_name, customer_name, status, budget_income, actual_income, budget_cost, actual_cost) VALUES
  (1, 'JOB-101', '', 'Marine Telemetry Rollout (Brisbane)', 'Bayside Marine Engineering Pty Ltd', 'Active', 32000.00, 20350.00, 14500.00, 9820.00),
  (2, 'JOB-101A', 'JOB-101', 'Stage 2 Dockside Hardware Install', 'Bayside Marine Engineering Pty Ltd', 'Active', 12000.00, 8400.00, 5200.00, 3910.00),
  (3, 'JOB-102', '', 'Multi-Clinic Payroll & STP Migration', 'Melbourne Dental Collective', 'Active', 14000.00, 9845.00, 6400.00, 4210.00),
  (4, 'JOB-103', '', 'Cellar Door POS & Inventory Fitout', 'Barossa Estate Vineyards Pty Ltd', 'Quoted', 27060.00, 0.00, 12800.00, 1240.00),
  (5, 'JOB-104', '', 'Roastery Commerce Launch', 'Southern Cross Coffee Roasters Pty Ltd', 'Completed', 15620.00, 15620.00, 6900.00, 6120.00);

INSERT OR IGNORE INTO time_slips (id, slip_date, staff_name, customer_name, job_code, activity, hours, hourly_rate, amount, status) VALUES
  (1, '2026-11-20', 'Liam O''Connor', 'Bayside Marine Engineering Pty Ltd', 'JOB-101', 'Telemetry API Architecture & Testing', 6.5, 240.00, 1560.00, 'Unbilled'),
  (2, '2026-11-19', 'Chloe Nguyen', 'Melbourne Dental Collective', 'JOB-102', 'STP Phase 2 Payroll Mapping & Audit', 5.0, 210.00, 1050.00, 'Unbilled'),
  (3, '2026-11-18', 'Priya Sharma', 'Barossa Estate Vineyards Pty Ltd', 'JOB-103', 'Cellar Door Checkout UX Prototype', 4.5, 195.00, 877.50, 'Unbilled'),
  (4, '2026-11-11', 'Jack Henderson', 'Southern Cross Coffee Roasters Pty Ltd', 'JOB-104', 'On-site Staff Training & Go-Live', 8.0, 180.00, 1440.00, 'Billed');
