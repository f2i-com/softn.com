import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch, type RuntimeInfo } from '../../../shared/ui/api';
import { csvEscape, downloadTextFile, getPillTheme } from '../../../shared/ui/format';
import {
  IconCheck,
  IconClose,
  IconCopy,
  IconDownload,
  IconEye,
  IconForm,
  IconPlus,
  IconTrash,
} from '../../../shared/ui/icons';

interface FormDef {
  id: number;
  slug: string;
  title: string;
  description: string;
  cover_gradient: string;
  submit_label: string;
  target_table: string;
  is_open: boolean;
  created_at: string;
}

interface FormFieldDef {
  id: number;
  form_id: number;
  field_key: string;
  label: string;
  field_type: 'text' | 'long_text' | 'single_select' | 'number' | 'date' | 'rating' | 'checkbox';
  required: boolean;
  placeholder: string;
  help_text: string;
  options: string[];
  condition: { fieldKey?: string; equals?: string };
  position: number;
}

interface Submission {
  id: number;
  form_id: number;
  status: string;
  submitter_name: string;
  submitter_email: string;
  answers: Record<string, unknown>;
  reviewer_note: string;
  created_at: string;
}

const GRADIENTS = [
  'linear-gradient(135deg,#6d28d9,#2563eb)',
  'linear-gradient(135deg,#ea580c,#db2777)',
  'linear-gradient(135deg,#0d9488,#0284c7)',
  'linear-gradient(135deg,#059669,#10b981)',
  'linear-gradient(135deg,#1e293b,#4f46e5)',
];

