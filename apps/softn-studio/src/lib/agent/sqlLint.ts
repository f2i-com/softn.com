/**
 * What a host refuses in an app's SQL, found before the host does. A host (apps/softn-host-php
 * runtime/sql.mjs, the Rust host's rules) runs migrations and request-time queries under an
 * authorizer: only its listed functions, and in a migration no PRAGMA, transaction, trigger, view,
 * temporary or virtual table. A migration it refuses stops the whole version from installing; a
 * query it refuses fails the request. This is deliberately narrow — the calls and statements a
 * host always refuses — so a check never sends an agent after a problem that is not there.
 */

import { SQL_MIGRATION_EXTRA_FUNCTIONS, SQL_RUNTIME_FUNCTIONS, SQL_TABLE_FUNCTIONS } from './guide';

const RUNTIME = new Set<string>([...SQL_RUNTIME_FUNCTIONS, ...SQL_TABLE_FUNCTIONS]);
const MIGRATION = new Set<string>([...SQL_RUNTIME_FUNCTIONS, ...SQL_MIGRATION_EXTRA_FUNCTIONS, ...SQL_TABLE_FUNCTIONS]);
/** Functions that read the clock or chance: at request time the answer is softn.time.now(). */
const CLOCK_OR_CHANCE = new Set(['datetime', 'date', 'time', 'strftime', 'julianday', 'unixepoch', 'random', 'randomblob', 'current_timestamp', 'current_date', 'current_time']);

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
  'to', 'if', 'index', 'conflict', 'do', 'nothing', 'generated', 'always', 'stored', 'virtual', 'with', 'recursive', 'escape', 'like', 'glob']);
/** `VARCHAR(100)`, `DECIMAL(10, 2)`: a column type's size, not a call. */
const TYPE_SIZE = /^\(\s*[+-]?\d+(?:\s*,\s*[+-]?\d+)?\s*\)/;
/** Statements a host never runs in a migration, as the first word of a statement. */
const DENIED_STATEMENTS = /^(PRAGMA|ATTACH|DETACH|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|VACUUM|ANALYZE)\b/i;

/**
 * The SQL with its string literals, quoted identifiers and comments blanked, so only code is
 * read. One pass from the left, as SQLite reads it: a `--` inside a string is part of the
 * string, and a quote inside a comment is part of the comment.
 */
