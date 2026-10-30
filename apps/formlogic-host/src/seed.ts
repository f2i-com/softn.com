/**
 * An app's bundled data (`manifest.files.xdb`), added to its database before
 * it first draws, as SoftN Web, the standalone runtime and the desktop loader
 * add it. The frame never did: an app FormLogic hosted opened with none of the
 * records it ships with (a directory's entries, a game's levels, a demo's
 * sample rows).
 *
 * Core's own reader and seeder do the work (parseXDBFile, seedXDBBundleData):
 * a seed is added once, one the person has since removed stays removed, and a
 * record already there is kept. They are passed in so this runs alone under
 * `node --test`. A file that cannot be read, or that the app's storage cannot
 * take, is said and skipped; the app opens with the rest.
 */
export interface SeedDatabase { isReady?: Promise<unknown> }
export interface SeedFile { collection: string; records: readonly unknown[]; warning?: string }

export interface SeedOutcome {
  /** Records added now (none on a later opening, when every seed is already there). */
  inserted: number;
  /** One line per file that was not added whole, for the console. */
  warnings: string[];
}

export async function seedBundledData<Database extends SeedDatabase, Data extends SeedFile>(
  files: ReadonlyMap<string, string>,
  manifest: { files?: { xdb?: unknown } },
  database: Database,
  parse: (path: string, content: string) => Data,
  seed: (database: Database, data: Data) => number,
  isActive: () => boolean = () => true,
): Promise<SeedOutcome> {
  const declared = manifest.files?.xdb;
  const paths = Array.isArray(declared) ? declared.filter((path): path is string => typeof path === 'string') : [];
  const outcome: SeedOutcome = { inserted: 0, warnings: [] };
  if (!paths.length) return outcome;
  await database.isReady;
  for (const path of paths) {
    // A frame closed while its database got ready writes nothing more.
    if (!isActive()) break;
    const content = files.get(path.replace(/^\.?\//, ''));
    if (content === undefined) { outcome.warnings.push(`${path}: listed in manifest.json but not in the app; nothing was added from it`); continue; }
    const data = parse(path, content);
    if (data.warning) outcome.warnings.push(data.warning);
    try {
      outcome.inserted += seed(database, data);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      outcome.warnings.push(`${path}: its records could not all be stored (${reason.split('\n')[0].slice(0, 200)})`);
    }
  }
  return outcome;
}
