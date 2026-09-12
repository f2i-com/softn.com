import React, { useEffect, useId, useRef, useState } from 'react';
import { useModalFocus } from '../../hooks/useModalFocus';
import type { EntityDef, RelationshipDraft } from '../../types/builder';

export interface RelationshipDialogProps {
  entities: EntityDef[];
  initial: RelationshipDraft;
  editing: boolean;
  /** Null saves successfully; an error keeps the dialog and draft open. */
  onSave: (draft: RelationshipDraft) => string | null;
  onClose: () => void;
}

const cardinalities: Array<{ value: RelationshipDraft['type']; symbol: string; label: string; example: string }> = [
  { value: 'one-to-one', symbol: '1 : 1', label: 'One to one', example: 'One person has one profile.' },
  { value: 'one-to-many', symbol: '1 : N', label: 'One to many', example: 'One customer has many orders.' },
  { value: 'many-to-one', symbol: 'N : 1', label: 'Many to one', example: 'Many orders belong to one customer.' },
  { value: 'many-to-many', symbol: 'N : N', label: 'Many to many', example: 'Many students take many courses.' },
];

function canStoreReference(type: RelationshipDraft['type']) {
  return type === 'one-to-one' || type === 'many-to-one';
}

function referenceFields(source: EntityDef | undefined, targetId: string) {
  return source?.fields.filter((field) => field.name !== 'id'
    && (field.type === 'string' || field.type === 'reference')
    && (!field.refEntity || field.refEntity === targetId)) ?? [];
}

