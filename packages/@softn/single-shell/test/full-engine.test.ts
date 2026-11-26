/**
 * Whether an app needs the full engine is a question about its code, and is
 * answered from its code alone. A bundle's text entries are decoded when
 * first read (runtime-shell's bundleFiles); the check went through every
 * entry with its text, so the first app a page opened had all of a large
 * data file decoded at load for nothing.
 */
import { expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { readZip } from '@softn/runtime-shell/bundleFiles';
import { needsFullEngine } from '../src/assemble';

/** The bundle's text files, telling which of them were read. */
function watched(files: Record<string, string>) {
  const { textFiles, archive } = readZip(zipSync(Object.fromEntries(Object.entries(files).map(([path, text]) => [path, strToU8(text)]))));
  const read = new Set<string>();
  const get = textFiles.get.bind(textFiles);
  textFiles.get = (path: string) => {
    read.add(path);
    return get(path);
  };
  return { textFiles, read, archive };
}

const JAVASCRIPT = { languages: ['javascript'], source: '<p>{n}</p>' };

it('reads the code files and not the data beside them', () => {
  const { textFiles, read, archive } = watched({
    'manifest.json': '{"name":"x","main":"main.ui"}',
    'main.ui': '<p>{n}</p>',
    'logic/main.logic': 'let n = 1',
    'data/catalog.json': JSON.stringify(Array.from({ length: 2000 }, (_, i) => ({ id: i, name: `item ${i}` }))),
    'notes.txt': 'kept for later',
  });
  expect(needsFullEngine(JAVASCRIPT, textFiles)).toBe(false);
  expect([...read].sort()).toEqual(['logic/main.logic', 'main.ui']);
  // The data file is still in the archive, not decoded.
  expect(archive.isRead('data/catalog.json')).toBe(false);
});

it('still finds what the lite engine lacks, in any code file', () => {
  const { textFiles } = watched({
    'main.ui': '<p>{n}</p>',
    'logic/format.js': 'export const price = (n) => n.toLocaleString("en")',
  });
  expect(needsFullEngine(JAVASCRIPT, textFiles)).toBe(true);
  expect(needsFullEngine({ languages: ['javascript', 'python'], source: '' }, new Map())).toBe(true);
  expect(needsFullEngine(JAVASCRIPT, new Map([['logic/main.py', 'x = 1']]))).toBe(true);
  expect(needsFullEngine({ languages: ['javascript'], source: '<p>{new Intl.NumberFormat().format(n)}</p>' }, new Map())).toBe(true);
});
