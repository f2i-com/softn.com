// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { LoadedXdbBindings } from '@softn/container';
import { useProjectStore } from '../stores/projectStore';
import { useFilesStore } from '../stores/filesStore';
import { useCanvasStore } from '../stores/canvasStore';
import { useSchemaStore } from '../stores/schemaStore';
import {
  clearBuilderWorkspace,
  clearStoredSession,
  QUARANTINE_STORAGE_KEY,
  SESSION_STORAGE_KEY,
  startupAction,
} from './openProject';
import { SESSION_ASSETS_KEY } from './storedAssets';
import {
  SqliteSession,
  createProjectSqliteDatabase,
  detectProjectSqliteDatabases,
  persistSqliteBytesToProject,
  splitSqlStatements,
} from './sqliteDatabase';

let xdbBindings: LoadedXdbBindings;

async function loadTestXdbBindings(): Promise<LoadedXdbBindings> {
  const enginesDir = path.resolve(__dirname, '../../../../packages/@softn/container/dist/runtime/engines');
  const wasmBytes = fs.readFileSync(path.join(enginesDir, 'xdb-wasm.wasm'));
  const module = await WebAssembly.compile(new Uint8Array(wasmBytes));
  // @ts-expect-error -- runtime glue asset has no bundled .d.ts
  const glue = (await import('../../../../packages/@softn/container/dist/runtime/engines/xdb-wasm.glue.js')) as {
    initSync: (arg: { module: WebAssembly.Module }) => void;
    WasmConnection: LoadedXdbBindings['WasmConnection'];
  };
  glue.initSync({ module });
  return { WasmConnection: glue.WasmConnection, module };
}

beforeEach(async () => {
  window.localStorage.clear();
  useProjectStore.getState().reset();
  useFilesStore.getState().reset();
  useCanvasStore.getState().reset();
  useSchemaStore.getState().reset();
  if (!xdbBindings) {
    xdbBindings = await loadTestXdbBindings();
  }
});

describe('Builder clear session & workspace reset', () => {
  it('clears all stored session/quarantine keys so startup does not prompt or restore deleted work', () => {
    window.localStorage.setItem(SESSION_STORAGE_KEY, '{"savedAt":"2026-11-21"}');
    window.localStorage.setItem(SESSION_ASSETS_KEY, '{"entries":{}}');
    window.localStorage.setItem(QUARANTINE_STORAGE_KEY, '{"raw":"bad"}');
    window.localStorage.setItem('softn.builder.session.owner.v1', '{"tab":"t1"}');

    useProjectStore.getState().setName('Dirty Draft');
    expect(useProjectStore.getState().isDirty).toBe(true);

    clearBuilderWorkspace();

    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(SESSION_ASSETS_KEY)).toBeNull();
    expect(window.localStorage.getItem(QUARANTINE_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem('softn.builder.session.owner.v1')).toBeNull();
    expect(useProjectStore.getState().isDirty).toBe(false);
    expect(useProjectStore.getState().name).toBe('Untitled App');

    const nextStart = startupAction(
      new URL('http://localhost/builder/') as unknown as Location,
      { replaceState: () => undefined, state: null } as unknown as History,
      window.localStorage.getItem(SESSION_STORAGE_KEY)
    );
    expect(nextStart.kind).toBe('nothing');
  });

  it('clearStoredSession leaves nothing behind for recovery', () => {
    window.localStorage.setItem(SESSION_STORAGE_KEY, '{"a":1}');
    clearStoredSession();
    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });
});

describe('SQL script statement splitter', () => {
  it('splits multi-statement SQL while preserving strings, comments, and triggers', () => {
    const script = `
      -- Leading comment; not a split
      CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT DEFAULT 'a;b');
      /* block; comment */
      CREATE TRIGGER items_audit AFTER INSERT ON items BEGIN
        INSERT INTO logs(msg) VALUES ('added;ok');
      END;
      INSERT INTO items(label) VALUES ('hello;world');
    `;
    const stmts = splitSqlStatements(script);
    expect(stmts).toHaveLength(3);
    expect(stmts[0]).toContain("DEFAULT 'a;b'");
    expect(stmts[1]).toContain('CREATE TRIGGER items_audit');
    expect(stmts[2]).toContain("'hello;world'");
  });
});

