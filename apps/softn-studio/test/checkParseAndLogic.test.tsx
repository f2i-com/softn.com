/** @vitest-environment jsdom */
/**
 * Studio's check reads the pages with core's parser and asks the engine
 * whether the logic compiles, and says where, file and line.
 *
 * It did neither. A page missing its `</Card>`, or `function broken( {` left
 * at the end of main.js, left the status bar at "No problems", Run and
 * Publish enabled, and the preview saying "Running" over a panel titled
 * "Parse Error" that named no file.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { configureZippWasmSource } from '@softn/core';
import { generateBlueprintFromBrief, scaffoldProjectFiles } from '../src/lib/studioProject';
import { validateProject } from '../src/lib/validator';
import { logicSyntaxProblems } from '../src/lib/logicCheck';
import { PreviewError } from '../src/components/canvas/PreviewError';
import { placeParseLine, previewBrokenBy } from '../src/components/canvas/VisualCanvas';
import { useProjectActions, type ProjectActions } from '../src/components/common/ProjectActions';
import { useVFSStore, useWorkspaceStore } from '../src/stores';
import { EXAMPLES } from '../src/examples';
import type { ProjectBrief, ValidationError, VFSFile } from '../src/types/studio';

configureZippWasmSource(readFileSync(resolve(process.cwd(), '../../packages/@softn/core/wasm-zipp/zipp_wasm_bg.wasm')));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const vfs = (list: Array<{ path: string; content: string }>) =>
  new Map<string, VFSFile>(list.map((f) => [f.path, { path: f.path, content: f.content, mimeType: 'text/plain', lastModified: 0, lastModifiedBy: 'user', version: 1 }]));

/** A new project as the wizard makes it: index.html, pages/home.html, main.js or main.py, one collection. */
function scaffold(logicLanguage: 'javascript' | 'python' = 'javascript'): Map<string, VFSFile> {
  const brief = { appName: 'Tea Log', description: 'Teas tasted.', target: 'web', style: 'clean', pages: ['Home'], collections: ['Teas'], authNeeded: false, logicLanguage } as unknown as ProjectBrief;
  return vfs(scaffoldProjectFiles(brief, generateBlueprintFromBrief(brief)));
}

function edit(files: Map<string, VFSFile>, path: string, change: (text: string) => string): Map<string, VFSFile> {
  const file = files.get(path)!;
  const next = new Map(files);
  next.set(path, { ...file, content: change(file.content as string) });
  return next;
}

const lineOf = (text: string, needle: string) => text.slice(0, text.indexOf(needle)).split('\n').length;
const ofType = (problems: ValidationError[], type: string) => problems.filter((p) => p.type === type);

describe('the check parses every page', () => {
  it('reports a page that does not parse as an error, at its own file and line', () => {
    const broken = edit(scaffold(), 'pages/home.html', (t) => t.replace('</Card>', ''));
    const errors = ofType(validateProject(broken, null), 'page-parse').filter((p) => p.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ file: 'pages/home.html', line: 4, level: 'error' });
    expect(errors[0].message).toMatch(/Mismatched tags: expected <\/Card>, got <\/Stack>/);
  });

  it('reports an error in an imported page against that page, not the page that imports it', () => {
    const broken = edit(scaffold(), 'pages/home.html', (t) => t.replace('</Card>', ''));
    expect(ofType(validateProject(broken, null), 'page-parse').map((p) => p.file)).toEqual(['pages/home.html']);
  });

  it('finds nothing to say of a new project, in either language, or of the bundled examples', () => {
    for (const files of [scaffold('javascript'), scaffold('python'), ...EXAMPLES.map((example) => vfs(example.files))]) {
      expect(ofType(validateProject(files, null), 'page-parse')).toEqual([]);
    }
  });
});

