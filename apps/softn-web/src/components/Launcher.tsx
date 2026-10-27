import React, { useCallback, useRef } from 'react';
import { DEFAULT_URLS } from '@softn/brand';
import { currentBuildId, groupByApp, hasStoredData, holdsNothingOfItsOwn, isOfflineReady, type CachedApp } from '../lib/appCache';
import { DirectoryShelf } from './DirectoryShelf';

/*
 * The runtime's home: open a file, or come back to an app you had open. The
 * catalogue lives on the site's Apps page; this screen only points there. Drawn from the shared tokens so it
 * is the same surface as the site and the tools — the product bar above it
 * already says which product this is, so there is no second logo here.
 */
import './Launcher.css';

/** An app open in this runtime right now, behind the home screen. */
export interface RunningApp {
  id: string;
  name: string;
  icon?: string;
}

interface LauncherProps {
  apps: CachedApp[];
  /** Cache records an offline install is running for right now. */
  installing?: ReadonlySet<string>;
  /** Apps still running behind this screen; the way back to each, and the way to stop it. */
  running?: RunningApp[];
  onResume?: (id: string) => void;
  onStop?: (id: string) => void;
  onOpenFile: (file: File) => void | Promise<void>;
  onOpenCached: (app: CachedApp) => void;
  /** Open a directory bundle without leaving this runtime's running apps. */
  onOpenUrl?: (url: string) => void;
  onRemove: (id: string) => void;
  /** Save this build's records as a file. */
  onExportData: (app: CachedApp) => void;
  /** Replace this build's records with the records in a file exported here. */
  onImportData: (app: CachedApp, file: File) => void;
  /** Copy `from`'s saved records into `to`, then open `to`. */
  onAdoptData: (from: CachedApp, to: CachedApp) => void;
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHrs = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHrs < 24) return `${diffHrs}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}

/**
 * What a card says about opening its app without a connection.
 *
 * "Offline ready" is the install's claim, and only against the build that
 * made it — a record installed before a deployment names chunks the new
 * shell does not, so it reads as needing a connection until the app is
 * opened online again (see isOfflineReady). "Needs connection" is also what
 * a never-installed record says: the bundle is here, the code to render
 * every route of it may not be.
 */
function offlineStatus(
  app: CachedApp,
  installing: ReadonlySet<string> | undefined
): { state: 'ready' | 'installing' | 'needs-connection'; label: string; title: string } {
  if (installing?.has(app.id)) {
    return {
      state: 'installing',
      label: 'Installing…',
      title: 'Fetching what this app needs to open without a connection.',
    };
  }
  if (isOfflineReady(app)) {
    const online = app.offline?.optionalOnline ?? [];
    return {
      state: 'ready',
      label: 'Offline ready',
      title: online.includes('ai')
        ? 'Opens without a connection, with a model it has loaded before. A model it has not loaded yet is a download.'
        : 'Opens without a connection: everything it can reach is kept in this browser.',
    };
  }
  // Three different reasons, and they used to share one sentence: an install
  // that ran against this build and did not finish (the dev server has no
  // service worker, say) was described as "installed against an earlier
  // build", which sent people looking for an update that did not exist.
  let title: string;
  if (!app.offline) {
    title = 'Open it online once and the runtime fetches what it needs to open offline.';
  } else if (app.offline.build !== currentBuildId()) {
    title = 'Installed against an earlier build of the runtime. Opening it online installs it again.';
  } else {
    const why = app.offline.reason ? ` ${app.offline.reason.replace(/\.?$/, '.')}` : '';
    title = `The last offline install did not finish.${why} Opening it online tries again.`;
  }
  return { state: 'needs-connection', label: 'Needs connection', title };
}

export function Launcher({
  apps,
  installing,
  running = [],
  onResume,
  onStop,
  onOpenFile,
  onOpenCached,
  onOpenUrl,
  onRemove,
  onAdoptData,
  onExportData,
  onImportData,
}: LauncherProps): React.ReactElement {
  const fileInputRef = useRef<HTMLInputElement>(null);
  // The same place the product bar's "Apps" goes, so the two agree.
  const directoryHref = DEFAULT_URLS.apps;
  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        await onOpenFile(file);
      } finally {
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    },
    [onOpenFile]
  );

  const groups = groupByApp(apps);

  // One hidden picker for every card's "Import data…": the card it was
  // pressed on is remembered until the file arrives.
  const importInputRef = useRef<HTMLInputElement>(null);
  const importTargetRef = useRef<CachedApp | null>(null);
  const pickImport = (app: CachedApp): void => {
    importTargetRef.current = app;
    importInputRef.current?.click();
  };

  return (
    <>
      <input
        ref={importInputRef}
        type="file"
        accept=".json,application/json"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          const target = importTargetRef.current;
          importTargetRef.current = null;
          if (file && target) onImportData(target, file);
          if (importInputRef.current) importInputRef.current.value = '';
        }}
      />
      <div className="softn-launcher">
        <div className="softn-launcher-inner">
          <div className="softn-launcher-head">
            <div>
              {/* Focusable, so returning Home from an app puts keyboard focus here
                  rather than on <body> (see App's focus effect). */}
              <h1 className="softn-launcher-title" id="softn-workspace" tabIndex={-1}>Your app workspace</h1>
              <p className="softn-launcher-sub">
                Pick up a saved app, discover something from the directory, or open a <code>.softn</code> file.
                Your apps keep their data in this browser.
              </p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.875rem', flexWrap: 'wrap' }}>
              <input
                ref={fileInputRef}
                type="file"
                accept=".softn"
                onChange={handleFileSelect}
                style={{ display: 'none' }}
              />
              <button className="softn-launcher-open" type="button" onClick={() => fileInputRef.current?.click()}>
                Open a .softn file
              </button>
              <span className="softn-launcher-hint">or drop one anywhere on this page</span>
            </div>
          </div>

          {running.length > 0 && (
            // Apps take the whole screen while they run, so this is the way back
            // to one that is still going — and the way to stop it without
            // opening it first. Mint, because the thing behind each dot is
            // genuinely executing.
            <section className="softn-launcher-section" style={{ marginTop: 0 }} aria-label="Running now">
              <div className="softn-launcher-section-head">
                <h2 className="softn-launcher-section-title">Running now</h2>
                <span className="softn-launcher-section-count">{running.length}</span>
              </div>
              <div className="softn-launcher-running">
                {running.map((tab) => (
                  <div key={tab.id} className="softn-launcher-run">
                    <button
                      type="button"
                      className="softn-launcher-run-open"
                      onClick={() => onResume?.(tab.id)}
                      title={`Back to ${tab.name}`}
                    >
                      <span className="softn-launcher-run-dot" aria-hidden="true" />
                      {tab.icon ? <img src={tab.icon} alt="" className="softn-launcher-run-icon" /> : null}
                      <span className="softn-launcher-run-name">{tab.name}</span>
                    </button>
                    <button
                      type="button"
                      className="softn-launcher-run-stop"
                      onClick={() => onStop?.(tab.id)}
                      aria-label={`Stop ${tab.name}`}
                      title={`Stop ${tab.name}`}
                    >
                      &times;
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}

          {groups.length > 0 ? (
            <section className="softn-launcher-section" style={{ marginTop: running.length > 0 ? undefined : 0 }}>
              <div className="softn-launcher-section-head">
                <h2 className="softn-launcher-section-title">Your apps</h2>
                <span className="softn-launcher-section-count">{groups.length}</span>
              </div>
              <div className="softn-launcher-grid">
                {groups.map((group) => {
                  // One card per app. Every build the browser still holds sits
                  // behind it, because identity is the bundle's digest and a
                  // rebuild is genuinely a different app — correct for what it
                  // may read, and no reason to show the user four cards called
                  // Notes.
                  const app = group.current;
                  const olderVersions = group.versions.slice(1);
                  // The most recently used older build that holds records of its
                  // own: one opened once and never used holds only its seeds,
                  // and would be offered ahead of the one with the person's data.
                  const dataSource = olderVersions.find((v) => !holdsNothingOfItsOwn(v.origin));
                  const offline = offlineStatus(app, installing);
                  const describedBy = `softn-launcher-card-${app.id}`;
                  return (
                    // The card was a `role="button"` div holding real buttons
                    // — Remove, Export data, a version chip — and a button
                    // inside a button is announced as one control and is not
                    // valid HTML. Opening is a real button now, and the card's
                    // other controls are its siblings. The button's ::after
                    // covers the card (Launcher.css), so a press anywhere on it
                    // still opens the app, as it did.
                    <div key={app.id} className="softn-launcher-card">
                      <button
                        type="button"
                        className="softn-launcher-card-open"
                        aria-label={`Open ${app.name}`}
                        aria-describedby={describedBy}
                        onClick={() => onOpenCached(app)}
                      >
                        {/* Phrasing content only, as a button may hold. */}
                        <span className="softn-launcher-card-row">
                          <span className="softn-launcher-icon">
                            {app.icon ? <img src={app.icon} alt="" /> : <span>{app.name.charAt(0).toUpperCase()}</span>}
                          </span>
                          <span style={{ minWidth: 0 }}>
                            <span className="softn-launcher-card-name">{app.name}</span>
                            <span className="softn-launcher-card-meta">v{app.version}</span>
                          </span>
                        </span>
                        <span id={describedBy} className="softn-launcher-card-text">
                          {/* The manifest's own words, cached as they came: one written
                              as `{ "en": "…" }` threw here, and Home, and with it the
                              whole runtime, went blank on every load. */}
                          {typeof app.description === 'string' && app.description && (
                            <span className="softn-launcher-card-desc">{app.description}</span>
                          )}
                          <span className="softn-launcher-card-foot">
                            Opened {formatDate(app.lastOpened).toLowerCase()}{' '}
                            <span className="softn-launcher-offline" data-state={offline.state} title={offline.title}>
                              {offline.label}
                            </span>
                          </span>
                        </span>
                      </button>

                      <button
                        className="softn-launcher-remove"
                        type="button"
                        onClick={() => onRemove(app.id)}
                        title={`Remove ${app.name} from this browser`}
                        aria-label={`Remove ${app.name}`}
                      >
                        &times;
                      </button>

                      {/* A build's records as a file: to keep, to move, to put
                          back. Import replaces, whole or not at all, and never
                          leaves an app emptier than the file it was given. */}
                      <div className="softn-launcher-data">
                        {hasStoredData(app.origin) && (
                          <button
                            type="button"
                            className="softn-launcher-data-btn"
                            onClick={() => onExportData(app)}
                            title={`Save the records of v${app.version} as a file you can keep or move to another browser`}
                          >
                            Export data
                          </button>
                        )}
                        <button
                          type="button"
                          className="softn-launcher-data-btn"
                          onClick={() => pickImport(app)}
                          title={`Replace the records of v${app.version} with a file exported here`}
                        >
                          Import data…
                        </button>
                      </div>

                      {olderVersions.length > 0 && (
                        // Earlier builds, in the same place rather than as cards
                        // of their own. Each keeps its own records — that is what
                        // makes going back to one meaningful rather than just
                        // older code.
                        <div className="softn-launcher-versions">
                          <div className="softn-launcher-versions-label">Earlier versions</div>
                          <div className="softn-launcher-chips">
                            {olderVersions.map((older) => (
                              // Open on the left, remove on the right, so an old
                              // build can be cleared out rather than accumulating
                              // for ever — these are whole bundles, and six
                              // releases of one app is six full copies.
                              <span key={older.id} className="softn-launcher-chip">
                                <button
                                  type="button"
                                  onClick={() => onOpenCached(older)}
                                  title={`Open v${older.version} — its own saved data comes with it`}
                                >
                                  {/* Two builds can carry the same version string —
                                      a rebuild without a version bump is the common
                                      case — and "v1.0.0" twice tells the user
                                      nothing about which is which. When the version
                                      does not distinguish them, when it was last
                                      opened does. */}
                                  v{older.version}
                                  {older.version === app.version ? ` · ${formatDate(older.lastOpened)}` : ''}
                                  {hasStoredData(older.origin) ? ' · has data' : ''}
                                </button>
                                {/* Removing one asks the person to export its data
                                    first, so its data can be exported from here. */}
                                {hasStoredData(older.origin) && (
                                  <button
                                    type="button"
                                    onClick={() => onExportData(older)}
                                    aria-label={`Export the data of version ${older.version}`}
                                    title={`Save the records of v${older.version} as a file you can keep or move to another browser`}
                                  >
                                    &#x2913;
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => onRemove(older.id)}
                                  aria-label={
                                    hasStoredData(older.origin)
                                      ? `Remove version ${older.version} and the data saved in it`
                                      : `Remove version ${older.version}`
                                  }
                                  title={
                                    hasStoredData(older.origin)
                                      ? 'Remove this version. Anything saved in it goes too.'
                                      : 'Remove this version'
                                  }
                                >
                                  &times;
                                </button>
                              </span>
                            ))}
                          </div>

                          {/* Carrying records forward is the one thing rollback
                              cannot do for you, and the runtime will not do it
                              unasked: nothing proves two bundles share an author.
                              Offered only while this build holds nothing of its
                              own: nothing at all, or only the sample records its
                              bundle seeded as it opened, which bringing the data
                              forward replaces (the person is asked first). */}
                          {holdsNothingOfItsOwn(app.origin) && dataSource && (
                            <button
                              type="button"
                              className="softn-launcher-adopt"
                              onClick={() => onAdoptData(dataSource, app)}
                              title={`Copy the records saved under v${dataSource.version} into this version. The older one keeps its own copy.`}
                            >
                              Bring my data forward from v{dataSource.version}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          ) : (
            <div className="softn-launcher-empty">
              <strong>Your library starts here.</strong> Apps you open appear here so you can return to them.
              Open a <strong>.softn</strong> file or choose an app from <a href={directoryHref}>the directory</a>.
            </div>
          )}
          {onOpenUrl && <DirectoryShelf onOpen={onOpenUrl} />}
        </div>
      </div>
    </>
  );
}
