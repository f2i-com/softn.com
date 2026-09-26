import { isHostedEditor } from '@softn/editor-shared/hostedEditor';
import React from 'react';
import { useHostedSaveLabel } from '@softn/editor-shared/useHostedSaveLabel';

/** Keep the document reachable on a phone while full editing uses the wider layout. */
export function NarrowScreenNotice({ studioUrl, runtimeUrl, projectName, isDirty, isSaving = false, onOpen, onSave, onPreview }: {
  studioUrl: string; runtimeUrl: string; projectName: string; isDirty: boolean; isSaving?: boolean;
  onOpen: () => void; onSave: () => void; onPreview: () => void;
}): React.ReactElement {
  const hosted = isHostedEditor();
  const saveLabel = useHostedSaveLabel() ?? 'Save app';
  return (
    <div style={s.wrap}>
      <div style={s.card}>
        <svg width="30" height="30" viewBox="0 0 26 26" style={{ color: 'var(--dim)' }} aria-hidden="true">
          <rect x="3.5" y="4.5" width="19" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M3.5 9.5h19M9 9.5v9" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
        <h1 style={s.title}>Your app, on a smaller screen</h1>
        <p style={s.copy}>
          Open, preview and save your app here. Use a screen at least 900 pixels wide for the canvas, schema and code editors.
        </p>
        <div style={s.project}>
          <strong style={{ overflowWrap: 'anywhere' }}>{projectName}</strong>
          <p style={{ ...s.copy, marginTop: 6 }} role="status">{isDirty ? 'You have unsaved changes. Save your app before leaving.' : 'Preview your current workspace or open a .softn bundle.'}</p>
          <div style={s.actions}>
            <button type="button" onClick={onPreview} style={{ ...s.action, ...s.primary }}>Preview app</button>
            <button type="button" onClick={onSave} style={s.action} disabled={isSaving} aria-busy={isSaving}>{isSaving ? 'Saving…' : saveLabel}</button>
            <button type="button" onClick={onOpen} style={s.action}>Open app</button>
          </div>
        </div>
        <p style={s.copy}>{hosted ? `${saveLabel} returns your changes to FormLogic. To keep editing on your phone, open AI Studio from there.` : "Use Studio to create with AI, or open an exported app in the runtime:"}</p>
        {!hosted && <div style={s.actions}>
          <a href={studioUrl} style={{ ...s.action, ...s.primary }}>Open Studio</a>
          <a href={runtimeUrl} style={s.action}>Open the runtime</a>
        </div>}
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  wrap: {
    // Drawn from the tokens, not the dark values they happen to have: this
    // page used to stay dark when the theme was light. It scrolls itself,
    // because the document around it never does.
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'safe center',
    justifyContent: 'center',
    padding: '1.5rem',
    background: 'var(--ink)',
    color: 'var(--paper)',
    fontFamily: 'var(--body)',
  },
  card: { maxWidth: 380, display: 'flex', flexDirection: 'column', gap: '0.75rem', margin: 'auto 0' },
  project: { border: '1px solid var(--line)', background: 'var(--ink-2)', borderRadius: 12, padding: 16, margin: '8px 0' },
  title: { margin: '0.5rem 0 0', fontFamily: 'var(--display)', fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.15 },
  copy: { margin: 0, fontSize: 14.5, lineHeight: 1.6, color: 'var(--dim)' },
  actions: { display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.5rem' },
  action: {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: 44,
    padding: '0 1rem',
    borderRadius: 8,
    border: '1px solid var(--line)',
    color: 'var(--paper)',
    textDecoration: 'none',
    fontSize: 14.5,
    fontWeight: 500,
    background: 'transparent',
    fontFamily: 'inherit',
    cursor: 'pointer',
  },
  primary: { background: 'var(--paper)', color: 'var(--ink)', borderColor: 'var(--paper)', fontWeight: 600 },
};