export const App: React.FC = () => {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [forms, setForms] = useState<FormDef[]>([]);
  const [fields, setFields] = useState<FormFieldDef[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [activeFormId, setActiveFormId] = useState<number>(1);
  const [tab, setTab] = useState<'preview' | 'builder' | 'submissions'>('preview');

  // Live form input state
  const [submitterName, setSubmitterName] = useState('');
  const [submitterEmail, setSubmitterEmail] = useState('');
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [submittedOk, setSubmittedOk] = useState<number | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  // Modals
  const [showNewForm, setShowNewForm] = useState(false);
  const [showAddField, setShowAddField] = useState(false);
  const [showEmbed, setShowEmbed] = useState(false);
  const [newFormTitle, setNewFormTitle] = useState('');
  const [newFormTable, setNewFormTable] = useState('Initiatives');

  // Add Field draft
  const [fLabel, setFLabel] = useState('');
  const [fType, setFType] = useState<FormFieldDef['field_type']>('text');
  const [fRequired, setFRequired] = useState(false);
  const [fOptions, setFOptions] = useState('Option 1, Option 2, Option 3');
  const [fCondField, setFCondField] = useState('');
  const [fCondVal, setFCondVal] = useState('');

  const [toast, setToast] = useState<string | null>(null);
  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((p) => (p === msg ? null : p)), 2800);
  }, []);

  const loadState = useCallback(async () => {
    const [rt, data] = await Promise.all([
      apiFetch<RuntimeInfo>('/api/runtime'),
      apiFetch<{ forms: FormDef[]; fields: FormFieldDef[]; submissions: Submission[] }>('/api/state'),
    ]);
    setRuntime(rt);
    setForms(data.forms);
    setFields(data.fields);
    setSubmissions(data.submissions);
  }, []);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  const activeForm = forms.find((f) => f.id === activeFormId) ?? forms[0] ?? null;
  const formFields = useMemo(
    () => fields.filter((f) => f.form_id === activeForm?.id).sort((a, b) => a.position - b.position),
    [fields, activeForm]
  );
  const formSubs = useMemo(
    () => submissions.filter((s) => s.form_id === activeForm?.id),
    [submissions, activeForm]
  );

  const isFieldVisible = (field: FormFieldDef): boolean => {
    if (!field.condition?.fieldKey || !field.condition?.equals) return true;
    return String(answers[field.condition.fieldKey] ?? '') === field.condition.equals;
  };

  const handleSubmitLiveForm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeForm) return;
    setFormError(null);
    try {
      const res = await apiFetch<{ submission: Submission }>(`/api/forms/${activeForm.id}/submissions`, {
        method: 'POST',
        body: {
          submitter_name: submitterName.trim() || 'Workspace Contributor',
          submitter_email: submitterEmail.trim(),
          answers,
        },
      });
      setSubmissions((prev) => [res.submission, ...prev]);
      setSubmittedOk(res.submission.id);
      setAnswers({});
      setSubmitterName('');
      setSubmitterEmail('');
      notify(`Submission #${res.submission.id} saved into XDB SQLite`);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Submission failed');
    }
  };

  const handleCreateForm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFormTitle.trim()) return;
    const res = await apiFetch<{ form: { id: number; title: string } }>('/api/forms', {
      method: 'POST',
      body: { title: newFormTitle.trim(), target_table: newFormTable.trim() || 'Intake' },
    });
    await loadState();
    setActiveFormId(res.form.id);
    setTab('builder');
    setShowNewForm(false);
    setNewFormTitle('');
    notify(`Created form "${res.form.title}"`);
  };

  const handleUpdateFormMeta = async (patch: Partial<FormDef>) => {
    if (!activeForm) return;
    await apiFetch(`/api/forms/${activeForm.id}`, { method: 'PATCH', body: patch });
    setForms((prev) => prev.map((f) => (f.id === activeForm.id ? { ...f, ...patch } : f)));
  };

  const handleAddField = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeForm || !fLabel.trim()) return;
    const condition = fCondField && fCondVal.trim() ? { fieldKey: fCondField, equals: fCondVal.trim() } : {};
    const options = fType === 'single_select' ? fOptions.split(',').map((s) => s.trim()).filter(Boolean) : [];
    const res = await apiFetch<{ field: FormFieldDef }>(`/api/forms/${activeForm.id}/fields`, {
      method: 'POST',
      body: { label: fLabel.trim(), field_type: fType, required: fRequired, options, condition },
    });
    setFields((prev) => [...prev, res.field]);
    setShowAddField(false);
    setFLabel('');
    setFCondField('');
    setFCondVal('');
    notify(`Added field "${res.field.label}"`);
  };

  const handleDeleteField = async (id: number) => {
    await apiFetch(`/api/form-fields/${id}`, { method: 'DELETE' });
    setFields((prev) => prev.filter((f) => f.id !== id));
    notify('Removed form field');
  };

  const handleUpdateSubmission = async (id: number, status: string, reviewer_note: string) => {
    const res = await apiFetch<{ submission: Submission }>(`/api/submissions/${id}`, {
      method: 'PATCH',
      body: { status, reviewer_note },
    });
    setSubmissions((prev) => prev.map((s) => (s.id === id ? res.submission : s)));
    notify(`Submission #${id} marked ${status}`);
  };

  const exportSubmissionsCsv = () => {
    if (!activeForm) return;
    const keys = formFields.map((f) => f.field_key);
    const header = ['ID', 'Status', 'Submitter', 'Email', 'Submitted At', ...formFields.map((f) => f.label)]
      .map(csvEscape)
      .join(',');
    const rows = formSubs.map((s) =>
      [s.id, s.status, s.submitter_name, s.submitter_email, s.created_at, ...keys.map((k) => s.answers[k] ?? '')]
        .map(csvEscape)
        .join(',')
    );
    downloadTextFile(`${activeForm.slug}-submissions.csv`, [header, ...rows].join('\n'), 'text/csv;charset=utf-8');
    notify(`Exported ${formSubs.length} submissions to CSV`);
  };

  return (
    <div className="bg-shell">
      <header className="bg-topbar">
        <div className="bg-topbar-left">
          <div className="bg-brand">
            <div className="bg-brand-badge" style={{ background: '#db2777' }}>
              <IconForm size={15} />
            </div>
            <div>
              <div className="bg-brand-title">Forms Builder &amp; Intake Hub</div>
              <div className="bg-brand-sub">Conditional logic forms feeding XDB SQLite directly</div>
            </div>
          </div>

          <div className="bg-segmented">
            <button type="button" className={`bg-seg-btn ${tab === 'preview' ? 'active' : ''}`} onClick={() => setTab('preview')}>
              <IconEye size={13} /> Live Form
            </button>
            <button type="button" className={`bg-seg-btn ${tab === 'builder' ? 'active' : ''}`} onClick={() => setTab('builder')}>
              <IconForm size={13} /> Builder ({formFields.length})
            </button>
            <button type="button" className={`bg-seg-btn ${tab === 'submissions' ? 'active' : ''}`} onClick={() => setTab('submissions')}>
              Submissions ({formSubs.length})
            </button>
          </div>
        </div>

        <div className="bg-topbar-right">
          {runtime && (
            <span className={`runtime-pill ${runtime.mode === 'standalone-php' ? 'standalone' : ''}`}>
              <span className="runtime-dot" />
              {runtime.mode === 'zipp-wasm' ? 'ZIPP PHP 8 + XDB' : 'Standalone PHP'}
            </span>
          )}
          <button type="button" className="btn btn-sm" onClick={() => setShowEmbed(true)}>
            <IconCopy size={13} /> Share &amp; Embed
          </button>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setShowNewForm(true)}>
            <IconPlus size={13} /> New Form
          </button>
        </div>
      </header>

      <div className="bg-body">
        <aside className="bg-rail">
          <div className="bg-rail-section">
            <div className="bg-rail-label">
              <span>Intake Forms</span>
              <span>{forms.length}</span>
            </div>
            {forms.map((f) => {
              const count = submissions.filter((s) => s.form_id === f.id).length;
              return (
                <button
                  key={f.id}
                  type="button"
                  className={`bg-rail-item ${activeForm?.id === f.id ? 'active' : ''}`}
                  onClick={() => {
                    setActiveFormId(f.id);
                    setSubmittedOk(null);
                    setAnswers({});
                    setFormError(null);
                  }}
                >
                  <IconForm size={13} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.title}</span>
                  <span className="bg-rail-count">{count}</span>
                </button>
              );
            })}
          </div>
        </aside>

        <main className="bg-content">
          <div className="bg-scroll-page">
            {/* TAB 1: LIVE BRANDED CONDITIONAL FORM */}
            {tab === 'preview' && activeForm && (
              <div style={{ maxWidth: 680, margin: '4px auto 24px' }}>
                <div className="card" style={{ overflow: 'hidden', boxShadow: 'var(--shadow-md)' }}>
                  <div style={{ background: activeForm.cover_gradient, color: '#ffffff', padding: '28px 30px' }}>
                    <span className="pill" style={{ background: 'rgba(255,255,255,0.2)', color: '#ffffff', marginBottom: 10 }}>
                      Feeds Table: {activeForm.target_table}
                    </span>
                    <h1 style={{ margin: '6px 0 6px', fontSize: 23, letterSpacing: '-0.025em' }}>{activeForm.title}</h1>
                    <p style={{ margin: 0, fontSize: 13.5, opacity: 0.92 }}>{activeForm.description}</p>
                  </div>

                  {submittedOk ? (
                    <div style={{ padding: '38px 30px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
                      <div style={{ width: 50, height: 50, borderRadius: 99, background: '#dcfce7', color: '#15803d', display: 'grid', placeItems: 'center' }}>
                        <IconCheck size={24} />
                      </div>
                      <h2 style={{ margin: 0 }}>Submission #{submittedOk} Received</h2>
                      <p style={{ margin: 0, color: 'var(--ink-secondary)', maxWidth: 420 }}>
                        Your response has been persisted directly into the XDB SQLite database and is ready in the Submissions Triage queue.
                      </p>
                      <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
                        <button type="button" className="btn btn-primary" onClick={() => setSubmittedOk(null)}>
                          Submit Another Response
                        </button>
                        <button type="button" className="btn" onClick={() => setTab('submissions')}>
                          View in Triage Table →
                        </button>
                      </div>
                    </div>
                  ) : (
                    <form onSubmit={(e) => void handleSubmitLiveForm(e)} style={{ padding: '24px 30px 28px', display: 'flex', flexDirection: 'column', gap: 16 }}>
                      {formError && (
                        <div style={{ padding: '10px 12px', borderRadius: 8, background: '#fee2e2', color: '#b91c1c', fontWeight: 600, fontSize: 13 }}>
                          {formError}
                        </div>
                      )}

                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                        <label className="field-label">
                          Your Name *
                          <input className="input" required placeholder="Maya Lin" value={submitterName} onChange={(e) => setSubmitterName(e.target.value)} />
                        </label>
                        <label className="field-label">
                          Work Email
                          <input className="input" type="email" placeholder="maya@company.example" value={submitterEmail} onChange={(e) => setSubmitterEmail(e.target.value)} />
                        </label>
                      </div>

                      {formFields.map((field) => {
                        if (!isFieldVisible(field)) return null;
                        const val = answers[field.field_key];
                        return (
                          <div key={field.id} className="field-label" style={{ gap: 6 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <span style={{ color: 'var(--ink)', fontSize: 13 }}>
                                {field.label} {field.required && <span style={{ color: '#dc2626' }}>*</span>}
                              </span>
                              {field.condition?.fieldKey && (
                                <span className="pill" style={{ background: '#ede9fe', color: '#6d28d9', fontSize: 10 }}>
                                  Conditional
                                </span>
                              )}
                            </div>
                            {field.help_text && <span style={{ fontSize: 11.5, color: 'var(--ink-muted)', fontWeight: 400 }}>{field.help_text}</span>}

                            {field.field_type === 'single_select' ? (
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
                                {field.options.map((opt) => {
                                  const selected = String(val ?? '') === opt;
                                  const pt = getPillTheme(opt);
                                  return (
                                    <button
                                      key={opt}
                                      type="button"
                                      onClick={() => setAnswers((p) => ({ ...p, [field.field_key]: opt }))}
                                      className="pill"
                                      style={{
                                        background: selected ? pt.dot : pt.bg,
                                        color: selected ? '#ffffff' : pt.fg,
                                        borderColor: pt.border,
                                        padding: '5px 12px',
                                        cursor: 'pointer',
                                        fontSize: 12.5,
                                      }}
                                    >
                                      {opt}
                                    </button>
                                  );
                                })}
                              </div>
                            ) : field.field_type === 'rating' ? (
                              <div style={{ display: 'flex', gap: 6 }}>
                                {[1, 2, 3, 4, 5].map((star) => (
                                  <button
                                    key={star}
                                    type="button"
                                    onClick={() => setAnswers((p) => ({ ...p, [field.field_key]: star }))}
                                    style={{
                                      border: '1px solid var(--border)',
                                      borderRadius: 7,
                                      padding: '6px 12px',
                                      background: Number(val || 0) >= star ? '#fef3c7' : '#ffffff',
                                      color: Number(val || 0) >= star ? '#d97706' : '#9ca3af',
                                      fontSize: 16,
                                      cursor: 'pointer',
                                    }}
                                  >
                                    ★
                                  </button>
                                ))}
                              </div>
                            ) : field.field_type === 'long_text' ? (
                              <textarea
                                className="textarea"
                                required={field.required}
                                placeholder={field.placeholder}
                                value={String(val ?? '')}
                                onChange={(e) => setAnswers((p) => ({ ...p, [field.field_key]: e.target.value }))}
                              />
                            ) : field.field_type === 'checkbox' ? (
                              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                                <input
                                  type="checkbox"
                                  checked={Boolean(val)}
                                  onChange={(e) => setAnswers((p) => ({ ...p, [field.field_key]: e.target.checked }))}
                                />
                                Yes / Confirmed
                              </label>
                            ) : (
                              <input
                                className="input"
                                type={field.field_type === 'number' ? 'number' : field.field_type === 'date' ? 'date' : 'text'}
                                required={field.required}
                                placeholder={field.placeholder}
                                value={String(val ?? '')}
                                onChange={(e) =>
                                  setAnswers((p) => ({
                                    ...p,
                                    [field.field_key]: field.field_type === 'number' ? Number(e.target.value) : e.target.value,
                                  }))
                                }
                              />
                            )}
                          </div>
                        );
                      })}

                      <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 8 }}>
                        <button type="submit" className="btn btn-primary" style={{ padding: '10px 20px', fontSize: 13.5 }}>
                          {activeForm.submit_label}
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              </div>
            )}

            {/* TAB 2: VISUAL FORM BUILDER */}
            {tab === 'builder' && activeForm && (
              <div className="bg-scroll-inner" style={{ maxWidth: 940 }}>
                <div className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong>Branding &amp; Cover Header</strong>
                    <button type="button" className="btn btn-sm btn-primary" onClick={() => setShowAddField(true)}>
                      <IconPlus size={13} /> Add Form Field
                    </button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <label className="field-label">
                      Form Title
                      <input
                        className="input"
                        value={activeForm.title}
                        onChange={(e) => void handleUpdateFormMeta({ title: e.target.value })}
                      />
                    </label>
                    <label className="field-label">
                      Submit Button Text
                      <input
                        className="input"
                        value={activeForm.submit_label}
                        onChange={(e) => void handleUpdateFormMeta({ submit_label: e.target.value })}
                      />
                    </label>
                  </div>
                  <label className="field-label">
                    Cover Gradient
                    <div style={{ display: 'flex', gap: 8 }}>
                      {GRADIENTS.map((g) => (
                        <button
                          key={g}
                          type="button"
                          onClick={() => void handleUpdateFormMeta({ cover_gradient: g })}
                          style={{
                            width: 44,
                            height: 26,
                            borderRadius: 6,
                            background: g,
                            border: activeForm.cover_gradient === g ? '3px solid #111827' : '1px solid #cbd5e1',
                            cursor: 'pointer',
                          }}
                        />
                      ))}
                    </div>
                  </label>
                </div>

                <div className="card">
                  <div className="card-header">
                    <span className="card-title">Form Fields &amp; Conditional Logic ({formFields.length})</span>
                  </div>
                  <div>
                    {formFields.map((f, i) => (
                      <div
                        key={f.id}
                        style={{
                          padding: '12px 16px',
                          borderBottom: '1px solid var(--border-subtle)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 12,
                        }}
                      >
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: 11.5, color: 'var(--ink-muted)', fontWeight: 700 }}>#{i + 1}</span>
                            <strong>{f.label}</strong>
                            <span className="pill" style={{ background: '#f1f5f9', color: '#334155', fontSize: 11 }}>{f.field_type}</span>
                            {f.required && <span className="pill" style={{ background: '#fee2e2', color: '#b91c1c', fontSize: 10.5 }}>Required</span>}
                            {f.condition?.fieldKey && (
                              <span className="pill" style={{ background: '#ede9fe', color: '#6d28d9', fontSize: 10.5 }}>
                                If {f.condition.fieldKey} = &ldquo;{f.condition.equals}&rdquo;
                              </span>
                            )}
                          </div>
                          {f.options.length > 0 && (
                            <div style={{ fontSize: 11.5, color: 'var(--ink-muted)', marginTop: 3 }}>
                              Choices: {f.options.join(' · ')}
                            </div>
                          )}
                        </div>
                        <button type="button" className="btn btn-xs btn-danger" onClick={() => void handleDeleteField(f.id)}>
                          <IconTrash size={12} /> Remove
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* TAB 3: SUBMISSIONS TRIAGE TABLE */}
            {tab === 'submissions' && activeForm && (
              <div className="bg-scroll-inner">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <h2 style={{ margin: 0, fontSize: 18 }}>Submissions for {activeForm.title}</h2>
                    <span style={{ fontSize: 12.5, color: 'var(--ink-muted)' }}>{formSubs.length} persisted SQLite records</span>
                  </div>
                  <button type="button" className="btn btn-sm" onClick={exportSubmissionsCsv}>
                    <IconDownload size={13} /> Export CSV
                  </button>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {formSubs.map((s) => {
                    const pt = getPillTheme(s.status);
                    return (
                      <div key={s.id} className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <strong>#{s.id} · {s.submitter_name}</strong>
                            {s.submitter_email && <span style={{ fontSize: 12, color: 'var(--ink-muted)' }}>{s.submitter_email}</span>}
                            <span style={{ fontSize: 11.5, color: 'var(--ink-muted)' }}>· {s.created_at}</span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span className="pill" style={{ background: pt.bg, color: pt.fg, borderColor: pt.border }}>
                              <span className="pill-dot" style={{ background: pt.dot }} />
                              {s.status}
                            </span>
                            {(['New', 'Reviewing', 'Approved', 'Archived'] as const).map((st) => (
                              <button
                                key={st}
                                type="button"
                                className={`btn btn-xs ${s.status === st ? 'btn-primary' : ''}`}
                                onClick={() => void handleUpdateSubmission(s.id, st, s.reviewer_note)}
                              >
                                {st}
                              </button>
                            ))}
                          </div>
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8, background: '#fafaf9', padding: 12, borderRadius: 8, border: '1px solid var(--border-subtle)' }}>
                          {Object.entries(s.answers).map(([k, v]) => (
                            <div key={k} style={{ fontSize: 12.5 }}>
                              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: 'var(--ink-muted)' }}>{k}</div>
                              <div style={{ marginTop: 2 }}>{String(v)}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                  {formSubs.length === 0 && <div className="empty-state">No submissions yet. Try filling out the Live Form tab!</div>}
                </div>
              </div>
            )}
          </div>
        </main>
      </div>

      {/* Modals */}
      {showNewForm && (
        <div className="modal-backdrop" onClick={() => setShowNewForm(false)}>
          <form className="modal-card" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void handleCreateForm(e)}>
            <div className="modal-head">
              <strong>Create Intake Form</strong>
              <button type="button" className="btn btn-xs btn-ghost" onClick={() => setShowNewForm(false)}><IconClose size={15} /></button>
            </div>
            <div className="modal-body">
              <label className="field-label">
                Form Title
                <input className="input" required placeholder="e.g. Bug Report Intake" value={newFormTitle} onChange={(e) => setNewFormTitle(e.target.value)} />
              </label>
              <label className="field-label">
                Destination Base Table
                <input className="input" value={newFormTable} onChange={(e) => setNewFormTable(e.target.value)} />
              </label>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setShowNewForm(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Create Form</button>
            </div>
          </form>
        </div>
      )}

      {showAddField && (
        <div className="modal-backdrop" onClick={() => setShowAddField(false)}>
          <form className="modal-card" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void handleAddField(e)}>
            <div className="modal-head">
              <strong>Add Form Field</strong>
              <button type="button" className="btn btn-xs btn-ghost" onClick={() => setShowAddField(false)}><IconClose size={15} /></button>
            </div>
            <div className="modal-body">
              <label className="field-label">
                Field Label
                <input className="input" required placeholder="e.g. Department, Budget, Target Date" value={fLabel} onChange={(e) => setFLabel(e.target.value)} />
              </label>
              <label className="field-label">
                Input Type
                <select className="select" value={fType} onChange={(e) => setFType(e.target.value as FormFieldDef['field_type'])}>
                  <option value="text">Single Line Text</option>
                  <option value="long_text">Long Paragraph</option>
                  <option value="single_select">Single Select Pills</option>
                  <option value="number">Number</option>
                  <option value="date">Date</option>
                  <option value="rating">5-Star Rating</option>
                  <option value="checkbox">Checkbox</option>
                </select>
              </label>
              {fType === 'single_select' && (
                <label className="field-label">
                  Options (comma-separated)
                  <input className="input" value={fOptions} onChange={(e) => setFOptions(e.target.value)} />
                </label>
              )}
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
                <input type="checkbox" checked={fRequired} onChange={(e) => setFRequired(e.target.checked)} />
                Required field
              </label>
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Optional Conditional Visibility</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <select className="select" value={fCondField} onChange={(e) => setFCondField(e.target.value)}>
                    <option value="">Always visible</option>
                    {formFields.map((ff) => (
                      <option key={ff.id} value={ff.field_key}>When {ff.label} equals...</option>
                    ))}
                  </select>
                  <input className="input" placeholder="Matching value" value={fCondVal} onChange={(e) => setFCondVal(e.target.value)} disabled={!fCondField} />
                </div>
              </div>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setShowAddField(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Add Field</button>
            </div>
          </form>
        </div>
      )}

      {showEmbed && activeForm && (
        <div className="modal-backdrop" onClick={() => setShowEmbed(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <strong>Share &amp; Embed Form</strong>
              <button type="button" className="btn btn-xs btn-ghost" onClick={() => setShowEmbed(false)}><IconClose size={15} /></button>
            </div>
            <div className="modal-body">
              <div style={{ fontSize: 12.5, color: 'var(--ink-secondary)' }}>
                Embed this portable SoftN Form container in any internal portal or public site — works offline in ZIPP WASM or connected to standalone PHP:
              </div>
              <pre className="code-block">{`<softn-app
  src="/bundles/basegrid-forms.softn"
  data-form="${activeForm.slug}"
></softn-app>`}</pre>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn btn-primary" onClick={() => setShowEmbed(false)}>Done</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
};
