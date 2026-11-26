/** @vitest-environment jsdom */
/**
 * Round 4 review of sqlite_execute's seed dump (Round 3 made it write only a project .sql file
 * outside builder/): a migration the app's host has already run is not rewritten by any of the
 * agent's write tools (lib/agent/appliedMigrations.ts), and the seed dump is one of them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LoadedXdbBindings } from '@softn/container';
import { useVFSStore, useWorkspaceStore } from '../src/stores';
import { executeTool, type ToolContext } from '../src/lib/agent/executeTool';
import { forgetAppliedMigrations, rememberAppliedMigrations } from '../src/lib/agent/appliedMigrations';

let xdbBindings: LoadedXdbBindings;

async function loadTestXdbBindings(): Promise<LoadedXdbBindings> {
  const enginesDir = path.resolve(__dirname, '../../../packages/@softn/container/dist/runtime/engines');
  const wasmBytes = fs.readFileSync(path.join(enginesDir, 'xdb-wasm.wasm'));
  const module = await WebAssembly.compile(new Uint8Array(wasmBytes));
  // @ts-expect-error -- runtime glue asset has no bundled .d.ts
  const glue = (await import('../../../packages/@softn/container/dist/runtime/engines/xdb-wasm.glue.js')) as {
    initSync: (arg: { module: WebAssembly.Module }) => void;
    WasmConnection: LoadedXdbBindings['WasmConnection'];
  };
  glue.initSync({ module });
  return { WasmConnection: glue.WasmConnection, module };
}

function makeCtx(): ToolContext {
  let tx = 0;
  return {
    seen: new Map(),
    blueprint: null,
    sqliteBindings: xdbBindings,
    newTransactionId: () => `tx-${++tx}`,
    env: {
      checkApp: async () => ({ ok: true, errors: [], warnings: [], renderedHeadless: true, page: 'index.html' }),
      inspectPreview: async () => ({ ok: true, text: 'ok' }),
      runFunction: async () => ({ ok: true, text: 'ok' }),
    },
  };
}

beforeEach(async () => {
  useVFSStore.getState().reset();
  useWorkspaceStore.getState().reset();
  forgetAppliedMigrations();
  if (!xdbBindings) xdbBindings = await loadTestXdbBindings();
});

afterEach(() => forgetAppliedMigrations());

const MIGRATION = 'CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL);\n';

function openInstalledApp(): void {
  useVFSStore.getState().openFiles([
    {
      path: 'manifest.json',
      content: JSON.stringify(
        { name: 'Tasks', version: '1.0.0', main: 'index.html', server: { entry: 'server/main.logic', database: { migrations: ['server/migrations/001_init.sql'] } } },
        null,
        2,
      ),
    },
    { path: 'index.html', content: '<!doctype html><h1>Tasks</h1>' },
    { path: 'server/main.logic', content: 'export function list() { return []; }\n' },
    { path: 'server/migrations/001_init.sql', content: MIGRATION },
  ]);
  // What a hosted editor does when the host opens an installed app (App.tsx).
  rememberAppliedMigrations(useVFSStore.getState().files);
}

describe('sqlite_execute in an app whose host has run its migrations', () => {
  it('does not write the seed dump over a migration that has run, and runs nothing', async () => {
    openInstalledApp();
    const before = new Map(useVFSStore.getState().files);
    const res = await executeTool(
      { id: 'x', name: 'sqlite_execute', input: { sql: 'CREATE TABLE notes (id INTEGER PRIMARY KEY)', sync_seed_sql: true, seed_sql_path: 'server/migrations/001_init.sql' } },
      makeCtx(),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain('server/migrations/001_init.sql');
    expect(res.content).toMatch(/already run/);
    expect(useVFSStore.getState().files).toEqual(before);
    expect(useVFSStore.getState().readFile('server/migrations/001_init.sql')).toBe(MIGRATION);
  });

  it('still writes the seed dump to a .sql file that is not a migration', async () => {
    openInstalledApp();
    const res = await executeTool(
      { id: 'x', name: 'sqlite_execute', input: { sql: 'CREATE TABLE notes (id INTEGER PRIMARY KEY)', sync_seed_sql: true, seed_sql_path: 'backend/schema.sql' } },
      makeCtx(),
    );
    expect(res.isError).toBe(false);
    expect(useVFSStore.getState().readFile('backend/schema.sql')).toMatch(/CREATE TABLE/i);
    expect(useVFSStore.getState().readFile('server/migrations/001_init.sql')).toBe(MIGRATION);
  });
});
