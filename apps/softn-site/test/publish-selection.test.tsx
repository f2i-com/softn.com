/**
 * The bytes the publish form uploads and the metadata it shows belong to
 * the same choice.
 *
 * The form used to set the chosen File the moment it was picked and commit
 * the inspection when the read finished, as two separate states. Pick A,
 * pick B while A is still being read, and A's read finishing last left the
 * zone naming B with A's manifest under it — and A's name in the form. A
 * batch read every file at once with no admission check, so a folder of
 * large bundles was loaded whole into memory before anything refused it.
 * Pinned here, on the pure controller and on the mounted page: a stale
 * read is discarded; an oversized batch is refused before a byte is read;
 * one bad file in a batch does not touch the others; a hand-off that
 * arrives after the visitor chose a file does not replace it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { strToU8, zipSync } from 'fflate';
import { admit, createSelectionController, isSettled, MAX_BATCH_BYTES, MAX_BATCH_FILES, MAX_FILE_BYTES, type SelectionState } from '../src/lib/selection';
import { inspectBundle } from '../src/lib/inspectBundle';

const takeBundleHandoff = vi.fn();
vi.mock('../src/lib/handoff', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/handoff')>('../src/lib/handoff');
  return { ...actual, takeBundleHandoff: (...args: unknown[]) => takeBundleHandoff(...args) };
});
vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return { ...actual, getApp: () => Promise.reject(new Error('not in this test')) };
});

import { PublishPage } from '../src/pages/PublishPage';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function bundleBytes(name: string): Uint8Array {
  return zipSync({
    'manifest.json': strToU8(JSON.stringify({ name, version: '1.0.0', description: `${name} does things`, main: 'ui/main.ui' }), true),
    'ui/main.ui': strToU8('<App/>', true),
  });
}

function bundleFile(name: string, fileName = `${name.toLowerCase()}.softn`): File {
  return new File([bundleBytes(name) as BlobPart], fileName, { type: 'application/zip' });
}

/** A file whose read the test finishes when it chooses to. */
function deferredRead(): { read: (f: File) => Promise<ArrayBuffer>; finish: (f: File) => Promise<void>; fail: (f: File, err: Error) => void; started: File[] } {
  const pending = new Map<File, { resolve: (b: ArrayBuffer) => void; reject: (e: Error) => void }>();
  const started: File[] = [];
  return {
    started,
    read: (f) =>
      new Promise<ArrayBuffer>((resolve, reject) => {
        started.push(f);
        pending.set(f, { resolve, reject });
      }),
    finish: async (f) => {
      const p = pending.get(f);
      if (!p) throw new Error(`no pending read for ${f.name}`);
      p.resolve(await realArrayBuffer(f));
      // Let the inspection and the state update run.
      await Promise.resolve();
      await Promise.resolve();
    },
    fail: (f, err) => {
      pending.get(f)?.reject(err);
    },
  };
}

/** jsdom's File has no arrayBuffer(); FileReader does the job. */
function realArrayBuffer(f: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(f);
  });
}

describe('admit', () => {
  it('refuses too many files, a file over the limit, and a batch over the aggregate limit, naming which', () => {
    const small = (n: number) => new File([new Uint8Array(10) as BlobPart], `b${n}.softn`);
    expect(admit([small(1), small(2)])).toEqual({ ok: true });
    const many = Array.from({ length: MAX_BATCH_FILES + 1 }, (_, i) => small(i));
    expect(admit(many)).toMatchObject({ ok: false, reason: expect.stringContaining(String(MAX_BATCH_FILES)) });
    // Sizes are checked from File.size, never by reading the file.
    const big = Object.defineProperty(new File([new Uint8Array(1) as BlobPart], 'big.softn'), 'size', { value: MAX_FILE_BYTES + 1 });
    expect(admit([small(1), big])).toMatchObject({ ok: false, reason: expect.stringContaining('big.softn') });
    // Each within the per-file limit; together over the batch limit.
    const each = Math.floor(MAX_BATCH_BYTES / 9);
    expect(each).toBeLessThan(MAX_FILE_BYTES);
    const nearLimit = (n: number) => Object.defineProperty(new File([new Uint8Array(1) as BlobPart], `h${n}.softn`), 'size', { value: each });
    expect(admit(Array.from({ length: 10 }, (_, i) => nearLimit(i)))).toMatchObject({ ok: false, reason: expect.stringContaining('together') });
  });
});