export function sqlCode(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];
    if (c === '-' && n === '-') {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end;
      out += ' ';
    } else if (c === '/' && n === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
      out += ' ';
    } else if (c === "'" || c === '"' || c === '`') {
      // A quote is escaped by doubling it.
      let j = i + 1;
      while (j < sql.length && !(sql[j] === c && sql[j + 1] !== c)) j += sql[j] === c ? 2 : 1;
      out += c + c;
      i = j + 1;
    } else if (c === '[') {
      const end = sql.indexOf(']', i + 1);
      i = end < 0 ? sql.length : end + 1;
      out += '[]';
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** Functions the SQL calls that `allowed` does not hold, each once, in order. */
function forbiddenCalls(sql: string, allowed: Set<string>): string[] {
  const code = sqlCode(sql);
  const found: string[] = [];
  for (const match of code.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    const name = match[1].toLowerCase();
    if (KEYWORDS.has(name) || allowed.has(name)) continue;
    const before = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(code.slice(0, match.index))?.[1]?.toLowerCase();
    // A type's size comes after the column's name (`name VARCHAR(100)`) or CAST's AS; `randomblob(8)` after another keyword or `(` is a call.
    if (before && (!KEYWORDS.has(before) || before === 'as') && TYPE_SIZE.test(code.slice(match.index + match[0].length - 1))) continue;
    if (before && NOT_A_CALL_BEFORE.has(before)) continue;
    // `CREATE INDEX name ON items(col)` and `INSERT INTO items (a) VALUES`: a table after its keyword two words back.
    const twoBack = /([A-Za-z_][A-Za-z0-9_]*)\s+[A-Za-z_][A-Za-z0-9_]*\s*$/.exec(code.slice(0, match.index))?.[1]?.toLowerCase();
    if (twoBack === 'exists' || twoBack === 'table') continue;
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

/** The statements of some SQL (code only), each trimmed, empty ones left out. */
function statements(code: string): string[] {
  return code.split(';').map((statement) => statement.trim()).filter(Boolean);
}

/** Why a host would refuse this migration, one line each; empty when nothing it always refuses is there. */
export function migrationSqlProblems(path: string, sql: string): string[] {
  const code = sqlCode(sql);
  const problems: string[] = [];
  const denied = statements(code).map((statement) => DENIED_STATEMENTS.exec(statement)).find(Boolean);
  if (denied) problems.push(`${path}: ${denied[1].toUpperCase()} is not allowed in a migration (the host runs each migration in its own transaction).`);
  const created = /\bCREATE\s+(?:(TEMP|TEMPORARY)\s+(?:TABLE|VIEW|TRIGGER)|VIRTUAL\s+TABLE|TRIGGER|VIEW)\b/i.exec(code);
  if (created) problems.push(`${path}: ${created[0].replace(/\s+/g, ' ').toUpperCase()} is not allowed: a migration creates and alters ordinary tables and indexes, and inserts rows.`);
  const dialect = /\b(SERIAL|AUTO_INCREMENT)\b/i.exec(code);
  if (dialect) problems.push(`${path}: ${dialect[1].toUpperCase()} is not SQLite: write INTEGER PRIMARY KEY, which numbers rows itself.`);
  const calls = forbiddenCalls(sql, MIGRATION);
  if (calls.length) problems.push(`${path}: calls ${calls.map((c) => `${c}()`).join(', ')}, which a migration may not; it may call ${[...SQL_RUNTIME_FUNCTIONS, ...SQL_MIGRATION_EXTRA_FUNCTIONS].join(', ')}.`);
  return problems;
}

const QUERY_STATEMENTS = new Set(['SELECT', 'WITH', 'VALUES']);
const EXECUTE_STATEMENTS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'WITH']);

/**
 * The SQL written as a plain string in the backend's softn.sql calls, checked for what a host
 * always refuses at request time: functions outside its list, a write through query or first, a
 * read through execute, and RETURNING (execute returns no rows). A string built at run time is
 * not read.
 */
export function backendSqlProblems(path: string, source: string): string[] {
  const problems: string[] = [];
  for (const match of source.matchAll(/softn\.sql\.(query|first|execute)\(\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`([^`$]*)`)/g)) {
    const kind = match[1];
    const sql = match[2] ?? match[3] ?? match[4] ?? '';
    // The line the SQL string starts on.
    const line = source.slice(0, match.index + match[0].search(/["'`]/)).split('\n').length;
    const at = `${path} line ${line}`;
    const code = sqlCode(sql);
    const keyword = /^\s*([A-Za-z]+)/.exec(code)?.[1]?.toUpperCase() ?? '';
    if (keyword && kind === 'execute' && !EXECUTE_STATEMENTS.has(keyword)) {
      problems.push(`${at}: softn.sql.execute runs an INSERT, UPDATE, DELETE or REPLACE; read with softn.sql.query or softn.sql.first.`);
    } else if (keyword && kind !== 'execute' && !QUERY_STATEMENTS.has(keyword)) {
      problems.push(`${at}: softn.sql.${kind} only reads (SELECT); change data with softn.sql.execute.`);
    }
    if (kind === 'execute' && /\bRETURNING\b/i.test(code)) {
      problems.push(`${at}: softn.sql.execute returns no rows, so RETURNING is refused; read the row back with softn.sql.first, using the lastInsertRowid it returns.`);
    }
    const calls = forbiddenCalls(sql, RUNTIME);
    if (calls.length) {
      const how = calls.some((call) => CLOCK_OR_CHANCE.has(call))
        ? 'take the time from softn.time.now() and pass it as a parameter'
        : 'work the value out in JavaScript and pass it as a parameter';
      problems.push(`${at}: the query calls ${calls.map((c) => `${c}()`).join(', ')}, which a request may not; ${how}. A query may call ${SQL_RUNTIME_FUNCTIONS.join(', ')}.`);
    }
  }
  return problems;
}
