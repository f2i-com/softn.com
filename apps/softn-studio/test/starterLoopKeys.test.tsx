/** @vitest-environment jsdom */
/**
 * The pages Studio writes itself give their loops a key.
 *
 * The guide teaches the agent `#each (task in tasks) key={task.id}` and says
 * that without one "the page warns when it renders". The scaffold a brief
 * becomes, and both bundled examples, looped over their pages and their
 * records without one. So every new app printed "[SoftN] Each block without
 * key expression detected" on every render, and the agent was handed that
 * warning after every check of a project it had not yet touched: the first
 * pages it reads showed it the thing its guide tells it not to write.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerAllBuiltins } from '@softn/components';
import { configureZippWasmSource } from '@softn/core';
import { EXAMPLES } from '../src/examples';
import { browserEnvironment } from '../src/lib/agent/appCheck';
import { generateBlueprintFromBrief, scaffoldProjectFiles } from '../src/lib/studioProject';
import type { ProjectBrief, VFSFile } from '../src/types/studio';

beforeAll(() => {
  configureZippWasmSource(readFileSync(resolve(process.cwd(), '../../packages/@softn/core/wasm-zipp/zipp_wasm_bg.wasm')));
  registerAllBuiltins();
});

const vfs = (entries: Array<{ path: string; content: string }>) =>
  new Map<string, VFSFile>(entries.map(({ path, content }) => [path, { path, content, mimeType: 'text/plain', lastModified: 0, lastModifiedBy: 'user', version: 1 }]));

const brief = (over: Partial<ProjectBrief> = {}): ProjectBrief => ({
  appName: 'Field Notes',
  description: 'Notes from the field, by site.',
  target: 'web',
  pages: ['Home', 'Sites', 'About'],
  collections: ['Notes', 'Sites'],
  authNeeded: false,
  style: 'clean',
  referenceImages: [],
  logicLanguage: 'javascript',
  ...over,
});

/** Every `#each` header in the project's pages. */
const loops = (files: Map<string, VFSFile>) =>
  [...files].flatMap(([path, file]) =>
    path.endsWith('.ui') && typeof file.content === 'string'
      ? file.content.split('\n').filter((line) => /^\s*#each\b/.test(line)).map((line) => `${path}: ${line.trim()}`)
      : [],
  );

describe('the loops in the pages Studio writes', () => {
  it('have a key in the scaffold of a brief with several pages and collections, in either language', () => {
    for (const logicLanguage of ['javascript', 'python'] as const) {
      const b = brief({ logicLanguage });
      const found = loops(vfs(scaffoldProjectFiles(b, generateBlueprintFromBrief(b))));
      // The row of page buttons, and one list for each collection.
      expect(found).toHaveLength(3);
      for (const loop of found) expect(loop, logicLanguage).toMatch(/#each \(item in \w+\) key=\{item\.id\}$/);
    }
  });

  it('have a key in both bundled examples', () => {
    for (const example of EXAMPLES) {
      const found = loops(vfs(example.files));
      expect(found.length, example.id).toBeGreaterThan(0);
      for (const loop of found) expect(loop, example.id).toMatch(/ key=\{item\.id\}$/);
    }
  });

  it('leave the check of a new app with no warning about a loop without a key', async () => {
    const b = brief();
    const report = await browserEnvironment.checkApp(vfs(scaffoldProjectFiles(b, generateBlueprintFromBrief(b))), { blueprint: null });
    expect(report.errors).toEqual([]);
    expect(report.renderedHeadless).toBe(true);
    // The records are drawn: the key did not empty the list.
    expect(report.rendered).toMatch(/Sample title/);
    expect(report.warnings.join('\n')).not.toMatch(/without key/i);
  }, 30_000);

  it('leave the check of the bundled example with no warning about a loop without a key', async () => {
    const example = EXAMPLES.find((e) => e.id === 'reading-list')!;
    const report = await browserEnvironment.checkApp(vfs(example.files), { blueprint: null });
    expect(report.errors).toEqual([]);
    expect(report.rendered).toMatch(/Piranesi/);
    expect(report.warnings.join('\n')).not.toMatch(/without key/i);
  }, 30_000);
});
