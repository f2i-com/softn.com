export type CapabilityCategory = 'data' | 'surfaces' | 'ai' | 'enterprise';

export interface BaseGridAppDef {
  id: string;
  slug: string;
  name: string;
  shortName: string;
  bundleFile: string;
  color: string;
  pastel: string;
  iconText: string;
  tagline: string;
  airtableEquivalents: string[];
  sqliteTables: string[];
  highlights: string[];
}

export interface AirtableParityItem {
  airtableFeature: string;
  category: CapabilityCategory;
  airtableTier: string;
  baseGridTarget: string;
  launchAppId: string;
  notes: string;
}

export const CATEGORIES: Array<{ id: CapabilityCategory; label: string }> = [
  { id: 'data', label: 'Relational Data & 7 Views' },
  { id: 'surfaces', label: 'Interfaces, Forms & Reporting' },
  { id: 'ai', label: 'Omni AI, Field Agents & Automations' },
  { id: 'enterprise', label: 'Portals, Two-Way Sync & Governance' },
];

export const BASEGRID_APPS: BaseGridAppDef[] = [
  {
    id: 'basegrid.bases',
    slug: 'bases',
    name: 'Bases & Views Studio',
    shortName: 'Bases & Views',
    bundleFile: 'basegrid-bases.softn',
    color: '#6d28d9',
    pastel: '#f3eeff',
    iconText: 'BV',
    tagline: 'Relational bases, cross-table links, formulas, rollups & all 7 Airtable views.',
    airtableEquivalents: ['Grid', 'Kanban', 'Calendar', 'Gallery', 'Timeline / Gantt', 'List', 'Inbox'],
    sqliteTables: ['bases', 'tables_meta', 'fields_meta', 'records_data', 'views_meta', 'record_comments', 'record_history'],
    highlights: [
      '3 pre-seeded relational bases (Roadmap, Pipeline Radar, Content Studio)',
      '17 field types including Linked Records, Lookups, Rollups & safe Formula engine',
      'Saved views with Filters, Sorts, Group By, Summary Footer, Comments & Revision History',
    ],
  },
  {
    id: 'basegrid.interfaces',
    slug: 'interfaces',
    name: 'Interface Designer & Reporting',
    shortName: 'Interfaces',
    bundleFile: 'basegrid-interfaces.softn',
    color: '#2563eb',
    pastel: '#eaf5ff',
    iconText: 'IF',
    tagline: 'Role-specific executive dashboards, SVG charts, record pickers & live pivot tables.',
    airtableEquivalents: ['Interface Designer', 'Exec Summary Cards', 'Charts & Pivot Extensions'],
    sqliteTables: ['interface_pages', 'interface_widgets', 'portfolio_records'],
    highlights: [
      'Visual layout editor with Half/Full responsive widget spans & Role Preview simulator',
      'Live global filters updating Exec KPIs, Bar/Donut charts & cross-tab Pivot heatmaps',
      'Interactive Record Picker with live Approve / Launch / Flag Action Buttons',
    ],
  },
  {
    id: 'basegrid.forms',
    slug: 'forms',
    name: 'Forms Builder & Intake Hub',
    shortName: 'Forms',
    bundleFile: 'basegrid-forms.softn',
    color: '#db2777',
    pastel: '#fdf2f8',
    iconText: 'FM',
    tagline: 'Branded conditional intake forms feeding XDB SQLite directly with triage queues.',
    airtableEquivalents: ['Form Views', 'Conditional Form Logic', 'Intake Workflows'],
    sqliteTables: ['forms', 'form_fields', 'form_submissions'],
    highlights: [
      'Dynamic conditional field visibility ("Show when Field = Value") validated in PHP',
      'Custom cover gradients, required checks, 5-star ratings & instant confirmation flow',
      'Live Submissions Triage table with status workflow, CSV export & <softn-app> embed code',
    ],
  },
  {
    id: 'basegrid.automations',
    slug: 'automations',
    name: 'Automations & Workflow Engine',
    shortName: 'Automations',
    bundleFile: 'basegrid-automations.softn',
    color: '#ea580c',
    pastel: '#fff1e6',
    iconText: 'AU',
    tagline: 'No-code trigger-action workflows with live PHP execution, run traces & zero run caps.',
    airtableEquivalents: ['Automations', 'Conditional Triggers', 'Webhooks & Run History'],
    sqliteTables: ['automations', 'automation_steps', 'workflow_records', 'automation_runs', 'notification_outbox'],
    highlights: [
      'Visual Trigger → Action flow builder with safety-first "Paused for Review" toggles',
      'Real PHP execution mutating SQLite rows & logging Slack, Email & Webhook outbox items',
      'Live Trigger Sandbox table + full millisecond step-by-step execution trace logs',
    ],
  },
  {
    id: 'basegrid.ai-omni',
    slug: 'ai-omni',
    name: 'Omni AI Builder & Field Agents',
    shortName: 'Omni & AI',
    bundleFile: 'basegrid-ai-omni.softn',
    color: '#0284c7',
    pastel: '#e0f2fe',
    iconText: 'AI',
    tagline: 'Conversational app architect, column-level AI Field Agents, AI Plays & MCP server.',
    airtableEquivalents: ['Airtable Omni', 'Field Agents', 'AI Plays', 'Airtable MCP'],
    sqliteTables: ['omni_blueprints', 'omni_messages', 'field_agents', 'agent_rows', 'mcp_settings', 'mcp_call_logs'],
    highlights: [
      'Generate relational bases, views & paused automations from natural language + 1-click Undo',
      'Autonomous column Field Agents (Summary, Risk, Category, Next Action) running locally',
      'Interactive Model Context Protocol (MCP) tool console with Admin AI Governance switches',
    ],
  },
  {
    id: 'basegrid.portals-sync',
    slug: 'portals-sync',
    name: 'Portals, Sync & Governance',
    shortName: 'Portals & Sync',
    bundleFile: 'basegrid-portals-sync.softn',
    color: '#0d9488',
    pastel: '#e7faf5',
    iconText: 'PS',
    tagline: 'White-label external guest portals ($0 add-on), two-way HyperDB sync & RBAC audits.',
    airtableEquivalents: ['External Portals', 'Two-Way Sync', 'HyperDB Scale', 'RBAC & Audit Logs'],
    sqliteTables: ['portals', 'portal_guests', 'portal_deliverables', 'sync_sources', 'sync_runs', 'rbac_policies', 'audit_logs'],
    highlights: [
      'White-label external portals with Live Guest Preview, deliverable sign-off & $0 guest fees',
      'Two-Way & HyperDB warehouse sync connectors (Snowflake, Jira, Salesforce, Stripe)',
      'Editable RBAC permission matrix, SAML/SCIM/Residency toggles & immutable Audit Trail',
    ],
  },
];

