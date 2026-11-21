import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { hostedWebContainersEnabled, isHostedEditor } from '@softn/editor-shared/hostedEditor';
import { useModalFocus } from '@softn/editor-shared/useModalFocus';
import { COMPONENT_STARTERS, WEB_STARTERS, createWebStarter, type StarterFile } from '@softn/editor-shared/webStarters';
import type { LogicLanguage } from '../../utils/logicFiles';

export type StarterTemplate = 'blank' | 'landing' | 'dashboard';
export type NewProjectFormat = 'ui' | 'web';
export type NewProjectLanguage = LogicLanguage | 'typescript';
export type NewProjectBackend = 'none' | 'formlogic' | 'php' | 'javascript' | 'typescript';

export interface NewProjectConfig {
  name: string;
  description: string;
  theme: 'light' | 'dark' | 'system';
  template: StarterTemplate;
  format?: NewProjectFormat;
  /** Optional backend & database choice (FormLogic tables/API or sandboxed PHP/JS/TS + SQLite) for either Web or Classic `.ui`. */
  backend?: NewProjectBackend;
  language: NewProjectLanguage;
  pythonPackages: string[];
}

interface NewProjectDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (config: NewProjectConfig, starterFiles?: StarterFile[]) => void;
}

export const TEMPLATES: { key: StarterTemplate; title: string; description: string }[] = [
  { key: 'blank', title: 'Blank', description: 'An empty page to build from scratch.' },
  { key: 'landing', title: 'Landing page', description: 'A heading, a short introduction and a call to action.' },
  { key: 'dashboard', title: 'Dashboard', description: 'Stat tiles, cards and a list with editable sample data.' },
];

const PROJECT_TYPES = [
  { id: 'starter', label: 'Web starter' },
  { id: 'web', label: 'Web layout' },
  { id: 'ui', label: 'Classic SoftN' },
] as const;
type ProjectType = (typeof PROJECT_TYPES)[number]['id'];

const LANGUAGES = [
  { id: 'javascript', label: 'JavaScript', file: 'app.js', classicFile: 'logic/main.logic' },
  { id: 'typescript', label: 'TypeScript', file: 'app.ts', classicFile: null },
  { id: 'python', label: 'Python', file: 'main.py', classicFile: 'logic/main.py' },
] as const;

function StarterIllustration({ framework }: { framework: (typeof WEB_STARTERS)[number]['id'] }) {
  return (
    <svg viewBox="0 0 110 52" aria-hidden="true" className="bl-starter-illustration" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round">
      {framework === 'vanilla' && <>
        <circle cx="69" cy="12" r="4" fill="currentColor" stroke="none" />
        <path d="m14 37 22-25 14 15L62 16l33 21H14Z" fill="currentColor" opacity=".13" />
        <path d="m14 37 22-25 14 15 12-11 33 21M27 23l6 1 3-4 5 2" />
        <path d="M20 41h20c18 0 25-3 17-5s-3-4 8-6" strokeDasharray="4 4" />
      </>}
      {framework === 'react' && <>
        <path d="M40 8h30a18 18 0 0 1 0 36H40a18 18 0 0 1 0-36Z" fill="currentColor" opacity=".13" />
        <rect x="22" y="8" width="66" height="36" rx="18" />
        <rect x="27" y="13" width="56" height="26" rx="13" />
        <rect x="32" y="18" width="46" height="16" rx="8" />
        <path d="M57 8v10m4-10v10" />
      </>}
      {framework === 'vue' && <>
        <path d="M55 16c-8-6-17-7-29-6v28c11-1 21 0 29 6 8-6 18-7 29-6V10c-12-1-21 0-29 6Z" fill="currentColor" opacity=".12" />
        <path d="M55 16c-8-6-17-7-29-6v28c11-1 21 0 29 6 8-6 18-7 29-6V10c-12-1-21 0-29 6Zm0 0v28M22 14v28c14-1 23-1 33 4 10-5 19-5 33-4V14" />
        <path d="M68 12v15l4-3 4 1V10" fill="currentColor" />
      </>}
    </svg>
  );
}

