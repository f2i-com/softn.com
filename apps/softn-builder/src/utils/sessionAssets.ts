/**
 * Asset encoding for the locally saved builder session.
 *
 * Assets were left out of the session entirely, so restoring brought back a
 * project whose every `asset('logo.png')` resolved to nothing — images and
 * sounds silently gone, while the file tree still listed them.
 *
 * Base64 rather than the raw `Uint8Array`: `JSON.stringify` turns a byte array
 * into `{"0":80,"1":75,…}`, roughly seven bytes of text per byte of asset,
 * which would push almost any project past the storage quota.
 */

import type { AssetFile } from '../types/builder';

export interface SerializedAssetFile {
  name: string;
  type: string;
  /** Base64 of the asset's bytes. */
  data: string;
}

export function encodeAsset(asset: AssetFile): SerializedAssetFile {
  let binary = '';
  // Chunked: `String.fromCharCode(...bytes)` exceeds the argument limit on
  // anything bigger than a small icon.
  const CHUNK = 0x8000;
  for (let i = 0; i < asset.data.length; i += CHUNK) {
    binary += String.fromCharCode(...asset.data.subarray(i, i + CHUNK));
  }
  return { name: asset.name, type: asset.type, data: btoa(binary) };
}

export function decodeAsset(asset: SerializedAssetFile): AssetFile {
  const binary = atob(asset.data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { name: asset.name, type: asset.type, data: bytes };
}
