import React, { useState, useCallback, useEffect } from 'react';
import { useWorkspaceStore, useVFSStore, useAIStore } from './stores';
import { unzipSync } from 'fflate';
import { TopBar } from './components/toolbar/TopBar';
import { LeftRail } from './components/layout/LeftRail';
import { VisualCanvas } from './components/canvas/VisualCanvas';
import { Inspector } from './components/inspector/Inspector';
import { BottomDrawer } from './components/layout/BottomDrawer';
import { StatusBar } from './components/layout/StatusBar';
import { Icon } from './components/common/Icon';
import { Dashboard } from './components/layout/Dashboard';
import { BriefWizard } from './components/brief/BriefWizard';
import { AIChat } from './components/ai/AIChat';
import { ComponentPalette } from './components/panels/ComponentPalette';
import { PagesPanel } from './components/panels/PagesPanel';
import { DataPanel } from './components/panels/DataPanel';
import { LogicPanel } from './components/panels/LogicPanel';
import { AssetsPanel } from './components/panels/AssetsPanel';
import { HistoryPanel } from './components/panels/HistoryPanel';
import { SettingsPanel } from './components/panels/SettingsPanel';
import { FilesPanel } from './components/panels/FilesPanel';
import { inferBlueprintFromFiles, inferBriefFromBlueprint, generateTaskGraph } from './lib/studioProject';
import { validateProject } from './lib/validator';
import { loadAISnapshot, loadRecentProjects, loadVFSSnapshot, loadWorkspaceSnapshot, saveAISnapshot, saveRecentProject, saveVFSSnapshot, saveWorkspaceSnapshot, decodePersistedVFS } from './lib/persistence';
import { BlueprintReview } from './components/blueprint/BlueprintReview';


type View = 'dashboard' | 'brief' | 'editor';

function getStudioThemeVars(theme: 'light' | 'dark'): React.CSSProperties {
  if (theme === 'light') {
    return {
      '--studio-bg': '#f0f5fc',
      '--studio-bg-elevated': '#f8fafb',
      '--studio-bg-muted': '#e8eef6',
      '--studio-panel': 'rgba(255,255,255,0.88)',
      '--studio-panel-strong': '#ffffff',
      '--studio-border': 'rgba(0,0,0,0.09)',
      '--studio-border-strong': 'rgba(0,0,0,0.15)',
      '--studio-border-subtle': 'rgba(0,0,0,0.04)',
      '--studio-text': '#1a2332',
      '--studio-text-muted': '#5b6b80',
      '--studio-text-dim': '#94a3b8',
      '--studio-accent': '#2563eb',
      '--studio-accent-soft': 'rgba(37,99,235,0.1)',
      '--studio-shadow': '0 20px 40px rgba(0,0,0,0.06)',
      '--studio-surface': 'rgba(0,0,0,0.03)',
      '--studio-surface-hover': 'rgba(0,0,0,0.06)',
      '--studio-inset': 'rgba(0,0,0,0.04)',
      '--studio-overlay': 'rgba(0,0,0,0.4)',
      '--studio-success': '#16a34a',
      '--studio-error': '#dc2626',
      '--studio-warning': '#d97706',
    } as React.CSSProperties;
  }

  return {
    '--studio-bg': '#09090b',
    '--studio-bg-elevated': '#0b1220',
    '--studio-bg-muted': '#0f1723',
    '--studio-panel': 'rgba(15,23,42,0.82)',
    '--studio-panel-strong': '#101723',
    '--studio-border': 'rgba(148,163,184,0.14)',
    '--studio-border-strong': 'rgba(148,163,184,0.2)',
    '--studio-border-subtle': 'rgba(255,255,255,0.04)',
    '--studio-text': '#f8fafc',
    '--studio-text-muted': '#94a3b8',
    '--studio-text-dim': '#52525b',
    '--studio-accent': '#38bdf8',
    '--studio-accent-soft': 'rgba(56,189,248,0.12)',
    '--studio-shadow': '0 18px 40px rgba(2,6,23,0.24)',
    '--studio-surface': 'rgba(255,255,255,0.04)',
    '--studio-surface-hover': 'rgba(255,255,255,0.08)',
    '--studio-inset': 'rgba(15,23,42,0.72)',
    '--studio-overlay': 'rgba(2,6,23,0.74)',
    '--studio-success': '#4ade80',
    '--studio-error': '#f87171',
    '--studio-warning': '#fbbf24',
  } as React.CSSProperties;
}

