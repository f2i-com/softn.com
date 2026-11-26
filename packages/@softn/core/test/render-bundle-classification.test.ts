/**
 * A file's extension is looked up among the registry's own entries. Looked
 * up as a key of a plain object, `notes.constructor` or `data.valueOf`
 * found what every object inherits under that name, a function with no
 * `binary` and no `mime`: the bytes were read as text, which does not give
 * them back, and handed out with no type.
 */
import { describe, expect, it } from 'vitest';
import { classifyAsset } from '../src/bundle/asset-classification';
import { readBundle } from '../src/bundle/bundle';
import { zipSync, strToU8 } from 'fflate';

describe('a name whose extension is a word every object has', () => {
  it('is opaque bytes, as any extension the registry does not know', () => {
    for (const name of ['notes.constructor', 'data.valueOf', 'a.toString', 'b.hasOwnProperty', 'c.__proto__', 'd.isPrototypeOf']) {
      expect(classifyAsset(name), name).toEqual({ kind: 'binary', mime: 'application/octet-stream', binary: true });
    }
    // What the registry does know is as it was.
    expect(classifyAsset('model.glb')).toEqual({ kind: 'model', mime: 'model/gltf-binary', binary: true });
    expect(classifyAsset('main.ui').binary).toBe(false);
  });

  it('keeps its bytes when a bundle is read', async () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x81]);
    const bundle = await readBundle(
      zipSync({
        'manifest.json': strToU8(JSON.stringify({ name: 'x', version: '1.0.0', main: 'main.ui' })),
        'main.ui': strToU8('<p>x</p>'),
        'blob.constructor': bytes,
      })
    );
    const file = bundle.files.get('blob.constructor')!;
    expect(file.type).toBe('asset');
    expect(file.content).toEqual(bytes);
  });
});
