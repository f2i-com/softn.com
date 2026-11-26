/**
 * What a mount lets go of when it is disposed, while the host still holds its handle (a
 * component's state, a list of open apps): not the app's files, nor its databases.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import { ContainerArchive, mountSoftNContainer, type SoftNContainerHandle } from '../src/index';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;

const PKG_ROOT = path.resolve(__dirname, '..');
const LITE_WASM = new Uint8Array(fs.readFileSync(path.join(PKG_ROOT, 'dist', 'runtime', 'engines', 'zipp-javascript-lite.wasm')));

async function collected(ref: WeakRef<object>): Promise<boolean> {
  for (let i = 0; i < 10 && ref.deref() !== undefined; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    gc();
  }
  return ref.deref() === undefined;
}

let restore: (() => void) | null = null;

afterEach(() => {
  restore?.();
  restore = null;
  document.body.innerHTML = '';
});

describe('a disposed mount', () => {
  it("holds none of the app's files for its next page once disposed, though its handle is still held", async () => {
    let vfsRef: WeakRef<object> | null = null;
    // Patched by hand: a spy keeps every value it returned, and would hold the files itself.
    const real = ContainerArchive.prototype.exportWorkerVfs;
    ContainerArchive.prototype.exportWorkerVfs = function (this: ContainerArchive) {
      const vfs = real.call(this);
      vfsRef = new WeakRef(vfs);
      return vfs;
    };
    restore = () => {
      ContainerArchive.prototype.exportWorkerVfs = real;
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    let handle: SoftNContainerHandle | null = await mountSoftNContainer(host, {
      isolation: 'inline',
      persistStorage: false,
      permissionMode: 'deny',
      engineWasm: { lite: LITE_WASM },
      source: {
        'index.html': '<!doctype html><html><body><p id="out">-</p><script src="app.js"></script></body></html>',
        'app.js': `document.getElementById('out').textContent = 'ran';`,
        'big.txt': 'x'.repeat(1_000_000),
      },
    });
    await expect.poll(() => handle!.shadowRoot.getElementById('out')?.textContent, { timeout: 10_000 }).toBe('ran');
    expect(vfsRef).not.toBeNull();
    handle.dispose();
    // The host keeps the handle (its state still names it).
    const kept = handle;
    handle = null;
    expect(await collected(vfsRef!)).toBe(true);
    expect(kept.appId).toBeTruthy();
  });
});
