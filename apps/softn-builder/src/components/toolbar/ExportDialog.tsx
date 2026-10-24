/**
 * ExportDialog - the bundle, checked and declared, on its way out.
 *
 * Three things happen here that did not before. The app's declaration is
 * edited: which capabilities it asks for, which hosts, which storage policy
 * per collection — and written to permission.json, so a Builder app can use
 * the network or its server storage at all. The icon is chosen, so the
 * directory shows one. And the bundle is inspected the way the directory
 * and the runtime will inspect it, before it leaves, so what they would
 * refuse is read here first. From here the bundle downloads, opens in the
 * runtime, or goes to the directory's publish page.
 */

import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useModalFocus } from '@softn/editor-shared/useModalFocus';
import {
  CAPABILITIES,
  CAPABILITY_INFO,
  STORAGE_POLICIES,
  STORAGE_POLICY_INFO,
  inspectBundle,
  type BundleInspection,
  type Capability,
  type StoragePolicy,
} from '@softn/core';
import { useProjectStore } from '../../stores/projectStore';
import { useFilesStore } from '../../stores/filesStore';
import { isPythonLogicPath } from '@softn/core';
import { toast } from '../../stores/notificationStore';
import { buildProjectBundle, bundleFileName, gatherCollections } from '../../utils/buildProjectBundle';
import type { PermissionDeclaration } from '../../utils/permissions';
import { destinationLabel, prepareHandoff, type ReadyHandoff } from '../../utils/handoff';
import { exportMessage, saveProject, type SaveOutcome } from '../../utils/saveProject';
import { danglingReferences, describeDangling, type DanglingReference } from '../../utils/projectReferences';
import { pageDiagnostics, type PageDiagnostic } from '../../utils/pageDiagnostics';
import { namePaths, unseenEntries } from '../../utils/unseenEntries';
import {
  discardQuarantinedSession,
  exportQuarantinedSession,
  readQuarantinedSession,
  type QuarantinedSession,
} from '../../utils/openProject';
import { dialogStyles } from './dialogStyles';

const MAX_ICON_BYTES = 512 * 1024;

/**
 * The hosts typed into the Network field, as the declaration lists them:
 * separated by commas, spaces or both.
 */
function parseHosts(text: string): string[] {
  return text.split(/[\s,]+/).map((h) => h.trim()).filter(Boolean);
}

