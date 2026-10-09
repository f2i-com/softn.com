/**
 * Renaming and moving a logic file.
 *
 * A `<logic src>` left pointing at a name that no longer exists produces the
 * worst possible outcome: the app renders completely and does nothing at all.
 * Nothing downstream treats it as an error — the preview substitutes an empty
 * `<logic>` block "to avoid parse errors", the parser turns the dangling tag
 * into an empty code block, and the renderer swaps every handler that is not a
 * function for a no-op whose warning is gated on `scriptLoaded`, which is false
 * in exactly this case. One console.warn, for an entirely dead app.
 *
 * `logicSrc` is only set on bundles that carried an explicit `<logic src>`, so
 * these tests establish one rather than relying on the default project, where
 * the pairing is implicit.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useFilesStore } from './filesStore';

const UI_ID = 'main_ui';
const LOGIC_ID = 'main_logic';

function store() {
  return useFilesStore.getState();
}

/** What the UI file's `<logic src>` currently resolves to. */
function resolvedLogicRef(): string | undefined {
  const file = store().uiFiles.get(UI_ID);
  if (!file?.logicSrc) return undefined;
  return store().resolveImportPath(file.path, file.logicSrc);
}

beforeEach(() => {
  store().reset();
  // A bundle loaded from disk carries the tag explicitly, and export writes it
  // back out from `originalSource`.
  store().updateUIFileLogicSrc(UI_ID, '../logic/main.logic');
  store().updateUIFileSource(
    UI_ID,
    '<logic src="../logic/main.logic" />\n<Stack></Stack>'
  );
});

describe('the fixture', () => {
  it('starts with a reference that resolves to the logic file', () => {
    expect(resolvedLogicRef()).toBe('logic/main.logic');
    expect(store().logicFiles.get(LOGIC_ID)?.path).toBe('logic/main.logic');
  });
});

describe('renaming a logic file', () => {
  it('repoints the UI files that referenced it', () => {
    store().renameFile(LOGIC_ID, 'app.logic');

    expect(store().logicFiles.get(LOGIC_ID)?.path).toBe('logic/app.logic');
    expect(resolvedLogicRef()).toBe('logic/app.logic');
  });

  it('keeps the reference resolvable from the UI file that holds it', () => {
    store().renameFile(LOGIC_ID, 'renamed.logic');

    const target = store().logicFiles.get(LOGIC_ID)!.path;
    expect(resolvedLogicRef()).toBe(target);
  });

  it('rewrites the tag in the original source too', () => {
    // Multi-file export re-emits the header from `originalSource`, so a stale
    // tag there would be written back into the exported bundle.
    store().renameFile(LOGIC_ID, 'app.logic');

    const source = store().uiFiles.get(UI_ID)?.originalSource ?? '';
    expect(source).toContain('app.logic');
    expect(source).not.toContain('main.logic');
  });

  it('leaves a UI file that referenced something else alone', () => {
    store().updateUIFileLogicSrc(UI_ID, '../logic/other.logic');
    store().renameFile(LOGIC_ID, 'app.logic');

    expect(store().uiFiles.get(UI_ID)?.logicSrc).toBe('../logic/other.logic');
  });

  it('leaves logic references alone when a UI file is renamed', () => {
    store().renameFile(UI_ID, 'home.ui');

    expect(store().uiFiles.get(UI_ID)?.path).toBe('ui/home.ui');
    expect(resolvedLogicRef()).toBe('logic/main.logic');
  });
});

describe('moving a logic file', () => {
  it('repoints the UI files that referenced it', () => {
    store().moveFile(LOGIC_ID, 'logic/nested');

    const target = store().logicFiles.get(LOGIC_ID)!.path;
    expect(target).toBe('logic/nested/main.logic');
    expect(resolvedLogicRef()).toBe(target);
  });
});

/**
 * An `<import … from>` follows the page it names.
 *
 * Only `<logic src>` was followed. A component page that was renamed, or
 * moved to another folder, left every page that used it importing a path
 * that no longer existed, and a page that was itself moved kept the paths
 * it had been written with, which are relative to where it used to be.
 */
describe('renaming and moving pages that import one another', () => {
  let headerId = '';
  const importsOfMain = () => store().uiFiles.get(UI_ID)!.imports.map((imp) => `${imp.name} from ${imp.source}`);
  const mainSource = () => store().uiFiles.get(UI_ID)!.originalSource ?? '';

  beforeEach(() => {
    headerId = store().createFile('ui/components', 'Header.ui', 'ui');
    store().setActiveFile(UI_ID);
    store().updateUIFileSource(
      UI_ID,
      '<import Header from="./components/Header.ui" />\n<import { Row } from=\'./components/Header.ui\' />\n<logic src="../logic/main.logic" />\n<App><Header /></App>'
    );
  });

  it('the fixture imports a page that is there', () => {
    expect(store().uiFiles.get(headerId)?.path).toBe('ui/components/Header.ui');
  });

  it('a renamed page is imported under its new name, in the source and in the list', () => {
    store().renameFile(headerId, 'TopBar.ui');
    expect(mainSource()).toContain('<import Header from="./components/TopBar.ui" />');
    expect(mainSource()).toContain("<import { Row } from='./components/TopBar.ui' />");
    expect(mainSource()).not.toContain('Header.ui');
    expect(importsOfMain()).toEqual(['Header from ./components/TopBar.ui', 'Row from ./components/TopBar.ui']);
  });

  it('a page imported with the `=` left out is followed too, as the composer places it', () => {
    // The parser and the composer read `from "./x.ui"` as the same import
    // (core, UI_IMPORT_PATTERN). The rename looked for `from=` alone, and
    // left a page written the other way importing a file that had gone.
    store().updateUIFileSource(UI_ID, '<import Header from "./components/Header.ui" />\n<App><Header /></App>');
    expect(importsOfMain()).toEqual(['Header from ./components/Header.ui']);
    store().renameFile(headerId, 'TopBar.ui');
    expect(mainSource()).toContain('<import Header from "./components/TopBar.ui" />');
    expect(importsOfMain()).toEqual(['Header from ./components/TopBar.ui']);
  });

  it('a moved page is imported from where it went', () => {
    store().moveFile(headerId, 'ui/shared');
    expect(mainSource()).toContain('<import Header from="./shared/Header.ui" />');
    expect(importsOfMain()[0]).toBe('Header from ./shared/Header.ui');
  });

  it('a page that is moved still imports the same pages, and links the same logic', () => {
    store().moveFile(UI_ID, 'ui/pages');
    expect(store().uiFiles.get(UI_ID)?.path).toBe('ui/pages/main.ui');
    expect(mainSource()).toContain('<import Header from="../components/Header.ui" />');
    expect(mainSource()).toContain('<logic src="../../logic/main.logic" />');
    expect(importsOfMain()[0]).toBe('Header from ../components/Header.ui');
  });

  it('an import of something else is left as it was written', () => {
    store().updateUIFileSource(UI_ID, '<import Card from="./components/Card.ui" />\n<App><Card /></App>');
    store().renameFile(headerId, 'TopBar.ui');
    expect(mainSource()).toContain('<import Card from="./components/Card.ui" />');
  });
});
