CREATE TABLE IF NOT EXISTS intray_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'Email Forward',
  supplier_name TEXT NOT NULL,
  supplier_abn TEXT NOT NULL DEFAULT '',
  supplier_inv_no TEXT NOT NULL DEFAULT '',
  doc_date TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '6-1400 Office Supplies',
  tax_code TEXT NOT NULL DEFAULT 'GST',
  subtotal REAL NOT NULL DEFAULT 0,
  gst_amount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  ocr_confidence INTEGER NOT NULL DEFAULT 97,
  status TEXT NOT NULL DEFAULT 'Ready',
  linked_bill_number TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS purchase_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_type TEXT NOT NULL DEFAULT 'bill',
  doc_number TEXT NOT NULL UNIQUE,
  supplier_name TEXT NOT NULL,
  supplier_abn TEXT NOT NULL DEFAULT '',
  supplier_inv_no TEXT NOT NULL DEFAULT '',
  issue_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Open',
  category TEXT NOT NULL DEFAULT '6-1200 Cloud & Software',
  subtotal REAL NOT NULL DEFAULT 0,
  gst_amount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  paid_amount REAL NOT NULL DEFAULT 0,
  attachment_name TEXT NOT NULL DEFAULT '',
  lines_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS supplier_debits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  debit_number TEXT NOT NULL UNIQUE,
  supplier_name TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  subtotal REAL NOT NULL DEFAULT 0,
  gst_amount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Open',
  applied_bill_number TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS expense_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_name TEXT NOT NULL,
  merchant TEXT NOT NULL,
  category TEXT NOT NULL,
  expense_date TEXT NOT NULL,
  tax_code TEXT NOT NULL DEFAULT 'GST',
  amount REAL NOT NULL,
  gst_amount REAL NOT NULL DEFAULT 0,
  billable_customer TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Submitted'
);

INSERT OR IGNORE INTO intray_docs
  (id, file_name, source, supplier_name, supplier_abn, supplier_inv_no, doc_date, category, tax_code, subtotal, gst_amount, total, ocr_confidence, status, linked_bill_number)
VALUES
  (1, 'bunnings-trade-INV88214.pdf', 'Supplier Feed (Bunnings)', 'Bunnings Trade Pty Ltd', '26 008 672 179', 'BT-88214', '2026-11-20', '6-2100 Repairs & Fitout', 'GST', 840.00, 84.00, 924.00, 99, 'Ready', ''),
  (2, 'officeworks-receipt-OW4410.jpg', 'Mobile Capture (OCR)', 'Officeworks Ltd', '36 004 763 526', 'OW-44109', '2026-11-19', '6-1400 Office Supplies', 'GST', 318.18, 31.82, 350.00, 96, 'Ready', ''),
  (3, 'telstra-business-nov2026.pdf', 'Email Forward', 'Telstra Business Australia', '33 051 775 556', 'TEL-901822', '2026-11-18', '6-1600 Telephone & Internet', 'GST', 445.45, 44.55, 490.00, 98, 'Ready', ''),
  (4, 'jb-hifi-commercial-macbook.pdf', 'Upload Drag & Drop', 'JB Hi-Fi Business', '80 093 220 136', 'JBC-55192', '2026-11-15', '1-3200 Computer Equipment', 'CAP', 3200.00, 320.00, 3520.00, 97, 'Linked', 'BILL-000211');

INSERT OR IGNORE INTO purchase_docs
  (id, doc_type, doc_number, supplier_name, supplier_abn, supplier_inv_no, issue_date, due_date, status, category, subtotal, gst_amount, total, paid_amount, attachment_name, lines_json)
VALUES
  (1, 'bill', 'BILL-000210', 'Amazon Web Services Australia', '36 605 345 895', 'AWS-AU-90841', '2026-11-02', '2026-11-16', 'Paid', '6-1200 Cloud & Software', 2800.00, 280.00, 3080.00, 3080.00, 'aws-nov-2026.pdf', '[{"description":"ap-southeast-2 Sydney Production Cluster","qty":1,"unitPrice":2800,"taxCode":"GST"}]'),
  (2, 'bill', 'BILL-000211', 'JB Hi-Fi Business', '80 093 220 136', 'JBC-55192', '2026-11-15', '2026-11-29', 'Open', '1-3200 Computer Equipment', 3200.00, 320.00, 3520.00, 0.00, 'jb-hifi-commercial-macbook.pdf', '[{"description":"MacBook Pro M4 14-inch (Capital Asset)","qty":1,"unitPrice":3200,"taxCode":"CAP"}]'),
  (3, 'bill', 'BILL-000212', 'Sydney CBD Commercial Property Trust', '41 088 120 443', 'RENT-NOV26', '2026-11-01', '2026-11-10', 'Overdue', '6-1800 Rent & Outgoings', 5800.00, 580.00, 6380.00, 0.00, 'sydney-rent-nov.pdf', '[{"description":"Level 14 Margaret St Office Lease (Nov)","qty":1,"unitPrice":5800,"taxCode":"GST"}]'),
  (4, 'bill', 'BILL-000213', 'Australia Post Business', '28 864 970 579', 'AP-77218', '2026-11-14', '2026-12-14', 'Partial', '6-1900 Freight & Courier', 1420.00, 142.00, 1562.00, 562.00, '', '[{"description":"Express Post eParcel Business Dispatch","qty":1,"unitPrice":1420,"taxCode":"GST"}]'),
  (5, 'po', 'PO-000091', 'Apex POS Hardware Pty Ltd', '77 612 904 118', '', '2026-11-19', '2026-12-03', 'Issued', '5-1100 Inventory Purchases', 6800.00, 680.00, 7480.00, 0.00, '', '[{"description":"2D Bluetooth Barcode Scanners","qty":10,"unitPrice":380,"taxCode":"GST"},{"description":"80mm Thermal Receipt Printers","qty":10,"unitPrice":300,"taxCode":"GST"}]'),
  (6, 'po', 'PO-000092', 'Pacific Packaging Solutions', '91 103 442 681', '', '2026-11-21', '2026-12-08', 'Draft', '5-1200 Packaging & Consumables', 1650.00, 165.00, 1815.00, 0.00, '', '[{"description":"Recycled Kraft Shipping Cartons (Pack 500)","qty":3,"unitPrice":550,"taxCode":"GST"}]');

INSERT OR IGNORE INTO supplier_debits (id, debit_number, supplier_name, issue_date, reason, subtotal, gst_amount, total, status, applied_bill_number) VALUES
  (1, 'DN-000014', 'Australia Post Business', '2026-11-17', 'Duplicate satchel surcharge credit adjustment', 200.00, 20.00, 220.00, 'Open', '');

INSERT OR IGNORE INTO expense_claims (id, employee_name, merchant, category, expense_date, tax_code, amount, gst_amount, billable_customer, status) VALUES
  (1, 'Liam O''Connor', 'Qantas Airways', '6-2400 Travel & Accommodation', '2026-11-16', 'GST', 682.00, 62.00, 'Bayside Marine Engineering Pty Ltd', 'Submitted'),
  (2, 'Chloe Nguyen', 'Uber Business AU', '6-2400 Travel & Accommodation', '2026-11-18', 'GST', 99.00, 9.00, 'Melbourne Dental Collective', 'Approved'),
  (3, 'Jack Henderson', 'Woolworths Metro (Staff Pantry)', '6-2200 Staff Amenities', '2026-11-12', 'FRE', 145.00, 0.00, '', 'Reimbursed');
