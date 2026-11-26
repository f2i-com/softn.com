/**
 * Round 4 (container host): the SQL bridge across backend requests.
 *
 * The native hosts give each request its own SQL connections: a PHP, JS or Python request
 * runs in a fresh program with a fresh bridge, and the Rust worker's handles are cleared
 * around each dispatch. Nothing a request opens or leaves half-done outlives it there.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadXdbWasm, XdbSqlManager } from '../src/xdb-sql-bridge';
import { LocalBackendTransport } from '../src/local-backend-transport';
import type { BackendConfig } from '../src/types';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINES_DIR = path.join(PKG_ROOT, 'dist', 'runtime', 'engines');
const XDB_WASM = path.join(ENGINES_DIR, 'xdb-wasm.wasm');
const XDB_GLUE = path.join(ENGINES_DIR, 'xdb-wasm.glue.js');
const dec = new TextDecoder();

function transport(backend: BackendConfig, textFiles: Record<string, string>) {
  return new LocalBackendTransport({
    appId: 'r4-sql',
    storagePrefix: 'r4-sql:',
    persistStorage: false,
    backend,
    databases: [{ name: 'app', file: 'app.db', seedSql: 'CREATE TABLE IF NOT EXISTS hits (id INTEGER PRIMARY KEY, n INTEGER);' }],
    textFiles,
    binaryFiles: {},
    runtimeUrl: '/runtime/',
    isolation: 'inline',
  });
}

async function get(t: LocalBackendTransport, p: string, query = '') {
  const r = await t.fetch({ method: 'GET', path: p, query, headers: {} });
  return { status: r.status, text: dec.decode(r.body) };
}

describe('r4 host: SQL writes that fail part-way are still saved', () => {
  it('saves the statements of a batch that ran before one failed', async () => {
    const bindings = await loadXdbWasm({ explicitSource: XDB_WASM, glueUrl: XDB_GLUE });
    const manager = new XdbSqlManager({
      bindings,
      databases: [{ name: 'app', file: 'app.db', seedSql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT UNIQUE);' }],
    });
    manager.preseedConfiguredDatabases();
    manager.flushDirty();
    const h = (manager.open('app.db') as { id: number }).id;

    const dml = manager.execute(h, "INSERT INTO t (v) VALUES ('a'); INSERT INTO t (v) VALUES ('a')");
    expect('error' in dml).toBe(true);
    // SQLite kept the first INSERT (autocommit), so the saved image must include it.
    expect(manager.query(h, 'SELECT v FROM t')).toEqual({ columns: ['v'], rows: [['a']] });
    expect(manager.flushDirty().map((f) => f.dbKey)).toEqual(['app.db']);

    const ddl = manager.execute(h, 'CREATE TABLE u (x); CREATE TABLE u (x)');
    expect('error' in ddl).toBe(true);
    expect(manager.flushDirty().map((f) => f.dbKey)).toEqual(['app.db']);

    // A single statement that fails changes nothing, so there is nothing new to save.
    expect('error' in manager.execute(h, "INSERT INTO t (v) VALUES ('a')")).toBe(true);
    expect(manager.flushDirty()).toEqual([]);
    manager.dispose();
  });
});

describe('r4 host: a configured database is not removed', () => {
  it('refuses to remove it, as the native hosts do, and keeps what was written', async () => {
    const bindings = await loadXdbWasm({ explicitSource: XDB_WASM, glueUrl: XDB_GLUE });
    const seedManager = new XdbSqlManager({ bindings, databases: [{ name: 'app', file: 'app.db', seedSql: 'CREATE TABLE t (v TEXT);' }] });
    seedManager.preseedConfiguredDatabases();
    const sh = (seedManager.open('app.db') as { id: number }).id;
    seedManager.execute(sh, "INSERT INTO t VALUES ('saved last visit')");
    const savedImage = seedManager.exportBytes('app.db')!;
    seedManager.dispose();

    const manager = new XdbSqlManager({
      bindings,
      databases: [{ name: 'app', file: 'app.db', seedSql: 'CREATE TABLE t (v TEXT);' }],
      initialPersistedDbs: { 'app.db': savedImage },
    });
    const h = (manager.open('app.db') as { id: number }).id;
    manager.execute(h, "INSERT INTO t VALUES ('written this visit')");
    const removed = manager.remove('app.db');
    expect('error' in removed).toBe(true);
    const again = (manager.open('app.db') as { id: number }).id;
    expect(manager.query(again, 'SELECT v FROM t ORDER BY rowid')).toEqual({
      columns: ['v'],
      rows: [['saved last visit'], ['written this visit']],
    });
    // A database the app made for itself is removed as before.
    expect(manager.copy('app.db', 'scratch.db')).toMatchObject({ bytes: expect.any(Number) });
    expect(manager.remove('scratch.db')).toEqual({ ok: true, removed: true });
    manager.dispose();
  });
});

describe('r4 host: SQL handles do not run out across requests', () => {
  it('serves a JS backend that opens its database in every request (the Builder and Studio template)', async () => {
    const t = transport({ runtime: 'javascript', entry: 'backend/index.js', mode: 'api', routes: ['/api/'] }, {
      'backend/index.js': `function handleRequest(req) {
  const db = sqlite.open('app.db');
  db.execute('INSERT INTO hits (n) VALUES (1)');
  return { status: 200, json: db.first('SELECT COUNT(*) AS c FROM hits') };
}`,
    });
    await t.ready;
    const statuses: number[] = [];
    let last = '';
    for (let i = 0; i < 40; i++) {
      const r = await get(t, '/api/items');
      statuses.push(r.status);
      last = r.text;
    }
    expect(statuses.filter((s) => s !== 200)).toEqual([]);
    expect(JSON.parse(last)).toEqual({ c: 40 });
    t.dispose();
  });

  it('keeps a handle opened at start-up or cached across requests usable', async () => {
    const t = transport({ runtime: 'javascript', entry: 'backend/index.js', mode: 'api', routes: ['/api/'] }, {
      'backend/index.js': `const boot = sqlite.open('app.db');
let cached = null;
function handleRequest(req) {
  cached = cached || sqlite.open('app.db');
  const extra = sqlite.open('app.db');
  extra.execute('INSERT INTO hits (n) VALUES (2)');
  extra.close();
  extra.close();
  return { status: 200, json: { a: boot.first('SELECT COUNT(*) AS c FROM hits').c, b: cached.first('SELECT COUNT(*) AS c FROM hits').c } };
}`,
    });
    await t.ready;
    let last = '';
    for (let i = 0; i < 36; i++) {
      const r = await get(t, '/api/x');
      expect(r.status).toBe(200);
      last = r.text;
    }
    expect(JSON.parse(last)).toEqual({ a: 36, b: 36 });
    t.dispose();
  });

  it('serves a PHP app that opens PDO in every request, file and in-memory', async () => {
    const t = transport({ runtime: 'php', entry: 'index.php', mode: 'ssr' }, {
      'index.php': `<?php
$pdo = new PDO('sqlite:app.db');
$pdo->exec('INSERT INTO hits (n) VALUES (1)');
$mem = new PDO('sqlite::memory:');
$mem->exec('CREATE TABLE scratch (a)');
echo 'count=' . $pdo->query('SELECT COUNT(*) FROM hits')->fetchColumn();
`,
    });
    await t.ready;
    const bad: string[] = [];
    let last = '';
    for (let i = 0; i < 40; i++) {
      const r = await get(t, '/index.php');
      if (r.status !== 200) bad.push(`${i}: ${r.status} ${r.text.slice(0, 120)}`);
      last = r.text;
    }
    expect(bad).toEqual([]);
    expect(last).toBe('count=40');
    t.dispose();
  });
});

describe('r4 host: a Python backend replays its SQL', () => {
  it('gives each statement its own result, and an SQL error to the statement that made it', async () => {
    const t = transport({ runtime: 'python', entry: 'b.py', mode: 'api', routes: ['/api/'] }, {
      'b.py': `
def handle_request(req):
    db = sqlite.open("app.db")
    db.execute("INSERT INTO hits (n) VALUES (?)", [5])
    db.execute("INSERT INTO hits (n) VALUES (?)", [6])
    rows = db.all("SELECT n FROM hits ORDER BY id")
    failed = ""
    try:
        db.all("SELECT nope FROM hits")
    except Exception as e:
        failed = "failed"
    big = db.first("SELECT 9007199254740991 AS b")
    return {"status": 200, "json": {"rows": [r["n"] for r in rows], "failed": failed, "big": big["b"]}}
`,
    });
    await t.ready;
    const r = await get(t, '/api/x');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ rows: [5, 6], failed: 'failed', big: 9007199254740991 });
    t.dispose();
  });
});

describe('r4 host: a request does not leave a transaction open', () => {
  it('rolls back what a PHP request began and never committed', async () => {
    const t = transport({ runtime: 'php', entry: 'index.php', mode: 'ssr' }, {
      'index.php': `<?php
$pdo = new PDO('sqlite:app.db');
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$m = $_GET['m'] ?? '';
if ($m === 'fail') {
  $pdo->beginTransaction();
  $pdo->exec('INSERT INTO hits (n) VALUES (99)');
  throw new Exception('boom');
}
if ($m === 'tx') {
  $pdo->beginTransaction();
  $pdo->exec('INSERT INTO hits (n) VALUES (2)');
  $pdo->commit();
  echo 'committed';
  exit;
}
echo 'n99=' . $pdo->query('SELECT COUNT(*) FROM hits WHERE n = 99')->fetchColumn();
`,
    });
    await t.ready;
    expect((await get(t, '/index.php', 'm=fail')).status).toBe(500);
    // The PHP host and PDO roll back a transaction its script never finished.
    expect(await get(t, '/index.php')).toEqual({ status: 200, text: 'n99=0' });
    expect(await get(t, '/index.php', 'm=tx')).toEqual({ status: 200, text: 'committed' });
    t.dispose();
  });

  it('rolls back what a JS request began and never committed, and saves what it did commit', async () => {
    const saved: string[] = [];
    const t = new LocalBackendTransport({
      appId: 'r4-sql-js',
      storagePrefix: 'r4-sql-js:',
      persistStorage: true,
      storage: {
        length: 0,
        clear() {},
        getItem: () => null,
        key: () => null,
        removeItem() {},
        setItem: (k: string) => { saved.push(k); },
      } as Storage,
      backend: { runtime: 'javascript', entry: 'backend/index.js', mode: 'api', routes: ['/api/'] },
      databases: [{ name: 'app', file: 'app.db', seedSql: 'CREATE TABLE IF NOT EXISTS hits (id INTEGER PRIMARY KEY, n INTEGER);' }],
      textFiles: {
        'backend/index.js': `function handleRequest(req) {
  const db = sqlite.open('app.db');
  if (req.path === '/api/half') {
    db.execute('BEGIN');
    db.execute('INSERT INTO hits (n) VALUES (7)');
    throw new Error('half done');
  }
  if (req.path === '/api/write-then-throw') {
    db.execute('INSERT INTO hits (n) VALUES (8)');
    throw new Error('after the write');
  }
  return { status: 200, json: db.first('SELECT COUNT(*) AS c FROM hits WHERE n = 7') };
}`,
      },
      binaryFiles: {},
      runtimeUrl: '/runtime/',
      isolation: 'inline',
    });
    await t.ready;
    await new Promise((r) => setTimeout(r, 400));
    expect((await t.fetch({ method: 'POST', path: '/api/half', headers: {} })).status).toBe(500);
    expect(await get(t, '/api/count')).toEqual({ status: 200, text: '{"c":0}' });
    saved.length = 0;
    expect((await t.fetch({ method: 'POST', path: '/api/write-then-throw', headers: {} })).status).toBe(500);
    // The row was written before the handler threw; it stays and is saved like any other write.
    await new Promise((r) => setTimeout(r, 50));
    expect(saved).toContain('r4-sql-js:sqlite:app.db');
    t.dispose();
  });
});
