// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  forgetDesktopFile, isDesktop, openCompanionUrl, saveDesktopFile, selectDesktopBundle, takeOpenedDesktopFile,
} from './desktop';
import { exportBundleToFile, saveBundleToFile } from './bundleExporter';
import { selectBundleFile } from './bundleLoader';
import { prepareHandoff } from './handoff';
import { openBundleFile } from './bundleLoader';
import { strToU8, zipSync } from 'fflate';

const native = vi.hoisted(() => ({ isTauri: vi.fn(() => true), invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: native.isTauri, invoke: native.invoke }));

beforeEach(() => { vi.clearAllMocks(); native.invoke.mockReset(); native.isTauri.mockReturnValue(true); });
afterEach(() => vi.restoreAllMocks());

type Reply = (args: unknown, options?: { headers: Record<string, string> }) => unknown;
/** Rust's side of the commands, as each test needs it. */
function rust(replies: Record<string, Reply>): void {
  native.invoke.mockImplementation(async (cmd: string, args?: unknown, options?: { headers: Record<string, string> }) => {
    const reply = replies[cmd];
    if (!reply) throw new Error(`unexpected command ${cmd}`);
    return reply(args, options);
  });
}

/** open_project's reply: the handle as JSON after its length in four bytes, then the file. */
function opened(handle: { id: string; name: string; path: string }, bytes: Uint8Array): ArrayBuffer {
  const head = new TextEncoder().encode(JSON.stringify(handle));
  const reply = new Uint8Array(4 + head.length + bytes.length);
  new DataView(reply.buffer).setUint32(0, head.length, true);
  reply.set(head, 4);
  reply.set(bytes, 4 + head.length);
  return reply.buffer;
}

const commands = () => native.invoke.mock.calls.map(([cmd]) => cmd as string);