export const AIRTABLE_PARITY_MAP: AirtableParityItem[] = [
  {
    airtableFeature: 'Relational Bases, Links, Lookups & Rollups',
    category: 'data',
    airtableTier: 'Free+',
    baseGridTarget: 'Bases & Views Studio',
    launchAppId: 'basegrid.bases',
    notes: 'Multi-table cross-links, instant Lookup pills, SUM/AVG/COUNT/MIN/MAX Rollups & safe Formula evaluation.',
  },
  {
    airtableFeature: 'Grid, Kanban, Calendar, Gallery, List & Inbox Views',
    category: 'data',
    airtableTier: 'Free+',
    baseGridTarget: 'Bases & Views Studio',
    launchAppId: 'basegrid.bases',
    notes: 'All 6 core views saved per table with filters, multi-sorts, grouping, column summary footer & inline editing.',
  },
  {
    airtableFeature: 'Timeline & Gantt Schedule Views',
    category: 'data',
    airtableTier: 'Team ($20/seat)+',
    baseGridTarget: 'Bases & Views Studio',
    launchAppId: 'basegrid.bases',
    notes: 'Unlocked for every user: quarter/half-year zoom Gantt bars with launch milestones and duration readouts.',
  },
  {
    airtableFeature: 'Record Comments & Revision History',
    category: 'data',
    airtableTier: 'Free (2w) → Enterprise (3y)',
    baseGridTarget: 'Bases & Views Studio',
    launchAppId: 'basegrid.bases',
    notes: 'Unlimited permanent SQLite revision history logging every field diff plus threaded record comments.',
  },
  {
    airtableFeature: 'Interface Designer & Exec Summary Cards',
    category: 'surfaces',
    airtableTier: 'Free → Business ($45/seat)',
    baseGridTarget: 'Interface Designer & Reporting',
    launchAppId: 'basegrid.interfaces',
    notes: 'Drag/toggle layout builder, KPI ribbons, interactive record picker with live Action Buttons & role preview.',
  },
  {
    airtableFeature: 'Reporting Charts & Pivot Table Extensions',
    category: 'surfaces',
    airtableTier: 'Team ($20/seat)+',
    baseGridTarget: 'Interface Designer & Reporting',
    launchAppId: 'basegrid.interfaces',
    notes: 'Built-in SVG Bar & Donut charts plus multi-dimensional Pivot Table heatmap extension with zero add-ons.',
  },
  {
    airtableFeature: 'Conditional Forms & Intake Triage',
    category: 'surfaces',
    airtableTier: 'Free → Team',
    baseGridTarget: 'Forms Builder & Intake Hub',
    launchAppId: 'basegrid.forms',
    notes: 'Branded cover headers, dynamic show/hide field conditions, server validation, triage status & CSV export.',
  },
  {
    airtableFeature: 'No-Code Automations & Run History',
    category: 'ai',
    airtableTier: '100 → 500k runs/mo',
    baseGridTarget: 'Automations & Workflow Engine',
    launchAppId: 'basegrid.automations',
    notes: 'Unlimited local & self-hosted runs executing real SQLite mutations, Slack/Email/Webhook logs & traces.',
  },
  {
    airtableFeature: 'Airtable Omni (Conversational App Builder)',
    category: 'ai',
    airtableTier: 'Credit-metered AI',
    baseGridTarget: 'Omni AI Builder & Field Agents',
    launchAppId: 'basegrid.ai-omni',
    notes: 'Natural language schema/view/automation generation + 1-click AI Plays + instant Undo/Revert.',
  },
  {
    airtableFeature: 'Autonomous AI Field Agents',
    category: 'ai',
    airtableTier: 'Credit-metered AI',
    baseGridTarget: 'Omni AI Builder & Field Agents',
    launchAppId: 'basegrid.ai-omni',
    notes: 'Record-level Summarizer, Risk Classifier, Category Tagger & Next-Action agents running offline in ZIPP PHP.',
  },
  {
    airtableFeature: 'Airtable MCP Server for AI Agents',
    category: 'ai',
    airtableTier: 'Platform Feature',
    baseGridTarget: 'Omni AI Builder & Field Agents',
    launchAppId: 'basegrid.ai-omni',
    notes: 'Built-in MCP tool explorer & permission-scoped query console with zero-retention admin controls.',
  },
  {
    airtableFeature: 'External White-Label Portals',
    category: 'enterprise',
    airtableTier: '+$120–$150/mo Add-on',
    baseGridTarget: 'Portals, Sync & Governance',
    launchAppId: 'basegrid.portals-sync',
    notes: 'Unlimited branded client/vendor portals with live guest preview and deliverable sign-off at $0 add-on cost.',
  },
  {
    airtableFeature: 'Two-Way Sync & HyperDB Connectors',
    category: 'enterprise',
    airtableTier: 'Business ($45) / Enterprise',
    baseGridTarget: 'Portals, Sync & Governance',
    launchAppId: 'basegrid.portals-sync',
    notes: 'Cross-base two-way sync, Jira/Salesforce/Stripe feeds & Snowflake HyperDB warehouse connectors.',
  },
  {
    airtableFeature: 'RBAC, SAML SSO, SCIM & Audit Logs',
    category: 'enterprise',
    airtableTier: 'Business / Enterprise Scale',
    baseGridTarget: 'Portals, Sync & Governance',
    launchAppId: 'basegrid.portals-sync',
    notes: 'Editable RBAC permission matrix, EU/AU/Local data residency switches & immutable SQLite audit log.',
  },
];
