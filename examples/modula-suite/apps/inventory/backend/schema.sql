CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  lead_days INTEGER NOT NULL DEFAULT 5,
  terms TEXT NOT NULL DEFAULT 'Net 30'
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Hardware',
  bin_location TEXT NOT NULL DEFAULT 'WH/A1',
  vendor_id INTEGER,
  vendor_name TEXT NOT NULL DEFAULT '',
  unit_cost REAL NOT NULL DEFAULT 0,
  sale_price REAL NOT NULL DEFAULT 0,
  stock_on_hand INTEGER NOT NULL DEFAULT 0,
  reorder_point INTEGER NOT NULL DEFAULT 10
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_number TEXT NOT NULL UNIQUE,
  vendor_name TEXT NOT NULL,
  product_id INTEGER NOT NULL,
  product_sku TEXT NOT NULL,
  product_name TEXT NOT NULL,
  qty INTEGER NOT NULL,
  unit_cost REAL NOT NULL,
  total REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'RFQ',
  expected_date TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS boms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  finished_product_id INTEGER NOT NULL,
  finished_sku TEXT NOT NULL,
  finished_name TEXT NOT NULL,
  work_center TEXT NOT NULL DEFAULT 'Assembly Bench 1',
  components_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS manufacturing_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mo_number TEXT NOT NULL UNIQUE,
  bom_id INTEGER NOT NULL,
  finished_sku TEXT NOT NULL,
  finished_name TEXT NOT NULL,
  qty_to_produce INTEGER NOT NULL DEFAULT 1,
  work_center TEXT NOT NULL DEFAULT 'Assembly Bench 1',
  status TEXT NOT NULL DEFAULT 'Planned',
  scheduled_date TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT NOT NULL,
  product_sku TEXT NOT NULL,
  product_name TEXT NOT NULL,
  source_loc TEXT NOT NULL,
  dest_loc TEXT NOT NULL,
  qty INTEGER NOT NULL,
  move_type TEXT NOT NULL,
  moved_at TEXT NOT NULL
);

INSERT OR IGNORE INTO vendors (id, name, contact, email, lead_days, terms) VALUES
  (1, 'Apex Hardware Imports', 'Devon Brooks', 'orders@apexhardware.example', 4, 'Net 30'),
  (2, 'Southern Packaging Co', 'Tessa Lin', 'sales@southernpack.example', 2, 'Net 14'),
  (3, 'Kestrel Electronics', 'Raj Mehta', 'supply@kestrelelec.example', 7, 'Net 45');

INSERT OR IGNORE INTO products (id, sku, name, category, bin_location, vendor_id, vendor_name, unit_cost, sale_price, stock_on_hand, reorder_point) VALUES
  (1, 'HW-POS-100', 'USB-C Thermal Receipt Printer', 'POS Hardware', 'WH/A1-02', 1, 'Apex Hardware Imports', 112.00, 219.00, 28, 10),
  (2, 'HW-SCN-204', '2D Wireless Barcode Scanner', 'POS Hardware', 'WH/A1-04', 1, 'Apex Hardware Imports', 64.00, 139.00, 6, 12),
  (3, 'HW-TAB-310', 'Industrial Counter Stand 11"', 'Accessories', 'WH/B2-01', 3, 'Kestrel Electronics', 48.00, 109.00, 19, 8),
  (4, 'PK-ROL-080', 'Thermal Paper Rolls 80mm (Box 24)', 'Consumables', 'WH/C1-09', 2, 'Southern Packaging Co', 18.50, 42.00, 5, 15),
  (5, 'NT-RTR-500', 'Edge Failover LTE Router', 'Networking', 'WH/B1-03', 3, 'Kestrel Electronics', 185.00, 349.00, 14, 6),
  (6, 'KIT-POS-PRO', 'Complete Retail POS Kit (Assembled)', 'Finished Kits', 'WH/FG-01', 1, 'In-House MRP', 224.00, 449.00, 4, 5);

INSERT OR IGNORE INTO purchase_orders (id, po_number, vendor_name, product_id, product_sku, product_name, qty, unit_cost, total, status, expected_date, created_at) VALUES
  (1, 'PO-2026-081', 'Apex Hardware Imports', 2, 'HW-SCN-204', '2D Wireless Barcode Scanner', 20, 64.00, 1280.00, 'Confirmed', '2026-11-26', '2026-11-18'),
  (2, 'PO-2026-082', 'Southern Packaging Co', 4, 'PK-ROL-080', 'Thermal Paper Rolls 80mm (Box 24)', 30, 18.50, 555.00, 'RFQ', '2026-11-25', '2026-11-20');

INSERT OR IGNORE INTO boms (id, code, finished_product_id, finished_sku, finished_name, work_center, components_json) VALUES
  (1, 'BOM-POS-KIT', 6, 'KIT-POS-PRO', 'Complete Retail POS Kit (Assembled)', 'Assembly Bench 1', '[{"product_id":1,"sku":"HW-POS-100","name":"USB-C Thermal Receipt Printer","qty":1},{"product_id":2,"sku":"HW-SCN-204","name":"2D Wireless Barcode Scanner","qty":1},{"product_id":3,"sku":"HW-TAB-310","name":"Industrial Counter Stand 11\"","qty":1}]');

INSERT OR IGNORE INTO manufacturing_orders (id, mo_number, bom_id, finished_sku, finished_name, qty_to_produce, work_center, status, scheduled_date, created_at) VALUES
  (1, 'MO-2026-011', 1, 'KIT-POS-PRO', 'Complete Retail POS Kit (Assembled)', 3, 'Assembly Bench 1', 'Planned', '2026-11-24', '2026-11-20');

INSERT OR IGNORE INTO stock_moves (id, reference, product_sku, product_name, source_loc, dest_loc, qty, move_type, moved_at) VALUES
  (1, 'WH/IN/00104', 'HW-POS-100', 'USB-C Thermal Receipt Printer', 'Vendors/Apex', 'WH/A1-02', 30, 'Receipt', '2026-11-10 09:20'),
  (2, 'WH/OUT/00088', 'HW-POS-100', 'USB-C Thermal Receipt Printer', 'WH/A1-02', 'Customers/Northstar', 2, 'Delivery', '2026-11-14 15:40'),
  (3, 'WH/OUT/00091', 'HW-SCN-204', '2D Wireless Barcode Scanner', 'WH/A1-04', 'Customers/Brightleaf', 8, 'Delivery', '2026-11-16 11:05');
