/// <reference types="vite/client" />

/**
 * monacoSetup - Points @monaco-editor/react at the bundled Monaco
 *
 * Imported for its side effects by CodeEditor, which is the single component
 * the Source and Logic editors both render through.
 */

import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import { SOFTN_DARK_THEME, SOFTN_LIGHT_THEME, softnDarkTheme, softnLightTheme } from './monacoThemes';

// Monaco asks for one worker per language service. The builder only ever opens
// `javascript` (Logic) and `xml` (Source), and xml is a Monarch grammar with no
// worker behind it, so the TypeScript worker plus the shared editor worker
// cover every editor in the app; the css/html/json workers would be several
// megabytes of precache nobody reaches.
self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    if (label === 'javascript' || label === 'typescript') return new TsWorker();
    return new EditorWorker();
  },
};

// Without this, @monaco-editor/react falls back to loading Monaco from
// jsDelivr at runtime, which leaves both editors stuck on "Loading editor..."
// in an installed builder that is offline.
loader.config({ monaco });

// The brand's editor themes, registered once before any editor asks for them.
monaco.editor.defineTheme(SOFTN_DARK_THEME, softnDarkTheme);
monaco.editor.defineTheme(SOFTN_LIGHT_THEME, softnLightTheme);

// Monaco measures its font once, when the first editor is created. IBM Plex
// Mono arrives with the bundle but may finish loading after that, and a
// measurement taken against the fallback face puts the cursor between
// letters; measure again once the faces are in.
if (typeof document !== 'undefined' && document.fonts) {
  void document.fonts.ready.then(() => monaco.editor.remeasureFonts());
}
