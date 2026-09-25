import React, { useRef, useState, useCallback, useEffect } from 'react';
import { Icon } from '../common/Icon';
import { EXAMPLES, type ExampleProject } from '../../examples';
import { ProviderSetup } from '../ai/ProviderSetup';
import { AIStatusPill, useAIReadiness } from '../ai/AIStatusPill';

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
  /** Open one of the bundled examples as a new project. */
  onOpenExample?: (example: ExampleProject) => void;
  recentProjects?: RecentEntry[];
  /** The examples offered; the bundled ones unless a test says otherwise. */
  examples?: readonly ExampleProject[];
  /**
   * The AI's part of the page. With `gate`, no provider is connected and
   * the person has not chosen to go without: connecting one is the first
   * thing on the page, and nothing else can be started until it is done or
   * `onSkip` is chosen. Without `gate`, a line under the hero says which
   * provider the AI uses. Absent in a hosted editor, which has its own AI.
   */
  ai?: { gate: boolean; onSkip(): void };
}

const TARGET_LABEL: Record<string, string> = { web: 'Web app', desktop: 'Desktop app', dual: 'Web and desktop' };

/** Which language an example's logic is in, read from its files. */
function exampleLanguage(example: ExampleProject): 'Python' | 'JavaScript' {
  return example.files.some((file) => /^logic\/.+\.py$/.test(file.path)) ? 'Python' : 'JavaScript';
}

/**
 * A few real lines of the example's logic — the function that switches pages,
 * which both examples have — so the two cards show the difference between
 * them rather than describe it. Comments are left out: the card has room for
 * the shape of the code, not its explanation.
 */