describe('XDB SQLite database detection, schema editing, CRUD & bundle persistence', () => {
  it('detects manifest.databases, hydrates seedSql, runs full schema + CRUD ops, and persists .db bytes', async () => {
    const seedSql = `
      CREATE TABLE menu_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        price REAL NOT NULL DEFAULT 0,
        notes TEXT
      );
      INSERT INTO menu_items (name, price, notes) VALUES ('Flat White', 4.8, 'Oat option');
      INSERT INTO menu_items (name, price, notes) VALUES ('Espresso', 3.5, NULL);
    `;
    const logicFiles = new Map([
      ['sql_1', { id: 'sql_1', path: 'backend/migrations/001_init.sql', content: seedSql }],
    ]);
    const manifest = {
      engine: 2,
      name: 'BrewDesk',
      version: '1.0.0',
      main: 'index.html',
      databases: [
        { name: 'brewdesk', engine: 'sqlite', file: 'brewdesk.db', seedSql: 'backend/migrations/001_init.sql' },
      ],
    };
    useProjectStore.getState().setSource({
      ...useProjectStore.getState().source,
      manifest,
      extraEntries: new Map(),
    });

    const dbs = detectProjectSqliteDatabases(useProjectStore.getState().source, logicFiles, new Map());
    expect(dbs).toHaveLength(1);
    expect(dbs[0].name).toBe('brewdesk');
    expect(dbs[0].file).toBe('brewdesk.db');
    expect(dbs[0].hasBinary).toBe(false);

    const session = await SqliteSession.openDatabase(dbs[0], logicFiles, new Map(), { bindings: xdbBindings });
    try {
      // Introspect tables & browse
      const tables = session.listTables();
      expect(tables.map((t) => [t.name, t.rowCount])).toEqual([['menu_items', 2]]);

      const page1 = session.browseTable('menu_items', { search: 'Flat', sortBy: 'price', sortDir: 'DESC' });
      expect(page1.totalRows).toBe(1);
      expect(page1.rows[0].values[1]).toBe('Flat White');

      // CRUD: Insert, Update (including NULL), Delete
      const ins = session.insertRow('menu_items', { name: 'Matcha Latte', price: 5.5, notes: 'Ceremonial' });
      expect(ins.changes).toBe(1);

      const allRows = session.browseTable('menu_items');
      expect(allRows.totalRows).toBe(3);
      const matcha = allRows.rows.find((r) => r.values[1] === 'Matcha Latte')!;
      expect(matcha).toBeDefined();

      session.updateRow('menu_items', { rowid: matcha.rowid }, { price: 6.0, notes: null });
      const afterUpdate = session.browseTable('menu_items', { search: 'Matcha' });
      expect(afterUpdate.rows[0].values[2]).toBe(6);
      expect(afterUpdate.rows[0].values[3]).toBeNull();

      const espresso = allRows.rows.find((r) => r.values[1] === 'Espresso')!;
      session.deleteRow('menu_items', { rowid: espresso.rowid });
      expect(session.browseTable('menu_items').totalRows).toBe(2);

      // Schema manipulation: add column, rename column, index, create new table, drop column
      session.addColumn('menu_items', { name: 'sku', type: 'TEXT', notNull: true, defaultValue: 'TBD' });
      session.renameColumn('menu_items', 'sku', 'item_code');
      session.createIndex('menu_items', 'idx_menu_code', ['item_code'], false);

      let struct = session.getTableStructure('menu_items');
      expect(struct.columns.map((c) => c.name)).toContain('item_code');
      expect(struct.indexes.some((i) => i.name === 'idx_menu_code')).toBe(true);

      session.dropIndex('idx_menu_code');
      session.dropColumn('menu_items', 'notes');
      struct = session.getTableStructure('menu_items');
      expect(struct.columns.map((c) => c.name)).not.toContain('notes');

      session.createTable('orders', [
        { name: 'id', type: 'INTEGER', primaryKey: true, autoIncrement: true, notNull: true },
        { name: 'customer', type: 'TEXT', notNull: true },
        { name: 'total', type: 'REAL', defaultValue: '0' },
      ]);
      session.insertRow('orders', { customer: 'Ada', total: 10.8 });

      const dump = session.exportSqlDump();
      expect(dump).toContain('CREATE TABLE');
      expect(dump).toContain('INSERT INTO "orders"');
      expect(dump).toContain("'Ada'");

      // Persist exported SQLite binary bytes back into projectStore and reopen from binary!
      const exportedBytes = session.exportBytes();
      persistSqliteBytesToProject(dbs[0], exportedBytes);
    } finally {
      session.close();
    }

    const updatedDbs = detectProjectSqliteDatabases(useProjectStore.getState().source, logicFiles, new Map());
    expect(updatedDbs[0].hasBinary).toBe(true);
    expect(updatedDbs[0].initialBytes!.byteLength).toBeGreaterThan(0);

    const reopened = await SqliteSession.openDatabase(
      updatedDbs[0],
      new Map(),
      useProjectStore.getState().source.extraEntries,
      { bindings: xdbBindings }
    );
    try {
      const tables = reopened.listTables();
      expect(tables.map((t) => t.name).sort()).toEqual(['menu_items', 'orders']);
      expect(reopened.browseTable('orders').rows[0].values[1]).toBe('Ada');
      expect(reopened.getTableStructure('menu_items').columns.map((c) => c.name)).toEqual([
        'id',
        'name',
        'price',
        'item_code',
      ]);
    } finally {
      reopened.close();
    }
  });

  it('can create a brand new SQLite database in an empty project', async () => {
    const db = await createProjectSqliteDatabase('Inventory', { bindings: xdbBindings });
    expect(db.name).toBe('inventory');
    expect(db.file).toBe('inventory.db');
    expect(useProjectStore.getState().source.extraEntries.has('inventory.db')).toBe(true);
    expect(useProjectStore.getState().isDirty).toBe(true);
  });
});
