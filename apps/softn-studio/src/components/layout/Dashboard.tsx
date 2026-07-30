import React, { useMemo, useRef, useState, useCallback, useEffect } from 'react';
import { Icon } from '../common/Icon';
import { useWorkspaceStore, useVFSStore, useAIStore } from '../../stores';
import { removeRecentProject, loadRecentProjects, loadWorkspaceSnapshot } from '../../lib/persistence';
import { Mark } from '../common/Mark';

interface RecentProject {
  id: string;
  name: string;
  target: string;
  lastModified: string;
}

interface DashboardProps {
  onNewProject: (templateId?: string) => void;
  onImportProject?: (file: File) => void;
  onLoadRecent?: () => void;
  recentProjects?: RecentProject[];
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
    ...shadows,
  };
}

export const Dashboard: React.FC<DashboardProps> = ({ onNewProject, onImportProject, onLoadRecent, recentProjects: initialRecent = [] }) => {
  const { themePreview, setThemePreview } = useWorkspaceStore();
  const [hoveredCard, setHoveredCard] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [recentProjects, setRecentProjects] = useState(initialRecent);
  const [savedProjectName, setSavedProjectName] = useState<string | null>(() => loadWorkspaceSnapshot()?.projectName ?? null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const theme = useMemo(() => getTheme(themePreview as ThemeMode), [themePreview]);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const handleFile = useCallback((file: File) => {
    if (!file.name.endsWith('.softn') && !file.name.endsWith('.zip') && !file.name.endsWith('.json')) return;
    onImportProject?.(file);
  }, [onImportProject]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleRemoveRecent = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    // Check if the removed project is the currently loaded one before wiping stores
    const currentName = savedProjectName;
    const removedProject = recentProjects.find((p) => p.id === id);
    removeRecentProject(id);
    setRecentProjects(loadRecentProjects());
    setSavedProjectName(loadWorkspaceSnapshot()?.projectName ?? null);
    // Only reset stores if the removed project matches the current workspace
    if (removedProject && (removedProject.name === currentName || id === useWorkspaceStore.getState().projectId)) {
      useWorkspaceStore.getState().reset();
      useVFSStore.getState().reset();
      useAIStore.getState().resetSession();
    }
  }, [savedProjectName, recentProjects]);

  const m = isMobile; // shorthand

  return (
    <div style={{ ...s.root, background: theme.pageBg, color: theme.text }}>
      <div style={s.scroll}>
        <div style={{ ...s.page, padding: m ? '20px 16px 32px' : '40px 28px 60px' }}>

          {/* Header */}
          <div style={{ ...s.header, marginBottom: m ? 24 : 36 }}>
            <div style={s.headerLeft}>
              <Mark size={m ? 36 : 44} radius={m ? 10 : 12} />
              <span style={{ ...s.logoLabel, fontSize: m ? 15 : 17, color: theme.text }}>SoftN Studio</span>
            </div>
            <button
              onClick={() => setThemePreview(themePreview === 'dark' ? 'light' : 'dark')}
              style={{ ...s.themeBtn, background: theme.cardBg, borderColor: theme.border, color: theme.textSecondary }}
              title={themePreview === 'dark' ? 'Light mode' : 'Dark mode'}
            >
              <Icon name={themePreview === 'dark' ? 'sun' : 'moon'} size={16} />
            </button>
          </div>

          {/* Hero */}
          <div style={{ textAlign: m ? 'center' : 'left', marginBottom: m ? 28 : 40 }}>
            <h1 style={{ ...s.heroTitle, fontSize: m ? 26 : 40 }}>
              Build apps with AI
            </h1>
            <p style={{ ...s.heroSub, color: theme.textSecondary, fontSize: m ? 14 : 16, maxWidth: m ? 320 : 520, margin: m ? '10px auto 0' : '10px 0 0' }}>
              Describe what you want, import an existing bundle, or jump back into a recent project.
            </p>
          </div>

          {/* Action Cards */}
          <div style={{ ...s.actions, flexDirection: m ? 'column' : 'row', gap: m ? 10 : 14, marginBottom: m ? 28 : 40 }}>
            <button
              onClick={() => onNewProject()}
              onMouseEnter={() => setHoveredCard('new')}
              onMouseLeave={() => setHoveredCard(null)}
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
              onMouseEnter={() => setHoveredCard('import')}
              onMouseLeave={() => setHoveredCard(null)}
              onDrop={handleDrop}
              onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
              onDragLeave={() => setIsDragOver(false)}
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
                <span style={{ ...s.actionTitle, color: theme.text }}>Import bundle</span>
                <span style={{ ...s.actionDesc, color: theme.textSecondary }}>{m ? 'Open a .softn file' : 'Open a .softn, .zip or .json file'}</span>
              </div>
              <Icon name="chevron-right" size={16} color={theme.textDim} />
            </button>
          </div>

          {/* Recent Projects */}
          {recentProjects.length > 0 && (
            <div style={{ marginBottom: m ? 20 : 32 }}>
              <h2 style={{ ...s.sectionTitle, color: theme.textSecondary, fontSize: m ? 12 : 13, marginBottom: m ? 10 : 12 }}>
                Recent projects
              </h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {recentProjects.map((project) => {
                  const isLoadable = project.name === savedProjectName;
                  const isHovered = hoveredCard === project.id;
                  return (
                    <div
                      key={project.id}
                      onClick={isLoadable ? () => onLoadRecent?.() : undefined}
                      onMouseEnter={() => setHoveredCard(project.id)}
                      onMouseLeave={() => setHoveredCard(null)}
                      style={{
                        ...s.projectRow,
                        cursor: isLoadable ? 'pointer' : 'default',
                        background: isHovered && isLoadable ? theme.cardBgHover : theme.cardBg,
                        borderColor: isHovered && isLoadable ? theme.accent : theme.border,
                        boxShadow: isHovered && isLoadable ? theme.shadowHover : theme.shadow,
                        opacity: isLoadable ? 1 : 0.5,
                        padding: m ? '12px 14px' : '14px 18px',
                      }}
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
                      {isLoadable && (
                        <span style={{ ...s.openBadge, background: theme.accentSoft, color: theme.accent }}>Open</span>
                      )}
                      <button
                        onClick={(e) => handleRemoveRecent(project.id, e)}
                        style={{
                          ...s.removeBtn,
                          color: theme.textDim,
                          opacity: isHovered || m ? 0.7 : 0,
                        }}
                        title="Remove"
                      >
                        <Icon name="x" size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>
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
                  { step: '03', title: 'Export', desc: 'Download your app as a .softn bundle' },
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

  // Header
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  logo: {
    flexShrink: 0,
    overflow: 'hidden',
  },
  logoImg: {
    width: '100%',
    height: '100%',
    objectFit: 'cover' as const,
    display: 'block',
  },
  logoLabel: {
    fontWeight: 700,
    letterSpacing: '-0.01em',
  },
  themeBtn: {
    width: 36,
    height: 36,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: 'solid',
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'all 0.15s',
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

  // Section
  sectionTitle: {
    margin: 0,
    fontFamily: 'var(--studio-mono)',
    fontSize: 11,
    fontWeight: 500,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.16em',
  },

  // Project rows
  projectRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderStyle: 'solid',
    transition: 'all 0.15s',
    position: 'relative',
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
  },
  removeBtn: {
    width: 28,
    height: 28,
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
