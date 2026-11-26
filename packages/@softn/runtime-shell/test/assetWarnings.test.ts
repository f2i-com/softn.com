/**
 * An asset whose extension has no registered type is served as opaque bytes
 * and says so once, whatever the extension is called: a name that is also a
 * property of every object (`constructor`, `toString`) is as unknown as any.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAssetResolver } from '../src/bundleFiles';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('an asset of an unregistered type', () => {
  it('is warned about once, even when its extension names an Object.prototype property', () => {
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:asset'), revokeObjectURL: vi.fn() });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const resolve = createAssetResolver(
      new Map([
        ['data/x.constructor', new Uint8Array([1])],
        ['data/y.tostring', new Uint8Array([2])],
        ['data/z.constructor', new Uint8Array([3])],
      ]),
      new Map()
    );
    expect(resolve('data/x.constructor')).toBe('blob:asset');
    expect(resolve('data/y.tostring')).toBe('blob:asset');
    expect(resolve('data/z.constructor')).toBe('blob:asset');
    const said = warn.mock.calls.map((call) => String(call[0]));
    expect(said.filter((line) => line.includes('No MIME type registered for .constructor'))).toHaveLength(1);
    expect(said.filter((line) => line.includes('No MIME type registered for .tostring'))).toHaveLength(1);
    resolve.dispose();
  });
});
