import React, { useState } from 'react';
import type { CannedMacro } from '../types';

interface MacrosViewProps {
  macros: CannedMacro[];
  onCreate: (macro: { shortcut: string; title: string; body: string }) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}

export const MacrosView: React.FC<MacrosViewProps> = ({ macros, onCreate, onDelete }) => {
  const [form, setForm] = useState({ shortcut: '', title: '', body: '' });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onCreate(form);
    setForm({ shortcut: '', title: '', body: '' });
  };

  return (
    <div className="split-2">
      <div className="panel">
        <div className="panel-header"><h2>Saved Canned Responses ({macros.length})</h2></div>
        <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {macros.map((m) => (
            <div key={m.id} className="chatter-item">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <span className="badge badge-accent" style={{ marginRight: '8px' }}>{m.shortcut}</span>
                  <strong>{m.title}</strong>
                </div>
                <button type="button" className="btn btn-sm btn-danger" onClick={() => void onDelete(m.id)}>Delete</button>
              </div>
              <div className="muted" style={{ fontSize: '12.5px' }}>{m.body}</div>
            </div>
          ))}
        </div>
      </div>

      <form className="panel" onSubmit={(e) => void handleSubmit(e)}>
        <div className="panel-header"><h2>Create Canned Macro</h2></div>
        <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div className="form-grid">
            <div className="field"><label>Shortcut *</label><input className="input" required placeholder="/billing" value={form.shortcut} onChange={(e) => setForm({ ...form, shortcut: e.target.value })} /></div>
            <div className="field"><label>Title *</label><input className="input" required placeholder="Billing Inquiry Reply" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
          </div>
          <div className="field"><label>Response Body *</label><textarea className="textarea" style={{ minHeight: '110px' }} required value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} /></div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="submit" className="btn btn-primary">Save Macro</button>
          </div>
        </div>
      </form>
    </div>
  );
};
