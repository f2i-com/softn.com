/**
 * A page of the project used inside another.
 *
 * A page is used by writing `<import Row from="./components/row.ui" />` in
 * the header of the page that uses it and `<Row />` where it goes. What
 * that means is decided when the app is put together (core,
 * source-composer.ts): the tag is replaced by the content of the imported
 * page, in the importing page's own scope. It is an include. Nothing
 * written on the tag reaches it, it holds nothing, and it reads the state
 * and the functions of the page it is in.
 *
 * The palette offers the project's own pages beside the library's
 * components, and this is what decides, for the page being edited: which
 * pages may be used on it, the name each is used by, the path its import is
 * written with, and which import lines the header of the page has.
 *
 * The element and its import are kept together by one rule. An import the
 * Builder wrote is in the page for as long as an element of the page uses
 * its name, and no longer: undoing the drop takes it out with the element,
 * redoing puts it back, and deleting the last use of it removes the line.
 * It is worked out from the elements whenever the page is written, not
 * recorded beside them, so it cannot come apart from them.
 *
 * An import the Builder did not write is the author's. It is never taken
 * out of a page that is opened, edited or saved, used or not, with one
 * exception: when its last use is deleted on the canvas it goes with that
 * use, as the Builder's own does (importsLeftUnused), and Undo brings both
 * back.
 */

import { UI_IMPORT_PATTERN } from '@softn/core';
import type { CanvasElement, UIFileState, UIImport } from '../types/builder';
import { componentRegistry } from './componentRegistry';
import { relativeImportPath, resolveImportPath } from './logicFiles';
import { stripSlash } from './values';

/** What a drag from the palette carries for a page: the file, since its name depends on the page it lands on. */
const PAGE_DRAG_PREFIX = '@page:';

export function pageDragType(fileId: string): string {
  return `${PAGE_DRAG_PREFIX}${fileId}`;
}

/** The file a dragged type stands for, or null when what is dragged is a component. */
export function draggedPageId(type: string | null | undefined): string | null {
  return typeof type === 'string' && type.startsWith(PAGE_DRAG_PREFIX) ? type.slice(PAGE_DRAG_PREFIX.length) : null;
}

const baseName = (path: string): string => path.split('/').pop() ?? path;

/**
 * The name a page is used by: its file name in the case a component is
 * written in. Only letters, digits and `_`, beginning with a letter, which
 * is all the composer's pattern reads as a name.
 */
export function pageName(fileName: string): string {
  const stem = baseName(fileName).replace(/\.ui$/i, '');
  const name = stem
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('');
  if (name === '') return 'Page';
  return /^[A-Za-z]/.test(name) ? name : `Page${name}`;
}

/** A page of the project as it could be used on the page being edited. */
export interface Importable {
  file: UIFileState;
  /** The name it is used by on this page: the one the page already gives it, or its file's. */
  name: string;
  /** The path its import is written with, from this page. */
  source: string;
  /** Whether this page imports it already, so that nothing more is written. */
  existing: boolean;
  /** Why it cannot be used on this page, where it cannot. */
  refused?: string;
}

/** Whether the page at `from` uses the page at `target`, itself or through the pages it uses. */
function reaches(from: string, target: string, byPath: ReadonlyMap<string, UIFileState>, seen = new Set<string>()): boolean {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  for (const imported of byPath.get(from)?.imports ?? []) {
    if (imported.source.startsWith('@')) continue;
    if (reaches(resolveImportPath(from, imported.source), target, byPath, seen)) return true;
  }
  return false;
}

const LIBRARY = new Set(componentRegistry.map((meta) => meta.name));

/**
 * Every other page of the project, as it could be used on the page with
 * this id, in the order of their paths. `imports` is what the page imports
 * now, which is the canvas's where the page is the one being edited.
 */
export function importableFor(pageId: string, uiFiles: ReadonlyMap<string, UIFileState>, imports: readonly UIImport[]): Importable[] {
  const page = uiFiles.get(pageId);
  if (!page) return [];
  const pagePath = stripSlash(page.path);
  const byPath = new Map([...uiFiles.values()].map((file) => [stripSlash(file.path), file]));
  const bound = new Map(imports.filter((imp) => !imp.source.startsWith('@')).map((imp) => [resolveImportPath(pagePath, imp.source), imp]));

  return [...uiFiles.values()]
    .filter((file) => file.id !== pageId)
    .sort((a, b) => stripSlash(a.path).localeCompare(stripSlash(b.path)))
    .map((file): Importable => {
      const path = stripSlash(file.path);
      const already = bound.get(path);
      const name = already?.name ?? pageName(path);
      const entry: Importable = { file, name, source: already?.source ?? relativeImportPath(pagePath, path), existing: already !== undefined };
      // A page inside itself has no end.
      if (reaches(path, pagePath, byPath)) return { ...entry, refused: `${baseName(path)} uses this page, so it cannot be used on it.` };
      if (already) return entry;
      if (LIBRARY.has(name)) {
        return { ...entry, refused: `${name} is a component of the library, and ${baseName(path)} would be used by that name. Rename the file to use it here.` };
      }
      const taken = imports.find((imp) => imp.name === name);
      if (taken) {
        const other = taken.source.startsWith('@') ? taken.source : resolveImportPath(pagePath, taken.source);
        return { ...entry, refused: `${name} is already the name of ${other} on this page. Rename one of the files to use both.` };
      }
      return entry;
    });
}

