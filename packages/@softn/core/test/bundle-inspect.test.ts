/**
 * The bundle inspector: what the directory will refuse, said first.
 */

import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { inspectBundle, inspectEntries } from '../src/bundle/inspect';

const ascii = (text: string) => strToU8(text, true);

function bundle(files: Record<string, string | Uint8Array>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) entries[k] = typeof v === 'string' ? ascii(v) : v;
  return zipSync(entries);
}

const manifest = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ name: 'Notes', version: '1.0.0', description: 'A notebook', main: 'ui/main.ui', icon: 'assets/icon.svg', files: { ui: ['ui/main.ui'], logic: ['logic/main.logic'] }, ...over });

const good = {
  'manifest.json': manifest(),
  'ui/main.ui': '<App/>',
  'logic/main.logic': 'let x = 1',
  'assets/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  'permission.json': JSON.stringify({ permissions: { storage: { enabled: true, collections: { notes: 'private' } } } }),
};

const errors = (r: ReturnType<typeof inspectBundle>) => r.report.filter((l) => l.level === 'error').map((l) => l.text);
const warns = (r: ReturnType<typeof inspectBundle>) => r.report.filter((l) => l.level === 'warn').map((l) => l.text);

describe('inspectBundle', () => {
  it('reads a good bundle with nothing to refuse', () => {
    const r = inspectBundle(bundle(good));
    expect(r.problem).toBeNull();
    expect(r.name).toBe('Notes');
    expect(r.main).toBe('ui/main.ui');
    expect(r.files).toBe(5);
    expect(r.capabilities).toEqual(['storage']);
    expect(r.storagePolicies).toEqual({ notes: 'private' });
    expect(r.iconDataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(errors(r)).toEqual([]);
  });

  it('refuses what is not an archive, has no manifest, or has no entry', () => {
    expect(inspectBundle(ascii('not a zip')).problem).toMatch(/not a \.softn bundle/);
    expect(inspectBundle(bundle({ 'ui/main.ui': '<App/>' })).problem).toMatch(/no manifest\.json/);
    expect(inspectBundle(bundle({ ...good, 'manifest.json': manifest({ main: undefined }) })).problem).toMatch(/names no entry file/);
    expect(inspectBundle(bundle({ ...good, 'manifest.json': manifest({ main: 'ui/missing.ui' }) })).problem).toMatch(/entry file is not in the bundle/);
  });

  it('refuses a declaration the runtime could not honour, by name', () => {
    const unknown = inspectBundle(bundle({ ...good, 'permission.json': JSON.stringify({ permissions: { network: { enabled: true } } }) }));
    expect(unknown.problem).toMatch(/network/);
    const badPolicy = inspectBundle(bundle({ ...good, 'permission.json': JSON.stringify({ permissions: { storage: { enabled: true, collections: { notes: 'readonly' } } } }) }));
    expect(badPolicy.problem).toMatch(/storage\.collections\.notes/);
  });

  it('warns about what makes a listing worse without refusing', () => {
    const r = inspectBundle(bundle({ ...good, 'manifest.json': manifest({ description: '', icon: undefined }) }));
    expect(r.problem).toBeNull();
    expect(warns(r)).toContainEqual(expect.stringMatching(/No description/));
    expect(warns(r)).toContainEqual(expect.stringMatching(/No icon/));
  });

  it('inspects files it is handed without zipping them first', () => {
    const entries = new Map<string, Uint8Array>();
    for (const [k, v] of Object.entries(good)) entries.set(k, ascii(v));
    const r = inspectEntries(entries);
    expect(r.problem).toBeNull();
    expect(r.files).toBe(5);
    expect(inspectEntries(null).problem).toMatch(/not a \.softn bundle/);
  });
});
