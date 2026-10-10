/**
 * A project's assets in the browser's store, apart from its text.
 *
 * The record a session is restored from held the project whole: every
 * page, and every picture as base64 inside the same string. That was one
 * write at each Save. Once unsaved work was kept as it is made
 * (utils/recoveryCopy.ts) it was that write at every change, megabytes of
 * pictures re-encoded for a word typed; so the copy left the assets out
 * above a budget, and then a project whose pictures the store had been
 * keeping since its last Save lost them from the record at the first edit
 * after it.
 *
 * Text changes all the time and assets hardly ever, so they are kept
 * apart. The session's text names each asset (`files.assetRefs`: its place,
 * its size and a hash of its bytes) and holds none of them. The assets are
 * one record of their own, written when the set changes and not otherwise:
 *
 *  - The signature of a set is, for each asset in the order of its id, the
 *    id, the path, the type, the length in bytes and a hash of the bytes:
 *    a 32-bit FNV-1a beside a second 32-bit hash that mixes in where each
 *    byte stands. The hash is worked out once for each byte array (an
 *    asset that is replaced is a new array) and remembered, so asking for
 *    the signature at every change costs nothing after the first.
 *  - A small head record holds the signature that is stored and the tab
 *    that stored it. It is read before each write, so a set another tab has
 *    put in the store since is seen and written over: the last writer wins
 *    for the assets as it does for the text, and the other tab is told
 *    (hooks/useRecoveryCopy.ts hears either key change).
 *  - The text is written first. If the store then refuses the assets, the
 *    text is kept all the same and the older set is left where it was: a
 *    restore puts back each asset the text names that the store still has
 *    (matched by id, size and hash), leaves out the rest with their places
 *    in the file tree, and the offer says how many are not in it. A set the
 *    store has refused is not encoded and tried again at every change: it
 *    is tried again when the set is another, and by a Save, which is asked
 *    for and may come after room has been made.
 *  - A project with no assets removes the record: megabytes of another
 *    project's pictures would otherwise sit in a store a few megabytes deep.
 *
 * A record written before this (assets inline in the session) restores as
 * it always did: joining leaves it as it is.
 */

import type { AssetFile } from '../types/builder';
import { encodeAsset, type SerializedAssetFile } from './sessionAssets';

export const SESSION_ASSETS_KEY = 'softn.builder.session.assets.v1';
export const SESSION_ASSETS_HEAD_KEY = 'softn.builder.session.assets.head.v1';

/** This page, among the tabs the editor is open in. */
export const TAB_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** An asset as the session's text names it: where it is, and enough to know its bytes again. */
export interface AssetRef {
  bundlePath?: string;
  name: string;
  type: string;
  size: number;
  hash: string;
}

/** A project's assets as they stood at one moment: what the text names, and the bytes themselves. */
export interface CapturedAssets {
  signature: string;
  refs: Array<[string, AssetRef]>;
  files: Array<[string, AssetFile]>;
}

/** The store, as much of it as is used. A store handed in by a test may only write. */
export type AssetStore = Pick<Storage, 'setItem'> & Partial<Pick<Storage, 'getItem' | 'removeItem'>>;

const hashes = new WeakMap<Uint8Array, string>();

/** A 32-bit FNV-1a of the bytes beside a second 32-bit hash that mixes in each byte's place, remembered for the array. */
function hashOf(bytes: Uint8Array): string {
  const known = hashes.get(bytes);
  if (known !== undefined) return known;
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < bytes.length; i++) {
    a = Math.imul(a ^ bytes[i], 0x01000193);
    b = Math.imul(b ^ ((bytes[i] + i) & 0xff), 0x85ebca6b);
  }
  const hash = `${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}`;
  hashes.set(bytes, hash);
  return hash;
}

export function assetRef(asset: AssetFile): AssetRef {
  return { ...(asset.bundlePath ? { bundlePath: asset.bundlePath } : {}), name: asset.name, type: asset.type, size: asset.data.byteLength, hash: hashOf(asset.data) };
}

