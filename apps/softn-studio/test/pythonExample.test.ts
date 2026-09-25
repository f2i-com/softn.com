/**
 * The bundled Python example runs on the engine it will run on.
 *
 * Nothing about its logic is mocked: the ZIPP web-python build the repository
 * vendors compiles the example's two modules, as composed from its own files
 * with its own manifest, and the functions its templates call are called. An
 * example that only looked like Python — one the composer accepted and the
 * engine then refused — would be worse than none, so this is what pins it.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  composeBundleSource,
  configureZippWasmSource,
  createConsoleModule,
  createMockNavModule,
  createMockXDBModule,
  createScriptRuntime,
  type ScriptContext,
} from '@softn/core';
import { READING_LIST_PYTHON } from '../src/examples/readingListPython';
import { generateBlueprintFromBrief, scaffoldProjectFiles } from '../src/lib/studioProject';
import type { ProjectBrief } from '../src/types/studio';

// Under Node the engine's glue would fetch its binary over HTTP; hand it the
// bytes instead, before anything starts the engine.
configureZippWasmSource(readFileSync(resolve(__dirname, '../../../packages/@softn/core/wasm-zipp/zipp_wasm_bg.wasm')));

/** The empty `<logic>` block a Python composition leaves in the markup. */
const EMPTY_LOGIC = { type: 'ScriptBlock', code: '', loc: { line: 1, column: 0, start: 0, end: 0 } } as const;

function makeContext(): ScriptContext {
  const state: Record<string, unknown> = {};
  return {
    state,
    setState: (path, value) => {
      state[path] = value;
    },
    data: {},
    xdb: createMockXDBModule(),
    nav: createMockNavModule(),
    console: createConsoleModule(),
  };
}

describe('the Python example', () => {
  it('composes from its manifest and runs: state, functions, and a helper imported by module name', async () => {
    const files = new Map(READING_LIST_PYTHON.files.map((f) => [f.path, f.content]));
    const manifest = JSON.parse(files.get('manifest.json')!) as { main: string; files: { logic: string[] } };
    const composed = composeBundleSource(files, manifest.main, manifest.files.logic);
    expect(composed.python?.modules).toEqual(['shelf', 'main']);

    const runtime = createScriptRuntime(makeContext(), undefined, 'studio-python-example', undefined, composed.logicBasePath, {
      mode: 'main',
      pythonProject: composed.python,
    });
    try {
      const loaded = await runtime.loadScript(EMPTY_LOGIC);
      expect(loaded.state).toMatchObject({ appName: 'Reading list', page: 'home', goal: 12 });
      expect(loaded.state.pages).toEqual([{ id: 'home', label: 'Home' }, { id: 'about', label: 'About' }]);
      expect(Object.keys(loaded.functions)).toEqual(expect.arrayContaining(['go', 'raise_goal', 'goal_label']));

      expect(loaded.syncFunctions.goal_label()).toBe('Goal: 12 books this year');
      await loaded.functions.raise_goal();
      expect(loaded.syncFunctions.goal_label()).toBe('Goal: 13 books this year');
    } finally {
      runtime.cleanup();
    }
  }, 30_000);
});

describe('the Python scaffold', () => {
  it('compiles with whatever the brief says, as data, and its shell navigates', async () => {
    // Quotes, a backslash, a newline and markup: JSON string literals are
    // Python string literals, so none of it can end the literal it sits in.
    const brief: ProjectBrief = {
      appName: 'Club "Quotes" \\ </title>',
      description: "Line one\nLine two, it's {not} code",
      target: 'web',
      pages: ['Home', 'Members'],
      collections: [],
      authNeeded: false,
      style: 'clean',
      logicLanguage: 'python',
      referenceImages: [],
    };
    const files = new Map(scaffoldProjectFiles(brief, generateBlueprintFromBrief(brief)).map((f) => [f.path, f.content]));
    const composed = composeBundleSource(files, 'ui/main.ui', ['logic/main.py']);
    const context = makeContext();
    const runtime = createScriptRuntime(context, undefined, 'studio-python-scaffold', undefined, composed.logicBasePath, {
      mode: 'main',
      pythonProject: composed.python,
    });
    try {
      const loaded = await runtime.loadScript(EMPTY_LOGIC);
      expect(loaded.state).toMatchObject({ appName: brief.appName, appDescription: brief.description, page: 'home' });
      expect(loaded.state.pages).toEqual([{ id: 'home', label: 'Home' }, { id: 'members', label: 'Members' }]);
      await loaded.functions.go('members');
      // The `global` in go is what makes this the app's page, not a local.
      expect(context.state.page).toBe('members');
    } finally {
      runtime.cleanup();
    }
  }, 30_000);
});
