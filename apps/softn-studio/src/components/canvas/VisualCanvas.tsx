import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useAIStore, useWorkspaceStore, useVFSStore } from '../../stores';
import { Icon } from '../common/Icon';
import { declarePythonPackage, resolveActivePreviewPath, resolveManifest, undeclaredPythonPackage } from '../../lib/studioProject';
import { getXDB, type SoftNRendererProps } from '@softn/core';
import type { ThemeProviderProps } from '@softn/components';
import { createPreviewAssetResolver } from '../../lib/previewAssets';
import { declaredCapabilities } from '../../lib/declaredCapabilities';
import { CodeFile, FileEditor } from './FileEditor';
import { useEditStore } from '../../stores/editStore';
import { confirmLeaveDraft } from '../../lib/handEdit';
import { askAgentToFix } from '../../lib/agentOrchestrator';
import { listenToConsoleErrors, notePreviewFault, readAppFault, readAppLog } from '../../lib/previewFaults';
import { MediaView, mediaKindFor } from './MediaView';
import {
  buildPreviewXDBState,
  clearPreviewXDBCollections,
  composePreviewProject,
  previewDataKey,
  declaredThemeMode,
  replacePreviewXDBCollections,
  stripTemplateComments,
} from '../../lib/previewProject';

/**
 * The files the preview renders. While an agent run is writing, a burst of
 * steps would remount the app once per write — each remount reloading its
 * engine — so the preview follows the files at most every `delay` ms, and
 * at least every `maxWait` ms so a long run still shows its progress. With
 * no run, it follows every change at once, as it always has.
 */
export function useSettledFiles<T>(value: T, delay: number, maxWait = 2_000): T {
  const [settled, setSettled] = useState(value);
  const lastFlush = useRef(Date.now());
  useEffect(() => {
    if (delay <= 0) {
      lastFlush.current = Date.now();
      setSettled(value);
      return;
    }
    const wait = Math.max(0, Math.min(delay, maxWait - (Date.now() - lastFlush.current)));
    const timer = setTimeout(() => {
      lastFlush.current = Date.now();
      setSettled(value);
    }, wait);
    return () => clearTimeout(timer);
  }, [value, delay, maxWait]);
  return delay <= 0 ? value : settled;
}

/**
 * How many different things one run of an app may put in Studio's log. A handler that fails on
 * every keystroke, or thirty times a second in a game's loop, says its one line once; an app
 * with a new complaint each time stops being copied out here.
 */
const APP_LOG_LINES = 12;
/** And how many different lines of its own (console.log, console.warn) a project may put there. */
const APP_PRINT_LINES = 40;

/**
 * The name of the element the previewed app is drawn in, for the theme provider: a side the
 * project declares is written on that element, and Studio's own document keeps Studio's.
 */
const PREVIEW_THEME_BOX = 'studio-preview';

export type CanvasViewMode = 'preview' | 'code';

/** Where the Preview | Code choice is kept: this tab's session, like the rest of the canvas's view state. */
const VIEW_MODE_KEY = 'softn.studio.canvasView.v1';

export function readCanvasViewMode(): CanvasViewMode {
  try {
    return window.sessionStorage.getItem(VIEW_MODE_KEY) === 'code' ? 'code' : 'preview';
  } catch {
    return 'preview';
  }
}

function writeCanvasViewMode(mode: CanvasViewMode): void {
  try {
    window.sessionStorage.setItem(VIEW_MODE_KEY, mode);
  } catch {
    // Storage can be blocked; the choice then lasts as long as the canvas.
  }
}

/** Preview | Code, for a file that is both a page and source. */
export function ViewSwitch({ mode, onChange }: { mode: CanvasViewMode; onChange: (mode: CanvasViewMode) => void }): React.ReactElement {
  return (
    <div className="st-view-switch" role="group" aria-label="Show the file as">
      <button type="button" aria-pressed={mode === 'preview'} onClick={() => onChange('preview')}>
        <Icon name="eye" size={13} />
        Preview
      </button>
      <button type="button" aria-pressed={mode === 'code'} onClick={() => onChange('code')}>
        <Icon name="code" size={13} />
        Code
      </button>
    </div>
  );
}

interface VisualCanvasProps {
  onStartBrief?: () => void;
  /** Bring the chat into view, where the canvas and the chat are not on screen together (a phone). */
  onShowChat?: () => void;
}

interface StablePreviewSurfaceProps {
  expanded: boolean;
  isMobile: boolean;
  label: string;
  frameStyle: React.CSSProperties;
  chrome: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}

/**
 * The preview child always occupies the same host node. Expanding changes only
 * that host's presentation, so stateful renderers, iframes, media, and games do
 * not restart simply because the user asks for more screen space.
 */