describe('the check asks the engine whether the logic compiles', () => {
  it('finds nothing wrong with logic that compiles, in either language and in the examples', async () => {
    for (const files of [scaffold('javascript'), scaffold('python'), ...EXAMPLES.map((example) => vfs(example.files))]) {
      expect(await logicSyntaxProblems(files)).toEqual([]);
    }
  });

  it('places a JavaScript function left open at the end of main.js, at main.js and its line', async () => {
    const files = edit(scaffold(), 'main.js', (t) => `${t}\nfunction broken( {\n`);
    const text = files.get('main.js')!.content as string;
    const problems = await logicSyntaxProblems(files);
    expect(problems).toEqual([expect.objectContaining({ file: 'main.js', line: lineOf(text, 'function broken'), level: 'error', type: 'logic-syntax' })]);
    expect(problems[0].message).toMatch(/does not compile/);
    expect(problems[0].message).toMatch(/still open/);
  });

  it('places a JavaScript line that does not compile at that line', async () => {
    const files = edit(scaffold(), 'main.js', (t) => t.replace('function go(id) {', 'let total = = 2\nfunction go(id) {'));
    const text = files.get('main.js')!.content as string;
    const problems = await logicSyntaxProblems(files);
    expect(problems).toEqual([expect.objectContaining({ file: 'main.js', line: lineOf(text, 'let total = = 2'), type: 'logic-syntax' })]);
    expect(problems[0].message).toContain('let total = = 2');
  });

  it('places a Python syntax error at the module and line Python names', async () => {
    const files = edit(scaffold('python'), 'main.py', (t) => `${t}\ndef broken(:\n`);
    const text = files.get('main.py')!.content as string;
    const problems = await logicSyntaxProblems(files);
    expect(problems).toEqual([expect.objectContaining({ file: 'main.py', line: lineOf(text, 'def broken'), type: 'logic-syntax' })]);
  });

  it('places an error in a page’s own <logic> block at the page’s line', async () => {
    const page = '<logic>\nlet count = 0\nfunction add( {\n</logic>\n\n<Stack>\n  <Text>{count}</Text>\n</Stack>\n';
    const files = vfs([
      { path: 'manifest.json', content: JSON.stringify({ name: 'Inline', version: '1.0.0', main: 'index.html' }) },
      { path: 'index.html', content: page },
    ]);
    const problems = await logicSyntaxProblems(files);
    expect(problems).toEqual([expect.objectContaining({ file: 'index.html', line: 3, type: 'logic-syntax' })]);
  });

  it('leaves nothing in storage when the logic writes to it as it loads, as it does on every save', async () => {
    const files = edit(scaffold(), 'main.js', (t) => `${t}\nlocalStorage.setItem('visits', '1')\n`);
    const before = localStorage.length;
    expect(await logicSyntaxProblems(files)).toEqual([]);
    expect(await logicSyntaxProblems(edit(files, 'main.js', (t) => `${t}\nfunction broken( {\n`))).toHaveLength(1);
    expect(localStorage.length).toBe(before);
  });

  it('places an error in a project of the older layout, ui/*.ui with logic/*.logic', async () => {
    const logic = 'let count = 0\n\nfunction add() {\n  count = count + 1\n}\n\nfunction broken( {\n';
    const files = vfs([
      { path: 'manifest.json', content: JSON.stringify({ name: 'Old', version: '1.0.0', main: 'ui/main.ui', files: { ui: ['ui/main.ui'], logic: ['logic/main.logic'] } }) },
      { path: 'ui/main.ui', content: '<logic src="../logic/main.logic" />\n\n<Stack>\n  <Button @click={add}>{count}</Button>\n</Stack>\n' },
      { path: 'logic/main.logic', content: logic },
    ]);
    const problems = await logicSyntaxProblems(files);
    expect(problems).toEqual([expect.objectContaining({ file: 'logic/main.logic', line: 7, type: 'logic-syntax' })]);
  });
});

describe('what the check finds holds the app back', () => {
  let root: Root | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    useWorkspaceStore.getState().reset();
    useVFSStore.getState().reset();
  });

  function actions(): ProjectActions {
    let seen: ProjectActions | null = null;
    const Probe = () => {
      seen = useProjectActions();
      return null;
    };
    const host = document.createElement('div');
    root = createRoot(host);
    act(() => root!.render(<Probe />));
    return seen!;
  }

  it('makes Run and Publish wait on a page that does not parse or logic that does not compile, and not on a warning', () => {
    const files = scaffold();
    useVFSStore.setState({ files });
    for (const type of ['page-parse', 'logic-syntax']) {
      useWorkspaceStore.getState().setErrors([{ file: 'pages/home.html', line: 4, level: 'error', type, message: 'x' }]);
      const held = actions();
      expect(held.canRun, type).toBe(false);
      expect(held.canPublish, type).toBe(false);
      expect(held.canExport, type).toBe(true);
      expect(held.describe('runtime', 'Run')).toMatch(/Fix the error/);
      act(() => root?.unmount());
    }
    useWorkspaceStore.getState().setErrors([{ file: 'pages/home.html', line: 4, level: 'warning', type: 'page-parse', message: 'x' }]);
    expect(actions().canRun).toBe(true);
  });

  it('does not call the preview running over a page that does not parse, or logic that does not compile', () => {
    const files = scaffold();
    const parse: ValidationError = { file: 'pages/home.html', line: 4, level: 'error', type: 'page-parse', message: 'x' };
    const logic: ValidationError = { file: 'main.js', line: 15, level: 'error', type: 'logic-syntax', message: 'x' };
    // The home page is placed in index.html: either page shows the error.
    expect(previewBrokenBy([parse], files, 'index.html')).toBe(parse);
    expect(previewBrokenBy([parse], files, 'pages/home.html')).toBe(parse);
    expect(previewBrokenBy([logic], files, 'pages/home.html')).toBe(logic);
    expect(previewBrokenBy([{ ...parse, level: 'warning' }], files, 'index.html')).toBeNull();
  });

  it('logs a parse line of the composed page at the line of the file it is in', () => {
    const files = edit(scaffold(), 'pages/home.html', (t) => t.replace('</Card>', ''));
    const placed = placeParseLine('Parse error at line 13:4: Mismatched tags: expected </Card>, got </Stack>', files, 'index.html');
    expect(placed).toMatch(/^pages\/home\.html, line 4: /);
    expect(placeParseLine('Parse error at line 4:4: Mismatched tags: expected </Card>, got </Stack>', files, 'pages/home.html')).toBe(placed);
  });
});

describe('the preview’s panel for an app it could not draw', () => {
  it('is titled by what went wrong, and says where', () => {
    const host = document.createElement('div');
    const panel = createRoot(host);
    const logic: ValidationError = { file: 'main.js', line: 15, level: 'error', type: 'logic-syntax', message: 'The logic does not compile: expected a property name' };
    act(() => panel.render(<PreviewError error={new Error('SyntaxError: expected a property name, at the end of the logic: …')} problems={[logic]} page="index.html" />));
    expect(host.querySelector('h3')?.textContent).toMatch(/The logic does not compile/);
    expect(host.textContent).toContain('main.js:15');
    act(() => panel.render(<PreviewError error={new Error('_init failed: boom')} problems={[logic]} page="index.html" />));
    expect(host.querySelector('h3')?.textContent).toMatch(/stopped with an error/);
    expect(host.textContent).not.toContain('Parse Error');
    act(() => panel.unmount());
  });
});
