import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { SoftNContainerHandle } from '@softn/container';
import { CORE_APPS, VERTICAL_PACKS, type ModulaAppDef } from '../data/suiteCatalog';
import { AppStoreModal } from './AppStoreModal';
import { CommandPalette } from './CommandPalette';
import { SoftNAppFrame } from './SoftNAppFrame';

interface WorkspaceHostProps {
  initialAppId?: string;
  initialPackFile?: string;
  onBackToSite: () => void;
}

interface MountedAppEntry {
  id: string;
  slug: string;
  name: string;
  shortName: string;
  color: string;
  iconText: string;
  source: string | Uint8Array;
  downloadUrl?: string;
  downloadName?: string;
  supportsStandalone: boolean;
}

export const WorkspaceHost: React.FC<WorkspaceHostProps> = ({
  initialAppId,
  initialPackFile,
  onBackToSite,
}) => {
  const [installedIds, setInstalledIds] = useState<string[]>(() => CORE_APPS.map((a) => a.id));
  const [mountedApps, setMountedApps] = useState<MountedAppEntry[]>([]);
  const [activeAppId, setActiveAppId] = useState<string | null>(null);
  const [showHomeGrid, setShowHomeGrid] = useState(true);
  const [showAppStore, setShowAppStore] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [homeQuery, setHomeQuery] = useState('');
  const [backendMode, setBackendMode] = useState<'zipp' | 'standalone'>('zipp');
  const [standaloneOnline, setStandaloneOnline] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState<string | null>(null);

  const handlesRef = useRef<Map<string, SoftNContainerHandle>>(new Map());
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((prev) => (prev === msg ? null : prev)), 3000);
  }, []);

  const checkStandaloneStatus = useCallback(async () => {
    try {
      const resp = await fetch('/api/standalone-status');
      if (resp.ok) {
        const data = (await resp.json()) as { servers?: Record<string, boolean> };
        if (data.servers) setStandaloneOnline(data.servers);
      }
    } catch {
      // ignore if offline
    }
  }, []);

  useEffect(() => {
    void checkStandaloneStatus();
  }, [checkStandaloneStatus]);

  // Global Ctrl+K / Cmd+K launcher shortcut
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setShowCommandPalette((v) => !v);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const openCoreApp = useCallback((app: ModulaAppDef) => {
    setInstalledIds((prev) => (prev.includes(app.id) ? prev : [...prev, app.id]));
    setMountedApps((prev) => {
      if (prev.some((m) => m.id === app.id)) return prev;
      return [
        ...prev,
        {
          id: app.id,
          slug: app.slug,
          name: app.name,
          shortName: app.shortName,
          color: app.color,
          iconText: app.iconText,
          source: `/bundles/${app.bundleFile}`,
          downloadUrl: `/bundles/${app.bundleFile}`,
          downloadName: app.bundleFile,
          supportsStandalone: true,
        },
      ];
    });
    setActiveAppId(app.id);
    setShowHomeGrid(false);
    setShowAppStore(false);
  }, []);

  const openVerticalPack = useCallback((file: string) => {
    const pack = VERTICAL_PACKS.find((p) => p.file === file);
    const id = `pack.${pack ? pack.slug : file.replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
    setMountedApps((prev) => {
      if (prev.some((m) => m.id === id)) return prev;
      return [
        ...prev,
        {
          id,
          slug: pack?.slug || id,
          name: pack?.name || file,
          shortName: pack?.name || file,
          color: pack?.color || '#334155',
          iconText: (pack?.name || 'PK').slice(0, 2).toUpperCase(),
          source: `/business-demos/${file}`,
          downloadUrl: `/business-demos/${file}`,
          downloadName: file,
          supportsStandalone: false,
        },
      ];
    });
    setActiveAppId(id);
    setShowHomeGrid(false);
    setShowAppStore(false);
  }, []);

  useEffect(() => {
    if (initialAppId) {
      const app = CORE_APPS.find((a) => a.id === initialAppId || a.slug === initialAppId);
      if (app) openCoreApp(app);
    } else if (initialPackFile) {
      openVerticalPack(initialPackFile);
    }
  }, [initialAppId, initialPackFile, openCoreApp, openVerticalPack]);

  const closeApp = (appId: string) => {
    setMountedApps((prev) => {
      const remaining = prev.filter((m) => m.id !== appId);
      if (activeAppId === appId) {
        if (remaining.length > 0) {
          setActiveAppId(remaining[remaining.length - 1].id);
        } else {
          setActiveAppId(null);
          setShowHomeGrid(true);
        }
      }
      return remaining;
    });
  };

  const handleRegisterHandle = useCallback((appId: string, handle: SoftNContainerHandle | null) => {
    if (handle) handlesRef.current.set(appId, handle);
    else handlesRef.current.delete(appId);
  }, []);

  const handleExportSqlite = async () => {
    if (!activeAppId) return;
    const handle = handlesRef.current.get(activeAppId);
    if (!handle) {
      notify('Wait for the container to finish booting first.');
      return;
    }
    try {
      const bytes = await handle.exportDatabase('app');
      if (!bytes || bytes.byteLength === 0) {
        notify('SQLite export is only available in local ZIPP XDB WASM mode.');
        return;
      }
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const blob = new Blob([copy], { type: 'application/x-sqlite3' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${activeAppId}.sqlite3`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify(`Exported ${activeAppId}.sqlite3 (${bytes.byteLength} bytes)`);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Export failed');
    }
  };

  const handleUploadCustomBundle = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const cleanName = file.name.replace(/\.softn$/i, '');
    const id = `custom.${cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.${Date.now()}`;
    setMountedApps((prev) => [
      ...prev,
      {
        id,
        slug: cleanName,
        name: cleanName,
        shortName: cleanName.slice(0, 14),
        color: '#475569',
        iconText: cleanName.slice(0, 2).toUpperCase(),
        source: bytes,
        supportsStandalone: false,
      },
    ]);
    setActiveAppId(id);
    setShowHomeGrid(false);
    setShowAppStore(false);
    e.target.value = '';
    notify(`Mounted custom bundle: ${file.name}`);
  };

  const toggleBackendMode = async () => {
    if (backendMode === 'zipp') {
      await checkStandaloneStatus();
      const anyUp = Object.values(standaloneOnline).some(Boolean);
      setBackendMode('standalone');
      notify(
        anyUp
          ? 'Switched to Standalone PHP Host mode (native php -S + WAL SQLite)'
          : 'Standalone PHP mode enabled — start `node examples/modula-suite/serve-php.mjs` if not running yet.'
      );
    } else {
      setBackendMode('zipp');
      notify('Switched to In-Browser ZIPP PHP WASM + XDB SQLite (zero server)');
    }
  };

  const activeEntry = mountedApps.find((m) => m.id === activeAppId) ?? null;
  const installedApps = CORE_APPS.filter((a) => installedIds.includes(a.id));
  const filteredHomeApps = installedApps.filter(
    (a) =>
      !homeQuery.trim() ||
      a.name.toLowerCase().includes(homeQuery.toLowerCase()) ||
      a.tagline.toLowerCase().includes(homeQuery.toLowerCase()) ||
      a.odooEquivalents.some((o) => o.toLowerCase().includes(homeQuery.toLowerCase()))
  );

  return (
    <div className="ws-shell">
      <header className="ws-topbar">
        <div className="ws-left">
          <button
            id="ws-home-grid-btn"
            type="button"
            className={`ws-grid-btn ${showHomeGrid ? 'active' : ''}`}
            title="App Switcher (Home Menu)"
            onClick={() => setShowHomeGrid((v) => !v)}
          >
            ⊞
          </button>

          <strong style={{ fontSize: '14px', letterSpacing: '-0.02em', marginRight: '6px', whiteSpace: 'nowrap' }}>
            Modula OS
          </strong>

          <div className="ws-tabs" role="tablist" aria-label="Running SoftN apps">
            {mountedApps.map((app) => {
              const isCurrent = !showHomeGrid && activeAppId === app.id;
              return (
                <div
                  key={app.id}
                  className={`ws-tab ${isCurrent ? 'active' : ''}`}
                  data-tab-app={app.slug}
                  onClick={() => {
                    setActiveAppId(app.id);
                    setShowHomeGrid(false);
                  }}
                >
                  <span className="ws-tab-dot" style={{ background: app.color }} />
                  <span>{app.shortName}</span>
                  <button
                    type="button"
                    className="ws-tab-close"
                    title={`Close ${app.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeApp(app.id);
                    }}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <div className="ws-right">
          <button
            id="ws-cmd-btn"
            type="button"
            className="ws-btn"
            title="Quick Jump (Ctrl+K)"
            onClick={() => setShowCommandPalette(true)}
          >
            ⌘K Jump
          </button>

          <button
            id="backend-mode-toggle"
            type="button"
            className={`ws-btn ${backendMode === 'zipp' ? 'active' : ''}`}
            onClick={() => void toggleBackendMode()}
            title="Toggle between In-Browser ZIPP PHP WASM and Standalone PHP servers"
          >
            {backendMode === 'zipp' ? '● ZIPP PHP WASM + XDB' : '● Standalone PHP Host'}
          </button>

          {activeEntry && !showHomeGrid && backendMode === 'zipp' && (
            <button type="button" className="ws-btn" onClick={() => void handleExportSqlite()}>
              Export SQLite .db
            </button>
          )}

          {activeEntry?.downloadUrl && !showHomeGrid && (
            <a className="ws-btn" href={activeEntry.downloadUrl} download={activeEntry.downloadName}>
              Download .softn
            </a>
          )}

          <button type="button" className="ws-btn" onClick={() => setShowAppStore(true)}>
            + App Store
          </button>

          <button type="button" className="ws-btn" onClick={onBackToSite}>
            ← Modula Site
          </button>
        </div>
      </header>

      <div className="ws-body">
        {showHomeGrid && (
          <div className="ws-home">
            <div className="ws-home-inner">
              <div className="ws-home-header">
                <div>
                  <h1 style={{ margin: 0, fontSize: '24px', letterSpacing: '-0.02em' }}>Modula Parent Workspace</h1>
                  <p style={{ margin: '4px 0 0', fontSize: '13.5px', color: '#9ca3af' }}>
                    {installedApps.length} installed SoftN apps · {mountedApps.length} running in keep-alive containers ·{' '}
                    {backendMode === 'zipp' ? 'PHP 8 running locally via ZIPP WASM + XDB SQLite' : 'Connected to Standalone PHP servers'}
                  </p>
                </div>
                <input
                  className="ws-home-search"
                  type="search"
                  placeholder="Filter apps (CRM, POS, MRP, eSign, HR...)"
                  value={homeQuery}
                  onChange={(e) => setHomeQuery(e.target.value)}
                />
              </div>

              <div>
                <div style={{ fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#9ca3af', marginBottom: '12px' }}>
                  Core ERP SoftN Apps ({installedApps.length} × React 18 + PHP 8 + XDB SQLite)
                </div>
                <div className="ws-home-grid">
                  {filteredHomeApps.map((app) => {
                    const isRunning = mountedApps.some((m) => m.id === app.id);
                    return (
                      <button
                        key={app.id}
                        type="button"
                        className="ws-app-tile"
                        data-home-app={app.slug}
                        onClick={() => openCoreApp(app)}
                      >
                        <div className="app-tile-icon" style={{ background: app.color }}>
                          {app.iconText}
                        </div>
                        <div style={{ fontWeight: 700, fontSize: '14px' }}>{app.name}</div>
                        <div style={{ fontSize: '11.5px', color: '#9ca3af', lineHeight: 1.35 }}>
                          {app.odooEquivalents.join(' · ')}
                        </div>
                        {isRunning && <span className="ws-app-running-tag">Running</span>}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <span style={{ fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#9ca3af' }}>
                    Turnkey SoftN Industry Packs (Mount Inside Parent Host)
                  </span>
                  <button type="button" className="ws-btn" onClick={() => fileInputRef.current?.click()}>
                    Upload Custom .softn
                  </button>
                </div>
                <div className="ws-home-grid">
                  {VERTICAL_PACKS.map((pack) => (
                    <button
                      key={pack.slug}
                      type="button"
                      className="ws-app-tile"
                      onClick={() => openVerticalPack(pack.file)}
                    >
                      <div className="app-tile-icon" style={{ background: pack.color }}>
                        {pack.name.slice(0, 2).toUpperCase()}
                      </div>
                      <div style={{ fontWeight: 700, fontSize: '13.5px' }}>{pack.name}</div>
                      <div style={{ fontSize: '11.5px', color: '#9ca3af' }}>{pack.category}</div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {mountedApps.map((app) => {
          const isVisible = !showHomeGrid && activeAppId === app.id;
          const backendUrl =
            backendMode === 'standalone' && app.supportsStandalone
              ? `/standalone/${app.slug}`
              : undefined;
          return (
            <SoftNAppFrame
              key={`${app.id}:${backendUrl ?? 'zipp'}`}
              appId={app.id}
              source={app.source}
              active={isVisible}
              backendUrl={backendUrl}
              onHandleReady={handleRegisterHandle}
            />
          );
        })}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".softn,.zip"
        style={{ display: 'none' }}
        onChange={(e) => void handleUploadCustomBundle(e)}
      />

      <AppStoreModal
        open={showAppStore}
        installedIds={installedIds}
        onClose={() => setShowAppStore(false)}
        onLaunch={openCoreApp}
        onInstall={(app) => {
          setInstalledIds((prev) => (prev.includes(app.id) ? prev : [...prev, app.id]));
          notify(`Installed ${app.name}`);
        }}
        onUninstall={(app) => {
          setInstalledIds((prev) => prev.filter((id) => id !== app.id));
          closeApp(app.id);
          notify(`Uninstalled ${app.name} from launcher`);
        }}
        onTriggerUpload={() => fileInputRef.current?.click()}
      />

      <CommandPalette
        open={showCommandPalette}
        mountedIds={mountedApps.map((m) => m.id)}
        backendMode={backendMode}
        onClose={() => setShowCommandPalette(false)}
        onOpenCoreApp={openCoreApp}
        onOpenPack={openVerticalPack}
        onToggleHome={() => setShowHomeGrid(true)}
        onToggleBackendMode={() => void toggleBackendMode()}
        onOpenAppStore={() => setShowAppStore(true)}
      />

      {toast && <div className="ws-toast">{toast}</div>}
    </div>
  );
};
