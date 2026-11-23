export interface ModulaAppDef {
  id: string;
  slug: string;
  name: string;
  shortName: string;
  department: DepartmentId;
  color: string;
  bgTint: string;
  iconText: string;
  bundleFile: string;
  standalonePort: number;
  tagline: string;
  odooEquivalents: string[];
  tables: string[];
  highlights: string[];
}

export type DepartmentId =
  | 'sales'
  | 'finance'
  | 'supply-chain'
  | 'services'
  | 'hr'
  | 'websites'
  | 'marketing'
  | 'productivity';

export interface ParityModule {
  odooName: string;
  department: DepartmentId;
  status: 'live' | 'pack' | 'roadmap';
  modulaTarget: string;
  launchAppId?: string;
  packFile?: string;
  notes: string;
}

export const DEPARTMENTS: Array<{ id: DepartmentId; label: string; color: string }> = [
  { id: 'sales', label: 'Sales & CRM', color: '#0d9488' },
  { id: 'finance', label: 'Finance', color: '#6d28d9' },
  { id: 'supply-chain', label: 'Supply Chain', color: '#d97706' },
  { id: 'services', label: 'Services & Projects', color: '#2563eb' },
  { id: 'hr', label: 'Human Resources', color: '#db2777' },
  { id: 'websites', label: 'Websites & Commerce', color: '#ea580c' },
  { id: 'marketing', label: 'Marketing & Events', color: '#9333ea' },
  { id: 'productivity', label: 'Productivity & Vault', color: '#059669' },
];

