import React, { useState } from 'react';
import type { WebLead } from '../types';

interface LeadsViewProps {
  leads: WebLead[];
  sourceSlug: string;
  onCreateLead: (lead: { name: string; email: string; company: string; message: string; source_page: string }) => Promise<void>;
  onUpdateStatus: (id: number, status: string) => Promise<void>;
}

export const LeadsView: React.FC<LeadsViewProps> = ({ leads, sourceSlug, onCreateLead, onUpdateStatus }) => {
  const [form, setForm] = useState({ name: '', email: '', company: '', message: '' });

  return (
    <div className="split-2">
      <div className="panel">
        <div className="panel-header"><h2>Inbound Website Leads ({leads.length})</h2></div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Contact</th><th>Company</th><th>Message</th><th>Status</th><th>Action</th></tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <tr key={l.id}>
                  <td><strong>{l.name}</strong><div className="muted" style={{ fontSize: '11.5px' }}>{l.email}</div></td>
                  <td>{l.company}</td>
                  <td>{l.message}</td>
                  <td><span className={`badge ${l.status === 'Qualified' ? 'badge-success' : 'badge-accent'}`}>{l.status}</span></td>
                  <td>
                    {l.status !== 'Qualified' && (
                      <button type="button" className="btn btn-sm btn-success" onClick={() => void onUpdateStatus(l.id, 'Qualified')}>Qualify</button>
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
          await onCreateLead({ ...form, source_page: sourceSlug });
          setForm({ name: '', email: '', company: '', message: '' });
        }}
      >
        <div className="panel-header"><h2>Test Public Lead Capture Form</h2></div>
        <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div className="field"><label>Name *</label><input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div className="field"><label>Email *</label><input className="input" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
          <div className="field"><label>Company</label><input className="input" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} /></div>
          <div className="field"><label>Inquiry *</label><textarea className="textarea" required value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} /></div>
          <button type="submit" className="btn btn-primary">Submit Lead to SQLite</button>
        </div>
      </form>
    </div>
  );
};
