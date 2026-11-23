export interface OpalAppDef {
  id: string;
  slug: string;
  name: string;
  shortName: string;
  bundleFile: string;
  myobModule: string;
  myobTierParity: string;
  tagline: string;
  accent: string;
  gradient: string;
  abbr: string;
  tables: string[];
  highlights: string[];
  quickActions: Array<{ label: string; hint: string }>;
}

export interface CompanyEntity {
  id: string;
  name: string;
  abn: string;
  industry: string;
  fy: string;
  basCycle: string;
  cashBalance: string;
  receivables: string;
  payables: string;
  estBas: string;
}

export const ENTITIES: CompanyEntity[] = [
  {
    id: 'harbourview',
    name: 'Harbourview Digital Pty Ltd',
    abn: '53 004 085 616',
    industry: 'Technology & Advisory · Sydney NSW',
    fy: 'FY2026–27 (Q2)',
    basCycle: 'Quarterly Accrual BAS',
    cashBalance: '$255,328.10',
    receivables: '$27,015.00',
    payables: '$10,900.00',
    estBas: '$15,110.00',
  },
  {
    id: 'southerncross',
    name: 'Southern Cross Trades Pty Ltd',
    abn: '51 824 753 556',
    industry: 'Electrical & Field Services · Melbourne VIC',
    fy: 'FY2026–27 (Q2)',
    basCycle: 'Quarterly Cash BAS',
    cashBalance: '$118,640.00',
    receivables: '$19,420.00',
    payables: '$6,840.00',
    estBas: '$8,920.00',
  },
];

