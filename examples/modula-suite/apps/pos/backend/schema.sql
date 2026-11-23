-- Modula Point of Sale & Equipment Rental Schema (XDB SQLite 3)

CREATE TABLE IF NOT EXISTS pos_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    register_name TEXT NOT NULL,
    cashier_name TEXT NOT NULL,
    opened_at TEXT NOT NULL,
    closed_at TEXT DEFAULT '',
    opening_float REAL DEFAULT 200,
    cash_sales REAL DEFAULT 0,
    card_sales REAL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'Open',
    notes TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS pos_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'Retail',
    price REAL NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0,
    stock_qty INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS pos_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number TEXT NOT NULL UNIQUE,
    session_id INTEGER NOT NULL,
    customer_name TEXT DEFAULT 'Walk-in Customer',
    order_type TEXT NOT NULL DEFAULT 'Counter',
    table_label TEXT DEFAULT '',
    items_json TEXT NOT NULL DEFAULT '[]',
    subtotal REAL NOT NULL DEFAULT 0,
    discount_pct REAL NOT NULL DEFAULT 0,
    tax_amount REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    payment_method TEXT NOT NULL DEFAULT 'Card',
    amount_tendered REAL NOT NULL DEFAULT 0,
    change_due REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'Paid',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rental_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'POS & Audio',
    daily_rate REAL NOT NULL DEFAULT 0,
    deposit_amount REAL NOT NULL DEFAULT 0,
    total_qty INTEGER NOT NULL DEFAULT 1,
    available_qty INTEGER NOT NULL DEFAULT 1,
    condition_note TEXT DEFAULT 'Excellent'
);

CREATE TABLE IF NOT EXISTS rental_bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_number TEXT NOT NULL UNIQUE,
    asset_id INTEGER NOT NULL,
    asset_name TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    qty INTEGER NOT NULL DEFAULT 1,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    daily_rate REAL NOT NULL DEFAULT 0,
    deposit_amount REAL NOT NULL DEFAULT 0,
    total_amount REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'Reserved',
    created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO pos_sessions (id, register_name, cashier_name, opened_at, closed_at, opening_float, cash_sales, card_sales, status, notes) VALUES
(1, 'Main Counter #1', 'Maya Lin', '2026-11-21 08:30', '2026-11-21 17:45', 250.00, 412.50, 1288.00, 'Closed', 'Balanced to the cent'),
(2, 'Main Counter #1', 'Maya Lin', '2026-11-22 08:30', '', 250.00, 165.00, 605.00, 'Open', 'Morning retail & cafe shift');

INSERT OR IGNORE INTO pos_items (id, sku, name, category, price, cost, stock_qty, active) VALUES
(1, 'POS-TERM-10', 'Touch POS Terminal 15"', 'Hardware', 349.00, 195.00, 14, 1),
(2, 'POS-SCAN-02', 'Bluetooth Barcode Scanner', 'Hardware', 89.00, 42.00, 26, 1),
(3, 'POS-PRN-80', '80mm Thermal Receipt Printer', 'Hardware', 129.00, 68.00, 18, 1),
(4, 'ACC-ROLL-10', 'Thermal Paper Rolls (10-Pack)', 'Accessories', 24.00, 9.50, 62, 1),
(5, 'ACC-STAND-1', 'Swivel Tablet Counter Stand', 'Accessories', 55.00, 22.00, 31, 1),
(6, 'CAFE-FLAT', 'Specialty Flat White', 'Cafe & Dining', 5.50, 1.40, 120, 1),
(7, 'CAFE-BRIO', 'Artisan Almond Croissant', 'Cafe & Dining', 7.50, 2.20, 40, 1),
(8, 'CAFE-BOWL', 'Roast Pumpkin Harvest Bowl', 'Cafe & Dining', 18.50, 6.20, 32, 1);

INSERT OR IGNORE INTO pos_orders (id, order_number, session_id, customer_name, order_type, table_label, items_json, subtotal, discount_pct, tax_amount, total, payment_method, amount_tendered, change_due, status, created_at) VALUES
(1, 'POS-2026-1001', 2, 'Harbor Roasters', 'Counter', '', '[{"itemId":1,"name":"Touch POS Terminal 15\"","qty":1,"price":349},{"itemId":3,"name":"80mm Thermal Receipt Printer","qty":1,"price":129},{"itemId":4,"name":"Thermal Paper Rolls (10-Pack)","qty":3,"price":24}]', 550.00, 0, 55.00, 605.00, 'Card', 605.00, 0, 'Paid', '2026-11-22 09:14'),
(2, 'POS-2026-1002', 2, 'Table 4 Walk-in', 'Dine-In', 'Table 4', '[{"itemId":6,"name":"Specialty Flat White","qty":4,"price":5.5},{"itemId":7,"name":"Artisan Almond Croissant","qty":4,"price":7.5},{"itemId":8,"name":"Roast Pumpkin Harvest Bowl","qty":2,"price":18.5}]', 89.00, 0, 8.90, 97.90, 'Cash', 100.00, 2.10, 'Paid', '2026-11-22 10:22'),
(3, 'POS-2026-1003', 2, 'Walk-in Customer', 'Takeaway', '', '[{"itemId":5,"name":"Swivel Tablet Counter Stand","qty":1,"price":55},{"itemId":6,"name":"Specialty Flat White","qty":1,"price":5.5}]', 60.50, 0, 6.05, 66.55, 'Cash', 70.00, 3.45, 'Paid', '2026-11-22 11:05');

INSERT OR IGNORE INTO rental_assets (id, asset_code, name, category, daily_rate, deposit_amount, total_qty, available_qty, condition_note) VALUES
(1, 'RNT-KIOSK-01', 'Pop-Up Event POS Kit (Terminal + Printer + LTE)', 'Event Tech', 85.00, 250.00, 6, 4, 'Ready - Fresh batteries'),
(2, 'RNT-AUDIO-02', 'Conference PA & Wireless Mic Bundle', 'Audio Visual', 140.00, 400.00, 4, 3, 'Tested Nov 2026'),
(3, 'RNT-SCAN-03', 'Warehouse Stocktake Handheld Fleet (5x)', 'Inventory Gear', 95.00, 300.00, 5, 5, 'Calibrated & charged'),
(4, 'RNT-PROJ-04', '4K Laser Projector + 120" Fast-Fold Screen', 'Audio Visual', 165.00, 500.00, 3, 2, 'Lamp hours < 200');

INSERT OR IGNORE INTO rental_bookings (id, booking_number, asset_id, asset_name, customer_name, qty, start_date, end_date, daily_rate, deposit_amount, total_amount, status, created_at) VALUES
(1, 'RNT-2026-201', 1, 'Pop-Up Event POS Kit (Terminal + Printer + LTE)', 'Coastal Markets Co.', 2, '2026-11-21', '2026-11-24', 85.00, 500.00, 510.00, 'Picked Up', '2026-11-20 14:15'),
(2, 'RNT-2026-202', 2, 'Conference PA & Wireless Mic Bundle', 'Northstar Summit', 1, '2026-11-22', '2026-11-25', 140.00, 400.00, 420.00, 'Picked Up', '2026-11-21 09:40'),
(3, 'RNT-2026-203', 4, '4K Laser Projector + 120" Fast-Fold Screen', 'Vanguard Health', 1, '2026-11-28', '2026-11-30', 165.00, 500.00, 330.00, 'Reserved', '2026-11-21 16:05');