describe('Builder desktop files', () => {
  it('opens through Rust, which shows the dialog, and names no path', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    rust({ open_project: () => opened({ id: '1', name: 'Fieldnotes.softn', path: 'C:\\Apps\\Fieldnotes.softn' }, bytes) });
    const browserPicker = vi.spyOn(HTMLInputElement.prototype, 'click');
    expect(isDesktop()).toBe(true);
    expect(await selectBundleFile()).toEqual(bytes);
    expect(native.invoke).toHaveBeenCalledWith('open_project', undefined, undefined);
    expect(browserPicker).not.toHaveBeenCalled();
  });

  it('treats a closed dialog as a cancellation and reports what Rust refused', async () => {
    rust({ open_project: () => new ArrayBuffer(0) });
    expect(await selectDesktopBundle()).toBeNull();
    rust({ open_project: () => { throw 'This bundle is too large. The maximum file size is 200 MB.'; } });
    await expect(selectDesktopBundle()).rejects.toThrow('maximum file size');
  });

  it('saves through Rust\'s dialog, then writes that same file by its id on Save', async () => {
    const written = { id: '4', name: 'Notes.softn', path: 'C:\\Apps\\Notes.softn' };
    rust({ save_file_as: () => written, save_project: () => written });
    const handle = await saveBundleToFile(new Uint8Array([4, 5, 6]), 'Notes');
    expect(handle).toEqual({ kind: 'desktop-file', ...written });
    expect(native.invoke).toHaveBeenCalledWith('save_file_as', new Uint8Array([4, 5, 6]),
      { headers: { 'softn-save-kind': 'project', 'softn-save-name': 'Notes.softn' } });
    await saveBundleToFile(new Uint8Array([7, 8]), 'Renamed app', handle);
    expect(commands()).toEqual(['save_file_as', 'save_project']);
    expect(native.invoke).toHaveBeenLastCalledWith('save_project', new Uint8Array([7, 8]), { headers: { 'softn-file': '4' } });
  });

  it('names a file only by the id Rust gave it, and asks where when it is no longer the project\'s', async () => {
    // A handle with another file's path in it writes nothing there: Rust knows the path by the id.
    const forged = { kind: 'desktop-file' as const, id: '1', name: 'Earlier.softn', path: 'C:\\Apps\\Earlier.softn' };
    rust({ save_project: () => null, save_file_as: () => ({ id: '7', name: 'Picked.softn', path: 'C:\\Apps\\Picked.softn' }) });
    expect(await saveDesktopFile(new Uint8Array([1]), 'Notes.softn', forged)).toMatchObject({ id: '7', name: 'Picked.softn' });
    expect(JSON.stringify(native.invoke.mock.calls)).not.toContain('Earlier');
    expect(commands()).toEqual(['save_project', 'save_file_as']);
  });

  it('never reports a cancelled or failed native save as a successful download', async () => {
    rust({ save_file_as: () => null });
    await expect(saveDesktopFile(new Uint8Array([1]), 'Notes.softn')).rejects.toMatchObject({ name: 'AbortError' });
    rust({ save_file_as: () => { throw 'Could not write Notes.softn: Disk full'; } });
    await expect(saveBundleToFile(new Uint8Array([1]), 'Notes')).rejects.toThrow('Disk full');
  });

  it('says what each save dialog is for, and carries any name', async () => {
    rust({ save_file_as: () => ({ id: '2', name: 'x', path: 'x' }) });
    await exportBundleToFile(new Uint8Array([1]), 'Café.softn');
    await saveDesktopFile(new Uint8Array([2]), 'session.json', undefined, 'recovery');
    expect(native.invoke.mock.calls.map(([, , options]) => options)).toEqual([
      { headers: { 'softn-save-kind': 'export', 'softn-save-name': 'Caf%C3%A9.softn' } },
      { headers: { 'softn-save-kind': 'recovery', 'softn-save-name': 'session.json' } },
    ]);
  });

  it('retains the opened file for Save once the Builder takes it up', async () => {
    const bytes = zipSync({
      'manifest.json': strToU8(JSON.stringify({ name: 'Notes', version: '1.0.0', main: 'ui/main.ui', files: { ui: ['ui/main.ui'], logic: [], xdb: [], assets: [] } })),
      'ui/main.ui': strToU8('<App><Text>Notes</Text></App>'),
    });
    const handle = { id: '3', name: 'Existing.softn', path: 'C:\\Apps\\Existing.softn' };
    rust({ open_project: () => opened(handle, bytes), use_opened_project: () => null, save_project: () => handle });
    const bundle = await openBundleFile();
    expect(bundle?.sourceHandle).toEqual({ kind: 'desktop-file', ...handle });
    await takeOpenedDesktopFile(bundle!.sourceHandle!);
    expect(native.invoke).toHaveBeenLastCalledWith('use_opened_project', { id: '3' }, undefined);
    await saveBundleToFile(bytes, 'Notes', bundle?.sourceHandle);
    expect(commands()).toEqual(['open_project', 'use_opened_project', 'save_project']);
  });

  it('lets go of the file before the next save is asked for, and does nothing in a browser', async () => {
    let letGo: () => void = () => {};
    rust({
      forget_project_file: () => new Promise<void>((resolve) => { letGo = resolve; }),
      save_file_as: () => ({ id: '5', name: 'New.softn', path: 'C:\\Apps\\New.softn' }),
    });
    forgetDesktopFile();
    const saving = saveDesktopFile(new Uint8Array([1]), 'New.softn');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(commands()).toEqual(['forget_project_file']);
    letGo();
    await saving;
    expect(commands()).toEqual(['forget_project_file', 'save_file_as']);

    native.invoke.mockClear();
    native.isTauri.mockReturnValue(false);
    forgetDesktopFile();
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it('gives the page no file system or dialog permission of its own', async () => {
    // The preview draws a bundle into this window, so whatever the page may
    // call, a stranger's app may call: the fs plugin wrote every file a
    // dialog had handed out this session, including ones saved earlier.
    const [{ readFileSync }, { resolve }] = await Promise.all([import('node:fs'), import('node:path')]);
    const file = resolve(import.meta.dirname, '../../src-tauri/capabilities/default.json');
    const capability = JSON.parse(readFileSync(file, 'utf8')) as { permissions: unknown[] };
    const names = capability.permissions.map((entry) => (typeof entry === 'string' ? entry : (entry as { identifier: string }).identifier));
    expect(names.filter((name) => name.startsWith('fs:') || name.startsWith('dialog:'))).toEqual([]);
  });

  it('explains file transfer from desktop without creating a browser handoff', async () => {
    const stage = vi.fn();
    const result = await prepareHandoff('runtime', new Uint8Array([1]), 'Notes', { stage, sameOrigin: () => true });
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('Export .softn') });
    expect(stage).not.toHaveBeenCalled();
  });

  it('opens only the companion website or repository through the native shell', async () => {
    await openCompanionUrl('https://softn.com/studio/');
    expect(native.invoke).toHaveBeenCalledWith('plugin:shell|open', { path: 'https://softn.com/studio/', with: null });
    await expect(openCompanionUrl('https://elsewhere.example/')).rejects.toThrow('companion');
    await expect(openCompanionUrl('file:///C:/private')).rejects.toThrow('companion');
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });
});
