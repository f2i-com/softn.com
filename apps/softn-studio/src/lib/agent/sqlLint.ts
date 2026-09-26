/**
 * What a host refuses in an app's SQL, found before the host does. A host (apps/softn-host-php
 * runtime/sql.mjs, the Rust host's rules) runs migrations and request-time queries under an
 * authorizer: only its listed functions, and in a migration no PRAGMA, transaction, trigger, view,
 * temporary or virtual table. A migration it refuses stops the whole version from installing; a
 * query it refuses fails the request. This is deliberately narrow — the calls and statements a
 * host always refuses — so a check never sends an agent after a problem that is not there.
 */

import { SQL_MIGRATION_CLOCK_FUNCTIONS, SQL_RUNTIME_FUNCTIONS } from './guide';

const RUNTIME = new Set<string>(SQL_RUNTIME_FUNCTIONS);
const MIGRATION = new Set<string>([...SQL_RUNTIME_FUNCTIONS, ...SQL_MIGRATION_CLOCK_FUNCTIONS]);

/**
 * Words written before `(` that are not function calls: a table or column list (`INTO items(`,
 * `TABLE items(`, `ON items(`, `REFERENCES items(`), or a keyword that takes one (`VALUES (`,
 * `CHECK (`, `IN (`, `KEY (`, `CAST (`).
 */
const NOT_A_CALL_BEFORE = new Set(['into', 'table', 'exists', 'references', 'on', 'index', 'join', 'from', 'update', 'as', 'with', 'view', 'trigger']);
const KEYWORDS = new Set(['values', 'check', 'in', 'exists', 'key', 'unique', 'primary', 'foreign', 'cast', 'not', 'and', 'or', 'as', 'on', 'using',
  'over', 'filter', 'when', 'then', 'else', 'where', 'from', 'select', 'default', 'collate', 'is', 'between', 'table', 'into', 'references',
  'constraint', 'returning', 'case', 'end', 'set', 'by', 'group', 'order', 'having', 'limit', 'offset', 'distinct', 'all', 'union', 'join',
  'left', 'inner', 'outer', 'cross', 'natural', 'insert', 'replace', 'update', 'delete', 'create', 'alter', 'drop', 'add', 'column', 'rename',
  'to', 'if', 'index', 'conflict', 'do', 'nothing', 'generated', 'always', 'stored', 'virtual', 'with', 'recursive', 'exists', 'escape', 'like', 'glob']);

/** The SQL with its string literals, quoted identifiers and comments blanked, so only code is read. */
export function sqlCode(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/`[^`]*`/g, '``')
    .replace(/\[[^\]]*\]/g, '[]');
}

/** Functions the SQL calls that `allowed` does not hold, each once, in order. */
function forbiddenCalls(sql: string, allowed: Set<string>): string[] {
  const code = sqlCode(sql);
  const found: string[] = [];
  for (const match of code.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    const name = match[1].toLowerCase();
    if (KEYWORDS.has(name) || allowed.has(name)) continue;
    const before = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(code.slice(0, match.index))?.[1]?.toLowerCase();
    if (before && NOT_A_CALL_BEFORE.has(before)) continue;
    // `CREATE INDEX name ON items(col)` and `INSERT INTO items (a) VALUES`: a table after its keyword two words back.
    const twoBack = /([A-Za-z_][A-Za-z0-9_]*)\s+[A-Za-z_][A-Za-z0-9_]*\s*$/.exec(code.slice(0, match.index))?.[1]?.toLowerCase();
    if (twoBack === 'exists' || twoBack === 'table') continue;
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

/** Why a host would refuse this migration, one line each; empty when nothing it always refuses is there. */
export function migrationSqlProblems(path: string, sql: string): string[] {
  const code = sqlCode(sql);
  const problems: string[] = [];
  const denied = /\b(PRAGMA|ATTACH|DETACH|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|VACUUM)\b/i.exec(code);
  if (denied) problems.push(`${path}: ${denied[1].toUpperCase()} is not allowed in a migration (the host runs each migration in its own transaction).`);
  const created = /\bCREATE\s+(?:(TEMP|TEMPORARY)\s+(?:TABLE|VIEW|TRIGGER)|VIRTUAL\s+TABLE|TRIGGER|VIEW)\b/i.exec(code);
  if (created) problems.push(`${path}: ${created[0].replace(/\s+/g, ' ').toUpperCase()} is not allowed: a migration creates and alters ordinary tables and indexes, and inserts rows.`);
  const dialect = /\b(SERIAL|AUTO_INCREMENT)\b/i.exec(code);
  if (dialect) problems.push(`${path}: ${dialect[1].toUpperCase()} is not SQLite: write INTEGER PRIMARY KEY, which numbers rows itself.`);
  const calls = forbiddenCalls(sql, MIGRATION);
  if (calls.length) problems.push(`${path}: calls ${calls.map((c) => `${c}()`).join(', ')}, which a migration may not; it may call ${[...MIGRATION].join(', ')}.`);
  return problems;
}

/**
 * The SQL written as a plain string in the backend's softn.sql calls, checked for functions a
 * request may not call. A string built at run time is not read.
 */
export function backendSqlProblems(path: string, source: string): string[] {
  const problems: string[] = [];
  for (const match of source.matchAll(/softn\.sql\.(?:query|first|execute)\(\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`([^`$]*)`)/g)) {
    const sql = match[1] ?? match[2] ?? match[3] ?? '';
    const calls = forbiddenCalls(sql, RUNTIME);
    if (calls.length) {
      const line = source.slice(0, match.index).split('\n').length;
      problems.push(`${path} line ${line}: the query calls ${calls.map((c) => `${c}()`).join(', ')}, which a request may not; take the time from softn.time.now() and pass it as a parameter. A query may call ${[...RUNTIME].join(', ')}.`);
    }
  }
  return problems;
}
