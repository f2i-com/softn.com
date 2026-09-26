/**
 * Migrations an app's host has already run. A hosted editor (FormLogic) opens a project that is
 * installed, so every migration it arrives with has run on the app's database: the host keeps
 * their checksums and refuses to start if one changes or goes. The agent's file tools refuse to
 * change them, and say how to make the change instead — a new numbered migration.
 *
 * Nothing is remembered outside a hosted editor: a project that has never been deployed may
 * rewrite its migrations freely.
 */

const MIGRATION = /^server\/migrations\/[^/]+\.sql$/;
let applied = new Map<string, string>();

/** Remember the migrations of the project the host opened (their current text). */
export function rememberAppliedMigrations(files: Iterable<[string, { content: unknown }]>): void {
  applied = new Map();
  for (const [path, file] of files) {
    if (MIGRATION.test(path) && typeof file.content === 'string') applied.set(path, file.content);
  }
}

export function forgetAppliedMigrations(): void {
  applied = new Map();
}

/** The next free migration name after the applied ones, e.g. server/migrations/002.sql. */
function nextMigration(): string {
  let highest = 0;
  for (const path of applied.keys()) {
    const number = /(\d+)[^/]*\.sql$/.exec(path);
    if (number) highest = Math.max(highest, Number(number[1]));
  }
  return `server/migrations/${String(highest + 1).padStart(3, '0')}.sql`;
}

/**
 * Why `change` to `path` is refused, or null when it may go ahead. Writing a migration back with
 * exactly the text it has is not a change.
 */
export function appliedMigrationRefusal(path: string, change: 'replace' | 'edit' | 'delete' | 'rename', next?: string): string | null {
  const was = applied.get(path);
  if (was === undefined) return null;
  if (change === 'replace' && next === was) return null;
  const verb = change === 'delete' ? 'be deleted' : change === 'rename' ? 'be renamed' : 'change';
  return `${path} has already run on this app's database on its host, so it cannot ${verb}: the host refuses to start when a migration it ran is changed or missing. Keep it as it is and put the change in a new migration, ${nextMigration()}, listed after it in manifest.json's server.database.migrations (a new column is ALTER TABLE … ADD COLUMN …; a new table is CREATE TABLE …).`;
}
