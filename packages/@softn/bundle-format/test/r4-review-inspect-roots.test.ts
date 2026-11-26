/**
 * Where the inspector looks for a bundle's files, as the directory looks
 * (apps/softn-api/lib/bundle.php) (audit round 4).
 *
 * - A bundle whose `main` and `icon` are written from its `frontendRoot`
 *   (`frontendRoot: "public"`, `main: "index.html"`, the file at
 *   `public/index.html`) is taken by the directory, which tries
 *   `frontendRoot/main` and `frontendRoot/icon`. The inspector said the entry
 *   file was not in the bundle, and the publish page refuses an inspection with
 *   a problem.
 * - A project zipped with its `ui/` folder at the top (`ui/main.ui`) is no
 *   bundle zipped inside a folder: the directory and the runtime do not take
 *   `ui/` for the bundle's root, and refuse it for its missing manifest. The
 *   inspector took it, and said nothing was wrong.
 */
import { describe, expect, it } from 'vitest';
import { inspectBundle } from '../src/inspect';
import { craftZip, enc } from './craft';

const errors = (report: { level: string; text: string }[]) => report.filter((l) => l.level === 'error').map((l) => l.text);
const warnings = (report: { level: string; text: string }[]) => report.filter((l) => l.level === 'warn').map((l) => l.text);

describe('a bundle whose entry is written from its frontendRoot', () => {
  it('has its entry and its icon found there', () => {
    const manifest = { name: 'Site', version: '1.0.0', description: 'd', engine: 2, frontendRoot: 'public', main: 'index.html', icon: 'icon.png' };
    const inspection = inspectBundle(
      craftZip([
        { name: 'manifest.json', data: enc(JSON.stringify(manifest)) },
        { name: 'public/index.html', data: enc('<!doctype html><p>hi</p>') },
        { name: 'public/icon.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]) },
        { name: 'permission.json', data: enc('{"permissions":{}}') },
      ]).bytes
    );
    expect(errors(inspection.report)).toEqual([]);
    expect(warnings(inspection.report).join(' ')).not.toMatch(/does not have: icon\.png/);
  });

  it('still says so when the entry is in neither place', () => {
    const manifest = { name: 'Site', version: '1.0.0', description: 'd', engine: 2, frontendRoot: 'public', main: 'index.html' };
    const inspection = inspectBundle(
      craftZip([
        { name: 'manifest.json', data: enc(JSON.stringify(manifest)) },
        { name: 'public/other.html', data: enc('<p>hi</p>') },
      ]).bytes
    );
    expect(errors(inspection.report)).toContain("The manifest's entry file is not in the bundle: index.html");
  });
});

describe('a project zipped with its ui/ folder at the top', () => {
  it('is not read as a bundle inside a folder named ui', () => {
    const manifest = { name: 'Notes', version: '1.0.0', description: 'd', main: 'main.ui' };
    const inspection = inspectBundle(
      craftZip([
        { name: 'ui/manifest.json', data: enc(JSON.stringify(manifest)) },
        { name: 'ui/main.ui', data: enc('<p>hi</p>') },
      ]).bytes
    );
    expect(errors(inspection.report).length).toBeGreaterThan(0);
  });
});
