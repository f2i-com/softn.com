/**
 * The references between a project's files that lead nowhere.
 *
 * A page names other files in two ways: `<import Banner from="./Banner.ui" />`
 * and `<logic src="../logic/main.logic" />`, each resolved against the page's
 * own path. Renaming a file follows both; deleting one leaves them. The
 * bundle that is then exported is well formed (every file its manifest lists
 * is there), so the check the export dialog ran, which reads the bundle as
 * the directory does, called it ready: the first sign was the app, saying
 * "Unknown component" where the page had been used, or doing nothing where
 * its logic had been.
 */

import type { LogicFileState, UIFileState } from '../types/builder';
import { logicSrcOf, resolveImportPath } from './logicFiles';

export interface DanglingReference {
  /** The page that holds the reference. */
  page: string;
  kind: 'import' | 'logic';
  /** The reference as the page writes it. */
  source: string;
  /** The component name an import gives the file, where it gives one. */
  name?: string;
  /** The path it comes to, which the project does not have. */
  target: string;
}

function stripSlash(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}

/** Every import and logic link of every page that names a file the project does not have, in page order. */
export function danglingReferences(
  uiFiles: ReadonlyMap<string, UIFileState>,
  logicFiles: ReadonlyMap<string, LogicFileState>
): DanglingReference[] {
  const pages = new Set([...uiFiles.values()].map((file) => stripSlash(file.path)));
  const logic = new Set([...logicFiles.values()].map((file) => stripSlash(file.path)));
  const found: DanglingReference[] = [];

  for (const file of [...uiFiles.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    const page = stripSlash(file.path);
    for (const imported of file.imports) {
      // A package is not a file of the project.
      if (imported.source.startsWith('@')) continue;
      const target = resolveImportPath(page, imported.source);
      if (!pages.has(target)) found.push({ page, kind: 'import', source: imported.source, name: imported.name, target });
    }
    const src = logicSrcOf(file, logicFiles);
    if (src) {
      const target = resolveImportPath(page, src);
      if (!logic.has(target)) found.push({ page, kind: 'logic', source: src, target });
    }
  }
  return found;
}

/** A reference that leads nowhere, as a line a person reads before the app leaves. */
export function describeDangling(reference: DanglingReference): string {
  return reference.kind === 'import'
    ? `${reference.page} imports ${reference.name ? `${reference.name} from ` : ''}${reference.source}, and the project has no ${reference.target}: where it is used the app will say “Unknown component”.`
    : `${reference.page} links ${reference.source}, and the project has no ${reference.target}: its bindings will be empty and its handlers will do nothing.`;
}
