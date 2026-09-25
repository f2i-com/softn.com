/** @vitest-environment jsdom */
/**
 * What the agent learns by running the app, with the real renderer and the
 * real engines: check_app renders the main page off-screen and reports what
 * failed; inspect_preview describes what it shows; run_app_function calls a
 * logic function in a fresh runtime and reports the state it changed — in
 * JavaScript and in Python.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { registerAllBuiltins } from '@softn/components';
import { configureZippWasmSource } from '@softn/core';
import { browserEnvironment, formatCheckReport } from '../src/lib/agent/appCheck';
import type { VFSFile } from '../src/types/studio';
import { APP } from './helpers/agentHarness';

beforeAll(() => {
  configureZippWasmSource(readFileSync(resolve(process.cwd(), '../../packages/@softn/core/wasm-zipp/zipp_wasm_bg.wasm')));
  registerAllBuiltins();
});

afterEach(() => {
  // Nothing the checks render may be left in the document.
  expect(document.querySelector('[data-softn-agent-check]')).toBeNull();
});

const vfs = (entries: Record<string, string>) =>
  new Map<string, VFSFile>(Object.entries(entries).map(([path, content]) => [path, { path, content, mimeType: 'text/plain', lastModified: 0, lastModifiedBy: 'user', version: 1 }]));

const app = (ui = APP.ui, logic = APP.logic) => vfs({ 'manifest.json': APP.manifest, 'ui/main.ui': ui, 'logic/main.logic': logic });

describe('check_app', () => {
  it('passes a working app, having rendered it', async () => {
    const report = await browserEnvironment.checkApp(app(), { blueprint: null });
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.renderedHeadless).toBe(true);
    expect(report.rendered).toContain('Tasks');
    expect(formatCheckReport(report)).toMatch(/^Check passed for ui\/main\.ui \(composed and rendered\)/);
  }, 20_000);

  it('reports template syntax the parser could not read, with its line', async () => {
    const report = await browserEnvironment.checkApp(app(APP.ui.replace('<Button @click={() => add()}>', '<Button @click={x => add()}>')), { blueprint: null });
    expect(report.ok).toBe(false);
    expect(report.errors.join('\n')).toMatch(/Parse error at line \d+/);
  }, 20_000);

  it('catches the handler that parses but never runs, and a one-way text field', async () => {
    const report = await browserEnvironment.checkApp(app(APP.ui.replace('<Button @click={() => add()}>', '<Input :value={count} />\n    <Button @click={() => { add() }}>')), { blueprint: null });
    expect(report.ok).toBe(false);
    expect(report.errors.join('\n')).toMatch(/ui\/main\.ui line 8: @click has a block-bodied arrow/);
    expect(report.warnings.join('\n')).toMatch(/ui\/main\.ui line 7: <Input :value=\{…\}> is one-way/);
  }, 20_000);

  it('reports a parse error in an imported page against that page and its own line, not the composed main page', async () => {
    // From a real run: home.ui's `new Date()` was reported as "ui/main.ui ... line 17", a line of
    // the composed source in neither file, and the model spent a step editing the wrong file.
    const files = vfs({
      'manifest.json': JSON.stringify({ name: 'Habits', version: '1.0.0', main: 'ui/main.ui', files: { ui: ['ui/main.ui', 'ui/pages/home.ui'], logic: ['logic/main.logic'] } }),
      'logic/main.logic': 'let count = 0',
      'ui/main.ui': '<import HomePage from="./pages/home.ui" />\n\n<logic src="../logic/main.logic" />\n\n<App>\n  <Heading level={1}>Habits</Heading>\n  <HomePage />\n</App>',
      'ui/pages/home.ui': '<Stack>\n  <Heading level={2}>Today</Heading>\n  <Text>{new Date().getDay()}</Text>\n</Stack>',
    });
    const report = await browserEnvironment.checkApp(files, { blueprint: null });
    expect(report.ok).toBe(false);
    const parse = report.errors.filter((e) => /Parse error/.test(e));
    expect(parse.length).toBeGreaterThan(0);
    expect(parse.every((e) => e.startsWith('ui/pages/home.ui: Parse error at line 3:'))).toBe(true);
  }, 20_000);

  it('reports a logic error thrown while the app loads', async () => {
    const report = await browserEnvironment.checkApp(app(APP.ui, 'let count = 0\nfunction _init() {\n  count = missing.value\n}\nfunction add() {}'), { blueprint: null });
    expect(report.ok).toBe(false);
    expect(report.errors.join('\n')).toMatch(/missing/);
  }, 20_000);

  it('reports a composer refusal without rendering', async () => {
    const report = await browserEnvironment.checkApp(app(APP.ui.replace('main.logic', 'gone.logic')), { blueprint: null });
    expect(report.ok).toBe(false);
    expect(report.renderedHeadless).toBe(false);
    expect(report.errors.join('\n')).toContain('logic/gone.logic is referenced by ui/main.ui but is not in the bundle');
  });
});

describe('inspect_preview', () => {
  it('describes headings, text and controls like an accessibility tree', async () => {
    const result = await browserEnvironment.inspectPreview(
      vfs({
        'manifest.json': APP.manifest,
        'logic/main.logic': 'let name = "Ada"\nlet agreed = true',
        'ui/main.ui': '<logic src="../logic/main.logic" />\n<App>\n  <Heading level={2}>Profile</Heading>\n  <Text>Signed in as {name}</Text>\n  <Input :bind={name} placeholder="Your name" />\n  <Checkbox :bind={agreed} label="Agree" />\n  <Button disabled>Save</Button>\n</App>',
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.text).toContain('heading 2: Profile');
    expect(result.text).toContain('Signed in as Ada');
    expect(result.text).toMatch(/textbox \(text\) "Your name" value="Ada"/);
    expect(result.text).toMatch(/checkbox ".*" checked/);
    expect(result.text).toContain('button "Save" (disabled)');
  }, 20_000);
});

describe('run_app_function', () => {
  it('calls a JavaScript function after setup calls and reports what it changed', async () => {
    const files = vfs({
      'manifest.json': APP.manifest,
      'ui/main.ui': '<logic src="../logic/main.logic" />\n<App><Text>{tasks.length}</Text></App>',
      'logic/main.logic': 'let tasks = []\nlet draft = ""\nfunction add() {\n  tasks = tasks.concat([{ title: draft }])\n  draft = ""\n  return tasks.length\n}',
    });
    const result = await browserEnvironment.runFunction(files, { name: 'add', setup_calls: [{ set: 'draft', value: 'Milk' }] });
    expect(result.ok).toBe(true);
    expect(result.text).toContain('set draft = "Milk"');
    expect(result.text).toContain('add() returned 1');
    expect(result.text).toContain('tasks: 0 → 1 items; added {"title":"Milk"}');
    expect(result.text).toContain('draft: "Milk" → ""');
  }, 20_000);

  it('takes a state assignment written as a call to "set", and says how to set state when a setup call is not a function', async () => {
    // From a real run: the model wrote the assignment as { name: "set", ... } three times, was told
    // only that set is not a function, and the run stopped on the repeated failure.
    const logic = 'let tasks = []\nlet draft = ""\nfunction add() {\n  tasks = tasks.concat([{ title: draft }])\n  draft = ""\n  return tasks.length\n}';
    const files = vfs({ 'manifest.json': APP.manifest, 'ui/main.ui': '<logic src="../logic/main.logic" />\n<App><Text>{tasks.length}</Text></App>', 'logic/main.logic': logic });
    const shapes = [{ name: 'set', args: ['draft', 'Milk'] }, { name: 'set', args: [{ draft: 'Milk' }] }, { name: 'set', state: 'draft', value: 'Milk' }, { set: { draft: 'Milk' } }];
    for (const setup of shapes) {
      const result = await browserEnvironment.runFunction(files, { name: 'add', setup_calls: [setup] });
      expect(result.ok, JSON.stringify(setup)).toBe(true);
      expect(result.text).toContain('set draft = "Milk"');
      expect(result.text).toContain('tasks: 0 → 1 items; added {"title":"Milk"}');
    }
    const wrong = await browserEnvironment.runFunction(files, { name: 'add', setup_calls: [{ name: 'prepare' }] });
    expect(wrong.ok).toBe(false);
    expect(wrong.text).toContain('Setup call prepare is not a function of the app. Functions: add. To set a state variable first, pass { "set": "stateName", "value": ... }');
    // An app with its own function called set keeps it.
    const own = vfs({ 'manifest.json': APP.manifest, 'ui/main.ui': '<logic src="../logic/main.logic" />\n<App><Text>{n}</Text></App>', 'logic/main.logic': 'let n = 0\nfunction set(v) {\n  n = v\n}\nfunction twice() {\n  n = n * 2\n}' });
    const kept = await browserEnvironment.runFunction(own, { name: 'twice', setup_calls: [{ name: 'set', args: [4] }] });
    expect(kept.text).toContain('set(4)');
    expect(kept.text).toContain('n: 4 → 8');
  }, 20_000);

  it('names the functions there are when asked for one that is not', async () => {
    const result = await browserEnvironment.runFunction(app(), { name: 'nope' });
    expect(result.ok).toBe(false);
    expect(result.text).toContain('nope is not a function of the app. Functions: add');
  }, 20_000);

  it('runs a Python function on the Python engine', async () => {
    const files = vfs({
      'manifest.json': JSON.stringify({ name: 'Py', version: '1.0.0', main: 'ui/main.ui', files: { ui: ['ui/main.ui'], logic: ['logic/main.py'] } }),
      'ui/main.ui': '<logic src="../logic/main.py" />\n<App><Text>{count}</Text></App>',
      'logic/main.py': 'count = 0\n\n\ndef bump(by):\n    global count\n    count = count + by\n    return count\n',
    });
    const result = await browserEnvironment.runFunction(files, { name: 'bump', args: [3] });
    expect(result.text).toContain('bump(3) returned 3');
    expect(result.text).toContain('count: 0 → 3');
  }, 40_000);
});