const App: React.FC = () => {
  const [view, setView] = useState<View>('dashboard');
  const [isHydrated, setIsHydrated] = useState(false);
  const {
    leftPanel,
    rightSidebarOpen,
    advancedMode,
    projectName,
    blueprint,
    blueprintApproved,
    themePreview,
  } = useWorkspaceStore();
  const { files } = useVFSStore();
  const [isMobile, setIsMobile] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<'chat' | 'canvas' | 'inspector'>('canvas');
  const [recentProjects, setRecentProjects] = useState(loadRecentProjects());

  // Responsive detection
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const handleNewProject = useCallback(() => {
    const currentTheme = useWorkspaceStore.getState().themePreview;
    useWorkspaceStore.getState().reset();
    useWorkspaceStore.getState().setThemePreview(currentTheme);
    useVFSStore.getState().reset();
    useAIStore.getState().resetSession();
    setView('brief');
  }, []);

  const hydrateFromStorage = useCallback(() => {
    const workspaceSnapshot = loadWorkspaceSnapshot();
    const aiSnapshot = loadAISnapshot();
    const vfsSnapshot = loadVFSSnapshot();

    if (workspaceSnapshot?.projectName) {
      useWorkspaceStore.setState({
        projectName: workspaceSnapshot.projectName,
        projectId: workspaceSnapshot.projectId,
        brief: workspaceSnapshot.brief ? { ...workspaceSnapshot.brief, referenceImages: [] } : null,
        blueprint: workspaceSnapshot.blueprint,
        taskGraph: workspaceSnapshot.taskGraph,
        blueprintApproved: workspaceSnapshot.blueprintApproved,
        mode: workspaceSnapshot.mode as never,
        leftPanel: workspaceSnapshot.leftPanel as never,
        leftPanelExpanded: workspaceSnapshot.leftPanelExpanded,
        rightSidebarOpen: workspaceSnapshot.rightSidebarOpen,
        bottomDrawerOpen: workspaceSnapshot.bottomDrawerOpen,
        bottomTab: workspaceSnapshot.bottomTab as never,
        advancedMode: workspaceSnapshot.advancedMode,
        activePageId: workspaceSnapshot.activePageId,
        activeFilePath: workspaceSnapshot.activeFilePath,
        selectedComponentId: workspaceSnapshot.selectedComponentId,
        devicePreset: workspaceSnapshot.devicePreset as never,
        zoom: workspaceSnapshot.zoom,
        themePreview: workspaceSnapshot.themePreview,
        consoleOutput: workspaceSnapshot.consoleOutput,
      });
    }

    if (aiSnapshot) {
      useAIStore.setState({
        providers: aiSnapshot.providers,
        activeProviderId: aiSnapshot.activeProviderId,
        modelProfile: aiSnapshot.modelProfile,
        messages: aiSnapshot.messages,
        iterationsUsed: aiSnapshot.iterationsUsed,
        maxIterations: aiSnapshot.maxIterations,
        tokensUsed: aiSnapshot.tokensUsed,
        tokenBudget: aiSnapshot.tokenBudget,
        filesChanged: aiSnapshot.filesChanged,
      });
    }

    if (vfsSnapshot) {
      useVFSStore.getState().reset();
      useVFSStore.getState().batchCreateFiles(decodePersistedVFS(vfsSnapshot), 'user');
    }

    return !!workspaceSnapshot?.projectName;
  }, []);

  useEffect(() => {
    if (hydrateFromStorage()) {
      setView('editor');
    }
    setIsHydrated(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleBackToDashboard = useCallback(() => {
    setView('dashboard');
  }, []);

  const handleImportProject = useCallback(async (file: File) => {
    try {
    const buffer = await file.arrayBuffer();
    const data = new Uint8Array(buffer);
    const vfs = useVFSStore.getState();
    const ws = useWorkspaceStore.getState();
    const decoder = new TextDecoder();

    // Reset VFS before import
    vfs.reset();

    const batch: Array<{ path: string; content: string | Uint8Array }> = [];

    // Try as ZIP first
    try {
      const entries = unzipSync(data);
      const entryList = Object.entries(entries);
      console.log(`[SoftN Import] ZIP parsed OK, ${entryList.length} entries`);
      for (const [fileName, content] of entryList) {
        if (fileName.endsWith('/')) continue; // skip directories
        // Normalize path separators and strip leading slash
        const path = fileName.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\//, '');
        if (!path || path.includes('..')) continue;
        const isText = /\.(ui|logic|json|xdb|md|txt|html|css|js|ts|tsx|jsx|svg|xml|yaml|yml|toml)$/i.test(path);
        batch.push({
          path,
          content: isText ? decoder.decode(content) : content,
        });
      }
    } catch (err) {
      console.log('[SoftN Import] Not a valid ZIP, trying fallback...', err);
    }

    // Fallback: load as single file
    if (batch.length === 0) {
      const text = decoder.decode(data);
      // Try as JSON project manifest
      try {
        const manifest = JSON.parse(text);
        if (manifest.files && typeof manifest.files === 'object') {
          for (const [path, content] of Object.entries(manifest.files)) {
            batch.push({ path, content: String(content) });
          }
          console.log(`[SoftN Import] JSON manifest parsed, ${batch.length} files`);
        }
      } catch {
        // Not JSON either
      }
      // Last resort: single file
      if (batch.length === 0) {
        batch.push({ path: file.name, content: text });
        console.log('[SoftN Import] Loaded as single file');
      }
    }

    // Batch-create all files in a single state update
    if (batch.length > 0) {
      vfs.batchCreateFiles(batch, 'user');
      console.log(`[SoftN Import] ${batch.length} files added to VFS`);
    }

    ws.setProjectName(file.name.replace(/\.(softn|zip|json)$/, ''));
    const inferredBlueprint = inferBlueprintFromFiles(file.name.replace(/\.(softn|zip|json)$/, ''), vfs.getSnapshot());
    const inferredBrief = inferBriefFromBlueprint(inferredBlueprint);
    ws.setBrief(inferredBrief);
    ws.setBlueprint(inferredBlueprint);
    ws.setBlueprintApproved(true);
    ws.setTaskGraph(generateTaskGraph(inferredBlueprint));
    ws.setActivePage(inferredBlueprint.pages[0]?.id ?? null);
    // Open AI first so imported bundles are ready for AI-guided editing
    ws.setLeftPanel('ai');
    ws.setMode('design');
    // Log to console output for user visibility
    ws.addConsoleOutput(`Imported ${batch.length} file(s) from ${file.name}`);
    for (const entry of batch.slice(0, 10)) {
      ws.addConsoleOutput(`  + ${entry.path}`);
    }
    if (batch.length > 10) {
      ws.addConsoleOutput(`  ... and ${batch.length - 10} more`);
    }
    useAIStore.getState().resetSession();
    useAIStore.getState().addMessage({
      id: crypto.randomUUID(),
      role: 'assistant',
      content: `Imported \`${file.name}\` and mapped ${inferredBlueprint.pages.length} page(s). Ask me to restyle screens, reorganize flows, improve data bindings, or prepare the bundle for export.`,
      timestamp: Date.now(),
    });
    const recent = {
      id: crypto.randomUUID(),
      name: file.name.replace(/\.(softn|zip|json)$/, ''),
      target: inferredBlueprint.target,
      lastModified: new Date().toLocaleString(),
    };
    saveRecentProject(recent);
    setRecentProjects(loadRecentProjects());
    setView('editor');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      useWorkspaceStore.getState().addConsoleOutput(`Import failed: ${msg}`);
      console.error('[SoftN Import] Failed:', err);
    }
  }, []);


  // Persist workspace state whenever it changes (subscription catches all fields)
  useEffect(() => {
    if (!isHydrated) return;
    const unsub = useWorkspaceStore.subscribe(() => {
      const ws = useWorkspaceStore.getState();
      const persistedBrief = ws.brief
        ? (({ referenceImages, ...rest }) => rest)(ws.brief)
        : null;
      saveWorkspaceSnapshot({
        projectName: ws.projectName,
        projectId: ws.projectId,
        brief: persistedBrief,
        blueprint: ws.blueprint,
        taskGraph: ws.taskGraph,
        blueprintApproved: ws.blueprintApproved,
        mode: ws.mode,
        leftPanel: ws.leftPanel,
        leftPanelExpanded: ws.leftPanelExpanded,
        rightSidebarOpen: ws.rightSidebarOpen,
        bottomDrawerOpen: ws.bottomDrawerOpen,
        bottomTab: ws.bottomTab,
        advancedMode: ws.advancedMode,
        activePageId: ws.activePageId,
        activeFilePath: ws.activeFilePath,
        selectedComponentId: ws.selectedComponentId,
        devicePreset: ws.devicePreset,
        zoom: ws.zoom,
        themePreview: ws.themePreview,
        consoleOutput: ws.consoleOutput,
      });
    });
    return unsub;
  }, [isHydrated]);

  // Persist AI state whenever it changes (messages, tokens, etc.)
  useEffect(() => {
    if (!isHydrated) return;
    const unsub = useAIStore.subscribe(() => {
      const ai = useAIStore.getState();
      // Skip saving during active agent turns to avoid excessive writes
      if (ai.agentState === 'building') return;
      saveAISnapshot({
        providers: ai.providers,
        activeProviderId: ai.activeProviderId,
        modelProfile: ai.modelProfile,
        messages: ai.messages,
        iterationsUsed: ai.iterationsUsed,
        maxIterations: ai.maxIterations,
        tokensUsed: ai.tokensUsed,
        tokenBudget: ai.tokenBudget,
        filesChanged: ai.filesChanged,
      });
    });
    return unsub;
  }, [isHydrated]);

  useEffect(() => {
    if (!isHydrated) return;
    saveVFSSnapshot(files);
  }, [isHydrated, files]);

  // Run validation when files or blueprint change
  useEffect(() => {
    if (!isHydrated || files.size === 0) return;
    const ws = useWorkspaceStore.getState();
    const validationErrors = validateProject(files, ws.blueprint);
    ws.clearErrors();
    for (const err of validationErrors) {
      ws.addError(err);
    }
  }, [isHydrated, files, blueprint]);

  useEffect(() => {
    if (!isHydrated) return;
    if (!projectName || !blueprint) return;
    saveRecentProject({
      id: useWorkspaceStore.getState().projectId || projectName,
      name: projectName,
      target: blueprint.target,
      lastModified: new Date().toLocaleString(),
    });
    setRecentProjects(loadRecentProjects());
  }, [isHydrated, projectName, blueprint]);

  const renderLeftPanelContent = () => {
    switch (leftPanel) {
      case 'ai': return <AIChat />;
      case 'components': return <ComponentPalette />;
      case 'pages': return <PagesPanel />;
      case 'data': return <DataPanel />;
      case 'logic': return <LogicPanel />;
      case 'assets': return <AssetsPanel />;
      case 'history': return <HistoryPanel />;
      case 'settings': return <SettingsPanel />;
      case 'files': return <FilesPanel />;
      default: return null;
    }
  };

  // Dashboard
  if (view === 'dashboard') {
    return (
      <Dashboard
        onNewProject={handleNewProject}
        onImportProject={handleImportProject}
        onLoadRecent={() => setView('editor')}
        recentProjects={recentProjects}
      />
    );
  }

  // Brief wizard (inline, full-page) — wrapped in theme vars
  if (view === 'brief') {
    return (
      <div style={{ ...styles.root, ...getStudioThemeVars(themePreview) }}>
        <BriefWizard onBack={handleBackToDashboard} onSubmit={() => setView('editor')} />
      </div>
    );
  }

  // Mobile editor
  if (isMobile) {
    return (
      <div style={{ ...styles.mobileRoot, ...getStudioThemeVars(themePreview) }}>
        {/* Compact mobile top bar */}
        <div style={styles.mobileTopBar}>
          <div style={styles.mobileTopLeft}>
            <button onClick={handleBackToDashboard} style={styles.mobileBackBtn} title="Back to home">
              <Icon name="chevron-left" size={20} />
            </button>
            <span style={styles.mobileProjectName}>
              {projectName || 'SoftN Studio'}
            </span>
          </div>
          <div style={styles.mobileTopRight}>
            <div style={styles.mobileStatusDot} />
          </div>
        </div>

        <div style={styles.mobileContent}>
          {mobilePanel === 'chat' && (
            <div style={styles.mobilePanel}>
              <AIChat />
            </div>
          )}
          {mobilePanel === 'canvas' && (
            <div style={styles.mobilePanel}>
              <VisualCanvas onStartBrief={handleNewProject} />
            </div>
          )}
          {mobilePanel === 'inspector' && (
            <div style={styles.mobilePanel}>
              <SettingsPanel />
            </div>
          )}
        </div>
        <div style={styles.mobileNav}>
          {[
            { id: 'chat' as const, label: 'AI Chat', icon: 'ai' as const },
            { id: 'canvas' as const, label: 'Preview', icon: 'eye' as const },
            { id: 'inspector' as const, label: 'Settings', icon: 'settings' as const },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setMobilePanel(tab.id)}
              style={{
                ...styles.mobileNavBtn,
                ...(mobilePanel === tab.id ? styles.mobileNavBtnActive : {}),
              }}
            >
              <Icon name={tab.icon} size={20} color={mobilePanel === tab.id ? 'var(--studio-accent)' : 'var(--studio-text-dim)'} />
              <span style={styles.mobileNavLabel}>{tab.label}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // Desktop editor
  return (
    <div style={{ ...styles.root, ...getStudioThemeVars(themePreview) }}>
      <TopBar onBackToDashboard={handleBackToDashboard} />
      <div style={styles.main}>
        <LeftRail>{renderLeftPanelContent()}</LeftRail>
        <div style={styles.centerColumn}>
          <VisualCanvas onStartBrief={handleNewProject} />
          <BottomDrawer />
        </div>
        {advancedMode && rightSidebarOpen && leftPanel !== 'ai' && <Inspector />}
      </div>
      <StatusBar />
      {!blueprintApproved && blueprint && view === 'editor' && (
        <BlueprintReview
          onApprove={() => useWorkspaceStore.getState().setMode('design')}
          onReviseBrief={() => setView('brief')}
        />
      )}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    overflow: 'hidden',
    background: 'var(--studio-bg)',
    color: 'var(--studio-text)',
  },
  main: {
    display: 'flex',
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
  centerColumn: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    overflow: 'hidden',
  },

  // Mobile
  mobileRoot: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    overflow: 'hidden',
    background: 'var(--studio-bg)',
    color: 'var(--studio-text)',
  },
  mobileTopBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 44,
    padding: '0 12px',
    borderBottom: '1px solid var(--studio-border)',
    background: 'var(--studio-bg-elevated)',
    flexShrink: 0,
  },
  mobileTopLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    overflow: 'hidden',
  },
  mobileBackBtn: {
    width: 32,
    height: 32,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    background: 'transparent',
    color: 'var(--studio-text-muted)',
    borderRadius: 8,
    cursor: 'pointer',
    flexShrink: 0,
    fontFamily: 'inherit',
  },
  mobileProjectName: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--studio-text)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  mobileTopRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  mobileStatusDot: {
    width: 7,
    height: 7,
    borderRadius: '50%',
    background: 'var(--studio-success)',
  },
  mobileContent: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    overflow: 'hidden',
  },
  mobilePanel: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    overflow: 'hidden',
  },
  mobileNav: {
    display: 'flex',
    borderTop: '1px solid var(--studio-border)',
    background: 'var(--studio-bg-elevated)',
    flexShrink: 0,
    paddingBottom: 'env(safe-area-inset-bottom, 0px)',
  },
  mobileNavBtn: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 3,
    padding: '10px 0 8px',
    border: 'none',
    background: 'transparent',
    color: 'var(--studio-text-dim)',
    cursor: 'pointer',
    position: 'relative',
    fontFamily: 'inherit',
    transition: 'color 0.15s',
  },
  mobileNavBtnActive: {
    color: 'var(--studio-accent)',
    background: 'var(--studio-accent-soft)',
  },
  mobileNavLabel: {
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: '0.2px',
  },
};

export default App;
