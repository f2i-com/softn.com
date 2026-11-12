/**
 * The rules a file is held to when a person adds, names or copies one in the
 * Files panel: what a name may be, what a clash becomes, how much an app may
 * carry, and whether a file from the computer is kept as text or as bytes.
 *
 * The panel was a list to read. Every file came from the AI or from an
 * import, and each of those has its own gate (lib/agent/executeTool.ts,
 * lib/projectImport.ts). A person now makes files too, so the same rules are
 * said once here, apart from the panel that shows them and the store actions
 * that apply them (lib/fileOps.ts).
 *
 * Names follow the Builder's Files panel (apps/softn-builder/src/utils/
 * addAssets.ts), so the two editors treat one name the same way: what a bundle
 * cannot hold is taken out, spaces become hyphens, and a name that is taken is
 * numbered (`logo-2.png`) and never written over.
 */

import { MAX_ZIP_INPUT_BYTES, classifyAsset, pythonModuleName } from '@softn/core';
import { keptAsBytes } from './fileKinds';
import { bundleNameProblem, canonicalKey, isPrivatePath } from './paths';
import { isTextEntry, namedAsText } from './projectImport';
import { isLogicPath, isPagePath } from './sourceKinds';

/**
 * The most one file of an app may be: what every SoftN reader inflates of one
 * entry before it refuses the bundle (MAX_ZIP_FILE_BYTES in
 * packages/@softn/bundle-format/src/zip.ts, which keeps the number to itself;
 * test/fileRules.test.ts holds this one to it).
 */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** The most an app may be: the largest bundle a reader opens. */
export const MAX_APP_BYTES = MAX_ZIP_INPUT_BYTES;

/** The most files an app may hold: the reader's limit on a bundle's entries (MAX_ZIP_ENTRIES, held to it by the same test). */
export const MAX_APP_FILES = 10_000;

/** Where a picture or other media file goes when no folder was pointed at. */
export const ASSETS_FOLDER = 'assets';

/** A size as it is said in a sentence: "812 bytes", "46.4 KB", "2.3 MB". */
export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A size beside a name in the tree, as short as it can be read: "812 B", "46 KB", "2.3 MB". */
export function shortSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

function megabytes(bytes: number): string {
  return `${Math.ceil(bytes / (1024 * 1024))} MB`;
}

/** The folder a path is in: '' at the top of the project. */
export function folderOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? '' : path.slice(0, cut);
}

/** The last part of a path: the name a row shows. */
export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** `name` inside `folder`, or at the top of the project. */
export function joinPath(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name;
}

const NOT_IN_A_NAME = '"\'`<>|?*:';

/**
 * A name as the project keeps it: its last part (a path from another computer
 * is not a folder here), less what a bundle cannot hold (control characters,
 * two dots in a row) and what a page cannot write in `asset("…")` (a quote),
 * with spaces made hyphens so the path is one word. Never empty.
 */
export function cleanFileName(raw: string): string {
  const last = raw.split(/[/\\]/).pop() ?? '';
  const kept = [...last].filter((ch) => {
    const code = ch.charCodeAt(0);
    return code > 31 && code !== 127 && !NOT_IN_A_NAME.includes(ch);
  }).join('');
  const cleaned = kept
    .trim()
    .replace(/\s+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+/, '');
  return cleaned === '' ? 'file' : cleaned;
}

export type NameVerdict =
  /** The name the file will have, and whether that is not what was typed. */
  | { ok: true; name: string; changed: boolean }
  | { ok: false; reason: string };

/**
 * What a typed name comes to. A slash is not cleaned away: it would say the
 * person meant a folder, and the name would lose it without a word. Anything
 * else the project cannot hold is taken out, and `changed` says so, for the
 * box to show the name the file will really have before it is given.
 */
export function typedName(typed: string): NameVerdict {
  const wanted = typed.trim();
  if (wanted === '') return { ok: false, reason: 'Type a name.' };
  if (/[/\\]/.test(wanted)) return { ok: false, reason: 'A name cannot hold a slash. To put it in a folder, drag it there, or cut it and paste it.' };
  const name = cleanFileName(wanted);
  // Only dots, hyphens or characters no name can hold: nothing of it is left to name the file by.
  if (name === 'file' && wanted !== 'file') return { ok: false, reason: 'Use letters or digits in the name.' };
  return { ok: true, name, changed: name !== wanted };
}

/**
 * Every name that is taken in the project, by its identity on a disk that
 * folds case: each file, each folder a file is in, and each folder the person
 * made that has nothing in it yet. A file may not take a folder's name either:
 * a disk holds one of them (lib/exportBundle.ts refuses the pair).
 */
export function takenKeys(paths: Iterable<string>, emptyFolders: Iterable<string> = []): Set<string> {
  const taken = new Set<string>();
  const add = (path: string) => {
    const key = canonicalKey(path);
    taken.add(key);
    for (let at = key.indexOf('/'); at !== -1; at = key.indexOf('/', at + 1)) taken.add(key.slice(0, at));
  };
  for (const path of paths) add(path);
  for (const folder of emptyFolders) add(folder);
  return taken;
}

