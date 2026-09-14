/**
 * A small, unstyled-by-default banner that tells the truth about where an
 * app's records are (audit SN-02): memory only, a damaged collection, a
 * native collection that failed to load, or native writes still in flight.
 * It renders nothing while storage is ready and idle. Hosts place it above
 * the running app and may restyle it through `className`.
 */
import React from 'react';
import { getXDB, useXDBStorageStatus, type XDBService, type XDBStorageStatus } from './xdb';

function describe(status: XDBStorageStatus): { title: string; detail: string; tone: 'warning' | 'error' } | null {
  if (status.state === 'memory-only') {
    return { title: 'Records are not being saved', detail: 'Browser storage is unavailable, so this app keeps its records in memory only. Closing it loses anything unsaved. Export your data to keep it.', tone: 'error' };
  }
  if (status.state === 'failed') {
    return { title: 'Saved records could not be loaded', detail: status.issues[0]?.message ?? 'The native database could not be read. Retry before making changes.', tone: 'error' };
  }
  if (status.state === 'degraded') {
    const corrupt = status.issues.find(i => i.kind === 'corrupt');
    if (corrupt) return { title: `Collection "${corrupt.collection}" is damaged`, detail: `${corrupt.message} Export the original bytes or restore a backup before writing to it.`, tone: 'error' };
    const hydration = status.issues.find(i => i.kind === 'hydration-failed');
    if (hydration) return { title: 'Some records did not load', detail: hydration.message, tone: 'warning' };
    const quota = status.issues.find(i => i.kind === 'quota');
    if (quota) return { title: 'Storage is full', detail: quota.message, tone: 'error' };
    const migration = status.issues.find(i => i.kind === 'migration-incomplete');
    if (migration) return { title: 'Older records were not all copied', detail: migration.message, tone: 'warning' };
    return { title: 'Storage needs attention', detail: status.issues[0]?.message ?? '', tone: 'warning' };
  }
  if (status.state === 'loading') {
    return null;
  }
  return null;
}

export function XDBStorageNotice({ appId, xdb, className }: { appId?: string; xdb?: XDBService; className?: string }): React.ReactElement | null {
  const service = xdb ?? getXDB(appId);
  const status = useXDBStorageStatus(service);
  const message = describe(status);
  const [retrying, setRetrying] = React.useState(false);
  if (!message && status.pendingWrites === 0) return null;
  if (!message) {
    return <div role="status" aria-live="polite" className={className} data-xdb-storage="pending" style={{ fontSize: 12, padding: '4px 12px' }}>
      Saving {status.pendingWrites} change{status.pendingWrites === 1 ? '' : 's'}…
    </div>;
  }
  const canRetry = status.state === 'failed' || status.issues.some(i => i.kind === 'hydration-failed');
  return <div role={message.tone === 'error' ? 'alert' : 'status'} aria-live={message.tone === 'error' ? 'assertive' : 'polite'} className={className} data-xdb-storage={status.state}
    style={{ padding: '8px 12px', fontSize: 13, lineHeight: 1.4, background: message.tone === 'error' ? '#fdecea' : '#fff4e5', color: '#3a2a00', borderBottom: '1px solid rgba(0,0,0,0.1)' }}>
    <strong>{message.title}.</strong> {message.detail}
    {canRetry && <button type="button" disabled={retrying} onClick={() => { setRetrying(true); void service.retryHydration().finally(() => setRetrying(false)); }} style={{ marginLeft: 8, minHeight: 28 }}>{retrying ? 'Retrying…' : 'Retry loading'}</button>}
  </div>;
}