export const OPAL_APPS: OpalAppDef[] = [
  {
    id: 'opal.sales',
    slug: 'sales',
    name: 'Sales & Invoicing',
    shortName: 'Sales',
    bundleFile: 'opal-sales.softn',
    myobModule: 'MYOB Sales',
    myobTierParity: 'Business Lite / Pro',
    tagline: 'Australian Tax Invoices, Quotes, Sales Orders, Customer Returns, Recurring & Online Pay.',
    accent: '#6100a5',
    gradient: 'linear-gradient(135deg, #6100a5, #7c3aed)',
    abbr: 'SL',
    tables: ['sales_docs', 'customer_payments', 'customer_credits', 'recurring_templates'],
    highlights: [
      'Tax Exclusive (+10% GST) & Tax Inclusive (1/11th) toggle',
      'One-click Quote -> Sales Order -> Tax Invoice conversion',
      'Printable AU Tax Invoice sheet with ABN, BSB/OSKO & BPAY',
      'Adjustment/Credit notes applied to open invoices or refunded',
    ],
    quickActions: [
      { label: 'New Tax Invoice', hint: 'Issue GST Tax Invoice' },
      { label: 'New Quote', hint: 'Send convertible quote' },
    ],
  },
  {
    id: 'opal.purchases',
    slug: 'purchases',
    name: 'Purchases, Bills & In Tray',
    shortName: 'Purchases',
    bundleFile: 'opal-purchases.softn',
    myobModule: 'MYOB Purchases & In Tray',
    myobTierParity: 'Business Lite / Pro',
    tagline: 'Smart OCR In Tray receipt capture, Supplier Bills, Purchase Orders, Debit Notes & Expenses.',
    accent: '#be185d',
    gradient: 'linear-gradient(135deg, #be185d, #7c3aed)',
    abbr: 'PU',
    tables: ['intray_docs', 'purchase_docs', 'supplier_debits', 'expense_claims'],
    highlights: [
      'OCR In Tray (Bunnings, Officeworks, Telstra feeds) -> 1-click Bill',
      'Purchase Order creation & conversion into Supplier Bills',
      'GST vs CAP (Capital Acquisition) tax code support',
      'Employee expense claims with customer on-charge flagging',
    ],
    quickActions: [
      { label: 'Capture In Tray Receipt', hint: 'OCR bill & receipt upload' },
      { label: 'Enter Supplier Bill', hint: 'Record payable bill' },
    ],
  },
  {
    id: 'opal.banking',
    slug: 'banking',
    name: 'Banking, Feeds & Reconcile',
    shortName: 'Banking',
    bundleFile: 'opal-banking.softn',
    myobModule: 'MYOB Banking',
    myobTierParity: 'Business Pro (Unlimited)',
    tagline: 'Unlimited Australian bank feeds, smart invoice matching, automated Bank Rules & reconciliation.',
    accent: '#0d9488',
    gradient: 'linear-gradient(135deg, #0d9488, #0284c7)',
    abbr: 'BK',
    tables: ['bank_accounts', 'bank_transactions', 'bank_rules', 'reconciliations'],
    highlights: [
      'Unlimited AU bank & credit card feeds (CommBank, NAB, ANZ, Stripe)',
      'Automated Bank Rules engine for instant GST/FRE coding',
      'Spend Money, Receive Money & atomic Inter-Account Transfers',
      'Statement reconciliation workbench with $0.00 Out-of-Balance audit',
    ],
    quickActions: [
      { label: 'Sync Bank Feed', hint: 'Pull overnight AU feed' },
      { label: 'Reconcile Statement', hint: 'Clear transactions' },
    ],
  },
  {
    id: 'opal.accounting',
    slug: 'accounting',
    name: 'Accounting, Journals & BAS',
    shortName: 'Accounting & BAS',
    bundleFile: 'opal-accounting.softn',
    myobModule: 'MYOB Accounting & AI BAS',
    myobTierParity: 'Business Pro + AI BAS',
    tagline: 'AU Chart of Accounts (1-xxxx–8-xxxx), balanced General Journals & AI-audited ATO BAS.',
    accent: '#4338ca',
    gradient: 'linear-gradient(135deg, #6100a5, #4338ca)',
    abbr: 'GL',
    tables: ['accounts', 'journal_entries', 'journal_lines', 'tax_transactions', 'bas_lodgements'],
    highlights: [
      'Standard MYOB-numbered Australian Chart of Accounts',
      'Double-entry General Journals with Debits = Credits & Reversals',
      'Live ATO BAS worksheet (G1, G2, G3, G10, G11, 1A, 1B, W1, W2)',
      'AI BAS pre-lodgement GST anomaly checks & ATO receipt log',
    ],
    quickActions: [
      { label: 'Prepare Q2 BAS', hint: 'Audit & lodge to ATO' },
      { label: 'Record General Journal', hint: 'Double-entry adjustment' },
    ],
  },
  {
    id: 'opal.payroll',
    slug: 'payroll',
    name: 'Payroll, STP Phase 2 & Super',
    shortName: 'Payroll & STP',
    bundleFile: 'opal-payroll.softn',
    myobModule: 'MYOB Payroll & Team',
    myobTierParity: 'AccountRight Plus (Unlimited)',
    tagline: 'Unlimited AU payroll with Stage 3 PAYG, 12% Superannuation, ATO STP2, Payslips & NES Leave.',
    accent: '#059669',
    gradient: 'linear-gradient(135deg, #059669, #0d9488)',
    abbr: 'PR',
    tables: ['employees', 'pay_runs', 'payslips', 'timesheets', 'leave_requests'],
    highlights: [
      'Stage 3 FY2026-27 PAYG tax + 2% Medicare + HELP withholding',
      'Automated 12.0% Superannuation Guarantee & Pay Super clearing',
      'STP Phase 2 disaggregated gross reporting & Fair Work Payslips',
      'Timesheet approval & NES Annual/Personal leave accrual engine',
    ],
    quickActions: [
      { label: 'Run Pay Run', hint: 'Calculate PAYG & 12% SG' },
      { label: 'Pay Super Batch', hint: 'SuperStream clearing' },
    ],
  },
  {
    id: 'opal.inventory',
    slug: 'inventory',
    name: 'Inventory, Jobs & Time Billing',
    shortName: 'Inventory & Jobs',
    bundleFile: 'opal-inventory.softn',
    myobModule: 'MYOB Inventory, Jobs & Time',
    myobTierParity: 'AccountRight Plus',
    tagline: 'Multi-location stock control, 3-tier pricing, stocktakes, sub-job budgets & billable time.',
    accent: '#d97706',
    gradient: 'linear-gradient(135deg, #d97706, #ea580c)',
    abbr: 'IJ',
    tables: ['items', 'stock_adjustments', 'jobs', 'time_slips'],
    highlights: [
      'Multi-location stock (Sydney, Melbourne, Brisbane) & reorder alerts',
      'Retail, Trade & Wholesale tiered pricing levels',
      'Parent Jobs & Sub-Jobs with budget vs actual margin bars',
      'Billable Time Slips rolled straight into job revenue',
    ],
    quickActions: [
      { label: 'Adjust Stocktake', hint: 'Update warehouse qty' },
      { label: 'Log Billable Time', hint: 'Add job activity slip' },
    ],
  },
  {
    id: 'opal.contacts',
    slug: 'contacts',
    name: 'Contacts, ABN & TPAR',
    shortName: 'Contacts',
    bundleFile: 'opal-contacts.softn',
    myobModule: 'MYOB Contacts & Advisors',
    myobTierParity: 'Business Pro',
    tagline: 'Customers, Suppliers, ATO TPAR Contractors, free Advisor seats & live ABR Mod-89 ABN check.',
    accent: '#2563eb',
    gradient: 'linear-gradient(135deg, #2563eb, #6100a5)',
    abbr: 'CT',
    tables: ['contacts', 'contact_notes'],
    highlights: [
      'Real ABR Mod-89 11-digit ABN checksum validator in PHP',
      'ATO TPAR (Taxable Payments Annual Report) contractor tracking',
      'ABA bank BSB/Account storage & credit limit utilization bars',
      'Unlimited free Chartered Accountant / Bookkeeper advisor contacts',
    ],
    quickActions: [
      { label: 'Add Contact & Verify ABN', hint: 'Live Mod-89 check' },
    ],
  },
  {
    id: 'opal.reporting',
    slug: 'reporting',
    name: 'Reporting & Multi-Currency',
    shortName: 'Reporting & FX',
    bundleFile: 'opal-reporting.softn',
    myobModule: 'MYOB Reporting & Premier FX',
    myobTierParity: 'AccountRight Premier',
    tagline: 'Accrual/Cash P&L, Balance Sheet, Cash Flow, Trial Balance, Aged AR/AP & Multi-Currency FX.',
    accent: '#4f46e5',
    gradient: 'linear-gradient(135deg, #4f46e5, #0d9488)',
    abbr: 'RP',
    tables: ['ledger_summary', 'monthly_cashflow', 'aged_items', 'fx_positions', 'saved_packs'],
    highlights: [
      'Profit & Loss with Accrual/Cash toggle & Prior Period variance',
      'Balance Sheet & Trial Balance double-entry verification badges',
      'Statement of Cash Flows & Aged Receivables / Payables',
      'AccountRight Premier multi-currency FX spot revaluation (USD/NZD/GBP/SGD)',
    ],
    quickActions: [
      { label: 'Run Profit & Loss', hint: 'Accrual vs Cash P&L' },
      { label: 'FX Revaluation', hint: 'Unrealised FX gain/loss' },
    ],
  },
];