export const CORE_APPS: ModulaAppDef[] = [
  {
    id: 'modula.crm',
    slug: 'crm',
    name: 'CRM, Sales & Subscriptions',
    shortName: 'CRM',
    department: 'sales',
    color: '#0d9488',
    bgTint: '#ccfbf1',
    iconText: 'CR',
    bundleFile: 'modula-crm.softn',
    standalonePort: 8101,
    tagline: 'Predictive lead scoring, Kanban pipeline, quotations, recurring MRR & forecasting.',
    odooEquivalents: ['CRM', 'Sales', 'Subscriptions'],
    tables: ['crm_leads', 'deals', 'contacts', 'quotes', 'subscriptions', 'activities'],
    highlights: ['Lead scoring + 1-click convert', 'Stage Kanban & weighted forecast', 'Multi-line quotations', 'MRR/ARR subscription contracts'],
  },
  {
    id: 'modula.pos',
    slug: 'pos',
    name: 'Point of Sale & Rental',
    shortName: 'POS',
    department: 'sales',
    color: '#0284c7',
    bgTint: '#e0f2fe',
    iconText: 'PS',
    bundleFile: 'modula-pos.softn',
    standalonePort: 8108,
    tagline: 'Touch retail/cafe POS register, cash drawer Z-reports, refunds & equipment rental desk.',
    odooEquivalents: ['Point of Sale', 'Restaurant POS', 'Rental'],
    tables: ['pos_sessions', 'pos_items', 'pos_orders', 'rental_assets', 'rental_bookings'],
    highlights: ['Counter, Dine-In & Takeaway POS', 'Cash/Card/Split + live receipt', 'Shift Z-Reports & refunds', 'Rental fleet check-out / return'],
  },
  {
    id: 'modula.accounting',
    slug: 'accounting',
    name: 'Accounting & Invoicing',
    shortName: 'Accounting',
    department: 'finance',
    color: '#6d28d9',
    bgTint: '#ede9fe',
    iconText: 'AC',
    bundleFile: 'modula-accounting.softn',
    standalonePort: 8102,
    tagline: 'Double-entry GL, invoices, credit notes, bank reconciliation, P&L & Balance Sheet.',
    odooEquivalents: ['Accounting', 'Invoicing', 'Expenses'],
    tables: ['accounts', 'invoices', 'bank_transactions', 'expenses', 'journal_entries'],
    highlights: ['Smart bank reconciliation', 'Credit notes & partial payments', 'Live P&L, Balance Sheet & Aging', 'Manual balanced journal entries'],
  },
  {
    id: 'modula.inventory',
    slug: 'inventory',
    name: 'Inventory, Purchase & MRP',
    shortName: 'Inventory',
    department: 'supply-chain',
    color: '#d97706',
    bgTint: '#fef3c7',
    iconText: 'IN',
    bundleFile: 'modula-inventory.softn',
    standalonePort: 8103,
    tagline: 'Warehouse bin ledger, customer deliveries, RFQs, Bills of Materials & MRP production.',
    odooEquivalents: ['Inventory', 'Purchase', 'Manufacturing'],
    tables: ['products', 'vendors', 'purchase_orders', 'boms', 'manufacturing_orders', 'stock_moves'],
    highlights: ['Bills of Materials & MRP kits', 'Deliveries & bin transfers', '1-click low-stock RFQs & receive', 'Double-entry stock move ledger'],
  },
  {
    id: 'modula.projects',
    slug: 'projects',
    name: 'Projects & Timesheets',
    shortName: 'Projects',
    department: 'services',
    color: '#2563eb',
    bgTint: '#dbeafe',
    iconText: 'PR',
    bundleFile: 'modula-projects.softn',
    standalonePort: 8104,
    tagline: 'Task Kanban, subtask checklists, live stopwatch timer, milestones & profitability.',
    odooEquivalents: ['Project', 'Timesheets'],
    tables: ['projects', 'tasks', 'milestones', 'timesheets'],
    highlights: ['Live stopwatch time tracker', 'Subtask checklists per task', 'Milestone delivery tracking', 'Project margin & utilization'],
  },
  {
    id: 'modula.fieldservice',
    slug: 'fieldservice',
    name: 'Field Service & Planning',
    shortName: 'Field Ops',
    department: 'services',
    color: '#0891b2',
    bgTint: '#cffafe',
    iconText: 'FS',
    bundleFile: 'modula-fieldservice.softn',
    standalonePort: 8109,
    tagline: 'Technician dispatch board, customer sign-off billing, appointments & shift roster.',
    odooEquivalents: ['Field Service', 'Appointments', 'Planning'],
    tables: ['technicians', 'work_orders', 'appointments', 'shifts'],
    highlights: ['4-stage technician dispatch board', 'Parts + labor sign-off billing', 'Conflict-checked appointment desk', 'Team shift planning & publish'],
  },
  {
    id: 'modula.hr',
    slug: 'hr',
    name: 'HR, Attendance & Payroll',
    shortName: 'HR',
    department: 'hr',
    color: '#db2777',
    bgTint: '#fce7f3',
    iconText: 'HR',
    bundleFile: 'modula-hr.softn',
    standalonePort: 8105,
    tagline: 'Employee directory, check-in kiosk, leave approvals, ATS hiring, appraisals & payroll.',
    odooEquivalents: ['Employees', 'Attendance', 'Time Off', 'Recruitment', 'Appraisals', 'Payroll'],
    tables: ['employees', 'attendances', 'leave_requests', 'candidates', 'appraisals', 'payslips'],
    highlights: ['Check-in/out attendance kiosk', 'Batch payroll run & payslips', 'Performance appraisal reviews', 'ATS Kanban + 1-click Hire'],
  },
  {
    id: 'modula.website',
    slug: 'website',
    name: 'Website, eCommerce & Marketing',
    shortName: 'Website',
    department: 'websites',
    color: '#ea580c',
    bgTint: '#ffedd5',
    iconText: 'WB',
    bundleFile: 'modula-website.softn',
    standalonePort: 8107,
    tagline: 'Block page composer, online store with promo codes, CMS blog, email blasts & leads.',
    odooEquivalents: ['Website', 'eCommerce', 'Blog', 'Email Marketing'],
    tables: ['pages', 'store_products', 'store_orders', 'blog_posts', 'campaigns', 'leads'],
    highlights: ['Reorderable page block builder', 'Storefront + promo code checkout', 'Built-in CMS Blog publishing', 'Email marketing campaigns'],
  },
  {
    id: 'modula.events',
    slug: 'events',
    name: 'Events, Surveys & eLearning',
    shortName: 'Events',
    department: 'marketing',
    color: '#9333ea',
    bgTint: '#f3e8ff',
    iconText: 'EV',
    bundleFile: 'modula-events.softn',
    standalonePort: 8111,
    tagline: 'Event ticketing & door check-in, live NPS surveys & self-hosted eLearning academy.',
    odooEquivalents: ['Events', 'Surveys', 'eLearning'],
    tables: ['events', 'registrations', 'surveys', 'survey_responses', 'courses', 'lessons'],
    highlights: ['Event ticketing & 1-click check-in', 'Real-time NPS & CSAT surveys', 'Self-hosted academy courses', 'Lesson completion progress'],
  },
  {
    id: 'modula.helpdesk',
    slug: 'helpdesk',
    name: 'Helpdesk & Knowledge',
    shortName: 'Helpdesk',
    department: 'productivity',
    color: '#059669',
    bgTint: '#d1fae5',
    iconText: 'HD',
    bundleFile: 'modula-helpdesk.softn',
    standalonePort: 8106,
    tagline: 'SLA ticket queue, canned macros, CSAT ratings, public/internal notes & SOP wiki.',
    odooEquivalents: ['Helpdesk', 'Knowledge'],
    tables: ['tickets', 'ticket_messages', 'canned_responses', 'kb_articles'],
    highlights: ['1-click canned reply macros', 'KB citation into ticket reply', 'Customer 1-5 star CSAT tracking', 'Editable company Knowledge Wiki'],
  },
  {
    id: 'modula.workspace',
    slug: 'workspace',
    name: 'Documents, eSign & Discuss',
    shortName: 'Workspace',
    department: 'productivity',
    color: '#4f46e5',
    bgTint: '#e0e7ff',
    iconText: 'WS',
    bundleFile: 'modula-workspace.softn',
    standalonePort: 8110,
    tagline: 'Document vault, SHA-256 electronic signatures, approvals inbox & team Discuss channels.',
    odooEquivalents: ['Documents', 'Sign', 'Approvals', 'Discuss'],
    tables: ['documents', 'sign_requests', 'approvals', 'channels', 'channel_messages'],
    highlights: ['Foldered Document Vault', 'SHA-256 cryptographic eSign', 'Cross-dept Approvals inbox', 'Persistent Discuss channels'],
  },
];

