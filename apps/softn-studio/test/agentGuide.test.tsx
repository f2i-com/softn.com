/** @vitest-environment jsdom */
/**
 * The agent's guide, held to the source of truth. What the guide says is
 * what the model writes, so:
 *
 *   - every component it names is one the component manifest registers;
 *   - every markup example in it composes with the runtime's composer and
 *     renders with the real renderer without an error — the snippets with a
 *     stand-in for the logic they refer to, the two complete apps as written;
 *   - the complete apps work when used: typing and clicking change the page
 *     (JavaScript here; the Python one is driven on the web-python engine in
 *     pythonPreview.test.tsx).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerAllBuiltins } from '@softn/components';
import { SoftNRenderer, composeBundleSource, configureZippWasmSource } from '@softn/core';
import { buildGuide, JAVASCRIPT_APP_EXAMPLE, PRIVATE_BACKEND_SECTION, projectHasBackend, PYTHON_APP_EXAMPLE } from '../src/lib/agent/guide';
import { COMPONENT_INDEX } from '../src/lib/agent/knowledge';
import { buildPreviewXDBState, composePreviewProject } from '../src/lib/previewProject';
import type { VFSFile } from '../src/types/studio';

configureZippWasmSource(readFileSync(resolve(process.cwd(), '../../packages/@softn/core/wasm-zipp/zipp_wasm_bg.wasm')));
registerAllBuiltins();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  const current = root;
  await act(async () => {
    current?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

const vfs = (entries: Record<string, string>) =>
  new Map<string, VFSFile>(Object.entries(entries).map(([path, content]) => [path, { path, content, mimeType: 'text/plain', lastModified: 0, lastModifiedBy: 'user', version: 1 }]));

/** Compose `files` as the runtime does, render the main page, and report every error it logged. */
async function renderApp(files: Map<string, VFSFile>, appId: string): Promise<{ errors: string[]; text: () => string }> {
  // The runtime's own composer accepts it…
  const text = new Map([...files].map(([p, f]) => [p, f.content as string]));
  const manifest = JSON.parse(text.get('manifest.json') ?? '{}') as { files?: { logic?: string[] } };
  composeBundleSource(text, 'ui/main.ui', manifest.files?.logic ?? []);
  // …and the preview composes it the same way.
  const result = composePreviewProject(files, 'ui/main.ui');
  if (!result.ok) throw new Error(result.error);
  const { composition } = result;
  const errors: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(
      <SoftNRenderer
        source={composition.source}
        python={composition.python}
        logicBasePath={composition.logicBasePath}
        importResolver={composition.importResolver}
        preIncludedLogicPaths={composition.preIncludedLogicPaths}
        initialData={buildPreviewXDBState(files).initialData}
        appId={appId}
        scriptExecutionMode="main"
        resumeSavedSyncRoom={false}
        onError={(error) => errors.push(`onError: ${error.message}`)}
      />,
    );
  });
  await settle();
  return { errors, text: () => container!.textContent ?? '' };
}

/** The fenced blocks of a markdown text, with their language. */
function blocks(markdown: string, language: string): string[] {
  return [...markdown.matchAll(/```(\w+)\n([\s\S]*?)```/g)].filter((m) => m[1] === language).map((m) => m[2]);
}

/** The example app's files, from its fenced blocks. */
function exampleFiles(example: string, logicPath: string): Map<string, VFSFile> {
  const language = logicPath.endsWith('.py') ? 'python' : 'javascript';
  return vfs({ 'ui/main.ui': blocks(example, 'xml')[0], [logicPath]: blocks(example, language)[0], 'manifest.json': blocks(example, 'json')[0] });
}

const REGISTERED = new Set(COMPONENT_INDEX.filter((c) => c.registered).map((c) => c.name));

describe('the guide names only components that exist', () => {
  it.each([
    ['JavaScript', buildGuide({ python: false, torch: false, style: 'clean' })],
    ['Python', buildGuide({ python: true, torch: true, style: 'clean' })],
  ])('%s', (_language, guide) => {
    const tags = new Set([...guide.matchAll(/<([A-Z][A-Za-z0-9]*)[\s/>]/g)].map((m) => m[1]));
    const unknown = [...tags].filter((t) => !REGISTERED.has(t));
    // <Header /> appears as an example of pasting an imported file, not as the component.
    expect(unknown.filter((t) => t !== 'Header')).toEqual([]);
    expect(tags.size).toBeGreaterThan(15);
  });
});

describe('the complete example apps', () => {
  it('JavaScript: composes, renders without errors, and works — type, add, filter, toggle, delete', async () => {
    const files = exampleFiles(JAVASCRIPT_APP_EXAMPLE, 'logic/main.logic');
    const { errors, text } = await renderApp(files, 'StudioGuideJS');
    expect(errors).toEqual([]);
    expect(text()).toContain('Tasks');
    expect(text()).toContain('No tasks');
    expect(text()).toContain('0 remaining');

    const input = container!.querySelector('input:not([type="checkbox"])') as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(input, 'Buy milk');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    const button = (label: string) => [...container!.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;
    await act(async () => button('Add').click());
    await settle();
    expect(text()).toContain('Buy milk');
    expect(text()).toContain('1 remaining');

    const checkbox = container!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => checkbox.click());
    await settle();
    expect(text()).toContain('0 remaining');

    const tab = [...container!.querySelectorAll('[role="tab"]')].find((t) => t.textContent?.trim() === 'Active') as HTMLElement;
    await act(async () => tab.click());
    await settle();
    expect(text()).not.toContain('Buy milk');

    await act(async () => ([...container!.querySelectorAll('[role="tab"]')].find((t) => t.textContent?.trim() === 'All') as HTMLElement).click());
    await settle();
    await act(async () => button('Delete').click());
    await settle();
    expect(text()).toContain('No tasks');
    expect(errors).toEqual([]);
  }, 30_000);

  it('Python: composes and renders without errors on the web-python engine', async () => {
    const files = exampleFiles(PYTHON_APP_EXAMPLE, 'logic/main.py');
    const { errors, text } = await renderApp(files, 'StudioGuidePy');
    expect(errors).toEqual([]);
    expect(text()).toContain('No tasks');
    expect(text()).toContain('0 remaining');
  }, 30_000);
});

