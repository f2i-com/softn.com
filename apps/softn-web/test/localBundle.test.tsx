// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_ZIP_INPUT_BYTES } from '@softn/core';
import { readLocalBundle } from '../src/lib/localBundle';
import { DropZone } from '../src/components/DropZone';
import { useLocalBundleFile } from '../src/lib/useLocalBundleFile';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function file(name = 'notes.softn', size = 4, read = vi.fn().mockResolvedValue(new ArrayBuffer(4))): File {
  return { name, size, arrayBuffer: read } as unknown as File;
}

describe('local bundle preflight', () => {
  it('accepts uppercase extensions and returns the file bytes', async () => {
    expect(await readLocalBundle(file('NOTES.SOFTN'))).toEqual(new Uint8Array(4));
  });
  it('rejects oversized files before allocating their contents', async () => {
    const read = vi.fn();
    await expect(readLocalBundle(file('notes.softn', MAX_ZIP_INPUT_BYTES + 1, read))).rejects.toThrow('too large');
    expect(read).not.toHaveBeenCalled();
  });
  it('rejects other file types before reading them', async () => {
    const read = vi.fn();
    await expect(readLocalBundle(file('notes.json', 4, read))).rejects.toThrow('.softn');
    expect(read).not.toHaveBeenCalled();
  });
  it('gives actionable feedback when the device cannot read a file', async () => {
    await expect(readLocalBundle(file('notes.softn', 4, vi.fn().mockRejectedValue(new Error('device disconnected')))))
      .rejects.toThrow('Try selecting the file again');
  });
});

describe('runtime file drops', () => {
  let host: HTMLDivElement;
  let root: Root;
  let mounted: boolean;
  const onFile = vi.fn();
  const onError = vi.fn();
  function RuntimeFiles(): React.ReactElement {
    const openFile = useLocalBundleFile(onFile, onError);
    return <DropZone onFile={openFile} onError={onError}><input /></DropZone>;
  }
  beforeEach(() => {
    vi.clearAllMocks();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    mounted = true;
    act(() => root.render(<RuntimeFiles />));
  });
  afterEach(() => {
    if (mounted) act(() => root.unmount());
    host.remove();
  });
  async function drag(type: string, files: File[] = [], types: string[] = ['Files']): Promise<Event> {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { files, types } });
    await act(async () => { host.querySelector('input')!.dispatchEvent(event); });
    return event;
  }
  it('leaves text drags and drops inside the app untouched', async () => {
    for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
      expect((await drag(type, [], ['text/plain'])).defaultPrevented).toBe(false);
      expect(host.querySelector('[role="status"]')).toBeNull();
    }
    expect(onFile).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
  it('shows feedback for file drags and opens uppercase app files', async () => {
    expect((await drag('dragenter')).defaultPrevented).toBe(true);
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Drop your');
    await drag('drop', [file('NOTES.SOFTN')]);
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(onFile).toHaveBeenCalledWith(new Uint8Array(4), 'NOTES.SOFTN');
  });
  it('respects upload zones and native file inputs inside a running app', async () => {
    const input = host.querySelector('input')!;
    const prevent = (event: Event) => event.preventDefault();
    input.addEventListener('drop', prevent);
    await drag('dragenter');
    await drag('drop', [file('records.csv')]);
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(onError).not.toHaveBeenCalled();
    input.removeEventListener('drop', prevent);
    input.type = 'file';
    expect((await drag('dragenter')).defaultPrevented).toBe(false);
    expect((await drag('drop', [file('records.csv')])).defaultPrevented).toBe(false);
    expect(onFile).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
  it('reports unsupported files and failed reads through the visible error channel', async () => {
    await drag('drop', [file('image.png')]);
    expect(onError.mock.calls[0][0].message).toContain('Drop a .softn');
    await drag('drop', [file('notes.softn', 4, vi.fn().mockRejectedValue(new Error('read failed')))]);
    expect(onError.mock.calls[1][0].message).toContain('could not be read');
  });
  it('does not reopen a file whose read finished after a newer selection', async () => {
    let finish!: (value: ArrayBuffer) => void;
    await drag('drop', [file('old.softn', 4, vi.fn(() => new Promise<ArrayBuffer>((resolve) => { finish = resolve; })))]);
    await drag('drop', [file('new.softn')]);
    await act(async () => finish(new ArrayBuffer(4)));
    expect(onFile).toHaveBeenCalledTimes(1);
    expect(onFile.mock.calls[0][1]).toBe('new.softn');
  });
  it('does not open files after the runtime unmounts', async () => {
    let finish!: (value: ArrayBuffer) => void;
    await drag('drop', [file('old.softn', 4, vi.fn(() => new Promise<ArrayBuffer>((resolve) => { finish = resolve; })))]);
    act(() => root.unmount());
    mounted = false;
    await act(async () => finish(new ArrayBuffer(4)));
    expect(onFile).not.toHaveBeenCalled();
  });
});
