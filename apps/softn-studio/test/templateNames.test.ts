/**
 * check_app reports the names the markup uses that nothing defines — the
 * mistake that renders an empty, inert page without a word. The markup is
 * read with core's parser, the names come from the logic as the real runtime
 * loads it (JavaScript and Python), and the built-ins are the evaluator's own.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import * as core from '@softn/core';
import { browserEnvironment, formatCheckReport, templateNameErrors } from '../src/lib/agent/appCheck';
import { editDistance, nearestName, TEMPLATE_GLOBALS } from '../src/lib/agent/templateNames';
import type { VFSFile } from '../src/types/studio';
import { APP } from './helpers/agentHarness';

beforeAll(() => {
  core.configureZippWasmSource(readFileSync(resolve(process.cwd(), '../../packages/@softn/core/wasm-zipp/zipp_wasm_bg.wasm')));
});

const vfs = (entries: Record<string, string>) =>
  new Map<string, VFSFile>(Object.entries(entries).map(([path, content]) => [path, { path, content, mimeType: 'text/plain', lastModified: 0, lastModifiedBy: 'user', version: 1 }]));

const LOGIC = 'let count = 0\nlet query = ""\nlet items = [{ title: "a", done: false }]\n$: total = items.length\n\nfunction add() {\n  count = count + 1\n}\n\nfunction saveItem(item) {\n  items = items.concat([item])\n}';

const page = (body: string, extra: Record<string, string> = {}, logic = LOGIC, head = '') =>
  vfs({ 'manifest.json': APP.manifest, 'ui/main.ui': `<logic src="../logic/main.logic" />\n${head}\n<App>\n${body}\n</App>`, 'logic/main.logic': logic, ...extra });

describe('undefined names in the markup', () => {
  it('reports a handler that calls a function the logic does not define, with its line and the nearest name', async () => {
    const { errors } = await templateNameErrors(page('  <Button @click={save}>Save</Button>\n  <Button @click={() => save(count)}>Again</Button>\n  <Button @click={() => add()}>Add</Button>'), 'ui/main.ui');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^ui\/main\.ui line 4 \(also line 5\): @click calls save, which the logic does not define — so it does nothing when it fires\. Did you mean saveItem\? The logic's functions: add, saveItem\./);
  });

  it('reports :bind to a name that is not state, and to a computed value', async () => {
    const { errors } = await templateNameErrors(page('  <Input :bind={qurey} />\n  <Input :bind={total} />\n  <Input :bind={query} />'), 'ui/main.ui');
    expect(errors.join('\n')).toMatch(/ui\/main\.ui line 4: :bind=\{qurey\} — qurey is not state, so the field has no value to show and typing into it is lost\. Did you mean query\? Declare it in the logic \(let qurey = …\)/);
    expect(errors.join('\n')).toMatch(/ui\/main\.ui line 5: :bind=\{total\} — total is a computed value, which cannot be written/);
    expect(errors).toHaveLength(2);
  });

  it('reports reads of names nothing defines, and a call to one in the markup', async () => {
    const { errors } = await templateNameErrors(
      page('  <Text>{pages.length} pages</Text>\n  #each (day in weekData)\n    <Text>{day.label}</Text>\n  #end\n  <Chart data={probeBars(itemz)} />\n  <Text>{cout}</Text>'),
      'ui/main.ui',
    );
    const text = errors.join('\n');
    expect(text).toMatch(/ui\/main\.ui line 4: pages is read here but nothing defines it — not the logic's state, functions or computed values, a <data> alias, nor a loop variable in scope — so it renders empty\. Define it in the logic \(let pages = …\)\./);
    expect(text).toMatch(/ui\/main\.ui line 5: weekData is read here/);
    expect(text).toMatch(/ui\/main\.ui line 8: \{probeBars\(…\)\} calls probeBars\(\), which the logic does not define — so it renders nothing\./);
    expect(text).toMatch(/line 8: itemz is read here .* Did you mean items\?/);
    expect(text).toMatch(/line 9: cout is read here .* Did you mean count\?/);
    expect(text).not.toMatch(/\bday\b/);
    expect(errors).toHaveLength(5);
  });

  it('does not flag loop variables, indexes, arrow parameters, <data> aliases, seeded collections or template assignments', async () => {
    const { errors, warnings } = await templateNameErrors(
      page(
        [
          '  #each (item, i in items)',
          '    <Checkbox :bind={item.done} label={`${i + 1}. ${item.title}`} />',
          '    <Button @click={() => saveItem(item)}>Save</Button>',
          '  #empty',
          '    <Text>Nothing</Text>',
          '  #end',
          '  <Card each={rows} as="row" if={row.data.done}>{row.data.title}</Card>',
          '  <Input @keydown={(e) => e.key === "Enter" && add()} />',
          '  <Text>{notes.length}</Text>',
          '  <Button @click={() => tab = "b"}>B</Button>',
          '  <Text>{tab === "b" ? "B" : "A"}</Text>',
          '  <Table data={items.map((row) => ({ title: row.title, n: total }))} />',
        ].join('\n'),
        { 'data/notes.xdb': JSON.stringify({ collection: 'notes', records: [{ id: '1', text: 'x' }] }) },
        LOGIC,
        '<data><collection name="tasks" as="rows" /></data>',
      ),
      'ui/main.ui',
    );
    // Only the assignment to a name the logic never declared is worth saying — as a warning, since it works once clicked.
    expect(errors).toEqual([]);
    expect(warnings).toEqual([expect.stringMatching(/^ui\/main\.ui line 13: @click assigns tab, which the logic does not declare: it has no value until the handler runs\./)]);
  });

  it('does not flag what the template evaluator provides, and says which globals it does not', async () => {
    const { errors } = await templateNameErrors(
      page(
        [
          '  <Text>{Math.round(count / 2)} {JSON.stringify(items)} {String(count)} {Number("1")} {Boolean(1)} {Array.isArray(items)}</Text>',
          '  <Text>{Date.now()} {parseInt("2")} {parseFloat("2.5")} {isNaN(count)} {isFinite(count)} {NaN} {Infinity}</Text>',
          '  <Text>{encodeURIComponent(query)} {decodeURIComponent(query)} {formatDate(count)} {currency(count)} {truncate(query, 3)}</Text>',
          '  <Image src={asset("assets/logo.png")} />',
          '  <Button @click={() => xdb_create("tasks", { title: query })}>Add</Button>',
          '  <Text>{true} {false} {null} {count} {map(items, (i) => i.title)}</Text>',
          '  <Text>{Object.keys(items[0]).length}</Text>',
        ].join('\n'),
      ),
      'ui/main.ui',
    );
    expect(errors).toEqual([expect.stringMatching(/^ui\/main\.ui line 10: Object is not available in templates, so it is undefined there \(templates have Number, String, Boolean, Array, Date, Math, JSON/)]);
  });

  it('checks an imported component in its own file, with its declared props, and not the props its tag was given', async () => {
    const files = page('  <Header title={pageTitle} subtitle={nope}>\n    <Text>{alsoDropped}</Text>\n  </Header>\n  <Text>{count}</Text>', {
      'ui/header.ui': '<component name="Header">\n  <prop name="title" type="string" />\n</component>\n\n<Stack>\n  <Heading level={1}>{title}</Heading>\n  <Text>{userName}</Text>\n</Stack>',
    });
    files.set('ui/main.ui', { ...files.get('ui/main.ui')!, content: `<import Header from="./header.ui" />\n${String(files.get('ui/main.ui')!.content)}` });
    const { errors } = await templateNameErrors(files, 'ui/main.ui');
    expect(errors).toEqual([expect.stringMatching(/^ui\/header\.ui line 7: userName is read here but nothing defines it/)]);
  });

  it('keeps line numbers true past template comments', async () => {
    const { errors } = await templateNameErrors(page('  // a comment\n\n\n  // another\n  <Text>{missing}</Text>'), 'ui/main.ui');
    expect(errors).toEqual([expect.stringMatching(/^ui\/main\.ui line 8: missing is read here/)]);
  });

  it('says nothing when the logic does not load (the render reports that), and flags everything on a page with no logic', async () => {
    expect((await templateNameErrors(page('  <Text>{nothing}</Text>', {}, 'let = ='), 'ui/main.ui')).errors).toEqual([]);
    const bare = vfs({ 'manifest.json': JSON.stringify({ name: 'X', version: '1.0.0', main: 'ui/main.ui', files: { ui: ['ui/main.ui'] } }), 'ui/main.ui': '<App>\n  <Text>{total}</Text>\n</App>' });
    expect((await templateNameErrors(bare, 'ui/main.ui')).errors).toEqual([expect.stringMatching(/^ui\/main\.ui line 2: total is read here/)]);
  });

  it('checks a Python app against the names its module defines', async () => {
    const files = vfs({
      'manifest.json': JSON.stringify({ name: 'Py', version: '1.0.0', main: 'ui/main.ui', files: { ui: ['ui/main.ui'], logic: ['logic/main.py'] } }),
      'ui/main.ui': '<logic src="../logic/main.py" />\n<App>\n  <Text>{count} {labl}</Text>\n  <Button @click={() => bump(1)}>Bump</Button>\n  <Button @click={() => reset_all()}>Reset</Button>\n  <Input :bind={name} />\n</App>',
      'logic/main.py': 'count = 0\nlabel = "Count"\nname = ""\n\n\ndef bump(by):\n    global count\n    count = count + by\n\n\ndef reset():\n    global count\n    count = 0\n',
    });
    const { errors } = await templateNameErrors(files, 'ui/main.ui');
    expect(errors.join('\n')).toMatch(/ui\/main\.ui line 3: labl is read here .* Did you mean label\? Define it in the logic \(labl = …\)/);
    expect(errors.join('\n')).toMatch(/ui\/main\.ui line 5: @click calls reset_all\(\), which the logic does not define .* The logic's functions: bump, reset\./);
    expect(errors).toHaveLength(2);
  }, 40_000);

  it('is part of check_app: the report fails and names each one', async () => {
    const report = await browserEnvironment.checkApp(page('  <Text>{pages.length} pages</Text>\n  <Button @click={() => save()}>Save</Button>'), { blueprint: null });
    expect(report.ok).toBe(false);
    const text = formatCheckReport(report);
    expect(text).toContain('Check found 2 error(s) in ui/main.ui:');
    expect(text).toContain('- ui/main.ui line 4: pages is read here but nothing defines it');
    expect(text).toContain('- ui/main.ui line 5: @click calls save(), which the logic does not define');
  });
});

describe('the lists the check trusts', () => {
  it('names exactly the globals the real template evaluator resolves', () => {
    const context = { state: {}, data: {}, computed: {}, props: {}, functions: {}, setState: () => {} } as never;
    const resolves = (name: string) => core.evaluateExpression({ type: 'Identifier', name, loc: { line: 1, column: 1, start: 0, end: 0 } } as never, context) !== undefined;
    for (const name of TEMPLATE_GLOBALS.filter((n) => n !== 'undefined')) expect(resolves(name), name).toBe(true);
    for (const name of ['Object', 'console', 'window', 'Set', 'Map', 'Promise', 'Intl', 'globalThis']) expect(resolves(name), name).toBe(false);
    // And no global the source adds is missing here.
    const source = readFileSync(resolve(process.cwd(), '../../packages/@softn/core/src/renderer/render.tsx'), 'utf8');
    const block = /const JS_GLOBALS[^{]*\{([\s\S]*?)\};/.exec(source)?.[1] ?? '';
    expect(block.split(',').map((s) => s.trim()).filter(Boolean).sort()).toEqual([...TEMPLATE_GLOBALS].sort());
  });

  it('suggests a close name, and nothing for a far one', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(nearestName('weekdata', ['weekData', 'week'])).toBe('weekData');
    expect(nearestName('probeBars', ['count', 'items'])).toBeNull();
    expect(nearestName('pages', ['page', 'pagesList'])).toBe('page');
  });
});
