/**
 * What names a file, following it when it is renamed or moved.
 *
 * A project's files name each other by path: a page asks for a picture with
 * `asset("assets/logo.png")`, links its logic with `<script src="main.js">`,
 * imports another page from `"./card.ui"`; logic imports `"../lib/dates.js"`;
 * the manifest names the main page and the icon. Renaming a file in the Files
 * panel would leave each of those asking for a file that is no longer there.
 * The Builder's panel makes them follow (apps/softn-builder/src/utils/
 * assetReferences.ts); this is the same for Studio, whose files are all text.
 *
 * A path is followed where it is written as a path, read the way the runtime
 * reads it there (packages/@softn/core/src/bundle/source-composer.ts):
 *
 *   - a quoted string that starts `./` or `../` leads from the file it is
 *     written in;
 *   - what a page gives `<import from>`, `<script src>`, `<logic src>`,
 *     `<link href>` and `<a href>` without `./` is read from the page's own
 *     folder too, and so is `url()` in a stylesheet file;
 *   - any other whole quoted string that is the path is from the project's
 *     root (`asset("assets/logo.png")`, `<img src="assets/logo.png">`, the
 *     manifest's `"main"`), with any of the three quotes and with or without a
 *     leading slash; for a folder, a quoted string that starts with its path
 *     and a slash (`"assets/icons/" + name`).
 *
 * A file that moves to another folder has what it names from its own folder
 * written from where it is now. Words between tags, comments and unquoted
 * mentions are not rewritten: a file where the old path can still be read
 * after all that is reported (`stillNames`), so the panel can say plainly what
 * was left. Studio's own notes under builder/ are not the app's, and are left
 * alone.
 */

import { resolveBundlePath } from '@softn/core';
import { isPrivatePath, normalizeProjectPath } from './paths';

/** A file moved from one path to another, or a folder with everything under it. */
export interface FileMove {
  from: string;
  to: string;
  /** A folder: every path under `from/` moves under `to/`. */
  folder: boolean;
}

/** `path` after the move: itself when the move does not touch it. */
export function movedPath(path: string, move: FileMove): string {
  if (!move.folder) return path === move.from ? move.to : path;
  if (path === move.from) return move.to;
  return path.startsWith(`${move.from}/`) ? `${move.to}${path.slice(move.from.length)}` : path;
}