describe('the selection controller', () => {
  it('shows the later choice when the earlier read finishes last', async () => {
    const reads = deferredRead();
    const c = createSelectionController({ read: reads.read });
    const a = bundleFile('Alpha');
    const b = bundleFile('Beta');
    const first = c.select([a]);
    const second = c.select([b]);
    expect(c.state().items[0].file).toBe(b);
    expect(c.state().items[0].status).toBe('inspecting');

    await reads.finish(b);
    expect(c.state().items[0].status).toBe('ready');
    expect(c.state().items[0].info?.name).toBe('Beta');

    await reads.finish(a);
    // A's result arrived last and changed nothing: file and metadata are still B's.
    const item = c.state().items[0];
    expect(item.file).toBe(b);
    expect(item.info?.name).toBe('Beta');
    expect(await first).toEqual({ outcome: 'superseded' });
    expect(await second).toMatchObject({ outcome: 'settled' });
  });

  it('refuses an oversized batch before reading a single byte, and keeps what was selected', async () => {
    const reads = deferredRead();
    const c = createSelectionController({ read: reads.read });
    const a = bundleFile('Alpha');
    void c.select([a]);
    await reads.finish(a);
    const before = c.state();

    const big = Object.defineProperty(bundleFile('Huge'), 'size', { value: MAX_FILE_BYTES + 1 });
    const outcome = await c.select([bundleFile('Beta'), big]);
    expect(outcome).toMatchObject({ outcome: 'rejected', reason: expect.stringContaining('huge.softn') });
    expect(reads.started).toEqual([a]);
    expect(c.state()).toBe(before);

    const many = Array.from({ length: MAX_BATCH_FILES + 1 }, (_, i) => bundleFile(`N${i}`));
    expect(await c.select(many)).toMatchObject({ outcome: 'rejected' });
    expect(reads.started).toEqual([a]);
  });

  it('inspects a batch a few at a time, and one bad file leaves the others as they are', async () => {
    const reads = deferredRead();
    const c = createSelectionController({ read: reads.read, concurrency: 2 });
    const files = [bundleFile('One'), new File([strToU8('not a zip', true) as BlobPart], 'two.softn'), bundleFile('Three'), bundleFile('Four')];
    const done = c.select(files);
    // Two in flight, no more, until one finishes.
    expect(reads.started.length).toBe(2);
    await reads.finish(files[0]);
    expect(reads.started.length).toBe(3);
    reads.fail(files[1], new Error('The file could not be read.'));
    await Promise.resolve();
    await Promise.resolve();
    await reads.finish(files[2]);
    await reads.finish(files[3]);
    expect(await done).toMatchObject({ outcome: 'settled' });

    const items = c.state().items;
    expect(items.map((i) => i.status)).toEqual(['ready', 'rejected', 'ready', 'ready']);
    expect(items[1].error).toBe('The file could not be read.');
    expect(items[0].info?.name).toBe('One');
    expect(items[3].info?.name).toBe('Four');
    expect(isSettled(c.state())).toBe(true);
  });

  it('marks a bundle the inspector refuses as rejected, with the report kept', async () => {
    const c = createSelectionController({ read: realArrayBuffer });
    await c.select([new File([strToU8('nope', true) as BlobPart], 'nope.softn')]);
    const item = c.state().items[0];
    expect(item.status).toBe('rejected');
    expect(item.error).toMatch(/not a \.softn bundle/);
    expect(item.info?.report.length).toBeGreaterThan(0);
  });

  it('retries one item without touching the rest, and discards a retry the selection has moved past', async () => {
    const reads = deferredRead();
    const c = createSelectionController({ read: reads.read, concurrency: 4 });
    const files = [bundleFile('One'), bundleFile('Two')];
    const done = c.select(files);
    reads.fail(files[0], new Error('busy'));
    await reads.finish(files[1]);
    await done;
    expect(c.state().items.map((i) => i.status)).toEqual(['rejected', 'ready']);
    const two = c.state().items[1];

    const retry = c.retry(0);
    expect(c.state().items[0].status).toBe('inspecting');
    expect(c.state().items[1]).toBe(two);
    await reads.finish(files[0]);
    await retry;
    expect(c.state().items.map((i) => i.status)).toEqual(['ready', 'ready']);
    expect(c.state().items[1]).toBe(two);

    // A retry that lands after the visitor cleared the selection is dropped.
    reads.fail(files[0], new Error('busy'));
    const later = c.retry(0);
    c.clear();
    await reads.finish(files[0]);
    await later;
    expect(c.state().items).toEqual([]);
  });

  it('a reserved hand-off arriving after a newer choice is discarded', async () => {
    const reads = deferredRead();
    const c = createSelectionController({ read: reads.read });
    const ticket = c.reserve();
    const chosen = bundleFile('Chosen');
    void c.select([chosen]);
    await reads.finish(chosen);
    const handed = bundleFile('Handed');
    expect(await c.select([handed], { ticket })).toEqual({ outcome: 'superseded' });
    expect(reads.started).toEqual([chosen]);
    expect(c.state().items[0].file).toBe(chosen);

    // Reserved and nothing chosen since: the hand-off is taken, in its generation.
    const c2 = createSelectionController({ read: reads.read });
    const t2 = c2.reserve();
    const p = c2.select([handed], { ticket: t2, digest: 'abc' });
    await reads.finish(handed);
    expect(await p).toEqual({ outcome: 'settled', generation: t2 });
    expect(c2.state().items[0].digest).toBe('abc');
    expect(c2.state().generation).toBe(t2);
  });

  it('notifies subscribers with a fresh state object on every change', async () => {
    const reads = deferredRead();
    const c = createSelectionController({ read: reads.read });
    const seen: SelectionState[] = [];
    const off = c.subscribe((s) => seen.push(s));
    const a = bundleFile('Alpha');
    void c.select([a]);
    await reads.finish(a);
    expect(seen.length).toBe(2);
    expect(seen[0]).not.toBe(seen[1]);
    off();
    c.clear();
    expect(seen.length).toBe(2);
    expect(inspectBundle(bundleBytes('X')).name).toBe('X');
  });
});

