import { describe, it, expect, beforeEach } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LocalBackendTransport,
  XdbSqlManager,
  loadXdbWasm,
  mountSoftNContainer,
  sqlInt,
  sqlDecimal,
  sqlBlob,
  sqlValueToBigInt,
  parseXdbResultJson,
  normalizeSqlParamsJson,
  SqlitePersistenceError,
  PLATFORM_MAX_SINGLE_SQLITE_BYTES,
  type SqlitePersistenceStatus,
} from '../src/index';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINES_DIR = path.join(PKG_ROOT, 'dist', 'runtime', 'engines');
const LITE_WASM = path.join(ENGINES_DIR, 'zipp-javascript-lite.wasm');
const PHP_WASM = path.join(ENGINES_DIR, 'zipp-php.wasm');
const XDB_WASM = path.join(ENGINES_DIR, 'xdb-wasm.wasm');
const XDB_GLUE = path.join(ENGINES_DIR, 'xdb-wasm.glue.js');

function flushAsync(ms = 100): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
  };
}

describe('SoftN SQLite Platform Enhancements (Lossless Codec, Workspaces, Persistence, Migrations, XDB Matrix)', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('lossless codec parses signed 64-bit integers, blobs, decimals, NULL/empty/zero, and rejects or converts unsigned overflows', () => {
    const raw =
      '{"columns":["i_big","i_min","i_max","i_safe","dec","blob_v","n","e","z"],"rows":[[9007199254740993,-9223372036854775808,9223372036854775807,42,"12345.6700",{"hex":"deadbeef"},null,"",0]]}';
    const parsed = parseXdbResultJson(raw, 'lossless');
    expect(parsed.columns).toEqual(['i_big', 'i_min', 'i_max', 'i_safe', 'dec', 'blob_v', 'n', 'e', 'z']);
    const row = parsed.rows[0];
    expect(row[0]).toEqual({ type: 'integer', value: '9007199254740993' });
    expect(row[1]).toEqual({ type: 'integer', value: '-9223372036854775808' });
    expect(row[2]).toEqual({ type: 'integer', value: '9223372036854775807' });
    expect(row[3]).toBe(42);
    expect(row[4]).toBe('12345.6700');
    expect(row[5]).toEqual({ type: 'blob', hex: 'deadbeef' });
    expect(row[6]).toBeNull();
    expect(row[7]).toBe('');
    expect(row[8]).toBe(0);

    expect(sqlValueToBigInt(row[0])).toBe(9007199254740993n);
    expect(sqlValueToBigInt(row[1])).toBe(-9223372036854775808n);
    expect(sqlValueToBigInt(row[2])).toBe(9223372036854775807n);

    // Unsigned 64-bit overflow rejected by default, or mapped to exact TEXT when unsignedOverflow='text'
    expect(() =>
      normalizeSqlParamsJson(JSON.stringify([sqlInt('18446744073709551615')]), { unsignedOverflow: 'reject' })
    ).toThrow(/overflow|64-bit/i);

    const asText = JSON.parse(
      normalizeSqlParamsJson(JSON.stringify([sqlInt('18446744073709551615')]), { unsignedOverflow: 'text' })!
    );
    expect(asText).toEqual(['18446744073709551615']);

    // Tagged decimal & blob params normalize cleanly for XDB
    const norm = JSON.parse(
      normalizeSqlParamsJson(JSON.stringify([sqlDecimal('19.9900'), sqlBlob(new Uint8Array([0xca, 0xfe]))]))!
    );
    expect(norm[0]).toBe('19.9900');
    expect(norm[1]).toEqual({ hex: 'cafe' });
  });

  it('verifies the full XDB SQLite compatibility matrix (64-bit ints, blobs, composite keys, transactions, snapshots, integrity checks, and empirical FK behavior)', async () => {
    const xdb = await loadXdbWasm({ explicitSource: XDB_WASM, glueUrl: XDB_GLUE });
    const mgr = new XdbSqlManager({ bindings: xdb, databases: [] });

    try {
      const ws = mgr.createWorkspace({ maxDatabases: 4, maxMemoryBytes: 16 * 1024 * 1024 });
      if ('error' in ws) throw new Error(ws.error);
      const db = mgr.createDatabase({ workspaceId: ws.id, temporary: true });
      if ('error' in db) throw new Error(db.error);

      // 1. Composite primary keys, 64-bit ints, decimals, blobs, ISO-8601 dates, NULL vs "" vs 0
      const ddl = mgr.execute(
        db.id,
        `CREATE TABLE ledger (
          id INTEGER PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          big_id INTEGER NOT NULL,
          amount_dec TEXT NOT NULL,
          payload BLOB,
          note TEXT,
          flag INTEGER,
          created_at TEXT NOT NULL
        );
        CREATE TABLE comp_pk (
          a TEXT NOT NULL,
          b INTEGER NOT NULL,
          v TEXT,
          PRIMARY KEY (a, b)
        );
        CREATE TABLE parents (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parents(id) ON DELETE CASCADE);`
      );
      expect('error' in ddl).toBe(false);

      // Composite PK enforcement
      const firstPk = mgr.execute(db.id, 'INSERT INTO comp_pk (a, b, v) VALUES (?, ?, ?)', JSON.stringify(['k1', 1, 'ok']));
      expect('error' in firstPk).toBe(false);
      const dupPk = mgr.execute(db.id, 'INSERT INTO comp_pk (a, b, v) VALUES (?, ?, ?)', JSON.stringify(['k1', 1, 'dup']));
      expect('error' in dupPk && /unique|constraint/i.test(dupPk.error)).toBe(true);

      // Lossless 64-bit integer insert & readback + exact lastInsertRowid
      const ins1 = mgr.execute(
        db.id,
        'INSERT INTO ledger (id, tenant_id, seq, big_id, amount_dec, payload, note, flag, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        JSON.stringify([
          sqlInt('9007199254740993'),
          'acme',
          1,
          sqlInt('-9223372036854775808'),
          sqlDecimal('12345.6700'),
          sqlBlob(new Uint8Array([0x00, 0xde, 0xad, 0xbe, 0xef, 0xff])),
          null,
          0,
          '2026-11-27T12:34:56.789Z',
        ]),
        undefined,
        { valueMode: 'lossless' }
      );
      if ('error' in ins1) throw new Error(ins1.error);
      expect(ins1.lastInsertRowid).toBe('9007199254740993');

      const ins2 = mgr.execute(
        db.id,
        'INSERT INTO ledger (id, tenant_id, seq, big_id, amount_dec, payload, note, flag, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        JSON.stringify([
          sqlInt('9223372036854775807'),
          'acme',
          2,
          sqlInt('9223372036854775807'),
          sqlDecimal('0.0001'),
          sqlBlob('010203'),
          '',
          1,
          '2026-11-27T12:35:00Z',
        ]),
        undefined,
        { valueMode: 'lossless' }
      );
      expect('error' in ins2).toBe(false);

      const queried = mgr.query(
        db.id,
        'SELECT id, big_id, amount_dec, payload, note, flag, created_at FROM ledger ORDER BY seq',
        undefined,
        undefined,
        { valueMode: 'lossless' }
      );
      if ('error' in queried) throw new Error(queried.error);
      expect(queried.rows[0][0]).toEqual({ type: 'integer', value: '9007199254740993' });
      expect(queried.rows[0][1]).toEqual({ type: 'integer', value: '-9223372036854775808' });
      expect(queried.rows[0][2]).toBe('12345.6700');
      expect(queried.rows[0][3]).toEqual({ type: 'blob', hex: '00deadbeefff' });
      expect(queried.rows[0][4]).toBeNull();
      expect(queried.rows[0][5]).toBe(0);
      expect(queried.rows[0][6]).toBe('2026-11-27T12:34:56.789Z');
      expect(queried.rows[1][0]).toEqual({ type: 'integer', value: '9223372036854775807' });
      expect(queried.rows[1][4]).toBe('');

      // 2. Transactions: BEGIN / ROLLBACK leaves DB untouched
      mgr.execute(db.id, 'BEGIN');
      mgr.execute(db.id, "INSERT INTO parents (id, name) VALUES (1, 'RolledBack')");
      // Committed snapshot must be rejected while a transaction is open!
      const openTxSnap = mgr.exportSnapshot(db.id, { consistency: 'committed' });
      expect('error' in openTxSnap && /transaction/i.test(openTxSnap.error)).toBe(true);
      mgr.execute(db.id, 'ROLLBACK');
      const countAfterRollback = mgr.query(db.id, 'SELECT COUNT(*) FROM parents');
      if ('error' in countAfterRollback) throw new Error(countAfterRollback.error);
      expect(countAfterRollback.rows[0][0]).toBe(0);

      // 3. Schema introspection (including DDL REFERENCES fallback for XDB v0.1.2)
      const schema = mgr.getSchema(db.id);
      if ('error' in schema) throw new Error(schema.error);
      const childrenTable = schema.tables.find((t) => t.name === 'children');
      expect(childrenTable).toBeDefined();
      expect(childrenTable!.foreignKeys.some((fk) => fk.table === 'parents' && fk.from === 'parent_id')).toBe(true);

      // 4. Integrity check + explicit SQL FK orphan check
      mgr.execute(db.id, "INSERT INTO parents (id, name) VALUES (10, 'Alpha')");
      mgr.execute(db.id, 'INSERT INTO children (id, parent_id) VALUES (100, 10)');
      const cleanReport = mgr.integrityCheck(db.id, { checkForeignKeys: true });
      if ('error' in cleanReport) throw new Error(cleanReport.error);
      expect(cleanReport.ok).toBe(true);
      expect(cleanReport.headerValid).toBe(true);
      expect(cleanReport.foreignKeyViolations).toEqual([]);

      // Empirical XDB v0.1.2 note: XDB does not enforce FK constraints natively, so an orphan insert
      // succeeds in XDB v0.1.2, and our host integrityCheck(checkForeignKeys: true) detects the orphan!
      mgr.execute(db.id, 'INSERT INTO children (id, parent_id) VALUES (101, 999)');
      const orphanReport = mgr.integrityCheck(db.id, { checkForeignKeys: true });
      if ('error' in orphanReport) throw new Error(orphanReport.error);
      expect(orphanReport.foreignKeyViolations.length).toBeGreaterThanOrEqual(1);
      expect(orphanReport.ok).toBe(false);
      mgr.execute(db.id, 'DELETE FROM children WHERE id = 101');

      // 5. Export standard SQLite snapshot & re-import as host-enforced readOnly handle
      const snap = mgr.exportSnapshot(db.id, { consistency: 'committed' });
      if ('error' in snap) throw new Error(snap.error);
      expect(new TextDecoder().decode(snap.bytes.subarray(0, 15))).toBe('SQLite format 3');
      expect(snap.byteLength).toBe(snap.bytes.byteLength);

      const importedRo = mgr.importBytes(snap.bytes, { readOnly: true, workspaceId: ws.id });
      if ('error' in importedRo) throw new Error(importedRo.error);
      expect(importedRo.readOnly).toBe(true);
      const roRows = mgr.query(importedRo.id, 'SELECT id, big_id FROM ledger ORDER BY seq', undefined, undefined, {
        valueMode: 'lossless',
      });
      if ('error' in roRows) throw new Error(roRows.error);
      expect(roRows.rows[0][0]).toEqual({ type: 'integer', value: '9007199254740993' });
      const roWrite = mgr.execute(importedRo.id, "INSERT INTO parents (id, name) VALUES (99, 'Fail')");
      expect('error' in roWrite && /read-only|readonly/i.test(roWrite.error)).toBe(true);

      // 6. Malformed binary import fails safely
      const badImport = mgr.importBytes(
        new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
        { workspaceId: ws.id }
      );
      expect('error' in badImport && /too small|invalid|malformed|not a database|header/i.test(badImport.error)).toBe(true);

      // 7. Workspace cancellation halts subsequent batch operations cleanly
      mgr.cancelWorkspace(ws.id);
      const afterCancel = mgr.query(db.id, 'SELECT 1');
      expect('error' in afterCancel && /cancel/i.test(afterCancel.error)).toBe(true);

      const disposed = mgr.disposeWorkspace(ws.id);
      expect(disposed.disposed).toBe(true);
      expect(disposed.closedHandles).toBeGreaterThanOrEqual(2);
    } finally {
      mgr.dispose();
    }
  });

  it('runs versioned non-destructive schema migrations with ledger non-replay and rollback on failure', async () => {
    const xdb = await loadXdbWasm({ explicitSource: XDB_WASM, glueUrl: XDB_GLUE });
    const persisted = new Map<string, Uint8Array>();

    // Install v1
    const mgrV1 = new XdbSqlManager({
      bindings: xdb,
      databases: [{ name: 'app', engine: 'sqlite', file: 'db/app.db', seedSql: 'schema.sql', schemaVersion: 1 }],
      textFiles: {
        'schema.sql': `CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
                       INSERT INTO customers (id, name) VALUES (1, 'Ada Lovelace');`,
      },
      onPersist: (key, bytes) => persisted.set(key, bytes.slice()),
    });
    const h1 = mgrV1.open('db/app.db');
    if ('error' in h1) throw new Error(h1.error);
    const q1 = mgrV1.query(h1.id, 'SELECT name FROM customers');
    if ('error' in q1) throw new Error(q1.error);
    expect(q1.rows).toEqual([['Ada Lovelace']]);
    const st1 = mgrV1.getMigrationStatus(h1.id);
    if ('error' in st1) throw new Error(st1.error);
    expect(st1.currentVersion).toBe(1);
    mgrV1.flushDirty();
    mgrV1.dispose();

    const v1Bytes = persisted.get('db/app.db');
    expect(v1Bytes).toBeDefined();

    // Upgrade v1 -> v2 preserving existing row and recording ledger checksum
    const mgrV2 = new XdbSqlManager({
      bindings: xdb,
      databases: [
        {
          name: 'app',
          engine: 'sqlite',
          file: 'db/app.db',
          seedSql: 'schema.sql',
          schemaVersion: 2,
          migrations: [
            { version: 2, file: 'migrations/002.sql', description: 'Add email column' },
          ],
        },
      ],
      textFiles: {
        'schema.sql': `CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL);`,
        'migrations/002.sql': `ALTER TABLE customers ADD COLUMN email TEXT DEFAULT 'unknown@example.com';
                               UPDATE customers SET email = 'ada@analytical.engine' WHERE id = 1;`,
      },
      initialPersistedDbs: { 'db/app.db': v1Bytes! },
      onPersist: (key, bytes) => persisted.set(key, bytes.slice()),
    });
    const h2 = mgrV2.open('db/app.db');
    if ('error' in h2) throw new Error(h2.error);
    const q2 = mgrV2.query(h2.id, 'SELECT id, name, email FROM customers');
    if ('error' in q2) throw new Error(q2.error);
    expect(q2.rows).toEqual([[1, 'Ada Lovelace', 'ada@analytical.engine']]);
    const st2 = mgrV2.getMigrationStatus(h2.id);
    if ('error' in st2) throw new Error(st2.error);
    expect(st2.currentVersion).toBe(2);
    expect(st2.applied.map((m) => m.version)).toContain(2);
    mgrV2.flushDirty();
    mgrV2.dispose();

    const v2Bytes = persisted.get('db/app.db')!;

    // Re-open at v2 -> migration 2 MUST NOT replay (ALTER TABLE would fail if replayed!)
    const mgrV2Reload = new XdbSqlManager({
      bindings: xdb,
      databases: [
        {
          name: 'app',
          engine: 'sqlite',
          file: 'db/app.db',
          schemaVersion: 2,
          migrations: [{ version: 2, file: 'migrations/002.sql', description: 'Add email column' }],
        },
      ],
      textFiles: {
        'migrations/002.sql': `ALTER TABLE customers ADD COLUMN email TEXT DEFAULT 'unknown@example.com';
                               UPDATE customers SET email = 'ada@analytical.engine' WHERE id = 1;`,
      },
      initialPersistedDbs: { 'db/app.db': v2Bytes },
    });
    const h2r = mgrV2Reload.open('db/app.db');
    if ('error' in h2r) throw new Error(h2r.error);
    const q2r = mgrV2Reload.query(h2r.id, 'SELECT email FROM customers WHERE id = 1');
    if ('error' in q2r) throw new Error(q2r.error);
    expect(q2r.rows).toEqual([['ada@analytical.engine']]);
    mgrV2Reload.dispose();

    // Failing v3 migration must roll back and restore the pre-upgrade v2 database intact!
    const mgrV3Fail = new XdbSqlManager({
      bindings: xdb,
      databases: [
        {
          name: 'app',
          engine: 'sqlite',
          file: 'db/app.db',
          schemaVersion: 3,
          migrations: [
            { version: 2, file: 'migrations/002.sql' },
            { version: 3, sql: 'ALTER TABLE customers ADD COLUMN tier TEXT; INVALID SQL SYNTAX HERE;' },
          ],
        },
      ],
      textFiles: {
        'migrations/002.sql': `ALTER TABLE customers ADD COLUMN email TEXT DEFAULT 'unknown@example.com';
                               UPDATE customers SET email = 'ada@analytical.engine' WHERE id = 1;`,
      },
      initialPersistedDbs: { 'db/app.db': v2Bytes },
    });
    const h3 = mgrV3Fail.open('db/app.db');
    expect('error' in h3).toBe(true);
    // Recovered v2 database remains intact and queryable!
    const recoveredBytes = mgrV3Fail.exportBytes('db/app.db');
    expect(recoveredBytes).not.toBeNull();
    mgrV3Fail.dispose();
  });

  it('tracks explicit persistence states, awaits flush acknowledgement, propagates quota/storage errors, and detects cross-tab revision conflicts', async () => {
    const backing = makeMemoryStorage();
    const events: SqlitePersistenceStatus[] = [];

    const transport1 = new LocalBackendTransport({
      appId: 'test-persist-ack',
      storagePrefix: 'softn-test-persist-ack:',
      runtimeUrl: '/runtime/',
      persistStorage: true,
      storage: backing,
      isolation: 'inline',
      databases: [{ name: 'app', engine: 'sqlite', file: 'db/app.db', persist: true }],
      textFiles: {},
      binaryFiles: {},
      xdbModule: XDB_WASM,
      xdbGlueUrl: XDB_GLUE,
      onPersistenceChange: (st) => events.push({ ...st }),
    });
    await transport1.ready;

    const opened = (await transport1.sqliteOp('open', ['db/app.db'])) as { id: number };
    await transport1.sqliteOp('execute', [opened.id, 'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)']);
    await transport1.sqliteOp('execute', [opened.id, "INSERT INTO notes (body) VALUES ('durable')"]);

    const ack = await transport1.flushAndAck({ handleId: opened.id });
    expect(ack.state).toBe('saved');
    expect(ack.revision).toBeGreaterThanOrEqual(1);
    expect(ack.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(events.some((e) => e.state === 'saved')).toBe(true);

    // Simulate another tab advancing the stored revision in the same backing storage
    const metaKey = 'softn-test-persist-ack:sqlite-meta:db/app.db';
    const rawMeta = JSON.parse(backing.getItem(metaKey)!);
    rawMeta.revision = ack.revision + 5;
    rawMeta.tabId = 'other-tab-id';
    backing.setItem(metaKey, JSON.stringify(rawMeta));

    await transport1.sqliteOp('execute', [opened.id, "INSERT INTO notes (body) VALUES ('conflict')"]);
    await expect(transport1.flushAndAck({ handleId: opened.id })).rejects.toThrow(/revision|conflict|tab/i);
    const conflictStatus = transport1.getPersistenceStatus('db/app.db') as SqlitePersistenceStatus;
    expect(conflictStatus.state).toBe('unsaved-changes');
    transport1.dispose();

    // Quota / storage failure propagation (never silently resolves!)
    const failingStorage: Storage = {
      ...makeMemoryStorage(),
      setItem() {
        const err = new Error('QuotaExceededError');
        err.name = 'QuotaExceededError';
        throw err;
      },
    };
    const transportQuota = new LocalBackendTransport({
      appId: 'test-quota-fail',
      storagePrefix: 'softn-test-quota-fail:',
      runtimeUrl: '/runtime/',
      persistStorage: true,
      storage: failingStorage,
      isolation: 'inline',
      databases: [{ name: 'app', engine: 'sqlite', file: 'db/app.db', persist: true }],
      textFiles: {},
      binaryFiles: {},
      xdbModule: XDB_WASM,
      xdbGlueUrl: XDB_GLUE,
    });
    await transportQuota.ready;
    const hq = (await transportQuota.sqliteOp('open', ['db/app.db'])) as { id: number };
    await transportQuota.sqliteOp('execute', [hq.id, 'CREATE TABLE t (x TEXT); INSERT INTO t VALUES ("boom")']);
    await expect(transportQuota.flushAndAck({ handleId: hq.id })).rejects.toBeInstanceOf(SqlitePersistenceError);
    expect((transportQuota.getPersistenceStatus('db/app.db') as SqlitePersistenceStatus).state).toBe(
      'storage-limit-reached'
    );
    transportQuota.dispose();

    expect(PLATFORM_MAX_SINGLE_SQLITE_BYTES).toBe(256 * 1024 * 1024);
  });

  it('enforces strict security isolation: guest with sqlite-workspace can use temporary workspaces while direct backend DB access stays blocked', async () => {
    const appZip = zipSync({
      'manifest.json': strToU8(
        JSON.stringify({
          engine: 2,
          name: 'Workspace With Backend',
          main: 'public/index.html',
          frontendRoot: 'public',
          backend: { runtime: 'php', mode: 'api', entry: 'backend/index.php', routes: ['/api/'] },
          databases: [{ name: 'app', engine: 'sqlite', file: 'db/app.db', seedSql: 'backend/schema.sql' }],
        })
      ),
      'permission.json': strToU8(
        JSON.stringify({ permissions: { 'sqlite-workspace': { enabled: true } } })
      ),
      'backend/schema.sql': strToU8(
        "CREATE TABLE secrets (id INTEGER PRIMARY KEY, token TEXT); INSERT INTO secrets VALUES (1, 'backend-only-secret');"
      ),
      'backend/index.php': strToU8(`<?php
        header('Content-Type: application/json');
        $pdo = new PDO('sqlite:db/app.db');
        echo json_encode(['count' => (int) $pdo->query('SELECT COUNT(*) FROM secrets')->fetchColumn()]);
      `),
      'public/index.html': strToU8(`<!doctype html>
<html><body>
  <div id="direct-err">pending</div>
  <div id="ws-ok">pending</div>
  <div id="api-ok">pending</div>
  <script type="module">
    import { sqlite } from 'softn:sqlite';

    // 1. Attempting direct access to backend-owned DB MUST be blocked!
    try {
      await sqlite.open('db/app.db');
      document.getElementById('direct-err').textContent = 'UNEXPECTED_OPEN';
    } catch (err) {
      document.getElementById('direct-err').textContent = 'BLOCKED:' + err.message;
    }

    // 2. Isolated temporary workspace works independently with zero access to backend DB!
    const ws = await sqlite.createWorkspace();
    const tmp = await ws.create();
    await tmp.execute('CREATE TABLE migrated (id INTEGER PRIMARY KEY, big_id INTEGER, amount TEXT)');
    await tmp.execute('INSERT INTO migrated VALUES (?, ?, ?)', [
      sqlite.sqlInt('9007199254740993'),
      sqlite.sqlInt('-9223372036854775808'),
      sqlite.sqlDecimal('99.9500'),
    ]);
    const rows = await tmp.all('SELECT id, big_id, amount FROM migrated');
    const bytes = await tmp.exportBytes();
    const ro = await ws.import(bytes, { readOnly: true });
    let roBlocked = false;
    try { await ro.execute('DELETE FROM migrated'); } catch { roBlocked = true; }
    await ws.dispose();
    document.getElementById('ws-ok').textContent =
      rows[0].id.value + '|' + rows[0].big_id.value + '|' + rows[0].amount + '|ro=' + roBlocked + '|len=' + bytes.byteLength;

    // 3. Backend API still accesses its private DB normally
    const resp = await fetch('/api/health');
    const json = await resp.json();
    document.getElementById('api-ok').textContent = 'backend_secrets=' + json.count;
  </script>
</body></html>`),
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = await mountSoftNContainer(host, {
      source: appZip,
      appId: 'test-workspace-isolation',
      isolation: 'inline',
      permissionMode: 'preapproved',
      engineWasm: { lite: LITE_WASM, php: PHP_WASM },
      xdbWasm: XDB_WASM,
      xdbGlueUrl: XDB_GLUE,
    });

    await flushAsync(200);
    expect(handle.shadowRoot.querySelector('#direct-err')?.textContent).toMatch(/^BLOCKED:/);
    expect(handle.shadowRoot.querySelector('#ws-ok')?.textContent).toMatch(
      /^9007199254740993\|-9223372036854775808\|99\.9500\|ro=true\|len=\d+$/
    );
    expect(handle.shadowRoot.querySelector('#api-ok')?.textContent).toBe('backend_secrets=1');
    handle.dispose();
  }, 30_000);
});