export const ODOO_PARITY_MAP: ParityModule[] = [
  // Sales
  { odooName: 'CRM', department: 'sales', status: 'live', modulaTarget: 'Modula CRM, Sales & Subscriptions', launchAppId: 'modula.crm', notes: 'Predictive lead scoring, Kanban pipeline, scheduled follow-ups & win/loss tracking' },
  { odooName: 'Sales & Quotations', department: 'sales', status: 'live', modulaTarget: 'Modula CRM, Sales & Subscriptions', launchAppId: 'modula.crm', notes: 'Multi-line quotations with tax calculation & auto-win deal conversion' },
  { odooName: 'Subscriptions', department: 'sales', status: 'live', modulaTarget: 'Modula CRM, Sales & Subscriptions', launchAppId: 'modula.crm', notes: 'Recurring MRR/ARR contracts, seat counts & Pause/Resume/Cancel lifecycle' },
  { odooName: 'Point of Sale (Shop & Restaurant)', department: 'sales', status: 'live', modulaTarget: 'Modula Point of Sale & Rental', launchAppId: 'modula.pos', notes: 'Touch register, Dine-In tables, Cash/Card/Split payments, receipts & Z-Reports' },
  { odooName: 'Rental', department: 'sales', status: 'live', modulaTarget: 'Modula Point of Sale & Rental', launchAppId: 'modula.pos', notes: 'Equipment rental fleet availability, deposits & atomic Check-Out/Return' },

  // Finance
  { odooName: 'Accounting', department: 'finance', status: 'live', modulaTarget: 'Modula Accounting & Invoicing', launchAppId: 'modula.accounting', notes: 'Double-entry GL, Chart of Accounts, P&L, Balance Sheet, Aged Receivables & Journal Entries' },
  { odooName: 'Invoicing & Credit Notes', department: 'finance', status: 'live', modulaTarget: 'Modula Accounting & Invoicing', launchAppId: 'modula.accounting', notes: 'Customer invoices, vendor bills, partial payments & balanced credit notes' },
  { odooName: 'Bank Reconciliation', department: 'finance', status: 'live', modulaTarget: 'Modula Accounting & Invoicing', launchAppId: 'modula.accounting', notes: 'Bank statement feed with 1-click smart invoice/bill matching & GL posting' },
  { odooName: 'Expenses', department: 'finance', status: 'live', modulaTarget: 'Modula Accounting & Invoicing', launchAppId: 'modula.accounting', notes: 'Employee expense submission, approval & direct GL reimbursement' },
  { odooName: 'Sign (eSignature)', department: 'finance', status: 'live', modulaTarget: 'Modula Documents, eSign & Discuss', launchAppId: 'modula.workspace', notes: 'Electronic signature envelopes sealed with PHP 8 SHA-256 audit hashes' },
  { odooName: 'Compliance & Advisory', department: 'finance', status: 'pack', modulaTarget: 'Finance OS (AU / US)', packFile: 'Finance-OS-AU-1.0.0.softn', notes: 'Existing SoftN regulatory advisory & document vault packs' },

  // Supply Chain
  { odooName: 'Inventory', department: 'supply-chain', status: 'live', modulaTarget: 'Modula Inventory, Purchase & MRP', launchAppId: 'modula.inventory', notes: 'Bin locations, customer deliveries, internal transfers & double-entry stock ledger' },
  { odooName: 'Purchase', department: 'supply-chain', status: 'live', modulaTarget: 'Modula Inventory, Purchase & MRP', launchAppId: 'modula.inventory', notes: 'Vendor RFQs, 1-click low-stock draft POs & atomic goods receiving' },
  { odooName: 'Manufacturing (MRP)', department: 'supply-chain', status: 'live', modulaTarget: 'Modula Inventory, Purchase & MRP', launchAppId: 'modula.inventory', notes: 'Bills of Materials (BoMs) & transactional kit assembly production orders' },
  { odooName: 'Quality (QMS / ISO)', department: 'supply-chain', status: 'pack', modulaTarget: 'OHS & QMS Pack', packFile: 'OHS-QMS-1.0.0.softn', notes: 'Existing SoftN ISO 9001/45001 CAPA, NCR & 5x5 risk matrix pack' },
  { odooName: 'Maintenance & Repairs', department: 'supply-chain', status: 'pack', modulaTarget: 'RepairBench / Mechanic Pack', packFile: 'RepairBench-1.0.0.softn', notes: 'Existing SoftN workshop bay, asset service & device repair packs' },

  // Services
  { odooName: 'Project', department: 'services', status: 'live', modulaTarget: 'Modula Projects & Timesheets', launchAppId: 'modula.projects', notes: '4-stage Task Kanban, subtask checklists, milestones & margin analytics' },
  { odooName: 'Timesheets', department: 'services', status: 'live', modulaTarget: 'Modula Projects & Timesheets', launchAppId: 'modula.projects', notes: 'Live stopwatch timer, billable/internal hours & utilization rollups' },
  { odooName: 'Field Service', department: 'services', status: 'live', modulaTarget: 'Modula Field Service & Planning', launchAppId: 'modula.fieldservice', notes: 'Technician dispatch board, site jobs, parts/labor billing & customer sign-off' },
  { odooName: 'Appointments', department: 'services', status: 'live', modulaTarget: 'Modula Field Service & Planning', launchAppId: 'modula.fieldservice', notes: 'Conflict-checked customer appointment booking & check-in desk' },
  { odooName: 'Planning', department: 'services', status: 'live', modulaTarget: 'Modula Field Service & Planning', launchAppId: 'modula.fieldservice', notes: 'Team shift capacity roster with draft/publish workflow' },

  // HR
  { odooName: 'Employees', department: 'hr', status: 'live', modulaTarget: 'Modula HR, Attendance & Payroll', launchAppId: 'modula.hr', notes: 'Employee directory, role/salary editing, departments & leave balances' },
  { odooName: 'Attendances', department: 'hr', status: 'live', modulaTarget: 'Modula HR, Attendance & Payroll', launchAppId: 'modula.hr', notes: 'Check-In / Check-Out attendance kiosk with live logged hours' },
  { odooName: 'Time Off', department: 'hr', status: 'live', modulaTarget: 'Modula HR, Attendance & Payroll', launchAppId: 'modula.hr', notes: 'Leave request queue with automatic PTO balance deduction' },
  { odooName: 'Recruitment (ATS)', department: 'hr', status: 'live', modulaTarget: 'Modula HR, Attendance & Payroll', launchAppId: 'modula.hr', notes: 'Candidate Kanban pipeline with 1-click Hire to Employee DB' },
  { odooName: 'Appraisals', department: 'hr', status: 'live', modulaTarget: 'Modula HR, Attendance & Payroll', launchAppId: 'modula.hr', notes: 'Structured 1-5 star performance reviews, goals & status tracking' },
  { odooName: 'Payroll', department: 'hr', status: 'live', modulaTarget: 'Modula HR, Attendance & Payroll', launchAppId: 'modula.hr', notes: 'Batch monthly payroll generation, tax withholding & payslip payout' },
  { odooName: 'Fleet', department: 'hr', status: 'pack', modulaTarget: 'FleetFlow Pack', packFile: 'FleetFlow-1.0.0.softn', notes: 'Existing SoftN vehicle logbook, rego alerts & fuel logs' },

  // Websites
  { odooName: 'Website Builder', department: 'websites', status: 'live', modulaTarget: 'Modula Website, eCommerce & Marketing', launchAppId: 'modula.website', notes: 'Multi-page reorderable block composer with SEO metadata & live preview' },
  { odooName: 'eCommerce', department: 'websites', status: 'live', modulaTarget: 'Modula Website, eCommerce & Marketing', launchAppId: 'modula.website', notes: 'Storefront catalog, promo codes (MODULA10/SAVE20), checkout & order fulfillment' },
  { odooName: 'Blog & Lead Forms', department: 'websites', status: 'live', modulaTarget: 'Modula Website, eCommerce & Marketing', launchAppId: 'modula.website', notes: 'CMS blog publishing & inbound contact forms persisted in SQLite' },
  { odooName: 'eLearning Academy', department: 'websites', status: 'live', modulaTarget: 'Modula Events, Surveys & eLearning', launchAppId: 'modula.events', notes: 'Self-hosted course catalog, interactive lesson reader & progress tracking' },

  // Marketing
  { odooName: 'Email Marketing', department: 'marketing', status: 'live', modulaTarget: 'Modula Website, eCommerce & Marketing', launchAppId: 'modula.website', notes: 'Audience segment campaigns, dispatch tracking & open/click telemetry' },
  { odooName: 'Events', department: 'marketing', status: 'live', modulaTarget: 'Modula Events, Surveys & eLearning', launchAppId: 'modula.events', notes: 'Event capacity management, ticket issuing & 1-click door check-in' },
  { odooName: 'Surveys & NPS', department: 'marketing', status: 'live', modulaTarget: 'Modula Events, Surveys & eLearning', launchAppId: 'modula.events', notes: 'Live 0-10 NPS & CSAT polls with real-time response analytics' },

  // Productivity
  { odooName: 'Helpdesk', department: 'productivity', status: 'live', modulaTarget: 'Modula Helpdesk & Knowledge', launchAppId: 'modula.helpdesk', notes: 'SLA triage queue, canned reply macros, CSAT ratings & public/internal notes' },
  { odooName: 'Knowledge', department: 'productivity', status: 'live', modulaTarget: 'Modula Helpdesk & Knowledge', launchAppId: 'modula.helpdesk', notes: 'Editable company SOP wiki with ticket citation & helpfulness votes' },
  { odooName: 'Documents', department: 'productivity', status: 'live', modulaTarget: 'Modula Documents, eSign & Discuss', launchAppId: 'modula.workspace', notes: 'Foldered document vault with version labels, tags & 1-click send to eSign' },
  { odooName: 'Approvals', department: 'productivity', status: 'live', modulaTarget: 'Modula Documents, eSign & Discuss', launchAppId: 'modula.workspace', notes: 'Cross-department purchase, travel & budget approvals inbox' },
  { odooName: 'Discuss', department: 'productivity', status: 'live', modulaTarget: 'Modula Documents, eSign & Discuss', launchAppId: 'modula.workspace', notes: 'Persistent public/private team channels with pinned announcements' },
  { odooName: 'Studio (App Customization)', department: 'productivity', status: 'live', modulaTarget: 'SoftN Studio & Builder', notes: 'Included free! Open any .softn bundle in SoftN Studio with built-in SQLite IDE' },
  { odooName: 'AI Receptionist / Voice', department: 'productivity', status: 'pack', modulaTarget: 'Aokie Receptionist Pack', packFile: 'Aokie-Receptionist-1.0.0.softn', notes: 'Existing SoftN call console, SMS inbox & AI transcripts' },
];

