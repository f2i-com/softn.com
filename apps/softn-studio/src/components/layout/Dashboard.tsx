import React, { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import { Icon } from '../common/Icon';
import { RenameField } from '../common/ProjectName';
import { EXAMPLES, type ExampleProject } from '../../examples';
import { ProviderSetup } from '../ai/ProviderSetup';
import { AIStatusPill, useAIReadiness } from '../ai/AIStatusPill';
import { COMPONENT_STARTERS, WEB_STARTERS, type WebStarter, type WebStarterId } from '@softn/editor-shared/webStarters';

/** A recent-list entry with what the dashboard knows about its copy. */
export interface RecentEntry {
  id: string;
  name: string;
  target: string;
  lastModified: string;
  /** A record for this id exists in project storage. */
  saved: boolean;
  /** This is the project currently in memory, saved or not. */
  active: boolean;
  /**
   * Why there is no copy to open, when it is not simply that there is none: the store did
   * not answer in time (`silent`), or the record was written by a newer Studio (`newer`).
   */
  why?: 'silent' | 'newer';
}

export type DashboardOutcome = { ok: true } | { ok: false; message: string };

interface DashboardProps {
  onNewProject: (templateId?: string) => void;
  onImportProject?: (file: File) => Promise<DashboardOutcome>;
  /** Open a recent project by id. The in-memory project opens without a read. */
  onOpenRecent?: (id: string) => Promise<DashboardOutcome>;
  /** Take an entry off the list. Nothing else is touched. */
  onRemoveRecent?: (id: string) => void;
  /** Delete a project's saved copy. Explicit, scoped to that id, and offered an export first. */
  onDeleteProject?: (id: string) => Promise<DashboardOutcome>;
  /** Download a saved project as a .softn without opening it. */
  onExportProject?: (id: string) => Promise<DashboardOutcome>;
  /** Give a project a new name: one saved here, open or not. */
  onRenameProject?: (id: string, name: string) => Promise<DashboardOutcome>;
  /** Open one of the bundled examples as a new project. */
  onOpenExample?: (example: ExampleProject) => void;
  onCreateStarter?: (starter: WebStarter) => Promise<void>;
  recentProjects?: RecentEntry[];
  /** This browser's storage did not answer in time: said above the list, with a way to ask again. */
  storeSilent?: boolean;
  onRetryStore?: () => void | Promise<void>;
  /** The examples offered; the bundled ones unless a test says otherwise. */
  examples?: readonly ExampleProject[];
  /**
   * The AI's part of the page. With `gate`, no provider is connected and
   * the person has not chosen to go without: connecting one is the first
   * thing on the page. Web starters work here too, and `onSkip` opens the
   * examples and other project actions. Without `gate`, a line under the hero says which
   * provider the AI uses. Absent in a hosted editor, which has its own AI.
   */
  ai?: { gate: boolean; onSkip(): void };
}

const TARGET_LABEL: Record<string, string> = { web: 'Web app', desktop: 'Desktop app', dual: 'Web and desktop' };

function exampleLanguage(example: ExampleProject): 'Python' | 'TypeScript' | 'JavaScript' {
  if (example.files.some((file) => /\.py$/i.test(file.path) && !/^assets\//i.test(file.path))) return 'Python';
  if (example.files.some((file) => /\.(?:tsx?|mts)$/i.test(file.path) && !/^assets\//i.test(file.path))) return 'TypeScript';
  return 'JavaScript';
}

function isContainerExample(example: ExampleProject): boolean {
  const manifest = example.files.find((file) => file.path === 'manifest.json');
  return Boolean(manifest && /"engine"\s*:\s*2/.test(manifest.content));
}

function exampleExcerpt(example: ExampleProject): { path: string; lines: string[] } | null {
  const logic = example.files.find((file) => /^(logic\/)?(main|app)\.(logic|js|ts|py)$/.test(file.path));
  if (!logic) return null;
  const all = logic.content.split('\n');
  const isComment = (line: string) => /^\s*(#|\/\/)/.test(line);
  let start = all.findIndex((line) => /^(function|def) go\b/.test(line));
  if (start < 0) start = all.findIndex((line) => line.trim() && !isComment(line));
  const lines: string[] = [];
  for (let i = start; i < all.length && lines.length < 4; i++) {
    const line = all[i];
    if (!line.trim()) {
      if (lines.length > 0) break;
      continue;
    }
    if (!isComment(line)) lines.push(line);
  }
  return { path: logic.path, lines };
}

const KEYWORDS = /\b(function|def|global|return|let|const|from|import|if)\b/g;

/** Keywords in the language colour; everything else stays ink. */
function highlight(line: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const match of line.matchAll(KEYWORDS)) {
    const at = match.index ?? 0;
    if (at > last) out.push(line.slice(last, at));
    out.push(<span key={at} className="kw">{match[0]}</span>);
    last = at + match[0].length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

/**
 * How each row of the recent list is named to assistive technology: by its project's name,
 * and, where two rows share a name (a bundle exported and imported again is a second project
 * of the same name), by when it was saved as well, and then by its place among them. Two rows
 * both called "Open Tea Log" could not be told apart without looking.
 */
function distinctRowNames(entries: readonly RecentEntry[]): Map<string, string> {
  const key = (name: string) => name.trim().toLowerCase();
  const byName = new Map<string, RecentEntry[]>();
  for (const entry of entries) byName.set(key(entry.name), [...(byName.get(key(entry.name)) ?? []), entry]);
  const names = new Map<string, string>();
  for (const entry of entries) {
    const same = byName.get(key(entry.name)) ?? [];
    if (same.length < 2) continue;
    const sameTime = same.filter((other) => other.lastModified === entry.lastModified);
    const when = entry.lastModified === 'in memory' ? 'in memory' : `saved ${entry.lastModified}`;
    names.set(entry.id, sameTime.length < 2 ? `${entry.name} (${when})` : `${entry.name} (${when}, ${sameTime.indexOf(entry) + 1} of ${sameTime.length})`);
  }
  return names;
}

/** The first letter of a project's name, for its tile in the list. */
function initial(name: string): string {
  const letter = name.trim().match(/\p{L}|\p{N}/u);
  return letter ? letter[0].toUpperCase() : '·';
}

/**
 * Studio's front door: one line for what it is for and the two ways to start,
 * then everything that already exists — the person's recent projects, first and
 * at the left, and the bundled examples beside them.
 *
 * Recent projects are a list of real buttons.
 *
 * Each row was a `div` with an `onClick`: no role, no tab stop, nothing
 * for Enter or Space to activate, and its remove control was invisible
 * until hovered, which a keyboard never does. The row that opens is a
 * `button` — the browser gives it activation on Enter and Space — and
 * "remove from list", "export a copy" and "delete" are separate labelled
 * buttons beside it, always visible enough to find. Removal and deletion
 * mean different things and say so: removing takes the entry off this
 * list; deleting takes the saved copy out of this browser, asks first, and
 * offers an export before it does. An entry with no saved copy says "No
 * saved copy" rather than pretending: the old list kept names of projects
 * whose only copy was overwritten long ago.
 *
 * The examples used to be offered only while the recent list was empty, and
 * only the JavaScript one. Both are always here now: a project needs no key
 * or bundle to start from one, and the pair is the quickest way to see what
 * choosing Python changes.
 *
 * Failures of the async actions land in a live region so they are read
 * out, not just painted.
 */
export const Dashboard: React.FC<DashboardProps> = ({
  onNewProject,
  onImportProject,
  onOpenRecent,
  onRemoveRecent,
  onDeleteProject,
  onExportProject,
  onRenameProject,
  onOpenExample,
  onCreateStarter,
  recentProjects = [],
  storeSilent = false,
  onRetryStore,
  examples = EXAMPLES,
  ai,
}) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** The store is being asked again: it may take as long to answer as it did not answer before. */
  const [askingStore, setAskingStore] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importRequest = useRef(0);
  const [importing, setImporting] = useState(false);
  const [creatingStarter, setCreatingStarter] = useState<WebStarterId | null>(null);
  const [starterError, setStarterError] = useState('');

  useEffect(() => () => { importRequest.current++; }, []);

  const handleFile = useCallback(async (file: File) => {
    if (!/\.(softn|zip|json)$/i.test(file.name)) {
      setNotice({ kind: 'error', text: 'Choose a .softn bundle, .zip archive or .json project file.' });
      return;
    }
    if (!onImportProject) return;
    const request = ++importRequest.current;
    setImporting(true);
    setNotice({ kind: 'info', text: `Opening ${file.name}…` });
    try {
      const outcome = await onImportProject(file);
      if (request !== importRequest.current) return;
      setNotice(outcome.ok ? null : { kind: 'error', text: `Could not import ${file.name}: ${outcome.message}` });
    } catch (err) {
      if (request !== importRequest.current) return;
      setNotice({ kind: 'error', text: `Could not import ${file.name}: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      if (request === importRequest.current) setImporting(false);
    }
  }, [onImportProject]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleOpen = useCallback(async (project: RecentEntry) => {
    if (!onOpenRecent || busyId) return;
    setNotice(null);
    setBusyId(project.id);
    try {
      const outcome = await onOpenRecent(project.id);
      if (!outcome.ok) setNotice({ kind: 'error', text: `Could not open ${project.name}: ${outcome.message}` });
    } catch (err) {
      setNotice({ kind: 'error', text: `Could not open ${project.name}: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setBusyId(null);
    }
  }, [onOpenRecent, busyId]);

  const handleExport = useCallback(async (project: RecentEntry) => {
    if (!onExportProject) return;
    setNotice(null);
    try {
      const outcome = await onExportProject(project.id);
      setNotice(outcome.ok ? { kind: 'info', text: `Exported ${project.name} as a .softn bundle.` } : { kind: 'error', text: `Could not export ${project.name}: ${outcome.message}` });
    } catch (err) {
      setNotice({ kind: 'error', text: `Could not export ${project.name}: ${err instanceof Error ? err.message : String(err)}` });
    }
  }, [onExportProject]);

  /**
   * Where the keyboard goes when the control it was on leaves the page: a rename that is kept or
   * cancelled, a delete that is confirmed. It fell to the page, and the next Tab started from the
   * top. Applied after the render that removes the control, and only when nothing else has taken
   * the focus meanwhile (a click elsewhere keeps it where it went).
   */
  const pendingFocus = useRef<{ row: string; control: 'open' | 'rename' | 'delete' } | 'start' | null>(null);

  const handleDelete = useCallback(async (project: RecentEntry) => {
    if (!onDeleteProject) return;
    setNotice(null);
    setBusyId(project.id);
    // The row the keyboard goes to once this one is gone: the next, else the one before, else
    // the way to start a new app.
    const at = recentProjects.findIndex((entry) => entry.id === project.id);
    const neighbour = recentProjects[at + 1] ?? recentProjects[at - 1];
    try {
      const outcome = await onDeleteProject(project.id);
      setNotice(outcome.ok ? { kind: 'info', text: `Deleted ${project.name} from this browser.` } : { kind: 'error', text: `Could not delete ${project.name}: ${outcome.message}` });
      pendingFocus.current = !outcome.ok ? { row: project.id, control: 'delete' } : neighbour ? { row: neighbour.id, control: 'open' } : 'start';
    } catch (err) {
      setNotice({ kind: 'error', text: `Could not delete ${project.name}: ${err instanceof Error ? err.message : String(err)}` });
      pendingFocus.current = { row: project.id, control: 'delete' };
    } finally {
      setBusyId(null);
      setConfirmingId(null);
    }
  }, [onDeleteProject, recentProjects]);

  const gated = !!ai?.gate;
  const homeRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  const firstExampleRef = useRef<HTMLButtonElement>(null);
  const exploring = useRef(false);
  const wasGated = useRef(gated);
  useEffect(() => {
    const lifted = wasGated.current && !gated;
    wasGated.current = gated;
    if (!lifted) return;
    const next = exploring.current && firstExampleRef.current ? firstExampleRef.current : startRef.current;
    exploring.current = false;
    homeRef.current?.scrollTo?.({ top: 0 });
    if (!document.activeElement || document.activeElement === document.body) next?.focus();
  }, [gated]);
  // pendingFocus, after the render that took the focused control away.
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const element = target === 'start'
      ? startRef.current
      : Array.from(homeRef.current?.querySelectorAll<HTMLElement>('[data-row]') ?? []).find((node) => node.dataset.row === target.row && node.dataset.control === target.control);
    element?.focus();
  });
  const aiReady = useAIReadiness().state === 'ready';
  const rowNames = useMemo(() => distinctRowNames(recentProjects), [recentProjects]);

  async function openStarter(starter: WebStarter) {
    if (!onCreateStarter) return;
    setStarterError('');
    setCreatingStarter(starter.id);
    try {
      await onCreateStarter(starter);
    } catch (error) {
      setStarterError(`Could not create ${starter.label} starter. ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setCreatingStarter(null);
    }
  }

  const importAction = onImportProject && (
    <button type="button" className="st-btn" onClick={() => fileInputRef.current?.click()}
      aria-busy={importing || undefined} data-drag={isDragOver || undefined}
      onDrop={handleDrop} onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
      onDragLeave={() => setIsDragOver(false)}
      title="Open a .softn bundle, a .zip archive or a .json project file. You can also drop the file here.">
      <Icon name="upload" size={16} />
      {importing ? 'Opening project…' : 'Import a bundle'}
    </button>
  );
  const importFeedback = (
    <div aria-live="polite" role={notice?.kind === 'error' ? 'alert' : 'status'}>
      {notice && <p className="st-notice" data-kind={notice.kind}>{notice.text}</p>}
    </div>
  );
  const fileInput = (
    <input ref={fileInputRef} type="file" accept=".softn,.zip,.json" hidden
      onChange={(e) => {
        const file = e.target.files?.[0];
        if (file) void handleFile(file);
        e.target.value = '';
      }}
    />
  );

  const starters = onCreateStarter && (
    <section className="st-web-starters" aria-label="Web starters">
      <h2 className="st-section-title">Web starters</h2>
      <p>Open a working app in Preview and edit its source.</p>
      <div className="st-web-starter-actions">
        {WEB_STARTERS.map((starter) => {
          const component = starter.id === 'vanilla' ? null : COMPONENT_STARTERS[starter.id];
          return (
            <div key={starter.id} className="st-starter-choice" data-framework={starter.id}>
              <button type="button" className="st-btn st-open-starter" aria-label={`Create ${starter.label} starter`}
                aria-describedby={`st-starter-name-${starter.id}`}
                disabled={creatingStarter !== null} aria-busy={creatingStarter === starter.id || undefined}
                onClick={() => void openStarter(starter)}>
                <span className="st-starter-mark" aria-hidden="true">
                  {starter.id === 'vanilla' ? 'JS' : starter.id === 'react' ? (
                    <svg viewBox="-12 -12 24 24" fill="none" stroke="currentColor" strokeWidth="1.2">
                      <ellipse rx="11" ry="4.3" /><ellipse rx="11" ry="4.3" transform="rotate(60)" />
                      <ellipse rx="11" ry="4.3" transform="rotate(120)" /><circle r="1.7" fill="currentColor" stroke="none" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M1 4h5l6 10.4L18 4h5L12 23z"/><path d="M6 4h4l2 3.5L14 4h4l-6 10.4z" opacity=".55"/></svg>
                  )}
                </span>
                <span className="st-starter-name">
                  <strong>{creatingStarter === starter.id ? 'Creating…' : starter.label}</strong>
                  <span id={`st-starter-name-${starter.id}`}>{starter.name}</span>
                </span>
                <Icon name="chevron-right" size={14} />
              </button>
              {component && (
                <button type="button" className="st-btn st-starter-component" aria-label={`Create ${component.label} starter`}
                  title={`Open ${starter.name} with editable ${component.sourceFile} source`}
                  disabled={creatingStarter !== null} aria-busy={creatingStarter === component.id || undefined}
                  onClick={() => void openStarter(component)}>
                  {creatingStarter === component.id ? 'Creating…' : `Use ${component.sourceFile}`}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {starterError && <p role="alert" className="st-notice" data-kind="error">{starterError}</p>}
    </section>
  );

  const onboarding = gated && (
    <section className="st-onboard" data-starters={onCreateStarter ? true : undefined} aria-labelledby="studio-onboard-title">
      <div className="st-onboard-intro">
        <h1 id="studio-onboard-title" className="st-onboard-title">{onCreateStarter ? 'Create your first app' : 'Connect an AI provider.'}</h1>
        <p className="st-onboard-lede">
          {onCreateStarter
            ? 'Pick a starter, open an existing project, or connect a model to build with AI.'
            : 'Choose the model Studio uses to build and edit your apps. You can change it later in Settings.'}
        </p>
      </div>
      {/* The way in without a key comes before the setup, in the page and in the tab order. It
          came after the card: beside it on a wide screen, but on a phone under the whole form,
          a screen and more down, so a newcomer with no key met a form and no way round it. */}
      <div className="st-onboard-skip">
        {starters}
        <div className="st-onboard-actions">
          {importAction}
          <button type="button" className="st-btn" onClick={() => { exploring.current = true; ai!.onSkip(); }}>
            <span>Explore examples<span className={onCreateStarter ? 'st-visually-hidden' : undefined}> without AI</span></span>
            <Icon name="chevron-right" size={16} />
          </button>
        </div>
        {importFeedback}
        {fileInput}
      </div>
      <div className="st-onboard-card">
        {onCreateStarter && <h2 className="st-section-title st-onboard-provider">Connect an AI provider</h2>}
        <ProviderSetup />
      </div>
    </section>
  );

  if (onboarding) {
    return (
      <div className="st-home" ref={homeRef}>
        <div className="st-home-inner">{onboarding}</div>
      </div>
    );
  }

  const sortedExamples = [...examples].sort((a, b) => Number(isContainerExample(b)) - Number(isContainerExample(a)));
  const examplesSection = onOpenExample && examples.length > 0 && (
    <section aria-labelledby="studio-examples-heading" className="st-home-examples">
      <div className="st-section-head">
        <h2 id="studio-examples-heading" className="st-section-title">Start from an example</h2>
        <span className="st-section-note">No key needed</span>
      </div>
      <ul className="st-examples">
        {sortedExamples.map((example, index) => {
          const language = exampleLanguage(example);
          const formatLabel = isContainerExample(example) ? 'Web Container' : '.ui';
          const excerpt = exampleExcerpt(example);
          const title = example.name.replace(/\s*\(example\)\s*$/i, '');
          return (
            <li key={example.id}>
              <button
                type="button"
                className="st-example"
                ref={index === 0 ? firstExampleRef : undefined}
                onClick={() => onOpenExample(example)}
                aria-label={`Open the ${language} example: ${title}`}
                aria-describedby={`studio-example-description-${index}`}
              >
                <span className="st-example-head">
                  <span className="st-example-lang">{formatLabel} · {language}</span>
                  <Icon name="chevron-right" size={18} />
                </span>
                <span className="st-example-title">{title}</span>
                <span className="st-example-desc" id={`studio-example-description-${index}`}>{example.description}</span>
                {excerpt && (
                  <code className="st-code" aria-hidden="true">
                    <span className="st-code-file">{excerpt.path}</span>
                    {excerpt.lines.map((line, i) => (
                      <React.Fragment key={i}>
                        {highlight(line)}
                        {i < excerpt.lines.length - 1 ? '\n' : null}
                      </React.Fragment>
                    ))}
                  </code>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );

  return (
    <div className="st-home" ref={homeRef}>
      <div className="st-home-inner">
        {/* One line for what Studio is for and the two ways to start, then the work. The product
            bar above carries the mark and the theme switch. */}
        <header className="st-home-head">
          <div className="st-home-intro">
            <h1 id="studio-home-title" className="st-home-title">Studio workspace</h1>
            {/* Said to someone who has made nothing here yet; a person with projects has read it. */}
            {recentProjects.length === 0 && (
              <p className="st-home-lede">
                Describe an app to build with AI, import a project or open an example to edit and run.
              </p>
            )}
          </div>
          <div className="st-home-actions">
            <button ref={startRef} type="button" className="st-btn st-btn-primary" onClick={() => onNewProject()}>
              <Icon name="sparkles" size={16} />
              Start a new app
            </button>
            {importAction}
            {onImportProject && <span className="st-home-hint">.softn, .zip or .json. You can also drop the file on Import.</span>}
            {ai && (
              <div className="st-home-ai">
                <span>{aiReady ? 'The AI uses' : 'The AI is not connected yet.'}</span>
                <AIStatusPill />
              </div>
            )}
          </div>

          {importFeedback}
        </header>
        {starters}

        {/* The work: the person's own projects first and at the left, where the eye starts, and
            the examples beside them. The page used to open on a headline that filled the screen,
            with the projects under it, below the fold on a laptop; on a phone they came after
            both examples. */}
        <div className="st-home-grid" data-empty={recentProjects.length === 0 || undefined}>
          {(recentProjects.length > 0 || storeSilent) && <section className="st-home-recent" aria-labelledby="studio-recent-heading">
            <div className="st-section-head">
              <h2 id="studio-recent-heading" className="st-section-title">Recent projects</h2>
              {recentProjects.length > 0 && <span className="st-section-note">Kept in this browser</span>}
            </div>
            {storeSilent && (
              <div role="alert" className="st-store-silent" data-store-silent="true">
                <p>
                  This browser’s storage did not answer in time, so Studio cannot tell which of these projects have a saved copy, and none of them can be opened yet. Nothing has been lost by this.
                </p>
                <button
                  type="button"
                  className="st-btn st-btn-sm"
                  disabled={askingStore}
                  aria-busy={askingStore || undefined}
                  onClick={() => {
                    if (askingStore) return;
                    setAskingStore(true);
                    void Promise.resolve(onRetryStore?.()).finally(() => setAskingStore(false));
                  }}
                >
                  {askingStore ? 'Asking…' : 'Try again'}
                </button>
              </div>
            )}
            {recentProjects.length > 0 && (
              <ul aria-labelledby="studio-recent-heading" className="st-recent-list">
                {recentProjects.map((project) => {
                  const who = rowNames.get(project.id) ?? project.name;
                  const openable = project.saved || project.active;
                  const isBusy = busyId === project.id;
                  const state = project.active && !project.saved ? 'unsaved' : project.saved ? 'saved' : 'missing';
                  // "No saved copy" is said only of a name with no record behind it. A store that
                  // did not answer may hold every copy, and a record a newer Studio wrote is a copy:
                  // each used to be called the same thing.
                  const why = state === 'missing' ? project.why : undefined;
                  const stateLabel = state === 'unsaved' ? 'Open, not saved' : state === 'saved' ? 'Saved'
                    : why === 'silent' ? 'Storage did not answer' : why === 'newer' ? 'From a newer Studio' : 'No saved copy';
                  const stateTitle = state === 'unsaved'
                    ? 'This project is in memory but has not been saved to this browser. Open it and export a bundle to keep it.'
                    : state === 'saved'
                      ? 'A saved copy is in this browser.'
                      : why === 'silent'
                        ? 'This browser’s storage did not answer in time, so Studio cannot tell whether a saved copy of this project is here. Try again above.'
                        : why === 'newer'
                          ? 'This project was saved by a newer version of Studio than this one, which cannot read it. Reload the page to get the newer Studio; nothing here writes over it.'
                          : 'This entry is only a name: no saved copy of it is in this browser.';
                  return (
                    <li key={project.id} className="st-recent-item">
                      <div className="st-recent-row" data-openable={openable}>
                        <button
                          type="button"
                          className="st-recent-open"
                          data-row={project.id}
                          data-control="open"
                          aria-disabled={openable && !isBusy ? undefined : true}
                          aria-busy={isBusy || undefined}
                          aria-label={`Open ${who}`}
                          title={stateTitle}
                          onClick={() => {
                            if (openable && !isBusy) void handleOpen(project);
                          }}
                        >
                          <span className="st-recent-glyph" aria-hidden="true">{initial(project.name)}</span>
                          <span className="st-recent-info">
                            <span className="st-recent-name">{project.name}</span>
                            <span className="st-recent-meta">
                              {TARGET_LABEL[project.target] ?? project.target}, {project.lastModified}
                            </span>
                          </span>
                          <span className="st-state" data-state={state}>{isBusy ? 'Opening…' : stateLabel}</span>
                        </button>
                        <div className="st-recent-actions">
                          {openable && onRenameProject && (
                            <button
                              type="button"
                              className="st-icon-btn"
                              data-row={project.id}
                              data-control="rename"
                              onClick={() => setRenamingId(renamingId === project.id ? null : project.id)}
                              aria-expanded={renamingId === project.id}
                              aria-label={`Rename ${who}`}
                              title="Rename…"
                            >
                              <Icon name="edit" size={15} />
                            </button>
                          )}
                          {project.saved && onExportProject && (
                            <button
                              type="button"
                              className="st-icon-btn"
                              onClick={() => void handleExport(project)}
                              aria-label={`Export ${who} as a bundle`}
                              title="Export bundle"
                            >
                              <Icon name="export" size={15} />
                            </button>
                          )}
                          <button
                            type="button"
                            className="st-icon-btn"
                            onClick={() => onRemoveRecent?.(project.id)}
                            aria-label={`Remove ${who} from the recent list`}
                            title="Remove from list (keeps the saved copy)"
                          >
                            <Icon name="x" size={15} />
                          </button>
                          {project.saved && onDeleteProject && (
                            <button
                              type="button"
                              className="st-icon-btn"
                              data-row={project.id}
                              data-control="delete"
                              onClick={() => setConfirmingId(confirmingId === project.id ? null : project.id)}
                              aria-expanded={confirmingId === project.id}
                              aria-label={`Delete ${who} from this browser`}
                              title="Delete project…"
                            >
                              <Icon name="trash" size={15} />
                            </button>
                          )}
                        </div>
                      </div>
                      {renamingId === project.id && onRenameProject && (
                        <div role="group" aria-label={`Rename ${who}`} className="st-confirm">
                          <RenameField
                            name={project.name}
                            label={`New name for ${who}`}
                            actions
                            onClose={() => {
                              // Kept or cancelled, the keyboard goes back to the row's Rename.
                              pendingFocus.current = { row: project.id, control: 'rename' };
                              setRenamingId(null);
                            }}
                            onRename={async (next) => {
                              try {
                                const outcome = await onRenameProject(project.id, next);
                                if (!outcome.ok) return `Could not rename ${project.name}: ${outcome.message}`;
                              } catch (err) {
                                return `Could not rename ${project.name}: ${err instanceof Error ? err.message : String(err)}`;
                              }
                              setNotice(null);
                              return null;
                            }}
                          />
                        </div>
                      )}
                      {confirmingId === project.id && (
                        <div role="group" aria-label={`Delete ${who}`} className="st-confirm">
                          <p>
                            Delete the saved copy of <strong>{project.name}</strong> from this browser? This cannot be undone. Export a bundle first if you want to keep it.
                          </p>
                          <div className="st-confirm-actions">
                            {onExportProject && (
                              <button type="button" className="st-btn st-btn-sm" onClick={() => void handleExport(project)}>
                                Export bundle first
                              </button>
                            )}
                            <button type="button" className="st-btn st-btn-sm st-btn-danger" onClick={() => void handleDelete(project)} disabled={isBusy}>
                              Delete project
                            </button>
                            <button
                              type="button"
                              className="st-btn st-btn-sm st-btn-ghost"
                              onClick={() => {
                                pendingFocus.current = { row: project.id, control: 'delete' };
                                setConfirmingId(null);
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>}

          {examplesSection}
        </div>

        {fileInput}
      </div>
    </div>
  );
};
