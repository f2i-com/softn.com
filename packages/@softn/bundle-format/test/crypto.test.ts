import { createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID, sha256Hex } from '../src/crypto';
import { sha256 } from '../src/sha256';

const nodeSha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
// A plain Uint8Array, the type the browser code is written for, not a Node Buffer.
const random = (length: number) => new Uint8Array(randomBytes(length));
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A page outside a secure context: getRandomValues, and neither subtle nor randomUUID. */
function insecureContext() {
  const platform = globalThis.crypto;
  vi.stubGlobal('crypto', { getRandomValues: <T extends ArrayBufferView>(array: T) => platform.getRandomValues(array) });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sha256, for where crypto.subtle is withheld', () => {
  // Padding goes wrong at the block edges: 55 bytes is the most that fits one
  // block with its length, 56 needs a second, 64 is exactly one.
  it.each([0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000])('agrees with node:crypto on %i bytes', (length) => {
    const bytes = random(length);
    expect(hex(sha256(bytes))).toBe(nodeSha256(bytes));
  });

  it('agrees on the standard test vectors', () => {
    expect(hex(sha256(new Uint8Array()))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(hex(sha256(new TextEncoder().encode('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('agrees on a megabyte, and hashes only the view it is given', () => {
    const bytes = random(1 << 20);
    expect(hex(sha256(bytes))).toBe(nodeSha256(bytes));
    const view = new Uint8Array(bytes.buffer, bytes.byteOffset + 10, 1000);
    expect(hex(sha256(view))).toBe(nodeSha256(view));
  });
});

describe('sha256Hex', () => {
  it('is the platform digest where there is one', async () => {
    const bytes = random(300);
    expect(await sha256Hex(bytes)).toBe(nodeSha256(bytes));
  });

  it('is the same digest outside a secure context', async () => {
    const bytes = random(300);
    insecureContext();
    expect(globalThis.crypto.subtle).toBeUndefined();
    expect(await sha256Hex(bytes)).toBe(nodeSha256(bytes));
  });
});

describe('randomUUID', () => {
  it('is a version-4 UUID with or without the platform one', () => {
    expect(randomUUID()).toMatch(UUID_V4);
    insecureContext();
    expect(typeof globalThis.crypto.randomUUID).toBe('undefined');
    const ids = new Set(Array.from({ length: 1000 }, () => randomUUID()));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(UUID_V4);
  });
});