/** Mount with a fresh key when opening another relationship. */
export function RelationshipDialog({ entities, initial, editing, onSave, onClose }: RelationshipDialogProps) {
  const id = useId();
  const dialogRef = useModalFocus(true, onClose, '[data-relationship-source]');
  const [sourceId, setSourceId] = useState(initial.sourceEntityId);
  const [targetId, setTargetId] = useState(initial.targetEntityId);
  const [type, setType] = useState(initial.type);
  const [fieldChoice, setFieldChoice] = useState(initial.newFieldName !== undefined ? 'new' : initial.sourceFieldId ? `field:${initial.sourceFieldId}` : '');
  const [newFieldName, setNewFieldName] = useState(initial.newFieldName ?? '');
  const [error, setError] = useState<{ message: string } | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!error) return;
    // Save remains visible in the footer even when the form body is scrolled.
    // Bring each failed attempt into view, including a repeated same error.
    errorRef.current?.focus({ preventScroll: true });
    errorRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [error]);
  const source = entities.find((entity) => entity.id === sourceId);
  const target = entities.find((entity) => entity.id === targetId);
  const fields = referenceFields(source, targetId);
  const storesReference = canStoreReference(type);
  // A collection/field may be removed while the dialog is open. Never submit
  // a hidden, stale reference that is no longer among the available choices.
  const referenceChoice = storesReference && source && target
    && (fieldChoice === 'new' || fields.some((field) => `field:${field.id}` === fieldChoice)) ? fieldChoice : '';

  const save = () => {
    if (!source || !target) { setError({ message: 'Choose a source and target collection.' }); return; }
    if (referenceChoice === 'new' && !newFieldName.trim()) { setError({ message: 'Enter a name for the new reference field.' }); return; }
    const draft: RelationshipDraft = {
      sourceEntityId: source.id,
      targetEntityId: target.id,
      type,
      sourceFieldId: referenceChoice.startsWith('field:') ? referenceChoice.slice(6) : '',
      ...(referenceChoice === 'new' ? { newFieldName: newFieldName.trim() } : {}),
    };
    try {
      const message = onSave(draft);
      if (message) { setError({ message }); return; }
      onClose();
    } catch (cause) {
      setError({ message: cause instanceof Error ? cause.message : 'The relationship could not be saved. Try again.' });
    }
  };

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div ref={dialogRef} style={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-intro`} tabIndex={-1} onClick={(event) => event.stopPropagation()}>
        <div style={styles.header}>
          <div style={{ minWidth: 0 }}>
            <div style={styles.eyebrow}>DATA MODEL</div>
            <h2 id={`${id}-title`} style={styles.title}>{editing ? 'Edit relationship' : 'Add relationship'}</h2>
          </div>
          <button type="button" style={styles.close} aria-label="Close relationship dialog" onClick={onClose}>×</button>
        </div>
        <form style={styles.form} onSubmit={(event) => { event.preventDefault(); save(); }} onKeyDown={(event) => {
          // Let native selects and buttons keep their Enter behavior; text
          // fields and cardinality radios can submit without moving focus.
          if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && event.target instanceof HTMLInputElement) {
            event.preventDefault(); event.currentTarget.requestSubmit();
          }
        }}>
          <div style={styles.body}>
            <p id={`${id}-intro`} style={styles.intro}>Connect two collections to describe how their records belong together.</p>
            <div style={styles.collections}>
              <div style={styles.field}>
                <label htmlFor={`${id}-source`} style={styles.label}>Source collection</label>
                <select id={`${id}-source`} data-relationship-source style={styles.input} value={source?.id ?? ''} onChange={(event) => {
                  setSourceId(event.target.value); setFieldChoice(''); setError(null);
                }}>
                  <option value="">Choose a collection</option>
                  {entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.name}</option>)}
                </select>
              </div>
              <div style={styles.field}>
                <label htmlFor={`${id}-target`} style={styles.label}>Target collection</label>
                <select id={`${id}-target`} style={styles.input} value={target?.id ?? ''} onChange={(event) => {
                  const nextId = event.target.value;
                  setTargetId(nextId);
                  if (fieldChoice !== 'new' && !referenceFields(source, nextId).some((field) => `field:${field.id}` === fieldChoice)) setFieldChoice('');
                  setError(null);
                }}>
                  <option value="">Choose a collection</option>
                  {entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.name}</option>)}
                </select>
              </div>
            </div>
            <fieldset style={styles.fieldset}>
              <legend style={{ ...styles.label, marginBottom: 10 }}>Relationship type</legend>
              <div style={styles.cardGrid}>
                {cardinalities.map((choice) => (
                  <label key={choice.value} style={{ ...styles.card, ...(type === choice.value ? styles.activeCard : {}) }}>
                    <span style={styles.cardHeading}>
                      <input type="radio" name={`${id}-type`} value={choice.value} checked={type === choice.value} style={{ accentColor: 'var(--coral)', margin: 0 }} onChange={() => {
                        setType(choice.value); if (!canStoreReference(choice.value)) setFieldChoice(''); setError(null);
                      }} />
                      <span style={styles.cardTitle}>{choice.label}</span>
                      <span style={styles.symbol} aria-hidden="true">{choice.symbol}</span>
                    </span>
                    <span style={styles.hint}>{choice.example}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div style={styles.referenceBox}>
              {storesReference ? (
                <>
                  <label htmlFor={`${id}-reference`} style={styles.label}>Reference field <span style={styles.optional}>Optional</span></label>
                  <p id={`${id}-reference-help`} style={styles.hint}>
                    {source?.name ?? 'The source collection'} stores the target record ID from {target?.name ?? 'the target collection'} in this field.
                  </p>
                  <select id={`${id}-reference`} style={styles.input} aria-describedby={`${id}-reference-help`} value={referenceChoice} disabled={!source || !target} onChange={(event) => { setFieldChoice(event.target.value); setError(null); }}>
                    <option value="">Diagram only</option>
                    {fields.map((field) => <option key={field.id} value={`field:${field.id}`}>{field.name} · {field.type}</option>)}
                    <option value="new">Create reference field…</option>
                  </select>
                  {referenceChoice === 'new' && (
                    <div style={{ ...styles.field, marginTop: 14 }}>
                      <label htmlFor={`${id}-new-field`} style={styles.label}>New reference field name</label>
                      <input id={`${id}-new-field`} style={styles.input} value={newFieldName} placeholder="customerId" autoComplete="off" spellCheck={false} onChange={(event) => { setNewFieldName(event.target.value); setError(null); }} />
                      <span style={styles.hint}>Adds a reference field to {source?.name}. Existing records stay unchanged.</span>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div style={styles.label}>Diagram only</div>
                  <p style={styles.hint}>{type === 'one-to-many' ? 'To store a reference on the many side, reverse the collections and choose Many to one.' : 'To store many-to-many links, use a linking collection with a reference to each side.'}</p>
                </>
              )}
              <p style={{ ...styles.hint, marginTop: 12 }}>Diagram only leaves existing fields and records unchanged.</p>
            </div>
            <p style={styles.hint}>Cardinality describes your model; app logic controls validation.</p>
            {error && <div ref={errorRef} role="alert" tabIndex={-1} style={styles.error}>{error.message}</div>}
          </div>
          <div style={styles.footer}>
            <button type="button" style={styles.button} onClick={onClose}>Cancel</button>
            <button type="submit" style={{ ...styles.button, ...styles.primary }}>{editing ? 'Save relationship' : 'Add relationship'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, zIndex: 1200, background: 'rgba(0, 0, 0, 0.58)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, boxSizing: 'border-box' },
  dialog: { width: 'min(680px, 100%)', minWidth: 0, maxHeight: 'calc(100dvh - 32px)', display: 'flex', flexDirection: 'column', overflow: 'hidden', color: 'var(--paper)', background: 'var(--ink-2)', border: '1px solid var(--line)', borderRadius: 18, boxShadow: '0 24px 80px rgba(0,0,0,0.32)' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '22px 24px 18px', borderBottom: '1px solid var(--line-soft)' },
  eyebrow: { fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', color: 'var(--coral)', marginBottom: 6 },
  title: { margin: 0, fontFamily: 'var(--b-display)', fontSize: 23, letterSpacing: '-0.025em', overflowWrap: 'anywhere' },
  close: { width: 36, height: 36, flexShrink: 0, border: '1px solid var(--line)', borderRadius: 9, background: 'transparent', color: 'var(--dim)', fontSize: 23, cursor: 'pointer' },
  form: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 },
  body: { display: 'flex', flexDirection: 'column', gap: 22, minHeight: 0, overflowY: 'auto', padding: '20px 24px' },
  intro: { margin: 0, fontSize: 14, lineHeight: 1.6, color: 'var(--dim)' },
  collections: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 230px), 1fr))', gap: 16 },
  field: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 },
  label: { display: 'block', fontSize: 13, lineHeight: 1.5, fontWeight: 600, color: 'var(--paper)' },
  input: { width: '100%', minWidth: 0, boxSizing: 'border-box', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--ink)', color: 'var(--paper)', fontFamily: 'inherit', fontSize: 14 },
  fieldset: { margin: 0, padding: 0, border: 0, minWidth: 0 },
  cardGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 230px), 1fr))', gap: 10 },
  card: { display: 'flex', flexDirection: 'column', gap: 9, padding: 13, minWidth: 0, border: '1px solid var(--line)', borderRadius: 10, background: 'var(--ink)', cursor: 'pointer' },
  activeCard: { borderColor: 'var(--coral)', background: 'color-mix(in srgb, var(--coral) 8%, var(--ink))' },
  cardHeading: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
  cardTitle: { fontSize: 13, fontWeight: 600 },
  symbol: { marginLeft: 'auto', fontFamily: 'var(--b-mono)', fontSize: 11, whiteSpace: 'nowrap', color: 'var(--coral)' },
  hint: { display: 'block', margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--dim)', overflowWrap: 'anywhere' },
  referenceBox: { padding: 16, background: 'var(--ink)', border: '1px solid var(--line-soft)', borderRadius: 12, display: 'flex', flexDirection: 'column', gap: 8 },
  optional: { fontSize: 11, fontWeight: 400, marginLeft: 6, color: 'var(--dim)' },
  footer: { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 10, padding: '16px 24px', borderTop: '1px solid var(--line-soft)' },
  button: { minHeight: 40, padding: '9px 16px', borderRadius: 8, border: '1px solid var(--line)', background: 'transparent', color: 'var(--paper)', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' },
  primary: { background: 'var(--coral)', borderColor: 'var(--coral)', color: '#fff' },
  error: { padding: '10px 12px', borderRadius: 8, border: '1px solid var(--coral)', color: 'var(--paper)', background: 'color-mix(in srgb, var(--coral) 10%, var(--ink))', fontSize: 13, lineHeight: 1.5, overflowWrap: 'anywhere' },
};
