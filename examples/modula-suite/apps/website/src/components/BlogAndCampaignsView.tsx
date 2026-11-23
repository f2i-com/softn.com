import React, { useState } from 'react';
import { formatPercent } from '../../../../shared/ui/format';
import type { BlogPost, Campaign } from '../types';

interface BlogViewProps {
  posts: BlogPost[];
  onCreatePost: (post: { title: string; author: string; tag: string; excerpt: string; body: string }) => Promise<void>;
  onTogglePublish: (id: number) => Promise<void>;
}

export const BlogView: React.FC<BlogViewProps> = ({ posts, onCreatePost, onTogglePublish }) => {
  const [form, setForm] = useState({ title: '', author: 'Alex Rivera', tag: 'Product', excerpt: '', body: '' });
  return (
    <div className="split-2">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {posts.map((p) => (
          <div key={p.id} className="panel">
            <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <span className="badge badge-accent">{p.tag}</span>
                  <span className={`badge ${p.published ? 'badge-success' : 'badge-warning'}`}>{p.published ? 'Published' : 'Draft'}</span>
                </div>
                <span className="muted" style={{ fontSize: '12px' }}>{p.author} · {p.published_at}</span>
              </div>
              <strong style={{ fontSize: '15.5px' }}>{p.title}</strong>
              <div style={{ fontSize: '13px', color: 'var(--ink-secondary)' }}>{p.body}</div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: '6px', borderTop: '1px solid var(--border)' }}>
                <button type="button" className="btn btn-sm" onClick={() => void onTogglePublish(p.id)}>
                  {p.published ? 'Unpublish' : 'Publish Live'}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <form
        className="panel"
        onSubmit={async (e) => {
          e.preventDefault();
          await onCreatePost(form);
          setForm({ title: '', author: 'Alex Rivera', tag: 'Product', excerpt: '', body: '' });
        }}
      >
        <div className="panel-header"><h2>Publish Blog Article</h2></div>
        <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div className="field"><label>Article Title *</label><input className="input" required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
          <div className="form-grid">
            <div className="field"><label>Author</label><input className="input" value={form.author} onChange={(e) => setForm({ ...form, author: e.target.value })} /></div>
            <div className="field"><label>Tag</label><input className="input" value={form.tag} onChange={(e) => setForm({ ...form, tag: e.target.value })} /></div>
          </div>
          <div className="field"><label>Excerpt</label><input className="input" value={form.excerpt} onChange={(e) => setForm({ ...form, excerpt: e.target.value })} /></div>
          <div className="field"><label>Body *</label><textarea className="textarea" style={{ minHeight: '130px' }} required value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} /></div>
          <button type="submit" className="btn btn-primary">Publish Post</button>
        </div>
      </form>
    </div>
  );
};

interface CampaignsViewProps {
  campaigns: Campaign[];
  onCreateCampaign: (c: { name: string; subject: string; audience: string; body: string }) => Promise<void>;
  onSendCampaign: (id: number) => Promise<void>;
}

export const CampaignsView: React.FC<CampaignsViewProps> = ({ campaigns, onCreateCampaign, onSendCampaign }) => {
  const [form, setForm] = useState({ name: '', subject: '', audience: 'All Leads & Customers', body: '' });
  return (
    <div className="split-2">
      <div className="panel">
        <div className="panel-header"><h2>Email Marketing Campaigns ({campaigns.length})</h2></div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Campaign</th><th>Audience</th><th className="num">Sent To</th><th className="num">Open Rate</th><th>Status</th><th>Action</th></tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id}>
                  <td><strong>{c.name}</strong><div className="muted" style={{ fontSize: '11.5px' }}>Subject: {c.subject}</div></td>
                  <td>{c.audience}</td>
                  <td className="num">{c.recipients}</td>
                  <td className="num">{c.status === 'Sent' ? formatPercent(c.open_rate) : '-'}</td>
                  <td><span className={`badge ${c.status === 'Sent' ? 'badge-success' : 'badge-warning'}`}>{c.status}</span></td>
                  <td>
                    {c.status === 'Draft' ? (
                      <button type="button" className="btn btn-sm btn-primary" onClick={() => void onSendCampaign(c.id)}>Send Now →</button>
                    ) : (
                      <span className="muted" style={{ fontSize: '11.5px' }}>{c.sent_at}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <form
        className="panel"
        onSubmit={async (e) => {
          e.preventDefault();
          await onCreateCampaign(form);
          setForm({ name: '', subject: '', audience: 'All Leads & Customers', body: '' });
        }}
      >
        <div className="panel-header"><h2>Compose Email Campaign</h2></div>
        <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div className="field"><label>Campaign Name *</label><input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="December Feature Launch" /></div>
          <div className="field"><label>Email Subject *</label><input className="input" required value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder="New: MRP & Bank Reconciliation live in Modula" /></div>
          <div className="field">
            <label>Audience Segment</label>
            <select className="select" value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value })}>
              <option value="All Leads & Customers">All Leads &amp; Customers</option>
              <option value="Inbound Web Leads">Inbound Web Leads</option>
              <option value="Store Customers">Store Customers</option>
            </select>
          </div>
          <div className="field"><label>Email Content</label><textarea className="textarea" style={{ minHeight: '110px' }} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} /></div>
          <button type="submit" className="btn btn-primary">Save Draft Campaign</button>
        </div>
      </form>
    </div>
  );
};
