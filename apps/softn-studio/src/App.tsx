import React, { useState, useCallback, useEffect, useRef } from 'react';
import { ProductBar, currentTheme, subscribeTheme } from '@softn/brand';
import { useWorkspaceStore, useVFSStore, useAIStore } from './stores';
import { TopBar } from './components/toolbar/TopBar';
import { LeftRail } from './components/layout/LeftRail';
import { VisualCanvas } from './components/canvas/VisualCanvas';
import { BottomDrawer } from './components/layout/BottomDrawer';
import { StatusBar } from './components/layout/StatusBar';
import { Icon } from './components/common/Icon';
import { Dashboard, type DashboardOutcome, type RecentEntry } from './components/layout/Dashboard';
import { BriefWizard } from './components/brief/BriefWizard';
import { AIChat } from './components/ai/AIChat';
import { ProviderSetupDialog } from './components/ai/ProviderSetupDialog';
import { needsProviderSetup } from './components/ai/AIStatusPill';
import { PagesPanel } from './components/panels/PagesPanel';
import { HistoryPanel } from './components/panels/HistoryPanel';
import { SettingsPanel } from './components/panels/SettingsPanel';
import { FilesPanel } from './components/panels/FilesPanel';
import { MobileProjectMenu } from './components/mobile/MobileProjectMenu';
import { SaveStatusIndicator } from './components/common/SaveStatus';
import { exportCurrentProject } from './components/common/ProjectActions';
import {
  inferBlueprintFromFiles,
  inferBriefFromBlueprint,
  generateTaskGraph,
  projectLogicLanguage,
} from './lib/studioProject';
import { validateProject } from './lib/validator';
import { openExampleInStores, type ExampleProject } from './examples';
import { abortAgentTurn } from './lib/agentOrchestrator';
import { buildFromBrief } from './lib/agent/buildFromBrief';
import { reportAgentStatusToHost, startRunFromBrief } from './lib/agent/hostedAgent';
import { rememberAppliedMigrations } from './lib/agent/appliedMigrations';
import { exportAsBundle, buildBundle } from './lib/exportBundle';
import { connectHostedEditor, isHostedEditor } from '@softn/editor-shared/hostedEditor';
import {
  listProjectSummaries,
  loadProjectRecord,
  loadRecentProjects,
  recordFilesAsMap,
  removeRecentProject,
} from './lib/persistence';
import { BlueprintReview } from './components/blueprint/BlueprintReview';
import {
  hasZipSignature,
  normalizeProjectPath,
  readJsonProject,
  readProjectArchive,
  readProjectFile,
} from './lib/projectImport';
import {
  beginNewProjectSession,
  claimWorkspace,
  deleteProject,
  hasProjectContent,
  openProjectById,
  openRemoteBundle,
  ownsWorkspace,
  readOpenLink,
  releaseWorkspace,
  resetProjectSessionForImport,
  restoreSession,
  startProjectAutosave,
  type AutosaveController,
} from './lib/projectSession';

type View = 'dashboard' | 'brief' | 'editor';

