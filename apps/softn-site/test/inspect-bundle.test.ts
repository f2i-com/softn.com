/**
 * The pre-publish report: what the directory will refuse, said first.
 */

import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { inspectBundle } from '../src/lib/inspectBundle';

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

const texts = (r: ReturnType<typeof inspectBundle>, level?: 'error' | 'warn') => r.report.filter((l) => !level || l.level === level).map((l) => l.text);

describe('inspectBundle', () => {
  it('reads a good bundle with nothing to refuse', () => {
    const r = inspectBundle(bundle(good));
    expect(r.problem).toBeNull();
    expect(r.name).toBe('Notes');
    expect(r.version).toBe('1.0.0');
    expect(r.main).toBe('ui/main.ui');
    expect(r.files).toBe(5);
    expect(r.capabilities).toEqual(['storage']);
    expect(r.storagePolicies).toEqual({ notes: 'private' });
    expect(r.iconDataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(texts(r, 'error')).toEqual([]);
  });

  it('refuses what is not an archive, has no manifest, or has a manifest that is not JSON', () => {
    expect(inspectBundle(ascii('not a zip at all')).problem).toMatch(/not a \.softn bundle/);
    expect(inspectBundle(bundle({ 'ui/main.ui': '<App/>' })).problem).toMatch(/no manifest\.json/);
    expect(inspectBundle(bundle({ 'manifest.json': '{ nope' })).problem).toMatch(/not valid JSON/);
  });

  it('refuses a manifest missing what the directory requires', () => {
    expect(inspectBundle(bundle({ ...good, 'manifest.json': manifest({ name: '' }) })).problem).toMatch(/no name/);
    expect(inspectBundle(bundle({ ...good, 'manifest.json': manifest({ version: undefined }) })).problem).toMatch(/no version/);
    expect(inspectBundle(bundle({ ...good, 'manifest.json': manifest({ main: undefined }) })).problem).toMatch(/names no entry file/);
    expect(inspectBundle(bundle({ ...good, 'manifest.json': manifest({ main: 'ui/missing.ui' }) })).problem).toMatch(/entry file is not in the bundle/);
  });

  it('refuses files the manifest lists but the bundle lacks', () => {
    const r = inspectBundle(bundle({ ...good, 'manifest.json': manifest({ files: { ui: ['ui/main.ui', 'ui/pages/Lost.ui'], logic: ['logic/main.logic'] } }) }));
    expect(r.problem).toMatch(/ui\/pages\/Lost\.ui/);
    expect(texts(inspectBundle(bundle({ ...good, 'manifest.json': manifest({ files: { ui: 'ui/main.ui' } }) })), 'error')).toEqual(['manifest.files.ui must be a list of paths.']);
    expect(texts(inspectBundle(bundle({ ...good, 'manifest.json': manifest({ files: { ui: ['ui/main.ui'], sounds: [] } }) })), 'warn')).toContainEqual(expect.stringMatching(/files\.sounds/));
  });

  it('refuses a declaration the directory would refuse, by name', () => {
    const notJson = inspectBundle(bundle({ ...good, 'permission.json': '{ "permissions": { "net": { "enabled": true }, } }' }));
    expect(notJson.problem).toMatch(/permission\.json is not valid JSON/);
    const unknown = inspectBundle(bundle({ ...good, 'permission.json': JSON.stringify({ permissions: { network: { enabled: true } } }) }));
    expect(unknown.problem).toMatch(/network/);
    expect(unknown.problem).toMatch(/accel/);
    const malformed = inspectBundle(bundle({ ...good, 'permission.json': JSON.stringify({ permissions: { net: { enabled: 'yes' } } }) }));
    expect(malformed.problem).toMatch(/"net" must be an object with a boolean "enabled"/);
    const badPolicy = inspectBundle(bundle({ ...good, 'permission.json': JSON.stringify({ permissions: { storage: { enabled: true, collections: { notes: 'readonly' } } } }) }));
    expect(badPolicy.problem).toMatch(/storage\.collections\.notes/);
    expect(badPolicy.problem).toMatch(/append-only/);
  });

  it('warns about what makes the listing worse without refusing it', () => {
    const r = inspectBundle(bundle({ ...good, 'manifest.json': manifest({ description: '', icon: 'assets/nope.png', config: { execution: 'thread' } }) }));
    expect(r.problem).toBeNull();
    const warns = texts(r, 'warn');
    expect(warns).toContainEqual(expect.stringMatching(/No description/));
    expect(warns).toContainEqual(expect.stringMatching(/icon the bundle does not have/));
    expect(warns).toContainEqual(expect.stringMatching(/config\.execution is "thread"/));
    expect(r.execution).toBe('main');
    const noPerm = inspectBundle(bundle({ 'manifest.json': manifest({ icon: undefined }), 'ui/main.ui': '<App/>', 'logic/main.logic': '' }));
    expect(texts(noPerm, 'warn')).toContainEqual(expect.stringMatching(/No permission\.json/));
    expect(texts(noPerm, 'warn')).toContainEqual(expect.stringMatching(/No icon/));
  });

  it('warns about large files, and refuses what will not fit', () => {
    const big = new Uint8Array(9 * 1024 * 1024);
    const r = inspectBundle(bundle({ ...good, 'assets/movie.bin': big }));
    expect(r.problem).toBeNull();
    expect(texts(r, 'warn')).toContainEqual(expect.stringMatching(/assets\/movie\.bin is 9\.0 MB/));
    expect(r.bytes).toBeGreaterThan(9 * 1024 * 1024);
  });

  it('refuses unsafe paths', () => {
    const r = inspectBundle(bundle({ ...good, '../escape.txt': 'x' }));
    expect(r.problem).toMatch(/unsafe path/);
  });
});
