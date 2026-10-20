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
import { base64ToBytes, bytesToBase64 } from './base64';

export interface SerializedAssetFile {
  bundlePath?: string;
  name: string;
  type: string;
  /** Base64 of the asset's bytes. */
  data: string;
}

export function encodeAsset(asset: AssetFile): SerializedAssetFile {
  return { ...(asset.bundlePath ? { bundlePath: asset.bundlePath } : {}), name: asset.name, type: asset.type, data: bytesToBase64(asset.data) };
}

export function decodeAsset(asset: SerializedAssetFile): AssetFile {
  return { ...(asset.bundlePath ? { bundlePath: asset.bundlePath } : {}), name: asset.name, type: asset.type, data: base64ToBytes(asset.data) };
}
