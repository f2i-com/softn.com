import { useState } from 'react';
import type { VaultDocument } from '../types';

interface DocumentsVaultViewProps {
  documents: VaultDocument[];
  onDelete: (id: number) => Promise<void>;
  onSendForSign: (doc: VaultDocument) => void;
}

export function DocumentsVaultView({ documents, onDelete, onSendForSign }: DocumentsVaultViewProps) {
  const [folder, setFolder] = useState('All');
  const [selectedId, setSelectedId] = useState<number | null>(documents[0]?.id ?? null);

  const folders = ['All', ...Array.from(new Set(documents.map((d) => d.folder)))];
  const filtered = documents.filter((d) => folder === 'All' || d.folder === folder);
  const activeDoc = filtered.find((d) => d.id === selectedId) ?? filtered[0] ?? null;

  return (
    <div className="split-2">
      <div className="panel">
        <div className="panel-header">
          <h2>Document Vault</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
            {folders.map((f) => (
              <button key={f} type="button" className={`btn btn-sm ${folder === f ? 'btn-primary' : ''}`} onClick={() => setFolder(f)}>
                {f}
              </button>
            ))}
          </div>
        </div>
        <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {filtered.map((doc) => (
            <div
              key={doc.id}
              className="kanban-card"
              style={{ borderColor: activeDoc?.id === doc.id ? '#4f46e5' : undefined }}
              onClick={() => setSelectedId(doc.id)}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="badge badge-accent">{doc.folder}</span>
                <span className="muted" style={{ fontSize: '11.5px' }}>{doc.version_label} · {doc.size_kb} KB</span>
              </div>
              <div className="kanban-card-title">{doc.title}</div>
              <div className="muted" style={{ fontSize: '12px' }}>Owner: {doc.owner_name} · Updated {doc.updated_at}</div>
            </div>
          ))}
          {filtered.length === 0 && <div className="empty-state">No documents in this folder</div>}
        </div>
      </div>

      <div className="panel">
        {activeDoc ? (
          <>
            <div className="panel-header">
              <div>
                <h2>{activeDoc.title}</h2>
                <div className="muted" style={{ fontSize: '12px' }}>
                  {activeDoc.folder} · {activeDoc.doc_type} · {activeDoc.version_label} · Owner: {activeDoc.owner_name}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button type="button" className="btn btn-sm btn-primary" onClick={() => onSendForSign(activeDoc)}>Request eSign →</button>
                <button type="button" className="btn btn-sm btn-danger" onClick={() => void onDelete(activeDoc.id)}>Delete</button>
              </div>
            </div>
            <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {activeDoc.tags && (
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {activeDoc.tags.split(',').map((t) => t.trim()).filter(Boolean).map((tag) => (
                    <span key={tag} className="badge badge-neutral">#{tag}</span>
                  ))}
                </div>
              )}
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit', background: '#f9fafb', border: '1px solid var(--border)', borderRadius: '8px', padding: '14px', fontSize: '13px', lineHeight: 1.6 }}>
                {activeDoc.content_text || '(No text body stored)'}
              </pre>
            </div>
          </>
        ) : (
          <div className="empty-state">Select a document to inspect or send for electronic signature.</div>
        )}
      </div>
    </div>
  );
}