const App: React.FC = () => {
  const [view, setView] = useState<View>('dashboard');
  const [isHydrated, setIsHydrated] = useState(false);
  const {
    leftPanel,
    projectName,
    blueprint,
    blueprintApproved,
  } = useWorkspaceStore();
  const { files } = useVFSStore();
  const providerCount = useAIStore((s) => s.providers.length);
  const setupSkipped = useAIStore((s) => s.setupSkipped);
  const [isMobile, setIsMobile] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<'chat' | 'canvas' | 'settings'>('canvas');
  const [recentProjects, setRecentProjects] = useState<RecentEntry[]>([]);
  const autosaveRef = useRef<AutosaveController | null>(null);
  /** The `?open=` link read once on first mount; `undefined` until read. */
  const openLinkRef = useRef<ReturnType<typeof readOpenLink> | undefined>(undefined);

  // Responsive detection
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // The theme is the one every SoftN app shares — chosen in the product bar
  // here or anywhere else, remembered under one key, and read by the script
  // that painted the ground before this code ran. Studio's own tokens follow
  // it rather than keeping a preference of their own.
  useEffect(() => {
    useWorkspaceStore.getState().setThemePreview(currentTheme());
    return subscribeTheme((next) => useWorkspaceStore.getState().setThemePreview(next));
  }, []);

  /**
   * The dashboard's list: the recent entries, each marked with whether a
   * record for it is in project storage, plus the project in memory if it
   * has content and is not listed yet — it is always reachable from here.
   * An entry with no record and not in memory is shown as "No saved copy":
   * the old list kept names whose only copy was overwritten long ago, and
   * saying so beats pretending.
   */
  const refreshRecent = useCallback(async () => {
    const list = loadRecentProjects();
    const summaries = await listProjectSummaries();
    const saved = new Set(summaries.map((summary) => summary.projectId));
    const ws = useWorkspaceStore.getState();
    const activeId = ws.projectId && hasProjectContent() ? ws.projectId : null;
    const entries: RecentEntry[] = list.map((entry) => ({ ...entry, saved: saved.has(entry.id), active: entry.id === activeId }));
    if (activeId && !entries.some((entry) => entry.id === activeId)) {
      entries.unshift({
        id: activeId,
        name: ws.projectName || 'Untitled app',
        target: ws.blueprint?.target ?? 'web',
        lastModified: 'in memory',
        saved: saved.has(activeId),
        active: true,
      });
    }
    setRecentProjects(entries);
  }, []);

  /**
   * Before the stores are given to another project, write this one. The
   * record is its own, under its own id, so nothing here can overwrite
   * another project — but a write that fails leaves the in-memory copy as
   * the only one, and replacing that silently is what the old single slot
   * did. So the person is asked, and told that Export bundle keeps it.
   * Resolves with whether to go on.
   */
  const checkpointBeforeReplace = useCallback(async (): Promise<boolean> => {
    const autosave = autosaveRef.current;
    if (!autosave || !hasProjectContent()) return true;
    const result = await autosave.flush();
    if (result.ok) return true;
    const name = useWorkspaceStore.getState().projectName || 'The current project';
    return window.confirm(
      `${name} could not be saved to this browser: ${result.message}\n\nContinue anyway and leave it unsaved? Press Cancel to go back and use Export bundle first.`,
    );
  }, []);

  const handleNewProject = useCallback(async () => {
    // A generation still running would finish against the project that replaces
    // this one and write its files there. agentOrchestrator already treats an
    // AbortError as "stop quietly", so nothing is written and no error is shown.
    const claim = claimWorkspace();
    abortAgentTurn();
    if (!(await checkpointBeforeReplace())) return;
    if (!ownsWorkspace(claim.generation)) return;
    beginNewProjectSession();
    setView('brief');
  }, [checkpointBeforeReplace]);

  /**
   * Open a bundled example as a new project: the same ownership and
   * checkpoint steps as an import, without the decode, since the files
   * are already here.
   */
  const handleOpenExample = useCallback(async (example?: ExampleProject) => {
    const claim = claimWorkspace();
    abortAgentTurn();
    if (!(await checkpointBeforeReplace())) return;
    if (!ownsWorkspace(claim.generation)) return;
    openExampleInStores(example);
    setView('editor');
    void refreshRecent();
  }, [checkpointBeforeReplace, refreshRecent]);

  const handleBackToDashboard = useCallback(() => {
    abortAgentTurn();
    void (autosaveRef.current?.flush() ?? Promise.resolve()).then(() => refreshRecent());
    setView('dashboard');
  }, [refreshRecent]);

  /**
   * Import a bundle as a new project. `owner` is the workspace generation an
   * earlier step (the remote open) already claimed; without it this claims
   * one itself. Ownership is checked after every await and once more right
   * before the stores are touched, so a result that arrives after something
   * else took the workspace is dropped, and dropped quietly.
   */
  const handleImportProject = useCallback(async (file: File, owner?: number): Promise<DashboardOutcome> => {
    const generation = owner ?? claimWorkspace().generation;
    abortAgentTurn();
    try {
      if (!(await checkpointBeforeReplace())) return { ok: false, message: 'The current project was kept open.' };
      if (!ownsWorkspace(generation)) return { ok: true };
      const data = await readProjectFile(file);
      // A second selection (or starting a new project) owns the workspace now.
      // File.arrayBuffer cannot be aborted, so discard the older read here.
      if (!ownsWorkspace(generation)) return { ok: true };
      const decoder = new TextDecoder();

      const batch: Array<{ path: string; content: string | Uint8Array }> = [];
      /** Whether the bytes were a readable archive, regardless of what was in it. */
      let zipParsed = false;

      // Try as ZIP first. The shared reader verifies sizes and checksums before
      // allocating entry buffers, so a small archive cannot inflate without a
      // bound just because it was opened in Studio rather than the runtime.
      try {
        const entryList = readProjectArchive(data);
        batch.push(...entryList);
        zipParsed = true;
      } catch (err) {
        // A damaged/unsafe archive is not a plain text project. Falling through
        // used to decode its bytes into a single gibberish file and, because the
        // VFS had already been reset, destroy the project the user had open.
        if (hasZipSignature(data) || /\.(softn|zip)$/i.test(file.name)) {
          throw err;
        }
      }

      // Fallback: load as single file — only when this was NOT a ZIP.
      //
      // A ZIP that parsed and held nothing used to fall through to here, so a
      // 22-byte empty archive became a "file" whose content was the raw archive
      // bytes, named after the bundle. The project opened with one unreadable
      // file in it and nothing said the bundle was empty.
      if (batch.length === 0 && zipParsed) {
        throw new Error(`${file.name} is a valid bundle but contains no files.`);
      } else if (batch.length === 0) {
        const text = decoder.decode(data);
        // Try as JSON project manifest. Unsafe paths and non-string file values
        // are ignored instead of becoming aliases or "[object Object]" files.
        batch.push(...readJsonProject(text));
        // Last resort: single file
        if (batch.length === 0) {
          const fallbackPath = normalizeProjectPath(file.name) ?? 'imported.txt';
          batch.push({ path: fallbackPath, content: text });
        }
      }

      // Commit only after the complete import has been decoded and validated,
      // so any failure above leaves the current project intact — and only if
      // nothing took the workspace while the decode ran.
      if (!ownsWorkspace(generation)) return { ok: true };
      resetProjectSessionForImport();
      useVFSStore.getState().batchCreateFiles(batch, 'user');

      const importedProjectName = file.name.replace(/\.(softn|zip|json)$/i, '');
      const importedWorkspace = useWorkspaceStore.getState();
      const importedVFS = useVFSStore.getState();
      importedWorkspace.setProjectName(importedProjectName);
      const importedSnapshot = importedVFS.getSnapshot();
      const inferredBlueprint = inferBlueprintFromFiles(importedProjectName, importedSnapshot);
      const inferredBrief = inferBriefFromBlueprint(inferredBlueprint, projectLogicLanguage(importedSnapshot));
      importedWorkspace.setBrief(inferredBrief);
      importedWorkspace.setBlueprint(inferredBlueprint);
      importedWorkspace.setBlueprintApproved(true);
      importedWorkspace.setTaskGraph(generateTaskGraph(inferredBlueprint));
      importedWorkspace.setActivePage(inferredBlueprint.pages[0]?.id ?? null);
      // Open AI first so imported bundles are ready for AI-guided editing
      importedWorkspace.setLeftPanel('ai');
      importedWorkspace.setMode('design');
      // Log to console output for user visibility
      importedWorkspace.addConsoleOutput(`Imported ${batch.length} file(s) from ${file.name}`);
      for (const entry of batch.slice(0, 10)) {
        importedWorkspace.addConsoleOutput(`  + ${entry.path}`);
      }
      if (batch.length > 10) {
        importedWorkspace.addConsoleOutput(`  ... and ${batch.length - 10} more`);
      }
      useAIStore.getState().addMessage({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `Imported \`${file.name}\` and mapped ${inferredBlueprint.pages.length} page(s). Ask me to restyle screens, reorganize flows, improve data bindings, or prepare the bundle for export.`,
        timestamp: Date.now(),
      });
      setView('editor');
      void refreshRecent();
      return { ok: true };
    } catch (err) {
      if (!ownsWorkspace(generation)) return { ok: true };
      const msg = err instanceof Error ? err.message : String(err);
      useWorkspaceStore.getState().addConsoleOutput(`Import failed: ${msg}`);
      return { ok: false, message: msg };
    }
  }, [checkpointBeforeReplace, refreshRecent]);

  const handleImportProjectRef = useRef(handleImportProject);
  handleImportProjectRef.current = handleImportProject;
  useEffect(() => {
    if (!isHostedEditor()) return;
    const disconnect = connectHostedEditor({
      open: async (bytes, name, { brief }) => {
        const result = await handleImportProjectRef.current(new File([new Uint8Array(bytes)], `${name}.softn`, { type: 'application/zip' }));
        if (!result.ok) throw new Error(result.message);
        // The host installed this project: every migration it came with has run on its database.
        rememberAppliedMigrations(useVFSStore.getState().files);
        useAIStore.setState({ providers: [{ id: 'formlogic', type: 'custom', name: 'FormLogic AI', apiKey: '', modelId: 'FormLogic default' }], activeProviderId: 'formlogic', modelProfile: { architect: 'FormLogic default', builder: 'FormLogic default', repair: 'FormLogic default', vision: 'FormLogic default' } });
        // The host brought the person here to have the agent carry out a request: start it
        // once the open is answered, so the host is not kept waiting for the whole run.
        if (brief) setTimeout(() => { void startRunFromBrief(brief); }, 0);
      },
      export: () => {
        if (useAIStore.getState().agentState === 'building') throw new Error('Wait for the AI to finish, or stop generating before reviewing changes.');
        return buildBundle(useVFSStore.getState().getSnapshot());
      },
    }, { agentRuns: true });
    const stopReporting = reportAgentStatusToHost();
    return () => { stopReporting(); disconnect(); };
  }, []);

  /**
   * Boot, in one sequence so the order is the same every time:
   *
   *   1. restoreSession — the settings, then the record the active-project
   *      pointer names, else the migrated legacy snapshot, else nothing.
   *   2. then, and only then, the `?open=` link — as a *new* project. It
   *      never replaces what was restored; that project keeps its own
   *      record, and the current one is checkpointed before the import
   *      commits. Anything the person does meanwhile (new project, import,
   *      open from the list) takes the workspace and the link's result is
   *      dropped without a message.
   *
   * The link is read once and taken out of the address bar so a reload does
   * not import it over edited work; it is kept in a ref so StrictMode's
   * second run of this effect still has it. Unmounting releases the
   * workspace: an open still in flight is aborted and stays silent.
   */
  useEffect(() => {
    let cancelled = false;
    if (isHostedEditor()) { setIsHydrated(true); return () => { releaseWorkspace(); abortAgentTurn(); }; }
    if (openLinkRef.current === undefined) {
      openLinkRef.current = readOpenLink(window.location.search, window.location.origin);
      if (openLinkRef.current) {
        const params = new URLSearchParams(window.location.search);
        params.delete('open');
        const rest = params.toString();
        window.history.replaceState({}, '', window.location.pathname + (rest ? `?${rest}` : ''));
      }
    }
    void (async () => {
      const outcome = await restoreSession();
      if (cancelled) return;
      if (outcome.restored) setView('editor');
      if (outcome.notice) useWorkspaceStore.getState().addConsoleOutput(outcome.notice);
      setIsHydrated(true);
      void refreshRecent();
      const link = openLinkRef.current;
      if (!link) return;
      const log = useWorkspaceStore.getState().addConsoleOutput;
      if ('error' in link) {
        log(link.error);
        return;
      }
      await openRemoteBundle(link.url, {
        importFile: async (file, generation) => {
          const outcome = await handleImportProjectRef.current(file, generation);
          if (!outcome.ok) throw new Error(outcome.message);
        },
        log,
      });
    })();
    return () => {
      cancelled = true;
      releaseWorkspace();
      abortAgentTurn();
    };
  }, [refreshRecent]);

  // Save project: one record per project, written after changes settle. The
  // controller reports through the save status the bars show. Leaving the
  // page flushes what is pending so the last checkpoint is not lost to the
  // debounce.
  useEffect(() => {
    if (!isHydrated || isHostedEditor()) return;
    const controller = startProjectAutosave();
    autosaveRef.current = controller;
    const flush = () => void controller.flush();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      controller.stop();
      if (autosaveRef.current === controller) autosaveRef.current = null;
    };
  }, [isHydrated]);

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

  // --- Dashboard actions, each about one project id -------------------------

  const handleOpenRecent = useCallback(async (id: string): Promise<DashboardOutcome> => {
    const ws = useWorkspaceStore.getState();
    if (ws.projectId === id && hasProjectContent()) {
      // The copy in memory is the newest there is; nothing to read.
      claimWorkspace();
      setView('editor');
      return { ok: true };
    }
    abortAgentTurn();
    const outcome = await openProjectById(id, checkpointBeforeReplace);
    if (outcome.ok) {
      setView('editor');
      void refreshRecent();
    }
    return outcome;
  }, [checkpointBeforeReplace, refreshRecent]);

  const handleRemoveRecent = useCallback((id: string) => {
    removeRecentProject(id);
    void refreshRecent();
  }, [refreshRecent]);

  const handleDeleteProject = useCallback(async (id: string): Promise<DashboardOutcome> => {
    const outcome = await deleteProject(id);
    void refreshRecent();
    return outcome;
  }, [refreshRecent]);

  const handleExportProject = useCallback(async (id: string): Promise<DashboardOutcome> => {
    const ws = useWorkspaceStore.getState();
    if (ws.projectId === id && hasProjectContent()) return exportCurrentProject();
    const record = await loadProjectRecord(id);
    if (!record) return { ok: false, message: 'there is no saved copy of it in this browser.' };
    try {
      exportAsBundle(recordFilesAsMap(record), record.workspace.projectName);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }, []);

  const renderLeftPanelContent = () => {
    switch (leftPanel) {
      case 'ai':
        return <AIChat />;
      case 'pages':
        return <PagesPanel />;
      case 'history':
        return <HistoryPanel />;
      case 'settings':
        return <SettingsPanel />;
      case 'files':
        return <FilesPanel />;
      default:
        return null;
    }
  };

  // The same bar as the site, the runtime and Builder, over every view: the
  // way between them.
  const bar = isHostedEditor() ? null : <ProductBar current="studio" />;
  // The AI setup, over any view: every prompt to connect a provider opens it.
  const setupDialog = isHostedEditor() ? null : <ProviderSetupDialog />;

  // Nothing is decided until the stored project has been read: showing the
  // dashboard for a moment and then the editor would be a flash of the
  // wrong page.
  if (!isHydrated) {
    return (
      <div style={styles.root}>
        {bar}
        <div style={styles.fill} role="status" aria-live="polite">
          <span style={styles.booting}>Opening your project…</span>
        </div>
      </div>
    );
  }

  // Dashboard
  if (view === 'dashboard') {
    return (
      <div style={styles.root}>
        {bar}
        <div style={styles.fill}>
          <Dashboard
            onNewProject={handleNewProject}
            onImportProject={handleImportProject}
            onOpenRecent={handleOpenRecent}
            onRemoveRecent={handleRemoveRecent}
            onDeleteProject={handleDeleteProject}
            onExportProject={handleExportProject}
            onOpenExample={(example) => void handleOpenExample(example)}
            recentProjects={recentProjects}
            ai={isHostedEditor() ? undefined : {
              gate: needsProviderSetup({ hosted: false, providerCount, setupSkipped }),
              onSkip: () => useAIStore.getState().setSetupSkipped(true),
            }}
          />
        </div>
        {setupDialog}
      </div>
    );
  }

  // Brief wizard (inline, full-page) — wrapped in theme vars
  if (view === 'brief') {
    return (
      <div style={styles.root}>
        {bar}
        <div style={styles.fill}>
          <BriefWizard onBack={handleBackToDashboard} onSubmit={() => setView('editor')} />
        </div>
        {setupDialog}
      </div>
    );
  }

  // Mobile editor.
  //
  // BlueprintReview is rendered here as well as in the desktop return below. It
  // used to appear only there, and this branch returns before reaching it — so
  // on a phone a generated blueprint was never put up for approval. The gate it
  // guards stayed shut with no way to open it: the plan could not be approved,
  // could not be sent back for revision, and could not even be read.
  //
  // The project menu on the right is the phone's Run, Publish and Export
  // bundle — the desktop TopBar's actions from the same hook. This header
  // used to end in a green dot that meant nothing, and a project on a phone
  // could not leave the device.
  if (isMobile) {
    return (
      <div style={styles.mobileRoot}>
        {bar}
        {/* Compact mobile top bar */}
        <div style={styles.mobileTopBar}>
          <div style={styles.mobileTopLeft}>
            {!isHostedEditor() && <button
              onClick={handleBackToDashboard}
              style={styles.mobileBackBtn}
              title="Back to home"
              aria-label="Back to home"
            >
              <Icon name="chevron-left" size={20} />
            </button>}
            <span style={styles.mobileProjectName}>{projectName || 'SoftN Studio'}</span>
          </div>
          <div style={styles.mobileTopRight}>
            <SaveStatusIndicator compact />
            <MobileProjectMenu />
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
          {mobilePanel === 'settings' && (
            <div style={styles.mobilePanel}>
              <SettingsPanel />
            </div>
          )}
        </div>
        <div style={styles.mobileNav}>
          {[
            { id: 'chat' as const, label: 'AI Chat', icon: 'ai' as const },
            { id: 'canvas' as const, label: 'Preview', icon: 'eye' as const },
            { id: 'settings' as const, label: 'Settings', icon: 'settings' as const },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setMobilePanel(tab.id)}
              aria-pressed={mobilePanel === tab.id}
              style={{
                ...styles.mobileNavBtn,
                ...(mobilePanel === tab.id ? styles.mobileNavBtnActive : {}),
              }}
            >
              <Icon
                name={tab.icon}
                size={20}
                color={mobilePanel === tab.id ? 'var(--studio-accent)' : 'var(--studio-text-dim)'}
              />
              <span style={styles.mobileNavLabel}>{tab.label}</span>
            </button>
          ))}
        </div>

        {!blueprintApproved && blueprint && view === 'editor' && (
          <BlueprintReview
            onApprove={() => {
              useWorkspaceStore.getState().setMode('design');
              // The agent builds the app to the brief; the chat is where that shows.
              if (buildFromBrief()) setMobilePanel('chat');
            }}
            onReviseBrief={() => setView('brief')}
          />
        )}
        {setupDialog}
      </div>
    );
  }

  // Desktop editor
  return (
    <div style={styles.root}>
      {bar}
      <TopBar onBackToDashboard={handleBackToDashboard} />
      <div style={styles.main}>
        <LeftRail>{renderLeftPanelContent()}</LeftRail>
        <div style={styles.centerColumn}>
          <VisualCanvas onStartBrief={handleNewProject} />
          <BottomDrawer />
        </div>
      </div>
      <StatusBar />
      {!blueprintApproved && blueprint && view === 'editor' && (
        <BlueprintReview
          onApprove={() => {
            useWorkspaceStore.getState().setMode('design');
            buildFromBrief();
          }}
          onReviseBrief={() => setView('brief')}
        />
      )}
      {setupDialog}
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
  /** The space under the product bar, for a view that fills the window itself. */
  fill: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  centerColumn: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    overflow: 'hidden',
  },
  booting: {
    margin: 'auto',
    fontFamily: 'var(--studio-mono)',
    fontSize: 12,
    color: 'var(--studio-text-muted)',
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
    minWidth: 0,
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
