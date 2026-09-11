/**
 * The differences a no-edit round trip is allowed to make, named.
 *
 * "Open, save, diff" is the Builder's contract: an app that was not edited
 * comes back as it went in. The round-trip test (bundleRoundTrip.test.ts)
 * compares the full archive inventory of an export against its input and
 * fails on any entry whose bytes changed — unless the entry is named here,
 * with the reason, and the test checks that the change is the one described.
 * A new difference is a new line here, reviewed as such; it does not get to
 * hide behind "the output looks similar".
 */

export interface DeliberateMigration {
  /** The archive entry, or a glob-like pattern (`xdb/*.xdb`). */
  entry: string;
  /** What changes, and why the change is wanted. */
  reason: string;
  /** How the test proves nothing else changed. */
  verifiedBy: string;
}

export const MIGRATIONS: readonly DeliberateMigration[] = [
  {
    entry: 'manifest.json',
    reason:
      'Re-serialized from the retained manifest object with two-space indentation. Every field the Builder ' +
      'does not edit is carried through as read, including forward-compatible ones it does not know; the ' +
      'file groups the Builder rebuilds (ui, logic, xdb, assets) are written from the project, which for a ' +
      'no-edit round trip is the same list. A legacy manifest whose paths lack their folder prefix is ' +
      'rewritten to name the archive path the file was actually found at, so a later open does not depend ' +
      'on the fallback lookup.',
    verifiedBy: 'the parsed manifest deep-equals the input manifest',
  },
  {
    entry: 'permission.json',
    reason:
      'Re-serialized from the project declaration the file was read into, so that what the export dialog ' +
      'shows and what the bundle says cannot disagree. Unknown capability names are refused on open by the ' +
      'shared inspection; nothing is added or granted.',
    verifiedBy: 'the parsed declaration deep-equals the input declaration',
  },
  {
    entry: 'xdb/*.xdb',
    reason:
      'Re-serialized in the canonical form with two-space indentation: `{ collection, schema, records }`. ' +
      'Records keep id, created_at, updated_at and any envelope keys the format does not name; flat ' +
      '(Studio-style) records are written in the nested form the runtime also reads; tombstoned records ' +
      'are written verbatim after the live rows, so their position among the rows is the one difference ' +
      'in order. Live records keep their file order.',
    verifiedBy: 'the parsed .xdb deep-equals the input, and the runtime parser reads the same records',
  },
];

/** Whether a changed entry is one the allowlist names. */
export function isAllowedMigration(path: string): boolean {
  return MIGRATIONS.some((m) => matches(m.entry, path));
}

function matches(pattern: string, path: string): boolean {
  if (!pattern.includes('*')) return pattern === path;
  const [prefix, suffix] = pattern.split('*');
  return path.startsWith(prefix) && path.endsWith(suffix) && path.length >= prefix.length + suffix.length;
}
