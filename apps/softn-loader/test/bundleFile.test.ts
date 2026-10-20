import { describe, expect, it } from 'vitest';
import { computeBundleAppId, isSoftnPath } from '../src/bundleFile';

describe('a .softn file on the desktop', () => {
  it('uses deterministic content identity rather than a manifest display name', async () => {
    const first = await computeBundleAppId(new Uint8Array([1, 2, 3]));
    const same = await computeBundleAppId(new Uint8Array([1, 2, 3]));
    const different = await computeBundleAppId(new Uint8Array([1, 2, 4]));

    expect(first).toMatch(/^bundle-[0-9a-f]{64}$/);
    // The digest the native side computes for the same bytes (data_identity.rs, bundle_digest).
    expect(first).toBe('bundle-039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81');
    expect(same).toBe(first);
    expect(different).not.toBe(first);
  });

  it('hashes only the bytes a view covers, not the buffer under it', async () => {
    const buffer = new Uint8Array([9, 1, 2, 3, 9]);
    expect(await computeBundleAppId(buffer.subarray(1, 4))).toBe(await computeBundleAppId(new Uint8Array([1, 2, 3])));
  });

  it('recognizes app files regardless of extension casing', () => {
    expect(isSoftnPath('C:\\Apps\\Fieldnotes.SOFTN')).toBe(true);
    expect(isSoftnPath('C:\\Apps\\Fieldnotes.softn.zip')).toBe(false);
  });
});
