/** @vitest-environment jsdom */
/**
 * What an app prints is in Studio's log, and a stopped app can be handed to the AI.
 *
 * An app's `console.log` and `console.warn` went to the browser's console,
 * which Studio does not show, so the one tool a person reaches for to see
 * what their logic is doing showed nothing here. They are in the Log now as
 * `[App] …`: each different line once, a long one cut, and no more than a
 * fixed number of them, so an app that logs in a loop fills neither the log
 * nor the saved project. They are not handed to the AI: only what the app
 * reported as an error is.
 *
 * And the notice that says an app has stopped offers "Ask the AI to fix it"
 * where a provider is connected: it sends the reason as a request, which is
 * what the person would have typed.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAllBuiltins } from '@softn/components';
import { configureZippWasmSource } from '@softn/core';
import { VisualCanvas } from '../src/components/canvas/VisualCanvas';
import { takePreviewFaults } from '../src/lib/previewFaults';
import { useAIStore, useVFSStore, useWorkspaceStore } from '../src/stores';
import { assertScriptsPassed, fakeProvider, lastRun, resetAgent, resultsIn } from './helpers/agentHarness';

beforeAll(() => {
  configureZippWasmSource(readFileSync(resolve(process.cwd(), '../../packages/@softn/core/wasm-zipp/zipp_wasm_bg.wasm')));
  registerAllBuiltins();
});

const MANIFEST = JSON.stringify({ name: 'Talker', version: '1.0.0', description: 'Talks.', main: 'ui/main.ui', files: { ui: ['ui/main.ui'], logic: ['logic/main.logic'] } });
const UI = `<logic src="../logic/main.logic" />

<App theme="light">
  <Text>Count: {count}</Text>
  <Button @click={() => add()}>Add one</Button>
  <Button @click={() => same()}>Same</Button>
  <Button @click={() => spin()}>Spin</Button>
</App>
`;
const LOGIC = `let count = 0

function add() {
  count = count + 1
  console.log("clicked " + count)
}

function same() {
  console.log("the same line")
  console.warn("careful: " + "x".repeat(400))
}

function spin() {
  while (true) {}
}

function _init() {
  console.log("started")
}
`;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetAgent();
  useWorkspaceStore.setState({ projectId: `talker-${Math.random().toString(36).slice(2)}`, projectName: 'Talker' });
  useVFSStore.getState().hydrateFiles([{ path: 'manifest.json', content: MANIFEST }, { path: 'ui/main.ui', content: UI }, { path: 'logic/main.logic', content: LOGIC }]);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  assertScriptsPassed();
  vi.restoreAllMocks();
  resetAgent();
});

const settle = async (ms = 400) => {
  for (let i = 0; i < ms / 20; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
};
const button = (name: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
const appLines = () => useWorkspaceStore.getState().consoleOutput.filter((line) => line.startsWith('[App] '));

describe('what an app prints', () => {
  it('is in the log, each different line once, a long one cut, and none of it handed to the AI', async () => {
    await act(async () => { root.render(<VisualCanvas />); });
    await settle(1200);
    expect(appLines()).toEqual(['[App] started']);

    await act(async () => { button('Add one')!.click(); });
    await settle(200);
    for (let i = 0; i < 3; i++) {
      await act(async () => { button('Same')!.click(); });
      await settle(120);
    }
    const lines = appLines();
    expect(lines.slice(0, 3)).toEqual(['[App] started', '[App] clicked 1', '[App] the same line']);
    expect(lines).toHaveLength(4);
    // (The engine hands on what a script prints at one level, so a warning is a line like any other.)
    expect(lines[3]).toMatch(/^\[App\] careful: x{200,}…$/);
    expect(lines[3].length).toBeLessThan(340);
    expect(takePreviewFaults(useWorkspaceStore.getState().projectId)).toEqual([]);
  }, 60_000);

  it('stops being copied out after a fixed number of lines, and says so once', async () => {
    await act(async () => { root.render(<VisualCanvas />); });
    await settle(1200);
    for (let i = 0; i < 48; i++) {
      await act(async () => { button('Add one')!.click(); });
      await settle(40);
    }
    await settle(300);
    const lines = appLines();
    expect(container.textContent).toContain('Count: 48');
    expect(lines).toHaveLength(41);
    expect(lines.at(-1)).toBe('[App] More lines from the app are not copied here: the browser’s console has them all.');
    expect(lines.filter((line) => /not copied here/.test(line))).toHaveLength(1);

    // The count is of one run of the app: restarted, it is copied out again, so a page that
    // prints a changing value does not go quiet for good. What it has said before is not said twice.
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Refresh preview"]')!.click(); });
    await settle(1200);
    await act(async () => { button('Same')!.click(); });
    await settle(200);
    await act(async () => { button('Add one')!.click(); });
    await settle(200);
    expect(appLines().slice(41).map((line) => line.replace(/x{20,}…$/, 'x…'))).toEqual(['[App] the same line', '[App] careful: x…']);
  }, 120_000);
});

describe('the notice of an app that has stopped', () => {
  const stopIt = async () => {
    await act(async () => { root.render(<VisualCanvas />); });
    await settle(1200);
    await act(async () => { button('Spin')!.click(); });
    await settle(1500);
    expect(container.querySelector('[data-preview-stopped]')).not.toBeNull();
  };

  it('offers to ask the AI, and asking sends the reason as a request the run is told about', async () => {
    const provider = fakeProvider('anthropic', [{ calls: [{ name: 'finish', input: { summary: 'Looked.' } }] }]);
    await stopIt();
    const ask = button('Ask the AI to fix it')!;
    expect(ask).toBeDefined();
    await act(async () => { ask.click(); });
    await settle(600);
    const asked = useAIStore.getState().messages.find((m) => m.role === 'user');
    expect(asked?.content).toMatch(/^The app stopped in the preview: spin ran until the engine cut it off .* Find what causes it and fix it\.$/);
    expect(provider.count()).toBe(1);
    expect(lastRun().run.status).toBe('finished');
    expect(resultsIn(provider.bodies[0])).toContain('What the app reported in the person’s preview since the last run');
    expect(useWorkspaceStore.getState().leftPanel).toBe('ai');
  }, 60_000);

  it('does not offer it where no provider is connected', async () => {
    useAIStore.setState({ providers: [], activeProviderId: null });
    await stopIt();
    expect(button('Ask the AI to fix it')).toBeUndefined();
    expect(button('Restart the preview')).toBeDefined();
  }, 60_000);
});
