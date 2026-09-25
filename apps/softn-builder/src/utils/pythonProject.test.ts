// @vitest-environment jsdom
/**
 * Starting an app whose logic is Python.
 *
 * It could not be done. A new project was always `logic/main.logic`, which
 * could not be deleted; the runtime refuses an app whose logic mixes the two
 * languages; the navigator renamed `helpers.py` to `helpers.py.logic`; and a
 * logic file it did make started with a `//` comment, a SyntaxError on the
 * first line of a Python module.
 *
 * Pinned: a Python project is `ui/main.ui` linked to `logic/main.py`, and it
 * previews and exports as a Python app; its starter is Python the engine
 * really runs — compiled here by the ZIPP release the repository vendors,
 * not checked by eye; and a new `.py` file starts with a Python comment.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  composeBundleSource,
  createConsoleModule,
  createMockNavModule,
  createMockXDBModule,
  createScriptRuntime,
  readBundleEntries,
  type ScriptContext,
} from '@softn/core';
import initWasm from '../../../../packages/@softn/core/wasm-zipp/zipp_wasm.js';
import { useProjectStore } from '../stores/projectStore';
import { useFilesStore } from '../stores/filesStore';
import { useCanvasStore } from '../stores/canvasStore';
import { buildProjectBundle } from './buildProjectBundle';
import { previewSourceFor } from './previewSource';
import { blankLogicFile, logicStarter } from './logicFiles';

/**
 * The engine binary, found by walking up from the working directory:
 * `import.meta.url` is an http URL under jsdom, not a file one.
 */
function findEngine(): string {
  const rel = 'packages/@softn/core/wasm-zipp/zipp_wasm_bg.wasm';
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, rel);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`Could not find ${rel} from ${process.cwd()}`);
}

beforeAll(async () => {
  // jsdom cannot fetch the engine binary the way a browser does, so it is
  // handed over as bytes, as @softn/core's own tests do (test/setup-wasm.ts).
  await initWasm({ module_or_path: readFileSync(findEngine()) });
});

function newPythonProject(): void {
  useProjectStore.getState().reset('python');
  useFilesStore.getState().reset('python');
  const file = useFilesStore.getState().uiFiles.get(useFilesStore.getState().activeFileId!)!;
  useCanvasStore.getState().loadState(file.elements, file.rootId);
}

function previewOfStores() {
  const project = useProjectStore.getState();
  const files = useFilesStore.getState();
  const canvas = useCanvasStore.getState();
  return previewSourceFor({
    elements: canvas.elements,
    rootId: canvas.rootId,
    logicSource: project.logicSource,
    collections: project.collections,
    activeFileId: files.activeFileId,
    uiFiles: files.uiFiles,
    logicFiles: files.logicFiles,
    nodes: files.nodes,
    retainedSource: project.source,
  });
}

/** An empty `<logic>` block: what the markup holds once the composer has taken the Python out. */
const EMPTY_LOGIC = { type: 'ScriptBlock' as const, code: '', loc: { line: 1, column: 0, start: 0, end: 0 } };

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

describe('a new Python project', () => {
  beforeEach(newPythonProject);

  it('is ui/main.ui linked to logic/main.py, with no JavaScript beside it', () => {
    const files = useFilesStore.getState();
    expect([...files.logicFiles.values()].map((file) => file.path)).toEqual(['logic/main.py']);
    expect(files.uiFiles.get('main_ui')?.logicSrc).toBe('../logic/main.py');
    expect(useProjectStore.getState().logicSource).toBe('');
  });

  it('previews as a Python app, without an error', () => {
    const preview = previewOfStores();
    expect(preview.error).toBeNull();
    expect(preview.composition?.languages).toContain('python');
    expect(preview.composition?.python?.files.main).toBe(logicStarter('python'));
  });

  it('exports its entry file linked to main.py, which composes as Python', async () => {
    const entries = readBundleEntries(await buildProjectBundle());
    const text = new Map([...entries].map(([path, bytes]) => [path, new TextDecoder().decode(bytes)]));
    expect(text.get('ui/main.ui')).toContain('<logic src="../logic/main.py" />');
    const manifest = JSON.parse(text.get('manifest.json')!);
    const composed = composeBundleSource(text, manifest.main, manifest.files.logic);
    expect(composed.languages).toContain('python');
    expect(composed.python?.modules).toEqual(['main']);
  });
});

describe('the Python starter, on the engine', () => {
  it('runs: its names are state and its functions change it', async () => {
    const context = makeContext();
    const runtime = createScriptRuntime(context, undefined, 'builder-python-starter', undefined, undefined, {
      mode: 'main',
      pythonProject: { files: { main: logicStarter('python') }, modules: ['main'] },
    });
    try {
      const loaded = await runtime.loadScript(EMPTY_LOGIC);
      expect(loaded.state).toEqual({ count: 0 });
      expect(Object.keys(loaded.functions).sort()).toEqual(['decrement', 'increment']);
      await loaded.functions.increment();
      await loaded.functions.increment();
      await loaded.functions.decrement();
      // The host mirrors each write, which is what a template binding reads.
      expect(context.state.count).toBe(1);
    } finally {
      runtime.cleanup();
    }
  });

  it('compiles a new .py file, whose header is a Python comment', async () => {
    const helper = blankLogicFile('logic/helpers.py');
    expect(helper.startsWith('# helpers.py')).toBe(true);
    const runtime = createScriptRuntime(makeContext(), undefined, 'builder-python-blank', undefined, undefined, {
      mode: 'main',
      pythonProject: { files: { helpers: helper, main: 'import helpers\ncount = 0\n' }, modules: ['helpers', 'main'] },
    });
    try {
      const loaded = await runtime.loadScript(EMPTY_LOGIC);
      expect(loaded.state.count).toBe(0);
    } finally {
      runtime.cleanup();
    }
  });
});
