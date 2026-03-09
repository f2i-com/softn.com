import React, { useMemo, useRef, useState, useCallback, useEffect } from 'react';
import { Icon } from '../common/Icon';
import { useWorkspaceStore, useVFSStore, useAIStore } from '../../stores';
import { removeRecentProject, loadRecentProjects, loadWorkspaceSnapshot } from '../../lib/persistence';

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

function getTheme(theme: ThemeMode) {
  if (theme === 'light') {
    return {
      pageBg: '#f4f7fb',
      cardBg: 'rgba(255,255,255,0.92)',
      cardBgHover: 'rgba(255,255,255,1)',
      surfaceBg: 'rgba(0,0,0,0.03)',
      text: '#111827',
      textSecondary: '#6b7280',
      textDim: '#9ca3af',
      border: 'rgba(0,0,0,0.08)',
      borderHover: 'rgba(0,0,0,0.15)',
      accent: '#2563eb',
      accentSoft: 'rgba(37,99,235,0.08)',
      accentGlow: 'rgba(37,99,235,0.12)',
      shadow: '0 1px 3px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.04)',
      shadowHover: '0 4px 12px rgba(0,0,0,0.08), 0 16px 40px rgba(0,0,0,0.06)',
    };
  }
  return {
    pageBg: '#0a0e17',
    cardBg: 'rgba(17,24,39,0.8)',
    cardBgHover: 'rgba(22,30,48,0.95)',
    surfaceBg: 'rgba(255,255,255,0.04)',
    text: '#f1f5f9',
    textSecondary: '#94a3b8',
    textDim: '#475569',
    border: 'rgba(148,163,184,0.12)',
    borderHover: 'rgba(148,163,184,0.22)',
    accent: '#38bdf8',
    accentSoft: 'rgba(56,189,248,0.08)',
    accentGlow: 'rgba(56,189,248,0.15)',
    shadow: '0 1px 3px rgba(0,0,0,0.2), 0 8px 24px rgba(0,0,0,0.15)',
    shadowHover: '0 4px 12px rgba(0,0,0,0.3), 0 16px 40px rgba(0,0,0,0.2)',
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
              <div style={{ ...s.logo, width: m ? 36 : 44, height: m ? 36 : 44, borderRadius: m ? 10 : 12 }}>
                <img src="/studio-icon.png" alt="SoftN Studio" style={{ ...s.logoImg, borderRadius: m ? 10 : 12 }} />
              </div>
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
                background: hoveredCard === 'new' ? theme.cardBgHover : theme.cardBg,
                borderColor: hoveredCard === 'new' ? theme.accent : theme.border,
                boxShadow: hoveredCard === 'new' ? theme.shadowHover : theme.shadow,
                padding: m ? '18px 16px' : '24px 22px',
              }}
            >
              <div style={{ ...s.actionIcon, background: 'linear-gradient(135deg, #0ea5e9, #2563eb)' }}>
                <Icon name="sparkles" size={20} color="#fff" />
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
              <div style={{ display: 'flex', gap: 12 }}>
                {[
                  { step: '1', title: 'Describe', desc: 'Tell AI what you want to build' },
                  { step: '2', title: 'Preview', desc: 'See the result live in the canvas' },
                  { step: '3', title: 'Export', desc: 'Download your app as a .softn bundle' },
                ].map((item) => (
                  <div key={item.step} style={{ ...s.stepCard, background: theme.cardBg, borderColor: theme.border, boxShadow: theme.shadow }}>
                    <div style={{ ...s.stepNum, background: 'linear-gradient(135deg, #0ea5e9, #2563eb)' }}>{item.step}</div>
                    <div>
                      <div style={{ ...s.stepTitle, color: theme.text }}>{item.title}</div>
                      <div style={{ ...s.stepDesc, color: theme.textSecondary }}>{item.desc}</div>
                    </div>
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
  },
  page: {
    width: '100%',
    maxWidth: 680,
    margin: '0 auto',
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
    fontWeight: 700,
    lineHeight: 1.1,
    margin: 0,
    letterSpacing: '-0.02em',
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
    fontSize: 13,
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
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
  stepCard: {
    flex: 1,
    display: 'flex',
    alignItems: 'flex-start',
    gap: 12,
    padding: '16px 18px',
    borderRadius: 14,
    borderWidth: 1,
    borderStyle: 'solid',
  },
  stepNum: {
    width: 28,
    height: 28,
    borderRadius: 999,
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 13,
    fontWeight: 700,
    flexShrink: 0,
  },
  stepTitle: {
    fontSize: 14,
    fontWeight: 700,
    marginBottom: 2,
  },
  stepDesc: {
    fontSize: 12,
    lineHeight: 1.5,
  },
};
