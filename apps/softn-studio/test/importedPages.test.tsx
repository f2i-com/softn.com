/** @vitest-environment jsdom */
/**
 * An imported page is not a component, and the check says so where it matters.
 *
 * `<import Row from="./row.ui" />` then `<Row />` places that file's markup
 * where the tag is, in the importing page's scope. Attributes and children
 * written on the tag are dropped, there are no props, no events and no
 * `$emit`, and the file has no scope of its own. A model that writes
 * `<Row item={todo} @done={…} />` gets a page that composes, renders and
 * passes nothing, with no error anywhere: so the check names each such use,
 * with its line and what to do instead. And the check follows an import
 * written with either spelling of `from`, as the composer does: it read only
 * `from="…"`, so a page imported the other way was placed and never checked.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerAllBuiltins } from '@softn/components';
import { configureZippWasmSource } from '@softn/core';
import { browserEnvironment, lintTemplates, templateNameErrors } from '../src/lib/agent/appCheck';
import { buildGuide } from '../src/lib/agent/guide';
import type { VFSFile } from '../src/types/studio';

beforeAll(() => {
  configureZippWasmSource(readFileSync(resolve(process.cwd(), '../../packages/@softn/core/wasm-zipp/zipp_wasm_bg.wasm')));
  registerAllBuiltins();
});

const vfs = (entries: Record<string, string>) =>
  new Map<string, VFSFile>(Object.entries(entries).map(([path, content]) => [path, { path, content, mimeType: 'text/plain', lastModified: 0, lastModifiedBy: 'user', version: 1 }]));

const MANIFEST = JSON.stringify({ name: 'Tasks', version: '1.0.0', main: 'ui/main.ui', files: { ui: ['ui/main.ui', 'ui/row.ui'], logic: ['logic/main.logic'] } });
const LOGIC = 'let tasks = [{ id: "1", title: "Buy milk" }]\nlet editingId = ""\nlet draft = ""\n\nfunction rename(id) {\n  editingId = id\n}\n\nfunction save(id) {\n  tasks = tasks.map((t) => (t.id === id ? { id: t.id, title: draft } : t))\n  editingId = ""\n}\n';
const ROW = '<Card>\n  <Text>{task.title}</Text>\n</Card>\n';

const project = (main: string, row = ROW, extra: Record<string, string> = {}) =>
  vfs({ 'manifest.json': MANIFEST, 'ui/main.ui': main, 'ui/row.ui': row, 'logic/main.logic': LOGIC, ...extra });

const page = (importLine: string, use: string) =>
  `${importLine}\n<logic src="../logic/main.logic" />\n\n<App>\n  #each (task in tasks)\n    ${use}\n  #end\n</App>\n`;

describe('a page imported into another', () => {
  it('is followed by the check whichever way its import spells from', async () => {
    const broken = '<Card>\n  <Text>{task.title} {nothingDefinesThis}</Text>\n</Card>\n';
    for (const importLine of ['<import Row from="./row.ui" />', '<import Row from "./row.ui" />', "<import Row from = './row.ui' />"]) {
      const { errors } = await templateNameErrors(project(page(importLine, '<Row />'), broken), 'ui/main.ui');
      expect(errors.join('\n'), importLine).toMatch(/ui\/row\.ui line 2: .*nothingDefinesThis/);
      expect(errors.join('\n'), importLine).not.toMatch(/Row/);
    }
  }, 30_000);

  it('is warned about where it is used with attributes: they are ignored, and what to do instead', () => {
    const files = project(page('<import Row from="./row.ui" />', '<Row item={task} class:done={task.done} @rename={(id) => rename(id)} />'));
    const { errors, warnings } = lintTemplates(files);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([
      'ui/main.ui line 6: <Row> is an imported page (ui/row.ui), not a component, so the attributes written on it (item, class:done, @rename) are ignored: an imported page has no props and no events. It is placed here as written, in this page\'s scope: it reads this page\'s state, calls its functions and sees a loop\'s variable by the same names. Remove the attributes, and keep state that belongs to one use (which row is being edited) in the page\'s logic.',
    ]);
  });

  it('is warned about where it is given children, with either spelling of the import, and not where it is used plainly', () => {
    const withChildren = project(page('<import Row from "./row.ui" />', '<Row>\n      <Text>Extra</Text>\n    </Row>'));
    expect(lintTemplates(withChildren).warnings).toEqual([
      expect.stringMatching(/^ui\/main\.ui line 6: <Row> is an imported page \(ui\/row\.ui\), not a component, so the content written inside it is ignored: an imported page has no slot\./),
    ]);
    // A plain use, in either form, is what the language means; and a real component keeps its props.
    expect(lintTemplates(project(page('<import Row from="./row.ui" />', '<Row />'))).warnings).toEqual([]);
    expect(lintTemplates(project(page('<import Row from="./row.ui" />', '<Row></Row>'))).warnings).toEqual([]);
    expect(lintTemplates(project(page('<import Row from="./row.ui" />', '<Row />\n    <Card title={task.title}><Text>In a card</Text></Card>'))).warnings).toEqual([]);
  });

  it('is told that $emit does not exist, in markup, in inline logic, and in a logic file of either language', () => {
    const files = project(
      page('<import Row from="./row.ui" />', '<Row />'),
      '<Card>\n  <Button @click={() => $emit("rename", task.id)}>Rename</Button>\n</Card>\n\n<logic>\nfunction done(id) {\n  $emit("done", id)\n}\n</logic>\n',
      { 'logic/helpers.logic': 'function tell(id) {\n  $emit("told", id)\n}\n', 'logic/main.py': 'def tell(task_id):\n    softn.$emit("told", task_id)\n' },
    );
    const said = lintTemplates(files).warnings.filter((w) => w.includes('$emit'));
    expect(said.map((w) => w.split(':')[0]).sort()).toEqual(['logic/helpers.logic line 2', 'logic/main.py line 2', 'ui/row.ui line 2', 'ui/row.ui line 7']);
    expect(said[0]).toMatch(/\$emit does not exist in SoftN: an imported page has no events to send\. It is placed in the page's scope, so call the page's function, or set its state, directly\./);
    // A name that merely contains it is not it.
    expect(lintTemplates(project(page('<import Row from="./row.ui" />', '<Row />'), ROW, { 'logic/helpers.logic': 'function my$emit() {}\nmy$emit()\n' })).warnings).toEqual([]);
  });
});

describe('what the guide teaches about importing a page', () => {
  /** The guide's fenced blocks in a language. */
  const blocks = (guide: string, language: string) => [...guide.matchAll(/```(\w+)\n([\s\S]*?)```/g)].filter((m) => m[1] === language).map((m) => m[2]);

  it('states the model, and nothing of props, events or slots on an imported page', () => {
    for (const python of [false, true]) {
      const guide = buildGuide({ python, torch: false, style: 'clean' });
      const reuse = guide.slice(guide.indexOf('### Reuse'), guide.indexOf('### Assets'));
      expect(reuse).toMatch(/not a component/);
      expect(reuse).toMatch(/in this page's scope/);
      expect(reuse).toMatch(/Attributes and children written on the tag are dropped/);
      expect(reuse).toMatch(/no props, no events and no `\$emit`/);
      expect(reuse).toMatch(/no scope of its own/);
      expect(reuse).toMatch(/`editingId`/);
      expect(reuse).not.toMatch(/<component>|<prop>|<slot>/);
    }
  });

  it('gives an example that the check itself accepts, with no warning', async () => {
    const guide = buildGuide({ python: false, torch: false, style: 'clean' });
    const [main, row] = blocks(guide.slice(guide.indexOf('### Reuse'), guide.indexOf('### Assets')), 'softn');
    expect(main).toContain('<import TaskRow from="./task-row.html" />');
    expect(row).toContain('editingId === task.id');
    const files = vfs({
      'manifest.json': JSON.stringify({ name: 'Tasks', version: '1.0.0', description: 'Tasks to do.', main: 'index.html', icon: 'assets/icon.svg', files: { ui: ['index.html', 'task-row.html'], logic: ['main.js'], assets: ['assets/icon.svg'] } }),
      'permission.json': JSON.stringify({ permissions: {} }),
      'assets/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" /></svg>',
      'index.html': main,
      'task-row.html': row,
      'main.js': LOGIC,
    });
    expect(lintTemplates(files)).toEqual({ errors: [], warnings: [] });
    const report = await browserEnvironment.checkApp(files, { blueprint: null });
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.rendered).toContain('Buy milk');
    expect(document.querySelector('[data-softn-agent-check]')).toBeNull();
  }, 30_000);
});
