import React, { useMemo, useRef, useState, useCallback, useEffect } from 'react';
import { Icon } from '../common/Icon';
import { useWorkspaceStore } from '../../stores';

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
  /** Open the bundled example project. Offered when there is nothing recent to open. */
  onOpenExample?: () => void;
  recentProjects?: RecentEntry[];
}

type ThemeMode = 'dark' | 'light';

/**
 * The dashboard used to carry its own palette — a third one, agreeing with
 * neither theme in App.tsx and drifting from both. These are now just names for
 * the studio tokens, so there is one place a colour is decided. App.tsx mirrors
 * those tokens onto the document element, which is what makes them resolve here:
 * the dashboard renders outside the subtree each editor view wraps in them.
 *
 * The shadows still branch on the mode because a shadow is not a colour swap —
 * on a light ground it is a soft grey lift, on a dark one it is a deeper hole.
 */
function getTheme(theme: ThemeMode) {
  const shadows =
    theme === 'light'
      ? {
          shadow: '0 1px 2px rgba(20,24,29,0.04), 0 8px 24px rgba(20,24,29,0.05)',
          shadowHover: '0 2px 6px rgba(20,24,29,0.07), 0 18px 44px rgba(20,24,29,0.09)',
        }
      : {
          shadow: '0 1px 2px rgba(0,0,0,0.3), 0 8px 24px rgba(0,0,0,0.22)',
          shadowHover: '0 2px 6px rgba(0,0,0,0.4), 0 18px 44px rgba(0,0,0,0.32)',
        };

  return {
    pageBg: 'var(--studio-bg)',
    cardBg: 'var(--studio-bg-elevated)',
    cardBgHover: 'var(--studio-bg-muted)',
    surfaceBg: 'var(--studio-surface)',
    text: 'var(--studio-text)',
    textSecondary: 'var(--studio-text-muted)',
    textDim: 'var(--studio-text-dim)',
    border: 'var(--studio-border)',
    borderHover: 'var(--studio-border-strong)',
    accent: 'var(--studio-accent)',
    accentSoft: 'var(--studio-accent-soft)',
    accentGlow: 'var(--studio-accent-soft)',
    error: 'var(--studio-error)',
    ...shadows,
  };
}

/**
 * Focus has to be visible on the recent-project controls, and inline styles
 * cannot express :focus-visible. One stylesheet, scoped by class, is the
 * least that does it.
 */
const FOCUS_CSS = `
.studio-recent-open:focus-visible,
.studio-recent-btn:focus-visible {
  outline: 2px solid var(--studio-accent);
  outline-offset: 2px;
}
.studio-recent-btn:hover,
.studio-recent-btn:focus-visible {
  opacity: 1 !important;
}
`;

