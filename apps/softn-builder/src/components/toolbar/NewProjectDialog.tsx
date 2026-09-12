import React, { useEffect, useId, useState } from 'react';
import { useModalFocus } from '../../hooks/useModalFocus';

export type StarterTemplate = 'blank' | 'landing' | 'dashboard';

export interface NewProjectConfig {
  name: string;
  description: string;
  theme: 'light' | 'dark' | 'system';
  template: StarterTemplate;
}

interface NewProjectDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (config: NewProjectConfig) => void;
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(15, 23, 42, 0.6)',
    backdropFilter: 'blur(4px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1200,
  },
  dialog: {
    width: 620,
    maxWidth: '92vw',
    borderRadius: 14,
    background: 'var(--ink-2)',
    boxShadow: '0 24px 52px rgba(15, 23, 42, 0.28)',
    border: '1px solid var(--line-soft)',
    overflow: 'hidden',
    maxHeight: '90dvh',
    display: 'flex',
    flexDirection: 'column',
  },
  header: {
    padding: '16px 20px',
    borderBottom: '1px solid var(--line-soft)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontSize: 18,
    fontWeight: 700,
    color: 'var(--paper)',
  },
  closeButton: {
    border: 'none',
    background: 'transparent',
    fontSize: 24,
    lineHeight: 1,
    color: 'var(--dim)',
    cursor: 'pointer',
    minWidth: 40, minHeight: 40,
  },
  body: {
    padding: 20,
    overflowY: 'auto',
    minHeight: 0,
    display: 'grid',
    gap: 14,
  },
  label: {
    display: 'block',
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--paper)',
    marginBottom: 6,
    letterSpacing: '0.03em',
    textTransform: 'uppercase',
  },
  input: {
    width: '100%',
    padding: '10px 12px',
    borderRadius: 8,
    border: '1px solid var(--line)',
    fontSize: 14,
  },
  textarea: {
    width: '100%',
    minHeight: 72,
    padding: '10px 12px',
    borderRadius: 8,
    border: '1px solid var(--line)',
    fontSize: 14,
    resize: 'vertical',
    maxHeight: 180,
  },
  row: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 12,
  },
  select: {
    width: '100%',
    padding: '10px 12px',
    borderRadius: 8,
    border: '1px solid var(--line)',
    fontSize: 14,
    background: 'var(--ink-2)',
  },
  templates: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
    gap: 10,
  },
  templateCard: {
    border: '1px solid var(--line)',
    borderRadius: 10,
    padding: 12,
    cursor: 'pointer',
    background: 'var(--ink)',
  },
  templateCardActive: {
    border: '1px solid var(--coral)',
    background: 'var(--mint-glow-soft)',
    boxShadow: 'inset 0 0 0 1px var(--coral)',
  },
  templateTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: 'var(--paper)',
    marginBottom: 4,
  },
  templateDesc: {
    fontSize: 12,
    color: 'var(--dim)',
    lineHeight: 1.4,
  },
  footer: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 10,
    padding: '14px 20px',
    borderTop: '1px solid var(--line-soft)',
    background: 'var(--ink)',
  },
  button: {
    borderRadius: 8,
    padding: '9px 14px',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    border: '1px solid transparent',
  },
  cancel: {
    background: 'var(--ink-2)',
    color: 'var(--paper)',
    borderColor: 'var(--line)',
  },
  create: {
    background: 'var(--coral)',
    color: '#fff',
    borderColor: 'var(--coral)',
  },
};

const templateDescriptions: Record<StarterTemplate, string> = {
  blank: 'App root only. Start from zero.',
  landing: 'Hero heading + intro copy + CTA button.',
  dashboard: 'Heading + KPI cards + starter list table.',
};

export function NewProjectDialog({ isOpen, onClose, onCreate }: NewProjectDialogProps) {
  const dialogRef = useModalFocus(isOpen, onClose, 'input');
  const fieldId = useId();
  const [name, setName] = useState('Untitled App');
  const [description, setDescription] = useState('');
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('system');
  const [template, setTemplate] = useState<StarterTemplate>('blank');

  useEffect(() => {
    if (!isOpen) return;
    setName('Untitled App');
    setDescription('');
    setTheme('system');
    setTemplate('blank');
  }, [isOpen]);

  if (!isOpen) return null;

  const handleCreate = () => {
    onCreate({
      name: name.trim() || 'Untitled App',
      description: description.trim(),
      theme,
      template,
    });
  };

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div ref={dialogRef} style={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={`${fieldId}-title`} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <span id={`${fieldId}-title`} style={styles.title}>Create New App</span>
          <button style={styles.closeButton} onClick={onClose} aria-label="Close new app dialog">
            ×
          </button>
        </div>

        <form style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }} onSubmit={(event) => { event.preventDefault(); handleCreate(); }}>
        <div style={styles.body}>
          <div>
            <label style={styles.label} htmlFor={`${fieldId}-name`}>App Name</label>
            <input
              id={`${fieldId}-name`}
              style={styles.input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Untitled App"
            />
          </div>

          <div>
            <label style={styles.label} htmlFor={`${fieldId}-description`}>Description</label>
            <textarea
              id={`${fieldId}-description`}
              style={styles.textarea}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Short description of what you're building"
            />
          </div>

          <div style={styles.row}>
            <div>
              <label style={styles.label} htmlFor={`${fieldId}-theme`}>Theme</label>
              <select
                id={`${fieldId}-theme`}
                style={styles.select}
                value={theme}
                onChange={(e) => setTheme(e.target.value as 'light' | 'dark' | 'system')}
              >
                <option value="light">Light</option>
                <option value="dark">Dark</option>
                <option value="system">System</option>
              </select>
            </div>
          </div>

          <div>
            <span id={`${fieldId}-templates`} style={styles.label}>Starter Template</span>
            <div style={styles.templates} role="group" aria-labelledby={`${fieldId}-templates`}>
              {(['blank', 'landing', 'dashboard'] as StarterTemplate[]).map((key) => {
                const active = template === key;
                return (
                  <button
                    key={key}
                    type="button"
                    style={{
                      ...styles.templateCard,
                      ...(active ? styles.templateCardActive : {}),
                      textAlign: 'left',
                    }}
                    aria-pressed={active}
                    onClick={() => setTemplate(key)}
                  >
                    <div style={styles.templateTitle}>
                      {key.charAt(0).toUpperCase() + key.slice(1)}
                    </div>
                    <div style={styles.templateDesc}>{templateDescriptions[key]}</div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div style={styles.footer}>
          <button type="button" style={{ ...styles.button, ...styles.cancel }} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" style={{ ...styles.button, ...styles.create }}>
            Create App
          </button>
        </div>
        </form>
      </div>
    </div>
  );
}
