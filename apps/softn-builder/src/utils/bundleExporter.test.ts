/**
 * Opening a bundle in the builder.
 *
 * `parseBundle` used a bare `unzipSync`: no size limits, no entry cap, no CRC
 * check, no path filtering. Opening a hostile .softn in the builder bypassed
 * every defence softn-web and softn-loader had — including the check that
 * catches an archive understating a file's size, which hands one reader a
 * truncated file while every other reader sees the whole one.
 */

import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { parseBundle } from './bundleExporter';

function bundle(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) entries[k] = strToU8(v);
  return zipSync(entries, { level: 6 });
}

const MANIFEST = JSON.stringify({
  name: 'T',
  version: '1.0.0',
  description: '',
  main: 'ui/main.ui',
  files: { ui: ['ui/main.ui'], logic: [], xdb: [], assets: [] },
  config: { window: { title: 'T', width: 1, height: 1 }, theme: { mode: 'light' } },
});

describe('parseBundle', () => {
  it('reads an ordinary bundle', () => {
    const { manifest, files } = parseBundle(
      bundle({ 'manifest.json': MANIFEST, 'ui/main.ui': '<Stack></Stack>' })
    );
    expect(manifest.name).toBe('T');
    expect(files.has('ui/main.ui')).toBe(true);
  });

  it('rejects an archive whose checksum does not match its bytes', () => {
    // Stored rather than deflated, so the content sits in the file verbatim and
    // a single byte can be flipped without disturbing any header. The declared
    // CRC in the central directory is left untouched — which is exactly the
    // shape of the attack: an archive that lies self-consistently about its
    // own contents, so only the checksum catches it.
    const entries: Record<string, Uint8Array> = {
      'manifest.json': strToU8(MANIFEST),
      'ui/main.ui': strToU8('<Stack>MARKERMARKER</Stack>'),
    };
    const data = zipSync(entries, { level: 0 });

    const marker = strToU8('MARKERMARKER');
    const at = data.findIndex((_b, i) => marker.every((m, j) => data[i + j] === m));
    expect(at, 'the stored content should be findable').toBeGreaterThan(0);

    const tampered = new Uint8Array(data);
    tampered[at] = tampered[at] ^ 0xff;

    expect(() => parseBundle(tampered)).toThrow(/checksum|Corrupt/i);
  });

  it('drops entries that try to escape the bundle root', () => {
    const { files } = parseBundle(
      bundle({
        'manifest.json': MANIFEST,
        'ui/main.ui': '<Stack></Stack>',
        '../escape.txt': 'nope',
      })
    );
    expect([...files.keys()].some((k) => k.includes('..'))).toBe(false);
  });
});
