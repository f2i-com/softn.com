/**
 * What the parser says of each page a project is about to ship.
 *
 * Export reads the bundle as the directory would, which checks the archive
 * and its manifest and does not read a page. A page that does not parse was
 * "Ready", and the app made from it stopped where it started; and what the
 * parser only warns of (a second `<data>` block that gives a name already
 * taken to another collection, which is then left out) was said nowhere a
 * person exporting would look. Both are listed in the export's check, each
 * with its file and line. Neither stops the export: the file is the
 * person's, and writing it is also how a project with no file is saved.
 */

import { parse } from '@softn/core';
import type { UIFileState } from '../types/builder';

export interface PageDiagnostic {
  /** `error`: the page does not parse. `warn`: it does, and something written in it does nothing. */
  level: 'error' | 'warn';
  text: string;
}

/**
 * The parser's diagnostics for every page that keeps its own source, errors
 * first, in the order of the pages' paths. A page made on the canvas is
 * written by the Builder and has none.
 */
export function pageDiagnostics(uiFiles: ReadonlyMap<string, UIFileState>): PageDiagnostic[] {
  const found: PageDiagnostic[] = [];
  const pages = [...uiFiles.values()].sort((a, b) => a.path.localeCompare(b.path));
  for (const page of pages) {
    const source = page.originalSource;
    if (source === undefined || source.trim() === '') continue;
    try {
      for (const diagnostic of parse(source).diagnostics ?? []) {
        found.push(
          diagnostic.severity === 'error'
            ? { level: 'error', text: `${page.path} does not parse, and the app will stop there. Line ${diagnostic.loc.line}: ${diagnostic.message}` }
            : { level: 'warn', text: `${page.path}, line ${diagnostic.loc.line}: ${diagnostic.message}` }
        );
      }
    } catch (error) {
      found.push({ level: 'error', text: `${page.path} does not parse, and the app will stop there. ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return [...found.filter((line) => line.level === 'error'), ...found.filter((line) => line.level === 'warn')];
}
