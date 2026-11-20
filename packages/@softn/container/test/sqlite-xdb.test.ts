import { describe, it, expect, beforeEach } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadXdbWasm, XdbSqlManager, mountSoftNContainer } from '../src/index';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINES_DIR = path.join(PKG_ROOT, 'dist', 'runtime', 'engines');
const LITE_WASM = path.join(ENGINES_DIR, 'zipp-javascript-lite.wasm');
const XDB_WASM = path.join(ENGINES_DIR, 'xdb-wasm.wasm');
const XDB_GLUE = path.join(ENGINES_DIR, 'xdb-wasm.glue.js');

function flushAsync(ms = 40): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Embedded XDB SQLite WASM & Declarative JSON Seed Data', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('hydrates structured & shorthand JSON seed data, executes ALTER/subquery SQL, and round-trips .db bytes', async () => {
    const bindings = await loadXdbWasm({ explicitSource: XDB_WASM, glueUrl: XDB_GLUE });
    const manager = new XdbSqlManager({
      bindings,
      databases: [
        {
          name: 'app',
          engine: 'sqlite',
          file: 'app.db',
          seedJson: {
            mode: 'ignore',
            schema: [
              'CREATE TABLE IF NOT EXISTS sites (id INTEGER PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1)',
              'CREATE TABLE IF NOT EXISTS levels (id INTEGER PRIMARY KEY, code TEXT NOT NULL)',
              'CREATE TABLE IF NOT EXISTS locations (id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL, name TEXT NOT NULL, UNIQUE(site_id, name))',
            ],
            tables: {
              sites: [
                { id: 1, name: 'North Pit', active: 1 },
                { id: 2, name: 'South Pit', active: 0 },
              ],
              levels: [{ id: 10, code: 'L-100' }],
              locations: [{ id: 100, site_id: 1, name: 'Bench A' }],
            },
          },
          persist: true,
        },
      ],
    });

    manager.preseedConfiguredDatabases();

    // 1. Verify structured seed rows
    const opened = manager.open('app.db');
    expect('id' in opened).toBe(true);
    const id = (opened as { id: number }).id;
    const sites = manager.query(id, 'SELECT id, name, active FROM sites ORDER BY id');
    expect('rows' in sites && sites.rows).toEqual([
      [1, 'North Pit', 1],
      [2, 'South Pit', 0],
    ]);

    // 2. Verify ALTER TABLE ADD COLUMN before trailing UNIQUE(...) constraint (xdb-rs fix)
    const alterRes = manager.execute(id, 'ALTER TABLE locations ADD COLUMN level_id INTEGER REFERENCES levels(id)');
    expect('error' in alterRes).toBe(false);
    const updRes = manager.execute(
      id,
      'UPDATE locations SET level_id = 10 WHERE site_id IN (SELECT id FROM sites WHERE active = 1)'
    );
    expect('error' in updRes).toBe(false);
    const loc = manager.query(id, 'SELECT name, level_id FROM locations WHERE id = ?', JSON.stringify([100]));
    expect('rows' in loc && loc.rows).toEqual([['Bench A', 10]]);

    // 3. Verify shorthand JSON seed (auto-infers CREATE TABLE + BLOB support)
    const seedReport = manager.seedJson('app.db', {
      audit_log: [
        { id: 1, actor: 'admin', payload: { __blob: [0xde, 0xad, 0xbe, 0xef] } },
        { id: 2, actor: 'system', payload: { hex: 'cafebabe' } },
      ],
    });
    expect('rowsInserted' in seedReport && seedReport.rowsInserted).toBe(2);

    const logs = manager.query(id, 'SELECT id, actor, length(payload) FROM audit_log ORDER BY id');
    expect('rows' in logs && logs.rows).toEqual([
      [1, 'admin', 4],
      [2, 'system', 4],
    ]);

    // 4. Verify atomic rollback / error reporting on bad JSON seed
    const badSeed = manager.seedJson('app.db', '["not-an-object"]');
    expect('error' in badSeed).toBe(true);

    // 5. Export raw SQLite `.db` bytes and reload into a brand-new XdbSqlManager
    const exported = manager.exportBytes('app');
    expect(exported).toBeInstanceOf(Uint8Array);
    expect(exported!.byteLength).toBeGreaterThanOrEqual(4096);
    manager.dispose();

    const manager2 = new XdbSqlManager({
      bindings,
      databases: [{ name: 'app', engine: 'sqlite', file: 'app.db', persist: true }],
      initialPersistedDbs: { 'app.db': exported! },
    });
    manager2.preseedConfiguredDatabases();
    const opened2 = manager2.open('app.db');
    const id2 = (opened2 as { id: number }).id;
    const persisted = manager2.query(id2, 'SELECT name, level_id FROM locations');
    expect('rows' in persisted && persisted.rows).toEqual([['Bench A', 10]]);
    manager2.dispose();
  });

  it('boots a single .zip app with db/seed.json, exposes softn:sqlite to frontend JS, and persists across remount', async () => {
    const appZip = zipSync({
      'index.html': strToU8(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>SQLite Notes App</title></head>
<body>
  <h1 id="title">Notes</h1>
  <ul id="list"></ul>
  <button id="add" type="button">Add Note</button>
  <script type="module">
    import sqlite from 'softn:sqlite';

    const db = await sqlite.open('app.db');
    async function render() {
      const rows = await db.all('SELECT id, title FROM notes ORDER BY id');
      const ul = document.getElementById('list');
      ul.innerHTML = '';
      for (const r of rows) {
        const li = document.createElement('li');
        li.textContent = r.id + ': ' + r.title;
        ul.appendChild(li);
      }
    }
    await render();
    document.getElementById('add').addEventListener('click', async () => {
      await db.run('INSERT INTO notes (title) VALUES (?)', ['Created in browser']);
      await render();
    });
  </script>
</body>
</html>`),
      'db/seed.json': strToU8(
        JSON.stringify({
          notes: [
            { id: 1, title: 'Seeded from JSON' },
            { id: 2, title: 'Runs on XDB WASM' },
          ],
        })
      ),
    });

    const host = document.createElement('div');
    document.body.appendChild(host);

    const handle = await mountSoftNContainer(host, {
      source: appZip,
      appId: 'test-sqlite-notes',
      isolation: 'inline',
      engineWasm: { lite: LITE_WASM },
      xdbWasm: XDB_WASM,
      xdbGlueUrl: XDB_GLUE,
    });

    await flushAsync(80);
    const items = Array.from(handle.shadowRoot.querySelectorAll('#list li')).map((el) => el.textContent);
    expect(items).toEqual(['1: Seeded from JSON', '2: Runs on XDB WASM']);

    // Mutate SQLite via button click
    (handle.shadowRoot.querySelector('#add') as HTMLButtonElement).click();
    await flushAsync(80);

    const afterAdd = Array.from(handle.shadowRoot.querySelectorAll('#list li')).map((el) => el.textContent);
    expect(afterAdd).toEqual(['1: Seeded from JSON', '2: Runs on XDB WASM', '3: Created in browser']);

    // Export binary SQLite snapshot via container handle
    const snapshot = await handle.exportDatabase('app');
    expect(snapshot).toBeInstanceOf(Uint8Array);
    expect(snapshot!.byteLength).toBeGreaterThanOrEqual(4096);

    // Runtime programmatic seed via handle.seedDatabase()
    await handle.seedDatabase('app', {
      notes: [{ id: 99, title: 'Injected via host API' }],
    });

    handle.dispose();

    // Remount with the same appId -> persisted SQLite state survives!
    const host2 = document.createElement('div');
    document.body.appendChild(host2);
    const handle2 = await mountSoftNContainer(host2, {
      source: appZip,
      appId: 'test-sqlite-notes',
      isolation: 'inline',
      engineWasm: { lite: LITE_WASM },
      xdbWasm: XDB_WASM,
      xdbGlueUrl: XDB_GLUE,
    });

    await flushAsync(80);
    const persistedItems = Array.from(handle2.shadowRoot.querySelectorAll('#list li')).map((el) => el.textContent);
    expect(persistedItems).toContain('3: Created in browser');
    expect(persistedItems).toContain('99: Injected via host API');

    handle2.dispose();
  });
});
