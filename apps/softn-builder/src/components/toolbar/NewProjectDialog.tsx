import React, { useEffect, useId, useState } from 'react';
import { useModalFocus } from '@softn/editor-shared/useModalFocus';
import type { LogicLanguage } from '../../utils/logicFiles';

export type StarterTemplate = 'blank' | 'landing' | 'dashboard';

export interface NewProjectConfig {
  name: string;
  description: string;
  theme: 'light' | 'dark' | 'system';
  template: StarterTemplate;
  /**
   * The language of the app's logic. An app has one: the runtime refuses a
   * bundle whose logic mixes the two, so it is chosen when the app is made.
   */
  language: LogicLanguage;
  /**
   * The Python packages the app asks for (`config.python.packages`): torch
   * or nothing. Only a Python app has any.
   */
  pythonPackages: string[];
}

interface NewProjectDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (config: NewProjectConfig) => void;
}


// Buttons, the overlay, the dialog frame and the choice cards are classes in
// styles/builder.css; what is left here is this form's own layout.
const styles: Record<string, React.CSSProperties> = {
  dialog: {
    width: 620,
  },
  header: {
    padding: '14px 12px 14px 20px',
    borderBottom: '1px solid var(--line-soft)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  body: {
    padding: 20,
    overflowY: 'auto',
    minHeight: 0,
    display: 'grid',
    gap: 18,
  },
  label: {
    display: 'block',
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--paper)',
    marginBottom: 6,
  },
  fieldset: {
    border: 'none',
    padding: 0,
    margin: 0,
    minWidth: 0,
  },
  input: {
    width: '100%',
    padding: '9px 12px',
    borderRadius: 8,
    fontSize: 14,
  },
  textarea: {
    width: '100%',
    minHeight: 64,
    padding: '9px 12px',
    borderRadius: 8,
    fontSize: 14,
    lineHeight: 1.5,
    resize: 'vertical',
    maxHeight: 180,
  },
  select: {
    width: '100%',
    padding: '9px 10px',
    borderRadius: 8,
    fontSize: 14,
  },
  cards: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
    gap: 10,
  },
  cardTitle: {
    display: 'block',
    fontSize: 13.5,
    fontWeight: 600,
    color: 'var(--paper)',
    marginBottom: 4,
  },
  cardDesc: {
    display: 'block',
    fontSize: 12,
    color: 'var(--dim)',
    lineHeight: 1.45,
  },
  cardPath: {
    display: 'block',
    fontFamily: 'var(--mono)',
    fontSize: 11.5,
    color: 'var(--coral)',
    marginTop: 6,
  },
  // A native radio, kept for the keyboard and the screen reader, drawn by the card.
  radio: {
    position: 'absolute',
    opacity: 0,
    width: 1,
    height: 1,
    margin: 0,
  },
  option: {
    display: 'flex',
    gap: 10,
    alignItems: 'flex-start',
    marginTop: 10,
    padding: '10px 12px',
    borderRadius: 8,
    border: '1px solid var(--line-soft)',
    background: 'var(--ink)',
    fontSize: 13,
    color: 'var(--paper)',
    cursor: 'pointer',
  },
  hint: {
    display: 'block',
    marginTop: 2,
    fontSize: 12,
    lineHeight: 1.45,
    color: 'var(--dim)',
  },
  footer: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
    padding: '12px 20px',
    borderTop: '1px solid var(--line-soft)',
    background: 'var(--ink)',
  },
};

const TEMPLATES: { key: StarterTemplate; title: string; description: string }[] = [
  { key: 'blank', title: 'Blank', description: 'An empty page. Start from zero.' },
  { key: 'landing', title: 'Landing page', description: 'A centred heading, an intro and a call-to-action button.' },
  { key: 'dashboard', title: 'Dashboard', description: 'A heading, stat tiles, cards and a list, ready for data.' },
];

const LANGUAGES: { key: LogicLanguage; title: string; description: string; path: string }[] = [
  { key: 'javascript', title: 'JavaScript', description: 'Runs in a sandboxed VM. The default.', path: 'logic/main.logic' },
  { key: 'python', title: 'Python', description: 'Runs on the ZIPP engine, with optional machine learning.', path: 'logic/main.py' },
];

