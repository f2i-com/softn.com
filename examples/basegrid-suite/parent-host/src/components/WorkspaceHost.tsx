import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { SoftNContainerHandle } from '@softn/container';
import { BASEGRID_APPS, type BaseGridAppDef } from '../data/suiteCatalog';
import { SoftNAppFrame } from './SoftNAppFrame';

interface WorkspaceHostProps {
  initialAppId?: string;
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
  onBackToSite,
}) => {
  const [mountedApps, setMountedApps] = useState<MountedAppEntry[]>([]);
  const [activeAppId, setActiveAppId] = useState<string | null>(null);
  const [showHomeGrid, setShowHomeGrid] = useState(true);
  const [homeQuery, setHomeQuery] = useState('');
  const [backendMode, setBackendMode] = useState<'zipp' | 'standalone'>('zipp');
  const [standaloneOnline, setStandaloneOnline] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState<string | null>(null);

  const handlesRef = useRef<Map<string, SoftNContainerHandle>>(new Map());
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((prev) => (prev === msg ? null : prev)), 3200);
  }, []);

  const checkStandaloneStatus = useCallback(async () => {
    try {
      const resp = await fetch('/api/standalone-status');
      if (resp.ok) {
        const data = (await resp.json()) as { servers?: Record<string, boolean> };
        if (data.servers) setStandaloneOnline(data.servers);
      }
    } catch {
      // ignore offline
    }
  }, []);

  useEffect(() => {
    void checkStandaloneStatus();
  }, [checkStandaloneStatus]);

  const openCoreApp = useCallback((app: BaseGridAppDef) => {
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
  }, []);

  useEffect(() => {
    if (initialAppId) {
      const found = BASEGRID_APPS.find((a) => a.id === initialAppId || a.slug === initialAppId);
      if (found) openCoreApp(found);
    }
  }, [initialAppId, openCoreApp]);

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
        notify('SQLite .db export is available in local ZIPP XDB WASM mode.');
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
      notify(`Exported ${activeAppId}.sqlite3 (${(bytes.byteLength / 1024).toFixed(1)} KB)`);
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
        shortName: cleanName.slice(0, 15),
        color: '#475569',
        iconText: cleanName.slice(0, 2).toUpperCase(),
        source: bytes,
        supportsStandalone: false,
      },
    ]);
    setActiveAppId(id);
    setShowHomeGrid(false);
    e.target.value = '';
    notify(`Mounted custom .softn container: ${file.name}`);
  };

  const toggleBackendMode = async () => {
    if (backendMode === 'zipp') {
      await checkStandaloneStatus();
      const anyUp = Object.values(standaloneOnline).some(Boolean);
      setBackendMode('standalone');
      notify(
        anyUp
          ? 'Switched to Standalone Native PHP 8 + WAL SQLite servers'
          : 'Standalone PHP mode enabled — start `node examples/basegrid-suite/serve-php.mjs` to connect native PHP servers.'
      );
    } else {
      setBackendMode('zipp');
      notify('Switched to Embedded ZIPP PHP 8 WASM + XDB SQLite (zero server)');
    }
  };

  const activeEntry = mountedApps.find((m) => m.id === activeAppId) ?? null;
  const filteredApps = BASEGRID_APPS.filter(
    (a) =>
      !homeQuery.trim() ||
      a.name.toLowerCase().includes(homeQuery.toLowerCase()) ||
      a.tagline.toLowerCase().includes(homeQuery.toLowerCase()) ||
      a.airtableEquivalents.some((eq) => eq.toLowerCase().includes(homeQuery.toLowerCase()))
  );

  return (
    <div className="ws-shell">
      <header className="ws-topbar">
        <div className="ws-left">
          <button
            id="ws-home-grid-btn"
            type="button"
            className={`ws-grid-btn ${showHomeGrid ? 'active' : ''}`}
            title="BaseGrid App Switcher"
            onClick={() => setShowHomeGrid((v) => !v)}
          >
            ⊞
          </button>

          <strong className="ws-brand-text">BaseGrid OS</strong>

          <div className="ws-tabs" role="tablist" aria-label="Running BaseGrid SoftN containers">
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
            id="backend-mode-toggle"
            type="button"
            className={`ws-btn ${backendMode === 'zipp' ? 'active' : ''}`}
            onClick={() => void toggleBackendMode()}
            title="Switch between In-Browser ZIPP PHP WASM and Standalone PHP hosting"
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

          <button type="button" className="ws-btn" onClick={() => fileInputRef.current?.click()}>
            + Mount .softn
          </button>

          <button type="button" className="ws-btn" onClick={onBackToSite}>
            ← BaseGrid Site
          </button>
        </div>
      </header>

      <input
        ref={fileInputRef}
        type="file"
        accept=".softn,.zip"
        style={{ display: 'none' }}
        onChange={(e) => void handleUploadCustomBundle(e)}
      />

      <div className="ws-body">
        {showHomeGrid && (
          <div className="ws-home">
            <div className="ws-home-inner">
              <div className="ws-home-header">
                <div>
                  <h1>BaseGrid Internal Parent Workspace</h1>
                  <p>
                    {BASEGRID_APPS.length} portable Airtable-alternative SoftN apps · {mountedApps.length} active in
                    keep-alive containers ·{' '}
                    {backendMode === 'zipp'
                      ? 'Running locally via ZIPP PHP 8 WASM + XDB SQLite'
                      : 'Connected to Standalone Native PHP 8 servers'}
                  </p>
                </div>
                <input
                  className="ws-home-search"
                  type="search"
                  placeholder="Filter apps (Grid, Kanban, Forms, Omni, Portals...)"
                  value={homeQuery}
                  onChange={(e) => setHomeQuery(e.target.value)}
                />
              </div>

              <div className="ws-home-grid">
                {filteredApps.map((app) => {
                  const isRunning = mountedApps.some((m) => m.id === app.id);
                  const isStandaloneUp = Boolean(standaloneOnline[app.slug]);
                  return (
                    <button
                      key={app.id}
                      type="button"
                      className="ws-app-card"
                      data-home-app={app.slug}
                      onClick={() => openCoreApp(app)}
                    >
                      <div className="ws-app-card-head">
                        <div className="ws-app-icon" style={{ background: app.color }}>
                          {app.iconText}
                        </div>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                          {isRunning && <span className="ws-running-pill">● Running</span>}
                          {backendMode === 'standalone' && (
                            <span className={`ws-status-pill ${isStandaloneUp ? 'up' : 'down'}`}>
                              {isStandaloneUp ? 'PHP Online' : 'PHP Offline'}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="ws-app-title">{app.name}</div>
                      <div className="ws-app-desc">{app.tagline}</div>

                      <div className="ws-app-tags">
                        {app.airtableEquivalents.slice(0, 4).map((eq) => (
                          <span key={eq} className="ws-eq-tag">{eq}</span>
                        ))}
                      </div>

                      <div className="ws-app-foot">
                        <span>{app.bundleFile}</span>
                        <span style={{ color: '#93c5fd', fontWeight: 700 }}>Open App →</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Keep-alive mounted SoftN v2 containers */}
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

      {toast && <div className="ws-toast">{toast}</div>}
    </div>
  );
};