/** The assets as they stand: the same objects, which are never changed in place. */
export function captureAssets(assetFiles: ReadonlyMap<string, AssetFile>): CapturedAssets {
  const files = [...assetFiles.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const refs = files.map(([id, asset]) => [id, assetRef(asset)] as [string, AssetRef]);
  const signature = refs.map(([id, ref]) => [id, ref.bundlePath ?? ref.name, ref.type, ref.size, ref.hash].join('\t')).join('\n');
  return { signature, refs, files };
}

export type AssetsStored =
  | { kind: 'none' }
  | { kind: 'unchanged' }
  | { kind: 'written' }
  | { kind: 'refused'; error: unknown };

/** The signature of a set the store would not take, so that it is not encoded again for every change. */
let refused: string | null = null;

function storedSignature(storage: AssetStore): string | null {
  try {
    const head = storage.getItem?.(SESSION_ASSETS_HEAD_KEY);
    if (!head) return null;
    const signature = (JSON.parse(head) as { signature?: unknown }).signature;
    return typeof signature === 'string' ? signature : null;
  } catch {
    return null;
  }
}

/**
 * Put the set in the store, unless it is the set that is there. Never
 * throws. `again` asks the store for a set it has refused before.
 */
export function storeAssets(storage: AssetStore, captured: CapturedAssets, options: { again?: boolean } = {}): AssetsStored {
  if (captured.files.length === 0) {
    try {
      if (storage.getItem?.(SESSION_ASSETS_HEAD_KEY) != null || storage.getItem?.(SESSION_ASSETS_KEY) != null) {
        storage.removeItem?.(SESSION_ASSETS_KEY);
        storage.removeItem?.(SESSION_ASSETS_HEAD_KEY);
      }
    } catch {
      // A record that cannot be removed is one nothing names any more.
    }
    refused = null;
    return { kind: 'none' };
  }
  if (storedSignature(storage) === captured.signature) return { kind: 'unchanged' };
  if (refused === captured.signature && !options.again) return { kind: 'refused', error: new Error('the store would not take this set of assets') };
  try {
    const files = captured.files.map(([id, asset], at) => [id, { ...encodeAsset(asset), size: captured.refs[at][1].size, hash: captured.refs[at][1].hash }]);
    storage.setItem(SESSION_ASSETS_KEY, JSON.stringify({ signature: captured.signature, files }));
  } catch (error) {
    refused = captured.signature;
    return { kind: 'refused', error };
  }
  refused = null;
  try {
    storage.setItem(SESSION_ASSETS_HEAD_KEY, JSON.stringify({ signature: captured.signature, tab: TAB_ID }));
  } catch {
    // Without its head the set is written again next time, which is all that is lost.
  }
  return { kind: 'written' };
}

/** For tests: forget which set the store refused. */
export function resetRefusedAssets(): void {
  refused = null;
}

/** How many assets a stored session names, and how many of them the store does not have. */
export interface AssetsKept {
  total: number;
  missing: number;
}

type StoredAsset = SerializedAssetFile & { size?: unknown; hash?: unknown };

/**
 * A stored session with its assets put back into it from their own record:
 * the shape a session has always been restored from. Each asset the text
 * names that the store still has is put back; one it has not is left out,
 * with its place in the file tree, its tab and the focus if it had it. A
 * session that holds its assets itself, as every record did before they
 * were kept apart, is handed back as it is.
 */
export function joinStoredSession(raw: string, assetsRaw: string | null): { raw: string; assets: AssetsKept } {
  let session: { files?: { assetRefs?: unknown; assetFiles?: unknown; nodes?: unknown; openTabs?: unknown; activeFileId?: unknown } };
  try {
    session = JSON.parse(raw);
  } catch {
    return { raw, assets: { total: 0, missing: 0 } };
  }
  const files = session?.files;
  if (!files || typeof files !== 'object' || !Array.isArray(files.assetRefs)) {
    const inline = Array.isArray(files?.assetFiles) ? files.assetFiles.length : 0;
    return { raw, assets: { total: inline, missing: 0 } };
  }

  const stored = new Map<string, StoredAsset>();
  try {
    const record = assetsRaw ? (JSON.parse(assetsRaw) as { files?: unknown }) : null;
    for (const entry of Array.isArray(record?.files) ? record.files : []) {
      if (Array.isArray(entry) && typeof entry[0] === 'string' && entry[1] && typeof entry[1] === 'object' && typeof (entry[1] as StoredAsset).data === 'string') {
        stored.set(entry[0], entry[1] as StoredAsset);
      }
    }
  } catch {
    // A record that cannot be read holds nothing.
  }

  const kept: Array<[string, SerializedAssetFile]> = [];
  const gone = new Set<string>();
  const refs = files.assetRefs as Array<[string, AssetRef]>;
  for (const [id, ref] of refs) {
    const found = stored.get(id);
    if (found && found.size === ref.size && found.hash === ref.hash) {
      kept.push([id, { ...(ref.bundlePath ? { bundlePath: ref.bundlePath } : {}), name: ref.name, type: ref.type, data: found.data }]);
    } else {
      gone.add(id);
    }
  }
  files.assetFiles = kept;
  delete files.assetRefs;
  if (gone.size > 0) {
    if (Array.isArray(files.nodes)) {
      files.nodes = (files.nodes as Array<[string, { children?: string[] }]>)
        .filter(([id]) => !gone.has(id))
        .map(([id, node]) => (node?.children?.some((child) => gone.has(child)) ? [id, { ...node, children: node.children.filter((child) => !gone.has(child)) }] : [id, node]));
    }
    if (Array.isArray(files.openTabs)) files.openTabs = (files.openTabs as string[]).filter((id) => !gone.has(id));
    if (typeof files.activeFileId === 'string' && gone.has(files.activeFileId)) files.activeFileId = null;
  }
  return { raw: JSON.stringify(session), assets: { total: refs.length, missing: gone.size } };
}

/** What the offer to restore says of assets that are not in the copy; nothing when all of them are. */
export function missingAssetsSentence(assets: AssetsKept): string {
  if (assets.missing === 0) return '';
  const which = assets.missing >= assets.total ? 'Its pictures and other assets' : `${assets.missing} of its ${assets.total} pictures and other assets`;
  return ` ${which} could not be kept in this browser and ${assets.missing === 1 && assets.missing < assets.total ? 'is' : 'are'} not in it: add them again, or open the file you last saved.`;
}
