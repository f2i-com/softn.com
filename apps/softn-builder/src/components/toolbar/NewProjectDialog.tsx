import React, { useEffect, useState } from 'react';

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
    background: '#ffffff',
    boxShadow: '0 24px 52px rgba(15, 23, 42, 0.28)',
    border: '1px solid #e2e8f0',
    overflow: 'hidden',
  },
  header: {
    padding: '16px 20px',
    borderBottom: '1px solid #e2e8f0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontSize: 18,
    fontWeight: 700,
    color: '#0f172a',
  },
  closeButton: {
    border: 'none',
    background: 'transparent',
    fontSize: 24,
    lineHeight: 1,
    color: '#64748b',
    cursor: 'pointer',
  },
  body: {
    padding: 20,
    display: 'grid',
    gap: 14,
  },
  label: {
    display: 'block',
    fontSize: 12,
    fontWeight: 600,
    color: '#334155',
    marginBottom: 6,
    letterSpacing: '0.03em',
    textTransform: 'uppercase',
  },
  input: {
    width: '100%',
    padding: '10px 12px',
    borderRadius: 8,
    border: '1px solid #cbd5e1',
    fontSize: 14,
  },
  textarea: {
    width: '100%',
    minHeight: 72,
    padding: '10px 12px',
    borderRadius: 8,
    border: '1px solid #cbd5e1',
    fontSize: 14,
    resize: 'vertical',
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
    border: '1px solid #cbd5e1',
    fontSize: 14,
    background: '#fff',
  },
  templates: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: 10,
  },
  templateCard: {
    border: '1px solid #cbd5e1',
    borderRadius: 10,
    padding: 12,
    cursor: 'pointer',
    background: '#f8fafc',
  },
  templateCardActive: {
    border: '1px solid #2563eb',
    background: '#eff6ff',
    boxShadow: 'inset 0 0 0 1px #2563eb',
  },
  templateTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: '#0f172a',
    marginBottom: 4,
  },
  templateDesc: {
    fontSize: 12,
    color: '#475569',
    lineHeight: 1.4,
  },
  footer: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 10,
    padding: '14px 20px',
    borderTop: '1px solid #e2e8f0',
    background: '#f8fafc',
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
    background: '#fff',
    color: '#334155',
    borderColor: '#cbd5e1',
  },
  create: {
    background: '#2563eb',
    color: '#fff',
    borderColor: '#2563eb',
  },
};

const templateDescriptions: Record<StarterTemplate, string> = {
  blank: 'App root only. Start from zero.',
  landing: 'Hero heading + intro copy + CTA button.',
  dashboard: 'Heading + KPI cards + starter list table.',
};

export function NewProjectDialog({ isOpen, onClose, onCreate }: NewProjectDialogProps) {
  const [name, setName] = useState('Untitled App');
  const [description, setDescription] = useState('');
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('light');
  const [template, setTemplate] = useState<StarterTemplate>('blank');

  useEffect(() => {
    if (!isOpen) return;
    setName('Untitled App');
    setDescription('');
    setTheme('light');
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
      <div style={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.title}>Create New App</span>
          <button style={styles.closeButton} onClick={onClose} aria-label="Close new app dialog">
            ×
          </button>
        </div>

        <div style={styles.body}>
          <div>
            <label style={styles.label}>App Name</label>
            <input
              style={styles.input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Untitled App"
            />
          </div>

          <div>
            <label style={styles.label}>Description</label>
            <textarea
              style={styles.textarea}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Short description of what you're building"
            />
          </div>

          <div style={styles.row}>
            <div>
              <label style={styles.label}>Theme</label>
              <select
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
            <label style={styles.label}>Starter Template</label>
            <div style={styles.templates}>
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
          <button style={{ ...styles.button, ...styles.cancel }} onClick={onClose}>
            Cancel
          </button>
          <button style={{ ...styles.button, ...styles.create }} onClick={handleCreate}>
            Create App
          </button>
        </div>
      </div>
    </div>
  );
}
