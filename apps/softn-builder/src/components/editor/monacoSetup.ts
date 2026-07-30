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