export const VERTICAL_PACKS: Array<{
  slug: string;
  name: string;
  category: string;
  file: string;
  description: string;
  color: string;
}> = [
  { slug: 'counterflow', name: 'CounterFlow Retail', category: 'Retail POS', file: 'CounterFlow-1.0.0.softn', description: 'Retail till operations, catalogue margins, stock ledger & returns desk.', color: '#0284c7' },
  { slug: 'passmaster', name: 'PassMaster Restaurant', category: 'Hospitality', file: 'PassMaster-1.0.0.softn', description: 'Section floor map, reservations, kitchen pass KDS & allergy alerts.', color: '#b45309' },
  { slug: 'brewdesk', name: 'BrewDesk Cafe', category: 'Hospitality', file: 'BrewDesk-1.0.0.softn', description: 'Barista order pad, espresso ticket queue, par stock & shift closeout.', color: '#92400e' },
  { slug: 'fleetflow', name: 'FleetFlow Fleet', category: 'Operations', file: 'FleetFlow-1.0.0.softn', description: 'Vehicle register, rego/licence expiry alerts, FBT trip & fuel logs.', color: '#0f766e' },
  { slug: 'ohs-qms', name: 'OHS & QMS (ISO)', category: 'Compliance', file: 'OHS-QMS-1.0.0.softn', description: 'ISO 45001/9001 incidents, 5x5 risk matrix, CAPA & audit reports.', color: '#7c3aed' },
  { slug: 'event-hub', name: 'Event Hub', category: 'Events', file: 'Event-Hub-1.0.0.softn', description: '1-tap attendee check-in, speaker schedule, vendor booths & budget.', color: '#c026d3' },
  { slug: 'plumbing-trades', name: 'Plumbing & Trades', category: 'Field Service', file: 'Plumbing-Trades-1.0.0.softn', description: 'Priority dispatch board, work orders, parts used & 1-click invoicing.', color: '#1d4ed8' },
  { slug: 'salon-studio', name: 'Salon Studio', category: 'Appointments', file: 'Salon-Studio-1.0.0.softn', description: 'Stylist appointment calendar, client formula cards & retail receipts.', color: '#be185d' },
];