/** The names the elements of a page are written with. */
function usedNames(elements: ReadonlyMap<string, CanvasElement>): Set<string> {
  const names = new Set<string>();
  for (const element of elements.values()) names.add(element.componentType);
  return names;
}

/**
 * The imports a page has, as it would be written now: every import but
 * those the Builder wrote (`written`, their names) that no element of the
 * page uses any more.
 */
export function liveImports(elements: ReadonlyMap<string, CanvasElement>, imports: readonly UIImport[], written: readonly string[] = []): UIImport[] {
  if (written.length === 0) return [...imports];
  const used = usedNames(elements);
  return imports.filter((imp) => !written.includes(imp.name) || used.has(imp.name));
}

/**
 * The imports that have just lost their last use: of the names the elements
 * taken off the page were written with (`removed`), those a page of the
 * project is imported by that no element left on the page uses.
 *
 * These become the Builder's to take away, whoever wrote the line. Which
 * imports the Builder wrote was remembered for the session and no longer:
 * a project exported and opened again came back with every import the
 * author's, so the last use of a page dropped from the palette the day
 * before left `<import TaskRow … />` in the header for good, importing a
 * file nothing on the page used. The rule now needs nothing remembered: the
 * line goes with the last use, when that use is deleted on the canvas.
 *
 * What it does not reach, each on purpose: an import that had no use to
 * delete (it may be on its way in), so a page that is only opened, edited
 * or saved keeps every line it has; a name of the library's or of an alias
 * (`@…`), which is not a page of the project; and a line written with
 * braces, which may name several things at once.
 */
export function importsLeftUnused(
  removed: Iterable<string>,
  elements: ReadonlyMap<string, CanvasElement>,
  imports: readonly UIImport[],
  written: readonly string[]
): string[] {
  const used = usedNames(elements);
  return [...new Set(removed)].filter(
    (name) =>
      !used.has(name) &&
      !written.includes(name) &&
      imports.some((imp) => imp.name === name && !imp.named && !imp.source.startsWith('@'))
  );
}

/** `<import Name from="./path.ui" />`, as the language's own examples write it. */
export function importLine(imported: UIImport): string {
  return `<import ${imported.name} from="${imported.source}" />`;
}

/**
 * `source` with the import lines the Builder keeps in it: one for each of
 * `imports` that the Builder wrote (`written`, their names) and the source
 * has not got, after the imports it has, or before its first tag where it
 * has none; and none for one it wrote that `imports` no longer has. Every
 * other character of the source, the author's own imports and its line
 * endings among them, is as it was.
 */
export function withImportLines(source: string, imports: readonly UIImport[], written: readonly string[] = []): string {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const wanted = new Map(imports.map((imp) => [imp.name, imp]));
  const found = [...source.matchAll(new RegExp(UI_IMPORT_PATTERN.source, 'g'))].map((match) => ({
    name: match[1],
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));

  // Taken out from the last to the first, so the places before stay where they are.
  let text = source;
  let last = -1;
  for (const line of [...found].reverse()) {
    if (written.includes(line.name) && !wanted.has(line.name)) {
      const after = text.slice(line.end).match(/^[ \t]*\r?\n/)?.[0].length ?? 0;
      text = text.slice(0, line.start) + text.slice(line.end + after);
    }
  }
  const kept = [...text.matchAll(new RegExp(UI_IMPORT_PATTERN.source, 'g'))];
  const have = new Set(kept.map((match) => match[1]));
  // Only what the Builder wrote is the Builder's to write. An import of the
  // author's is in the source already, in whichever of its forms the
  // parser read it by (`<import { Row } from=… />` is one this pattern does
  // not find), and a line added for it would be a second import of it.
  const missing = imports.filter((imp) => written.includes(imp.name) && !have.has(imp.name));
  if (missing.length === 0) return text;

  if (kept.length > 0) {
    const tail = kept[kept.length - 1];
    last = (tail.index ?? 0) + tail[0].length;
    const breakAfter = text.slice(last).match(/^[ \t]*\r?\n/)?.[0].length;
    const lines = missing.map(importLine).join(eol);
    return breakAfter !== undefined
      ? text.slice(0, last + breakAfter) + lines + eol + text.slice(last + breakAfter)
      : text.slice(0, last) + eol + lines + text.slice(last);
  }
  // No import yet: before the first tag of the file, under any comment it opens with.
  const first = text.match(/^[ \t]*<(?!!--)/m);
  const at = first?.index ?? 0;
  return text.slice(0, at) + missing.map(importLine).join(eol) + eol + text.slice(at);
}
