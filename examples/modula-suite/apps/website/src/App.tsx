import { useCallback, useEffect, useState } from 'react';
import { apiFetch, type RuntimeInfo } from '../../../shared/ui/api';
import { formatCompactMoney } from '../../../shared/ui/format';
import { BlogView, CampaignsView } from './components/BlogAndCampaignsView';
import { LeadsView } from './components/LeadsView';
import { PageBuilderView } from './components/PageBuilderView';
import { StorefrontView } from './components/StorefrontView';
import type { BlogPost, Campaign, CmsPage, StoreOrder, StoreProduct, WebLead, WebsiteOverview } from './types';

export function App() {
  const [tab, setTab] = useState<'builder' | 'store' | 'blog' | 'campaigns' | 'leads'>('builder');
  const [overview, setOverview] = useState<WebsiteOverview | null>(null);
  const [pages, setPages] = useState<CmsPage[]>([]);
  const [selectedPageId, setSelectedPageId] = useState<number>(1);
  const [products, setProducts] = useState<StoreProduct[]>([]);
  const [orders, setOrders] = useState<StoreOrder[]>([]);
  const [posts, setPosts] = useState<BlogPost[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [leads, setLeads] = useState<WebLead[]>([]);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((prev) => (prev === msg ? null : prev)), 2800);
  }, []);

  const loadAll = useCallback(async () => {
    try {
      setError(null);
      const [ov, pgRes, prodRes, ordRes, blRes, cpRes, ldRes, rt] = await Promise.all([
        apiFetch<WebsiteOverview>('/api/overview'),
        apiFetch<{ pages: CmsPage[] }>('/api/pages'),
        apiFetch<{ products: StoreProduct[] }>('/api/store/products'),
        apiFetch<{ orders: StoreOrder[] }>('/api/store/orders'),
        apiFetch<{ posts: BlogPost[] }>('/api/blog'),
        apiFetch<{ campaigns: Campaign[] }>('/api/campaigns'),
        apiFetch<{ leads: WebLead[] }>('/api/leads'),
        apiFetch<RuntimeInfo>('/api/runtime'),
      ]);
      setOverview(ov);
      setPages(pgRes.pages);
      setProducts(prodRes.products);
      setOrders(ordRes.orders);
      setPosts(blRes.posts);
      setCampaigns(cpRes.campaigns);
      setLeads(ldRes.leads);
      setRuntime(rt);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const selectedPage = pages.find((p) => p.id === selectedPageId) ?? pages[0] ?? null;

  return (
    <div className="erp-app" style={{ ['--accent' as string]: '#ea580c', ['--accent-soft' as string]: '#ffedd5', ['--accent-ink' as string]: '#9a3412' }}>
      <header className="erp-topbar">
        <div className="erp-brand">
          <div className="erp-brand-dot">WB</div>
          <div>
            <h1>Website, eCommerce &amp; Marketing</h1>
            <div className="erp-brand-sub">Block Page CMS, Storefront, Blog &amp; Email Campaigns</div>
          </div>
        </div>

        <nav className="erp-tabs" aria-label="Website sections">
          <button type="button" className={`erp-tab ${tab === 'builder' ? 'active' : ''}`} onClick={() => setTab('builder')}>Pages ({pages.length})</button>
          <button type="button" className={`erp-tab ${tab === 'store' ? 'active' : ''}`} onClick={() => setTab('store')}>Storefront ({orders.length})</button>
          <button type="button" className={`erp-tab ${tab === 'blog' ? 'active' : ''}`} onClick={() => setTab('blog')}>Blog ({posts.length})</button>
          <button type="button" className={`erp-tab ${tab === 'campaigns' ? 'active' : ''}`} onClick={() => setTab('campaigns')}>Campaigns ({campaigns.length})</button>
          <button type="button" className={`erp-tab ${tab === 'leads' ? 'active' : ''}`} onClick={() => setTab('leads')}>Leads ({leads.length})</button>
        </nav>
      </header>

      <main className="erp-main">
        {error && <div className="alert alert-danger"><span>{error}</span><button type="button" className="btn btn-sm" onClick={() => setError(null)}>Dismiss</button></div>}

        {overview && (
          <section className="kpi-grid">
            <div className="kpi-card">
              <span className="kpi-label">Published Pages &amp; Blog</span>
              <span className="kpi-value">{overview.publishedPages} / {overview.blogCount}</span>
              <span className="kpi-sub">Live CMS pages · Blog posts</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Storefront Revenue</span>
              <span className="kpi-value" style={{ color: '#059669' }}>{formatCompactMoney(overview.storeRevenue)}</span>
              <span className="kpi-sub">{overview.ordersCount} total order(s)</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Email Campaigns</span>
              <span className="kpi-value">{overview.sentCampaigns} sent</span>
              <span className="kpi-sub">{campaigns.length} total campaigns</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Inbound Web Leads</span>
              <span className="kpi-value">{overview.leadsCount}</span>
              <span className="kpi-sub">Captured into SQLite</span>
            </div>
          </section>
        )}

        {loading ? (
          <div className="panel"><div className="empty-state">Loading CMS from PHP + XDB SQLite...</div></div>
        ) : tab === 'builder' ? (
          <PageBuilderView
            pages={pages}
            selectedPage={selectedPage}
            onSelectPage={(pg) => setSelectedPageId(pg.id)}
            onSavePage={async (pg) => {
              await apiFetch(`/api/pages/${pg.id}`, {
                method: 'PUT',
                body: {
                  title: pg.title,
                  meta_desc: pg.meta_desc,
                  headline: pg.headline,
                  subheadline: pg.subheadline,
                  cta_label: pg.cta_label,
                  accent_color: pg.accent_color,
                  blocks: pg.blocks,
                  published: Boolean(pg.published),
                },
              });
              await loadAll();
              notify(`Saved "${pg.title}" with ${pg.blocks.length} block(s)`);
            }}
            onCreatePage={async (slug, title) => {
              const res = await apiFetch<{ page: CmsPage }>('/api/pages', { method: 'POST', body: { slug, title } });
              await loadAll();
              setSelectedPageId(res.page.id);
              notify(`Created page ${res.page.slug}`);
            }}
          />
        ) : tab === 'store' ? (
          <StorefrontView
            products={products}
            orders={orders}
            onCheckout={async (payload) => {
              await apiFetch('/api/store/orders', { method: 'POST', body: payload });
              await loadAll();
              notify('Order placed & stock updated!');
            }}
            onCreateProduct={async (prod) => {
              await apiFetch('/api/store/products', { method: 'POST', body: prod });
              await loadAll();
              notify('Store product added');
            }}
            onOrderStatus={async (id, status) => {
              await apiFetch(`/api/store/orders/${id}/status`, { method: 'PATCH', body: { status } });
              await loadAll();
              notify(`Order marked ${status}`);
            }}
          />
        ) : tab === 'blog' ? (
          <BlogView
            posts={posts}
            onCreatePost={async (post) => {
              await apiFetch('/api/blog', { method: 'POST', body: post });
              await loadAll();
              notify('Blog article published');
            }}
            onTogglePublish={async (id) => {
              await apiFetch(`/api/blog/${id}/toggle`, { method: 'PATCH' });
              await loadAll();
              notify('Post status updated');
            }}
          />
        ) : tab === 'campaigns' ? (
          <CampaignsView
            campaigns={campaigns}
            onCreateCampaign={async (c) => {
              await apiFetch('/api/campaigns', { method: 'POST', body: c });
              await loadAll();
              notify('Campaign draft saved');
            }}
            onSendCampaign={async (id) => {
              await apiFetch(`/api/campaigns/${id}/send`, { method: 'POST' });
              await loadAll();
              notify('Campaign dispatched to SQLite audience!');
            }}
          />
        ) : (
          <LeadsView
            leads={leads}
            sourceSlug={selectedPage?.slug || '/'}
            onCreateLead={async (lead) => {
              await apiFetch('/api/leads', { method: 'POST', body: lead });
              await loadAll();
              notify('Lead captured');
            }}
            onUpdateStatus={async (id, status) => {
              await apiFetch(`/api/leads/${id}/status`, { method: 'PATCH', body: { status } });
              await loadAll();
              notify('Lead qualified');
            }}
          />
        )}
      </main>

      <footer className="erp-footer">
        <span>Modula Website, eCommerce &amp; Marketing · SoftN v2 React + PHP Container</span>
        {runtime && (
          <span className="runtime-pill">
            <span className="runtime-dot" />
            {runtime.mode === 'zipp-wasm' ? 'PHP 8 (ZIPP WASM)' : 'Standalone PHP'} · {runtime.database}
          </span>
        )}
      </footer>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
