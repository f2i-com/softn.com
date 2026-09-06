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
import {
  CAPABILITIES,
  CAPABILITY_INFO,
  STORAGE_POLICIES,
  STORAGE_POLICY_INFO,
  inspectBundle,
  stageBundleHandoff,
  handoffUrl,
  type BundleInspection,
  type Capability,
  type StoragePolicy,
} from '@softn/core';
import { useProjectStore } from '../../stores/projectStore';
import { toast } from '../../stores/notificationStore';
import { buildProjectBundle, bundleFileName, gatherCollections } from '../../utils/buildProjectBundle';
import type { PermissionDeclaration } from '../../utils/permissions';
import { RUNTIME_URL, SITE_URL } from '../../utils/siteUrls';

const MAX_ICON_BYTES = 512 * 1024;

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed' as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0,0,0,0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  dialog: {
    background: 'var(--ink-2)',
    borderRadius: 12,
    width: 560,
    maxWidth: '94vw',
    maxHeight: '92vh',
    display: 'flex',
    flexDirection: 'column' as const,
    boxShadow: '0 20px 40px rgba(0,0,0,0.2)',
    overflow: 'hidden',
  },
  header: {
    padding: '16px 24px',
    borderBottom: '1px solid var(--line-soft)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontSize: 18,
    fontWeight: 600,
    color: 'var(--paper)',
  },
  closeButton: {
    background: 'transparent',
    border: 'none',
    fontSize: 24,
    color: 'var(--dimmer)',
    cursor: 'pointer',
    padding: 4,
    lineHeight: 1,
  },
  content: {
    padding: 24,
    overflowY: 'auto' as const,
    flex: 1,
  },
  field: {
    marginBottom: 16,
  },
  label: {
    display: 'block',
    fontSize: 13,
    fontWeight: 500,
    color: 'var(--dim)',
    marginBottom: 6,
  },
  input: {
    width: '100%',
    padding: '10px 12px',
    border: '1px solid var(--line-soft)',
    borderRadius: 8,
    fontSize: 14,
    outline: 'none',
  },
  textarea: {
    width: '100%',
    padding: '10px 12px',
    border: '1px solid var(--line-soft)',
    borderRadius: 8,
    fontSize: 14,
    outline: 'none',
    minHeight: 64,
    resize: 'vertical' as const,
  },
  select: {
    padding: '6px 8px',
    border: '1px solid var(--line-soft)',
    borderRadius: 6,
    fontSize: 13,
    outline: 'none',
    background: 'var(--ink-2)',
    color: 'var(--paper)',
  },
  section: {
    borderTop: '1px solid var(--line-soft)',
    paddingTop: 16,
    marginTop: 4,
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: 600,
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
    background: 'var(--ink-3, rgba(255,255,255,0.04))',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    fontSize: 20,
    color: 'var(--dim)',
    flexShrink: 0,
  },
  smallButton: {
    padding: '6px 12px',
    borderRadius: 6,
    fontSize: 13,
    cursor: 'pointer',
    background: 'transparent',
    border: '1px solid var(--line-soft)',
    color: 'var(--dim)',
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
  reportError: { color: '#ef4444' },
  reportWarn: { color: '#d97706' },
  reportOk: { color: '#10b981' },
  footer: {
    padding: '16px 24px',
    borderTop: '1px solid var(--line-soft)',
    display: 'flex',
    justifyContent: 'flex-end',
    flexWrap: 'wrap' as const,
    gap: 12,
  },
  button: {
    padding: '10px 20px',
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all 0.15s',
  },
  cancelButton: {
    background: 'transparent',
    border: '1px solid var(--line-soft)',
    color: 'var(--dim)',
  },
  secondaryButton: {
    background: 'transparent',
    border: '1px solid var(--coral)',
    color: 'var(--coral)',
  },
  exportButton: {
    background: 'var(--coral)',
    border: '1px solid var(--coral)',
    color: '#fff',
  },
  buttonDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
  progress: {
    textAlign: 'center' as const,
    padding: 24,
    color: 'var(--dim)',
  },
  success: {
    textAlign: 'center' as const,
    padding: 24,
    color: '#10b981',
  },
  error: {
    padding: 12,
    background: '#fef2f2',
    border: '1px solid #fecaca',
    borderRadius: 8,
    color: '#ef4444',
    fontSize: 13,
    marginBottom: 16,
  },
};

interface ExportDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
}

