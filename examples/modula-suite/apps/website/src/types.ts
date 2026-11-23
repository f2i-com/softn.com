export interface WebsiteOverview {
  publishedPages: number;
  totalPages: number;
  ordersCount: number;
  storeRevenue: number;
  leadsCount: number;
  blogCount: number;
  sentCampaigns: number;
}

export interface PageBlock {
  kind: 'features' | 'testimonial' | 'faq' | 'cta';
  heading: string;
  body: string;
}

export interface CmsPage {
  id: number;
  slug: string;
  title: string;
  meta_desc: string;
  headline: string;
  subheadline: string;
  cta_label: string;
  accent_color: string;
  blocks: PageBlock[];
  published: number;
  updated_at: string;
}

export interface StoreProduct {
  id: number;
  name: string;
  sku: string;
  category: string;
  price: number;
  stock: number;
  summary: string;
}

export interface StoreOrder {
  id: number;
  order_number: string;
  customer_name: string;
  customer_email: string;
  items_summary: string;
  promo_code: string;
  discount_amount: number;
  total: number;
  status: string;
  created_at: string;
}

export interface BlogPost {
  id: number;
  slug: string;
  title: string;
  author: string;
  tag: string;
  excerpt: string;
  body: string;
  published: number;
  published_at: string;
}

export interface Campaign {
  id: number;
  name: string;
  subject: string;
  audience: string;
  body: string;
  recipients: number;
  open_rate: number;
  status: string;
  sent_at: string;
}

export interface WebLead {
  id: number;
  name: string;
  email: string;
  company: string;
  message: string;
  source_page: string;
  status: string;
  created_at: string;
}