const PROJECT_BACKENDS: { key: NewProjectBackend; title: string; description: string; path: string }[] = [
  { key: 'none', title: 'Local collections', description: 'Offline local XDB collections (.xdb) — works in both Web Containers and .ui apps.', path: 'xdb/*.xdb' },
  { key: 'formlogic', title: 'FormLogic API', description: 'FormLogic private SQLite tables & API routes — works in both Web Containers and .ui apps.', path: 'server/main.logic' },
  { key: 'php', title: 'PHP + SQLite', description: 'Sandboxed PHP 8 API with persistent SQLite via ZIPP WASM or multi-user server.', path: 'backend/index.php' },
  { key: 'javascript', title: 'JS API + SQLite', description: 'Sandboxed JavaScript HTTP handler + persistent SQLite.', path: 'backend/server.js' },
  { key: 'typescript', title: 'TS API + SQLite', description: 'Sandboxed TypeScript HTTP handler + persistent SQLite.', path: 'backend/server.ts' },
];

function moveBetweenChoices(event: KeyboardEvent<HTMLDivElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const buttons = Array.from(event.currentTarget.querySelectorAll('button'));
  const index = buttons.indexOf(event.target as HTMLButtonElement);
  if (index < 0) return;
  let next: number;
  switch (event.key) {
    case 'ArrowRight': next = (index + 1) % buttons.length; break;
    case 'ArrowLeft': next = (index + buttons.length - 1) % buttons.length; break;
    case 'Home': next = 0; break;
    case 'End': next = buttons.length - 1; break;
    default: return;
  }
  event.preventDefault();
  buttons[next].focus();
  buttons[next].click();
}

export function NewProjectDialog({ isOpen, ...props }: NewProjectDialogProps) {
  return isOpen ? <NewProjectForm {...props} /> : null;
}

