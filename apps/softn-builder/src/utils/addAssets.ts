/**
 * A file from the person's computer, put among the project's assets.
 *
 * The Builder could open a bundle that carried pictures, list them, rename
 * them, delete them and offer them for an Image's source; it could not take
 * one in. `projectStore.addAsset` had no caller, and the file store, which is
 * where the project's assets are (utils/projectAssets.ts), had no way to be
 * given one. An app made here could show a picture only from an address on
 * another site.
 *
 * A picked file goes into `assets/` under its own name, made into a name a
 * bundle can hold and a page can write in `asset("…")`. A name that is taken
 * is not written over: the new file is numbered (`logo-2.png`).
 *
 * And a file put in place of one that is there (replaceAsset, below). A
 * newer picture under the same name had to be made by deleting the old one
 * and adding the new, and every page that asks for it by its path depends on
 * the name coming out the same. Replacing keeps the path and swaps the bytes.
 */

import { ASSET_CLASSIFICATIONS, classifyAsset } from '@softn/core';
import { useCanvasStore } from '../stores/canvasStore';
import { useFilesStore } from '../stores/filesStore';
import type { ProjectFileNode } from '../types/builder';
import { flushCanvasToActiveFile } from './buildProjectBundle';
import { askConfirm } from './confirm';

/** Where a file that is added goes unless a folder is named. */
export const ASSETS_FOLDER = 'assets';

/**
 * The largest one file of an app can be: what a bundle's reader takes as one entry
 * (MAX_ZIP_FILE_BYTES in @softn/bundle-format's zip.ts, 50 MB). It was the whole bundle's limit
 * (200 MB), so a 120 MB picture could be added here and the bundle it was saved in could not be
 * opened again, here or anywhere.
 */
export const MAX_ASSET_BYTES = 50 * 1024 * 1024;

/** The pictures an Image draws, which the list of a page's pictures offers. */
export const PICTURE_PATTERN = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

/** The same pictures, as a file picker is asked for them. */
export const PICTURE_ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.svg,.bmp';

/**
 * The name a picked file is kept under: its own, less what a bundle cannot
 * hold (a folder, two dots in a row) and what `asset("…")` cannot be read
 * back with (a quote, a backslash). Spaces become hyphens, so the path a
 * page writes is one word.
 */
export function assetNameFor(fileName: string): string {
  const last = fileName.split(/[/\\]/).pop() ?? '';
  const cleaned = last
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"'`<>|?*:]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+/, '');
  return cleaned === '' ? 'file' : cleaned;
}