/**
 * Recent projects are a list of real buttons.
 *
 * Each row was a `div` with an `onClick`: no role, no tab stop, nothing
 * for Enter or Space to activate, and its remove control was invisible
 * until hovered, which a keyboard never does. The row that opens is now a
 * `button` — the browser gives it activation on Enter and Space — and
 * "remove from list", "export a copy" and "delete" are separate labelled
 * buttons beside it, always visible enough to find. Removal and deletion
 * mean different things and say so: removing takes the entry off this
 * list; deleting takes the saved copy out of this browser, asks first, and
 * offers an export before it does. An entry with no saved copy says "No
 * saved copy" rather than pretending: the old list kept names of projects
 * whose only copy was overwritten long ago.
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
}) => {
  const { themePreview } = useWorkspaceStore();
  const [hoveredCard, setHoveredCard] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importRequest = useRef(0);
  const [importing, setImporting] = useState(false);

  const theme = useMemo(() => getTheme(themePreview as ThemeMode), [themePreview]);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

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

  const m = isMobile; // shorthand

  return (
    <div style={{ ...s.root, background: theme.pageBg, color: theme.text }}>
      <style>{FOCUS_CSS}</style>
      <div style={s.scroll}>
        <div style={{ ...s.page, padding: m ? '20px 16px 32px' : '40px 28px 60px' }}>

          {/* The product bar above carries the mark and the theme switch;
              this page starts with what Studio is for. */}

          {/* Hero */}
          <div style={{ textAlign: m ? 'center' : 'left', marginBottom: m ? 28 : 40 }}>
            <h1 style={{ ...s.heroTitle, fontSize: m ? 26 : 40 }}>
              Build apps with AI
            </h1>
            <p style={{ ...s.heroSub, color: theme.textSecondary, fontSize: m ? 14 : 16, maxWidth: m ? 320 : 520, margin: m ? '10px auto 0' : '10px 0 0' }}>
              Describe what you want, import an existing bundle, or jump back into a recent project.
            </p>
          </div>

          <div aria-live="polite" role={notice?.kind === 'error' ? 'alert' : 'status'} style={{ minHeight: notice ? undefined : 0 }}>
            {notice && (
              <p style={{ ...s.notice, color: notice.kind === 'error' ? theme.error : theme.textSecondary, borderColor: notice.kind === 'error' ? theme.error : theme.border }}>
                {notice.text}
              </p>
            )}
          </div>

          {/* Action Cards */}
          <div style={{ ...s.actions, flexDirection: m ? 'column' : 'row', gap: m ? 10 : 14, marginBottom: m ? 28 : 40 }}>
            <button
              onClick={() => onNewProject()}
              onMouseEnter={() => setHoveredCard('new')}
              onMouseLeave={() => setHoveredCard(null)}
              className="studio-recent-open"
              style={{
                ...s.actionCard,
                flex: m ? 'none' : 1,
                // The primary path, and it says so at rest rather than only on
                // hover: side by side at identical weight, neither card looked
                // like the one to press first.
                background: hoveredCard === 'new' ? theme.cardBgHover : theme.cardBg,
                borderColor: theme.accent,
                boxShadow: hoveredCard === 'new' ? theme.shadowHover : theme.shadow,
                padding: m ? '18px 16px' : '24px 22px',
              }}
            >
              <div style={{ ...s.actionIcon, background: 'var(--studio-accent-soft)', border: '1px solid var(--studio-accent)' }}>
                <Icon name="sparkles" size={20} color="var(--studio-accent)" />
              </div>
              <div style={s.actionText}>
                <span style={{ ...s.actionTitle, color: theme.text }}>Start with AI</span>
                <span style={{ ...s.actionDesc, color: theme.textSecondary }}>Describe your app idea</span>
              </div>
              <Icon name="chevron-right" size={16} color={theme.textDim} />
            </button>

            <button
              onClick={() => fileInputRef.current?.click()}
              aria-busy={importing || undefined}
              onMouseEnter={() => setHoveredCard('import')}
              onMouseLeave={() => setHoveredCard(null)}
              onDrop={handleDrop}
              onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
              onDragLeave={() => setIsDragOver(false)}
              className="studio-recent-open"
              style={{
                ...s.actionCard,
                flex: m ? 'none' : 1,
                background: isDragOver ? theme.accentSoft : hoveredCard === 'import' ? theme.cardBgHover : theme.cardBg,
                borderColor: isDragOver ? theme.accent : hoveredCard === 'import' ? theme.borderHover : theme.border,
                boxShadow: hoveredCard === 'import' ? theme.shadowHover : theme.shadow,
                padding: m ? '18px 16px' : '24px 22px',
              }}
            >
              <div style={{ ...s.actionIcon, background: theme.accentSoft }}>
                <Icon name="upload" size={20} color={theme.accent} />
              </div>
              <div style={s.actionText}>
                <span style={{ ...s.actionTitle, color: theme.text }}>{importing ? 'Opening project…' : 'Import bundle'}</span>
                <span style={{ ...s.actionDesc, color: theme.textSecondary }}>Open a .softn, .zip or .json file</span>
              </div>
              <Icon name="chevron-right" size={16} color={theme.textDim} />
            </button>
          </div>

          {/* A first visit has no key and no bundle, so neither card above
              ends in an app. The example does: a complete project, opened
              as a copy, that runs and exports as it is. It is offered only
              while there is nothing recent, and says it is an example. */}
          {recentProjects.length === 0 && onOpenExample && (
            <div style={{ marginBottom: m ? 28 : 40 }}>
              <button
                type="button"
                onClick={onOpenExample}
                onMouseEnter={() => setHoveredCard('example')}
                onMouseLeave={() => setHoveredCard(null)}
                className="studio-recent-open"
                aria-label="Open an example project"
                style={{
                  ...s.actionCard,
                  width: '100%',
                  background: hoveredCard === 'example' ? theme.cardBgHover : theme.cardBg,
                  borderColor: hoveredCard === 'example' ? theme.borderHover : theme.border,
                  boxShadow: hoveredCard === 'example' ? theme.shadowHover : theme.shadow,
                  padding: m ? '14px 16px' : '16px 22px',
                }}
              >
                <div style={{ ...s.actionIcon, background: theme.accentSoft }}>
                  <Icon name="layout" size={20} color={theme.accent} />
                </div>
                <div style={s.actionText}>
                  <span style={{ ...s.actionTitle, color: theme.text }}>Open an example</span>
                  <span style={{ ...s.actionDesc, color: theme.textSecondary }}>
                    No key or bundle needed. A small complete app — a reading list — opens as a copy you can change, run and export.
                  </span>
                </div>
                <span style={{ ...s.openBadge, background: theme.accentSoft, color: theme.accent }}>Example</span>
              </button>
            </div>
          )}

          {/* Recent Projects */}
          {recentProjects.length > 0 && (
            <div style={{ marginBottom: m ? 20 : 32 }}>
              <h2 id="studio-recent-heading" style={{ ...s.sectionTitle, color: theme.textSecondary, fontSize: m ? 12 : 13, marginBottom: m ? 10 : 12 }}>
                Recent projects
              </h2>
              <ul aria-labelledby="studio-recent-heading" style={s.list}>
                {recentProjects.map((project) => {
                  const openable = project.saved || project.active;
                  const isHovered = hoveredCard === project.id;
                  const isBusy = busyId === project.id;
                  const badge = project.active && !project.saved ? 'Open · not saved' : project.saved ? 'Open' : 'No saved copy';
                  const badgeTitle = project.active && !project.saved
                    ? 'This project is in memory but has not been saved to this browser. Open it and export a bundle to keep it.'
                    : project.saved
                      ? 'A saved copy is in this browser.'
                      : 'This entry is only a name: no saved copy of it is in this browser.';
                  return (
                    <li key={project.id} style={s.listItem}>
                      <div
                        onMouseEnter={() => setHoveredCard(project.id)}
                        onMouseLeave={() => setHoveredCard(null)}
                        style={{
                          ...s.projectRow,
                          background: isHovered && openable ? theme.cardBgHover : theme.cardBg,
                          borderColor: isHovered && openable ? theme.accent : theme.border,
                          boxShadow: isHovered && openable ? theme.shadowHover : theme.shadow,
                          opacity: openable ? 1 : 0.6,
                          padding: m ? '8px 8px 8px 14px' : '8px 10px 8px 18px',
                        }}
                      >
                        <button
                          type="button"
                          className="studio-recent-open"
                          aria-disabled={openable && !isBusy ? undefined : true}
                          aria-busy={isBusy || undefined}
                          aria-label={`Open ${project.name}`}
                          title={badgeTitle}
                          onClick={() => {
                            if (openable && !isBusy) void handleOpen(project);
                          }}
                          style={{ ...s.openBtn, cursor: openable ? 'pointer' : 'default' }}
                        >
                          <div style={{ ...s.projectIcon, background: theme.accentSoft }}>
                            <Icon name="layout" size={16} color={theme.accent} />
                          </div>
                          <div style={s.projectInfo}>
                            <span style={{ ...s.projectName, color: theme.text }}>{project.name}</span>
                            <span style={{ ...s.projectMeta, color: theme.textDim, fontSize: m ? 11 : 12 }}>
                              {project.target} · {project.lastModified}
                            </span>
                          </div>
                          <span style={{ ...s.openBadge, background: openable ? theme.accentSoft : theme.surfaceBg, color: openable ? theme.accent : theme.textDim }}>
                            {isBusy ? 'Opening…' : badge}
                          </span>
                        </button>
                        <div style={s.rowActions}>
                          {project.saved && onExportProject && (
                            <button
                              type="button"
                              className="studio-recent-btn"
                              onClick={() => void handleExport(project)}
                              style={{ ...s.removeBtn, color: theme.textDim }}
                              aria-label={`Export ${project.name} as a bundle`}
                              title="Export bundle"
                            >
                              <Icon name="export" size={14} />
                            </button>
                          )}
                          <button
                            type="button"
                            className="studio-recent-btn"
                            onClick={() => onRemoveRecent?.(project.id)}
                            style={{ ...s.removeBtn, color: theme.textDim }}
                            aria-label={`Remove ${project.name} from the recent list`}
                            title="Remove from list (keeps the saved copy)"
                          >
                            <Icon name="x" size={14} />
                          </button>
                          {project.saved && onDeleteProject && (
                            <button
                              type="button"
                              className="studio-recent-btn"
                              onClick={() => setConfirmingId(confirmingId === project.id ? null : project.id)}
                              aria-expanded={confirmingId === project.id}
                              style={{ ...s.removeBtn, color: theme.textDim }}
                              aria-label={`Delete ${project.name} from this browser`}
                              title="Delete project…"
                            >
                              <Icon name="trash" size={14} />
                            </button>
                          )}
                        </div>
                      </div>
                      {confirmingId === project.id && (
                        <div role="group" aria-label={`Delete ${project.name}`} style={{ ...s.confirm, borderColor: theme.error }}>
                          <p style={{ ...s.confirmText, color: theme.text }}>
                            Delete the saved copy of <strong>{project.name}</strong> from this browser? This cannot be undone. Export a bundle first if you want to keep it.
                          </p>
                          <div style={s.confirmActions}>
                            {onExportProject && (
                              <button type="button" className="studio-recent-btn" onClick={() => void handleExport(project)} style={{ ...s.confirmBtn, borderColor: theme.accent, color: theme.text }}>
                                Export bundle first
                              </button>
                            )}
                            <button type="button" className="studio-recent-btn" onClick={() => void handleDelete(project)} disabled={isBusy} style={{ ...s.confirmBtn, background: theme.error, borderColor: theme.error, color: '#fff' }}>
                              Delete project
                            </button>
                            <button type="button" className="studio-recent-btn" onClick={() => setConfirmingId(null)} style={{ ...s.confirmBtn, borderColor: theme.border, color: theme.textSecondary }}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* How it works — desktop only */}
          {!m && (
            <div style={{ marginBottom: 32 }}>
              <h2 style={{ ...s.sectionTitle, color: theme.textSecondary, marginBottom: 12 }}>How it works</h2>
              {/*
                A real sequence, so the numbers earn their place — but as three
                boxed cards they competed with the two actions above, which are
                the only things on this screen you can actually press. Divided
                columns say "steps" just as well and stay in the background.
              */}
              <div style={s.steps}>
                {[
                  { step: '01', title: 'Describe', desc: 'Tell AI what you want to build' },
                  { step: '02', title: 'Preview', desc: 'See the result live in the canvas' },
                  { step: '03', title: 'Export bundle', desc: 'Download your app as a .softn file, then Run or Publish it' },
                ].map((item, i) => (
                  <div
                    key={item.step}
                    style={{
                      ...s.step,
                      borderLeft: i === 0 ? 'none' : `1px solid ${theme.border}`,
                      paddingLeft: i === 0 ? 0 : 18,
                    }}
                  >
                    <div style={{ ...s.stepNum, color: theme.accent }}>{item.step}</div>
                    <div style={{ ...s.stepTitle, color: theme.text }}>{item.title}</div>
                    <div style={{ ...s.stepDesc, color: theme.textSecondary }}>{item.desc}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

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
    </div>
  );
};

const s: Record<string, React.CSSProperties> = {
  root: {
    height: '100vh',
    width: '100%',
    overflow: 'hidden',
  },
  scroll: {
    height: '100%',
    overflowY: 'auto',
    overflowX: 'hidden',
    WebkitOverflowScrolling: 'touch',
    // Centre the column in the viewport rather than pinning it to the top. The
    // dashboard is short, and left at the top it sat in the first third of the
    // screen with the rest of the window empty behind it. `auto` margins on the
    // flex child keep it centred when it is short and let it scroll normally
    // once recent projects make it taller than the window.
    display: 'flex',
    flexDirection: 'column',
  },
  page: {
    width: '100%',
    maxWidth: 760,
    margin: 'auto',
  },

  // Hero
  heroTitle: {
    fontFamily: 'var(--studio-display)',
    fontWeight: 800,
    lineHeight: 0.98,
    margin: 0,
    letterSpacing: '-0.04em',
    fontVariationSettings: "'wdth' 100, 'opsz' 40",
  },
  heroSub: {
    lineHeight: 1.6,
    margin: 0,
  },

  // Action cards
  actions: {
    display: 'flex',
  },
  actionCard: {
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    borderRadius: 16,
    borderWidth: 1,
    borderStyle: 'solid',
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left' as const,
    transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
  },
  actionIcon: {
    width: 42,
    height: 42,
    borderRadius: 12,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  actionText: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    flex: 1,
    minWidth: 0,
  },
  actionTitle: {
    fontSize: 14,
    fontWeight: 700,
  },
  actionDesc: {
    fontSize: 12,
    lineHeight: 1.4,
  },

  notice: {
    margin: '0 0 16px',
    padding: '10px 14px',
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: 'solid',
    fontSize: 13,
    lineHeight: 1.5,
    overflowWrap: 'anywhere',
  },

  // Section
  sectionTitle: {
    margin: 0,
    fontFamily: 'var(--studio-mono)',
    fontSize: 11,
    fontWeight: 500,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.16em',
  },
  list: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  listItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },

  // Project rows
  projectRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    borderRadius: 14,
    borderWidth: 1,
    borderStyle: 'solid',
    transition: 'all 0.15s',
    position: 'relative',
  },
  openBtn: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '6px 4px',
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    fontFamily: 'inherit',
    textAlign: 'left' as const,
    borderRadius: 10,
  },
  projectIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  projectInfo: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    flex: 1,
    minWidth: 0,
  },
  projectName: {
    fontSize: 14,
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  projectMeta: {
    fontSize: 12,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  openBadge: {
    fontSize: 11,
    fontWeight: 700,
    padding: '4px 10px',
    borderRadius: 999,
    flexShrink: 0,
    whiteSpace: 'nowrap',
  },
  rowActions: {
    display: 'flex',
    alignItems: 'center',
    gap: 2,
    flexShrink: 0,
  },
  removeBtn: {
    width: 32,
    height: 32,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    background: 'transparent',
    borderRadius: 8,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'opacity 0.15s',
    flexShrink: 0,
    opacity: 0.6,
  },
  confirm: {
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: 'solid',
    padding: '12px 14px',
    background: 'var(--studio-surface)',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  confirmText: {
    margin: 0,
    fontSize: 13,
    lineHeight: 1.5,
  },
  confirmActions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
  },
  confirmBtn: {
    padding: '7px 12px',
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: 'solid',
    background: 'transparent',
    fontFamily: 'inherit',
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer',
  },

  // Steps
  steps: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 18,
  },
  step: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 2,
  },
  stepNum: {
    fontFamily: 'var(--studio-mono)',
    fontSize: 11,
    letterSpacing: '0.1em',
    marginBottom: 6,
  },
  stepTitle: {
    fontSize: 14,
    fontWeight: 600,
  },
  stepDesc: {
    fontSize: 12.5,
    lineHeight: 1.55,
  },
};
