import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ThemeProvider, Spinner, Box, Text } from '@softn/components';
import { DropZone } from './components/DropZone';
import { Launcher } from './components/Launcher';
import { AppRunner } from './components/AppRunner';
import { TabBar } from './components/TabBar';
import { PermissionPrompt } from './components/PermissionPrompt';
import type { PermissionConfig } from '@softn/core';

const appShellStyles = `
  @keyframes softn-shell-fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @keyframes softn-shell-slide-up {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .softn-shell {
    --softn-tab-bar-height: 38px;
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }
  .softn-shell-loading {
    animation: softn-shell-fade-in 300ms cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  .softn-shell-error {
    animation: softn-shell-slide-up 350ms cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  .softn-shell-error-card {
    transition: box-shadow 250ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .softn-shell-error-card:hover {
    box-shadow: 0 8px 32px rgba(239, 68, 68, 0.08), 0 0 0 1px rgba(239, 68, 68, 0.2);
  }
  .softn-shell-error-btn {
    transition: all 180ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .softn-shell-error-btn:hover {
    background: #3a3a44 !important;
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
  }
  .softn-shell-error-btn:active {
    transform: translateY(0) scale(0.98);
  }
  @media (max-width: 640px) {
    .softn-shell {
      --softn-tab-bar-height: 34px;
    }
  }
`;
import {
  readZip,
  loadXDBData,
  processBundle,
  createImportResolver,
  extractIconDataUrl,
  extractPermissions,
  type BundleManifest,
} from './lib/bundleProcessor';
import {
  getCachedApps,
  cacheApp,
  getCachedAppByName,
  removeCachedApp,
  updateLastOpened,
  updateGrantedPermissions,
  type CachedApp,
} from './lib/appCache';

// ── URL Routing Helpers ──────────────────────────────────────────

function parseAppUrl(): { appName: string | null; page: string | null } {
  const path = window.location.pathname;
  const match = path.match(/^\/app\/([^/]+)(?:\/(.+))?$/);
  if (!match) return { appName: null, page: null };
  return {
    appName: decodeURIComponent(match[1]),
    page: match[2] ? decodeURIComponent(match[2]) : null,
  };
}

function buildAppUrl(appName: string | null, page?: string | null): string {
  if (!appName) return '/';
  let url = `/app/${encodeURIComponent(appName)}`;
  if (page) url += `/${encodeURIComponent(page)}`;
  return url;
}

// ── Types ────────────────────────────────────────────────────────

interface OpenTab {
  id: string;
  name: string;
  source: string; // empty string = skeleton tab (loading)
  icon?: string;
  initialPage?: string;
  permissions?: import('@softn/core').AppPermissions;
  permissionConfig?: PermissionConfig;
  importResolver?: (path: string) => Promise<string | null>;
  logicBasePath?: string;
}

// ── App Component ────────────────────────────────────────────────

