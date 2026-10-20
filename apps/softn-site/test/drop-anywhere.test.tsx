/**
 * The "drop to publish" overlay comes down when the file is dropped.
 *
 * While a file is dragged over the window the site dims the page and says
 * where a drop will go. The overlay follows a count of dragenter and
 * dragleave, and is taken down by the page-wide drop handler. The publish
 * form's own zone takes its drop and stops it there, so that the page-wide
 * handler does not take the same files twice — and so the handler that
 * takes the overlay down never ran. Nothing follows a drop to say the drag
 * has left, so the page stayed dimmed, with "Drop .softn files to publish
 * them" across it, after the file was already in the form.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { strToU8, zipSync } from 'fflate';

vi.mock('../src/lib/api', async () => ({
  ...(await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api')),
  getApp: () => Promise.reject(new Error('not in this test')),
}));

import { DropAnywhere } from '../src/components/DropAnywhere';
import { PublishPage } from '../src/pages/PublishPage';
import { takeDroppedBundles } from '../src/lib/dropped';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function bundleFile(fileName: string): File {
  const bytes = zipSync({
    'manifest.json': strToU8(JSON.stringify({ name: 'Notes', version: '1.0.0', description: 'Keeps notes', main: 'ui/main.ui' }), true),
    'ui/main.ui': strToU8('<App/>', true),
  });
  return new File([bytes as BlobPart], fileName, { type: 'application/zip' });
}

/** A drag event as the browser sends it for files from outside the page. */
function drag(target: Element, type: string, files: File[]): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files, dropEffect: 'none' } });
  act(() => {
    target.dispatchEvent(event);
  });
}

let container: HTMLElement;
let root: Root;

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

beforeEach(() => {
  localStorage.clear();
  takeDroppedBundles();
  // jsdom's File has no arrayBuffer(); FileReader does the job.
  Object.defineProperty(File.prototype, 'arrayBuffer', {
    configurable: true,
    writable: true,
    value(this: File) {
      return new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(this);
      });
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <>
        <PublishPage route={{ path: '/publish', query: new URLSearchParams() }} categories={[]} onCategories={() => {}} categoriesError={null} onRetryCategories={() => {}} />
        <DropAnywhere onPublishPage />
      </>,
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (File.prototype as unknown as { arrayBuffer?: unknown }).arrayBuffer;
});

describe('the drop overlay', () => {
  it('comes down when the file is dropped on the form’s own zone', async () => {
    const zone = container.querySelector('.dropzone')!;
    const file = bundleFile('notes.softn');
    drag(zone, 'dragenter', [file]);
    expect(container.querySelector('.drop-anywhere')).not.toBeNull();
    drag(zone, 'dragover', [file]);
    drag(zone, 'drop', [file]);
    await settle();

    expect(container.querySelector('.dropzone')?.textContent).toContain('notes.softn');
    expect(container.querySelector('.drop-anywhere')).toBeNull();
    // The zone took it; the page-wide handler did not stash a second copy.
    expect(takeDroppedBundles()).toEqual([]);
  });

  it('comes down when the file is dropped beside the zone, and the form takes it', async () => {
    const beside = container.querySelector('h1')!;
    const file = bundleFile('beside.softn');
    drag(beside, 'dragenter', [file]);
    expect(container.querySelector('.drop-anywhere')).not.toBeNull();
    drag(beside, 'drop', [file]);
    await settle();

    expect(container.querySelector('.drop-anywhere')).toBeNull();
    expect(container.querySelector('.dropzone')?.textContent).toContain('beside.softn');
  });

  // A dropped folder is one item of `dataTransfer.files`, which is not a
  // file, so a folder of bundles used to be "None of those is a .softn
  // bundle", on the zone and beside it alike.
  it.each([
    ['on the zone', '.dropzone'],
    ['beside the zone', 'h1'],
  ])('opens a folder dropped %s and lists the bundles in it', async (_where, selector) => {
    const target = container.querySelector(selector)!;
    const entry = (f: File) => ({ name: f.name, isFile: true, isDirectory: false, file: (ok: (f: File) => void) => ok(f) });
    const children = [entry(bundleFile('two.softn')), entry(new File(['notes'], 'notes.txt', { type: 'text/plain' })), entry(bundleFile('one.softn'))];
    const folder = {
      name: 'my-apps',
      isFile: false,
      isDirectory: true,
      createReader: () => {
        let done = false;
        return {
          readEntries: (ok: (batch: unknown[]) => void) => {
            const batch = done ? [] : children;
            done = true;
            setTimeout(() => ok(batch), 0);
          },
        };
      },
    };
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: { types: ['Files'], files: [new File([], 'my-apps')], items: [{ kind: 'file', webkitGetAsEntry: () => folder }], dropEffect: 'none' },
    });
    act(() => {
      target.dispatchEvent(event);
    });
    await settle();
    expect(container.textContent).not.toContain('None of those is a .softn bundle');
    const rows = [...container.querySelectorAll('.batch-item')];
    expect(rows.map((r) => r.querySelector('.batch-status')?.textContent)).toEqual(['ready', 'ready']);
    expect(rows.map((r) => r.querySelector('.muted')?.textContent?.trim())).toEqual([expect.stringContaining('v1.0.0'), expect.stringContaining('v1.0.0')]);
  });

  it('follows the pointer across elements while the drag is still over the page', () => {
    const zone = container.querySelector('.dropzone')!;
    const title = container.querySelector('h1')!;
    const file = bundleFile('notes.softn');
    drag(title, 'dragenter', [file]);
    drag(zone, 'dragenter', [file]);
    drag(title, 'dragleave', [file]);
    expect(container.querySelector('.drop-anywhere')).not.toBeNull();
    drag(zone, 'dragleave', [file]);
    expect(container.querySelector('.drop-anywhere')).toBeNull();
  });
});
