import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import {
  createBundle,
  validateBundleBytes,
  validateBundleEntries,
  validateBundlePath,
  openBundleArchive,
} from '../src/index';

describe('BundleBuilder and Bundle Validation SDK (@softn/bundle-format)', () => {
  it('validates bundle entry paths and rejects path traversal, drive letters, and reserved segments', () => {
    expect(validateBundlePath('public/index.html')).toBeNull();
    expect(validateBundlePath('backend/src/App.php')).toBeNull();
    expect(validateBundlePath('../escape.txt')).toBeTypeOf('string');
    expect(validateBundlePath('/etc/passwd')).toBeTypeOf('string');
    expect(validateBundlePath('a\\b.txt')).toBeTypeOf('string');
    expect(validateBundlePath('C:/windows/win.ini')).toBeTypeOf('string');
    expect(validateBundlePath('dir/../secret.sql')).toBeTypeOf('string');
    expect(validateBundlePath('bad\0name.txt')).toBeTypeOf('string');
  });

  it('builds a validated full-stack v2 .softn archive with deterministic SHA-256 fingerprint, permissions, and migrations', async () => {
    const dbBytes = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00]);
    const builder = createBundle({
      manifest: {
        engine: 2,
        id: 'acme-orders',
        name: 'Acme Orders',
        version: '1.2.0',
        frontendRoot: 'public',
        main: 'public/index.html',
        backend: {
          runtime: 'php',
          mode: 'api',
          entry: 'backend/index.php',
          routes: ['/api/'],
          phpMode: 'sapi',
        },
        databases: [
          {
            name: 'app',
            engine: 'sqlite',
            file: 'db/app.db',
            schemaVersion: 2,
            migrations: [
              { version: 2, file: 'backend/migrations/002.sql', description: 'Add status index' },
            ],
            persist: true,
          },
        ],
      },
      permissions: {
        permissions: {
          files: { enabled: true },
        },
      },
    });

    builder
      .addText('public/index.html', '<!doctype html><html><body><div id="root"></div></body></html>')
      .addText('backend/index.php', '<?php echo json_encode(["ok" => true]);')
      .addText('backend/migrations/002.sql', 'CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);')
      .addBinary('db/app.db', dbBytes)
      .addJson('public/config.json', { theme: 'dark' });

    expect(builder.has('public/index.html')).toBe(true);
    expect(builder.listFiles()).toContain('public/index.html');
    expect(builder.listFiles()).toContain('backend/index.php');

    const preValidation = builder.validate();
    expect(preValidation.valid).toBe(true);
    expect(preValidation.errors).toEqual([]);

    const built = await builder.build({ strict: true });
    expect(built.size).toBe(built.bytes.byteLength);
    expect(built.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(built.fileCount).toBeGreaterThanOrEqual(7);
    expect(built.validation.valid).toBe(true);
    expect(built.inspection.backendRuntime).toBe('php');

    // Re-open and validate serialized ZIP bytes
    const archive = openBundleArchive(built.bytes);
    try {
      expect(archive.names()).toContain('db/app.db');
      expect(archive.read('db/app.db')).toEqual(dbBytes);
      expect(JSON.parse(new TextDecoder().decode(archive.read('manifest.json')!))).toMatchObject({
        id: 'acme-orders',
        version: '1.2.0',
      });
    } finally {
      archive.release();
    }

    const byteValidation = validateBundleBytes(built.bytes);
    expect(byteValidation.valid).toBe(true);
    expect(byteValidation.errors).toEqual([]);
  });

  it('rejects missing entry files, unknown permissions, invalid migrations, and hostile paths', () => {
    const missingMain = validateBundleEntries({
      'manifest.json': strToU8(JSON.stringify({ engine: 2, name: 'Broken', main: 'public/missing.html' })),
    });
    expect(missingMain.valid).toBe(false);
    expect(missingMain.errors.some((e) => /missing\.html|start file|main/i.test(e))).toBe(true);

    const badPerms = validateBundleEntries({
      'manifest.json': strToU8(JSON.stringify({ engine: 2, name: 'BadPerm', main: 'index.html' })),
      'index.html': strToU8('<p>hi</p>'),
      'permission.json': strToU8(JSON.stringify({ permissions: { 'root-shell': { enabled: true } } })),
    });
    expect(badPerms.valid).toBe(false);
    expect(badPerms.errors.some((e) => /root-shell|capabilit/i.test(e))).toBe(true);

    const badMigration = validateBundleEntries({
      'manifest.json': strToU8(
        JSON.stringify({
          engine: 2,
          name: 'BadMig',
          main: 'index.html',
          databases: [
            {
              name: 'app',
              file: 'db/app.db',
              schemaVersion: 2,
              migrations: [
                { version: 2, file: 'migrations/missing.sql' },
                { version: 2, sql: 'SELECT 1;' },
              ],
            },
          ],
        })
      ),
      'index.html': strToU8('<p>hi</p>'),
    });
    expect(badMigration.valid).toBe(false);
    expect(badMigration.errors.some((e) => /duplicate|missing/i.test(e))).toBe(true);

    // Hostile ZIP bytes (traversal path)
    const hostileZip = zipSync({
      'manifest.json': strToU8(JSON.stringify({ engine: 2, name: 'Hostile', main: 'index.html' })),
      'index.html': strToU8('<p>hi</p>'),
      '../evil.txt': strToU8('nope'),
    });
    const hostileRes = validateBundleBytes(hostileZip);
    expect(hostileRes.valid).toBe(false);
  });
});
