import React, { useState } from 'react';
import type { KbArticle } from '../types';

interface KnowledgeBaseViewProps {
  articles: KbArticle[];
  onVote: (id: number) => Promise<void>;
  onUpdate: (id: number, data: { title: string; category: string; body: string }) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}

export const KnowledgeBaseView: React.FC<KnowledgeBaseViewProps> = ({
  articles,
  onVote,
  onUpdate,
  onDelete,
}) => {
  const [query, setQuery] = useState('');
  const [catFilter, setCatFilter] = useState('All');
  const [editing, setEditing] = useState<KbArticle | null>(null);

  const categories = ['All', ...Array.from(new Set(articles.map((a) => a.category)))];
  const filtered = articles.filter((a) => {
    if (catFilter !== 'All' && a.category !== catFilter) return false;
    const q = query.trim().toLowerCase();
    return !q || a.title.toLowerCase().includes(q) || a.body.toLowerCase().includes(q);
  });

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    await onUpdate(editing.id, { title: editing.title, category: editing.category, body: editing.body });
    setEditing(null);
  };

  return (
    <>
      <div className="toolbar">
        <div className="toolbar-left">
          {categories.map((c) => (
            <button key={c} type="button" className={`btn btn-sm ${catFilter === c ? 'btn-primary' : ''}`} onClick={() => setCatFilter(c)}>
              {c}
            </button>
          ))}
        </div>
        <input className="input" style={{ minWidth: '250px' }} type="search" placeholder="Search SOPs & runbooks..." value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      <div className="card-grid">
        {filtered.map((art) => (
          <div key={art.id} className="panel">
            <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '9px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: '8px' }}>
                <span className="badge badge-accent">{art.category}</span>
                <span className="muted" style={{ fontSize: '11.5px' }}>Updated {art.updated_at}</span>
              </div>
              <strong style={{ fontSize: '15px' }}>{art.title}</strong>
              <p style={{ margin: 0, fontSize: '13px', color: 'var(--ink-secondary)', lineHeight: 1.5 }}>{art.body}</p>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '6px', borderTop: '1px solid var(--border)' }}>
                <span className="muted" style={{ fontSize: '12px' }}>{art.helpful_votes} helpful</span>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <button type="button" className="btn btn-sm" onClick={() => setEditing(art)}>Edit</button>
                  <button type="button" className="btn btn-sm" onClick={() => void onVote(art.id)}>Helpful +1</button>
                  <button type="button" className="btn btn-sm btn-danger" onClick={() => void onDelete(art.id)}>×</button>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void handleSaveEdit(e)}>
            <div className="modal-head"><h3>Edit Knowledge Article</h3><button type="button" className="btn btn-sm" onClick={() => setEditing(null)}>Cancel</button></div>
            <div className="modal-body">
              <div className="field"><label>Title *</label><input className="input" required value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} /></div>
              <div className="field"><label>Category</label><input className="input" value={editing.category} onChange={(e) => setEditing({ ...editing, category: e.target.value })} /></div>
              <div className="field"><label>Body *</label><textarea className="textarea" style={{ minHeight: '150px' }} required value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} /></div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button><button type="submit" className="btn btn-primary">Save Changes</button></div>
          </form>
        </div>
      )}
    </>
  );
};
