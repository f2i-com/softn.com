/**
 * Small .softn bundles built in the test, for journeys that need an app no
 * example ships: the same layout examples/torch-trainer/build.mjs writes
 * (manifest.json, permission.json, ui/, logic/), zipped in memory with a
 * fixed timestamp so every run hands the runtime the same bytes.
 */
import { strToU8, zipSync } from 'fflate';

export interface PythonBundle {
  id: string;
  name: string;
  ui: string;
  python: string;
  /** Python packages the manifest declares under config.python.packages. */
  packages?: string[];
}

/** A .softn bundle whose logic is `logic/main.py`, as a buffer for a file input. */
export function pythonBundle({ id, name, ui, python, packages }: PythonBundle): Buffer {
  const manifest = {
    id,
    name,
    version: '1.0.0',
    description: 'Built by the e2e gate.',
    main: 'ui/main.ui',
    files: { ui: ['ui/main.ui'], logic: ['logic/main.py'], xdb: [], assets: [] },
    ...(packages ? { config: { python: { packages } } } : {}),
  };
  const files: Record<string, string> = {
    'manifest.json': JSON.stringify(manifest, null, 2),
    'permission.json': JSON.stringify({ permissions: {} }),
    'ui/main.ui': ui,
    'logic/main.py': python,
  };
  const zipped = zipSync(
    Object.fromEntries(Object.entries(files).map(([file, text]) => [file, strToU8(text)])),
    { level: 6, mtime: new Date('2026-09-25T00:00:00.000Z') }
  );
  return Buffer.from(zipped);
}
