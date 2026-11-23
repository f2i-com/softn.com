CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  meta_desc TEXT NOT NULL DEFAULT '',
  headline TEXT NOT NULL,
  subheadline TEXT NOT NULL,
  cta_label TEXT NOT NULL DEFAULT 'Get Started',
  accent_color TEXT NOT NULL DEFAULT '#ea580c',
  blocks_json TEXT NOT NULL DEFAULT '[]',
  published INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS store_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sku TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL DEFAULT 'Hardware',
  price REAL NOT NULL,
  stock INTEGER NOT NULL DEFAULT 10,
  summary TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS store_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT NOT NULL UNIQUE,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  items_summary TEXT NOT NULL,
  promo_code TEXT NOT NULL DEFAULT '',
  discount_amount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'Confirmed',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS blog_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT 'Modula Team',
  tag TEXT NOT NULL DEFAULT 'Product',
  excerpt TEXT NOT NULL,
  body TEXT NOT NULL,
  published INTEGER NOT NULL DEFAULT 1,
  published_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'All Leads & Customers',
  body TEXT NOT NULL,
  recipients INTEGER NOT NULL DEFAULT 0,
  open_rate REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Draft',
  sent_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  source_page TEXT NOT NULL DEFAULT '/',
  status TEXT NOT NULL DEFAULT 'New',
  created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO pages (id, slug, title, meta_desc, headline, subheadline, cta_label, accent_color, blocks_json, published, updated_at) VALUES
  (1, '/', 'Homepage', 'Open Odoo alternative powered by portable SoftN React + PHP + XDB SQLite containers.', 'Run every department from portable SoftN apps.', 'Zero per-user SaaS lock-in. Launch locally in ZIPP WASM or host on your own PHP server in seconds.', 'Launch Workspace', '#ea580c', '[{"kind":"features","heading":"Why Teams Switch from Odoo","body":"Zero per-seat tax, 1-click SQLite export, and standalone PHP hosting with zero code changes."},{"kind":"testimonial","heading":"Harbour Logistics Pty","body":"We cut our 3-year ERP spend by 74% and run offline-ready warehouse containers across 4 depots."}]', 1, '2026-11-19'),
  (2, '/hardware', 'POS & Retail Hardware', 'Offline-first POS hardware kits built for Modula stores.', 'Offline-first hardware kits built for modern stores.', 'Pre-configured thermal printers, 2D scanners, and LTE failover routers tested with Modula POS.', 'Shop Kits', '#0d9488', '[{"kind":"features","heading":"Plug & Print Ready","body":"Works out of the box with CounterFlow Retail and PassMaster Hospitality containers."}]', 1, '2026-11-18'),
  (3, '/enterprise', 'Enterprise Self-Hosting', 'Deploy Modula PHP 8 + WAL SQLite containers on your private VPC.', 'Own your PHP backend and SQLite databases forever.', 'Deploy inside your parent portal or VPC with audited SQLite exports and full source ownership.', 'Book Architecture Review', '#5b21b6', '[{"kind":"faq","heading":"Do we need to rewrite PHP code when moving off ZIPP WASM?","body":"No - the exact same PHP 8 + PDO SQLite codebase runs locally in zipp-php.wasm and standalone on native PHP."}]', 1, '2026-11-20');

INSERT OR IGNORE INTO store_products (id, name, sku, category, price, stock, summary) VALUES
  (1, 'Retail POS Starter Bundle', 'KIT-POS-01', 'Bundles', 429.00, 14, 'Receipt printer, 2D wireless scanner, and counter tablet stand.'),
  (2, 'Warehouse Barcode Kit', 'KIT-WH-02', 'Warehouse', 289.00, 9, 'Rugged 2D scanner plus 1,000 bin location QR labels.'),
  (3, 'Edge Offline Failover Box', 'KIT-NET-03', 'Infrastructure', 349.00, 11, 'Pre-flashed LTE router with local SQLite sync relay.'),
  (4, 'Self-Hosted Enterprise Support (Annual)', 'SVC-ENT-12', 'Services', 1490.00, 99, 'Priority architecture guidance and custom PHP container hooks.');

INSERT OR IGNORE INTO store_orders (id, order_number, customer_name, customer_email, items_summary, promo_code, discount_amount, total, status, created_at) VALUES
  (1, 'WEB-2026-301', 'Marcus Vance', 'mvance@northstar.example', '2 x Retail POS Starter Bundle', '', 0, 858.00, 'Confirmed', '2026-11-17 14:22'),
  (2, 'WEB-2026-302', 'Claire Bennett', 'claire@harbourlogistics.example', '1 x Warehouse Barcode Kit', 'MODULA10', 28.90, 260.10, 'Fulfilled', '2026-11-19 10:05');

INSERT OR IGNORE INTO blog_posts (id, slug, title, author, tag, excerpt, body, published, published_at) VALUES
  (1, 'why-portable-erp-containers', 'Why Portable SoftN Containers Beat Monolithic SaaS ERPs', 'Alex Rivera', 'Architecture', 'How running React + PHP 8 + XDB SQLite inside isolated workers eliminates vendor lock-in.', 'Traditional ERPs force every department into one tightly coupled server and charge per user the moment you add a second module. With SoftN v2 containers, each business app is a self-contained ~60 KB archive that boots in your browser locally or scales onto standalone PHP.', 1, '2026-11-18'),
  (2, 'offline-first-retail-pos', 'Zero-Downtime Retail POS with XDB SQLite WASM', 'Jordan Patel', 'Engineering', 'Keep selling when store internet drops - then sync or export SQLite cleanly.', 'Every Modula app persists its XDB SQLite 3 database right inside browser IndexedDB when running locally, and switches seamlessly to WAL SQLite on your server when connected.', 1, '2026-11-15');

INSERT OR IGNORE INTO campaigns (id, name, subject, audience, body, recipients, open_rate, status, sent_at) VALUES
  (1, 'Q4 Odoo Switcher Guide', 'Cut your 2027 ERP licensing bill to $0/seat', 'All Leads & Customers', 'Discover how 7 portable SoftN containers replace CRM, Accounting, Inventory, MRP, Projects, HR, and Helpdesk.', 4, 62.5, 'Sent', '2026-11-16 09:00'),
  (2, 'POS Hardware Holiday Promo', 'Save 10% on POS Starter Kits with code MODULA10', 'Store Customers', 'Use promo code MODULA10 at checkout for 10% off retail & warehouse hardware bundles.', 0, 0, 'Draft', '');

INSERT OR IGNORE INTO leads (id, name, email, company, message, source_page, status, created_at) VALUES
  (1, 'Hannah Cho', 'hcho@solsticehealth.example', 'Solstice Health Clinics', 'Interested in replacing our 35-seat Odoo Enterprise subscription with embedded SoftN apps.', '/enterprise', 'New', '2026-11-18 11:30'),
  (2, 'Owen Gallagher', 'owen@tasmancivil.example', 'Tasman Civil Services', 'Can we host the Inventory and Projects PHP backends on our existing Linux VM?', '/', 'Qualified', '2026-11-20 08:50');