export function ExportDialog({ isOpen, onClose }: ExportDialogProps) {
  const {
    name,
    version,
    description,
    icon,
    permissions,
    setName,
    setVersion,
    setDescription,
    setIcon,
    setPermissions,
  } = useProjectStore();

  const [busy, setBusy] = useState<null | 'export' | 'run' | 'publish'>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [inspection, setInspection] = useState<BundleInspection | null>(null);
  const iconInput = useRef<HTMLInputElement>(null);

  // The collections the bundle will carry, for a policy row each.
  const collectionNames = useMemo(() => (isOpen ? gatherCollections().map((c) => c.name) : []), [isOpen]);

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
    let cancelled = false;
    const timer = setTimeout(() => {
      buildProjectBundle()
        .then((bytes) => {
          if (!cancelled) setInspection(inspectBundle(bytes));
        })
        .catch((e) => {
          if (!cancelled) setInspection(null);
          console.warn('[ExportDialog] pre-flight failed:', e);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isOpen, name, version, description, icon, permissions]);

  useEffect(() => {
    if (!isOpen) {
      setError(null);
      setDone(null);
      setBusy(null);
    }
  }, [isOpen]);

  const run = useCallback(
    async (what: 'export' | 'run' | 'publish') => {
      try {
        setBusy(what);
        setError(null);
        const bytes = await buildProjectBundle();

        if (what === 'export') {
          const blob = new Blob([new Uint8Array(bytes)], { type: 'application/zip' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = bundleFileName(name);
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          setDone('Bundle exported.');
          toast.success('Bundle exported');
          setTimeout(() => {
            setDone(null);
            onClose();
          }, 1500);
          return;
        }

        // The runtime and the directory are pages of this origin; the bundle
        // is staged for whichever opens next. In development they are other
        // ports and share nothing, so the page opens without it and says so.
        const staged = await stageBundleHandoff(bytes, name, 'builder');
        if (!staged) {
          setError('This browser could not hold the bundle for the next page. Export it and open the file there instead.');
          return;
        }
        const target = what === 'run' ? handoffUrl(RUNTIME_URL, 'runtime') : handoffUrl(SITE_URL, 'publish');
        const opened = window.open(target, '_blank', 'noopener');
        if (!opened) window.location.assign(target);
        setDone(what === 'run' ? 'Opened in the runtime.' : 'Handed to the publish page.');
        setTimeout(() => {
          setDone(null);
          onClose();
        }, 1500);
      } catch (err) {
        console.error('[ExportDialog] failed:', err);
        const msg = err instanceof Error ? err.message : 'Export failed';
        setError(msg);
        toast.error(msg);
      } finally {
        setBusy(null);
      }
    },
    [name, onClose]
  );

  if (!isOpen) return null;

  const hasNet = permissions.capabilities.includes('net');
  const hasStorage = permissions.capabilities.includes('storage');
  const refused = inspection?.problem != null;
  const errors = inspection?.report.filter((l) => l.level === 'error') ?? [];
  const warns = inspection?.report.filter((l) => l.level === 'warn') ?? [];

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.title}>Export Bundle</span>
          <button style={styles.closeButton} onClick={onClose}>
            ×
          </button>
        </div>

        <div style={styles.content}>
          {done ? (
            <div style={styles.success}>
              <div style={{ fontSize: 48, marginBottom: 16 }}>✓</div>
              <div style={{ fontSize: 16, fontWeight: 500 }}>{done}</div>
            </div>
          ) : busy ? (
            <div style={styles.progress}>
              <div style={{ fontSize: 24, marginBottom: 16 }}>⏳</div>
              <div>Creating bundle...</div>
            </div>
          ) : (
            <>
              {error && <div style={styles.error}>{error}</div>}

              <div style={styles.field}>
                <label style={styles.label}>App Name</label>
                <input type="text" style={styles.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="My App" />
              </div>

              <div style={styles.field}>
                <label style={styles.label}>Version</label>
                <input type="text" style={styles.input} value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.0.0" />
              </div>

              <div style={styles.field}>
                <label style={styles.label}>Description</label>
                <textarea
                  style={styles.textarea}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What the app is, in a sentence or two. The directory shows this on the card."
                />
              </div>

              <div style={styles.field}>
                <label style={styles.label}>Icon</label>
                <div style={styles.iconRow}>
                  <div style={styles.iconBox}>
                    {icon ? <img src={icon} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : (name.trim()[0] || '?').toUpperCase()}
                  </div>
                  <button type="button" style={styles.smallButton} onClick={() => iconInput.current?.click()}>
                    {icon ? 'Change…' : 'Choose…'}
                  </button>
                  {icon && (
                    <button type="button" style={styles.smallButton} onClick={() => setIcon(null)}>
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
                            style={{ ...styles.input, padding: '6px 10px', fontSize: 13 }}
                            value={permissions.allowedHosts.join(', ')}
                            onChange={(e) =>
                              update({ allowedHosts: e.target.value.split(/[\s,]+/).map((h) => h.trim()).filter(Boolean) })
                            }
                            placeholder="Hosts it may reach, comma-separated; empty means any host"
                          />
                          <label style={{ ...styles.policyRow, fontSize: 12, color: 'var(--dim)' }}>
                            <input type="checkbox" checked={permissions.allowHttp} onChange={(e) => update({ allowHttp: e.target.checked })} />
                            Allow plain http:// servers (for a development server on localhost)
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

              <div style={styles.section}>
                <div style={styles.sectionTitle}>Before it leaves</div>
                <div style={styles.sectionNote}>The bundle as the directory and the runtime will read it.</div>
                <div style={styles.report}>
                  {!inspection ? (
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

        {!done && !busy && (
          <div style={styles.footer}>
            <button style={{ ...styles.button, ...styles.cancelButton }} onClick={onClose}>
              Cancel
            </button>
            <button
              style={{ ...styles.button, ...styles.secondaryButton, ...(refused ? styles.buttonDisabled : {}) }}
              onClick={() => void run('run')}
              disabled={refused}
              title={refused ? 'Fix what the check found first' : 'Open the bundle in the SoftN runtime'}
            >
              Open in runtime
            </button>
            <button
              style={{ ...styles.button, ...styles.secondaryButton, ...(refused ? styles.buttonDisabled : {}) }}
              onClick={() => void run('publish')}
              disabled={refused}
              title={refused ? 'Fix what the check found first' : 'Hand the bundle to the directory’s publish page'}
            >
              Publish…
            </button>
            <button style={{ ...styles.button, ...styles.exportButton }} onClick={() => void run('export')}>
              Export .softn
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
