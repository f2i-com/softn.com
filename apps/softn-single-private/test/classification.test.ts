import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { ASSET_CLASSIFICATIONS } from '@softn/core';

/**
 * The PHP host carries its own copy of core's extension registry, because it
 * cannot import the TypeScript one. This holds the two equal, so an extension
 * added to core is served under the same MIME type, and packed or served on
 * the same side, as every other reader classifies it.
 */
function phpTable(): Record<string, { mime: string; kind: string }> {
  const source = readFileSync(
    fileURLToPath(new URL('../public/softn-serve.php', import.meta.url)),
    'utf8'
  );
  const block = source.match(/const SOFTN_ENTRY_TYPES = \[([\s\S]*?)\n\];/);
  expect(block).not.toBeNull();
  const table: Record<string, { mime: string; kind: string }> = {};
  for (const row of block![1].matchAll(/'([a-z0-9]+)' => \['([^']+)', '([a-z]+)'\]/g)) {
    table[row[1]] = { mime: row[2], kind: row[3] };
  }
  return table;
}

it('classifies every extension the way @softn/core does', () => {
  const php = phpTable();
  const core = Object.fromEntries(
    Object.entries(ASSET_CLASSIFICATIONS).map(([ext, c]) => [ext, { mime: c.mime, kind: c.kind }])
  );
  expect(php).toEqual(core);
});

it('packs exactly the entries core reads as text, apart from the two text-form models', () => {
  // Kind `text` goes in the source pack; gltf and obj are text to core's
  // reader but models to the host, fetched on demand like a .glb, because a
  // model of tens of megabytes has no place in the JSON the app boots from.
  const php = phpTable();
  for (const [ext, c] of Object.entries(ASSET_CLASSIFICATIONS)) {
    const packed = php[ext].kind === 'text';
    expect(packed, ext).toBe(!c.binary && c.kind === 'text');
  }
});
