/**
 * The Data tab tells a database changed elsewhere from its own last save by
 * this signature, so a change anywhere in the file has to change it.
 */
import { describe, expect, it } from 'vitest';
import { sqliteBytesSignature } from '../src/sqliteDatabase';

describe('sqliteBytesSignature', () => {
  it('changes when one byte of a large database changes, wherever it is', () => {
    const before = new Uint8Array(1024 * 1024);
    for (let i = 0; i < before.length; i++) before[i] = (i * 31) & 0xff;
    const signature = sqliteBytesSignature(before);
    // Positions a sample of every 64th byte never read, and ones it did.
    for (const at of [1, 63, 4097, 65_537, before.length - 2, 0, 64]) {
      const after = before.slice();
      after[at] ^= 0x5a;
      expect(sqliteBytesSignature(after), `byte ${at}`).not.toBe(signature);
    }
  });

  it('is the same for the same bytes in any buffer, and says empty for none', () => {
    const bytes = new Uint8Array([83, 81, 76, 105, 116, 101, 32, 102, 111, 114, 109, 97, 116]);
    const inLargerBuffer = new Uint8Array(bytes.length + 3);
    inLargerBuffer.set(bytes, 3);
    expect(sqliteBytesSignature(inLargerBuffer.subarray(3))).toBe(sqliteBytesSignature(bytes));
    expect(sqliteBytesSignature(new Uint8Array(0))).toBe('empty');
    expect(sqliteBytesSignature(null)).toBe('empty');
  });
});
