import React, { useCallback, useRef } from 'react';
import { DEFAULT_URLS } from '@softn/brand';
import { groupByApp, hasStoredData, type CachedApp } from '../lib/appCache';

/*
 * The runtime's home: open a file, or come back to an app you had open. The
 * catalogue lives on the site's Apps page; this screen only points there. Drawn from the shared tokens so it
 * is the same surface as the site and the tools — the product bar above it
 * already says which product this is, so there is no second logo here.
 */
const launcherStyles = `
  @keyframes softn-launcher-fade-up {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .softn-launcher {
    min-height: 100%;
    background: var(--ink);
    color: var(--paper);
    font-family: var(--body);
    padding: clamp(1.5rem, 4vw, 3rem) var(--gutter) 4rem;
  }
  .softn-launcher-inner {
    max-width: 1040px;
    margin: 0 auto;
  }
  .softn-launcher-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 1.5rem;
    flex-wrap: wrap;
    margin-bottom: 2rem;
    animation: softn-launcher-fade-up 400ms var(--ease) both;
  }
  .softn-launcher-title {
    font-family: var(--display);
    font-weight: 700;
    font-size: clamp(1.625rem, 3vw, 2.25rem);
    line-height: 1.05;
    letter-spacing: -0.03em;
  }
  .softn-launcher-sub {
    margin-top: 0.5rem;
    color: var(--dim);
    font-size: 0.9375rem;
    max-width: 40rem;
  }
  .softn-launcher-sub a,
  .softn-launcher-empty a {
    color: var(--paper);
    text-decoration: underline;
    text-decoration-color: var(--dimmer);
    text-underline-offset: 3px;
  }
  .softn-launcher-sub a:hover,
  .softn-launcher-empty a:hover { text-decoration-color: var(--paper); }
  .softn-launcher-sub code {
    font-family: var(--mono);
    font-size: 0.875em;
    color: var(--coral);
  }
  .softn-launcher-open {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 2.75rem;
    padding: 0 1.125rem;
    border-radius: 8px;
    border: 1px solid var(--paper);
    background: var(--paper);
    color: var(--ink);
    font: inherit;
    font-weight: 600;
    font-size: 0.875rem;
    cursor: pointer;
    white-space: nowrap;
    transition: background 160ms var(--ease), border-color 160ms var(--ease);
  }
  .softn-launcher-open:hover { background: var(--invert-hover); border-color: var(--invert-hover); }
  .softn-launcher-open:focus-visible { outline: 2px solid var(--mint); outline-offset: 3px; }
  .softn-launcher-hint {
    color: var(--dimmer);
    font-size: 0.8125rem;
  }
  .softn-launcher-section {
    margin-top: 2.5rem;
    animation: softn-launcher-fade-up 400ms var(--ease) 80ms both;
  }
  .softn-launcher-section-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 0.875rem;
  }
  .softn-launcher-section-title {
    font-family: var(--display);
    font-weight: 700;
    font-size: 1.125rem;
    letter-spacing: -0.02em;
  }
  .softn-launcher-section-count {
    font-family: var(--mono);
    font-size: 0.75rem;
    color: var(--dimmer);
  }
  .softn-launcher-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
    gap: 0.75rem;
  }
  .softn-launcher-card {
    position: relative;
    display: flex;
    flex-direction: column;
    background: var(--ink-2);
    border: 1px solid var(--line-soft);
    border-radius: 12px;
    padding: 1rem;
    cursor: pointer;
    transition: border-color 160ms var(--ease), background 160ms var(--ease);
  }
  .softn-launcher-card:hover {
    border-color: var(--line-strong);
    background: var(--ink-3);
  }
  .softn-launcher-card:focus-visible {
    outline: 2px solid var(--mint);
    outline-offset: 3px;
  }
  .softn-launcher-card-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-width: 0;
  }
  .softn-launcher-icon {
    position: relative;
    width: 40px;
    height: 40px;
    border-radius: 10px;
    flex-shrink: 0;
    overflow: hidden;
    background: var(--ink-3);
    border: 1px solid var(--line-soft);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .softn-launcher-icon img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .softn-launcher-icon span {
    font-family: var(--display);
    font-weight: 700;
    font-size: 1rem;
    color: var(--paper);
  }
  .softn-launcher-card-name {
    font-weight: 600;
    font-size: 0.9375rem;
    letter-spacing: -0.01em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .softn-launcher-card-meta {
    margin-top: 2px;
    font-family: var(--mono);
    font-size: 0.6875rem;
    color: var(--dimmer);
  }
  .softn-launcher-card-desc {
    margin-top: 0.75rem;
    font-size: 0.8125rem;
    color: var(--dim);
    line-height: 1.5;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .softn-launcher-card-foot {
    margin-top: auto;
    padding-top: 0.75rem;
    font-size: 0.75rem;
    color: var(--dimmer);
  }
  .softn-launcher-remove {
    position: absolute;
    top: 8px;
    right: 8px;
    width: 26px;
    height: 26px;
    background: transparent;
    border: none;
    color: transparent;
    font: inherit;
    font-size: 1rem;
    cursor: pointer;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: color 160ms var(--ease), background 160ms var(--ease);
  }
  .softn-launcher-card:hover .softn-launcher-remove,
  .softn-launcher-remove:focus-visible { color: var(--dimmer); }
  .softn-launcher-remove:hover { color: var(--paper); background: var(--ink); }
  .softn-launcher-versions {
    margin-top: 0.75rem;
    padding-top: 0.625rem;
    border-top: 1px solid var(--line-soft);
  }
  .softn-launcher-versions-label {
    font-size: 0.6875rem;
    color: var(--dimmer);
    margin-bottom: 0.4375rem;
  }
  .softn-launcher-chips { display: flex; flex-wrap: wrap; gap: 0.375rem; }
  .softn-launcher-chip {
    display: inline-flex;
    align-items: stretch;
    border-radius: 6px;
    border: 1px solid var(--line);
    background: var(--ink);
    overflow: hidden;
  }
  .softn-launcher-chip button {
    min-height: 28px;
    padding: 0.25rem 0.5rem;
    border: none;
    background: transparent;
    color: var(--dim);
    font: inherit;
    font-family: var(--mono);
    font-size: 0.6875rem;
    cursor: pointer;
  }
  .softn-launcher-chip button:hover { color: var(--paper); background: var(--ink-3); }
  .softn-launcher-chip button + button { border-left: 1px solid var(--line); min-width: 24px; padding: 0 0.375rem; }
  .softn-launcher-adopt {
    margin-top: 0.5rem;
    min-height: 30px;
    width: 100%;
    padding: 0.3125rem 0.5rem;
    border-radius: 6px;
    border: 1px solid var(--mint-edge);
    background: var(--mint-glow-soft);
    color: var(--paper);
    font: inherit;
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
  }
  .softn-launcher-adopt:hover { background: var(--mint-glow); }
  .softn-launcher-running {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .softn-launcher-run {
    display: inline-flex;
    align-items: stretch;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--ink-2);
    overflow: hidden;
  }
  .softn-launcher-run-open,
  .softn-launcher-run-stop {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 2.5rem;
    padding: 0 0.875rem;
    border: none;
    background: transparent;
    color: var(--paper);
    font: inherit;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition: background 160ms var(--ease);
  }
  .softn-launcher-run-open:hover { background: var(--ink-3); }
  .softn-launcher-run-open:focus-visible, .softn-launcher-run-stop:focus-visible { outline: 2px solid var(--mint); outline-offset: -3px; }
  .softn-launcher-run-dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--mint);
    box-shadow: 0 0 0 3px var(--mint-glow);
    flex-shrink: 0;
  }
  .softn-launcher-run-icon { width: 18px; height: 18px; border-radius: 5px; object-fit: cover; }
  .softn-launcher-run-stop {
    border-left: 1px solid var(--line);
    color: var(--dim);
    font-size: 1.1rem;
    padding: 0 0.75rem;
  }
  .softn-launcher-run-stop:hover { color: var(--paper); background: var(--ink-3); }
  .softn-launcher-empty {
    padding: 2.5rem 1.5rem;
    border: 1px dashed var(--line);
    border-radius: 12px;
    color: var(--dim);
    font-size: 0.9375rem;
    line-height: 1.6;
    max-width: 40rem;
    animation: softn-launcher-fade-up 400ms var(--ease) 60ms both;
  }
  .softn-launcher-empty strong { color: var(--paper); font-weight: 500; }
  @media (max-width: 640px) {
    .softn-launcher-grid { grid-template-columns: 1fr; }
    .softn-launcher-hint { display: none; }
  }
  @media (pointer: coarse) {
    .softn-launcher-card { min-height: 44px; }
    .softn-launcher-remove { color: var(--dimmer); }
  }
`;