export interface FollowedMove {
  /** The new text of each file whose references changed, by the path it had before the move. */
  texts: Map<string, string>;
  /** Those files, by the path each has after the move. */
  followed: string[];
  /** Files, by the path each has after the move, where the old path can still be read. */
  stillNames: string[];
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const dirOf = (path: string) => {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? '' : path.slice(0, cut);
};

const isPage = (path: string) => /\.(ui|html?)$/i.test(path);
const isStylesheet = (path: string) => /\.css$/i.test(path);

/** The way from the folder `dir` to the file `target`, written with `./` or `../`. */
function relativeFile(dir: string, target: string): string {
  const from = dir ? dir.split('/') : [];
  const to = target.split('/');
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared++;
  const up = from.length - shared;
  const rest = to.slice(shared).join('/');
  return up === 0 ? `./${rest}` : `${'../'.repeat(up)}${rest}`;
}

/** The way from the folder `dir` to the folder `target`, ending in a slash. */
function relativeFolder(dir: string, target: string): string {
  const from = dir ? dir.split('/') : [];
  const to = target.split('/');
  let shared = 0;
  while (shared < from.length && shared < to.length && from[shared] === to[shared]) shared++;
  const up = from.length - shared;
  const rest = to.slice(shared).join('/');
  const way = up === 0 ? `./${rest}` : `${'../'.repeat(up)}${rest}`;
  return way.endsWith('/') ? way : `${way}/`;
}

/** The way from the folder `dir` to `target` without `./` in front where it is inside `dir`: how a page writes a neighbour. */
function besideFile(dir: string, target: string): string {
  if (dir === '') return target;
  return target.startsWith(`${dir}/`) ? target.slice(dir.length + 1) : relativeFile(dir, target);
}

/** What a reference is given, less the `?v=3` or `#top` a site adds after the file's name. */
function splitSuffix(written: string): [string, string] {
  const at = written.search(/[?#]/);
  return at < 0 ? [written, ''] : [written.slice(0, at), written.slice(at)];
}

interface Project {
  hasFile(path: string): boolean;
  hasFolder(path: string): boolean;
}

function projectOf(paths: Iterable<string>): Project {
  const files = new Set<string>();
  const folders = new Set<string>();
  for (const path of paths) {
    files.add(path);
    for (let at = path.indexOf('/'); at !== -1; at = path.indexOf('/', at + 1)) folders.add(path.slice(0, at));
  }
  return { hasFile: (path) => files.has(path), hasFolder: (path) => folders.has(path) };
}

/**
 * The `./` and `../` references in the text of the file at `was` (now at
 * `now`), each written as it has to be after the move: to where its file is
 * now, from where this file is now. One that leads to nothing in the project
 * is not a reference, and is left as it is.
 */
function followRelative(text: string, was: string, now: string, move: FileMove, project: Project): string {
  if (!text.includes('./')) return text;
  const rebased = dirOf(was) !== dirOf(now);
  return text.replace(/(["'`])(\.{1,2}\/[^"'`\r\n]*)\1/g, (whole, quote: string, written: string) => {
    const [way, suffix] = splitSuffix(written);
    const toFolder = way.endsWith('/');
    let target: string;
    try {
      target = resolveBundlePath(was, way);
    } catch {
      return whole;
    }
    if (toFolder ? !project.hasFolder(target) : !project.hasFile(target)) return whole;
    const moved = movedPath(target, move);
    if (moved === target && !rebased) return whole;
    const next = toFolder ? relativeFolder(dirOf(now), moved) : relativeFile(dirOf(now), moved);
    return `${quote}${next}${suffix}${quote}`;
  });
}

/** What is not a path written from the page's own folder: an address, one from the root, a fragment, `./` (followed already), an expression. */
const NOT_BESIDE = /^(?:[a-z][a-z0-9+.-]*:|\/|#|\.{1,2}\/|[{$<])/i;

/** What a page reads from its own folder: `<import from>`, `<script src>`, `<logic src>`, `<link href>`, `<a href>`. */
const PAGE_NAMES = /(<(?:script|logic)\b[^>]*?\ssrc\s*=\s*|<(?:link|a)\b[^>]*?\shref\s*=\s*|<import\b[^>]*?\sfrom\s*=\s*)(["'])([^"'\r\n]+)\2/gi;

/** What a stylesheet reads from its own folder. */
const STYLESHEET_NAMES = /(\burl\(\s*)(["']?)([^"')\r\n]+)\2(\s*\))/gi;

/** A character no source holds: it stands, with a number, for a reference that has been dealt with. */
const HELD = String.fromCharCode(0xe000);

/**
 * What a page or a stylesheet names from its own folder without `./`, written
 * as it has to be after the move. Each one that is a file of the project is
 * taken out of the text and kept in `held`, whether or not it changed: read
 * from the page's folder, `src="main.js"` in `pages/about.html` is
 * `pages/main.js`, and the pass that follows paths from the root must not take
 * it for the `main.js` at the top of the project.
 */
function followBeside(text: string, was: string, now: string, move: FileMove, project: Project, held: string[]): string {
  const from = dirOf(was);
  const here = dirOf(now);
  const follow = (written: string): string | null => {
    const [way, suffix] = splitSuffix(written.trim());
    if (way === '' || NOT_BESIDE.test(way)) return null;
    const named = normalizeProjectPath(way);
    if (named === null) return null;
    const target = from ? `${from}/${named}` : named;
    if (!project.hasFile(target)) return null;
    const moved = movedPath(target, move);
    const next = moved === target && from === here ? way : besideFile(here, moved);
    held.push(`${next}${suffix}`);
    return `${HELD}${held.length - 1}${HELD}`;
  };
  if (isPage(was)) {
    return text.replace(PAGE_NAMES, (whole, lead: string, quote: string, written: string) => {
      const mark = follow(written);
      return mark === null ? whole : `${lead}${quote}${mark}${quote}`;
    });
  }
  return text.replace(STYLESHEET_NAMES, (whole, lead: string, quote: string, written: string, tail: string) => {
    const mark = follow(written);
    return mark === null ? whole : `${lead}${quote}${mark}${quote}${tail}`;
  });
}

/** Every path from the project's root that the move touches, written as it is after it: quoted, or alone in `url()`. */
function followFromRoot(text: string, move: FileMove): string {
  if (!text.includes(move.from)) return text;
  const from = escaped(move.from);
  if (move.folder) {
    return text
      .replace(new RegExp(`(["'\`])(/?)${from}/`, 'g'), (_whole, quote: string, slash: string) => `${quote}${slash}${move.to}/`)
      .replace(new RegExp(`(\\burl\\(\\s*/?)${from}/`, 'gi'), (_whole, lead: string) => `${lead}${move.to}/`);
  }
  return text
    .replace(
      new RegExp(`(["'\`])(/?)${from}([?#][^"'\`\\r\\n]*)?\\1`, 'g'),
      (_whole, quote: string, slash: string, suffix: string | undefined) => `${quote}${slash}${move.to}${suffix ?? ''}${quote}`,
    )
    .replace(new RegExp(`(\\burl\\(\\s*/?)${from}(\\s*\\))`, 'gi'), (_whole, lead: string, tail: string) => `${lead}${move.to}${tail}`);
}

/** Whether the old path can still be read in `text` as a path of its own, not as part of a longer one. */
function mentions(text: string, move: FileMove): boolean {
  if (!text.includes(move.from)) return false;
  const tail = move.folder ? '/' : '(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])';
  return new RegExp(`(^|[^A-Za-z0-9_./-])${escaped(move.from)}${tail}`).test(text);
}

/** The Python module a `.py` file is imported as, or null for any other file. */
function pythonModule(path: string): string | null {
  const match = /([^/]+)\.py$/i.exec(path);
  return match ? match[1] : null;
}

/**
 * Follow one move through every text file of the project. Nothing is written
 * here: `texts` is what each changed file has to hold, for the caller to put
 * in the same unit as the move itself.
 */
export function followMove(files: ReadonlyMap<string, { content: string | Uint8Array }>, move: FileMove): FollowedMove {
  const result: FollowedMove = { texts: new Map(), followed: [], stillNames: [] };
  if (move.from === move.to) return result;
  // A path with a quote or a line break in it cannot be told apart from the text around it.
  const writable = !/["'`\r\n\\]/.test(move.from) && !/["'`\r\n\\]/.test(move.to);
  const project = projectOf(files.keys());
  // `import helpers` names a module, not a path: it is found, and not rewritten.
  const wasModule = move.folder ? null : pythonModule(move.from);
  const moduleGone = wasModule !== null && pythonModule(move.to) !== wasModule;
  const importsModule = moduleGone ? new RegExp(`^[ \\t]*(?:import[ \\t]+(?:[\\w.]+[ \\t]*,[ \\t]*)*${escaped(wasModule)}\\b|from[ \\t]+${escaped(wasModule)}[ \\t]+import\\b)`, 'm') : null;

  for (const [was, file] of files) {
    if (typeof file.content !== 'string' || isPrivatePath(was)) continue;
    const now = movedPath(was, move);
    const text = file.content;
    let out = text;
    let named = false;
    if (writable) {
      out = followRelative(out, was, now, move, project);
      const held: string[] = [];
      if ((isPage(was) || isStylesheet(was)) && !out.includes(HELD)) out = followBeside(out, was, now, move, project, held);
      out = followFromRoot(out, move);
      // Asked before what was held is put back: a neighbour of the same name is not the file that moved.
      named = mentions(out, move);
      if (held.length > 0) out = out.replace(new RegExp(`${HELD}(\\d+)${HELD}`, 'g'), (_whole, index: string) => held[Number(index)]);
    } else {
      named = mentions(out, move);
    }
    if (out !== text) {
      result.texts.set(was, out);
      result.followed.push(now);
    }
    const imports = importsModule !== null && was !== move.from && /\.py$/i.test(was) && importsModule.test(out);
    if (named || imports) result.stillNames.push(now);
  }
  result.followed.sort();
  result.stillNames.sort();
  return result;
}

/**
 * The files that name `path` (or, for a folder, anything in it), by their own
 * paths: what would be left asking for a file that is not there if it were
 * deleted. The file itself, and files inside the folder, are not counted.
 */
export function namersOf(files: ReadonlyMap<string, { content: string | Uint8Array }>, path: string, folder: boolean): string[] {
  // Asked as a move to a name nothing has: whatever would follow it, or still name it, names it now.
  const move: FileMove = { from: path, to: `${path}.moved-away`, folder };
  const { followed, stillNames } = followMove(files, move);
  const inside = (name: string) => name === move.to || name.startsWith(`${move.to}/`);
  return [...new Set([...followed, ...stillNames])].filter((name) => !inside(name)).sort();
}
