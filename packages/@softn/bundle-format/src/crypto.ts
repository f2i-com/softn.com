/**
 * The two pieces of Web Crypto SoftN's pages use that a browser withholds
 * outside a secure context: `crypto.subtle` and `crypto.randomUUID`. A site
 * served over plain HTTP from anywhere but localhost (an intranet address,
 * say) is such a context, and there the play page could not check the bundle
 * it fetched and the runtime stopped at its first tab id. Each is used where
 * the platform has it; otherwise the same result comes from here.
 * `crypto.getRandomValues` is not withheld, so a fallback UUID is as random
 * as the platform's own.
 */

/** A random (version 4) UUID. */
export function randomUUID(): string {
  const platform = globalThis.crypto;
  if (typeof platform.randomUUID === 'function') return platform.randomUUID();
  const bytes = platform.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * SHA-256 of the bytes, as lower-case hex. Where crypto.subtle is withheld
 * the same digest comes from ./sha256, which is fetched only then: a secure
 * page, nearly every visit, never loads it.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return toHex((await import('./sha256')).sha256(bytes));
  // A copy into a plain buffer: a view over a larger buffer would hash the whole buffer.
  return toHex(new Uint8Array(await subtle.digest('SHA-256', new Uint8Array(bytes))));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