// The overlay, frame, title, close button and buttons are classes in
// styles/builder.css, and what the dialogs share is in dialogStyles.ts;
// these are the form's own layout.
const styles: Record<string, React.CSSProperties> = {
  dialog: {
    width: 580,
  },
  header: dialogStyles.header,
  content: {
    padding: 24,
    overflowY: 'auto' as const,
    flex: 1,
    minHeight: 0,
  },
  field: {
    marginBottom: 16,
  },
  label: dialogStyles.label,
  input: dialogStyles.input,
  textarea: dialogStyles.textarea,
  select: {
    padding: '6px 8px',
    borderRadius: 6,
    fontSize: 13,
    minWidth: 0,
    flex: 1,
  },
  section: {
    borderTop: '1px solid var(--line-soft)',
    paddingTop: 16,
    marginTop: 4,
    marginBottom: 16,
  },
  sectionTitle: {
    fontFamily: 'var(--display)',
    fontSize: 15,
    fontWeight: 700,
    letterSpacing: '-0.01em',
    color: 'var(--paper)',
    marginBottom: 4,
  },
  sectionNote: {
    fontSize: 12,
    color: 'var(--dimmer)',
    marginBottom: 10,
    lineHeight: 1.4,
  },
  capRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    padding: '6px 0',
    fontSize: 13,
    color: 'var(--paper)',
    cursor: 'pointer',
  },
  capSummary: {
    fontSize: 12,
    color: 'var(--dimmer)',
    lineHeight: 1.4,
  },
  sub: {
    margin: '4px 0 8px 26px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
  },
  policyRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    fontSize: 13,
    color: 'var(--paper)',
  },
  iconRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  iconBox: {
    width: 48,
    height: 48,
    borderRadius: 10,
    border: '1px solid var(--line-soft)',
    background: 'var(--ink-3)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    fontSize: 20,
    color: 'var(--dim)',
    flexShrink: 0,
  },
  report: {
    borderRadius: 8,
    border: '1px solid var(--line-soft)',
    padding: '10px 12px',
    fontSize: 12,
    lineHeight: 1.5,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
  },
  reportError: { color: 'var(--danger)' },
  reportWarn: { color: 'var(--warn)' },
  reportOk: { color: 'var(--paper)' },
  footer: {
    ...dialogStyles.footer,
    padding: '12px 24px',
    alignItems: 'center',
    flexWrap: 'wrap' as const,
  },
  footerNote: {
    marginRight: 'auto',
    fontSize: 12,
    color: 'var(--danger)',
  },
  progress: {
    textAlign: 'center' as const,
    padding: '32px 24px',
    color: 'var(--dim)',
  },
  success: {
    textAlign: 'center' as const,
    padding: '24px 16px',
    color: 'var(--paper)',
  },
  successMark: {
    width: 44,
    height: 44,
    margin: '0 auto 14px',
    borderRadius: '50%',
    border: '1px solid var(--line-strong)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 20,
    color: 'var(--paper)',
  },
  error: {
    padding: '10px 12px',
    background: 'var(--bl-danger-soft)',
    border: '1px solid var(--danger)',
    borderRadius: 8,
    color: 'var(--paper)',
    fontSize: 13,
    lineHeight: 1.5,
    marginBottom: 16,
  },
};

interface ExportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Write the project's bundle as an export, by the rule a save goes by
   * (utils/saveProject.ts). The app gives this: it knows the file the
   * project is kept in, which decides whether the export is its save or a
   * copy, and keeps the place a desktop export was written. On its own the
   * dialog exports a project that has no file.
   */
  exportProject?: () => Promise<SaveOutcome>;
}

const exportWithNoFile = (): Promise<SaveOutcome> => saveProject({ as: 'export', view: 'design', existingHandle: null });

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
}

