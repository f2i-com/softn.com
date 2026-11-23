import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../shared/ui/opal.css';
import { apiFetch, type RuntimeInfo } from '../../../shared/ui/api';
import { formatAbn, formatAud, initialsOf } from '../../../shared/ui/format';

interface ContactsOverview {
  customers: number;
  suppliers: number;
  contractors: number;
  advisors: number;
  tparTotal: number;
  validAbns: number;
}

interface ContactNote {
  id: number;
  created_at: string;
  author: string;
  channel: string;
  body: string;
}

interface Contact {
  id: number;
  name: string;
  contact_type: 'Customer' | 'Supplier' | 'Contractor' | 'Advisor';
  abn: string;
  abn_valid: number;
  primary_person: string;
  email: string;
  phone: string;
  suburb: string;
  state: string;
  postcode: string;
  payment_terms: string;
  credit_limit: number;
  balance: number;
  bsb: string;
  bank_account: string;
  tpar_reportable: number;
  tpar_ytd: number;
  default_tax_code: string;
  notes: ContactNote[];
}

function typeBadge(t: string): string {
  switch (t) {
    case 'Customer': return 'badge-opal';
    case 'Supplier': return 'badge-brand';
    case 'Contractor': return 'badge-warning';
    case 'Advisor': return 'badge-info';
    default: return 'badge-neutral';
  }
}

