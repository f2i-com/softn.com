// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isDesktop, openCompanionUrl, saveDesktopFile, selectDesktopBundle } from './desktop';
import { saveBundleToFile } from './bundleExporter';
import { selectBundleFile } from './bundleLoader';
import { prepareHandoff } from './handoff';
import { openBundleFile } from './bundleLoader';
import { strToU8, zipSync } from 'fflate';

const native = vi.hoisted(() => ({
  isTauri: vi.fn(() => true), invoke: vi.fn(), open: vi.fn(), save: vi.fn(),
  stat: vi.fn(), readFile: vi.fn(), writeFile: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: native.isTauri, invoke: native.invoke }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: native.open, save: native.save }));
vi.mock('@tauri-apps/plugin-fs', () => ({ stat: native.stat, readFile: native.readFile, writeFile: native.writeFile }));

beforeEach(() => { vi.clearAllMocks(); native.isTauri.mockReturnValue(true); });
afterEach(() => vi.restoreAllMocks());

describe('Builder desktop files', () => {
  it('uses the native open picker and reads only the chosen file', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    native.open.mockResolvedValue('C:\\Apps\\Fieldnotes.softn');
    native.stat.mockResolvedValue({ size: 3 });
    native.readFile.mockResolvedValue(bytes);
    const browserPicker = vi.spyOn(HTMLInputElement.prototype, 'click');
    expect(isDesktop()).toBe(true);
    expect(await selectBundleFile()).toEqual(bytes);
    expect(native.open).toHaveBeenCalledWith(expect.objectContaining({ multiple: false, directory: false }));
    expect(native.readFile).toHaveBeenCalledWith('C:\\Apps\\Fieldnotes.softn');
    expect(browserPicker).not.toHaveBeenCalled();
  });

  it('treats native picker cancellation as a cancellation and checks size before allocating', async () => {
    native.open.mockResolvedValue(null);
    expect(await selectDesktopBundle(10)).toBeNull();
    expect(native.readFile).not.toHaveBeenCalled();
    native.open.mockResolvedValue('/apps/large.softn');
    native.stat.mockResolvedValue({ size: 11 });
    await expect(selectDesktopBundle(10)).rejects.toThrow('maximum file size');
    expect(native.readFile).not.toHaveBeenCalled();
  });

  it('saves through the native dialog, then reuses that exact path on Save', async () => {
    const bytes = new Uint8Array([4, 5, 6]);
    native.save.mockResolvedValue('C:\\Apps\\Notes.softn');
    native.writeFile.mockResolvedValue(undefined);
    const handle = await saveBundleToFile(bytes, 'Notes');
    expect(handle).toEqual({ kind: 'desktop-file', name: 'Notes.softn', path: 'C:\\Apps\\Notes.softn' });
    expect(native.save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: 'Notes.softn' }));
    await saveBundleToFile(new Uint8Array([7, 8]), 'Renamed app', handle);
    expect(native.save).toHaveBeenCalledTimes(1);
    expect(native.writeFile).toHaveBeenLastCalledWith('C:\\Apps\\Notes.softn', new Uint8Array([7, 8]));
  });

  it('never reports a cancelled or failed native save as a successful download', async () => {
    native.save.mockResolvedValue(null);
    await expect(saveDesktopFile(new Uint8Array([1]), 'Notes.softn')).rejects.toMatchObject({ name: 'AbortError' });
    expect(native.writeFile).not.toHaveBeenCalled();
    native.save.mockResolvedValue('/apps/Notes.softn');
    native.writeFile.mockRejectedValue(new Error('Disk full'));
    await expect(saveBundleToFile(new Uint8Array([1]), 'Notes')).rejects.toThrow('Disk full');
  });

  it('retains the opened file for Save without asking for another destination', async () => {
    const bytes = zipSync({
      'manifest.json': strToU8(JSON.stringify({ name: 'Notes', version: '1.0.0', main: 'ui/main.ui', files: { ui: ['ui/main.ui'], logic: [], xdb: [], assets: [] } })),
      'ui/main.ui': strToU8('<App><Text>Notes</Text></App>'),
    });
    native.open.mockResolvedValue('C:\\Apps\\Existing.softn');
    native.stat.mockResolvedValue({ size: bytes.length });
    native.readFile.mockResolvedValue(bytes);
    native.writeFile.mockResolvedValue(undefined);
    const bundle = await openBundleFile();
    expect(bundle?.sourceHandle?.name).toBe('Existing.softn');
    await saveBundleToFile(bytes, 'Notes', bundle?.sourceHandle);
    expect(native.save).not.toHaveBeenCalled();
    expect(native.writeFile).toHaveBeenCalledWith('C:\\Apps\\Existing.softn', bytes);
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