/** `name`, or `name-2`, `name-3` … before its extension: the first that no file or folder in `folder` has. */
export function freeAssetName(nodes: ReadonlyMap<string, ProjectFileNode>, folder: string, name: string): string {
  const taken = new Set([...nodes.values()].map((node) => node.path));
  const at = (candidate: string) => (folder ? `${folder}/${candidate}` : candidate);
  if (!taken.has(at(name))) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${extension}`;
    if (!taken.has(at(candidate))) return candidate;
  }
}

export interface AddedAsset {
  id: string;
  /** Where it is in the project: what `asset("…")` is given. */
  path: string;
}

export interface AddedAssets {
  added: AddedAsset[];
  /** Why each file that was not added was not, in words to show. */
  refused: string[];
}

function megabytes(bytes: number): string {
  return `${Math.ceil(bytes / (1024 * 1024))} MB`;
}

/** A file's size as it is said: "812 bytes", "46.4 KB", "2.3 MB". */
export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What a picked file is read from: a `File`, as much of it as is used. */
export type PickedFile = Pick<File, 'name' | 'size' | 'arrayBuffer'>;

/** Why a picked file is too large for an app to carry, or null. Asked before it is read. */
function tooLargeReason(file: PickedFile): string | null {
  return file.size > MAX_ASSET_BYTES ? `${file.name} is ${megabytes(file.size)}, and one file of an app can be ${megabytes(MAX_ASSET_BYTES)} at most.` : null;
}

/** A picked file's bytes, or why they could not be had, in words to show. */
async function bytesOf(file: PickedFile): Promise<Uint8Array | string> {
  try {
    return new Uint8Array(await file.arrayBuffer());
  } catch (e) {
    return `${file.name} could not be read${e instanceof Error && e.message ? `: ${e.message}` : '.'}`;
  }
}

/**
 * Put each picked file into `folder`. One that cannot be read or is too
 * large is left out and said; the others are added all the same.
 */
export async function addAssetFiles(files: readonly PickedFile[], folder: string = ASSETS_FOLDER): Promise<AddedAssets> {
  const result: AddedAssets = { added: [], refused: [] };
  for (const file of files) {
    const tooLarge = tooLargeReason(file);
    if (tooLarge) {
      result.refused.push(tooLarge);
      continue;
    }
    const data = await bytesOf(file);
    if (typeof data === 'string') {
      result.refused.push(data);
      continue;
    }
    try {
      // Asked of the store as it is now: a file added a moment ago has its name.
      const store = useFilesStore.getState();
      const name = freeAssetName(store.nodes, folder, assetNameFor(file.name));
      const path = folder ? `${folder}/${name}` : name;
      const id = store.addAssetFile(folder, name, classifyAsset(path).mime, data);
      result.added.push({ id, path });
    } catch (e) {
      result.refused.push(e instanceof Error ? e.message : String(e));
    }
  }
  return result;
}

/** What a name ends in after its last dot, in small letters: what says a file's kind. '' when it has none. */
export function endingOf(name: string): string {
  const last = name.split(/[/\\]/).pop() ?? '';
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(dot + 1).toLowerCase() : '';
}

/**
 * The endings a file may have to take the place of the one at `path`: its
 * own, and any other an app is handed as the very same type (`.jpg` for
 * `.jpeg`). Not every ending of one type: `.txt`, `.ui` and `.logic` are all
 * handed out as plain text and are not each other, and the type given to an
 * ending nobody knows says nothing of what is in the file.
 */
export function replacementEndings(path: string): string[] {
  const ending = endingOf(path);
  const own = Object.prototype.hasOwnProperty.call(ASSET_CLASSIFICATIONS, ending) ? ASSET_CLASSIFICATIONS[ending] : undefined;
  if (!own || !own.binary || own.mime === 'application/octet-stream') return [ending];
  const alike = Object.keys(ASSET_CLASSIFICATIONS).filter(
    (other) => other !== ending && ASSET_CLASSIFICATIONS[other].binary && ASSET_CLASSIFICATIONS[other].mime === own.mime
  );
  return [ending, ...alike];
}

/** What a file is, in a word or two, as its name says it: "PNG picture", "MP3 sound", "PDF file". */
export function assetKindWords(path: string): string {
  const ending = endingOf(path);
  if (ending === '') return 'File';
  const noun = { image: 'picture', audio: 'sound', video: 'video', model: 'model', font: 'font', text: 'file', binary: 'file' }[classifyAsset(path).kind];
  return `${ending === 'jpg' ? 'JPEG' : ending.toUpperCase()} ${noun}`;
}

/** Those endings as a file picker is asked for them; '' (any file) for a name that has none. */
export function replacementAccept(path: string): string {
  return replacementEndings(path)
    .filter((ending) => ending !== '')
    .map((ending) => `.${ending}`)
    .join(',');
}

/** A file's kind as its name says it: "a .png file". */
function kindWords(name: string): string {
  const ending = endingOf(name);
  return ending === '' ? 'a file with no type in its name' : `a .${ending} file`;
}

/**
 * Why a file called `fileName` cannot take the place of the asset at `path`,
 * or null when it can.
 *
 * An app is handed each of its files as the type its name says
 * (classifyAsset): a JPEG put under `team-photo.png` would be handed out as
 * a PNG. Giving it the right name instead would take it from under every
 * page that asks for it by the old one. So it is refused, and the two ways
 * on are said.
 */
export function wrongKindReason(path: string, fileName: string): string | null {
  if (replacementEndings(path).includes(endingOf(fileName))) return null;
  const noun = PICTURE_PATTERN.test(fileName) ? 'picture' : 'file';
  return `${fileName} is ${kindWords(fileName)}, and ${path} is ${kindWords(path)}. Replacing keeps the name, and the name tells the app what kind of file it is. Choose ${kindWords(path)}, or add ${fileName} as a new ${noun} and choose it where this one is used.`;
}

/** What is asked before one file takes another's place. */
export interface ReplaceQuestion {
  /** Where the asset is in the project. */
  path: string;
  /** The picked file, by its own name. */
  fileName: string;
  oldBytes: number;
  newBytes: number;
  /** The pages and logic files that ask for the asset by its path. */
  users: string[];
}

export type ReplacedAsset =
  /** The new bytes are in place; `users` get them from now on. */
  | { outcome: 'replaced'; path: string; users: string[] }
  /** The picked file is, byte for byte, what was there. Nothing was changed. */
  | { outcome: 'same'; path: string }
  /** It was asked, and the answer was no. */
  | { outcome: 'cancelled' }
  /** Why it was not done, in words to show. */
  | { outcome: 'refused'; reason: string };

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * The question, in the Builder's own dialog, as deleting a file asks its own
 * (utils/confirm.ts). A change to the project's files has no undo, and what
 * a replaced file held is in the project and nowhere else the Builder knows.
 */
function askReplace(question: ReplaceQuestion): Promise<boolean> {
  const noun = PICTURE_PATTERN.test(question.path) ? 'picture' : 'file';
  const users =
    question.users.length === 0
      ? ''
      : `\n\n${question.users.join(', ')} ${question.users.length === 1 ? 'uses' : 'use'} it, and will get the new one.`;
  return askConfirm(
    `Put ${question.fileName} (${sizeWords(question.newBytes)}) in place of ${question.path} (${sizeWords(question.oldBytes)})? The ${noun} that is there now leaves the project, and Undo does not bring it back.${users}`,
    { title: `Replace ${noun}`, confirmLabel: 'Replace', danger: true }
  );
}

/** The asset `id` as the project has it now, or null when it has not. */
function assetAt(id: string): { path: string; data: Uint8Array } | null {
  const files = useFilesStore.getState();
  const node = files.nodes.get(id);
  const asset = files.assetFiles.get(id);
  return node && node.type === 'file' && node.fileType === 'asset' && asset ? { path: node.path, data: asset.data } : null;
}

/**
 * Put a picked file in place of the asset `id`, under the path the asset
 * has: every page and logic file that asks for it goes on working, and gets
 * the new bytes.
 *
 * It goes by what adding goes by (too large, cannot be read), and is refused
 * when its name says another kind of file than the path does
 * (wrongKindReason). A file that is, byte for byte, what is there changes
 * nothing, and the project is not made unsaved by it. Anything else is asked
 * about first, with the pages that use it named: the bytes that are there
 * cannot be had back.
 */
export async function replaceAsset(
  id: string,
  file: PickedFile,
  ask: (question: ReplaceQuestion) => Promise<boolean> = askReplace
): Promise<ReplacedAsset> {
  const gone: ReplacedAsset = { outcome: 'refused', reason: 'That picture or file is no longer in the project.' };
  const before = assetAt(id);
  if (!before) return gone;
  const refused = tooLargeReason(file) ?? wrongKindReason(before.path, file.name);
  if (refused) return { outcome: 'refused', reason: refused };
  const data = await bytesOf(file);
  if (typeof data === 'string') return { outcome: 'refused', reason: data };
  if (sameBytes(data, before.data)) return { outcome: 'same', path: before.path };

  // The pages are asked what they use as they are now, the one on the canvas
  // with them (FileNavigator.tsx, flushHeldPage): a flush that fails leaves
  // the question to be asked of the files as they are.
  if (useCanvasStore.getState().pageId !== null) {
    try {
      flushCanvasToActiveFile();
    } catch {
      // The files as they were last flushed are asked.
    }
  }
  const users = useFilesStore.getState().assetUsersOf(id);
  const yes = await ask({ path: before.path, fileName: file.name, oldBytes: before.data.byteLength, newBytes: data.byteLength, users });
  if (!yes) return { outcome: 'cancelled' };

  // What is replaced is what was asked about, if it is still there and still that kind.
  const now = assetAt(id);
  if (!now) return gone;
  const refusedNow = wrongKindReason(now.path, file.name);
  if (refusedNow) return { outcome: 'refused', reason: refusedNow };
  try {
    useFilesStore.getState().replaceAssetFile(id, data);
  } catch (e) {
    return { outcome: 'refused', reason: e instanceof Error ? e.message : String(e) };
  }
  return { outcome: 'replaced', path: now.path, users };
}

/** What is said once a file was put in place, or turned out to be the one that was there. */
export function replacedWords(result: ReplacedAsset, fileName: string): string | null {
  if (result.outcome === 'replaced') return `Replaced ${result.path}`;
  if (result.outcome === 'same') return `${fileName} is what ${result.path} holds already. Nothing was changed.`;
  return null;
}
