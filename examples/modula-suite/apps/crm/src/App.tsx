import { useCallback, useEffect, useState } from 'react';
import { apiFetch, type RuntimeInfo } from '../../../shared/ui/api';
import { formatCompactMoney, formatMoney, formatPercent } from '../../../shared/ui/format';
import { LeadsQueueView, SubscriptionsView } from './components/LeadsAndSubscriptionsView';
import { PipelineView } from './components/PipelineView';
import { AnalyticsView, ContactsView, QuotesView } from './components/QuotesContactsAnalyticsView';
import {
  PIPELINE_STAGES,
  type Activity,
  type Contact,
  type CrmLead,
  type CrmOverview,
  type Deal,
  type Quote,
  type QuoteLine,
  type Subscription,
} from './types';

export function App() {
  const [tab, setTab] = useState<'pipeline' | 'leads' | 'quotes' | 'subscriptions' | 'contacts' | 'analytics'>('pipeline');
  const [search, setSearch] = useState('');
  const [overview, setOverview] = useState<CrmOverview | null>(null);
  const [leads, setLeads] = useState<CrmLead[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [selectedDeal, setSelectedDeal] = useState<Deal | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);

  const [showNewDeal, setShowNewDeal] = useState(false);
  const [dealForm, setDealForm] = useState({
    title: '', company: '', contact_name: '', contact_email: '', stage: 'New',
    expected_revenue: '25000', priority: '2', close_date: '2026-12-30', notes: '',
  });
  const [showNewLead, setShowNewLead] = useState(false);
  const [leadForm, setLeadForm] = useState({
    name: '', company: '', email: '', phone: '', source: 'Website', est_budget: '30000', team_size: '25', notes: '',
  });
  const [showNewContact, setShowNewContact] = useState(false);
  const [contactForm, setContactForm] = useState({
    name: '', company: '', email: '', phone: '', role_title: '', tag: 'Prospect',
  });
  const [showNewQuote, setShowNewQuote] = useState(false);
  const [quoteCustomer, setQuoteCustomer] = useState('');
  const [quoteDealId, setQuoteDealId] = useState('');
  const [quoteTaxRate, setQuoteTaxRate] = useState('10');
  const [quoteLines, setQuoteLines] = useState<QuoteLine[]>([{ description: 'Modula Suite Deployment', qty: 1, unitPrice: 12000 }]);
  const [showNewSub, setShowNewSub] = useState(false);
  const [subForm, setSubForm] = useState({
    customer_name: '', plan_name: 'Managed PHP Hosting + Support', billing_cycle: 'Monthly', mrr: '490', seats: '20',
  });

  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((prev) => (prev === msg ? null : prev)), 2800);
  }, []);

  const loadAll = useCallback(async () => {
    try {
      setError(null);
      const [ov, lRes, dRes, cRes, qRes, sRes, rt] = await Promise.all([
        apiFetch<CrmOverview>('/api/overview'),
        apiFetch<{ leads: CrmLead[] }>('/api/leads'),
        apiFetch<{ deals: Deal[] }>('/api/deals'),
        apiFetch<{ contacts: Contact[] }>('/api/contacts'),
        apiFetch<{ quotes: Quote[] }>('/api/quotes'),
        apiFetch<{ subscriptions: Subscription[] }>('/api/subscriptions'),
        apiFetch<RuntimeInfo>('/api/runtime'),
      ]);
      setOverview(ov);
      setLeads(lRes.leads);
      setDeals(dRes.deals);
      setContacts(cRes.contacts);
      setQuotes(qRes.quotes);
      setSubscriptions(sRes.subscriptions);
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

  const openDeal = async (deal: Deal) => {
    setSelectedDeal(deal);
    const res = await apiFetch<{ activities: Activity[] }>(`/api/deals/${deal.id}/activities`);
    setActivities(res.activities);
  };

  const handleStageChange = async (dealId: number, stage: string, lostReason = '') => {
    const res = await apiFetch<{ deal: Deal }>(`/api/deals/${dealId}/stage`, { method: 'PATCH', body: { stage, lost_reason: lostReason } });
    await loadAll();
    if (selectedDeal && selectedDeal.id === dealId) {
      setSelectedDeal(res.deal);
      const aRes = await apiFetch<{ activities: Activity[] }>(`/api/deals/${dealId}/activities`);
      setActivities(aRes.activities);
    }
    notify(`Deal moved to ${stage}`);
  };

  const qLower = search.trim().toLowerCase();
  const filteredDeals = deals.filter((d) => !qLower || d.title.toLowerCase().includes(qLower) || d.company.toLowerCase().includes(qLower) || d.contact_name.toLowerCase().includes(qLower));
  const filteredContacts = contacts.filter((c) => !qLower || c.name.toLowerCase().includes(qLower) || c.company.toLowerCase().includes(qLower) || c.email.toLowerCase().includes(qLower));
  const quoteTotal = quoteLines.reduce((acc, l) => acc + l.qty * l.unitPrice, 0) * (1 + (Number(quoteTaxRate) || 0) / 100);

  return (
    <div className="erp-app" style={{ ['--accent' as string]: '#0d9488', ['--accent-soft' as string]: '#ccfbf1', ['--accent-ink' as string]: '#115e59' }}>
      <header className="erp-topbar">
        <div className="erp-brand">
          <div className="erp-brand-dot">CR</div>
          <div>
            <h1>CRM, Sales &amp; Subscriptions</h1>
            <div className="erp-brand-sub">Lead Scoring, Pipeline, Quotations, Recurring MRR &amp; Analytics</div>
          </div>
        </div>

        <nav className="erp-tabs" aria-label="CRM sections">
          <button type="button" className={`erp-tab ${tab === 'pipeline' ? 'active' : ''}`} onClick={() => setTab('pipeline')}>Pipeline ({deals.filter((d) => d.stage !== 'Lost').length})</button>
          <button type="button" className={`erp-tab ${tab === 'leads' ? 'active' : ''}`} onClick={() => setTab('leads')}>Leads ({leads.filter((l) => l.status === 'Open').length})</button>
          <button type="button" className={`erp-tab ${tab === 'quotes' ? 'active' : ''}`} onClick={() => setTab('quotes')}>Quotes ({quotes.length})</button>
          <button type="button" className={`erp-tab ${tab === 'subscriptions' ? 'active' : ''}`} onClick={() => setTab('subscriptions')}>Subscriptions ({subscriptions.length})</button>
          <button type="button" className={`erp-tab ${tab === 'contacts' ? 'active' : ''}`} onClick={() => setTab('contacts')}>Contacts ({contacts.length})</button>
          <button type="button" className={`erp-tab ${tab === 'analytics' ? 'active' : ''}`} onClick={() => setTab('analytics')}>Forecasting</button>
        </nav>

        <div className="erp-actions">
          <input className="input" type="search" placeholder="Search..." style={{ width: '160px' }} value={search} onChange={(e) => setSearch(e.target.value)} />
          {tab === 'pipeline' && <button id="new-deal-btn" type="button" className="btn btn-primary" onClick={() => setShowNewDeal(true)}>+ Opportunity</button>}
          {tab === 'leads' && <button type="button" className="btn btn-primary" onClick={() => setShowNewLead(true)}>+ Lead</button>}
          {tab === 'quotes' && <button type="button" className="btn btn-primary" onClick={() => setShowNewQuote(true)}>+ Quotation</button>}
          {tab === 'subscriptions' && <button type="button" className="btn btn-primary" onClick={() => setShowNewSub(true)}>+ Subscription</button>}
          {tab === 'contacts' && <button type="button" className="btn btn-primary" onClick={() => setShowNewContact(true)}>+ Contact</button>}
        </div>
      </header>

      <main className="erp-main">
        {error && <div className="alert alert-danger"><span>{error}</span><button type="button" className="btn btn-sm" onClick={() => setError(null)}>Dismiss</button></div>}

        {overview && (
          <section className="kpi-grid">
            <div className="kpi-card">
              <span className="kpi-label">Open Pipeline</span>
              <span className="kpi-value" id="kpi-pipeline">{formatCompactMoney(overview.openPipeline)}</span>
              <span className="kpi-sub">{overview.openDeals} active · {overview.pendingActivities} scheduled follow-ups</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Weighted Forecast</span>
              <span className="kpi-value">{formatCompactMoney(overview.weightedForecast)}</span>
              <span className="kpi-sub">{overview.openLeads} scored leads awaiting qualification</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Closed Won</span>
              <span className="kpi-value" style={{ color: '#059669' }}>{formatCompactMoney(overview.wonRevenue)}</span>
              <span className="kpi-sub">{overview.wonDeals} won / {overview.lostDeals} lost · {formatPercent(overview.winRate)} win rate</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Active Recurring MRR</span>
              <span className="kpi-value" style={{ color: '#0d9488' }}>{formatMoney(overview.activeMrr)}</span>
              <span className="kpi-sub">ARR {formatCompactMoney(overview.activeArr)}</span>
            </div>
          </section>
        )}

        {loading ? (
          <div className="panel"><div className="empty-state">Loading CRM records from PHP + XDB SQLite...</div></div>
        ) : tab === 'pipeline' ? (
          <PipelineView
            deals={filteredDeals}
            selectedDeal={selectedDeal}
            activities={activities}
            onOpenDeal={openDeal}
            onCloseDeal={() => setSelectedDeal(null)}
            onStageChange={handleStageChange}
            onAddActivity={async (dealId, kind, summary, dueDate) => {
              await apiFetch(`/api/deals/${dealId}/activities`, { method: 'POST', body: { kind, summary, author: 'Alex Rivera', due_date: dueDate } });
              const aRes = await apiFetch<{ activities: Activity[] }>(`/api/deals/${dealId}/activities`);
              setActivities(aRes.activities);
              await loadAll();
              notify(dueDate ? 'Follow-up scheduled' : 'Activity logged');
            }}
            onToggleActivity={async (actId) => {
              if (!selectedDeal) return;
              await apiFetch(`/api/activities/${actId}/toggle`, { method: 'PATCH' });
              const aRes = await apiFetch<{ activities: Activity[] }>(`/api/deals/${selectedDeal.id}/activities`);
              setActivities(aRes.activities);
              await loadAll();
            }}
          />
        ) : tab === 'leads' ? (
          <LeadsQueueView
            leads={leads}
            onConvertLead={async (lead) => {
              await apiFetch(`/api/leads/${lead.id}/convert`, { method: 'POST', body: { owner_name: 'Alex Rivera' } });
              await loadAll();
              setTab('pipeline');
              notify(`Converted ${lead.company || lead.name} to Qualified Deal!`);
            }}
          />
        ) : tab === 'quotes' ? (
          <QuotesView
            quotes={quotes}
            onQuoteStatus={async (id, status) => {
              await apiFetch(`/api/quotes/${id}/status`, { method: 'PATCH', body: { status } });
              await loadAll();
              notify(`Quotation marked ${status}`);
            }}
          />
        ) : tab === 'subscriptions' ? (
          <SubscriptionsView
            subscriptions={subscriptions}
            onStatusChange={async (id, status) => {
              await apiFetch(`/api/subscriptions/${id}/status`, { method: 'PATCH', body: { status } });
              await loadAll();
              notify(`Subscription marked ${status}`);
            }}
          />
        ) : tab === 'contacts' ? (
          <ContactsView contacts={filteredContacts} />
        ) : (
          <AnalyticsView overview={overview} />
        )}
      </main>

      <footer className="erp-footer">
        <span>Modula CRM, Sales &amp; Subscriptions · SoftN v2 React + PHP Container</span>
        {runtime && (
          <span className="runtime-pill">
            <span className="runtime-dot" />
            {runtime.mode === 'zipp-wasm' ? 'PHP 8 (ZIPP WASM)' : 'Standalone PHP'} · {runtime.database}
          </span>
        )}
      </footer>

      {showNewDeal && (
        <div className="modal-backdrop" onClick={() => setShowNewDeal(false)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              await apiFetch('/api/deals', { method: 'POST', body: { ...dealForm, expected_revenue: Number(dealForm.expected_revenue) || 0, priority: Number(dealForm.priority) || 2 } });
              setShowNewDeal(false);
              setDealForm({ title: '', company: '', contact_name: '', contact_email: '', stage: 'New', expected_revenue: '25000', priority: '2', close_date: '2026-12-30', notes: '' });
              await loadAll();
              notify('Opportunity added');
            }}
          >
            <div className="modal-head"><h3>New Opportunity</h3><button type="button" className="btn btn-sm" onClick={() => setShowNewDeal(false)}>Cancel</button></div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field full"><label>Opportunity Title *</label><input id="deal-title-input" className="input" required value={dealForm.title} onChange={(e) => setDealForm({ ...dealForm, title: e.target.value })} /></div>
                <div className="field"><label>Company</label><input className="input" value={dealForm.company} onChange={(e) => setDealForm({ ...dealForm, company: e.target.value })} /></div>
                <div className="field"><label>Contact Name</label><input className="input" value={dealForm.contact_name} onChange={(e) => setDealForm({ ...dealForm, contact_name: e.target.value })} /></div>
                <div className="field"><label>Expected Revenue ($)</label><input className="input" type="number" value={dealForm.expected_revenue} onChange={(e) => setDealForm({ ...dealForm, expected_revenue: e.target.value })} /></div>
                <div className="field"><label>Stage</label><select className="select" value={dealForm.stage} onChange={(e) => setDealForm({ ...dealForm, stage: e.target.value })}>{PIPELINE_STAGES.map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
                <div className="field"><label>Priority</label><select className="select" value={dealForm.priority} onChange={(e) => setDealForm({ ...dealForm, priority: e.target.value })}><option value="1">★ Normal</option><option value="2">★★ High</option><option value="3">★★★ Urgent</option></select></div>
                <div className="field"><label>Close Date</label><input className="input" type="date" value={dealForm.close_date} onChange={(e) => setDealForm({ ...dealForm, close_date: e.target.value })} /></div>
                <div className="field full"><label>Notes</label><textarea className="textarea" value={dealForm.notes} onChange={(e) => setDealForm({ ...dealForm, notes: e.target.value })} /></div>
              </div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setShowNewDeal(false)}>Cancel</button><button id="save-deal-btn" type="submit" className="btn btn-primary">Create Opportunity</button></div>
          </form>
        </div>
      )}

      {showNewLead && (
        <div className="modal-backdrop" onClick={() => setShowNewLead(false)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              await apiFetch('/api/leads', { method: 'POST', body: { ...leadForm, est_budget: Number(leadForm.est_budget) || 0, team_size: Number(leadForm.team_size) || 10 } });
              setShowNewLead(false);
              setLeadForm({ name: '', company: '', email: '', phone: '', source: 'Website', est_budget: '30000', team_size: '25', notes: '' });
              await loadAll();
              notify('Lead scored & saved');
            }}
          >
            <div className="modal-head"><h3>Capture Inbound Lead</h3><button type="button" className="btn btn-sm" onClick={() => setShowNewLead(false)}>Cancel</button></div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field"><label>Lead Name *</label><input className="input" required value={leadForm.name} onChange={(e) => setLeadForm({ ...leadForm, name: e.target.value })} /></div>
                <div className="field"><label>Company</label><input className="input" value={leadForm.company} onChange={(e) => setLeadForm({ ...leadForm, company: e.target.value })} /></div>
                <div className="field"><label>Email</label><input className="input" type="email" value={leadForm.email} onChange={(e) => setLeadForm({ ...leadForm, email: e.target.value })} /></div>
                <div className="field"><label>Source</label><select className="select" value={leadForm.source} onChange={(e) => setLeadForm({ ...leadForm, source: e.target.value })}><option value="Website">Website</option><option value="Referral">Referral</option><option value="Partner">Partner</option><option value="Trade Show">Trade Show</option></select></div>
                <div className="field"><label>Budget ($)</label><input className="input" type="number" value={leadForm.est_budget} onChange={(e) => setLeadForm({ ...leadForm, est_budget: e.target.value })} /></div>
                <div className="field"><label>Team Size</label><input className="input" type="number" value={leadForm.team_size} onChange={(e) => setLeadForm({ ...leadForm, team_size: e.target.value })} /></div>
                <div className="field full"><label>Notes</label><textarea className="textarea" value={leadForm.notes} onChange={(e) => setLeadForm({ ...leadForm, notes: e.target.value })} /></div>
              </div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setShowNewLead(false)}>Cancel</button><button type="submit" className="btn btn-primary">Auto-Score &amp; Save</button></div>
          </form>
        </div>
      )}

      {showNewSub && (
        <div className="modal-backdrop" onClick={() => setShowNewSub(false)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              await apiFetch('/api/subscriptions', { method: 'POST', body: { ...subForm, mrr: Number(subForm.mrr) || 0, seats: Number(subForm.seats) || 1 } });
              setShowNewSub(false);
              setSubForm({ customer_name: '', plan_name: 'Managed PHP Hosting + Support', billing_cycle: 'Monthly', mrr: '490', seats: '20' });
              await loadAll();
              notify('Subscription activated');
            }}
          >
            <div className="modal-head"><h3>New Recurring Subscription</h3><button type="button" className="btn btn-sm" onClick={() => setShowNewSub(false)}>Cancel</button></div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field full"><label>Customer *</label><input className="input" required value={subForm.customer_name} onChange={(e) => setSubForm({ ...subForm, customer_name: e.target.value })} /></div>
                <div className="field full"><label>Plan *</label><input className="input" required value={subForm.plan_name} onChange={(e) => setSubForm({ ...subForm, plan_name: e.target.value })} /></div>
                <div className="field"><label>Cycle</label><select className="select" value={subForm.billing_cycle} onChange={(e) => setSubForm({ ...subForm, billing_cycle: e.target.value })}><option value="Monthly">Monthly</option><option value="Annual">Annual</option></select></div>
                <div className="field"><label>MRR ($/mo)</label><input className="input" type="number" step="0.01" value={subForm.mrr} onChange={(e) => setSubForm({ ...subForm, mrr: e.target.value })} /></div>
                <div className="field"><label>Seats</label><input className="input" type="number" value={subForm.seats} onChange={(e) => setSubForm({ ...subForm, seats: e.target.value })} /></div>
              </div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setShowNewSub(false)}>Cancel</button><button type="submit" className="btn btn-primary">Activate</button></div>
          </form>
        </div>
      )}

      {showNewContact && (
        <div className="modal-backdrop" onClick={() => setShowNewContact(false)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              await apiFetch('/api/contacts', { method: 'POST', body: contactForm });
              setShowNewContact(false);
              setContactForm({ name: '', company: '', email: '', phone: '', role_title: '', tag: 'Prospect' });
              await loadAll();
              notify('Contact saved');
            }}
          >
            <div className="modal-head"><h3>New Contact</h3><button type="button" className="btn btn-sm" onClick={() => setShowNewContact(false)}>Cancel</button></div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field"><label>Name *</label><input className="input" required value={contactForm.name} onChange={(e) => setContactForm({ ...contactForm, name: e.target.value })} /></div>
                <div className="field"><label>Company</label><input className="input" value={contactForm.company} onChange={(e) => setContactForm({ ...contactForm, company: e.target.value })} /></div>
                <div className="field"><label>Email</label><input className="input" type="email" value={contactForm.email} onChange={(e) => setContactForm({ ...contactForm, email: e.target.value })} /></div>
                <div className="field"><label>Phone</label><input className="input" value={contactForm.phone} onChange={(e) => setContactForm({ ...contactForm, phone: e.target.value })} /></div>
                <div className="field"><label>Title</label><input className="input" value={contactForm.role_title} onChange={(e) => setContactForm({ ...contactForm, role_title: e.target.value })} /></div>
                <div className="field"><label>Segment</label><select className="select" value={contactForm.tag} onChange={(e) => setContactForm({ ...contactForm, tag: e.target.value })}><option value="Prospect">Prospect</option><option value="Customer">Customer</option><option value="Enterprise">Enterprise</option><option value="Partner">Partner</option></select></div>
              </div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setShowNewContact(false)}>Cancel</button><button type="submit" className="btn btn-primary">Save</button></div>
          </form>
        </div>
      )}

      {showNewQuote && (
        <div className="modal-backdrop" onClick={() => setShowNewQuote(false)}>
          <form
            className="modal modal-wide"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              await apiFetch('/api/quotes', { method: 'POST', body: { customer_name: quoteCustomer, deal_id: quoteDealId ? Number(quoteDealId) : null, tax_rate: Number(quoteTaxRate) || 0, items: quoteLines } });
              setShowNewQuote(false);
              setQuoteCustomer('');
              setQuoteDealId('');
              setQuoteLines([{ description: 'Modula Suite Deployment', qty: 1, unitPrice: 12000 }]);
              await loadAll();
              notify('Quotation generated');
            }}
          >
            <div className="modal-head"><h3>New Sales Quotation</h3><button type="button" className="btn btn-sm" onClick={() => setShowNewQuote(false)}>Cancel</button></div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field"><label>Customer *</label><input className="input" required value={quoteCustomer} onChange={(e) => setQuoteCustomer(e.target.value)} /></div>
                <div className="field">
                  <label>Link to Deal</label>
                  <select className="select" value={quoteDealId} onChange={(e) => { setQuoteDealId(e.target.value); const f = deals.find((d) => String(d.id) === e.target.value); if (f && !quoteCustomer) setQuoteCustomer(f.company || f.title); }}>
                    <option value="">None</option>
                    {deals.map((d) => <option key={d.id} value={d.id}>{d.title} ({d.company})</option>)}
                  </select>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong style={{ fontSize: '12.5px' }}>Line Items</strong>
                <button type="button" className="btn btn-sm" onClick={() => setQuoteLines([...quoteLines, { description: '', qty: 1, unitPrice: 0 }])}>+ Add Line</button>
              </div>
              {quoteLines.map((line, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 75px 110px 36px', gap: '6px' }}>
                  <input className="input" placeholder="Description" value={line.description} onChange={(e) => { const n = [...quoteLines]; n[i] = { ...n[i], description: e.target.value }; setQuoteLines(n); }} />
                  <input className="input" type="number" min="1" value={line.qty} onChange={(e) => { const n = [...quoteLines]; n[i] = { ...n[i], qty: Number(e.target.value) || 1 }; setQuoteLines(n); }} />
                  <input className="input" type="number" min="0" step="0.01" value={line.unitPrice} onChange={(e) => { const n = [...quoteLines]; n[i] = { ...n[i], unitPrice: Number(e.target.value) || 0 }; setQuoteLines(n); }} />
                  <button type="button" className="btn btn-sm btn-danger" disabled={quoteLines.length <= 1} onClick={() => setQuoteLines(quoteLines.filter((_, idx) => idx !== i))}>×</button>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '8px', borderTop: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><label style={{ fontSize: '12px' }}>Tax %</label><input className="input" style={{ width: '70px' }} type="number" value={quoteTaxRate} onChange={(e) => setQuoteTaxRate(e.target.value)} /></div>
                <strong style={{ fontSize: '16px', fontVariantNumeric: 'tabular-nums' }}>Total: {formatMoney(quoteTotal)}</strong>
              </div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setShowNewQuote(false)}>Cancel</button><button type="submit" className="btn btn-primary">Create Quotation</button></div>
          </form>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
