/** @vitest-environment jsdom */
/**
 * What a check's logic stores is its own, and gone when the check is.
 *
 * The check loads a page's logic, and the logic's top level runs as it
 * loads. The save check loaded every project under one fixed id, and so into
 * one database, the browser's own and kept for good: one project's records
 * were there when another's logic was checked. The agent's checks used a
 * fresh id each, and each left a database behind in Studio's storage.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { configureZippWasmSource } from '@softn/core';
import { logicSyntaxProblems } from '../src/lib/logicCheck';
import { runAppFunction, templateNameErrors } from '../src/lib/agent/appCheck';
import type { VFSFile } from '../src/types/studio';

beforeAll(() => {
  configureZippWasmSource(readFileSync(resolve(process.cwd(), '../../packages/@softn/core/wasm-zipp/zipp_wasm_bg.wasm')));
});

const MANIFEST = JSON.stringify({ name: 'Notes', version: '1.0.0', main: 'ui/main.ui', files: { ui: ['ui/main.ui'], logic: ['logic/main.logic'] } });
const UI = `<logic src="../logic/main.logic" />

<App theme="light">
  <Text>{seen}</Text>
</App>
`;
// Writes a record as it loads, and says how many it found there first.
const LOGIC = (secret: string) => `let seen = db.query("notes").length
db.create("notes", { secret: "${secret}" })

function count() {
  return db.query("notes").length
}
`;

const project = (secret: string) =>
  new Map<string, VFSFile>(
    Object.entries({ 'manifest.json': MANIFEST, 'ui/main.ui': UI, 'logic/main.logic': LOGIC(secret) }).map(([path, content]) => [
      path,
      { path, content, mimeType: 'text/plain', lastModified: 0, lastModifiedBy: 'user', version: 1 },
    ]),
  );

const stored = () => Object.keys(localStorage).sort();

beforeEach(() => localStorage.clear());

describe("a check's storage", () => {
  it('is gone after the save check, so the next project checked starts with nothing', async () => {
    expect(await logicSyntaxProblems(project('from A'))).toEqual([]);
    expect(stored()).toEqual([]);
    expect(await logicSyntaxProblems(project('from B'))).toEqual([]);
    expect(stored()).toEqual([]);
  }, 30_000);

  it("is gone after the agent's checks, and a run sees only what its own logic wrote", async () => {
    expect((await templateNameErrors(project('from A'), 'ui/main.ui')).errors).toEqual([]);
    expect(stored()).toEqual([]);
    const run = await runAppFunction(project('from B'), { name: 'count' });
    expect(run).toMatchObject({ ok: true });
    expect(run.text).toMatch(/^count\(\) returned 1\n/);
    expect(stored()).toEqual([]);
  }, 30_000);
});
