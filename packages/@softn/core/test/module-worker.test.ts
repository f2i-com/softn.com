/**
 * A Worker whose script is outside the page's service-worker scope is started through a
 * one-line `blob:` module, so the page's service worker answers for it (and for what it
 * imports) offline; every other Worker is started exactly as written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { outsideServiceWorkerScope, ScopedWorker, startModuleWorker } from '../src/runtime/module-worker';

interface Started {
  url: string | URL;
  options?: WorkerOptions;
}

const ORIGIN = 'https://softn.test';
let started: Started[];
/** A blob as it was made: what it holds is read without waiting on a reader. */
interface MadeBlob {
  parts: BlobPart[];
  type: string;
}
let blobs: MadeBlob[];
let revoked: string[];

function control(scriptURL: string | null): void {
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: scriptURL === null ? { controller: null } : { controller: { scriptURL } },
  });
}

const text = (blob: MadeBlob): string => blob.parts.join('');

beforeEach(() => {
  started = [];
  blobs = [];
  revoked = [];
  vi.useFakeTimers();
  vi.stubGlobal(
    'Worker',
    class {
      constructor(url: string | URL, options?: WorkerOptions) {
        started.push({ url, options });
      }
    }
  );
  vi.stubGlobal('location', new URL(`${ORIGIN}/web/app/~Notes`));
  vi.stubGlobal(
    'Blob',
    class {
      readonly parts: BlobPart[];
      readonly type: string;
      constructor(parts: BlobPart[] = [], options: BlobPropertyBag = {}) {
        this.parts = parts;
        this.type = options.type ?? '';
      }
    }
  );
  URL.createObjectURL = vi.fn((blob: Blob) => {
    blobs.push(blob as unknown as MadeBlob);
    return `blob:${ORIGIN}/${blobs.length}`;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  }) as typeof URL.revokeObjectURL;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'serviceWorker');
});

describe('which Worker scripts the page’s service worker does not reach', () => {
  it('none, when no service worker controls the page', () => {
    control(null);
    expect(outsideServiceWorkerScope(`${ORIGIN}/shared/assets/core-runtime/runtime/script-worker.js`)).toBe(false);
    Reflect.deleteProperty(navigator, 'serviceWorker');
    expect(outsideServiceWorkerScope(`${ORIGIN}/shared/assets/zipWorker-AY6hx7tf.js`)).toBe(false);
  });

  it('one outside the service worker’s own folder; not one under it, however deep', () => {
    control(`${ORIGIN}/web/sw.js`);
    expect(outsideServiceWorkerScope(`${ORIGIN}/web/assets/core-runtime/runtime/script-worker.js`)).toBe(false);
    expect(outsideServiceWorkerScope(`${ORIGIN}/web/assets/zipWorker-AY6hx7tf.js`)).toBe(false);
    expect(outsideServiceWorkerScope(`${ORIGIN}/shared/assets/core-runtime/runtime/script-worker.js`)).toBe(true);
    expect(outsideServiceWorkerScope(`${ORIGIN}/shared/container-runtime/e03138f892dd/container-worker.js`)).toBe(true);
    // A folder whose name only starts the same is another folder.
    expect(outsideServiceWorkerScope(`${ORIGIN}/webinar/worker.js`)).toBe(true);
    // A service worker at the root reaches everything.
    control(`${ORIGIN}/sw.js`);
    expect(outsideServiceWorkerScope(`${ORIGIN}/shared/assets/zipWorker-AY6hx7tf.js`)).toBe(false);
  });
});

describe('starting a module Worker', () => {
  it('is the plain constructor where the script is in scope, or nothing controls the page', () => {
    control(null);
    const url = new URL(`${ORIGIN}/shared/assets/core-runtime/runtime/script-worker.js`);
    startModuleWorker(url);
    control(`${ORIGIN}/web/sw.js`);
    startModuleWorker(`${ORIGIN}/web/assets/core-runtime/runtime/sandbox-worker.js`, { name: 'sandbox' });
    expect(started).toEqual([
      // The address as it was given, a URL object or text.
      { url, options: { type: 'module' } },
      { url: `${ORIGIN}/web/assets/core-runtime/runtime/sandbox-worker.js`, options: { type: 'module', name: 'sandbox' } },
    ]);
    expect(blobs).toEqual([]);
  });

  it('is a one-line module that imports the script, where the script is out of the service worker’s reach', () => {
    control(`${ORIGIN}/web/sw.js`);
    startModuleWorker(new URL(`${ORIGIN}/shared/assets/core-runtime/runtime/model-worker.js`), { name: 'model' });
    expect(started).toEqual([{ url: `blob:${ORIGIN}/1`, options: { type: 'module', name: 'model' } }]);
    expect(blobs).toHaveLength(1);
    expect(blobs[0].type).toBe('text/javascript');
    expect(text(blobs[0])).toBe(`import "${ORIGIN}/shared/assets/core-runtime/runtime/model-worker.js";`);
    // The address is given back once the Worker has had every chance to read it.
    expect(revoked).toEqual([]);
    vi.advanceTimersByTime(60_000);
    expect(revoked).toEqual([`blob:${ORIGIN}/1`]);
  });

  it('writes the address as a string of the module, whatever it holds', () => {
    control(`${ORIGIN}/web/sw.js`);
    // Relative to the page, with a quote and a line break in it: nothing of it is read as code.
    startModuleWorker('/shared/assets/odd"name\n.js');
    const source = text(blobs[0]);
    expect(source.startsWith('import "')).toBe(true);
    expect(source).not.toContain('\n');
    expect(JSON.parse(source.slice('import '.length, -1))).toBe(`${ORIGIN}/shared/assets/odd%22name.js`);
  });

  it('under the bundler’s spelling: a constructor that gives back the Worker', () => {
    control(`${ORIGIN}/web/sw.js`);
    const Worker = ScopedWorker;
    const worker = new Worker(new URL(`${ORIGIN}/shared/assets/zipWorker-AY6hx7tf.js`), { type: 'module' });
    expect(started).toEqual([{ url: `blob:${ORIGIN}/1`, options: { type: 'module' } }]);
    expect(worker).toBeInstanceOf(globalThis.Worker);
  });
});
