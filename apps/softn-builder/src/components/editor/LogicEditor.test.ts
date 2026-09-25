/**
 * Which language the logic editor highlights, and why it is not a constant.
 *
 * The runtime decides an app's language from its logic file names: a file
 * ending `.py` is Python. The editor has to agree, and not because of the
 * colours — Monaco's auto-indent for JavaScript fights code whose indentation
 * IS the program, and its JavaScript parser marks correct Python as broken
 * from the first `def`.
 */

import { describe, expect, it } from 'vitest';
import { editorLanguageFor } from './logicLanguage';
import { composePreviewBundle } from '../../utils/previewBundle';
import { previewManifest } from '../../utils/bundleExporter';

/**
 * The preview's composition of a project made here: the manifest export
 * would write lists every logic file, which is how a helper no markup names
 * is found at all.
 */
function composeProject(files: Map<string, string>) {
  const logic = [...files.keys()].filter((path) => path.startsWith('logic/'));
  return composePreviewBundle(files, 'ui/main.ui', previewManifest(null, logic, undefined));
}

describe('the logic editor follows the file name', () => {
  it('highlights a .py logic file as Python', () => {
    expect(editorLanguageFor('logic/main.py')).toBe('python');
    expect(editorLanguageFor('app.PY')).toBe('python');
  });

  it('highlights everything else as JavaScript', () => {
    expect(editorLanguageFor('logic/main.logic')).toBe('javascript');
    expect(editorLanguageFor(undefined)).toBe('javascript');
    expect(editorLanguageFor('notes.py.logic')).toBe('javascript');
  });
});

describe('the preview composes a Python project', () => {
  const MAIN_PY = ['from helpers import double', '', 'count = 0', ''].join('\n');
  const HELPERS_PY = ['def double(x):', '    return x * 2', ''].join('\n');
  const ui = (logic: string) => [`<logic src="../logic/${logic}" />`, '<p>hi</p>'].join('\n');

  it('counts .py as logic, so a preview is not an app with nothing behind it', () => {
    const files = new Map<string, string>([
      ['ui/main.ui', ui('main.py')],
      ['logic/main.py', 'count = 0\n'],
    ]);
    const composed = composeProject(files);
    expect(composed.languages).toEqual(['javascript', 'python']);
    expect(composed.python?.modules).toEqual(['main']);
    expect(composed.python?.files.main).toBe('count = 0\n');
  });

  it('collects a .py helper the markup never references, the way it does .logic', () => {
    // This is what the extension scan is FOR. A helper module is imported by
    // another module rather than referenced from the markup, so nothing would
    // find it if the preview only collected what the markup names.
    const files = new Map<string, string>([
      ['ui/main.ui', ui('main.py')],
      ['logic/main.py', MAIN_PY],
      ['logic/helpers.py', HELPERS_PY],
    ]);
    const composed = composeProject(files);
    expect(composed.python?.modules).toEqual(['helpers', 'main']);
    expect(composed.python?.files.helpers).toBe(HELPERS_PY);
  });

  it('leaves a JavaScript project composed exactly as before', () => {
    const files = new Map<string, string>([
      ['ui/main.ui', ui('main.logic')],
      ['logic/main.logic', 'let count = 0;'],
    ]);
    const composed = composeProject(files);
    expect(composed.languages).toEqual(['javascript']);
    expect(composed.python).toBeUndefined();
    expect(composed.source).toContain('let count = 0;');
  });
});