export function NewProjectDialog({ isOpen, onClose, onCreate }: NewProjectDialogProps) {
  const dialogRef = useModalFocus(isOpen, onClose, 'input');
  const fieldId = useId();
  const [name, setName] = useState('Untitled App');
  const [description, setDescription] = useState('');
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('system');
  const [template, setTemplate] = useState<StarterTemplate>('blank');
  const [language, setLanguage] = useState<LogicLanguage>('javascript');
  const [torch, setTorch] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setName('Untitled App');
    setDescription('');
    setTheme('system');
    setTemplate('blank');
    setLanguage('javascript');
    setTorch(false);
  }, [isOpen]);

  if (!isOpen) return null;

  const handleCreate = () => {
    onCreate({
      name: name.trim() || 'Untitled App',
      description: description.trim(),
      theme,
      template,
      language,
      pythonPackages: language === 'python' && torch ? ['torch'] : [],
    });
  };

  return (
    <div className="bl-overlay" style={{ zIndex: 1200 }} onClick={onClose}>
      <div ref={dialogRef} className="bl-dialog" style={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={`${fieldId}-title`} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <h2 id={`${fieldId}-title`} className="bl-dialog-title">Create a new app</h2>
          <button type="button" className="bl-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <form style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }} onSubmit={(event) => { event.preventDefault(); handleCreate(); }}>
        <div style={styles.body}>
          <div>
            <label style={styles.label} htmlFor={`${fieldId}-name`}>Name</label>
            <input
              id={`${fieldId}-name`}
              style={styles.input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Untitled App"
            />
          </div>

          <div>
            <label style={styles.label} htmlFor={`${fieldId}-description`}>Description <span style={{ fontWeight: 400, color: 'var(--dim)' }}>(optional)</span></label>
            <textarea
              id={`${fieldId}-description`}
              style={styles.textarea}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What the app is for, in a sentence"
            />
          </div>

          {/* One language per app: the runtime refuses a bundle whose logic
              mixes the two, so this is the moment to choose. */}
          <fieldset style={styles.fieldset}>
            <legend style={styles.label}>Logic language</legend>
            <div style={styles.cards}>
              {LANGUAGES.map((option) => (
                <label
                  key={option.key}
                  className="bl-choice"
                  data-checked={language === option.key}
                  style={{ position: 'relative', display: 'block' }}
                >
                  <input
                    type="radio"
                    name={`${fieldId}-language`}
                    value={option.key}
                    checked={language === option.key}
                    onChange={() => setLanguage(option.key)}
                    style={styles.radio}
                  />
                  <span style={styles.cardTitle}>{option.title}</span>
                  <span style={styles.cardDesc}>{option.description}</span>
                  <span style={styles.cardPath}>{option.path}</span>
                </label>
              ))}
            </div>
            {language === 'python' && (
              <label style={styles.option}>
                <input
                  type="checkbox"
                  checked={torch}
                  onChange={(e) => setTorch(e.target.checked)}
                  style={{ marginTop: 3 }}
                  data-setting="python-torch"
                />
                <span>
                  Machine learning (torch)
                  <span style={styles.hint}>
                    Lets the app import torch: tensors, autograd, torch.nn and optimizers. You can change this later in Export.
                  </span>
                </span>
              </label>
            )}
          </fieldset>

          <div>
            <span id={`${fieldId}-templates`} style={styles.label}>Start from</span>
            <div style={styles.cards} role="group" aria-labelledby={`${fieldId}-templates`}>
              {TEMPLATES.map(({ key, title, description: text }) => (
                <button
                  key={key}
                  type="button"
                  className="bl-choice"
                  aria-pressed={template === key}
                  onClick={() => setTemplate(key)}
                >
                  <span style={styles.cardTitle}>{title}</span>
                  <span style={styles.cardDesc}>{text}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label style={styles.label} htmlFor={`${fieldId}-theme`}>App theme</label>
            <select
              id={`${fieldId}-theme`}
              style={{ ...styles.select, maxWidth: 280 }}
              value={theme}
              onChange={(e) => setTheme(e.target.value as 'light' | 'dark' | 'system')}
            >
              <option value="system">Match the device</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </div>
        </div>

        <div style={styles.footer}>
          <button type="button" className="bl-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="bl-btn bl-btn-primary">
            Create app
          </button>
        </div>
        </form>
      </div>
    </div>
  );
}
