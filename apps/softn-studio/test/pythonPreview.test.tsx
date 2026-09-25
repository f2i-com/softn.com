/** @vitest-environment jsdom */
/**
 * The Python example, rendered: the real renderer and the real web-python
 * engine, fed what Studio's preview composes.
 *
 * The engine tests call the example's functions directly. What they cannot
 * show is the template side — `{goal_label()}`, `#each (item in pages)`,
 * `@click={() => go(item.id)}` — reaching a Python app through the renderer.
 * Those are the idioms the Python prompt teaches, so this renders them.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { registerAllBuiltins } from '@softn/components';
import { SoftNRenderer, configureZippWasmSource } from '@softn/core';
import { READING_LIST_PYTHON } from '../src/examples/readingListPython';
import { PYTHON_APP_EXAMPLE } from '../src/lib/agentOrchestrator';
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
});

/** Let the engine load, the script run and the state settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

describe('the Python example in the renderer', () => {
  it('shows state from Python, calls Python from the template, and switches page from a button', async () => {
    const files = new Map<string, VFSFile>(
      READING_LIST_PYTHON.files.map((f) => [
        f.path,
        { path: f.path, content: f.content, mimeType: 'text/plain', lastModified: 0, lastModifiedBy: 'user', version: 1 },
      ]),
    );
    const result = composePreviewProject(files, 'ui/main.ui');
    if (!result.ok) throw new Error(result.error);
    const { composition } = result;

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
          initialData={buildPreviewXDBState(files).initialData}
          appId="StudioPythonPreview"
          scriptExecutionMode="main"
          resumeSavedSyncRoom={false}
        />,
      );
    });
    await settle();

    const text = () => container!.textContent ?? '';
    expect(text()).toContain('Reading list');
    expect(text()).toContain('Goal: 12 books this year');
    expect(text()).toContain('Piranesi');

    const button = (label: string) => [...container!.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
    await act(async () => {
      button('One more')!.click();
    });
    await settle();
    expect(text()).toContain('Goal: 13 books this year');

    await act(async () => {
      button('About')!.click();
    });
    await settle();
    expect(text()).toContain('This example is the reading list with its logic written in Python');
  }, 30_000);
});

describe("the Python prompt's own example in the renderer", () => {
  it('runs as the model is taught to write it: bound input, arrow handlers, a function in the template', async () => {
    // Read from the prompt itself, so the example the model copies is the one tested.
    const blocks = [...PYTHON_APP_EXAMPLE.matchAll(/```(xml|python)\n([\s\S]*?)```/g)];
    const ui = blocks.find((b) => b[1] === 'xml')![2];
    const main = blocks.find((b) => b[1] === 'python')![2];
    const files = new Map<string, VFSFile>(
      [
        ['ui/main.ui', ui],
        ['logic/main.py', main],
      ].map(([path, content]) => [path, { path, content, mimeType: 'text/plain', lastModified: 0, lastModifiedBy: 'user', version: 1 }]),
    );
    const result = composePreviewProject(files, 'ui/main.ui');
    if (!result.ok) throw new Error(result.error);
    const { composition } = result;

    container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container!);
      root.render(
        <SoftNRenderer
          source={composition.source}
          python={composition.python}
          logicBasePath={composition.logicBasePath}
          appId="StudioPythonPromptExample"
          scriptExecutionMode="main"
          resumeSavedSyncRoom={false}
        />,
      );
    });
    await settle();
    const text = () => container!.textContent ?? '';
    expect(text()).toContain('No tasks');
    // The renderer joins an expression to the text after it, so no space is asserted.
    expect(text()).toMatch(/0\s*remaining/);

    const input = container!.querySelector('input:not([type="checkbox"])') as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(input, 'Buy milk');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    const add = [...container!.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Add')!;
    await act(async () => {
      add.click();
    });
    await settle();
    // The input is bound with :bind, so what was typed reached Python's
    // new_task, and add_task (called through an arrow) appended it.
    expect(text()).toContain('Buy milk');
    expect(text()).toMatch(/1\s*remaining/);

    const remove = [...container!.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Delete')!;
    await act(async () => {
      remove.click();
    });
    await settle();
    expect(text()).toContain('No tasks');
  }, 30_000);
});
