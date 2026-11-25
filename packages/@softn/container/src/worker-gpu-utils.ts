/**
 * Self-contained helpers shared only between the lazy worker GPU hosts
 * (`webgl-worker-host.ts` and `three-worker-host.ts`).
 *
 * Kept separate from `archive.ts` and `host-policy.ts` so `container-worker.js`
 * never splits a static `worker-chunks/chunk-*.js` dependency onto the startup path
 * of plain JS/TS/Python apps that do not use WebGL or Three.js.
 */

const MAX_CANVAS_SIDE = 8192;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function canvasSide(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(MAX_CANVAS_SIDE, Math.floor(value)))
    : 0;
}