describe('the publish page', () => {
  let container: HTMLElement;
  let root: Root;
  let reads: ReturnType<typeof deferredRead>;
  let arrayBuffer: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    reads = deferredRead();
    arrayBuffer = vi.fn(function (this: File) {
      return reads.read(this);
    });
    Object.defineProperty(File.prototype, 'arrayBuffer', { value: arrayBuffer, configurable: true, writable: true });
    takeBundleHandoff.mockReset();
    window.history.replaceState({}, '', '/publish');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (File.prototype as unknown as { arrayBuffer?: unknown }).arrayBuffer;
  });

  function mount(search = ''): void {
    window.history.replaceState({}, '', `/publish${search}`);
    act(() => {
      root.render(<PublishPage route={{ path: '/publish', query: new URLSearchParams(search) }} categories={[{ id: 'games', name: 'Games', emoji: '', description: '', apps: 1, suggested: false }]} onCategories={() => {}} categoriesError={null} onRetryCategories={() => {}} />);
    });
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  const pick = (files: File[]) => {
    const input = container.querySelector<HTMLInputElement>('.dropzone input[type="file"]')!;
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    act(() => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };
  const submitButton = () => [...container.querySelectorAll<HTMLButtonElement>('button[type="submit"]')].find((b) => /Publish/.test(b.textContent ?? ''))!;
  const nameField = () => container.querySelector<HTMLInputElement>('input[placeholder="What it is called"]')!;

  it('shows B and would upload B when A was chosen first and read last', async () => {
    mount();
    const a = bundleFile('Alpha');
    const b = bundleFile('Beta');
    pick([a]);
    pick([b]);
    await settle();
    expect(container.querySelector('.dropzone')?.textContent).toContain('beta.softn');
    expect(submitButton().disabled).toBe(true);

    await act(() => reads.finish(b));
    await settle();
    await act(() => reads.finish(a));
    await settle();

    const zone = container.querySelector('.dropzone')!;
    expect(zone.textContent).toContain('beta.softn');
    expect(zone.textContent).toContain('Beta v1.0.0');
    expect(zone.textContent).not.toContain('Alpha');
    expect(nameField().value).toBe('Beta');
    // Ready, with a category picked, the form submits B's bytes.
    const select = container.querySelector<HTMLSelectElement>('select')!;
    act(() => {
      select.value = 'games';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(submitButton().disabled).toBe(false);
  });

  it('refuses an oversized folder before reading any file', async () => {
    mount();
    const files = Array.from({ length: MAX_BATCH_FILES + 1 }, (_, i) => bundleFile(`N${i}`));
    pick(files);
    await settle();
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(String(MAX_BATCH_FILES));
  });

  it('lists a batch with the bad file skipped and the others ready', async () => {
    mount();
    const files = [bundleFile('One'), new File([strToU8('not a zip', true) as BlobPart], 'two.softn'), bundleFile('Three')];
    pick(files);
    await settle();
    expect(container.textContent).toContain('Reading 3 bundles');
    for (const f of files) {
      await act(() => reads.finish(f));
    }
    await settle();
    const rows = [...container.querySelectorAll('.batch-item')];
    expect(rows.length).toBe(3);
    expect(rows[0].textContent).toContain('One');
    expect(rows[0].textContent).toContain('ready');
    expect(rows[1].textContent).toContain('skipped');
    expect(rows[1].textContent).toMatch(/not a \.softn bundle/);
    expect(rows[2].textContent).toContain('Three');
    expect(rows[2].textContent).toContain('ready');
  });

  it('does not let a hand-off that arrives late replace the file the visitor chose', async () => {
    let resolveHandoff: (v: unknown) => void = () => {};
    takeBundleHandoff.mockImplementation(() => new Promise((resolve) => (resolveHandoff = resolve)));
    mount('?from=handoff&handoff=abcdefghijklmnop');
    await settle();
    const chosen = bundleFile('Chosen');
    pick([chosen]);
    await act(() => reads.finish(chosen));
    await settle();
    expect(nameField().value).toBe('Chosen');

    await act(async () => {
      resolveHandoff({ ok: true, handoff: { id: 'abcdefghijklmnop', bytes: bundleBytes('Handed'), name: 'Handed', from: 'builder', to: 'publish', digest: 'd', stagedAt: Date.now() } });
      await Promise.resolve();
    });
    await settle();
    expect(reads.started.map((f) => f.name)).toEqual(['chosen.softn']);
    expect(container.querySelector('.dropzone')?.textContent).toContain('chosen.softn');
    expect(nameField().value).toBe('Chosen');
  });
});