function App() {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [overview, setOverview] = useState<ContactsOverview | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [filter, setFilter] = useState('All');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<number>(1);
  const [noteBody, setNoteBody] = useState('');
  const [noteChannel, setNoteChannel] = useState('Phone Call');
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);

  // New Contact Modal + Live ABN Validator
  const [showModal, setShowModal] = useState(false);
  const [fName, setFName] = useState('');
  const [fType, setFType] = useState<'Customer' | 'Supplier' | 'Contractor' | 'Advisor'>('Customer');
  const [fAbn, setFAbn] = useState('53 004 085 616');
  const [abnCheck, setAbnCheck] = useState<{ valid: boolean; formatted: string; reason: string } | null>(null);
  const [fPerson, setFPerson] = useState('');
  const [fEmail, setFEmail] = useState('');
  const [fPhone, setFPhone] = useState('');
  const [fSuburb, setFSuburb] = useState('Sydney');
  const [fState, setFState] = useState('NSW');
  const [fPost, setFPost] = useState('2000');
  const [fTpar, setFTpar] = useState(false);

  const notify = useCallback((msg: string, err = false) => {
    setToast({ msg, err });
    setTimeout(() => setToast((prev) => (prev?.msg === msg ? null : prev)), 3200);
  }, []);

  const loadAll = useCallback(async () => {
    try {
      const [rt, ov, cs] = await Promise.all([
        apiFetch<RuntimeInfo>('/api/runtime'),
        apiFetch<ContactsOverview>('/api/overview'),
        apiFetch<{ contacts: Contact[] }>('/api/contacts'),
      ]);
      setRuntime(rt);
      setOverview(ov);
      setContacts(cs.contacts);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), true);
    }
  }, [notify]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const verifyAbnNow = async (raw: string) => {
    try {
      const res = await apiFetch<{ valid: boolean; formatted: string; reason: string }>(`/api/validate-abn?abn=${encodeURIComponent(raw)}`);
      setAbnCheck(res);
    } catch {
      setAbnCheck(null);
    }
  };

  const handleCreateContact = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await apiFetch<{ contact: Contact }>('/api/contacts', {
        method: 'POST',
        body: {
          name: fName,
          contact_type: fType,
          abn: fAbn,
          primary_person: fPerson,
          email: fEmail,
          phone: fPhone,
          suburb: fSuburb,
          state: fState,
          postcode: fPost,
          tpar_reportable: fTpar || fType === 'Contractor',
        },
      });
      setShowModal(false);
      setFName('');
      setSelectedId(res.contact.id);
      notify(`Added ${res.contact.contact_type} "${res.contact.name}"`);
      await loadAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const handleAddNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || !noteBody.trim()) return;
    try {
      await apiFetch(`/api/contacts/${selected.id}/notes`, {
        method: 'POST',
        body: { channel: noteChannel, body: noteBody },
      });
      setNoteBody('');
      notify('Logged activity note');
      await loadAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const filtered = contacts.filter((c) => {
    if (filter !== 'All' && c.contact_type !== filter) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return (
        c.name.toLowerCase().includes(q) ||
        c.abn.toLowerCase().includes(q) ||
        c.primary_person.toLowerCase().includes(q) ||
        c.suburb.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const selected = contacts.find((c) => c.id === selectedId) || filtered[0] || null;

  return (
    <div className="opal-app">
      <header className="opal-topbar">
        <div className="opal-brand">
          <div className="opal-brand-mark" style={{ background: 'linear-gradient(135deg, #2563eb, #6100a5)' }}>CT</div>
          <div>
            <h1>Contacts, ABN &amp; TPAR Directory</h1>
            <div className="opal-brand-sub">Customers · Suppliers · ATO TPAR Contractors · Free Advisor Access · Live ABR ABN Check</div>
          </div>
        </div>

        <div className="opal-actions">
          {runtime && (
            <span className={`runtime-pill ${runtime.mode === 'standalone-php' ? 'standalone' : ''}`}>
              <span className="runtime-dot" />
              {runtime.mode === 'zipp-wasm' ? 'ZIPP PHP · XDB' : 'Standalone PHP'}
            </span>
          )}
          <button
            className="btn btn-primary btn-sm"
            onClick={() => {
              setShowModal(true);
              void verifyAbnNow(fAbn);
            }}
          >
            + Add Contact
          </button>
        </div>
      </header>

      <main className="opal-main">
        {overview && (
          <section className="kpi-grid">
            <div className="kpi-card" style={{ '--kpi-accent': 'linear-gradient(90deg, #0d9488, #059669)' } as React.CSSProperties}>
              <div className="kpi-label">Active Customers</div>
              <div className="kpi-value">{overview.customers}</div>
              <div className="kpi-sub">Credit limits &amp; payment terms tracked</div>
            </div>
            <div className="kpi-card" style={{ '--kpi-accent': 'linear-gradient(90deg, #6100a5, #7c3aed)' } as React.CSSProperties}>
              <div className="kpi-label">Suppliers &amp; Vendors</div>
              <div className="kpi-value">{overview.suppliers}</div>
              <div className="kpi-sub">BSB / ABA batch details stored</div>
            </div>
            <div className="kpi-card" style={{ '--kpi-accent': 'linear-gradient(90deg, #d97706, #f59e0b)' } as React.CSSProperties}>
              <div className="kpi-label">TPAR Contractors YTD</div>
              <div className="kpi-value text-warning">{formatAud(overview.tparTotal)}</div>
              <div className="kpi-sub">{overview.contractors} ATO TPAR reportable contractors</div>
            </div>
            <div className="kpi-card" style={{ '--kpi-accent': 'linear-gradient(90deg, #2563eb, #6366f1)' } as React.CSSProperties}>
              <div className="kpi-label">ABR Verified ABNs</div>
              <div className="kpi-value text-opal">{overview.validAbns}</div>
              <div className="kpi-sub">{overview.advisors} free Chartered Accountant / Advisor seat(s)</div>
            </div>
          </section>
        )}

        <div className="split-main">
          <section className="panel">
            <div className="toolbar">
              <div className="filter-pills">
                {['All', 'Customer', 'Supplier', 'Contractor', 'Advisor'].map((t) => (
                  <button key={t} className={`pill-btn ${filter === t ? 'active' : ''}`} onClick={() => setFilter(t)}>
                    {t}
                  </button>
                ))}
              </div>
              <input
                className="input input-sm"
                placeholder="Search name, ABN, suburb..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Contact / Business</th>
                    <th>Role</th>
                    <th>ABN (ABR Check)</th>
                    <th className="right">Open Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((c) => (
                    <tr
                      key={c.id}
                      onClick={() => setSelectedId(c.id)}
                      style={{
                        cursor: 'pointer',
                        background: selected?.id === c.id ? '#f5f0ff' : undefined,
                      }}
                    >
                      <td>
                        <div className="row-nowrap">
                          <div className="avatar">{initialsOf(c.name)}</div>
                          <div>
                            <div className="fw-700">{c.name}</div>
                            <div className="row-sub">{c.primary_person} · {c.suburb}, {c.state}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span className={`badge ${typeBadge(c.contact_type)}`}>{c.contact_type}</span>
                        {c.tpar_reportable === 1 && <div className="row-sub text-warning fw-700">ATO TPAR</div>}
                      </td>
                      <td>
                        <div className="num fw-700">{formatAbn(c.abn)}</div>
                        {c.abn_valid === 1 ? (
                          <span className="badge badge-success" style={{ marginTop: 2 }}>ABR Valid</span>
                        ) : (
                          <span className="badge badge-danger" style={{ marginTop: 2 }}>Check ABN</span>
                        )}
                      </td>
                      <td className="right money fw-700">{formatAud(c.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {selected && (
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2 className="panel-title">{selected.name}</h2>
                  <div className="panel-subtitle">{selected.contact_type} · ABN {formatAbn(selected.abn)} · {selected.payment_terms}</div>
                </div>
                <span className={`badge ${typeBadge(selected.contact_type)}`}>{selected.contact_type}</span>
              </div>
              <div className="panel-body stack">
                <div className="callout callout-brand">
                  <div>
                    <div className="fw-700">{selected.primary_person}</div>
                    <div>{selected.email} · {selected.phone}</div>
                    <div className="muted">{selected.suburb}, {selected.state} {selected.postcode} · Default Tax: {selected.default_tax_code}</div>
                  </div>
                </div>

                {selected.credit_limit > 0 && (
                  <div>
                    <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                      <span className="muted">Credit Limit Utilization</span>
                      <span className="money fw-700">{formatAud(selected.balance)} / {formatAud(selected.credit_limit)}</span>
                    </div>
                    <div className="progress-track">
                      <div
                        className="progress-fill"
                        style={{ width: `${Math.min(100, Math.round((selected.balance / selected.credit_limit) * 100))}%` }}
                      />
                    </div>
                  </div>
                )}

                {selected.bsb && (
                  <div className="callout">
                    <div>
                      <div className="fw-700">ABA / EFT Bank Details</div>
                      <div className="num">BSB <strong>{selected.bsb}</strong> · Account <strong>{selected.bank_account}</strong></div>
                    </div>
                    {selected.tpar_reportable === 1 && (
                      <div style={{ textAlign: 'right' }}>
                        <span className="badge badge-warning">TPAR Reportable</span>
                        <div className="money fw-700" style={{ marginTop: 4 }}>{formatAud(selected.tpar_ytd)} YTD</div>
                      </div>
                    )}
                  </div>
                )}

                <form onSubmit={handleAddNote} className="stack" style={{ gap: 8 }}>
                  <div className="row">
                    <strong style={{ fontSize: 12.5 }}>Activity &amp; Compliance Notes</strong>
                    <div className="spacer" />
                    <select className="select" style={{ width: 120, padding: '4px 8px', fontSize: 12 }} value={noteChannel} onChange={(e) => setNoteChannel(e.target.value)}>
                      <option>Phone Call</option>
                      <option>Email</option>
                      <option>Compliance</option>
                      <option>Advisor</option>
                    </select>
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <input className="input" style={{ flex: 1 }} placeholder="Log a contact interaction or remittance note..." value={noteBody} onChange={(e) => setNoteBody(e.target.value)} />
                    <button type="submit" className="btn btn-primary btn-sm">Add</button>
                  </div>
                </form>

                <div className="stack" style={{ gap: 8 }}>
                  {selected.notes.map((n) => (
                    <div key={n.id} className="callout" style={{ padding: '9px 12px' }}>
                      <div>
                        <div className="row" style={{ gap: 6, marginBottom: 2 }}>
                          <span className="badge badge-neutral">{n.channel}</span>
                          <span className="fw-700" style={{ fontSize: 12 }}>{n.author}</span>
                          <span className="muted" style={{ fontSize: 11 }}>{n.created_at}</span>
                        </div>
                        <div>{n.body}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}
        </div>
      </main>

      {/* New Contact Modal with Live Mod-89 ABN Validator */}
      {showModal && (
        <div className="modal-backdrop" onClick={() => setShowModal(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={handleCreateContact}>
            <div className="modal-head">
              <h2>Add Australian Business Contact</h2>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowModal(false)}>Close</button>
            </div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field"><label>Business / Contact Name</label><input className="input" required value={fName} onChange={(e) => setFName(e.target.value)} placeholder="e.g. Fremantle Logistics Pty Ltd" /></div>
                <div className="field">
                  <label>Contact Type</label>
                  <select className="select" value={fType} onChange={(e) => setFType(e.target.value as Contact['contact_type'])}>
                    <option>Customer</option>
                    <option>Supplier</option>
                    <option>Contractor</option>
                    <option>Advisor</option>
                  </select>
                </div>
              </div>
              <div className="field">
                <label>Australian Business Number (ABN — Live Mod-89 Checksum)</label>
                <div className="row" style={{ gap: 8 }}>
                  <input className="input num" style={{ flex: 1 }} value={fAbn} onChange={(e) => setFAbn(e.target.value)} placeholder="53 004 085 616" />
                  <button type="button" className="btn btn-soft btn-sm" onClick={() => void verifyAbnNow(fAbn)}>Validate ABN</button>
                </div>
                {abnCheck && (
                  <div style={{ marginTop: 4 }}>
                    <span className={`badge ${abnCheck.valid ? 'badge-success' : 'badge-danger'}`}>
                      {abnCheck.valid ? `Valid ABN: ${abnCheck.formatted}` : abnCheck.reason}
                    </span>
                  </div>
                )}
              </div>
              <div className="form-grid-3">
                <div className="field"><label>Primary Person</label><input className="input" value={fPerson} onChange={(e) => setFPerson(e.target.value)} /></div>
                <div className="field"><label>Email</label><input className="input" type="email" value={fEmail} onChange={(e) => setFEmail(e.target.value)} /></div>
                <div className="field"><label>Phone</label><input className="input" value={fPhone} onChange={(e) => setFPhone(e.target.value)} /></div>
                <div className="field"><label>Suburb</label><input className="input" value={fSuburb} onChange={(e) => setFSuburb(e.target.value)} /></div>
                <div className="field">
                  <label>State</label>
                  <select className="select" value={fState} onChange={(e) => setFState(e.target.value)}>
                    {['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'].map((st) => <option key={st}>{st}</option>)}
                  </select>
                </div>
                <div className="field"><label>Postcode</label><input className="input" value={fPost} onChange={(e) => setFPost(e.target.value)} /></div>
              </div>
              <label className="row" style={{ cursor: 'pointer' }}>
                <input type="checkbox" checked={fTpar || fType === 'Contractor'} onChange={(e) => setFTpar(e.target.checked)} />
                <span>Report payments on ATO Taxable Payments Annual Report (TPAR)</span>
              </label>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setShowModal(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Save Contact</button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className={`toast ${toast.err ? 'error' : ''}`}>{toast.msg}</div>}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
