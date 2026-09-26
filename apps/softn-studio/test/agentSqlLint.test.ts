/**
 * The SQL a host always refuses, found in Studio: functions outside the host's lists, and the
 * statements a migration may not run. Held to the host's own rules, and quiet on SQL it takes.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SQL_MIGRATION_CLOCK_FUNCTIONS, SQL_RUNTIME_FUNCTIONS } from '../src/lib/agent/guide';
import { backendSqlProblems, migrationSqlProblems, sqlCode } from '../src/lib/agent/sqlLint';

const HOST_SQL = readFileSync(resolve(process.cwd(), '../softn-host-php/runtime/sql.mjs'), 'utf8');
const hostSet = (name: string) => {
  const start = HOST_SQL.indexOf(`export const ${name}=new Set([`);
  const body = HOST_SQL.slice(start, HOST_SQL.indexOf(']);', start));
  return [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
};

describe('the host\'s SQL functions', () => {
  it('are the ones the guide and the lint use', () => {
    expect([...SQL_RUNTIME_FUNCTIONS]).toEqual(hostSet('RUNTIME_FUNCTIONS'));
    // MIGRATION_FUNCTIONS spreads RUNTIME_FUNCTIONS, then adds the clock and ALTER TABLE's own helpers.
    expect(hostSet('MIGRATION_FUNCTIONS').slice(0, SQL_MIGRATION_CLOCK_FUNCTIONS.length)).toEqual([...SQL_MIGRATION_CLOCK_FUNCTIONS]);
  });
});

describe('a migration', () => {
  it('passes ordinary SQLite: tables, indexes, keys, checks, defaults, inserts', () => {
    const sql = `-- recipes (with a comment that says PRAGMA)
CREATE TABLE IF NOT EXISTS recipes(
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) > 0),
  favourite INTEGER NOT NULL DEFAULT 0,
  created TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(title),
  FOREIGN KEY (id) REFERENCES items(id)
);
CREATE INDEX recipes_title ON recipes(title);
ALTER TABLE recipes ADD COLUMN steps TEXT NOT NULL DEFAULT '';
INSERT INTO recipes (title, steps) VALUES ('Pancakes; begin here', upper('mix'));`;
    expect(migrationSqlProblems('server/migrations/002.sql', sql)).toEqual([]);
  });

  it('is refused a trigger, a view, a PRAGMA, a transaction, SERIAL, and functions a host does not allow', () => {
    const lines = migrationSqlProblems('server/migrations/002.sql', `BEGIN;
PRAGMA foreign_keys = ON;
CREATE TABLE notes(id SERIAL PRIMARY KEY, code TEXT DEFAULT (lower(hex(randomblob(8)))), made TEXT DEFAULT (now()));
CREATE TRIGGER touch AFTER UPDATE ON notes BEGIN SELECT 1; END;`);
    expect(lines[0]).toContain('BEGIN is not allowed');
    expect(lines.some((l) => l.includes('CREATE TRIGGER is not allowed'))).toBe(true);
    expect(lines.some((l) => l.includes('SERIAL is not SQLite'))).toBe(true);
    expect(lines.some((l) => l.includes('calls randomblob(), now()'))).toBe(true);
    expect(migrationSqlProblems('m.sql', 'CREATE VIEW v AS SELECT 1;')[0]).toContain('CREATE VIEW is not allowed');
    expect(migrationSqlProblems('m.sql', 'CREATE TEMP TABLE t(a);')[0]).toContain('CREATE TEMP TABLE is not allowed');
  });
});

describe('a backend\'s queries', () => {
  it('are refused a clock or random function, with the line and the way to do it', () => {
    const source = `function createItem(req) {
  softn.sql.execute("INSERT INTO items(title, made) VALUES(?, datetime('now'))", [req.body.title]);
  return {status: 201, body: softn.sql.first('SELECT id, count(*) AS n FROM items WHERE lower(title) = lower(?)', [req.body.title])};
}`;
    const lines = backendSqlProblems('server/main.logic', source);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('server/main.logic line 2: the query calls datetime()');
    expect(lines[0]).toContain('softn.time.now()');
  });

  it('reads only plain strings, and sees no calls inside quotes or identifiers', () => {
    expect(backendSqlProblems('b.logic', 'softn.sql.query(`SELECT * FROM items WHERE id = ${id}`, [])')).toEqual([]);
    expect(sqlCode(`SELECT "now()" FROM t WHERE a = 'random()' -- json(x)`)).not.toMatch(/now\(|random\(|json\(/);
  });
});