describe('every markup snippet in the guide', () => {
  // The names the snippets read, as a page's logic would define them.
  const STAND_IN = {
    javascript: 'let count = 0\nlet items = [{ title: "One" }]\nlet loading = false\nfunction increment() {\n  count = count + 1\n}',
    python: 'count = 0\nitems = [{"title": "One"}]\nloading = False\n\n\ndef increment():\n    global count\n    count = count + 1\n',
  };

  it.each([
    ['JavaScript', false],
    ['Python', true],
  ])('%s: composes and renders without errors', async (_language, python) => {
    const guide = buildGuide({ python, torch: false, style: 'clean' });
    const example = python ? PYTHON_APP_EXAMPLE : JAVASCRIPT_APP_EXAMPLE;
    const snippets = blocks(guide, 'xml').filter((b) => !example.includes(b));
    expect(snippets.length).toBeGreaterThanOrEqual(2);
    const logicPath = python ? 'logic/main.py' : 'logic/main.logic';
    for (const [i, snippet] of snippets.entries()) {
      const ui = snippet.includes('<logic') ? snippet : `<logic src="../${logicPath}" />\n${snippet}`;
      const files = vfs({
        'ui/main.ui': ui,
        [logicPath]: python ? STAND_IN.python : STAND_IN.javascript,
        'manifest.json': JSON.stringify({ name: 'Snippet', version: '1.0.0', main: 'ui/main.ui', files: { ui: ['ui/main.ui'], logic: [logicPath] } }),
      });
      const { errors } = await renderApp(files, `StudioGuideSnippet${python ? 'Py' : 'Js'}${i}`);
      expect({ snippet: i, errors }).toEqual({ snippet: i, errors: [] });
      await act(async () => root?.unmount());
      root = null;
      container?.remove();
      container = null;
      vi.restoreAllMocks();
    }
  }, 60_000);

  it('the JavaScript logic sample runs', async () => {
    const guide = buildGuide({ python: false, torch: false, style: 'clean' });
    const sample = blocks(guide, 'javascript').find((b) => b.includes('function remaining'))!;
    const files = vfs({
      'ui/main.ui': '<logic src="../logic/main.logic" />\n<App>\n  <Input :bind={draft} />\n  <Button @click={() => add()}>Add</Button>\n  <Text>{remaining()} left</Text>\n</App>',
      'logic/main.logic': sample,
      'manifest.json': JSON.stringify({ name: 'Sample', version: '1.0.0', main: 'ui/main.ui', files: { ui: ['ui/main.ui'], logic: ['logic/main.logic'] } }),
    });
    const { errors, text } = await renderApp(files, 'StudioGuideSample');
    expect(errors).toEqual([]);
    expect(text()).toMatch(/0\s*left/);
  }, 30_000);
});

describe('the private backend section', () => {
  const runtime = (file: string) => readFileSync(resolve(process.cwd(), '../softn-host-php/runtime', file), 'utf8');
  const manifest = (server?: unknown) => JSON.stringify({ name: 'Notes', version: '1.0.0', main: 'ui/main.ui', ...(server ? { server } : {}) });

  it('is in the guide only for a project whose manifest declares a backend entry', () => {
    const backend = { entry: 'server/main.logic', requires: { apiVersion: 1, capabilities: ['sql'] } };
    expect(projectHasBackend(manifest(backend))).toBe(true);
    expect(projectHasBackend(manifest())).toBe(false);
    expect(projectHasBackend(manifest({ database: { kind: 'private-sqlite' } }))).toBe(false);
    expect(projectHasBackend('{ not json')).toBe(false);
    expect(projectHasBackend(undefined)).toBe(false);
    expect(buildGuide({ python: false, torch: false, backend: true, style: 'clean' })).toContain(PRIVATE_BACKEND_SECTION);
    expect(buildGuide({ python: false, torch: false, style: 'clean' })).not.toContain("This app's private backend");
  });

  it('says what the backend runtime does: its methods, its route paths and its SQL bindings', () => {
    const worker = runtime('request-worker.mjs');
    const host = runtime('wasm-host.mjs');
    // Methods and the exact-match /api/ paths the section describes.
    expect(worker).toContain("['GET','POST','PUT','DELETE'].includes(request.method)");
    expect(worker).toContain(String.raw`/^\/api\/[a-zA-Z0-9/_-]+$/`);
    expect(worker).toContain('routes.find(r=>r.path===request.path&&r.method===request.method)');
    expect(PRIVATE_BACKEND_SECTION).toContain('GET, POST, PUT and DELETE');
    expect(PRIVATE_BACKEND_SECTION).toContain('no `/:id` segments');
    for (const binding of ['softn.sql.query', 'softn.sql.first', 'softn.sql.execute']) {
      expect(host).toContain(`${binding}=function(s,p)`);
      expect(PRIVATE_BACKEND_SECTION).toContain(`\`${binding}(sql, params)\``);
    }
  });
});
