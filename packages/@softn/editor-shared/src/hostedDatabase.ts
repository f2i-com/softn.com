import { isRecord, parseManifest } from './formlogicBackend';

/** Design a new SQLite table in source. FormLogic applies the listed migrations in order. */
export interface HostedTableColumn {
  name: string;
  type: 'TEXT' | 'INTEGER' | 'REAL' | 'BOOLEAN';
  required?: boolean;
}

export interface HostedTableDesign {
  name: string;
  columns: HostedTableColumn[];
}

type ProjectFiles = Readonly<Record<string, string>>;

function identifier(name: string, label: string): string {
  const value = name.trim();
  if (!/^[a-z][a-z0-9_]*$/i.test(value)) {
    throw new Error(`${label} must start with a letter and contain only letters, numbers and underscores.`);
  }
  if (/^(?:sqlite_|pragma_)|^dbstat$/i.test(value)) throw new Error(`SQLite reserves the name “${value}”.`);
  return value;
}

export function createTableSql(table: HostedTableDesign): string {
  const name = identifier(table.name, 'The table name');
  const taken = new Set(['id', 'rowid', 'oid', '_rowid_']);
  const lines = ['  "id" INTEGER PRIMARY KEY'];
  for (const [index, column] of table.columns.entries()) {
    const field = identifier(column.name, `Column ${index + 1}`);
    if (taken.has(field.toLowerCase())) throw new Error(`The column name “${field}” is already in use.`);
    taken.add(field.toLowerCase());
    if (!['TEXT', 'INTEGER', 'REAL', 'BOOLEAN'].includes(column.type)) throw new Error(`Choose a type for “${field}”.`);
    const type = column.type === 'BOOLEAN' ? 'INTEGER' : column.type;
    const check = column.type === 'BOOLEAN' ? ` CHECK ("${field}" IN (0, 1))` : '';
    lines.push(`  "${field}" ${type}${column.required ? ' NOT NULL' : ''}${check}`);
  }
  return `CREATE TABLE "${name}" (\n${lines.join(',\n')}\n);\n`;
}

/** Read the table declarations in an existing migration without treating comments or literal values as SQL. */
export function migrationTableNames(sql: string): string[] {
  const statements = sql.replace(/--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'/g, ' ');
  const declarations = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:main|"main"|\[main\])\s*\.\s*)?(?:"((?:""|[^"])+)"|`([^`]+)`|\[([^\]]+)\]|([\w$]+))/gi;
  return Array.from(statements.matchAll(declarations), (match) => (match[1] ?? match[2] ?? match[3] ?? match[4]).replace(/""/g, '"'));
}

function migrationList(list: unknown): string[] {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.some(path => typeof path !== 'string')) {
    throw new Error('The manifest needs an ordered list of paths in server.database.migrations.');
  }
  return list;
}

export function listedMigrations(files: ProjectFiles): string[] {
  const { server } = parseManifest(files['manifest.json']);
  if (server === undefined) return [];
  if (!isRecord(server) || !isRecord(server.database)) throw new Error('Check the backend database declaration in manifest.json.');
  return migrationList(server.database.migrations);
}

/** The native runners apply paths in byte order. A generated name must sort after all existing ones. */
export function nextMigrationFile(paths: Iterable<string>): string {
  const folder = 'server/migrations/';
  let last = '';
  let width = 3;
  let highest = 0;
  for (const path of paths) {
    if (!path.startsWith(folder) || !path.endsWith('.sql')) continue;
    if (path > last) last = path;
    const digits = /^\d+/.exec(path.slice(folder.length))?.[0];
    if (digits) {
      width = Math.max(width, digits.length);
      highest = Math.max(highest, Number(digits));
    }
  }
  if (Number.isSafeInteger(highest + 1)) {
    const numbered = folder + String(highest + 1).padStart(width, '0') + '.sql';
    if (numbered > last) return numbered;
  }
  // A hand-named migration or a jump in digit width (999 → 1000) may sort
  // after the next number. Continue under that stem: init_001, init_002…
  const suffix = /^(.*_)(\d+)\.sql$/.exec(last);
  if (suffix) {
    const next = Number(suffix[2]) + 1;
    if (Number.isSafeInteger(next) && String(next).length <= suffix[2].length) {
      return suffix[1] + String(next).padStart(suffix[2].length, '0') + '.sql';
    }
  }
  return last.slice(0, -4) + '_001.sql';
}

export function createTableMigration(files: ProjectFiles, table: HostedTableDesign) {
  const sql = createTableSql(table);
  const manifest = parseManifest(files['manifest.json']);
  const server = manifest.server;
  if (!isRecord(server) || !isRecord(server.requires) || server.requires.apiVersion !== 1) {
    throw new Error('Set up the FormLogic API v1 backend before adding a table.');
  }
  const capabilities = server.requires.capabilities;
  if (!Array.isArray(capabilities) || capabilities.some(value => typeof value !== 'string')) {
    throw new Error('The manifest needs a list in server.requires.capabilities.');
  }
  if (!isRecord(server.database) || server.database.kind !== 'private-sqlite') {
    throw new Error('The backend must use a FormLogic private SQLite database.');
  }
  const migrations = migrationList(server.database.migrations);
  for (const path of migrations) {
    if (!Object.hasOwn(files, path)) throw new Error(`Restore the missing migration ${path} before adding a table.`);
    if (migrationTableNames(files[path]).some(name => name.toLowerCase() === table.name.trim().toLowerCase())) {
      throw new Error(`“${table.name.trim()}” already has a table declaration in ${path}.`);
    }
  }

  const path = nextMigrationFile(Object.keys(files));
  if (!capabilities.includes('sql')) server.requires.capabilities = [...capabilities, 'sql'];
  server.database.migrations = [...migrations, path];
  return { path, sql, manifest: JSON.stringify(manifest, null, 2) + '\n' };
}
