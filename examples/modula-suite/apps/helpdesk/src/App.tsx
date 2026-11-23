import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch, type RuntimeInfo } from '../../../shared/ui/api';
import { formatNumber } from '../../../shared/ui/format';
import { KnowledgeBaseView } from './components/KnowledgeBaseView';
import { MacrosView } from './components/MacrosView';
import { TicketQueueView } from './components/TicketQueueView';
import type { CannedMacro, HelpdeskOverview, KbArticle, Ticket, TicketMessage } from './types';

export function App() {
  const [tab, setTab] = useState<'tickets' | 'kb' | 'macros'>('tickets');
  const [overview, setOverview] = useState<HelpdeskOverview | null>(null);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [messages, setMessages] = useState<TicketMessage[]>([]);
  const [macros, setMacros] = useState<CannedMacro[]>([]);
  const [articles, setArticles] = useState<KbArticle[]>([]);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [showNewTicket, setShowNewTicket] = useState(false);
  const [ticketForm, setTicketForm] = useState({ subject: '', customer_name: '', customer_email: '', priority: 'Normal', tags: 'Support', body: '' });

  const [showNewKb, setShowNewKb] = useState(false);
  const [kbForm, setKbForm] = useState({ title: '', category: 'Operations', body: '' });

  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((prev) => (prev === msg ? null : prev)), 2800);
  }, []);

  const loadMessages = useCallback(async (ticketId: number) => {
    const res = await apiFetch<{ messages: TicketMessage[] }>(`/api/tickets/${ticketId}/messages`);
    setMessages(res.messages);
  }, []);

  const loadAll = useCallback(async () => {
    try {
      setError(null);
      const [ov, tRes, mRes, kRes, rt] = await Promise.all([
        apiFetch<HelpdeskOverview>('/api/overview'),
        apiFetch<{ tickets: Ticket[] }>('/api/tickets'),
        apiFetch<{ macros: CannedMacro[] }>('/api/macros'),
        apiFetch<{ articles: KbArticle[] }>('/api/kb'),
        apiFetch<RuntimeInfo>('/api/runtime'),
      ]);
      setOverview(ov);
      setTickets(tRes.tickets);
      setMacros(mRes.macros);
      setArticles(kRes.articles);
      setRuntime(rt);
      if (tRes.tickets.length > 0 && selectedId === null) {
        const firstId = tRes.tickets[0].id;
        setSelectedId(firstId);
        void loadMessages(firstId);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [loadMessages, selectedId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const handleSelectTicket = (id: number) => {
    setSelectedId(id);
    void loadMessages(id);
  };

  const handleUpdateTicket = async (id: number, patch: { stage?: string; priority?: string; csat_rating?: number }) => {
    await apiFetch(`/api/tickets/${id}`, { method: 'PATCH', body: patch });
    await loadAll();
    notify('Ticket updated');
  };

  const handleSendMessage = async (ticketId: number, body: string, isInternal: boolean) => {
    await apiFetch(`/api/tickets/${ticketId}/messages`, { method: 'POST', body: { author: 'Samira Khan', is_internal: isInternal, body } });
    await loadMessages(ticketId);
    notify(isInternal ? 'Internal note logged' : 'Reply sent');
  };

  const handleCreateTicket = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await apiFetch<{ ticket: Ticket }>('/api/tickets', { method: 'POST', body: ticketForm });
    setShowNewTicket(false);
    setTicketForm({ subject: '', customer_name: '', customer_email: '', priority: 'Normal', tags: 'Support', body: '' });
    await loadAll();
    handleSelectTicket(res.ticket.id);
    notify(`Ticket ${res.ticket.ticket_number} created`);
  };

  const handleCreateKb = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch('/api/kb', { method: 'POST', body: kbForm });
    setShowNewKb(false);
    setKbForm({ title: '', category: 'Operations', body: '' });
    await loadAll();
    notify('Knowledge article published');
  };

  return (
    <div className="erp-app" style={{ ['--accent' as string]: '#059669', ['--accent-soft' as string]: '#d1fae5', ['--accent-ink' as string]: '#065f46' }}>
      <header className="erp-topbar">
        <div className="erp-brand">
          <div className="erp-brand-dot">HD</div>
          <div>
            <h1>Helpdesk &amp; Knowledge</h1>
            <div className="erp-brand-sub">SLA Triage, CSAT Ratings, Canned Macros &amp; Full CRUD SOP Wiki</div>
          </div>
        </div>

        <nav className="erp-tabs" aria-label="Helpdesk sections">
          <button type="button" className={`erp-tab ${tab === 'tickets' ? 'active' : ''}`} onClick={() => setTab('tickets')}>Tickets ({tickets.length})</button>
          <button type="button" className={`erp-tab ${tab === 'kb' ? 'active' : ''}`} onClick={() => setTab('kb')}>Knowledge Base ({articles.length})</button>
          <button type="button" className={`erp-tab ${tab === 'macros' ? 'active' : ''}`} onClick={() => setTab('macros')}>Canned Macros ({macros.length})</button>
        </nav>

        <div className="erp-actions">
          {tab === 'kb' ? (
            <button type="button" className="btn btn-primary" onClick={() => setShowNewKb(true)}>+ New Article</button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => setShowNewTicket(true)}>+ New Ticket</button>
          )}
        </div>
      </header>

      <main className="erp-main">
        {error && <div className="alert alert-danger"><span>{error}</span><button type="button" className="btn btn-sm" onClick={() => setError(null)}>Dismiss</button></div>}

        {overview && (
          <section className="kpi-grid">
            <div className="kpi-card">
              <span className="kpi-label">Open Tickets</span>
              <span className="kpi-value">{overview.openTickets}</span>
              <span className="kpi-sub">{overview.highPriority} high/urgent priority</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Resolved Tickets</span>
              <span className="kpi-value" style={{ color: '#059669' }}>{overview.solvedTickets}</span>
              <span className="kpi-sub">SLA targets met</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Customer CSAT</span>
              <span className="kpi-value" style={{ color: '#d97706' }}>{formatNumber(overview.avgCsat, 1)} ★</span>
              <span className="kpi-sub">Across {overview.ratedCount} rated resolution(s)</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Knowledge &amp; Macros</span>
              <span className="kpi-value">{overview.kbArticles} / {macros.length}</span>
              <span className="kpi-sub">Published SOPs · Reply macros</span>
            </div>
          </section>
        )}

        {loading ? (
          <div className="panel"><div className="empty-state">Loading helpdesk from PHP + XDB SQLite...</div></div>
        ) : tab === 'tickets' ? (
          <TicketQueueView
            tickets={tickets}
            selectedId={selectedId}
            messages={messages}
            macros={macros}
            articles={articles}
            onSelectTicket={handleSelectTicket}
            onUpdateTicket={handleUpdateTicket}
            onSendMessage={handleSendMessage}
          />
        ) : tab === 'kb' ? (
          <KnowledgeBaseView
            articles={articles}
            onVote={async (id) => {
              await apiFetch(`/api/kb/${id}/vote`, { method: 'POST' });
              await loadAll();
              notify('Thanks for voting!');
            }}
            onUpdate={async (id, data) => {
              await apiFetch(`/api/kb/${id}`, { method: 'PUT', body: data });
              await loadAll();
              notify('Knowledge article updated');
            }}
            onDelete={async (id) => {
              await apiFetch(`/api/kb/${id}`, { method: 'DELETE' });
              await loadAll();
              notify('Article removed');
            }}
          />
        ) : (
          <MacrosView
            macros={macros}
            onCreate={async (macro) => {
              await apiFetch('/api/macros', { method: 'POST', body: macro });
              await loadAll();
              notify('Canned macro saved');
            }}
            onDelete={async (id) => {
              await apiFetch(`/api/macros/${id}`, { method: 'DELETE' });
              await loadAll();
              notify('Macro deleted');
            }}
          />
        )}
      </main>

      <footer className="erp-footer">
        <span>Modula Helpdesk &amp; Knowledge · SoftN v2 React + PHP Container</span>
        {runtime && (
          <span className="runtime-pill">
            <span className="runtime-dot" />
            {runtime.mode === 'zipp-wasm' ? 'PHP 8 (ZIPP WASM)' : 'Standalone PHP'} · {runtime.database}
          </span>
        )}
      </footer>

      {showNewTicket && (
        <div className="modal-backdrop" onClick={() => setShowNewTicket(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void handleCreateTicket(e)}>
            <div className="modal-head"><h3>Create Support Ticket</h3><button type="button" className="btn btn-sm" onClick={() => setShowNewTicket(false)}>Cancel</button></div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field full"><label>Subject *</label><input className="input" required value={ticketForm.subject} onChange={(e) => setTicketForm({ ...ticketForm, subject: e.target.value })} /></div>
                <div className="field"><label>Customer Name *</label><input className="input" required value={ticketForm.customer_name} onChange={(e) => setTicketForm({ ...ticketForm, customer_name: e.target.value })} /></div>
                <div className="field"><label>Customer Email</label><input className="input" type="email" value={ticketForm.customer_email} onChange={(e) => setTicketForm({ ...ticketForm, customer_email: e.target.value })} /></div>
                <div className="field"><label>Priority</label><select className="select" value={ticketForm.priority} onChange={(e) => setTicketForm({ ...ticketForm, priority: e.target.value })}><option value="Low">Low</option><option value="Normal">Normal</option><option value="High">High</option><option value="Urgent">Urgent</option></select></div>
                <div className="field"><label>Tags</label><input className="input" value={ticketForm.tags} onChange={(e) => setTicketForm({ ...ticketForm, tags: e.target.value })} /></div>
                <div className="field full"><label>Initial Message</label><textarea className="textarea" value={ticketForm.body} onChange={(e) => setTicketForm({ ...ticketForm, body: e.target.value })} /></div>
              </div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setShowNewTicket(false)}>Cancel</button><button type="submit" className="btn btn-primary">Open Ticket</button></div>
          </form>
        </div>
      )}

      {showNewKb && (
        <div className="modal-backdrop" onClick={() => setShowNewKb(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void handleCreateKb(e)}>
            <div className="modal-head"><h3>Publish Knowledge Article</h3><button type="button" className="btn btn-sm" onClick={() => setShowNewKb(false)}>Cancel</button></div>
            <div className="modal-body">
              <div className="field"><label>Title *</label><input className="input" required value={kbForm.title} onChange={(e) => setKbForm({ ...kbForm, title: e.target.value })} /></div>
              <div className="field"><label>Category</label><input className="input" value={kbForm.category} onChange={(e) => setKbForm({ ...kbForm, category: e.target.value })} /></div>
              <div className="field"><label>Article Body *</label><textarea className="textarea" style={{ minHeight: '140px' }} required value={kbForm.body} onChange={(e) => setKbForm({ ...kbForm, body: e.target.value })} /></div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setShowNewKb(false)}>Cancel</button><button type="submit" className="btn btn-primary">Publish</button></div>
          </form>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