export interface MyobComparisonRow {
  capability: string;
  myobSolo: string;
  myobLite: string;
  myobPro: string;
  arPlus: string;
  arPremier: string;
  opalSoftn: string;
  opalModule: string;
}

export const MYOB_COMPARISON: MyobComparisonRow[] = [
  {
    capability: 'Pricing (AUD, standard)',
    myobSolo: '~$99/yr (mobile)',
    myobLite: '~$315/yr',
    myobPro: '~$70/mo',
    arPlus: '~$165/mo',
    arPremier: '~$210/mo',
    opalSoftn: '$0 / Self-hosted SoftN',
    opalModule: 'All 8 Apps',
  },
  {
    capability: 'Quotes, Sales Orders & Tax Invoices',
    myobSolo: 'Invoices only',
    myobLite: 'Quotes + Invoices',
    myobPro: 'Quotes + Orders + Inv',
    arPlus: 'Full + Returns',
    arPremier: 'Full + Returns',
    opalSoftn: 'Full + Recurring + Preview',
    opalModule: 'sales',
  },
  {
    capability: 'In Tray (OCR Receipt Capture) & Bills',
    myobSolo: 'Mobile receipts',
    myobLite: 'Included',
    myobPro: 'Included',
    arPlus: 'Included + POs',
    arPremier: 'Included + POs',
    opalSoftn: 'OCR In Tray + Bills + POs + Expenses',
    opalModule: 'purchases',
  },
  {
    capability: 'Live Bank Feeds & Bank Rules',
    myobSolo: 'Up to 2 banks',
    myobLite: 'Up to 2 banks',
    myobPro: 'Unlimited',
    arPlus: 'Unlimited',
    arPremier: 'Unlimited',
    opalSoftn: 'Unlimited + Rules + Reconcile',
    opalModule: 'banking',
  },
  {
    capability: 'GST Tracking, AI BAS & General Journals',
    myobSolo: 'GST only',
    myobLite: 'BAS to ATO',
    myobPro: 'BAS + AI Checks',
    arPlus: 'BAS + Journals',
    arPremier: 'BAS + Journals',
    opalSoftn: 'Full AU CoA + Journals + AI BAS',
    opalModule: 'accounting',
  },
  {
    capability: 'Payroll (STP Phase 2, 12% Super, Leave)',
    myobSolo: 'Not included',
    myobLite: 'Add-on (max 2 staff)',
    myobPro: 'Add-on ($/emp/mo)',
    arPlus: 'Unlimited Included',
    arPremier: 'Unlimited Included',
    opalSoftn: 'Unlimited Included (Stage 3 PAYG)',
    opalModule: 'payroll',
  },
  {
    capability: 'Multi-Location Inventory, Jobs & Time Billing',
    myobSolo: 'No',
    myobLite: '1 location basic',
    myobPro: 'Basic jobs',
    arPlus: 'Multi-tier + Sub-jobs',
    arPremier: 'Multi-tier + Sub-jobs',
    opalSoftn: 'Multi-Warehouse + 3 Tiers + Jobs + Time',
    opalModule: 'inventory',
  },
  {
    capability: 'Contacts, ABN Validation & ATO TPAR',
    myobSolo: 'Basic',
    myobLite: 'Standard',
    myobPro: 'Unlimited Users',
    arPlus: 'Full + TPAR',
    arPremier: 'Full + TPAR',
    opalSoftn: 'Live Mod-89 ABN + TPAR + Advisors',
    opalModule: 'contacts',
  },
  {
    capability: 'Multi-Currency & Multi-Business Entities',
    myobSolo: 'No',
    myobLite: 'No',
    myobPro: 'No',
    arPlus: 'No',
    arPremier: 'Yes (Premier only)',
    opalSoftn: 'Included (FX Reval + Entity Switcher)',
    opalModule: 'reporting',
  },
  {
    capability: 'Runtime & Data Sovereignty',
    myobSolo: 'MYOB Cloud only',
    myobLite: 'MYOB Cloud only',
    myobPro: 'MYOB Cloud only',
    arPlus: 'Win Desktop + Cloud',
    arPremier: 'Win Desktop + Cloud',
    opalSoftn: 'ZIPP PHP WASM + XDB SQLite OR Standalone PHP',
    opalModule: 'sales',
  },
];
