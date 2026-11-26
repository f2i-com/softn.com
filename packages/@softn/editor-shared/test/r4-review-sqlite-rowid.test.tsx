// @vitest-environment jsdom
/**
 * Audit round 4: Browse's Edit and Delete find a row by its rowid, and a
 * rowid past 2^53 is the row it names.
 *
 * The engine answers in JSON with every digit, and `JSON.parse` rounds an
 * integer past 2^53 to the nearest double: 9007199254740993 was read as
 * 9007199254740992. That is another row's rowid in a table keyed by such
 * numbers (an INTEGER PRIMARY KEY holding ids made elsewhere, as 64-bit ids
 * from a service are), so Save changed, and Delete removed, the other row.
 * Regression tests: both failed on 0e839a1f.
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

// Two ids a double cannot tell apart.
const SEED = `
  CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT);
  INSERT INTO items (id, label) VALUES (9007199254740992, 'lower'), (9007199254740993, 'upper');
`;
const database: ProjectSqliteDatabase = { id: 'db:app:app.db', name: 'app', file: 'app.db', seedSqlPaths: ['seed.sql'], hasBinary: false, initialBytes: null, walBytes: null, journalBytes: null };

/** What the table holds, each row as whether its id is the upper one, and its label. */
const contents = (session: SqliteSession): unknown[][] => session.exec('SELECT id = 9007199254740993, label FROM items ORDER BY id').rows;

describe('a row whose rowid is past 2^53', () => {
  it('is the one Delete removes', async () => {
    const session = await SqliteSession.open(database, () => SEED, { bindings: xdb.bindings! });
    try {
      const upper = session.browseTable('items').rows.find((row) => row.values[1] === 'upper')!;
      session.deleteRow('items', { rowid: upper.rowid });
      expect(contents(session)).toEqual([[0, 'lower']]);
    } finally {
      session.close();
    }
  });

  it('keeps an ordinary rowid a number (guard)', async () => {
    const session = await SqliteSession.open(database, () => "CREATE TABLE t (label TEXT); INSERT INTO t VALUES ('only');", { bindings: xdb.bindings! });
    try {
      expect(session.browseTable('t').rows).toEqual([{ rowid: 1, values: ['only'] }]);
    } finally {
      session.close();
    }
  });
});

describe('editing a row whose rowid is past 2^53 in the database admin', () => {
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
    vi.spyOn(console, 'error').mockImplementation(() => {});
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it('saves the change into that row, and leaves the other alone', async () => {
    const saved: Uint8Array[] = [];
    act(() =>
      root.render(
        <SqliteDatabaseAdmin
          host={{
            projectId: 'p1',
            databases: [database],
            readTextFile: (p) => (p === 'seed.sql' ? SEED : null),
            persistBytes: (_db, bytes) => {
              saved.push(bytes);
            },
            createDatabase: async () => database,
            notify: { success: () => {}, info: () => {}, error: () => {} },
          }}
        />
      )
    );
    await settle();
    // Rows are browsed in rowid order: "lower", then "upper".
    const edits = [...host.querySelectorAll<HTMLButtonElement>('button')].filter((b) => b.textContent === 'Edit');
    expect(edits).toHaveLength(2);
    act(() => edits[1].click());
    const form = host.querySelector<HTMLFormElement>('form[aria-label="Edit row"]')!;
    const label = [...form.querySelectorAll<HTMLInputElement>('input[type="text"]')][1];
    expect(label.value).toBe('upper');
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
      { bindings: xdb.bindings! }
    );
    try {
      expect(contents(reopened)).toEqual([
        [0, 'lower'],
        [1, 'renamed'],
      ]);
    } finally {
      reopened.close();
    }
  });
});