function App(): React.ReactElement {
  // Parse URL once for initial state
  const [urlInit] = useState(() => parseAppUrl());
  // Pre-create a skeleton tab ID if loading from URL (so tab bar shows immediately)
  const [urlTabId] = useState(() => (urlInit.appName ? crypto.randomUUID() : null));

  const [openTabs, setOpenTabs] = useState<OpenTab[]>(() => {
    // Pre-populate tab from URL so it appears in tab bar instantly on reload
    if (urlInit.appName && urlTabId) {
      return [{
        id: urlTabId,
        name: urlInit.appName,
        source: '', // empty = still loading
        initialPage: urlInit.page || undefined,
      }];
    }
    return [];
  });
  const [activeTabId, setActiveTabId] = useState<string | null>(urlTabId); // skeleton tab or Home
  const [apps, setApps] = useState<CachedApp[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [loadingTabId, setLoadingTabId] = useState<string | null>(null);
  const [loadingFileName, setLoadingFileName] = useState('');
  const [pendingPermission, setPendingPermission] = useState<{
    config: PermissionConfig;
    appName: string;
    appIcon?: string;
    onAllow: () => void;
    onDeny: () => void;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const openTabsRef = useRef(openTabs);
  openTabsRef.current = openTabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  // URL routing state
  const tabPagesRef = useRef<Record<string, string>>({}); // tabId → current page
  const urlReadyRef = useRef(false); // true after initial URL parsing
  const skipNextUrlPushRef = useRef(false); // skip URL push after popstate

  // Load cached apps on mount
  useEffect(() => {
    getCachedApps().then(setApps).catch(console.error);
  }, []);

  // Update document title when active tab changes
  useEffect(() => {
    if (activeTabId === null) {
      document.title = 'SoftN Web';
    } else {
      const tab = openTabs.find((t) => t.id === activeTabId);
      if (tab) document.title = tab.name;
    }
  }, [activeTabId, openTabs]);

  /** Process a .softn bundle from raw bytes */
  const processBundleData = useCallback(
    async (data: Uint8Array, fileName: string, cachedAppId?: string, initialPage?: string) => {
      try {
        setError(null);

        const { textFiles, binaryFiles } = readZip(data);

        const manifestContent = textFiles.get('manifest.json');
        if (!manifestContent) {
          throw new Error('Bundle missing manifest.json');
        }

        let manifest: BundleManifest;
        try {
          manifest = JSON.parse(manifestContent);
        } catch {
          throw new Error('Invalid manifest.json: not valid JSON');
        }

        // Validate required manifest fields
        if (!manifest.name || typeof manifest.name !== 'string') {
          throw new Error('Invalid manifest.json: missing or invalid "name"');
        }
        if (!manifest.main || typeof manifest.main !== 'string') {
          throw new Error('Invalid manifest.json: missing or invalid "main"');
        }
        if (manifest.name.length > 255) {
          throw new Error('Invalid manifest.json: name exceeds 255 characters');
        }

        const appName = manifest.name || fileName.replace(/\.softn$/, '');

        // Check if a tab with this name already exists (use ref for fresh value)
        const existingTab = openTabsRef.current.find((t) => t.name === appName);
        if (existingTab && existingTab.source) {
          // Already fully loaded — just switch to it
          setActiveTabId(existingTab.id);
          return;
        }

        // Use existing skeleton tab ID (from URL pre-populate) or create new
        const tabId = existingTab?.id || crypto.randomUUID();

        if (!existingTab) {
          // Fresh open (not from URL) — show loading overlay
          setLoadingTabId(tabId);
          setLoadingFileName(appName);
          setActiveTabId(null); // Show loading on Home
        }

        // Extract permission config from permission.json or manifest.permissions
        const permissionConfig = extractPermissions(textFiles, manifest);

        // Extract icon early (needed for permission prompt)
        const icon = extractIconDataUrl(binaryFiles, manifest);

        // Check if permissions are declared and need consent
        if (permissionConfig) {
          // Look up cached app to check for prior grant
          const cachedApp = await getCachedAppByName(appName);
          const hasGrant = cachedApp?.grantedPermissions && cachedApp.permissionsPromptedAt;

          if (!hasGrant) {
            // Show permission prompt and wait for user decision
            const userDecision = await new Promise<boolean>((resolve) => {
              setPendingPermission({
                config: permissionConfig,
                appName,
                appIcon: icon,
                onAllow: () => {
                  setPendingPermission(null);
                  resolve(true);
                },
                onDeny: () => {
                  setPendingPermission(null);
                  resolve(false);
                },
              });
            });

            if (!userDecision) {
              // User denied — clean up and show error
              setLoadingTabId(null);
              setLoadingFileName('');
              // Remove skeleton tab if it was created for URL
              if (existingTab && !existingTab.source) {
                setOpenTabs((prev) => prev.filter((t) => t.id !== tabId));
              }
              setActiveTabId(null);
              setError(new Error(`Permission denied: "${appName}" was not granted the requested permissions.`));
              return;
            }

            // User allowed — store grant in cache
            const grantedPerms: Record<string, boolean> = {};
            const perms = permissionConfig.permissions;
            if (perms.net?.enabled) grantedPerms['net'] = true;
            if (perms.camera?.enabled) grantedPerms['camera'] = true;
            if (perms.files?.enabled) grantedPerms['files'] = true;
            if (perms.qr?.enabled) grantedPerms['qr'] = true;

            // Cache the app first so we have an ID to store grants against
            const cached = await cacheApp(data, manifest, icon);
            if (cached) {
              await updateGrantedPermissions(cached.id, grantedPerms);
            }
          }
        }

        // Load XDB data (per-app isolation)
        await loadXDBData(textFiles, manifest, manifest.name);

        // Process source
        const { source, logicBasePath } = processBundle(textFiles, manifest);
        const importResolver = createImportResolver(textFiles);

        // Cache the app (may already be cached from permission flow above, cacheApp handles dedup by name)
        await cacheApp(data, manifest, icon);

        if (cachedAppId) {
          await updateLastOpened(cachedAppId);
        }

        // Refresh cached apps list
        const updatedApps = await getCachedApps();
        setApps(updatedApps);

        // Create or update the tab
        const newTab: OpenTab = {
          id: tabId,
          name: appName,
          source,
          icon: icon || undefined,
          initialPage: initialPage || existingTab?.initialPage,
          permissions: manifest.permissions,
          permissionConfig: permissionConfig || undefined,
          importResolver,
          logicBasePath,
        };
        setOpenTabs((prev) => {
          const idx = prev.findIndex((t) => t.id === tabId);
          if (idx !== -1) {
            // Update skeleton tab in-place
            return prev.map((t) => (t.id === tabId ? newTab : t));
          }
          return [...prev, newTab];
        });
        setActiveTabId(tabId);
        setLoadingTabId(null);
        setLoadingFileName('');
      } catch (err) {
        console.error('[SoftN Web] Failed to load bundle:', err);
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoadingTabId(null);
        setLoadingFileName('');
      }
    },
    []
  );

  /** Handle file from picker or drag-drop */
  const handleOpenFile = useCallback(
    (data: Uint8Array, fileName: string) => {
      processBundleData(data, fileName);
    },
    [processBundleData]
  );

  /** Handle opening a cached app */
  const handleOpenCached = useCallback(
    (app: CachedApp) => {
      // Check if already open (use ref for fresh value)
      const existingTab = openTabsRef.current.find((t) => t.name === app.name);
      if (existingTab) {
        setActiveTabId(existingTab.id);
        return;
      }
      processBundleData(app.bundleData, `${app.name}.softn`, app.id);
    },
    [processBundleData]
  );

  /** Handle removing a cached app */
  const handleRemove = useCallback(async (id: string) => {
    await removeCachedApp(id);
    const updatedApps = await getCachedApps();
    setApps(updatedApps);
  }, []);

  /** Close a tab */
  const handleCloseTab = useCallback(
    (tabId: string) => {
      // Clean up page tracking
      delete tabPagesRef.current[tabId];

      setOpenTabs((prev) => {
        const idx = prev.findIndex((t) => t.id === tabId);
        if (idx === -1) return prev;
        const next = prev.filter((t) => t.id !== tabId);
        // If we're closing the active tab, activate the nearest neighbor or Home
        if (activeTabIdRef.current === tabId) {
          if (next.length === 0) {
            setActiveTabId(null);
          } else if (idx < next.length) {
            setActiveTabId(next[idx].id);
          } else {
            setActiveTabId(next[next.length - 1].id);
          }
        }
        return next;
      });
    },
    []
  );

  /** Select a tab */
  const handleSelectTab = useCallback((id: string | null) => {
    setActiveTabId(id);
    setError(null);
  }, []);

  /** "+" button triggers file input */
  const handleAddTab = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  /** File input change handler */
  const handleFileInputChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const buffer = await file.arrayBuffer();
        handleOpenFile(new Uint8Array(buffer), file.name);
      } catch (err) {
        console.error('[SoftN Web] Failed to read file:', err);
        setError(err instanceof Error ? err : new Error('Failed to read file'));
      } finally {
        // Always reset so same file can be re-selected
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    },
    [handleOpenFile]
  );

  /** Called by AppRunner when an app's currentPage changes */
  const handlePageChange = useCallback((tabId: string, page: string) => {
    tabPagesRef.current[tabId] = page;
    // Update URL (replace, not push — page changes don't create history entries)
    if (activeTabIdRef.current === tabId) {
      const tab = openTabsRef.current.find((t) => t.id === tabId);
      if (tab) {
        const url = buildAppUrl(tab.name, page);
        if (window.location.pathname !== url) {
          window.history.replaceState({}, '', url);
        }
      }
    }
  }, []);

  // ── URL Routing: Load app from URL on mount ───────────────────

  useEffect(() => {
    if (urlInit.appName) {
      getCachedAppByName(urlInit.appName).then((cachedApp) => {
        if (cachedApp) {
          processBundleData(cachedApp.bundleData, `${cachedApp.name}.softn`, cachedApp.id, urlInit.page || undefined);
        } else {
          // App not in cache — remove skeleton tab and go Home
          setOpenTabs([]);
          setActiveTabId(null);
          window.history.replaceState({}, '', '/');
        }
        urlReadyRef.current = true;
      });
    } else {
      urlReadyRef.current = true;
    }
  }, [processBundleData, urlInit]);

  // ── URL Routing: Sync activeTabId → URL ──────────────────────

  useEffect(() => {
    if (!urlReadyRef.current) return;
    if (skipNextUrlPushRef.current) {
      skipNextUrlPushRef.current = false;
      return;
    }

    let url = '/';
    if (activeTabId) {
      const tab = openTabs.find((t) => t.id === activeTabId);
      if (tab) {
        const page = tabPagesRef.current[activeTabId];
        url = buildAppUrl(tab.name, page);
      }
    }

    if (window.location.pathname !== url) {
      window.history.pushState({}, '', url);
    }
  }, [activeTabId, openTabs]);

  // ── URL Routing: Browser back/forward ────────────────────────

  useEffect(() => {
    const handlePopState = () => {
      const { appName } = parseAppUrl();
      skipNextUrlPushRef.current = true;

      if (!appName) {
        setActiveTabId(null);
        return;
      }

      // Find open tab with matching name
      const tab = openTabsRef.current.find((t) => t.name === appName);
      if (tab) {
        setActiveTabId(tab.id);
      } else {
        // App not open as a tab — go Home
        setActiveTabId(null);
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Refresh cached apps when returning to Home
  useEffect(() => {
    if (activeTabId === null) {
      getCachedApps().then(setApps).catch(console.error);
    }
  }, [activeTabId]);

  const isHome = activeTabId === null;

  return (
    <DropZone onFile={handleOpenFile}>
      <style dangerouslySetInnerHTML={{ __html: appShellStyles }} />
      {/* Hidden file input for the + button */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".softn"
        onChange={handleFileInputChange}
        style={{ display: 'none' }}
      />

      <div className="softn-shell">
        <TabBar
          tabs={openTabs.map((t) => ({ id: t.id, name: t.name, icon: t.icon }))}
          activeTabId={activeTabId}
          onSelectTab={handleSelectTab}
          onCloseTab={handleCloseTab}
          onAddTab={handleAddTab}
        />

        {/* Content area below tab bar */}
        <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
          {/* Loading indicator (for non-URL opens that don't have skeleton tabs) */}
          {loadingTabId && (
            <ThemeProvider followSystem>
              <Box
                className="softn-shell-loading"
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  justifyContent: 'center',
                  alignItems: 'center',
                  flexDirection: 'column',
                  gap: '1rem',
                  background: '#0c0c0e',
                  zIndex: 10,
                }}
              >
                <Spinner size="lg" />
                <Text style={{ color: '#5a5a66', fontSize: '0.875rem', letterSpacing: '-0.01em' }}>Loading {loadingFileName}...</Text>
              </Box>
            </ThemeProvider>
          )}

          {/* Permission consent prompt */}
          {pendingPermission && (
            <PermissionPrompt
              appName={pendingPermission.appName}
              appIcon={pendingPermission.appIcon}
              permissions={pendingPermission.config}
              onAllow={pendingPermission.onAllow}
              onDeny={pendingPermission.onDeny}
            />
          )}

          {/* Error state */}
          {error && !loadingTabId && (
            <ThemeProvider followSystem>
              <div
                className="softn-shell-error"
                style={{
                  position: 'absolute',
                  inset: 0,
                  padding: '2rem',
                  background: '#0c0c0e',
                  zIndex: 10,
                  overflow: 'auto',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <div
                  className="softn-shell-error-card"
                  style={{
                    padding: '2rem',
                    background: '#16161a',
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                    borderRadius: '14px',
                    maxWidth: '480px',
                    width: '100%',
                    boxShadow: '0 4px 24px rgba(0, 0, 0, 0.3)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
                    <div style={{
                      width: '36px',
                      height: '36px',
                      borderRadius: '10px',
                      background: 'rgba(239, 68, 68, 0.1)',
                      border: '1px solid rgba(239, 68, 68, 0.15)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="15" y1="9" x2="9" y2="15" />
                        <line x1="9" y1="9" x2="15" y2="15" />
                      </svg>
                    </div>
                    <div style={{
                      color: '#ececf0',
                      fontWeight: 600,
                      fontSize: '1.0625rem',
                      letterSpacing: '-0.02em',
                    }}>
                      Failed to load application
                    </div>
                  </div>
                  <div style={{
                    color: '#7a7a86',
                    fontSize: '0.8125rem',
                    lineHeight: 1.6,
                    padding: '0.75rem 1rem',
                    background: 'rgba(255, 255, 255, 0.02)',
                    borderRadius: '8px',
                    border: '1px solid rgba(255, 255, 255, 0.04)',
                    fontFamily: 'monospace',
                    wordBreak: 'break-word',
                  }}>
                    {error.message}
                  </div>
                  <button
                    className="softn-shell-error-btn"
                    onClick={() => {
                      setError(null);
                      setActiveTabId(null);
                    }}
                    style={{
                      marginTop: '1.25rem',
                      padding: '0.5rem 1.25rem',
                      background: '#1e1e23',
                      color: '#ececf0',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      fontSize: '0.8125rem',
                      fontWeight: 500,
                      letterSpacing: '-0.01em',
                    }}
                  >
                    Back to Home
                  </button>
                </div>
              </div>
            </ThemeProvider>
          )}

          {/* Home / Launcher */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              overflow: 'auto',
              display: isHome && !loadingTabId && !error ? 'block' : 'none',
            }}
          >
            <Launcher
              apps={apps}
              onOpenFile={handleOpenFile}
              onOpenCached={handleOpenCached}
              onRemove={handleRemove}
            />
          </div>

          {/* All open app tabs — stay mounted, toggled via display */}
          {openTabs.map((tab) => (
            <AppRunner
              key={tab.id}
              source={tab.source}
              appName={tab.name}
              active={activeTabId === tab.id && !error}
              initialPage={tab.initialPage}
              permissions={tab.permissions}
              importResolver={tab.importResolver}
              logicBasePath={tab.logicBasePath}
              onPageChange={(page) => handlePageChange(tab.id, page)}
            />
          ))}
        </div>
      </div>
    </DropZone>
  );
}

export default App;