export function StablePreviewSurface({
  expanded,
  isMobile,
  label,
  frameStyle,
  chrome,
  onClose,
  children,
}: StablePreviewSurfaceProps): React.ReactElement {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!expanded) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();
    return () => {
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [expanded]);

  const trapDialogFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!expanded || event.key !== 'Tab') return;
    const surface = surfaceRef.current;
    if (!surface) return;
    const focusable = Array.from(
      surface.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter(
      (element) => !element.hidden && !element.closest<HTMLElement>('[aria-hidden="true"]')
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      ref={surfaceRef}
      data-softn-preview-surface="true"
      style={{
        ...styles.previewFrame,
        ...frameStyle,
        ...(expanded ? styles.expandedPreviewFrame : {}),
      }}
      role={expanded ? 'dialog' : undefined}
      aria-modal={expanded ? 'true' : undefined}
      aria-label={expanded ? `${label} expanded preview` : undefined}
      onKeyDown={trapDialogFocus}
    >
      <div
        style={{
          ...styles.previewChrome,
          ...(isMobile || expanded ? { display: 'none' } : {}),
        }}
        aria-hidden={isMobile || expanded || undefined}
      >
        {chrome}
      </div>
      <div
        data-softn-preview-content="true"
        style={{
          ...styles.previewContentHost,
          ...(expanded ? styles.expandedContent : {}),
        }}
      >
        {children}
      </div>
      {expanded && (
        <div style={styles.expandedFloatingBar}>
          <div style={styles.expandedFloatingLabel}>{label}</div>
          <button
            ref={closeButtonRef}
            onClick={onClose}
            style={styles.expandedCloseBtn}
            aria-label="Close expanded preview"
            title="Close expanded preview"
          >
            <Icon name="x" size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

export const VisualCanvas: React.FC<VisualCanvasProps> = ({ onStartBrief, onShowChat }) => {
  const {
    blueprint,
    devicePreset,
    zoom,
    activePageId,
    activeFilePath,
    projectId,
    projectName,
  } = useWorkspaceStore();
  const liveFiles = useVFSStore((s) => s.files);
  const agentWriting = useAIStore((s) => s.agentState === 'building');
  const aiConnected = useAIStore((s) => s.providers.some((provider) => provider.id === s.activeProviderId));
  const files = useSettledFiles(liveFiles, agentWriting ? 600 : 0);
  const [activeVFSFile, setActiveVFSFile] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [isExpandedPreview, setIsExpandedPreview] = useState(false);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [viewMode, setViewModeState] = useState<CanvasViewMode>(readCanvasViewMode);
  const setViewMode = useCallback((mode: CanvasViewMode) => {
    // Leaving the code view leaves the editor that may be open in it: a draft that is not
    // saved is asked about first, and the view stays where it is when the answer is no.
    if (mode !== 'code' && !confirmLeaveDraft()) return;
    setViewModeState(mode);
    writeCanvasViewMode(mode);
  }, []);
  const [PreviewComponent, setPreviewComponent] =
    useState<React.ComponentType<SoftNRendererProps> | null>(null);
  const [ThemeProviderComponent, setThemeProviderComponent] =
    useState<React.ComponentType<ThemeProviderProps> | null>(null);
  const [rendererError, setRendererError] = useState<string | null>(null);
  const [rendererRetry, setRendererRetry] = useState(0);
  const [isMobile, setIsMobile] = useState(false);
  const seededPreviewRef = useRef<{
    xdb: ReturnType<typeof getXDB>;
    collections: Set<string>;
  } | null>(null);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const pages = blueprint?.pages ?? [];
  const currentPage = pages.find((p) => p.id === activePageId) ?? pages[0];
  const previewAppId = useMemo(() => {
    const base = projectId || projectName || blueprint?.appName || 'softn-preview';
    return `studio-preview-${String(base)
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, '-')}`;
  }, [projectId, projectName, blueprint?.appName]);

  const manifest = resolveManifest(files);
  const manifestPages = Array.isArray(manifest?.pages)
    ? (manifest.pages as Array<Record<string, unknown>>)
    : [];

  const deviceWidths: Record<string, number> = {
    desktop: 1280,
    tablet: 768,
    mobile: 375,
  };
  const previewWidth = deviceWidths[devicePreset] ?? 1280;
  const scale = zoom / 100;

  const hasFiles = files.size > 0;
  const selectedSurfaceLabel = activeVFSFile
    ? (activeVFSFile.split('/').pop() ?? activeVFSFile)
    : (currentPage?.name ?? 'Preview');

  useEffect(() => {
    const nextPath = resolveActivePreviewPath(files, activeVFSFile, activeFilePath);
    if (nextPath !== activeVFSFile) setActiveVFSFile(nextPath);
  }, [files, activeFilePath, activeVFSFile]);

  // Get preview content for the active VFS file
  const previewFileContent = activeVFSFile
    ? (() => {
        const file = files.get(activeVFSFile);
        return file && typeof file.content === 'string' ? file.content : null;
      })()
    : null;

  const activeContent = activeVFSFile ? files.get(activeVFSFile)?.content ?? null : null;

  // Determine if the active file is HTML-renderable
  const isHtmlFile = activeVFSFile ? /\.(html|htm)$/i.test(activeVFSFile) : false;
  // Images, audio, video, fonts and PDFs are shown as themselves; so is any
  // other file kept as bytes, with its name, type and size.
  const showsAsMedia = Boolean(
    activeVFSFile && activeContent !== null && (mediaKindFor(activeVFSFile) || typeof activeContent !== 'string'),
  );
  const isManifestFile = activeVFSFile === 'manifest.json';
  const isSoftNUIFile = activeVFSFile ? /\.ui$/i.test(activeVFSFile) : false;
  // A page is both something to look at and source: it gets Preview | Code.
  const canSwitchView = (isSoftNUIFile || isHtmlFile) && previewFileContent !== null;
  const showCode = canSwitchView && viewMode === 'code';

  useEffect(() => {
    let mounted = true;
    const loadRenderer = async () => {
      try {
        const components = await import('@softn/components');
        if (!mounted) return;
        if (components.registerAllBuiltins) {
          components.registerAllBuiltins();
        }
        const core = await import('@softn/core');
        if (!mounted) return;
        if (!core.SoftNWithXDB) throw new Error('The preview renderer is unavailable.');
        setThemeProviderComponent(() => components.ThemeProvider ?? null);
        // The renderer a runtime uses: the page's <data> block binds its collections from the
        // preview's store (seeded below), under the names, filters, order and limits it gives
        // them. The plain renderer was handed every record under its collection's name, which
        // showed a collection read as another name as empty, and ignored filter, sort and limit.
        setPreviewComponent(() => core.SoftNWithXDB);
      } catch (error) {
        if (mounted) setRendererError(error instanceof Error ? error.message : 'The preview renderer could not load.');
      }
    };

    loadRenderer();
    return () => {
      mounted = false;
    };
  }, [rendererRetry]);

  // The preview-data reset policy (see previewDataKey in lib/previewProject.ts):
  // the disposable XDB collections are reseeded from source only when an .xdb
  // file changes — its content, its path or its presence — or when the person
  // presses "Reset preview data". This memo used to depend on the whole file
  // map, so a one-character edit to a .ui file threw away every record typed
  // into the preview. `files` is read here on purpose without being a
  // dependency: the key already changes for exactly the edits that should
  // reseed, and `previewDataResets` counts the explicit resets.
  const previewDataKeyValue = useMemo(() => previewDataKey(files), [files]);
  const [previewDataResets, setPreviewDataResets] = useState(0);
  const previewXDBState = useMemo(
    () => buildPreviewXDBState(files),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [previewDataKeyValue, previewDataResets]
  );
  // The records go into the preview's store (below) and nowhere else: the page reads them
  // through its <data> block, as it does when the app runs. They used to be handed to the
  // page as well, every collection under its own name, so a page that declared none still
  // drew its rows here and was empty everywhere else.

  useEffect(() => {
    let xdb: ReturnType<typeof getXDB>;
    try {
      xdb = getXDB(previewAppId);
    } catch {
      // Storage can be unavailable in privacy-restricted contexts.
      return;
    }
    let disposed = false;
    void xdb.isReady
      .then(() => {
        if (disposed) return;
        const previous = seededPreviewRef.current;
        if (previous && previous.xdb !== xdb) {
          clearPreviewXDBCollections(previous.xdb, previous.collections);
        }
        const previousCollections = previous?.xdb === xdb ? previous.collections : [];
        const ownedCollections = new Set([...previousCollections, ...previewXDBState.collections]);
        seededPreviewRef.current = { xdb, collections: ownedCollections };
        replacePreviewXDBCollections(xdb, previewXDBState, previousCollections);
        seededPreviewRef.current = {
          xdb,
          collections: new Set(previewXDBState.collections),
        };
      })
      .catch(() => {
        // Without the store the page has no records, here as in a runtime without one.
      });

    return () => {
      disposed = true;
    };
  }, [previewAppId, previewXDBState]);

  useEffect(
    () => () => {
      const seeded = seededPreviewRef.current;
      seededPreviewRef.current = null;
      if (!seeded) return;
      try {
        clearPreviewXDBCollections(seeded.xdb, seeded.collections);
      } catch {
        // Disposable preview cleanup is best effort if storage is revoked.
      }
    },
    []
  );

  const resolveAssetUrl = useMemo(
    () => createPreviewAssetResolver(files, activeVFSFile ?? 'ui/main.ui'),
    [files, activeVFSFile]
  );

  const rendererFunctions = useMemo<Record<string, (...args: unknown[]) => unknown>>(
    () => ({
      asset: (assetPath: unknown) => resolveAssetUrl(String(assetPath ?? '')),
    }),
    [resolveAssetUrl]
  );

  // The previewed file is composed as the runtime composes a bundle's main,
  // Python logic and all (see composePreviewProject). A composition the
  // runtime would refuse is an error shown in the preview, not a page that
  // renders without the logic Run will then fail on.
  const preview = useMemo(() => {
    if (!isSoftNUIFile || !activeVFSFile || !previewFileContent) return null;
    const result = composePreviewProject(files, activeVFSFile);
    if (!result.ok) return result;
    const { composition } = result;
    // The page as it is written. Quoted paths under assets/ used to be swapped for data: URLs
    // here, which drew a picture named by its bare path (src="assets/logo.png") that no
    // runtime loads; asset() and the asset resolver below are what resolve a bundle file.
    const source = stripTemplateComments(composition.source);
    return { ok: true as const, composition, source };
  }, [isSoftNUIFile, activeVFSFile, previewFileContent, files]);
  const softNSource = preview?.ok ? preview.source : null;
  const composition = preview?.ok ? preview.composition : null;
  const compositionError = preview && !preview.ok ? preview.error : null;
  // One refusal has a one-edit fix: a .py file importing a package
  // manifest.json does not declare. The fix is offered where the refusal is
  // shown, and made through the VFS so it is one undoable change.
  const missingPackage = compositionError ? undeclaredPythonPackage(compositionError) : null;
  const enablePackage = useCallback((name: string) => {
    const vfs = useVFSStore.getState();
    const current = vfs.readFile('manifest.json');
    if (typeof current !== 'string') return;
    const next = declarePythonPackage(current, name);
    if (next !== null && next !== current) vfs.updateFile('manifest.json', next, 'user');
  }, []);
  /** The app is mounted and its logic can run, whether the frame shows it or its code. */
  const appMounted = Boolean(isSoftNUIFile && softNSource && PreviewComponent);

  // One run of the app: this source, since this start. A stop belongs to the run it happened
  // in, so a changed file or a restart is a new run with nothing stopped, and a late line from
  // the run before it is not taken for this one's.
  const run = useMemo(() => ({ source: softNSource, start: refreshKey, file: activeVFSFile }), [softNSource, refreshKey, activeVFSFile]);
  const [stop, setStop] = useState<{ run: object; reason: string } | null>(null);
  const stoppedBecause = stop && stop.run === run ? stop.reason : null;

  // What the app prints with console.log and console.warn, copied to Studio's log. Each
  // different line is copied once for as long as this project is on the canvas (a page that
  // logs as it starts would say so again after every edit), and one run of the app may add no
  // more than APP_PRINT_LINES, so an app that logs in a loop fills neither the log nor the
  // saved project. The count is of the run: a page that prints a changing value is copied
  // out again after an edit or a restart, where a count for the whole session left it quiet
  // for good. (The log itself keeps its newest 500 lines whatever is put in it.)
  const printed = useRef<{ project: string | null; said: Set<string>; run: object | null; count: number; full: boolean }>({ project: null, said: new Set(), run: null, count: 0, full: false });
  const logAppLine = useCallback((text: string) => {
    if (printed.current.project !== projectId) printed.current = { project: projectId, said: new Set(), run: null, count: 0, full: false };
    const book = printed.current;
    if (book.run !== run) {
      book.run = run;
      book.count = 0;
      book.full = false;
      // What was said is remembered so as not to be said twice, and not without end.
      if (book.said.size > APP_PRINT_LINES * 10) book.said.clear();
    }
    if (book.full || book.said.has(text)) return;
    const over = book.count >= APP_PRINT_LINES;
    if (over) book.full = true;
    else {
      book.count++;
      book.said.add(text);
    }
    const line = over ? 'More lines from the app are not copied here: the browser’s console has them all.' : text;
    // Later, not now: the app may be printing from inside a render, where a store may not be written.
    queueMicrotask(() => useWorkspaceStore.getState().addConsoleOutput('[App] ' + line));
  }, [projectId, run]);

  // What the app's logic reports goes to the browser's console and nowhere else, so it is
  // listened for while an app is mounted (lib/previewFaults.ts): each thing it says once to
  // Studio's log and to the agent's next run, and a stop to the frame, which says so.
  useEffect(() => {
    if (!appMounted) return;
    let listening = true;
    const said = new Set<string>();
    const stopListening = listenToConsoleErrors((args, level) => {
      if (!listening) return;
      if (level !== 'error') {
        // What the app itself printed: to the log, and not to the AI.
        const line = readAppLog(args, level);
        if (line !== null) logAppLine(line);
        return;
      }
      const fault = readAppFault(args);
      if (!fault) return;
      // Later, not now: the runtime may be reporting from inside a render, where a store may not be written.
      queueMicrotask(() => {
        if (!listening) return;
        if (fault.text && !said.has(fault.text) && said.size < APP_LOG_LINES) {
          said.add(fault.text);
          useWorkspaceStore.getState().addConsoleOutput(`[App] ${fault.text}`);
          notePreviewFault(projectId, fault);
        }
        if (fault.stopped) setStop((was) => (was && was.run === run ? was : { run, reason: fault.text || 'A call in its logic ran until the engine cut it off.' }));
      });
    });
    return () => {
      listening = false;
      stopListening();
    };
  }, [appMounted, run, projectId, logAppLine]);

  /** The app is actually rendering in the frame, and answering: the one thing the chrome marks as live. */
  const isLive = Boolean(appMounted && !showCode && !stoppedBecause);

  // Blob URLs are resources, not render calculations. Creating them in
  // useMemo leaks the URL whenever React abandons a render (and on Strict
  // Mode's development probe), because no effect cleanup ever owns it.
  useEffect(() => {
    setBlobUrl(null);
    if (!previewFileContent || !isHtmlFile) return;
    const blob = new Blob([previewFileContent], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    setBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [previewFileContent, isHtmlFile, refreshKey]);

  useEffect(() => {
    if (!isExpandedPreview) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsExpandedPreview(false);
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [isExpandedPreview]);

  // Toolbar actions
  const handleToolAction = useCallback((id: string) => {
    switch (id) {
      case 'refresh':
        setRefreshKey((k) => k + 1);
        break;
      case 'newtab':
        setIsExpandedPreview(true);
        break;
      case 'resetdata':
        // Reseed the preview's collections from the .xdb files as they are
        // now; the person asked for it, which is the only other time it happens.
        setPreviewDataResets((n) => n + 1);
        break;
    }
  }, []);

  // A draft whose file has gone from the project keeps its editor on the canvas (lib/handEdit.ts).
  const orphanedDraft = useEditStore((s) => (s.draft && !liveFiles.has(s.draft.path) ? s.draft.path : null));

  const renderPreviewContent = () => {
    if (orphanedDraft) return <FileEditor path={orphanedDraft} onClose={() => {}} />;
    if (showsAsMedia && activeVFSFile && activeContent !== null) {
      return <MediaView key={activeVFSFile} path={activeVFSFile} content={activeContent} />;
    }

    if (previewFileContent === null) {
      return (
        <div style={{ ...styles.previewContent, background: 'var(--studio-bg)' }}>
          <div style={styles.previewPlaceholder}>
            <Icon name="eye" size={32} color="var(--studio-border-strong)" />
            <span style={{ fontSize: 13, color: 'var(--studio-text-dim)', marginTop: 8 }}>
              {files.size} file{files.size !== 1 ? 's' : ''} loaded — select a file to preview
            </span>
          </div>
        </div>
      );
    }

    const codeView = activeVFSFile ? <CodeFile path={activeVFSFile} source={previewFileContent} /> : null;

    // Code, for a page whose preview is not running: nothing to keep alive.
    if (showCode && !(isSoftNUIFile && softNSource && PreviewComponent) && !(isHtmlFile && blobUrl)) {
      return codeView;
    }

    if (isSoftNUIFile && compositionError) {
      return (
        <div style={styles.previewContent}>
          <div className="st-state-panel" role="alert">
            <h3 className="st-state-title">
              <span className="st-state-mark"><Icon name="alert-circle" size={16} /></span>
              This app cannot be previewed as it stands.
            </h3>
            <p className="st-state-message">{compositionError}</p>
            {missingPackage ? (
              <>
                <p className="st-state-note">
                  The app imports {missingPackage} but manifest.json does not ask for it. Enabling it adds
                  {' '}<code>{missingPackage}</code> to <code>config.python.packages</code>; Undo takes it back out.
                </p>
                <div className="st-state-actions">
                  <button type="button" className="st-btn st-btn-sm st-btn-primary" onClick={() => enablePackage(missingPackage)}>
                    Enable {missingPackage}
                  </button>
                </div>
              </>
            ) : (
              <p className="st-state-note">Run would stop at the same point: the preview composes the app the way the runtime does. Fix the file named above, or ask the AI to.</p>
            )}
            <details>
              <summary>View source</summary>
              <pre style={styles.filePreview}>{previewFileContent}</pre>
            </details>
          </div>
        </div>
      );
    }

    if (isSoftNUIFile && !PreviewComponent) {
      if (!rendererError) {
        return (
          <div style={styles.previewContent}>
            <div className="st-loading" role="status" aria-busy="true">Preparing preview…</div>
          </div>
        );
      }
      return (
        <div style={styles.previewContent}>
          <div className="st-state-panel" role="alert">
            <h3 className="st-state-title">
              <span className="st-state-mark"><Icon name="alert-circle" size={16} /></span>
              Preview could not start.
            </h3>
            <p className="st-state-message">{rendererError}</p>
            <div className="st-state-actions">
              <button
                type="button"
                className="st-btn st-btn-sm"
                onClick={() => { setRendererError(null); setRendererRetry((value) => value + 1); }}
              >
                Retry preview
              </button>
            </div>
            <details>
              <summary>View source</summary>
              <pre style={styles.filePreview}>{previewFileContent}</pre>
            </details>
          </div>
        </div>
      );
    }

    if (isSoftNUIFile && softNSource && PreviewComponent) {
      // The preview grants nothing: a call to the network, storage or a
      // device fails here whatever permission.json declares, because there
      // is no consent bar to grant it and a design preview is not the place
      // to reach out from. That used to be silent — the failure named a
      // missing permission.json the project did have — so the declared
      // capabilities are named here, with where to run them for real.
      const declared = declaredCapabilities(files.get('permission.json')?.content);
      const capabilityNote =
        declared.length > 0 ? (
          <div role="note" style={styles.capabilityNote}>
            Preview grants no capabilities: {declared.join(', ')} {declared.length === 1 ? 'is' : 'are'} declared in permission.json, but calls to{' '}
            {declared.length === 1 ? 'it' : 'them'} fail here. Use Run to open the bundle in the runtime, where they can be allowed.
          </div>
        ) : null;
      // The app's logic has stopped: said above the app, which still shows its last state and
      // answers nothing. Restart mounts it again with a fresh engine.
      const stopNotice = stoppedBecause ? (
        <div role="alert" className="st-preview-stop-notice" data-preview-stopped="true">
          <p>
            <strong>This app has stopped.</strong> {stoppedBecause} Fix it in the code, or ask the AI to.
          </p>
          <div className="st-preview-stop-actions">
            {/* Where a provider is connected: the reason, sent as the request the person would have typed. */}
            {aiConnected && (
              <button
                type="button"
                className="st-btn st-btn-sm st-btn-primary"
                disabled={agentWriting}
                title={agentWriting ? 'The AI is working: ask when the run stops.' : undefined}
                onClick={() => {
                  if (!askAgentToFix(stoppedBecause)) return;
                  const ws = useWorkspaceStore.getState();
                  if (ws.leftPanel !== 'ai' || !ws.leftPanelExpanded) ws.setLeftPanel('ai');
                  onShowChat?.();
                }}
              >
                Ask the AI to fix it
              </button>
            )}
            <button type="button" className="st-btn st-btn-sm" onClick={() => setRefreshKey((k) => k + 1)}>
              Restart the preview
            </button>
          </div>
        </div>
      ) : null;
      // In Code the running app stays mounted, hidden, so switching back
      // finds it as it was rather than restarted.
      const rendererStyle = showCode ? { ...styles.rendererWrap, display: 'none' } : styles.rendererWrap;
      return ThemeProviderComponent ? (
        <>
          {showCode && codeView}
          <div style={rendererStyle}>
          {stopNotice}
          {capabilityNote}
          {/* The app's own box: a side the project declares is written here, under Studio's notices and not on them. */}
          <div data-softn-theme-box={PREVIEW_THEME_BOX} style={styles.themeBox}>
          <ThemeProviderComponent followHost followSystem declaredMode={declaredThemeMode(manifest)} box={PREVIEW_THEME_BOX}>
            <PreviewComponent
              key={refreshKey}
              source={softNSource}
              functions={rendererFunctions}
              assetResolver={resolveAssetUrl}
              importResolver={composition?.importResolver}
              logicBasePath={composition?.logicBasePath}
              preIncludedLogicPaths={composition?.preIncludedLogicPaths}
              python={composition?.python}
              appId={previewAppId}
              scriptExecutionMode="main"
              resumeSavedSyncRoom={false}
            />
          </ThemeProviderComponent>
          </div>
          </div>
        </>
      ) : (
        <>
          {showCode && codeView}
          <div style={rendererStyle}>
          {stopNotice}
          {capabilityNote}
          <PreviewComponent
            key={refreshKey}
            source={softNSource}
            functions={rendererFunctions}
              assetResolver={resolveAssetUrl}
            importResolver={composition?.importResolver}
            logicBasePath={composition?.logicBasePath}
            preIncludedLogicPaths={composition?.preIncludedLogicPaths}
            python={composition?.python}
            appId={previewAppId}
            scriptExecutionMode="main"
            resumeSavedSyncRoom={false}
          />
          </div>
        </>
      );
    }

    if (isHtmlFile && blobUrl) {
      return (
        <>
          {showCode && codeView}
          <iframe
          key={refreshKey}
          src={blobUrl}
          style={showCode ? { ...styles.iframe, display: 'none' } : styles.iframe}
          // allow-scripts WITHOUT allow-same-origin. Together the two cancel the
          // sandbox out: the blob inherits this origin, so previewed HTML could
          // read localStorage — where the model API key is kept — and reach back
          // into the parent document. The HTML being previewed is a model's
          // output or an imported bundle, so it is not ours to trust. Dropping
          // the flag costs nothing: the blob still loads and its scripts still
          // run, they just get an opaque origin and a SecurityError on storage.
          sandbox="allow-scripts"
          title="App Preview"
          />
        </>
      );
    }

    if (isManifestFile) {
      return (
        <div style={styles.codePreviewCard}>
          <div style={styles.manifestSummary}>
            <div style={styles.manifestStat}>
              <span style={styles.manifestLabel}>Bundle</span>
              <strong>{String(manifest?.name ?? 'Imported app')}</strong>
            </div>
            <div style={styles.manifestStat}>
              <span style={styles.manifestLabel}>Entry</span>
              <strong>{String(manifest?.entry ?? manifest?.main ?? 'n/a')}</strong>
            </div>
            <div style={styles.manifestStat}>
              <span style={styles.manifestLabel}>Pages</span>
              <strong>{manifestPages.length}</strong>
            </div>
          </div>
          {codeView}
        </div>
      );
    }

    return codeView;
  };

  return (
    <div className="st-canvas">
      {/* Canvas area */}
      <div
        style={{
          ...styles.canvasArea,
          ...(isMobile ? { padding: 0 } : {}),
          ...(isExpandedPreview ? { zIndex: 1000, overflow: 'visible' } : {}),
        }}
      >
        {hasFiles ? (
          <StablePreviewSurface
            expanded={isExpandedPreview}
            isMobile={isMobile}
            label={selectedSurfaceLabel}
            frameStyle={
              isMobile
                ? { borderRadius: 0, border: 'none', boxShadow: 'none', width: '100%', transition: 'none' }
                : { width: Math.min(previewWidth * scale, previewWidth), maxWidth: '100%' }
            }
            onClose={() => setIsExpandedPreview(false)}
            chrome={
              <div className="st-preview-chrome">
                <div className="st-preview-where">
                  <span className="st-preview-file" title={activeVFSFile ?? undefined}>
                    {activeVFSFile && activeVFSFile.includes('/') && (
                      <span className="dir">{activeVFSFile.slice(0, activeVFSFile.lastIndexOf('/') + 1)}</span>
                    )}
                    {selectedSurfaceLabel}
                  </span>
                  <span className="st-preview-tag">{devicePreset}</span>
                  {isLive && <span className="st-live">Running</span>}
                  {stoppedBecause && !showCode && <span className="st-preview-stopped" title={stoppedBecause}>Stopped</span>}
                </div>
                <div style={styles.chromeRight}>
                {canSwitchView && <ViewSwitch mode={viewMode} onChange={setViewMode} />}
                <div className="st-preview-tools" role="toolbar" aria-label="Preview controls">
                  {[
                    { id: 'refresh', icon: 'refresh' as const, label: 'Refresh preview' },
                    { id: 'resetdata', icon: 'database' as const, label: 'Reset preview data (reseed from the .xdb files)' },
                    { id: 'newtab', icon: 'maximize' as const, label: 'Expand preview' },
                  ].map((tool) => (
                    <button
                      key={tool.id}
                      type="button"
                      onClick={() => handleToolAction(tool.id)}
                      className="st-icon-btn"
                      title={tool.label}
                      aria-label={tool.label}
                    >
                      <Icon name={tool.icon} size={15} />
                    </button>
                  ))}
                </div>
                </div>
              </div>
            }
          >
            <div style={styles.surfaceColumn}>
              {/* The frame's header is hidden on a phone, so the switch comes with the content there. */}
              {isMobile && canSwitchView && (
                <div className="st-view-switch-bar">
                  <ViewSwitch mode={viewMode} onChange={setViewMode} />
                </div>
              )}
              {renderPreviewContent()}
            </div>
          </StablePreviewSurface>
        ) : (
          <div style={styles.emptyCanvas}>
            <div style={styles.emptyGraphic}>
              <div style={styles.emptyPhone}>
                <div style={styles.emptyPhoneScreen}>
                  <div style={styles.emptyBar} />
                  <div style={{ ...styles.emptyBar, width: '60%', opacity: 0.5 }} />
                  <div style={styles.emptyBlock} />
                  <div style={{ ...styles.emptyBar, width: '40%', opacity: 0.3, marginTop: 8 }} />
                </div>
              </div>
            </div>
            <h3 style={styles.emptyTitle}>No app yet</h3>
            <p style={styles.emptyDesc}>
              Use the AI chat or guided brief to describe your app. The AI will generate and modify
              all files for you.
            </p>
            <div style={styles.emptyActionRow}>
              <button
                onClick={() => useWorkspaceStore.getState().setLeftPanel('ai')}
                style={styles.emptyActionCard}
              >
                <span style={styles.emptyActionKicker}>Fastest start</span>
                <span style={styles.emptyActionTitle}>Open AI chat</span>
              </button>
              {onStartBrief && (
                <button onClick={onStartBrief} style={styles.emptyActionCard}>
                  <span style={styles.emptyActionKicker}>Guided</span>
                  <span style={styles.emptyActionTitle}>Run the brief wizard</span>
                </button>
              )}
            </div>
          </div>
        )}
      </div>

    </div>
  );
};

// Kept here for what has always imported it from the canvas; it lives with the check's use of it now.
export { declaredCapabilities };

const styles: Record<string, React.CSSProperties> = {
  canvasArea: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    overflow: 'auto',
    padding: 16,
    position: 'relative',
    zIndex: 1,
    minHeight: 0,
  },
  previewFrame: {
    borderRadius: 12,
    overflow: 'hidden',
    border: '1px solid var(--studio-border-strong)',
    boxShadow: 'var(--studio-shadow)',
    flex: 1,
    minHeight: 0,
    transition: 'width 0.3s ease',
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--studio-bg-elevated)',
  },
  expandedPreviewFrame: {
    position: 'fixed',
    inset: 0,
    zIndex: 999,
    width: '100%',
    maxWidth: 'none',
    height: '100%',
    flex: 'none',
    borderRadius: 0,
    border: 'none',
    boxShadow: 'none',
    background: 'var(--studio-bg-elevated)',
  },
  previewContentHost: {
    minWidth: 0,
    flex: 1,
    minHeight: 0,
    display: 'flex',
    overflow: 'hidden',
    background: 'var(--studio-bg-elevated)',
  },
  capabilityNote: {
    padding: '6px 10px',
    fontSize: 12,
    lineHeight: 1.4,
    color: 'var(--studio-text-muted)',
    background: 'var(--studio-panel)',
    borderBottom: '1px solid var(--studio-border)',
  },
  themeBox: {
    minHeight: '100%',
  },
  rendererWrap: {
    minWidth: 0,
    position: 'relative',
    width: '100%',
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    background: 'var(--studio-bg-elevated)',
  },
  expandedFloatingBar: {
    position: 'fixed',
    top: 16,
    right: 16,
    left: 16,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    pointerEvents: 'none',
    zIndex: 1001,
  },
  expandedFloatingLabel: {
    maxWidth: '70%',
    padding: '8px 12px',
    borderRadius: 999,
    background: 'var(--studio-panel)',
    border: '1px solid var(--studio-border)',
    fontFamily: 'var(--studio-mono)',
    fontSize: 13,
    fontWeight: 700,
    color: 'var(--studio-text)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    pointerEvents: 'auto',
  },
  expandedCloseBtn: {
    width: 34,
    height: 34,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '1px solid var(--studio-border)',
    background: 'var(--studio-panel)',
    color: 'var(--studio-text)',
    borderRadius: 12,
    cursor: 'pointer',
    fontFamily: 'inherit',
    pointerEvents: 'auto',
  },
  expandedContent: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    background: 'var(--studio-bg-elevated)',
  },
  previewChrome: {
    height: 42,
    display: 'flex',
    alignItems: 'center',
    padding: '0 6px 0 14px',
    background: 'var(--studio-bg-elevated)',
    borderBottom: '1px solid var(--studio-border)',
    flexShrink: 0,
  },
  iframe: {
    width: '100%',
    flex: 1,
    border: 'none',
    background: 'var(--studio-bg-elevated)',
    minHeight: 0,
  },
  codePreviewCard: {
    width: '100%',
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    minHeight: 0,
    background: 'var(--studio-bg-elevated)',
  },
  chromeRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
  },
  surfaceColumn: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  manifestSummary: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
    gap: 10,
    padding: 16,
    borderBottom: '1px solid var(--studio-border)',
    flexShrink: 0,
  },
  manifestStat: {
    padding: 12,
    borderRadius: 14,
    background: 'var(--studio-inset)',
    border: '1px solid var(--studio-border)',
    fontFamily: 'var(--studio-mono)',
    fontSize: 12,
    color: 'var(--studio-text)',
    overflowWrap: 'anywhere',
  },
  manifestLabel: {
    display: 'block',
    fontSize: 10,
    color: 'var(--studio-text-muted)',
    marginBottom: 8,
  },
  previewContent: {
    width: '100%',
    flex: 1,
    minHeight: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'auto',
  },
  previewPlaceholder: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
  },
  filePreview: {
    width: '100%',
    margin: 0,
    padding: 16,
    fontSize: 12,
    lineHeight: 1.6,
    fontFamily: 'var(--studio-mono)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    overflow: 'auto',
  },
  emptyCanvas: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    padding: 40,
  },
  emptyGraphic: {
    marginBottom: 24,
  },
  emptyPhone: {
    width: 120,
    height: 200,
    borderRadius: 16,
    border: '2px solid var(--studio-border-strong)',
    padding: 8,
    background: 'var(--studio-inset)',
    boxShadow: 'var(--studio-shadow)',
  },
  emptyPhoneScreen: {
    width: '100%',
    height: '100%',
    borderRadius: 10,
    background: 'var(--studio-surface)',
    padding: 12,
  },
  emptyBar: {
    width: '80%',
    height: 6,
    borderRadius: 3,
    background: 'var(--studio-surface-hover)',
    marginBottom: 6,
  },
  emptyBlock: {
    width: '100%',
    height: 40,
    borderRadius: 6,
    background: 'var(--studio-surface-hover)',
    marginTop: 8,
    marginBottom: 8,
  },
  emptyTitle: {
    fontFamily: 'var(--studio-display)',
    fontSize: 26,
    fontWeight: 800,
    letterSpacing: '-0.03em',
    color: 'var(--studio-text)',
    margin: 0,
  },
  emptyDesc: {
    fontSize: 14,
    color: 'var(--studio-text-muted)',
    lineHeight: 1.6,
    maxWidth: 360,
    marginTop: 10,
  },
  emptyActionRow: {
    display: 'flex',
    gap: 12,
    marginTop: 24,
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  emptyActionCard: {
    minWidth: 180,
    padding: '14px 16px',
    borderRadius: 16,
    background: 'var(--studio-inset)',
    border: '1px solid var(--studio-border)',
    textAlign: 'left' as const,
    boxShadow: 'var(--studio-shadow)',
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'border-color 0.15s, background 0.15s',
  },
  emptyActionKicker: {
    display: 'block',
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--studio-text-dim)',
    marginBottom: 8,
  },
  emptyActionTitle: {
    display: 'block',
    fontFamily: 'var(--studio-display)',
    fontSize: 15,
    fontWeight: 700,
    letterSpacing: '-0.02em',
    color: 'var(--studio-text)',
  },
};
