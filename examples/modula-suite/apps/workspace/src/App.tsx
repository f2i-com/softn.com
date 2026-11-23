import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, type RuntimeInfo } from '../../../shared/ui/api';
import { formatMoney } from '../../../shared/ui/format';
import { ApprovalsInboxView } from './components/ApprovalsInboxView';
import { DiscussChannelsView } from './components/DiscussChannelsView';
import { DocumentsVaultView } from './components/DocumentsVaultView';
import { SignRequestsView } from './components/SignRequestsView';
import type {
  ApprovalRequest,
  ChannelMessage,
  DiscussChannel,
  SignRequest,
  VaultDocument,
  WorkspaceOverview,
} from './types';

export function App() {
  const [tab, setTab] = useState<'documents' | 'sign' | 'approvals' | 'discuss'>('documents');
  const [overview, setOverview] = useState<WorkspaceOverview | null>(null);
  const [documents, setDocuments] = useState<VaultDocument[]>([]);
  const [signs, setSigns] = useState<SignRequest[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [channels, setChannels] = useState<DiscussChannel[]>([]);
  const [activeChannel, setActiveChannel] = useState<DiscussChannel | null>(null);
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  const activeChannelIdRef = useRef<number | null>(null);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [showNewDoc, setShowNewDoc] = useState(false);
  const [docForm, setDocForm] = useState({ title: '', folder: 'Contracts', doc_type: 'Contract', owner_name: 'Alex Rivera', version_label: 'v1.0', tags: 'legal', content_text: '' });

  const [signTargetDoc, setSignTargetDoc] = useState<VaultDocument | null>(null);
  const [signForm, setSignForm] = useState({ signer_name: '', signer_email: '' });

  const [showNewApproval, setShowNewApproval] = useState(false);
  const [approvalForm, setApprovalForm] = useState({ category: 'Purchase', title: '', requester_name: 'Alex Rivera', amount: '650', justification: '' });

  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((prev) => (prev === msg ? null : prev)), 2800);
  }, []);

  const loadChannelMessages = useCallback(async (ch: DiscussChannel) => {
    activeChannelIdRef.current = ch.id;
    setActiveChannel(ch);
    const mRes = await apiFetch<{ messages: ChannelMessage[] }>(`/api/channels/${ch.id}/messages`);
    setMessages(mRes.messages);
  }, []);

  const loadAll = useCallback(async () => {
    try {
      setError(null);
      const [ov, dRes, sRes, aRes, cRes, rt] = await Promise.all([
        apiFetch<WorkspaceOverview>('/api/overview'),
        apiFetch<{ documents: VaultDocument[] }>('/api/documents'),
        apiFetch<{ signs: SignRequest[] }>('/api/signs'),
        apiFetch<{ approvals: ApprovalRequest[] }>('/api/approvals'),
        apiFetch<{ channels: DiscussChannel[] }>('/api/channels'),
        apiFetch<RuntimeInfo>('/api/runtime'),
      ]);
      setOverview(ov);
      setDocuments(dRes.documents);
      setSigns(sRes.signs);
      setApprovals(aRes.approvals);
      setChannels(cRes.channels);
      setRuntime(rt);
      if (cRes.channels.length > 0) {
        const target =
          cRes.channels.find((c) => c.id === activeChannelIdRef.current) ?? cRes.channels[0];
        activeChannelIdRef.current = target.id;
        setActiveChannel(target);
        const mRes = await apiFetch<{ messages: ChannelMessage[] }>(`/api/channels/${target.id}/messages`);
        setMessages(mRes.messages);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  return (
    <div className="erp-app" style={{ ['--accent' as string]: '#4f46e5', ['--accent-soft' as string]: '#e0e7ff', ['--accent-ink' as string]: '#3730a3' }}>
      <header className="erp-topbar">
        <div className="erp-brand">
          <div className="erp-brand-dot">WS</div>
          <div>
            <h1>Documents, eSign, Approvals &amp; Discuss</h1>
            <div className="erp-brand-sub">Document Vault, SHA-256 Electronic Signatures, Approval Inbox &amp; Team Chat</div>
          </div>
        </div>

        <nav className="erp-tabs" aria-label="Workspace sections">
          <button type="button" className={`erp-tab ${tab === 'documents' ? 'active' : ''}`} onClick={() => setTab('documents')}>Documents ({documents.length})</button>
          <button type="button" className={`erp-tab ${tab === 'sign' ? 'active' : ''}`} onClick={() => setTab('sign')}>eSign ({signs.length})</button>
          <button type="button" className={`erp-tab ${tab === 'approvals' ? 'active' : ''}`} onClick={() => setTab('approvals')}>Approvals ({approvals.filter((a) => a.status === 'Pending').length})</button>
          <button type="button" className={`erp-tab ${tab === 'discuss' ? 'active' : ''}`} onClick={() => setTab('discuss')}>Discuss ({channels.length})</button>
        </nav>

        <div className="erp-actions">
          {tab === 'documents' && <button type="button" className="btn btn-primary" onClick={() => setShowNewDoc(true)}>+ Document</button>}
          {tab === 'approvals' && <button type="button" className="btn btn-primary" onClick={() => setShowNewApproval(true)}>+ Request Approval</button>}
        </div>
      </header>

      <main className="erp-main">
        {error && <div className="alert alert-danger"><span>{error}</span><button type="button" className="btn btn-sm" onClick={() => setError(null)}>Dismiss</button></div>}

        {overview && (
          <section className="kpi-grid">
            <div className="kpi-card">
              <span className="kpi-label">Vault Documents</span>
              <span className="kpi-value">{overview.totalDocs}</span>
              <span className="kpi-sub">Versioned files stored in XDB SQLite</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">eSign Envelopes</span>
              <span className="kpi-value">{overview.pendingSigns} pending</span>
              <span className="kpi-sub">{overview.signedCount} sealed with SHA-256 hash</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Pending Approvals</span>
              <span className="kpi-value" style={{ color: overview.pendingApprovals > 0 ? '#d97706' : '#059669' }}>{overview.pendingApprovals}</span>
              <span className="kpi-sub">{formatMoney(overview.approvedAmount)} approved to date</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Discuss Activity</span>
              <span className="kpi-value" style={{ color: '#4f46e5' }}>{overview.totalMessages}</span>
              <span className="kpi-sub">{channels.length} persistent team channels</span>
            </div>
          </section>
        )}

        {loading ? (
          <div className="panel"><div className="empty-state">Loading Workspace Vault &amp; Discuss from PHP + XDB SQLite...</div></div>
        ) : tab === 'documents' ? (
          <DocumentsVaultView
            documents={documents}
            onDelete={async (id) => {
              await apiFetch(`/api/documents/${id}`, { method: 'DELETE' });
              await loadAll();
              notify('Document deleted');
            }}
            onSendForSign={(doc) => {
              setSignTargetDoc(doc);
              setSignForm({ signer_name: '', signer_email: '' });
            }}
          />
        ) : tab === 'sign' ? (
          <SignRequestsView
            signs={signs}
            onSign={async (id, signatureText) => {
              await apiFetch(`/api/signs/${id}/sign`, { method: 'POST', body: { signature_text: signatureText } });
              await loadAll();
              notify('Document signed & sealed with SHA-256 audit hash');
            }}
            onDecline={async (id) => {
              await apiFetch(`/api/signs/${id}/decline`, { method: 'POST' });
              await loadAll();
              notify('Signature request declined');
            }}
          />
        ) : tab === 'approvals' ? (
          <ApprovalsInboxView
            approvals={approvals}
            onDecide={async (id, status, decision_note) => {
              await apiFetch(`/api/approvals/${id}/decide`, { method: 'PATCH', body: { status, decision_note } });
              await loadAll();
              notify(`Request ${status}`);
            }}
          />
        ) : (
          <DiscussChannelsView
            channels={channels}
            activeChannel={activeChannel}
            messages={messages}
            onSelectChannel={loadChannelMessages}
            onPostMessage={async (channelId, author_name, body) => {
              await apiFetch(`/api/channels/${channelId}/messages`, { method: 'POST', body: { author_name, body } });
              await loadAll();
            }}
            onTogglePin={async (msgId) => {
              await apiFetch(`/api/messages/${msgId}/pin`, { method: 'PATCH' });
              await loadAll();
            }}
            onCreateChannel={async (name, topic) => {
              const res = await apiFetch<{ channel: DiscussChannel }>('/api/channels', { method: 'POST', body: { name, topic } });
              await loadAll();
              await loadChannelMessages(res.channel);
              notify(`Created ${res.channel.name}`);
            }}
          />
        )}
      </main>

      <footer className="erp-footer">
        <span>Modula Documents, eSign, Approvals &amp; Discuss · SoftN v2 React + PHP Container</span>
        {runtime && (
          <span className="runtime-pill">
            <span className="runtime-dot" />
            {runtime.mode === 'zipp-wasm' ? 'PHP 8 (ZIPP WASM)' : 'Standalone PHP'} · {runtime.database}
          </span>
        )}
      </footer>

      {showNewDoc && (
        <div className="modal-backdrop" onClick={() => setShowNewDoc(false)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              await apiFetch('/api/documents', { method: 'POST', body: docForm });
              setShowNewDoc(false);
              setDocForm({ title: '', folder: 'Contracts', doc_type: 'Contract', owner_name: 'Alex Rivera', version_label: 'v1.0', tags: 'legal', content_text: '' });
              await loadAll();
              notify('Document stored in vault');
            }}
          >
            <div className="modal-head"><h3>Create Vault Document</h3><button type="button" className="btn btn-sm" onClick={() => setShowNewDoc(false)}>Cancel</button></div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field full"><label>Document Title *</label><input className="input" required value={docForm.title} onChange={(e) => setDocForm({ ...docForm, title: e.target.value })} /></div>
                <div className="field"><label>Folder</label><select className="select" value={docForm.folder} onChange={(e) => setDocForm({ ...docForm, folder: e.target.value })}><option value="Contracts">Contracts</option><option value="Finance">Finance</option><option value="HR Policies">HR Policies</option><option value="Legal">Legal</option><option value="Operations">Operations</option></select></div>
                <div className="field"><label>Version</label><input className="input" value={docForm.version_label} onChange={(e) => setDocForm({ ...docForm, version_label: e.target.value })} /></div>
                <div className="field full"><label>Tags (comma separated)</label><input className="input" value={docForm.tags} onChange={(e) => setDocForm({ ...docForm, tags: e.target.value })} /></div>
                <div className="field full"><label>Document Body</label><textarea className="textarea" rows={5} value={docForm.content_text} onChange={(e) => setDocForm({ ...docForm, content_text: e.target.value })} /></div>
              </div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setShowNewDoc(false)}>Cancel</button><button type="submit" className="btn btn-primary">Save to Vault</button></div>
          </form>
        </div>
      )}

      {signTargetDoc && (
        <div className="modal-backdrop" onClick={() => setSignTargetDoc(null)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              await apiFetch('/api/signs', { method: 'POST', body: { document_id: signTargetDoc.id, ...signForm } });
              setSignTargetDoc(null);
              setTab('sign');
              await loadAll();
              notify('Signature envelope dispatched');
            }}
          >
            <div className="modal-head"><h3>Send for eSignature</h3><button type="button" className="btn btn-sm" onClick={() => setSignTargetDoc(null)}>Cancel</button></div>
            <div className="modal-body">
              <div className="chatter-item"><strong>{signTargetDoc.title}</strong></div>
              <div className="form-grid">
                <div className="field"><label>Signer Name *</label><input className="input" required value={signForm.signer_name} onChange={(e) => setSignForm({ ...signForm, signer_name: e.target.value })} /></div>
                <div className="field"><label>Signer Email *</label><input className="input" type="email" required value={signForm.signer_email} onChange={(e) => setSignForm({ ...signForm, signer_email: e.target.value })} /></div>
              </div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setSignTargetDoc(null)}>Cancel</button><button type="submit" className="btn btn-primary">Send Envelope</button></div>
          </form>
        </div>
      )}

      {showNewApproval && (
        <div className="modal-backdrop" onClick={() => setShowNewApproval(false)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              await apiFetch('/api/approvals', { method: 'POST', body: { ...approvalForm, amount: Number(approvalForm.amount) || 0 } });
              setShowNewApproval(false);
              setApprovalForm({ category: 'Purchase', title: '', requester_name: 'Alex Rivera', amount: '650', justification: '' });
              await loadAll();
              notify('Approval request submitted');
            }}
          >
            <div className="modal-head"><h3>Submit Approval Request</h3><button type="button" className="btn btn-sm" onClick={() => setShowNewApproval(false)}>Cancel</button></div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field full"><label>Request Title *</label><input className="input" required value={approvalForm.title} onChange={(e) => setApprovalForm({ ...approvalForm, title: e.target.value })} /></div>
                <div className="field"><label>Category</label><select className="select" value={approvalForm.category} onChange={(e) => setApprovalForm({ ...approvalForm, category: e.target.value })}><option value="Purchase">Purchase</option><option value="Travel">Travel</option><option value="Contract">Contract</option><option value="Budget">Budget</option><option value="Access">Access</option></select></div>
                <div className="field"><label>Amount ($)</label><input className="input" type="number" step="0.01" value={approvalForm.amount} onChange={(e) => setApprovalForm({ ...approvalForm, amount: e.target.value })} /></div>
                <div className="field full"><label>Business Justification</label><textarea className="textarea" value={approvalForm.justification} onChange={(e) => setApprovalForm({ ...approvalForm, justification: e.target.value })} /></div>
              </div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setShowNewApproval(false)}>Cancel</button><button type="submit" className="btn btn-primary">Submit Request</button></div>
          </form>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
