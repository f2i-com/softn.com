/** @vitest-environment jsdom */
/**
 * A parser warning is a warning here too.
 *
 * The parser's diagnostics were all errors until it gained one that is not:
 * two `<data>` blocks on a page that give one name to different collections
 * (the first keeps the name, the second is left out and said). Everything in
 * Studio that reads diagnostics was written when "a diagnostic" meant "the
 * page is broken", so this pins what each of them does with a warning: the
 * validator and the export do not refuse the bundle, the check passes and
 * hands the agent the warning to read, and the name check still looks at the
 * page.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerAllBuiltins } from '@softn/components';
import { configureZippWasmSource, parse } from '@softn/core';
import { browserEnvironment, formatCheckReport, templateNameErrors } from '../src/lib/agent/appCheck';
import { buildBundle } from '../src/lib/exportBundle';
import { validateProject } from '../src/lib/validator';
import type { VFSFile } from '../src/types/studio';

beforeAll(() => {
  configureZippWasmSource(readFileSync(resolve(process.cwd(), '../../packages/@softn/core/wasm-zipp/zipp_wasm_bg.wasm')));
  registerAllBuiltins();
});

const vfs = (entries: Record<string, string>) =>
  new Map<string, VFSFile>(Object.entries(entries).map(([path, content]) => [path, { path, content, mimeType: 'text/plain', lastModified: 0, lastModifiedBy: 'user', version: 1 }]));

const PAGE = `<data>
  <collection name="tasks" as="items" />
</data>

<data>
  <collection name="notes" as="items" />
</data>

<App>
  #each (item in items) key={item.id}
    <Text>{item.data.title}</Text>
  #end
</App>
`;
const FILES = vfs({
  'manifest.json': JSON.stringify({ name: 'Two blocks', version: '1.0.0', main: 'ui/main.ui', icon: 'assets/icon.svg', files: { ui: ['ui/main.ui'], xdb: ['xdb/tasks.xdb', 'xdb/notes.xdb'], assets: ['assets/icon.svg'] } }),
  'permission.json': '{"permissions":{}}',
  'assets/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" /></svg>',
  'ui/main.ui': PAGE,
  'xdb/tasks.xdb': JSON.stringify({ collection: 'tasks', records: [{ id: '1', title: 'A task' }] }),
  'xdb/notes.xdb': JSON.stringify({ collection: 'notes', records: [{ id: '1', title: 'A note' }] }),
});

describe('a page the parser warns about', () => {
  it('is the case this is about: one diagnostic, and it is a warning', () => {
    const diagnostics = parse(PAGE).diagnostics ?? [];
    expect(diagnostics.map((d) => d.severity)).toEqual(['warning']);
    expect(diagnostics[0].message).toMatch(/is not declared, because this page already reads "tasks" as items/);
  });

  it('is not refused by the validator or the export', () => {
    expect(validateProject(FILES, null).filter((problem) => problem.level === 'error')).toEqual([]);
    expect(buildBundle(FILES).length).toBeGreaterThan(0);
  });

  it('passes the check, which hands the agent the warning with its line', async () => {
    const report = await browserEnvironment.checkApp(FILES, { blueprint: null });
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.rendered).toContain('A task');
    const warning = report.warnings.find((line) => /already reads "tasks" as items/.test(line));
    expect(warning).toMatch(/^ui\/main\.ui: Parse warning at line 6:\d+: <collection name="notes" as="items"> is not declared/);
    expect(formatCheckReport(report)).toMatch(/^Check passed for ui\/main\.ui/);
    expect(formatCheckReport(report)).toContain('Warnings:\n- ');
  }, 30_000);

  it('still has its names checked: a warning does not make the page one the check gives up on', async () => {
    const withTypo = vfs({ ...Object.fromEntries([...FILES].map(([path, file]) => [path, file.content as string])), 'ui/main.ui': PAGE.replace('{item.data.title}', '{item.data.title} {nothingDefinesThis}') });
    const { errors } = await templateNameErrors(withTypo, 'ui/main.ui');
    expect(errors.join('\n')).toMatch(/ui\/main\.ui line 11: nothingDefinesThis is read here but nothing defines it/);
  }, 30_000);
});
