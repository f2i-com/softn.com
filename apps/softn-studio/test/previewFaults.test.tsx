/** @vitest-environment jsdom */
/**
 * An app whose logic stops says so, to the person and to the agent.
 *
 * A handler that never returns (`while (true) {}`, a function that calls
 * itself for ever, a pattern that backtracks without end) does not freeze
 * Studio: the engine counts its steps and cuts the call off in well under a
 * second. What it does after that is stop for good. Every later click in the
 * preview is ignored, and the only word of it was in the browser's own
 * console, which Studio does not show: the preview went on saying "Running"
 * over an app in which no button did anything, and when the loop was in
 * `_init` it opened that way. The agent was told in the engine's words
 * ("RangeError: script exceeded its instruction budget", then "zipp: engine
 * is disposed"), which say nothing of loops.
 *
 * The preview now says the app stopped, why, and offers to restart it; the
 * check and run_app_function say what an endless loop is in a sentence; the
 * log carries what the app's logic reported; and the next run is told what
 * the person's preview reported since the last one.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerAllBuiltins } from '@softn/components';
import { configureZippWasmSource } from '@softn/core';
import { VisualCanvas } from '../src/components/canvas/VisualCanvas';
import { browserEnvironment, runAppFunction } from '../src/lib/agent/appCheck';
import { buildProjectContext } from '../src/lib/agent/prompt';
import { duringCheck, explainEngineStops, heardByPreview, listenToConsoleErrors, notePreviewFault, readAppFault, takePreviewFaults } from '../src/lib/previewFaults';
import { useVFSStore, useWorkspaceStore } from '../src/stores';
import type { VFSFile } from '../src/types/studio';

beforeAll(() => {
  configureZippWasmSource(readFileSync(resolve(process.cwd(), '../../packages/@softn/core/wasm-zipp/zipp_wasm_bg.wasm')));
  registerAllBuiltins();
});

const MANIFEST = JSON.stringify({ name: 'Loop', version: '1.0.0', main: 'ui/main.ui', files: { ui: ['ui/main.ui'], logic: ['logic/main.logic'] } });
const UI = `<logic src="../logic/main.logic" />

<App theme="light">
  <Text>Count: {count}</Text>
  <Button @click={() => add()}>Add one</Button>
  <Button @click={() => spin()}>Spin</Button>
</App>
`;
const logic = (extra = '') => `let count = 0\n\nfunction add() {\n  count = count + 1\n}\n\nfunction spin() {\n  while (true) {}\n}\n${extra}`;
const INIT_LOOP = '\nfunction _init() {\n  while (true) {}\n}\n';

const project = (logicSource: string): Record<string, string> => ({ 'manifest.json': MANIFEST, 'ui/main.ui': UI, 'logic/main.logic': logicSource });
const vfs = (entries: Record<string, string>) =>
  new Map<string, VFSFile>(Object.entries(entries).map(([path, content]) => [path, { path, content, mimeType: 'text/plain', lastModified: 0, lastModifiedBy: 'user', version: 1 }]));

describe('what the runtime reports, read for a person', () => {
  it('reads a call cut off at its budget as a stop, and says what does that', () => {
    const fault = readAppFault(['[SoftN] Error executing function spin:', new RangeError('script exceeded its instruction budget')]);
    expect(fault).toEqual({
      stopped: true,
      text: 'spin ran until the engine cut it off (script exceeded its instruction budget), which is what an endless loop or a function that calls itself without end does. The app’s logic stopped there: nothing in it runs again until it is restarted.',
    });
    expect(readAppFault(['[SoftN] Error executing function find:', new RangeError('regular expression exceeded its execution budget')])).toEqual({
      stopped: true,
      text: 'A regular expression in find ran until the engine cut it off (regular expression exceeded its execution budget), which is what a pattern that backtracks without end does. The app’s logic stopped there: nothing in it runs again until it is restarted.',
    });
  });

  it('reads the lines that follow a stop as the same stop, with nothing more to say', () => {
    expect(readAppFault(['[SoftN] Error syncing state after spin:', new Error('zipp: engine is disposed')])).toEqual({ stopped: true, text: '' });
    expect(readAppFault(['[SoftN] The script engine has stopped (a call exceeded its budget or failed to compile); ignoring add and later calls until the app is reloaded.'])).toEqual({ stopped: true, text: '' });
    expect(readAppFault(['[SoftN] Error executing function add:', new Error('zipp: engine is disposed')])).toEqual({ stopped: true, text: '' });
  });

  it('reads a handler that throws as a failure of that handler, and leaves the engine running', () => {
    expect(readAppFault(['[SoftN] Error executing function save:', new TypeError('Cannot read properties of undefined (reading \'title\')')])).toEqual({
      stopped: false,
      text: 'save failed: Cannot read properties of undefined (reading \'title\')',
    });
    // What the app itself wrote with console.error arrives under the same mark.
    expect(readAppFault(['[SoftN]', 'could not load', 3])).toEqual({ stopped: false, text: 'could not load 3' });
  });

  it('leaves alone what is not the runtime’s', () => {
    expect(readAppFault(['Warning: Each child in a list should have a unique "key" prop.'])).toBeNull();
    expect(readAppFault([new Error('[SoftN] not a line of the runtime')])).toBeNull();
    expect(readAppFault([])).toBeNull();
  });

  it('turns the engine’s lines about a stop into one sentence, and leaves every other line as it was', () => {
    expect(explainEngineStops([
      '[SoftN] Error executing function _init: RangeError: script exceeded its instruction budget',
      '[SoftN] Error syncing state after _init: zipp: engine is disposed',
      '[SoftN] Error evaluating expression "x.y": TypeError: x is undefined',
    ])).toEqual([
      '_init ran until the engine cut it off (script exceeded its instruction budget), which is what an endless loop or a function that calls itself without end does. The app’s logic stopped there: nothing in it runs again until it is restarted.',
      '[SoftN] Error evaluating expression "x.y": TypeError: x is undefined',
    ]);
  });
});

describe('whose line it is, while a check renders', () => {
  const budget = (fn: string) => [`[SoftN] Error executing function ${fn}:`, new RangeError('script exceeded its instruction budget')];
  const heardDuring = async (mayRun: (fn: string) => boolean, lines: unknown[][]) => {
    const heard: string[] = [];
    const taken: boolean[] = [];
    const stop = listenToConsoleErrors((args) => heard.push(readAppFault(args)?.text ?? ''));
    await duringCheck(mayRun, async () => { for (const line of lines) taken.push(heardByPreview(line)); });
    stop();
    return { heard, taken };
  };

  it('is the preview’s when it names a function the check never runs', async () => {
    const { heard, taken } = await heardDuring((fn) => fn === '_init', [budget('spin'), ['[SoftN] Error syncing state after spin:', new Error('zipp: engine is disposed')]]);
    expect(taken).toEqual([true, true]);
    expect(heard[0]).toMatch(/^spin ran until the engine cut it off/);
  });

  it('is the check’s the first time it names one the check runs, and the preview’s the second: each engine stops once', async () => {
    const { heard, taken } = await heardDuring((fn) => fn === '_init', [budget('_init'), ['[SoftN] Error syncing state after _init:', new Error('zipp: engine is disposed')], budget('_init')]);
    expect(taken).toEqual([false, false, true]);
    expect(heard).toEqual([expect.stringMatching(/^_init ran until the engine cut it off/)]);
  });

  it('is the check’s when it is not about a function at all, and the preview’s for a handler that throws', async () => {
    const { taken } = await heardDuring((fn) => fn === '_init', [
      ['[SoftN] Parse error at line 3:1:', 'Unexpected token'],
      ['Warning: something React said'],
      ['[SoftN] Error executing function save:', new TypeError('x is undefined')],
      ['[SoftN] Error executing function _init:', new TypeError('x is undefined')],
    ]);
    expect(taken).toEqual([false, false, true, false]);
  });

  it('is everyone’s again once the check is over', async () => {
    const heard: unknown[][] = [];
    const stop = listenToConsoleErrors((args) => heard.push(args));
    await duringCheck(() => true, async () => {});
    const quiet = console.error;
    console.error(...budget('_init'));
    expect(console.error).toBe(quiet);
    stop();
    expect(heard).toHaveLength(1);
  });
});

describe('the agent, told about a loop that never ends', () => {
  it('reads one sentence from the check when _init never returns, not the engine’s two', async () => {
    const report = await browserEnvironment.checkApp(vfs(project(logic(INIT_LOOP))), { blueprint: null });
    expect(report.ok).toBe(false);
    expect(report.errors).toEqual([
      'ui/main.ui (render): _init ran until the engine cut it off (script exceeded its instruction budget), which is what an endless loop or a function that calls itself without end does. The app’s logic stopped there: nothing in it runs again until it is restarted.',
    ]);
  }, 30_000);

  // Page logic runs timers now, and a callback that throws is reported on its own line: the check
  // is to hand it to the model as an error of the app, with what the callback threw.
  it('is told of a timer callback that throws, as an error of the app', async () => {
    const failing = '\nfunction _init() {\n  setTimeout(() => {\n    let missing = null\n    count = missing.length\n  }, 30)\n}\n';
    const report = await browserEnvironment.checkApp(vfs(project(logic(failing))), { blueprint: null });
    expect(report.ok).toBe(false);
    expect(report.errors).toEqual([expect.stringMatching(/^ui\/main\.ui \(render\): \[SoftN\] A timer callback in the logic failed: TypeError: Cannot read properties of null \(reading 'length'\)/)]);
  }, 30_000);

  // run_app_function reads the state when the call returns and then stops the app, so a timer the
  // call set never fires there: "State did not change" read as a timer that does nothing.
  it('is told by run_app_function that a timer the call set was not waited for', async () => {
    const later = '\nfunction later() {\n  setTimeout(() => {\n    count = 5\n  }, 0)\n}\n';
    const result = await runAppFunction(vfs(project(logic(later))), { name: 'later' });
    expect(result.text).toMatch(/^later\(\) returned undefined\nState did not change\.\nTimers are not waited for here:/);
    expect(result.text).toMatch(/call what the callback does as a function of its own/);
    // A page whose logic sets no timer is told nothing of them.
    expect((await runAppFunction(vfs(project(logic())), { name: 'add' })).text).not.toMatch(/Timers/);
  }, 30_000);

  it('is told that the function did not return when run_app_function meets one', async () => {
    const result = await runAppFunction(vfs(project(logic())), { name: 'spin' });
    expect(result.ok).toBe(false);
    expect(result.text.split('\n')[0]).toBe('spin() did not return: spin ran until the engine cut it off (script exceeded its instruction budget), which is what an endless loop or a function that calls itself without end does. The app’s logic stopped there: nothing in it runs again until it is restarted.');
    expect(result.text).not.toMatch(/returned undefined|engine is disposed/);
    // A function that ends is reported as it always was.
    const fine = await runAppFunction(vfs(project(logic())), { name: 'add' });
    expect(fine).toMatchObject({ ok: true });
    expect(fine.text).toMatch(/^add\(\) returned undefined\nState changed:\n {2}count: 0 → 1/);
  }, 30_000);

  it('is told at the start of its next run what the person’s preview reported, once', () => {
    useWorkspaceStore.getState().reset();
    useVFSStore.getState().reset();
    useWorkspaceStore.setState({ projectId: 'p1', projectName: 'Loop' });
    useVFSStore.getState().hydrateFiles(Object.entries(project(logic())).map(([path, content]) => ({ path, content })));
    expect(buildProjectContext('edit', takePreviewFaults('p1'))).not.toMatch(/preview/i);

    notePreviewFault('p1', { stopped: true, text: 'spin ran until the engine cut it off.' });
    notePreviewFault('p1', { stopped: true, text: '' });
    notePreviewFault('p1', { stopped: false, text: 'save failed: x is undefined' });
    notePreviewFault('p1', { stopped: false, text: 'save failed: x is undefined' });
    notePreviewFault('another-project', { stopped: false, text: 'not this project’s' });

    const context = buildProjectContext('edit', takePreviewFaults('p1'));
    expect(context).toContain('## What the app reported in the person’s preview since the last run\n- spin ran until the engine cut it off.\n- save failed: x is undefined\n');
    expect(context).not.toMatch(/not this project/);
    // Taken once: the run that was told has it in its conversation.
    expect(takePreviewFaults('p1')).toEqual([]);
  });
});

describe('the preview of an app whose logic has stopped', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useWorkspaceStore.getState().reset();
    useVFSStore.getState().reset();
    useWorkspaceStore.setState({ projectId: 'loop-project', projectName: 'Loop' });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    takePreviewFaults('loop-project');
  });

  const settle = async (ms = 400) => {
    for (let i = 0; i < ms / 20; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  };
  const button = (name: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
  const notice = () => container.querySelector<HTMLElement>('[data-preview-stopped]');

  it('says the app stopped and why, marks it stopped, logs it, and runs again after Restart', async () => {
    useVFSStore.getState().hydrateFiles(Object.entries(project(logic())).map(([path, content]) => ({ path, content })));
    await act(async () => { root.render(<VisualCanvas />); });
    await settle(1200);
    expect(container.textContent).toContain('Count: 0');
    expect(container.querySelector('.st-live')?.textContent).toBe('Running');
    expect(notice()).toBeNull();

    await act(async () => { button('Add one')!.click(); });
    await settle();
    expect(container.textContent).toContain('Count: 1');

    await act(async () => { button('Spin')!.click(); });
    await settle(1500);
    expect(notice()?.getAttribute('role')).toBe('alert');
    expect(notice()?.textContent).toContain('This app has stopped.');
    expect(notice()?.textContent).toContain('spin ran until the engine cut it off (script exceeded its instruction budget), which is what an endless loop');
    expect(container.querySelector('.st-live')).toBeNull();
    expect(container.querySelector('.st-preview-stopped')?.textContent).toBe('Stopped');
    expect(useWorkspaceStore.getState().consoleOutput.filter((line) => line.startsWith('[App] '))).toEqual([
      '[App] spin ran until the engine cut it off (script exceeded its instruction budget), which is what an endless loop or a function that calls itself without end does. The app’s logic stopped there: nothing in it runs again until it is restarted.',
    ]);

    // Restart: a fresh engine, the notice gone, and the app answers again from its first state.
    await act(async () => { [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Restart the preview')!.click(); });
    await settle(1200);
    expect(notice()).toBeNull();
    expect(container.querySelector('.st-live')?.textContent).toBe('Running');
    expect(container.textContent).toContain('Count: 0');
    await act(async () => { button('Add one')!.click(); });
    await settle();
    expect(container.textContent).toContain('Count: 1');
  }, 60_000);

  // A handler that throws is not a stop: the engine goes on, and so does the app. What it said
  // used to go to the browser's console alone; it is in Studio's log now, once, and kept for
  // the agent's next run, while the frame goes on saying Running, which is true.
  it('logs a handler that throws, once, and leaves the app running', async () => {
    const throwing = 'let count = 0\n\nfunction add() {\n  count = count + 1\n}\n\nfunction spin() {\n  let missing = null\n  count = missing.length\n}\n';
    useVFSStore.getState().hydrateFiles(Object.entries(project(throwing)).map(([path, content]) => ({ path, content })));
    await act(async () => { root.render(<VisualCanvas />); });
    await settle(1200);
    for (let i = 0; i < 3; i++) {
      await act(async () => { button('Spin')!.click(); });
      await settle(300);
    }
    expect(notice()).toBeNull();
    expect(container.querySelector('.st-live')?.textContent).toBe('Running');
    const logged = useWorkspaceStore.getState().consoleOutput.filter((line) => line.startsWith('[App] '));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^\[App\] spin failed: /);
    await act(async () => { button('Add one')!.click(); });
    await settle();
    expect(container.textContent).toContain('Count: 1');
    expect(takePreviewFaults('loop-project')).toEqual([logged[0].slice('[App] '.length)]);
  }, 60_000);

  it('logs a timer callback that throws, and tells the next run', async () => {
    const failing = logic('\nfunction _init() {\n  setTimeout(() => {\n    let missing = null\n    count = missing.length\n  }, 50)\n}\n');
    useVFSStore.getState().hydrateFiles(Object.entries(project(failing)).map(([path, content]) => ({ path, content })));
    await act(async () => { root.render(<VisualCanvas />); });
    await settle(1500);
    const logged = useWorkspaceStore.getState().consoleOutput.filter((line) => line.startsWith('[App] '));
    expect(logged).toEqual([expect.stringMatching(/^\[App\] A timer callback in the logic failed: .*reading 'length'/)]);
    expect(container.querySelector('.st-live')?.textContent).toBe('Running');
    expect(takePreviewFaults('loop-project')).toEqual([logged[0].slice('[App] '.length)]);
  }, 60_000);

  // The order things happen in when the agent writes a loop and the person then presses the
  // button: the write starts a check, which takes the console for as long as it renders, and
  // the preview takes up the changed file while that check is still going. The preview used
  // to put its own listener on the console and take it off again, and the two swaps crossed:
  // the check gave the console back to a listener the preview had already let go of, and the
  // preview heard nothing from then on.
  it('still hears the app after a check ran across a change of its files', async () => {
    useVFSStore.getState().hydrateFiles(Object.entries(project(logic().replace('while (true) {}', 'count = 0'))).map(([path, content]) => ({ path, content })));
    await act(async () => { root.render(<VisualCanvas />); });
    await settle(1200);
    expect(container.textContent).toContain('Count: 0');

    // The agent's write, and the check it starts; the preview follows the file while the check renders.
    await act(async () => { useVFSStore.getState().updateFile('logic/main.logic', logic(), 'ai'); });
    const check = browserEnvironment.checkApp(useVFSStore.getState().files, { blueprint: null });
    await settle(100);
    await act(async () => { useVFSStore.getState().updateFile('ui/main.ui', UI.replace('Add one', 'Add 1'), 'ai'); });
    await settle(100);
    expect((await check).errors).toEqual([]);
    await settle(1200);
    expect(notice()).toBeNull();

    await act(async () => { button('Spin')!.click(); });
    await settle(1500);
    expect(notice()?.textContent).toContain('spin ran until the engine cut it off');
    // And what the check rendered was never taken for the person's preview.
    expect(takePreviewFaults('loop-project').filter((line) => !line.startsWith('spin ran'))).toEqual([]);
  }, 60_000);

  // A check renders the app a second time, off the page, and collects what is printed while it
  // does. For that second or so the preview used to hear nothing: a button pressed in it then
  // stopped the app with "Running" still showing, and the check reported the person's loop as
  // an error in a page whose own render was fine. A check only ever runs the functions the
  // renderer runs by itself, so a line about any other function is the preview's.
  it('is heard when the app stops while a check is rendering, and the check does not take it for its own', async () => {
    useVFSStore.getState().hydrateFiles(Object.entries(project(logic())).map(([path, content]) => ({ path, content })));
    await act(async () => { root.render(<VisualCanvas />); });
    await settle(1200);

    const check = browserEnvironment.checkApp(useVFSStore.getState().files, { blueprint: null });
    await settle(60);
    await act(async () => { button('Spin')!.click(); });
    const report = await check;
    await settle(300);

    expect(report.errors).toEqual([]);
    expect(notice()?.textContent).toContain('spin ran until the engine cut it off');
    expect(container.querySelector('.st-preview-stopped')?.textContent).toBe('Stopped');
  }, 60_000);

  it('starts the app again by itself when the file that stopped it is changed', async () => {
    useVFSStore.getState().hydrateFiles(Object.entries(project(logic(INIT_LOOP))).map(([path, content]) => ({ path, content })));
    await act(async () => { root.render(<VisualCanvas />); });
    await settle(2000);
    expect(notice()?.textContent).toContain('_init ran until the engine cut it off');

    // The person (or the agent) takes the loop out: the preview is of the new file, and runs.
    await act(async () => { useVFSStore.getState().updateFile('logic/main.logic', logic(), 'user'); });
    await settle(1500);
    expect(notice()).toBeNull();
    expect(container.querySelector('.st-live')?.textContent).toBe('Running');
    await act(async () => { button('Add one')!.click(); });
    await settle();
    expect(container.textContent).toContain('Count: 1');
  }, 60_000);
});
