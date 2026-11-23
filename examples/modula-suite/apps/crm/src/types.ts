export interface StageSummary {
  stage: string;
  count: number;
  revenue: number;
}

export interface OwnerSummary {
  owner: string;
  open: number;
  won: number;
  deals: number;
}

export interface CrmOverview {
  openPipeline: number;
  weightedForecast: number;
  wonRevenue: number;
  winRate: number;
  openDeals: number;
  wonDeals: number;
  lostDeals: number;
  contactsCount: number;
  quotesCount: number;
  openLeads: number;
  activeMrr: number;
  activeArr: number;
  pendingActivities: number;
  byStage: StageSummary[];
  byOwner: OwnerSummary[];
}

export interface CrmLead {
  id: number;
  name: string;
  company: string;
  email: string;
  phone: string;
  source: string;
  est_budget: number;
  team_size: number;
  score: number;
  status: string;
  notes: string;
  created_at: string;
}

export interface Deal {
  id: number;
  title: string;
  company: string;
  contact_name: string;
  contact_email: string;
  stage: string;
  expected_revenue: number;
  probability: number;
  priority: number;
  owner_name: string;
  close_date: string;
  lost_reason: string;
  notes: string;
  pending_tasks?: number;
  created_at: string;
}

export interface Contact {
  id: number;
  name: string;
  company: string;
  email: string;
  phone: string;
  role_title: string;
  tag: string;
  created_at: string;
}

export interface QuoteLine {
  description: string;
  qty: number;
  unitPrice: number;
}

export interface Quote {
  id: number;
  quote_number: string;
  deal_id: number | null;
  customer_name: string;
  status: string;
  subtotal: number;
  tax_rate: number;
  total: number;
  valid_until: string;
  items: QuoteLine[];
  created_at: string;
}

export interface Subscription {
  id: number;
  sub_number: string;
  customer_name: string;
  plan_name: string;
  billing_cycle: string;
  mrr: number;
  seats: number;
  status: string;
  next_billing_date: string;
}

export interface Activity {
  id: number;
  deal_id: number;
  kind: string;
  author: string;
  summary: string;
  due_date: string;
  done: number;
  created_at: string;
}

export const PIPELINE_STAGES = ['New', 'Qualified', 'Proposition', 'Negotiation', 'Won'] as const;
