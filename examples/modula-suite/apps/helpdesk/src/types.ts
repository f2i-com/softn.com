export interface HelpdeskOverview {
  openTickets: number;
  highPriority: number;
  solvedTickets: number;
  kbArticles: number;
  avgCsat: number;
  ratedCount: number;
}

export interface Ticket {
  id: number;
  ticket_number: string;
  subject: string;
  customer_name: string;
  customer_email: string;
  stage: string;
  priority: string;
  assignee: string;
  sla_status: string;
  tags: string;
  csat_rating: number;
  created_at: string;
}

export interface TicketMessage {
  id: number;
  ticket_id: number;
  author: string;
  is_internal: number;
  body: string;
  created_at: string;
}

export interface CannedMacro {
  id: number;
  shortcut: string;
  title: string;
  body: string;
}

export interface KbArticle {
  id: number;
  title: string;
  category: string;
  body: string;
  helpful_votes: number;
  updated_at: string;
}
