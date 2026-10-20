/**
 * Bytes as base64 and back: a session's assets and kept files, and a
 * project's icon as a data URL. Each place that needed it had a copy of its
 * own, six in all.
 */

/**
 * `bytes` as base64. In chunks: `String.fromCharCode(...bytes)` exceeds the
 * argument limit on anything bigger than a small icon.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

/** The bytes `text` holds as base64. Throws, as `atob` does, on text that is not base64. */
export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