export function ExportDialog({ isOpen, onClose, exportProject = exportWithNoFile }: ExportDialogProps) {
  const {
    name,
    version,
    description,
    icon,
    permissions,
    pythonPackages,
    setName,
    setVersion,
    setDescription,
    setIcon,
    setPermissions,
    setPythonPackages,
  } = useProjectStore();
  // The Python settings are offered to an app with Python logic, and to one
  // that already declares a package, so a declaration is never out of reach.
  const hasPython = useFilesStore((state) => [...state.logicFiles.values()].some((file) => isPythonLogicPath(file.path)));
  // What an opened bundle carried that the Builder does not show, and the export writes back.
  const retained = useProjectStore((state) => state.source);
  const unseen = useMemo(() => unseenEntries(retained), [retained]);
  const usesTorch = pythonPackages.includes('torch');

  const [busy, setBusy] = useState<null | 'export' | 'run' | 'publish'>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  /** A bundle staged for the runtime or the publish page, with the link that claims it. */
  const [ready, setReady] = useState<ReadyHandoff | null>(null);
  const [inspection, setInspection] = useState<BundleInspection | null>(null);
  const [references, setReferences] = useState<DanglingReference[]>([]);
  const [pages, setPages] = useState<PageDiagnostic[]>([]);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  /** A saved session that would not restore, kept for download (utils/openProject.ts). */
  const [quarantine, setQuarantine] = useState<QuarantinedSession | null>(null);
  const iconInput = useRef<HTMLInputElement>(null);
  /**
   * The Network hosts as typed, and the list they were typed over. The field
   * shows what is typed while the declaration still holds that list: it used
   * to show the list joined again on every keystroke, so a space or a comma
   * typed after a host was gone before the next host could follow it.
   */
  const [hostsDraft, setHostsDraft] = useState<{ text: string; over: string } | null>(null);
  const hostsJoined = permissions.allowedHosts.join(', ');
  const hostsText = hostsDraft !== null && hostsDraft.over === hostsJoined ? hostsDraft.text : hostsJoined;

  // A modal owns focus while it is open: focus moves in when it opens, Tab
  // wraps inside it, Escape closes it before the window-level shortcuts see
  // it, and focus goes back to the control that opened it when it closes
  // (the same hook as the other dialogs). The overlay used to be a div with
  // none of this — Tab left for the toolbar behind it, and closing dropped
  // focus on the body.
  const dialogRef = useModalFocus(isOpen, onClose);
  useEffect(() => {
    if (isOpen) setQuarantine(readQuarantinedSession());
    else setHostsDraft(null);
  }, [isOpen]);

  // The collections the bundle will carry, for a policy row each.
  const collections = useMemo(() => {
    try {
      return { names: isOpen ? gatherCollections().map((c) => c.name) : [], error: null };
    } catch (cause) {
      return { names: [], error: cause instanceof Error ? cause.message : 'Could not read the collections.' };
    }
  }, [isOpen]);
  const collectionNames = collections.names;

  const update = useCallback(
    (patch: Partial<PermissionDeclaration>) => setPermissions({ ...permissions, ...patch }),
    [permissions, setPermissions]
  );

  const toggleCapability = (cap: Capability) => {
    const has = permissions.capabilities.includes(cap);
    const next = has ? permissions.capabilities.filter((c) => c !== cap) : [...permissions.capabilities, cap];
    update({ capabilities: CAPABILITIES.filter((c) => next.includes(c)) });
  };

  const setPolicy = (collection: string, policy: StoragePolicy) => {
    const next = { ...permissions.storagePolicies };
    if (policy === 'public') delete next[collection];
    else next[collection] = policy;
    update({ storagePolicies: next });
  };

  const takeIcon = async (file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp|svg\+xml)$/.test(file.type)) {
      toast.error('An icon is a PNG, JPEG, WebP or SVG.');
      return;
    }
    if (file.size > MAX_ICON_BYTES) {
      toast.error('The directory shows icons up to 512 KB; this one is larger.');
      return;
    }
    try {
      setIcon(await readAsDataUrl(file));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not read the icon');
    }
  };

  // The pre-flight: build the bundle as it would be exported and read it back.
  // Re-run as the fields change, a moment after the last keystroke.
  useEffect(() => {
    if (!isOpen) return;
    setInspection(null);
    setReferences([]);
    setPages([]);
    setPreflightError(null);
    if (collections.error) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      buildProjectBundle()
        .then((bytes) => {
          if (cancelled) return;
          setInspection(inspectBundle(bytes));
          // What the directory's reading does not ask: whether each page's
          // imports and logic link lead to a file the project has. Read
          // after the build, which puts the canvas into its file first.
          const files = useFilesStore.getState();
          setReferences(danglingReferences(files.uiFiles, files.logicFiles));
          // Nor whether each page parses, or what the parser warns of in one that does.
          setPages(pageDiagnostics(files.uiFiles));
        })
        .catch((e) => {
          if (!cancelled) setPreflightError(e instanceof Error ? e.message : 'Could not check the bundle.');
          console.warn('[ExportDialog] pre-flight failed:', e);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isOpen, name, version, description, icon, permissions, pythonPackages, collections.error]);

  // The dialog stays mounted while it is closed, so a run that finishes after
  // a close would speak to the dialog opened next: a link to a bundle staged
  // from the project as it was, or the closing timer of an export shutting
  // it. Each close counts one more opening, and a run answers only the one
  // it started in; the closing timer is cleared with it.
  const opening = useRef(0);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const timers = closeTimer;
    return () => {
      if (timers.current !== null) clearTimeout(timers.current);
    };
  }, []);

  useEffect(() => {
    if (!isOpen) {
      opening.current++;
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
      closeTimer.current = null;
      setError(null);
      setDone(null);
      setReady(null);
      setBusy(null);
    }
  }, [isOpen]);

  const run = useCallback(
    async (what: 'export' | 'run' | 'publish') => {
      const started = opening.current;
      const current = () => started === opening.current;
      try {
        setBusy(what);
        setError(null);

        if (what === 'export') {
          // The same bundle a save writes, by a save's own rule: whether it
          // leaves the project saved depends on where the project is kept.
          const outcome = await exportProject();
          if (outcome.kind === 'cancelled') return;
          if (outcome.kind === 'failed') throw outcome.error;
          const said = exportMessage(outcome, bundleFileName(name));
          if (current()) setDone(said);
          // A copy that leaves changes unsaved is news, not a success to wave through.
          if (outcome.copy?.unsaved || outcome.stale || outcome.projectChanged) toast.warning(said);
          else toast.success(said);
          if (!outcome.copy && !outcome.sessionStored && !outcome.projectChanged && !outcome.sessionSuperseded) {
            toast.info('The local recovery copy could not be stored (storage full or blocked); the file itself was exported.');
          }
          if (!outcome.copy && outcome.sessionAssets === 'left-out' && !outcome.projectChanged) {
            toast.info('The local recovery copy was kept without the project’s pictures and other assets (this browser’s storage is full); the file itself was exported.');
          }
          if (current()) {
            if (closeTimer.current !== null) clearTimeout(closeTimer.current);
            closeTimer.current = setTimeout(() => {
              closeTimer.current = null;
              setDone(null);
              onClose();
            }, 1500);
          }
          return;
        }

        const bytes = await buildProjectBundle();
        if (!current()) return;

        // The runtime and the directory are pages of this origin; the bundle
        // is staged under an id addressed to the one chosen, and the dialog
        // then offers the link. Opening it is the person's click, so it is
        // never popup-blocked and never navigates the editor by mistake — see
        // utils/handoff.ts. In development the pages can be other origins;
        // that is reported instead of opening a page that finds nothing.
        const outcome = await prepareHandoff(what === 'run' ? 'runtime' : 'publish', bytes, name);
        if (!current()) return;
        if (!outcome.ok) {
          setError(outcome.message);
          return;
        }
        setReady(outcome.ready);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        console.error('[ExportDialog] failed:', err);
        const msg = err instanceof Error ? err.message : 'Export failed';
        if (current()) setError(msg);
        toast.error(msg);
      } finally {
        if (current()) setBusy(null);
      }
    },
    [name, onClose, exportProject]
  );

  if (!isOpen) return null;

  const hasNet = permissions.capabilities.includes('net');
  const hasStorage = permissions.capabilities.includes('storage');
  const bundleProblem = collections.error ?? preflightError;
  const refused = inspection?.problem != null || bundleProblem != null;
  const errors = inspection?.report.filter((l) => l.level === 'error') ?? [];
  const warns = inspection?.report.filter((l) => l.level === 'warn') ?? [];

  return (
    <div className="bl-overlay" style={{ zIndex: 1000 }} onClick={onClose} role="presentation">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-dialog-title"
        tabIndex={-1}
        className="bl-dialog"
        style={styles.dialog}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={styles.header}>
          <h2 id="export-dialog-title" className="bl-dialog-title">
            Export, run or publish
          </h2>
          <button type="button" className="bl-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div style={styles.content}>
          {ready ? (
            <div style={styles.success} role="status" aria-live="polite">
              <div style={styles.successMark} aria-hidden="true">✓</div>
              <div style={{ fontSize: 16, fontWeight: 600 }}>
                {ready.name} is ready for {destinationLabel(ready.to)}.
              </div>
              <div style={{ ...styles.capSummary, marginTop: 8 }}>Builder stays open. The link is good for ten minutes and can be taken once.</div>
              <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginTop: 20, flexWrap: 'wrap' }}>
                <a
                  href={ready.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="bl-btn bl-btn-primary bl-btn-lg"
                  onClick={() => {
                    setTimeout(() => {
                      setReady(null);
                      onClose();
                    }, 0);
                  }}
                >
                  {ready.to === 'runtime' ? 'Open in the runtime' : 'Open the publish page'} ↗
                </a>
                <a href={ready.url} className="bl-btn bl-btn-lg" title="Leave Builder and open it in this tab">
                  Open here instead
                </a>
              </div>
            </div>
          ) : done ? (
            <div style={styles.success}>
              <div style={styles.successMark} aria-hidden="true">✓</div>
              <div style={{ fontSize: 16, fontWeight: 600 }} role="status">{done}</div>
            </div>
          ) : busy ? (
            <div style={styles.progress} role="status" aria-live="polite">
              <div>{busy === 'export' ? 'Creating the bundle…' : `Staging the bundle for ${busy === 'run' ? 'the runtime' : 'the publish page'}…`}</div>
            </div>
          ) : (
            <>
              {error && <div style={styles.error} role="alert">{error}</div>}

              <div style={styles.field}>
                <label style={styles.label} htmlFor="export-app-name">Name</label>
                <input id="export-app-name" type="text" style={styles.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="My App" />
              </div>

              <div style={styles.field}>
                <label style={styles.label} htmlFor="export-app-version">Version</label>
                <input id="export-app-version" type="text" style={styles.input} value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.0.0" />
              </div>

              <div style={styles.field}>
                <label style={styles.label} htmlFor="export-app-description">Description</label>
                <textarea
                  id="export-app-description"
                  style={styles.textarea}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What the app is, in a sentence or two. The directory shows this on the card."
                />
              </div>

              <div style={styles.field}>
                <span style={styles.label} id="export-app-icon">Icon</span>
                <div style={styles.iconRow}>
                  <div style={styles.iconBox}>
                    {icon ? <img src={icon} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : (name.trim()[0] || '?').toUpperCase()}
                  </div>
                  <button type="button" className="bl-btn bl-btn-sm" aria-describedby="export-app-icon" onClick={() => iconInput.current?.click()}>
                    {icon ? 'Change…' : 'Choose…'}
                  </button>
                  {icon && (
                    <button type="button" className="bl-btn bl-btn-sm" onClick={() => setIcon(null)}>
                      Remove
                    </button>
                  )}
                  <input
                    ref={iconInput}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/svg+xml"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      void takeIcon(e.target.files?.[0]);
                      e.target.value = '';
                    }}
                  />
                  <span style={styles.capSummary}>PNG, JPEG, WebP or SVG, up to 512 KB. Without one the card shows an initial.</span>
                </div>
              </div>

              <div style={styles.section}>
                <div style={styles.sectionTitle}>What the app may use</div>
                <div style={styles.sectionNote}>
                  Written to permission.json. The runtime grants only what is declared here, after the person running the app agrees; a call to
                  anything else fails.
                </div>
                {permissions.legacy !== undefined && (
                  <div style={styles.sectionNote} data-permission-source="manifest">
                    This app has no permission.json: what is ticked is what the older permissions block in its manifest grants, which the
                    runtime reads in its place. Leave it as it is and the app is exported as it came; change it and a permission.json is
                    written, which the runtime then reads instead.
                  </div>
                )}
                {CAPABILITIES.map((cap) => {
                  const on = permissions.capabilities.includes(cap);
                  return (
                    <div key={cap}>
                      <label style={styles.capRow}>
                        <input type="checkbox" checked={on} onChange={() => toggleCapability(cap)} style={{ marginTop: 2 }} />
                        <span>
                          <span style={{ fontWeight: 500 }}>{CAPABILITY_INFO[cap].label}</span>
                          <span style={{ ...styles.capSummary, display: 'block' }}>{CAPABILITY_INFO[cap].summary}</span>
                        </span>
                      </label>
                      {cap === 'net' && on && hasNet && (
                        <div style={styles.sub}>
                          <input
                            type="text"
                            aria-label="Hosts the app may reach"
                            aria-describedby="export-net-hosts-note"
                            data-setting="net-hosts"
                            style={{ ...styles.input, padding: '6px 10px', fontSize: 13 }}
                            value={hostsText}
                            onChange={(e) => {
                              const text = e.target.value;
                              const hosts = parseHosts(text);
                              setHostsDraft({ text, over: hosts.join(', ') });
                              // A separator typed after a host changes nothing that is declared.
                              if (hosts.join(', ') !== hostsJoined) update({ allowedHosts: hosts });
                            }}
                            // Left, the field says the list as it is declared.
                            onBlur={() => setHostsDraft(null)}
                            placeholder="Hosts it may reach, comma-separated; empty means any internet host"
                          />
                          <span id="export-net-hosts-note" style={styles.capSummary}>
                            With none listed it may reach any host on the internet, but not this computer or its local network
                            (localhost, 192.168.…, .local): list such a host here to reach it.
                          </span>
                          <label style={{ ...styles.policyRow, fontSize: 12, color: 'var(--dim)' }}>
                            <input type="checkbox" checked={permissions.allowHttp} onChange={(e) => update({ allowHttp: e.target.checked })} />
                            Allow plain http:// servers (for a development server on localhost, which has to be listed above)
                          </label>
                        </div>
                      )}
                      {cap === 'storage' && on && hasStorage && (
                        <div style={styles.sub}>
                          {collectionNames.length === 0 ? (
                            <span style={styles.capSummary}>No collections in this project yet. Add one in the Data view to set its policy.</span>
                          ) : (
                            collectionNames.map((collection) => (
                              <div key={collection} style={styles.policyRow}>
                                <span style={{ minWidth: 120 }}>{collection}</span>
                                <select
                                  aria-label={`Storage policy for ${collection}`}
                                  style={styles.select}
                                  value={permissions.storagePolicies[collection] ?? 'public'}
                                  onChange={(e) => setPolicy(collection, e.target.value as StoragePolicy)}
                                >
                                  {STORAGE_POLICIES.map((p) => (
                                    <option key={p} value={p}>
                                      {STORAGE_POLICY_INFO[p].label} — {STORAGE_POLICY_INFO[p].summary}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {(hasPython || pythonPackages.length > 0) && (
                <div style={styles.section}>
                  <div style={styles.sectionTitle}>Python</div>
                  <div style={styles.sectionNote}>
                    Written to manifest.json as config.python.packages. An app that imports torch has to declare it, or it is refused before it runs.
                  </div>
                  <label style={styles.capRow}>
                    <input
                      type="checkbox"
                      checked={usesTorch}
                      onChange={(e) =>
                        setPythonPackages(e.target.checked ? [...pythonPackages, 'torch'] : pythonPackages.filter((p) => p !== 'torch'))
                      }
                      style={{ marginTop: 2 }}
                      data-setting="python-torch"
                    />
                    <span>
                      <span style={{ fontWeight: 500 }}>Machine learning (torch)</span>
                      <span style={{ ...styles.capSummary, display: 'block' }}>
                        Tensors, autograd, torch.nn, losses and optimizers, run on the CPU inside the engine.
                      </span>
                    </span>
                  </label>
                </div>
              )}

              {quarantine && (
                <div style={styles.section}>
                  <div style={styles.sectionTitle}>Recovery</div>
                  <div style={styles.sectionNote}>
                    A locally saved session from {quarantine.quarantinedAt ? new Date(quarantine.quarantinedAt).toLocaleString() : 'earlier'} could not be
                    restored ({quarantine.error}). It was kept as it was, not deleted; download it to keep a copy.
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button type="button" className="bl-btn bl-btn-sm" onClick={() => {
                      void exportQuarantinedSession().catch((err: unknown) => {
                        if (!(err instanceof Error && err.name === 'AbortError')) toast.error('Could not save the recovery file. It is still stored here.');
                      });
                    }}>
                      Download session…
                    </button>
                    <button
                      type="button"
                      className="bl-btn bl-btn-sm"
                      onClick={() => {
                        discardQuarantinedSession();
                        setQuarantine(null);
                      }}
                    >
                      Discard
                    </button>
                  </div>
                </div>
              )}

              <div style={styles.section}>
                <div style={styles.sectionTitle}>Before it leaves</div>
                <div style={styles.sectionNote}>The bundle as the directory and the runtime will read it.</div>
                <div style={styles.report}>
                  {bundleProblem ? (
                    <span role="alert" style={styles.reportError}>{bundleProblem}</span>
                  ) : !inspection ? (
                    <span style={styles.capSummary}>Checking…</span>
                  ) : (
                    <>
                      <span style={refused ? styles.reportError : styles.reportOk}>
                        {refused
                          ? 'The directory would refuse this bundle.'
                          : `Ready: ${inspection.files} files, ${inspection.capabilities.length === 0 ? 'no capabilities' : `asks for ${inspection.capabilities.map((c) => CAPABILITY_INFO[c as Capability]?.label ?? c).join(', ')}`}.`}
                      </span>
                      {errors.map((l, i) => (
                        <span key={`e${i}`} style={styles.reportError}>
                          ✕ {l.text}
                        </span>
                      ))}
                      {pages.length > 0 && (
                        <span data-report="pages" style={{ display: 'contents' }}>
                          {pages.map((line, i) => (
                            <span key={`p${i}`} style={line.level === 'error' ? styles.reportError : styles.reportWarn}>
                              {line.level === 'error' ? '✕' : '△'} {line.text}
                            </span>
                          ))}
                        </span>
                      )}
                      {references.length > 0 && (
                        <span data-report="references" style={{ display: 'contents' }}>
                          {references.map((reference, i) => (
                            <span key={`r${i}`} style={styles.reportWarn}>
                              △ {describeDangling(reference)}
                            </span>
                          ))}
                        </span>
                      )}
                      {(unseen.server.length > 0 || unseen.other.length > 0) && (
                        <span data-report="unseen" style={{ display: 'contents' }}>
                          {unseen.server.length > 0 && (
                            <span style={styles.reportWarn}>
                              △ Server logic the Builder does not show goes into the bundle as it came, and runs on the app’s server: {namePaths(unseen.server)}. Look at it before you publish.
                            </span>
                          )}
                          {unseen.other.length > 0 && (
                            <span style={styles.reportWarn}>
                              △ Files the Builder does not show go into the bundle as they came: {namePaths(unseen.other)}.
                            </span>
                          )}
                        </span>
                      )}
                      {warns.map((l, i) => (
                        <span key={`w${i}`} style={styles.reportWarn}>
                          △ {l.text}
                        </span>
                      ))}
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        {ready && (
          <div style={styles.footer}>
            <button type="button" className="bl-btn" onClick={() => setReady(null)}>
              Back
            </button>
          </div>
        )}
        {!done && !busy && !ready && (
          <div style={styles.footer}>
            {refused && (
              <span style={styles.footerNote}>
                {bundleProblem ? 'This bundle cannot be built yet — see the check above.' : 'The directory would refuse this bundle — see the check above.'}
              </span>
            )}
            <button type="button" className="bl-btn bl-btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="bl-btn"
              onClick={() => void run('run')}
              disabled={refused}
              title={refused ? 'Fix what the check found first' : 'Stage the bundle for the SoftN runtime'}
            >
              Open in runtime…
            </button>
            <button
              type="button"
              className="bl-btn"
              onClick={() => void run('publish')}
              disabled={refused}
              title={refused ? 'Fix what the check found first' : 'Stage the bundle for the directory’s publish page'}
            >
              Publish…
            </button>
            <button
              type="button"
              className="bl-btn bl-btn-primary"
              onClick={() => void run('export')}
              disabled={bundleProblem != null}
              title={bundleProblem ? 'Fix what the check found first' : undefined}
            >
              Export .softn
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
