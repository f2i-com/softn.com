import React, { useState } from 'react';
import type { CmsPage, PageBlock } from '../types';

interface PageBuilderViewProps {
  pages: CmsPage[];
  selectedPage: CmsPage | null;
  onSelectPage: (pg: CmsPage) => void;
  onSavePage: (pg: CmsPage) => Promise<void>;
  onCreatePage: (slug: string, title: string) => Promise<void>;
}

export const PageBuilderView: React.FC<PageBuilderViewProps> = ({
  pages,
  selectedPage,
  onSelectPage,
  onSavePage,
  onCreatePage,
}) => {
  const [draft, setDraft] = useState<CmsPage | null>(selectedPage);
  const [showNew, setShowNew] = useState(false);
  const [newSlug, setNewSlug] = useState('/pricing');
  const [newTitle, setNewTitle] = useState('Pricing Plans');

  // Keep draft synced when selecting a different page
  if (selectedPage && (!draft || draft.id !== selectedPage.id)) {
    setDraft(selectedPage);
  }

  if (!draft) {
    return <div className="panel"><div className="empty-state">No pages yet.</div></div>;
  }

  const addBlock = (kind: PageBlock['kind']) => {
    const defaults: Record<PageBlock['kind'], PageBlock> = {
      features: { kind: 'features', heading: 'Built for Modularity', body: 'Deploy only the apps you need inside isolated SoftN containers.' },
      testimonial: { kind: 'testimonial', heading: 'Customer Spotlight', body: 'Switching to Modula saved our team over $40,000/yr in SaaS seats.' },
      faq: { kind: 'faq', heading: 'Can we export our SQLite database?', body: 'Yes — download a standard .sqlite3 file in one click at any time.' },
      cta: { kind: 'cta', heading: 'Ready to try Modula?', body: 'Boot the entire ERP suite locally in your browser with zero setup.' },
    };
    setDraft({ ...draft, blocks: [...draft.blocks, defaults[kind]] });
  };

  const updateBlock = (idx: number, patch: Partial<PageBlock>) => {
    const next = draft.blocks.map((b, i) => (i === idx ? { ...b, ...patch } : b));
    setDraft({ ...draft, blocks: next });
  };

  const moveBlock = (idx: number, dir: -1 | 1) => {
    const to = idx + dir;
    if (to < 0 || to >= draft.blocks.length) return;
    const next = [...draft.blocks];
    const [moved] = next.splice(idx, 1);
    next.splice(to, 0, moved);
    setDraft({ ...draft, blocks: next });
  };

  return (
    <>
      <div className="split-2">
        <form
          className="panel"
          onSubmit={(e) => {
            e.preventDefault();
            void onSavePage(draft);
          }}
        >
          <div className="panel-header" style={{ flexWrap: 'wrap' }}>
            <h2>Page &amp; Block Builder</h2>
            <div style={{ display: 'flex', gap: '6px' }}>
              <select
                className="select"
                value={draft.id}
                onChange={(e) => {
                  const found = pages.find((p) => p.id === Number(e.target.value));
                  if (found) {
                    onSelectPage(found);
                    setDraft(found);
                  }
                }}
              >
                {pages.map((p) => <option key={p.id} value={p.id}>{p.slug} — {p.title}</option>)}
              </select>
              <button type="button" className="btn btn-sm" onClick={() => setShowNew(true)}>+ Page</button>
            </div>
          </div>

          <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div className="form-grid">
              <div className="field"><label>Page Title</label><input className="input" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></div>
              <div className="field">
                <label>Brand Accent</label>
                <select className="select" value={draft.accent_color} onChange={(e) => setDraft({ ...draft, accent_color: e.target.value })}>
                  <option value="#ea580c">Terracotta (#ea580c)</option>
                  <option value="#5b21b6">Plum Violet (#5b21b6)</option>
                  <option value="#0d9488">Teal (#0d9488)</option>
                  <option value="#2563eb">Cobalt (#2563eb)</option>
                </select>
              </div>
            </div>
            <div className="field"><label>SEO Meta Description</label><input className="input" value={draft.meta_desc} onChange={(e) => setDraft({ ...draft, meta_desc: e.target.value })} placeholder="Meta description for search engines..." /></div>
            <div className="field"><label>Hero Headline</label><input className="input" value={draft.headline} onChange={(e) => setDraft({ ...draft, headline: e.target.value })} /></div>
            <div className="field"><label>Hero Subheadline</label><textarea className="textarea" value={draft.subheadline} onChange={(e) => setDraft({ ...draft, subheadline: e.target.value })} /></div>
            <div className="field"><label>Primary CTA Button</label><input className="input" value={draft.cta_label} onChange={(e) => setDraft({ ...draft, cta_label: e.target.value })} /></div>

            <div style={{ borderTop: '1px solid var(--border)', paddingTop: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '6px' }}>
                <strong style={{ fontSize: '12.5px' }}>Content Sections ({draft.blocks.length})</strong>
                <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                  <button type="button" className="btn btn-sm" onClick={() => addBlock('features')}>+ Features</button>
                  <button type="button" className="btn btn-sm" onClick={() => addBlock('testimonial')}>+ Quote</button>
                  <button type="button" className="btn btn-sm" onClick={() => addBlock('faq')}>+ FAQ</button>
                  <button type="button" className="btn btn-sm" onClick={() => addBlock('cta')}>+ CTA</button>
                </div>
              </div>
              {draft.blocks.map((blk, i) => (
                <div key={i} className="chatter-item">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span className="badge badge-neutral" style={{ textTransform: 'uppercase' }}>{blk.kind}</span>
                    <div style={{ display: 'flex', gap: '4px' }}>
                      <button type="button" className="btn btn-sm" disabled={i === 0} onClick={() => moveBlock(i, -1)}>↑</button>
                      <button type="button" className="btn btn-sm" disabled={i === draft.blocks.length - 1} onClick={() => moveBlock(i, 1)}>↓</button>
                      <button type="button" className="btn btn-sm btn-danger" onClick={() => setDraft({ ...draft, blocks: draft.blocks.filter((_, idx) => idx !== i) })}>×</button>
                    </div>
                  </div>
                  <input className="input" value={blk.heading} onChange={(e) => updateBlock(i, { heading: e.target.value })} placeholder="Section heading" />
                  <input className="input" value={blk.body} onChange={(e) => updateBlock(i, { body: e.target.value })} placeholder="Section content" />
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '6px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
                <input type="checkbox" checked={Boolean(draft.published)} onChange={(e) => setDraft({ ...draft, published: e.target.checked ? 1 : 0 })} />
                Published on <code>{draft.slug}</code>
              </label>
              <button type="submit" className="btn btn-primary">Save &amp; Publish</button>
            </div>
          </div>
        </form>

        <div className="panel">
          <div className="panel-header">
            <h2>Live Page Preview ({draft.slug})</h2>
            <span className={`badge ${draft.published ? 'badge-success' : 'badge-warning'}`}>{draft.published ? 'Published' : 'Draft'}</span>
          </div>
          <div style={{ padding: '28px 22px', background: '#111827', color: '#f9fafb', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
            <span className="badge" style={{ background: draft.accent_color, color: '#ffffff' }}>{draft.title}</span>
            <h2 style={{ margin: 0, fontSize: '24px', lineHeight: 1.2, maxWidth: '480px' }}>{draft.headline}</h2>
            <p style={{ margin: 0, color: '#d1d5db', maxWidth: '460px', fontSize: '13.5px' }}>{draft.subheadline}</p>
            <button type="button" className="btn" style={{ background: draft.accent_color, borderColor: draft.accent_color, color: '#fff', marginTop: '4px' }}>
              {draft.cta_label} →
            </button>
          </div>
          <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {draft.blocks.map((blk, i) => (
              <div
                key={i}
                style={{
                  padding: '14px 16px',
                  borderRadius: '10px',
                  border: '1px solid var(--border)',
                  background: blk.kind === 'testimonial' ? '#fffbeb' : blk.kind === 'cta' ? '#f5f3ff' : 'var(--surface-subtle)',
                }}
              >
                <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', color: draft.accent_color, marginBottom: '4px' }}>{blk.kind}</div>
                <strong style={{ fontSize: '14.5px', display: 'block', marginBottom: '4px' }}>{blk.heading}</strong>
                <div style={{ fontSize: '13px', color: 'var(--ink-secondary)' }}>{blk.body}</div>
              </div>
            ))}
            {draft.meta_desc && (
              <div className="muted" style={{ fontSize: '11.5px', paddingTop: '6px', borderTop: '1px solid var(--border)' }}>
                <strong>SEO Snippet:</strong> {draft.meta_desc}
              </div>
            )}
          </div>
        </div>
      </div>

      {showNew && (
        <div className="modal-backdrop" onClick={() => setShowNew(false)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              await onCreatePage(newSlug, newTitle);
              setShowNew(false);
            }}
          >
            <div className="modal-head"><h3>Create Website Page</h3><button type="button" className="btn btn-sm" onClick={() => setShowNew(false)}>Cancel</button></div>
            <div className="modal-body">
              <div className="field"><label>URL Slug *</label><input className="input" required value={newSlug} onChange={(e) => setNewSlug(e.target.value)} placeholder="/about" /></div>
              <div className="field"><label>Page Title *</label><input className="input" required value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="About Us" /></div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setShowNew(false)}>Cancel</button><button type="submit" className="btn btn-primary">Create Page</button></div>
          </form>
        </div>
      )}
    </>
  );
};
