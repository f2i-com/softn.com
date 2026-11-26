// @vitest-environment jsdom
/**
 * Editing one field of a row in the database admin (SqliteDatabaseAdmin)
 * changes that field and nothing else.
 *
 * Save wrote every column back from the form's text. A BLOB arrives from the
 * engine as `{ "hex": "…" }`, which the form shows as that JSON, so changing
 * a row's label turned its picture into the text `{"hex":"…"}`; and an
 * integer past 2^53, which the form can only show rounded, was written back
 * rounded.
 *
 * Runs against the real XDB SQLite engine from @softn/container's build.
 */
import fs from 'node:fs';
import path from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedXdbBindings } from '@softn/container';

const xdb = vi.hoisted(() => ({ bindings: null as LoadedXdbBindings | null }));
vi.mock('@softn/container', () => ({ loadXdbWasm: async () => xdb.bindings }));

import { SqliteDatabaseAdmin } from '../src/SqliteDatabaseAdmin';
import { SqliteSession, type ProjectSqliteDatabase } from '../src/sqliteDatabase';

beforeAll(async () => {
  const engines = path.resolve(__dirname, '../../container/dist/runtime/engines');
  const module = await WebAssembly.compile(new Uint8Array(fs.readFileSync(path.join(engines, 'xdb-wasm.wasm'))));
  const glue = (await import(/* @vite-ignore */ path.join(engines, 'xdb-wasm.glue.js'))) as {
    initSync: (arg: { module: WebAssembly.Module }) => void;
    WasmConnection: LoadedXdbBindings['WasmConnection'];
  };
  glue.initSync({ module });
  xdb.bindings = { WasmConnection: glue.WasmConnection, module };
});

const SEED = `
  CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT, picture BLOB, big INTEGER);
  INSERT INTO items (label, picture, big) VALUES ('first', X'00ff10', 9007199254740993);
`;
const database: ProjectSqliteDatabase = { id: 'db:app:app.db', name: 'app', file: 'app.db', seedSqlPaths: ['seed.sql'], hasBinary: false, initialBytes: null, walBytes: null, journalBytes: null };

let host: HTMLDivElement;
let root: Root;

async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function openEditor(saved: Uint8Array[]): Promise<HTMLFormElement> {
  act(() =>
    root.render(
      <SqliteDatabaseAdmin
        host={{
          projectId: 'p1',
          databases: [database],
          readTextFile: (p) => (p === 'seed.sql' ? SEED : null),
          persistBytes: (_db, bytes) => { saved.push(bytes); },
          createDatabase: async () => database,
          notify: { success: () => {}, info: () => {}, error: () => {} },
        }}
      />,
    ),
  );
  await settle();
  const edit = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Edit');
  expect(edit).toBeDefined();
  act(() => edit!.click());
  return host.querySelector<HTMLFormElement>('form[aria-label="Edit row"]')!;
}

describe('editing a row', () => {
  it('writes nothing, and leaves the project alone, when nothing was changed', async () => {
    const saved: Uint8Array[] = [];
    const form = await openEditor(saved);
    const save = [...form.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Save changes')!;
    await act(async () => {
      save.click();
    });
    await settle(2);
    expect(saved).toEqual([]);
    expect(host.querySelector('form[aria-label="Edit row"]')).toBeNull();
  });

  it('writes back the field that changed, leaving a BLOB and a large integer as they were', async () => {
    const saved: Uint8Array[] = [];
    const form = await openEditor(saved);
    const inputs = [...form.querySelectorAll<HTMLInputElement>('input[type="text"]')];
    // id, label, picture, big — in column order.
    const label = inputs[1];
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setValue.call(label, 'renamed');
      label.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = [...form.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Save changes')!;
    await act(async () => {
      save.click();
    });
    await settle(2);
    expect(saved.length).toBeGreaterThan(0);

    const reopened = await SqliteSession.open(
      { ...database, hasBinary: true, initialBytes: saved[saved.length - 1], seedSqlPaths: [] },
      () => null,
      { bindings: xdb.bindings! },
    );
    try {
      expect(reopened.exec('SELECT label, typeof(picture), hex(picture), big = 9007199254740993 FROM items').rows).toEqual([
        ['renamed', 'blob', '00FF10', 1],
      ]);
    } finally {
      reopened.close();
    }
  });
});