function exampleExcerpt(example: ExampleProject): { path: string; lines: string[] } | null {
  const logic = example.files.find((file) => /^logic\/main\.(logic|py)$/.test(file.path));
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

/** The first letter of a project's name, for its tile in the list. */
function initial(name: string): string {
  const letter = name.trim().match(/\p{L}|\p{N}/u);
  return letter ? letter[0].toUpperCase() : '·';
}

/**
 * Studio's front door: what it is for, the one thing to press first, and
 * everything that already exists — recent projects and the bundled examples.
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
  onOpenExample,
  recentProjects = [],
  examples = EXAMPLES,
  ai,
}) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importRequest = useRef(0);
  const [importing, setImporting] = useState(false);

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

  const handleDelete = useCallback(async (project: RecentEntry) => {
    if (!onDeleteProject) return;
    setNotice(null);
    setBusyId(project.id);
    try {
      const outcome = await onDeleteProject(project.id);
      setNotice(outcome.ok ? { kind: 'info', text: `Deleted ${project.name} from this browser.` } : { kind: 'error', text: `Could not delete ${project.name}: ${outcome.message}` });
    } catch (err) {
      setNotice({ kind: 'error', text: `Could not delete ${project.name}: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setBusyId(null);
      setConfirmingId(null);
    }
  }, [onDeleteProject]);

  const gated = !!ai?.gate;
  // React 18 has no `inert` prop; the attribute takes the locked part out
  // of the tab order and the accessibility tree in one go.
  const lockedRef = useRef<HTMLDivElement>(null);
  const homeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    lockedRef.current?.toggleAttribute('inert', gated);
    // Leaving the step (connected or skipped) starts the page from its top,
    // not wherever the setup's last step had scrolled it.
    if (!gated) homeRef.current?.scrollTo?.({ top: 0 });
  }, [gated]);
  const aiReady = useAIReadiness().state === 'ready';

  const onboarding = gated && (
    <section className="st-onboard" aria-labelledby="studio-onboard-title">
      <div className="st-onboard-intro">
        <span className="st-onboard-eyebrow">Before you start</span>
        <h1 id="studio-onboard-title" className="st-onboard-title">Connect an AI provider.</h1>
        <p className="st-onboard-lede">
          Studio’s AI writes your app, and it needs a model to do it. Run one on this computer for free, or use your own
          OpenAI or Anthropic key. It takes a minute, and you can change it later in Settings.
        </p>
      </div>
      <div className="st-onboard-card">
        <ProviderSetup />
      </div>
      <div className="st-onboard-skip">
        <span>Just looking? The examples run without any AI.</span>
        <button type="button" className="st-btn st-btn-sm" onClick={ai!.onSkip}>
          Explore examples without AI
        </button>
      </div>
    </section>
  );

  return (
    <div className="st-home" ref={homeRef}>
      <div className="st-home-inner" data-has-recent={recentProjects.length > 0}>
        {onboarding}
        {/* Everything else is still on the page, so it is not a wall — but
            nothing in it can be started until the step above is done or
            skipped, and it says so rather than failing later. */}
        <div ref={lockedRef} className={gated ? 'st-home-locked' : undefined}>
        {/* The product bar above carries the mark and the theme switch;
            this page starts with what Studio is for. */}
        <div className="st-home-top">
          <section className="st-hero" aria-labelledby="studio-home-title">
            <h1 id="studio-home-title" className="st-hero-title">Describe an app. Studio builds it.</h1>
            <p className="st-hero-lede">
              Tell the AI what the app is for. Studio writes its <code>.ui</code> pages, logic and data,
              shows it running as it goes, and exports a <code>.softn</code> bundle you can run or publish.
            </p>
            <div className="st-hero-actions">
              <button type="button" className="st-btn st-btn-primary st-btn-lg" onClick={() => onNewProject()}>
                <Icon name="sparkles" size={16} />
                Start a new app
              </button>
              <button
                type="button"
                className="st-btn st-btn-lg"
                onClick={() => fileInputRef.current?.click()}
                aria-busy={importing || undefined}
                data-drag={isDragOver || undefined}
                onDrop={handleDrop}
                onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
                onDragLeave={() => setIsDragOver(false)}
              >
                <Icon name="upload" size={16} />
                {importing ? 'Opening project…' : 'Import a bundle'}
              </button>
              <span className="st-hero-hint">.softn, .zip or .json. You can also drop the file on Import.</span>
            </div>

            {ai && !gated && (
              <div className="st-home-ai">
                <span>{aiReady ? 'The AI uses' : 'The AI is not connected yet.'}</span>
                <AIStatusPill />
              </div>
            )}

            <div aria-live="polite" role={notice?.kind === 'error' ? 'alert' : 'status'}>
              {notice && <p className="st-notice" data-kind={notice.kind}>{notice.text}</p>}
            </div>
          </section>

          {onOpenExample && examples.length > 0 && (
            <section aria-labelledby="studio-examples-heading" className="st-home-examples">
              <div className="st-section-head">
                <h2 id="studio-examples-heading" className="st-section-title">Start from an example</h2>
                <span className="st-section-note">No key needed</span>
              </div>
              <ul className="st-examples">
                {examples.map((example) => {
                  const language = exampleLanguage(example);
                  const excerpt = exampleExcerpt(example);
                  const title = example.name.replace(/\s*\(example\)\s*$/i, '');
                  return (
                    <li key={example.id}>
                      <button
                        type="button"
                        className="st-example"
                        onClick={() => onOpenExample(example)}
                        aria-label={`Open the ${language} example: ${title}`}
                      >
                        <span className="st-example-head">
                          <span className="st-example-title">{title}</span>
                          <span className="st-example-lang">{language}</span>
                        </span>
                        <span className="st-example-desc">{example.description}</span>
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
          )}
        </div>

        <div className="st-home-recent">
          <section aria-labelledby="studio-recent-heading">
            <div className="st-section-head">
              <h2 id="studio-recent-heading" className="st-section-title">Recent projects</h2>
              {recentProjects.length > 0 && <span className="st-section-note">Kept in this browser</span>}
            </div>
            {recentProjects.length === 0 ? (
              <div className="st-empty">
                <strong>Nothing here yet</strong>
                Apps you start, import or open from an example are saved in this browser and listed here.
                Export a bundle to keep a copy anywhere else.
              </div>
            ) : (
              <ul aria-labelledby="studio-recent-heading" className="st-recent-list">
                {recentProjects.map((project) => {
                  const openable = project.saved || project.active;
                  const isBusy = busyId === project.id;
                  const state = project.active && !project.saved ? 'unsaved' : project.saved ? 'saved' : 'missing';
                  const stateLabel = state === 'unsaved' ? 'Open, not saved' : state === 'saved' ? 'Saved' : 'No saved copy';
                  const stateTitle = state === 'unsaved'
                    ? 'This project is in memory but has not been saved to this browser. Open it and export a bundle to keep it.'
                    : state === 'saved'
                      ? 'A saved copy is in this browser.'
                      : 'This entry is only a name: no saved copy of it is in this browser.';
                  return (
                    <li key={project.id} className="st-recent-item">
                      <div className="st-recent-row" data-openable={openable}>
                        <button
                          type="button"
                          className="st-recent-open"
                          aria-disabled={openable && !isBusy ? undefined : true}
                          aria-busy={isBusy || undefined}
                          aria-label={`Open ${project.name}`}
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
                          {project.saved && onExportProject && (
                            <button
                              type="button"
                              className="st-icon-btn"
                              onClick={() => void handleExport(project)}
                              aria-label={`Export ${project.name} as a bundle`}
                              title="Export bundle"
                            >
                              <Icon name="export" size={15} />
                            </button>
                          )}
                          <button
                            type="button"
                            className="st-icon-btn"
                            onClick={() => onRemoveRecent?.(project.id)}
                            aria-label={`Remove ${project.name} from the recent list`}
                            title="Remove from list (keeps the saved copy)"
                          >
                            <Icon name="x" size={15} />
                          </button>
                          {project.saved && onDeleteProject && (
                            <button
                              type="button"
                              className="st-icon-btn"
                              onClick={() => setConfirmingId(confirmingId === project.id ? null : project.id)}
                              aria-expanded={confirmingId === project.id}
                              aria-label={`Delete ${project.name} from this browser`}
                              title="Delete project…"
                            >
                              <Icon name="trash" size={15} />
                            </button>
                          )}
                        </div>
                      </div>
                      {confirmingId === project.id && (
                        <div role="group" aria-label={`Delete ${project.name}`} className="st-confirm">
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
                            <button type="button" className="st-btn st-btn-sm st-btn-ghost" onClick={() => setConfirmingId(null)}>
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
          </section>

        </div>

        {/* A real sequence, so it is numbered; kept small and last, because
            nothing in it can be pressed. */}
        <ol className="st-steps" aria-label="How Studio works">
          <li><strong>Describe</strong>Say what the app is for; the AI plans its pages and data.</li>
          <li><strong>Preview</strong>Watch it render as files are written, and click through it.</li>
          <li><strong>Export bundle</strong>Download a .softn file, then Run or Publish it.</li>
        </ol>

        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".softn,.zip,.json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
            e.target.value = '';
          }}
        />
      </div>
    </div>
  );
};
