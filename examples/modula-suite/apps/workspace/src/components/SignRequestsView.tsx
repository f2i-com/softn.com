import { useState } from 'react';
import type { SignRequest } from '../types';

interface SignRequestsViewProps {
  signs: SignRequest[];
  onSign: (id: number, signatureText: string) => Promise<void>;
  onDecline: (id: number) => Promise<void>;
}

export function SignRequestsView({ signs, onSign, onDecline }: SignRequestsViewProps) {
  const [signingReq, setSigningReq] = useState<SignRequest | null>(null);
  const [sigInput, setSigInput] = useState('');

  return (
    <>
      <div className="panel">
        <div className="panel-header">
          <h2>eSignature Envelopes &amp; SHA-256 Cryptographic Audit Trail</h2>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Envelope</th>
                <th>Document</th>
                <th>Signer</th>
                <th>Status</th>
                <th>Signature &amp; Audit Hash</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {signs.map((s) => (
                <tr key={s.id}>
                  <td><strong>{s.ref_code}</strong></td>
                  <td>{s.document_title}</td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{s.signer_name}</div>
                    <div className="muted" style={{ fontSize: '11.5px' }}>{s.signer_email}</div>
                  </td>
                  <td>
                    <span className={`badge ${s.status === 'Signed' ? 'badge-success' : s.status === 'Declined' ? 'badge-danger' : 'badge-warning'}`}>
                      {s.status}
                    </span>
                  </td>
                  <td>
                    {s.status === 'Signed' ? (
                      <div style={{ fontSize: '12px' }}>
                        <div style={{ fontFamily: 'Georgia, serif', fontStyle: 'italic', fontSize: '14px', color: '#111827' }}>{s.signature_text}</div>
                        <div className="muted" style={{ fontSize: '11px' }}>
                          {s.signed_at} · <code>sha256:{s.audit_hash.slice(0, 14)}…</code>
                        </div>
                      </div>
                    ) : (
                      <span className="muted" style={{ fontSize: '12px' }}>Awaiting signature</span>
                    )}
                  </td>
                  <td>
                    {s.status === 'Pending' ? (
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          onClick={() => {
                            setSigningReq(s);
                            setSigInput(s.signer_name);
                          }}
                        >
                          Sign Now
                        </button>
                        <button type="button" className="btn btn-sm btn-danger" onClick={() => void onDecline(s.id)}>Decline</button>
                      </div>
                    ) : (
                      <span className="muted" style={{ fontSize: '12px' }}>Sealed</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {signingReq && (
        <div className="modal-backdrop" onClick={() => setSigningReq(null)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              await onSign(signingReq.id, sigInput);
              setSigningReq(null);
            }}
          >
            <div className="modal-head">
              <h3>Sign {signingReq.ref_code}</h3>
              <button type="button" className="btn btn-sm" onClick={() => setSigningReq(null)}>Cancel</button>
            </div>
            <div className="modal-body">
              <div className="chatter-item">
                <strong>{signingReq.document_title}</strong>
                <div className="muted" style={{ fontSize: '12px' }}>Signer: {signingReq.signer_name} ({signingReq.signer_email})</div>
              </div>
              <div className="field">
                <label>Type Full Legal Signature *</label>
                <input className="input" required value={sigInput} onChange={(e) => setSigInput(e.target.value)} />
              </div>
              <div style={{ border: '1px dashed #6366f1', borderRadius: '10px', padding: '14px', textAlign: 'center', background: '#f5f3ff' }}>
                <div className="muted" style={{ fontSize: '11px', marginBottom: '4px' }}>Signature Preview</div>
                <div style={{ fontFamily: 'Georgia, serif', fontStyle: 'italic', fontSize: '24px', color: '#312e81' }}>
                  {sigInput || 'Your Signature'}
                </div>
              </div>
              <div className="muted" style={{ fontSize: '12px' }}>
                Clicking Adopt &amp; Sign computes a server-side SHA-256 audit hash in PHP 8 and seals this envelope in XDB SQLite.
              </div>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setSigningReq(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Adopt &amp; Sign Document</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