/**
 * `name`, or `name-2`, `name-3` … before its ending: the first that nothing in
 * `folder` has. A folder's name is numbered at its end, whatever dots it has.
 */
export function freeName(taken: ReadonlySet<string>, folder: string, name: string, isFolder = false): string {
  const at = (candidate: string) => canonicalKey(joinPath(folder, candidate));
  if (!taken.has(at(name))) return name;
  const dot = isFolder ? -1 : name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ending = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${ending}`;
    if (!taken.has(at(candidate))) return candidate;
  }
}

/** Why a new file may not have this path, in words for the person, or null when it may. */
export function newPathProblem(path: string): string | null {
  if (isPrivatePath(path)) return 'builder/ is where Studio keeps its own notes on the project. They are not exported, and files are not added there.';
  const dropped = bundleNameProblem(path);
  if (dropped) return `${nameOf(path)} cannot go in the app’s bundle: ${dropped}.`;
  if (/\.py$/i.test(path)) {
    try {
      pythonModuleName(path);
    } catch (err) {
      return err instanceof Error ? `${err.message}.` : String(err);
    }
  }
  return null;
}

/** Why one file is too large for an app to carry, or null. Asked before it is read. */
export function tooLargeReason(name: string, bytes: number): string | null {
  return bytes > MAX_FILE_BYTES ? `${name} is ${megabytes(bytes)}, and one file of an app can be ${megabytes(MAX_FILE_BYTES)} at most.` : null;
}

/**
 * Why the app cannot take `adding` more files of `addingBytes` in all, or null
 * when it can. `count` and `bytes` are what its bundle holds now.
 */
export function appLimitReason(count: number, bytes: number, adding: number, addingBytes: number): string | null {
  if (count + adding > MAX_APP_FILES) {
    return `An app can hold ${MAX_APP_FILES.toLocaleString('en-US')} files at most, and this one has ${count.toLocaleString('en-US')}.`;
  }
  if (bytes + addingBytes > MAX_APP_BYTES) {
    return `That would make the app ${megabytes(bytes + addingBytes)}, and an app can be ${megabytes(MAX_APP_BYTES)} at most.`;
  }
  return null;
}

/** What a file is kept as: its text, its bytes, or why it cannot be kept. */
export type KeptContent = { ok: true; content: string | Uint8Array } | { ok: false; reason: string };

/**
 * A file from the person's computer as the project keeps it: text for what is
 * text (a page, logic, JSON, an SVG, and any file of a kind nothing names whose
 * bytes are text), and bytes for the rest, decided as an import decides it
 * (lib/projectImport.ts), so a file added by hand is the same file it would be
 * had it come in with a bundle.
 *
 * A file whose name says text and whose bytes are not UTF-8 is refused. Read
 * as text it would lose every character that did not decode, and a page or a
 * logic file kept as bytes is one nothing here can read, check or run.
 */
export function keptContent(path: string, bytes: Uint8Array): KeptContent {
  if (!isTextEntry(path, bytes)) return { ok: true, content: bytes };
  try {
    return { ok: true, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    if (!namedAsText(path)) return { ok: true, content: bytes };
    return { ok: false, reason: `${nameOf(path)} is not UTF-8 text, which a file of its kind has to be. Save it as UTF-8 and add it again.` };
  }
}

/**
 * Whether a file belongs at the top of the project when no folder was pointed
 * at: the app's own source and settings, which pages and the manifest name by
 * where they are. Everything else (a picture, a sound, a font, a document) is
 * something the app shows or serves, and goes with the assets.
 */
export function belongsAtTheTop(path: string): boolean {
  return isPagePath(path) || isLogicPath(path) || /\.(css|json|xdb|sql|ts|tsx|jsx)$/i.test(path);
}

/** What a new text file starts as: valid JSON for a file that has to be JSON, and nothing otherwise. */
export function starterContent(path: string): string {
  return /\.json$/i.test(path) ? '{}\n' : '';
}

/** Why a new, empty file cannot have this name, or null: a picture cannot begin as nothing. */
export function emptyFileProblem(path: string): string | null {
  if (!keptAsBytes(path)) return null;
  const { kind } = classifyAsset(path);
  const noun = kind === 'image' ? 'a picture' : kind === 'audio' ? 'a sound' : kind === 'video' ? 'a video' : kind === 'font' ? 'a font' : 'a file kept as bytes';
  return `${nameOf(path)} would be ${noun}, which cannot start empty. Use Add files to bring one in from this computer.`;
}

/**
 * The name a picture pasted from the clipboard is kept under. A screenshot or
 * a picture copied from a page arrives as "image.png", made that moment, which
 * says nothing: it is named for what it is, and a second one is numbered.
 */
export function pastedName(file: { name: string; type?: string; lastModified?: number }, now: number = Date.now()): string {
  const fresh = file.lastModified === undefined || Math.abs(now - file.lastModified) < 5000;
  const unnamed = /^image\.[a-z0-9]+$/i.test(file.name) && fresh;
  if (!unnamed && file.name.trim() !== '') return file.name;
  const ending = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')).toLowerCase() : file.type === 'image/jpeg' ? '.jpg' : '.png';
  return `pasted-picture${ending}`;
}
