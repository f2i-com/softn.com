/**
 * createBundleFromDirectory, which for a long time only threw.
 *
 * It is in the package's public types and its message said it needed Node or
 * Tauri — which it also said when called from Node, so it was a dead end rather
 * than a direction. The bundler CLI's help offers the directory it could not
 * read as the worked example: `bundle ./demo-bundle ./demo.softn`.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, unlinkSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBundleFromDirectory, readBundle, readBundleEntries } from '../src/bundle';

/** The project narrows the ambient Buffer type, so compare the bytes directly. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

describe('createBundleFromDirectory', () => {
  it('bundles the demo directory the CLI help points at', async () => {
    const bytes = await createBundleFromDirectory({ sourceDir: 'demo-bundle', outputPath: '' });
    expect(bytes.byteLength).toBeGreaterThan(1000);
    const bundle = await readBundle(bytes);
    expect(bundle.manifest.name).toBe('Todo App Demo');
  });

  it('copies every file through byte for byte', async () => {
    // The archive is checked against its sources, so a round trip through a
    // string — which would decide line endings on the reader's behalf — is not
    // good enough. Nested directories included.
    const bytes = await createBundleFromDirectory({ sourceDir: 'demo-bundle', outputPath: '' });
    const entries = await readBundleEntries(bytes);
    const names = [...entries.keys()].filter((n) => n !== 'manifest.json');
    expect(names).toContain('components/todo-item.ui');
    expect(names).toContain('assets/icon.svg');
    for (const name of names) {
      const onDisk = new Uint8Array(readFileSync(join('demo-bundle', name)));
      expect(sameBytes(entries.get(name)!, onDisk), `${name} differs from its source`).toBe(true);
    }
  });

  it('writes to outputPath when one is given', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'softn-bundle-')), 'demo.softn');
    const bytes = await createBundleFromDirectory({ sourceDir: 'demo-bundle', outputPath: out });
    expect(existsSync(out)).toBe(true);
    expect(sameBytes(new Uint8Array(readFileSync(out)), bytes)).toBe(true);
    unlinkSync(out);
  });

  it('honours exclude', async () => {
    const bytes = await createBundleFromDirectory({
      sourceDir: 'demo-bundle',
      outputPath: '',
      exclude: ['utils.logic'],
    });
    const entries = await readBundleEntries(bytes);
    expect([...entries.keys()]).not.toContain('utils.logic');
    expect([...entries.keys()]).toContain('app.logic');
  });

  it('does not pack manifest.json twice', async () => {
    // createBundleFromFiles writes the manifest from the parsed object, so the
    // file on disk must not be added alongside it.
    const bytes = await createBundleFromDirectory({ sourceDir: 'demo-bundle', outputPath: '' });
    const entries = await readBundleEntries(bytes);
    expect([...entries.keys()].filter((n) => n === 'manifest.json')).toHaveLength(1);
  });

  it('says which thing is missing', async () => {
    await expect(
      createBundleFromDirectory({ sourceDir: 'no-such-directory-here', outputPath: '' })
    ).rejects.toThrow(/Source directory not found/);

    const empty = mkdtempSync(join(tmpdir(), 'softn-empty-'));
    mkdirSync(join(empty, 'sub'), { recursive: true });
    writeFileSync(join(empty, 'sub', 'a.logic'), 'let a = 1\n');
    await expect(createBundleFromDirectory({ sourceDir: empty, outputPath: '' })).rejects.toThrow(
      /manifest\.json not found/
    );
  });
});
