import React from 'react';

/**
 * What the builder shows on a screen it cannot work on.
 *
 * The builder is four resizable panels around a drag-and-drop canvas and a
 * Monaco editor. Below roughly a laptop width those panels stop fitting, and
 * there is no honest phone layout for them: dragging a component onto a canvas
 * and resizing a split pane are mouse gestures, and shrinking the chrome until
 * it technically renders would produce something that looks usable and is not.
 *
 * So it says so, and points at the two things that do work on a phone — Studio
 * authors the same bundles, and the runtime opens them. A real touch builder is
 * a product decision, not a stylesheet.
 */
export function NarrowScreenNotice({ studioUrl, runtimeUrl }: { studioUrl: string; runtimeUrl: string }): React.ReactElement {
  return (
    <div style={s.wrap}>
      <div style={s.card}>
        <svg width="30" height="30" viewBox="0 0 26 26" style={{ color: '#8b94a2' }} aria-hidden="true">
          <rect x="3.5" y="4.5" width="19" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M3.5 9.5h19M9 9.5v9" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
        <h1 style={s.title}>The builder needs a wider screen</h1>
        <p style={s.copy}>
          Its canvas, panels and code editor are built around a mouse and about 900 pixels of width.
          Rather than shrink them into something that looks usable and is not, it waits for a laptop.
        </p>
        <p style={s.copy}>Both of these build the same <code style={s.code}>.softn</code> bundles and work here:</p>
        <div style={s.actions}>
          <a href={studioUrl} style={{ ...s.action, ...s.primary }}>Open Studio</a>
          <a href={runtimeUrl} style={s.action}>Open the runtime</a>
        </div>
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  wrap: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '1.5rem',
    background: '#101317',
    color: '#f2f0ec',
    fontFamily: "'IBM Plex Sans', system-ui, -apple-system, sans-serif",
  },
  card: { maxWidth: 380, display: 'flex', flexDirection: 'column', gap: '0.75rem' },
  title: { margin: '0.5rem 0 0', fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.15 },
  copy: { margin: 0, fontSize: 14.5, lineHeight: 1.6, color: '#8b94a2' },
  code: { fontFamily: "'IBM Plex Mono', ui-monospace, monospace", fontSize: '0.9em', color: '#ff8a4c' },
  actions: { display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.5rem' },
  action: {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: 44,
    padding: '0 1rem',
    borderRadius: 8,
    border: '1px solid #262c36',
    color: '#f2f0ec',
    textDecoration: 'none',
    fontSize: 14.5,
    fontWeight: 500,
  },
  primary: { background: '#f2f0ec', color: '#101317', borderColor: '#f2f0ec' },
};
