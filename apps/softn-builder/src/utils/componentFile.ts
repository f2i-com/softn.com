/**
 * A component file: a page made to be used inside other pages.
 *
 * A new UI file is a page of its own, with an `<App>` around what it holds.
 * The files a real app keeps under `ui/components/` are not: each is what
 * goes where its tag stands, a row or a header, and has no App. Such a
 * file could be made only by writing it in Code. It is made here with a
 * source from the first, so it is written back as the fragment it is and
 * never given an App it did not have.
 */

import { useFilesStore } from '../stores/filesStore';
import { pageName } from './pageImports';

/** Where component files go unless a folder is asked for. */
export const COMPONENTS_FOLDER = 'ui/components';

/** What a new component file holds: something to see where it is used, in something to drop more into. */
export function componentStarter(fileName: string): string {
  return `<Stack>\n  <Text>${pageName(fileName)}</Text>\n</Stack>\n`;
}

/** Make a component file and open it. Throws what `createFile` throws for a name that cannot be used. */
export function createComponentFile(name: string, parentPath: string = COMPONENTS_FOLDER): string {
  const fileName = /\.ui$/i.test(name) ? name : `${name}.ui`;
  const files = useFilesStore.getState();
  const id = files.createFile(parentPath, fileName, 'ui');
  useFilesStore.getState().updateUIFileSource(id, componentStarter(fileName));
  return id;
}
