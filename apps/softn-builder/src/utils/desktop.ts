import { isTauri, invoke } from '@tauri-apps/api/core';

export const isDesktop = (): boolean => isTauri();

export interface DesktopFileHandle {
  kind: 'desktop-file';
  path: string;
  name: string;
}

export type BundleFileHandle = FileSystemFileHandle | DesktopFileHandle;

/** Dialog selections grant access to just the chosen file for this session. */
export async function selectDesktopBundle(maxBytes: number): Promise<Uint8Array | null> {
  return (await selectDesktopBundleFile(maxBytes))?.bytes ?? null;
}

export async function selectDesktopBundleFile(maxBytes: number): Promise<{ bytes: Uint8Array; handle: DesktopFileHandle } | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const path = await open({
    title: 'Open a Softn app', multiple: false, directory: false,
    filters: [{ name: 'Softn app', extensions: ['softn'] }],
  });
  if (!path || Array.isArray(path)) return null;
  const { stat, readFile } = await import('@tauri-apps/plugin-fs');
  if ((await stat(path)).size > maxBytes) {
    throw new Error('This bundle is too large. The maximum file size is 200 MB.');
  }
  const bytes = await readFile(path);
  if (bytes.byteLength > maxBytes) {
    throw new Error('This bundle is too large. The maximum file size is 200 MB.');
  }
  return { bytes, handle: { kind: 'desktop-file', path, name: path.split(/[\\/]/).pop() || 'app.softn' } };
}

export async function saveDesktopFile(
  bytes: Uint8Array, suggestedName: string, existing?: DesktopFileHandle,
): Promise<DesktopFileHandle> {
  let path = existing?.path;
  if (!path) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const extension = suggestedName.split('.').pop() || 'softn';
    path = (await save({
      title: 'Save your Softn app', defaultPath: suggestedName,
      filters: [{ name: extension === 'softn' ? 'Softn app' : 'Recovery file', extensions: [extension] }],
    })) ?? undefined;
  }
  if (!path) throw new DOMException('Save cancelled', 'AbortError');
  const { writeFile } = await import('@tauri-apps/plugin-fs');
  await writeFile(path, bytes);
  return { kind: 'desktop-file', path, name: path.split(/[\\/]/).pop() || suggestedName };
}

/** These links leave the desktop window intact; no app data is uploaded. */
export async function openCompanionUrl(href: string): Promise<void> {
  const url = new URL(href);
  const allowed = url.origin === 'https://softn.com'
    || (url.origin === 'https://github.com' && url.pathname === '/f2i-com/softn.com');
  if (!allowed || url.username || url.password) throw new Error('This is not a Softn companion page.');
  await invoke('plugin:shell|open', { path: url.href, with: null });
}
