import { isTauri, invoke, type InvokeArgs, type InvokeOptions } from '@tauri-apps/api/core';

export const isDesktop = (): boolean => isTauri();

export interface DesktopFileHandle {
  kind: 'desktop-file';
  /** Which file Rust keeps for the project now open (src-tauri/src/files.rs). Not a secret. */
  id: string;
  path: string;
  name: string;
}

export type BundleFileHandle = FileSystemFileHandle | DesktopFileHandle;

/** What a save dialog is for; Rust decides from it whether the file becomes the project's. */
export type DesktopSaveKind = 'project' | 'export' | 'recovery';

/*
 * The page names no path and has no file system or dialog permission. Rust
 * shows the dialogs, reads the bundle picked in one, and writes only the file
 * kept for the project now open (src-tauri/src/files.rs): a bundle drawn in
 * the preview runs in this window and can make the same calls. The calls go
 * one after another in the order the Builder makes them, so a file the
 * project lets go of is let go of before the next save is asked for.
 */
let turn: Promise<unknown> = Promise.resolve();

async function call<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  const next = turn.then(() => invoke<T>(cmd, args, options), () => invoke<T>(cmd, args, options));
  turn = next.catch(() => undefined);
  try {
    return await next;
  } catch (e) {
    // Rust refuses with a sentence; the callers report Errors.
    throw e instanceof Error ? e : new Error(String(e));
  }
}

type WrittenFile = Omit<DesktopFileHandle, 'kind'>;

export async function selectDesktopBundle(): Promise<Uint8Array | null> {
  return (await selectDesktopBundleFile())?.bytes ?? null;
}

/** Rust's open dialog: a `.softn` file of at most 200 MB, read whole. */
export async function selectDesktopBundleFile(): Promise<{ bytes: Uint8Array; handle: DesktopFileHandle } | null> {
  const reply = await call<ArrayBuffer | number[]>('open_project');
  const raw = reply instanceof ArrayBuffer ? new Uint8Array(reply) : Uint8Array.from(reply);
  if (raw.byteLength === 0) return null;
  // The file's handle as JSON, after its length in four bytes; then the file.
  const length = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(0, true);
  const handle = JSON.parse(new TextDecoder().decode(raw.subarray(4, 4 + length))) as WrittenFile;
  return { bytes: raw.subarray(4 + length), handle: { kind: 'desktop-file', ...handle } };
}

/**
 * The bundle just opened becomes the project's file: the one Save writes,
 * and from then on the file before it cannot be written. Called before the
 * bundle is put in the workspace, where its code can run.
 */
export async function takeOpenedDesktopFile(handle: DesktopFileHandle): Promise<void> {
  await call('use_opened_project', { id: handle.id });
}

/** The project now open has no file: nothing is written until Save asks where. */
export function forgetDesktopFile(): void {
  if (!isDesktop()) return;
  void call('forget_project_file').catch((e: unknown) => console.warn('[desktop] The previous file was not let go of:', e));
}

/**
 * Write the project's file, or, with none or one that is no longer the
 * project's, write where the person picks in Rust's save dialog.
 */
export async function saveDesktopFile(
  bytes: Uint8Array, suggestedName: string, existing?: DesktopFileHandle, kind: DesktopSaveKind = 'project',
): Promise<DesktopFileHandle> {
  const saved = existing
    ? await call<WrittenFile | null>('save_project', bytes, { headers: { 'softn-file': existing.id } })
    : null;
  const written = saved ?? await call<WrittenFile | null>('save_file_as', bytes, {
    headers: { 'softn-save-kind': kind, 'softn-save-name': encodeURIComponent(suggestedName) },
  });
  if (!written) throw new DOMException('Save cancelled', 'AbortError');
  return { kind: 'desktop-file', ...written };
}

/** Rust asks, in its own words: the page cannot open a dialog that says something else. */
export async function askDiscardUnsaved(): Promise<boolean> {
  return invoke<boolean>('ask_discard_unsaved');
}

/** These links leave the desktop window intact; no app data is uploaded. */
export async function openCompanionUrl(href: string): Promise<void> {
  const url = new URL(href);
  const allowed = url.origin === 'https://softn.com'
    || (url.origin === 'https://github.com' && url.pathname === '/f2i-com/softn.com');
  if (!allowed || url.username || url.password) throw new Error('This is not a Softn companion page.');
  await invoke('plugin:shell|open', { path: url.href, with: null });
}