/** An app open in this runtime right now, behind the home screen. */
export interface RunningApp {
  id: string;
  name: string;
  icon?: string;
}

interface LauncherProps {
  apps: CachedApp[];
  /** Apps still running behind this screen; the way back to each, and the way to stop it. */
  running?: RunningApp[];
  onResume?: (id: string) => void;
  onStop?: (id: string) => void;
  onOpenFile: (data: Uint8Array, fileName: string) => void;
  onOpenCached: (app: CachedApp) => void;
  onRemove: (id: string) => void;
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
 * Enter and Space on a `role="button"` element.
 *
 * The launcher's cards were plain divs with an onClick, so every app and every
 * demo on the runtime's front screen could only be opened with a mouse — the
 * browser gives keyboard activation to real buttons, and to nothing else. They
 * cannot simply become buttons: a cached app's card contains its own Remove
 * button, and a button inside a button is not valid HTML.
 *
 * The target check matters. Without it, pressing Space on the nested Remove
 * button would delete the app and open it in the same keystroke.
 */
function activateOnKey(run: () => void) {
  return (event: React.KeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    run();
  };
}

export function Launcher({
  apps,
  running = [],
  onResume,
  onStop,
  onOpenFile,
  onOpenCached,
  onRemove,
  onAdoptData,
}: LauncherProps): React.ReactElement {
  const fileInputRef = useRef<HTMLInputElement>(null);
  // The same place the product bar's "Apps" goes, so the two agree.
  const directoryHref = DEFAULT_URLS.apps;
  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const buffer = await file.arrayBuffer();
        onOpenFile(new Uint8Array(buffer), file.name);
      } catch (err) {
        console.error('[SoftN] Failed to read file:', err);
      }
      if (fileInputRef.current) fileInputRef.current.value = '';
    },
    [onOpenFile]
  );

  const groups = groupByApp(apps);

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: launcherStyles }} />
      <div className="softn-launcher">
        <div className="softn-launcher-inner">
          <div className="softn-launcher-head">
            <div>
              <h1 className="softn-launcher-title">Run an app</h1>
              <p className="softn-launcher-sub">
                Open a <code>.softn</code> file from your machine, or pick up one you had open. Apps run here in a sandbox
                and keep their data in this browser. Looking for something to run? <a href={directoryHref}>Browse the directory</a>.
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
                  // The most recently used older build that actually has records.
                  const dataSource = olderVersions.find((v) => hasStoredData(v.origin));
                  return (
                    <div
                      key={app.id}
                      className="softn-launcher-card"
                      role="button"
                      tabIndex={0}
                      aria-label={`Open ${app.name}`}
                      onClick={() => onOpenCached(app)}
                      onKeyDown={activateOnKey(() => onOpenCached(app))}
                    >
                      <button
                        className="softn-launcher-remove"
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemove(app.id);
                        }}
                        title={`Remove ${app.name} from this browser`}
                        aria-label={`Remove ${app.name}`}
                      >
                        &times;
                      </button>

                      <div className="softn-launcher-card-row">
                        <div className="softn-launcher-icon">
                          {app.icon ? <img src={app.icon} alt="" /> : <span>{app.name.charAt(0).toUpperCase()}</span>}
                        </div>
                        <div style={{ minWidth: 0 }}>
                          <div className="softn-launcher-card-name">{app.name}</div>
                          <div className="softn-launcher-card-meta">v{app.version}</div>
                        </div>
                      </div>
                      {app.description && <div className="softn-launcher-card-desc">{app.description}</div>}
                      <div className="softn-launcher-card-foot">Opened {formatDate(app.lastOpened).toLowerCase()}</div>

                      {olderVersions.length > 0 && (
                        // Earlier builds, in the same place rather than as cards
                        // of their own. Each keeps its own records — that is what
                        // makes going back to one meaningful rather than just
                        // older code.
                        <div
                          className="softn-launcher-versions"
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                        >
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
                              Offered only when this build has no records of its
                              own, so it can never write over data already here. */}
                          {!hasStoredData(app.origin) && dataSource && (
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
              <strong>Nothing open yet.</strong> Open a <strong>.softn</strong> file, drop one anywhere on this page, or pick
              one from <a href={directoryHref}>the directory</a>. An app is one file — its interface, its logic and its
              assets — and it runs here without installing anything.
            </div>
          )}

        </div>
      </div>
    </>
  );
}