function NewProjectForm({ onClose, onCreate }: Omit<NewProjectDialogProps, 'isOpen'>) {
  const supportsWeb = !isHostedEditor() || hostedWebContainersEnabled();
  const fieldId = useId();
  const [projectType, setProjectType] = useState<ProjectType>(supportsWeb ? 'starter' : 'ui');
  const [framework, setFramework] = useState<(typeof WEB_STARTERS)[number]>(WEB_STARTERS[0]);
  const [useComponent, setUseComponent] = useState(false);
  const [template, setTemplate] = useState(TEMPLATES[0]);
  const [backend, setBackend] = useState<NewProjectBackend>('none');
  const [language, setLanguage] = useState<(typeof LANGUAGES)[number]>(LANGUAGES[0]);
  const [name, setName] = useState<string | null>(null);
  const [description, setDescription] = useState<string | null>(null);
  const [theme, setTheme] = useState<NewProjectConfig['theme']>('system');
  const [torch, setTorch] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const cancelButton = useRef<HTMLButtonElement>(null);
  const errorMessage = useRef<HTMLParagraphElement>(null);

  const request = useRef(0);
  const close = () => { request.current += 1; onClose(); };
  const dialogRef = useModalFocus(true, close, supportsWeb ? 'input[type="radio"]:checked' : 'button[aria-pressed="true"]');
  useEffect(() => () => { request.current += 1; }, []);
  useEffect(() => { if (error) errorMessage.current?.focus(); }, [error]);

  const classic = projectType === 'ui';
  const component = framework.id === 'vanilla' ? null : COMPONENT_STARTERS[framework.id];
  const starter = projectType === 'starter' ? (useComponent && component ? component : framework) : null;
  const selectedLanguage = starter ? LANGUAGES[0] : language;
  const scriptFile = starter?.sourceFile ?? (classic ? selectedLanguage.classicFile : selectedLanguage.file);
  const defaultName = starter?.name ?? 'Untitled App';
  const defaultDescription = starter?.description ?? '';

  function chooseType(next: ProjectType) {
    setProjectType(next);
    if (next === 'ui' && !language.classicFile) setLanguage(LANGUAGES[0]);
    setError('');
  }

  async function handleCreate() {
    if (creating) return;
    const generation = ++request.current;
    const config: NewProjectConfig = {
      name: name?.trim() || defaultName,
      description: description?.trim() ?? defaultDescription,
      theme,
      template: starter ? 'blank' : template.key,
      ...(classic ? {} : { format: 'web' as const }),
      ...(!starter && backend !== 'none' ? { backend } : {}),
      language: selectedLanguage.id,
      pythonPackages: selectedLanguage.id === 'python' && torch ? ['torch'] : [],
    };
    setError('');
    try {
      if (starter) {
        cancelButton.current?.focus();
        setCreating(true);
        const files = await createWebStarter(starter.id, config);
        if (generation === request.current) onCreate(config, files);
      } else {
        onCreate(config);
      }
    } catch (cause) {
      if (generation === request.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation === request.current) setCreating(false);
    }
  }

  return (
    <div className="bl-overlay bl-create-overlay" onClick={close}>
      <div ref={dialogRef} className="bl-dialog bl-create" role="dialog" aria-modal="true" aria-labelledby={fieldId + '-title'} tabIndex={-1} onClick={(event) => event.stopPropagation()}>
        <header className="bl-create-head">
          <h2 id={fieldId + '-title'} className="bl-dialog-title">Create a new app</h2>
          <button type="button" className="bl-close" onClick={close} aria-label="Close">×</button>
        </header>

        <form onSubmit={(event) => { event.preventDefault(); void handleCreate(); }}>
          <div className="bl-create-body" {...(creating ? { inert: '' } : {})}>
            {supportsWeb && (
              <fieldset>
                <legend className="bl-create-label">Project type</legend>
                <div className="bl-create-types">
                  {PROJECT_TYPES.map(({ id, label }) => (
                    <label key={id} className="bl-create-type" data-selected={projectType === id}>
                      <input className="bl-create-radio" type="radio" name={fieldId + '-type'} value={id}
                        checked={projectType === id} onChange={() => chooseType(id)} />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}

            {starter ? (
              <fieldset>
                <legend className="bl-create-label">Framework</legend>
                <div className="bl-starter-options" role="toolbar" aria-label="Choose framework" onKeyDown={moveBetweenChoices}>
                  {WEB_STARTERS.map((option) => (
                    <button key={option.id} type="button" className="bl-choice bl-framework-option"
                      aria-label={option.label} aria-pressed={framework.id === option.id} tabIndex={framework.id === option.id ? 0 : -1}
                      aria-describedby={fieldId + '-starter-' + option.id}
                      onClick={() => { if (option.id !== framework.id) setUseComponent(false); setFramework(option); setError(''); }}>
                      <span className="bl-framework-sample" data-framework={option.id} aria-hidden="true">
                        <StarterIllustration framework={option.id} />
                      </span>
                      <span className="bl-framework-caption">
                        <strong>{option.label}</strong>
                        <span id={fieldId + '-starter-' + option.id}>{option.name}</span>
                      </span>
                    </button>
                  ))}
                </div>
                {component && (
                  <fieldset className="bl-starter-format">
                    <legend className="bl-create-label">Source format</legend>
                    <div className="bl-language-options">
                      <label className="bl-choice bl-language-option" data-checked={!useComponent}>
                        <input type="radio" className="bl-create-radio" name={fieldId + '-source'} value="js"
                          checked={!useComponent} onChange={() => { setUseComponent(false); setError(''); }} />
                        <strong>JavaScript</strong>
                        <code>{framework.sourceFile}</code>
                      </label>
                      <label className="bl-choice bl-language-option" data-checked={useComponent}>
                        <input type="radio" className="bl-create-radio" name={fieldId + '-source'} value={component.id}
                          checked={useComponent} onChange={() => { setUseComponent(true); setError(''); }} />
                        <strong>{component.format}</strong>
                        <code>{component.sourceFile}</code>
                      </label>
                    </div>
                  </fieldset>
                )}
                <p className="bl-choice-detail" aria-live="polite">{starter.description}{!component && <> Edit <code>{scriptFile}</code> to change its behavior.</>}</p>
              </fieldset>
            ) : (
              <>
                <fieldset>
                  <legend className="bl-create-label">Page layout</legend>
                  <div className="bl-starter-options" role="toolbar" aria-label="Choose page layout" onKeyDown={moveBetweenChoices}>
                    {TEMPLATES.map((option) => (
                      <button key={option.key} type="button" className="bl-choice bl-starter-tile"
                        aria-pressed={template.key === option.key} tabIndex={template.key === option.key ? 0 : -1} onClick={() => setTemplate(option)}>
                        <span className="bl-starter-thumbnail" data-template={option.key} aria-hidden="true"><i /><i /><i /></span>
                        {option.title}
                      </button>
                    ))}
                  </div>
                  <p className="bl-choice-detail" aria-live="polite">{template.description}</p>
                </fieldset>
                <fieldset>
                  <legend className="bl-create-label">Logic language</legend>
                  <div className="bl-language-options">
                    {LANGUAGES.filter((item) => !classic || item.classicFile).map((item) => (
                      <label key={item.id} className="bl-choice bl-language-option" data-checked={language.id === item.id}>
                        <input className="bl-create-radio" type="radio" name={fieldId + '-language'} value={item.id}
                          checked={language.id === item.id} onChange={() => setLanguage(item)} />
                        {item.label}
                      </label>
                    ))}
                  </div>
                  <p className="bl-choice-detail" aria-live="polite">
                    {classic ? 'Design the page in ' : 'Edit the page in '}<code>{classic ? 'ui/main.ui' : 'index.html'}</code> and its logic in <code>{scriptFile}</code>.
                  </p>
                  {language.id === 'python' && (
                    <label className="bl-create-torch">
                      <input type="checkbox" checked={torch} onChange={(event) => setTorch(event.target.checked)} data-setting="python-torch" />
                      Include torch for machine learning
                    </label>
                  )}
                </fieldset>
                {supportsWeb && (
                <fieldset>
                  <legend className="bl-create-label">Backend &amp; database (optional)</legend>
                  <div className="bl-backend-options">
                    {PROJECT_BACKENDS.map((option) => (
                      <label key={option.key} className="bl-choice bl-backend-option" data-checked={backend === option.key}>
                        <input
                          className="bl-create-radio"
                          type="radio"
                          name={fieldId + '-backend'}
                          value={option.key}
                          checked={backend === option.key}
                          onChange={() => setBackend(option.key)}
                        />
                        <strong>{option.title}</strong>
                        <code>{option.path}</code>
                      </label>
                    ))}
                  </div>
                  <p className="bl-choice-detail" aria-live="polite">
                    {PROJECT_BACKENDS.find((b) => b.key === backend)?.description}
                  </p>
                </fieldset>
                )}
              </>
            )}

            <div>
              <label className="bl-create-label" htmlFor={fieldId + '-name'}>Name</label>
              <input id={fieldId + '-name'} className="bl-create-field" value={name ?? defaultName}
                onChange={(event) => setName(event.target.value)} placeholder={defaultName} onFocus={(event) => event.target.select()} />
            </div>
            <details className="bl-project-details">
              <summary>Description and theme</summary>
              <div>
                <div>
                  <label className="bl-create-label" htmlFor={fieldId + '-description'}>Description <span>(optional)</span></label>
                  <textarea id={fieldId + '-description'} className="bl-create-field" value={description ?? defaultDescription}
                    onChange={(event) => setDescription(event.target.value)} placeholder="What the app is for" />
                </div>
                <div>
                  <label className="bl-create-label" htmlFor={fieldId + '-theme'}>App theme</label>
                  <select id={fieldId + '-theme'} className="bl-create-field" value={theme}
                    onChange={(event) => setTheme(event.target.value as NewProjectConfig['theme'])}>
                    <option value="system">Match the device</option>
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                  </select>
                </div>
              </div>
            </details>
            {error && <p ref={errorMessage} tabIndex={-1} role="alert" className="bl-create-error">{error}</p>}
          </div>

          <footer className="bl-create-footer">
            <span role="status">{creating ? <>Loading <strong>{framework.label}</strong> starter…</> : <>Opens in <strong>{starter ? 'Preview' : classic ? 'Design' : 'Code'}</strong></>}</span>
            <button ref={cancelButton} type="button" className="bl-btn" onClick={close}>Cancel</button>
            <button type="submit" className="bl-btn bl-btn-primary" disabled={creating}>{creating ? 'Creating…' : 'Create app'}</button>
          </footer>
        </form>
      </div>
    </div>
  );
}
