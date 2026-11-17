import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { WebContainerNotRunHereError, computeBundleAppId, desktopBundleFiles, isSoftnPath } from '../src/bundleFile';

describe('a .softn file on the desktop', () => {
  it('uses deterministic content identity rather than a manifest display name', async () => {
    const first = await computeBundleAppId(new Uint8Array([1, 2, 3]));
    const same = await computeBundleAppId(new Uint8Array([1, 2, 3]));
    const different = await computeBundleAppId(new Uint8Array([1, 2, 4]));

    expect(first).toMatch(/^bundle-[0-9a-f]{64}$/);
    // The digest the native side computes for the same bytes (data_identity.rs, bundle_digest).
    expect(first).toBe('bundle-039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81');
    expect(same).toBe(first);
    expect(different).not.toBe(first);
  });

  it('hashes only the bytes a view covers, not the buffer under it', async () => {
    const buffer = new Uint8Array([9, 1, 2, 3, 9]);
    expect(await computeBundleAppId(buffer.subarray(1, 4))).toBe(await computeBundleAppId(new Uint8Array([1, 2, 3])));
  });

  it('recognizes app files regardless of extension casing', () => {
    expect(isSoftnPath('C:\\Apps\\Fieldnotes.SOFTN')).toBe(true);
    expect(isSoftnPath('C:\\Apps\\Fieldnotes.softn.zip')).toBe(false);
  });
});

describe('which bundles the desktop runs', () => {
  const softn = {
    'manifest.json': strToU8(JSON.stringify({ name: 'Fieldnotes', version: '1.0.0', main: 'ui/main.ui', files: { ui: ['ui/main.ui'] } })),
    'ui/main.ui': strToU8('<App><Text>Hi</Text></App>'),
  };
  const page = '<!doctype html><html><head><title>Plain Site</title></head><body><script>document.title = "x";</script></body></html>';

  it('a SoftN bundle, read through to its files, at the root of the archive or zipped as its folder', () => {
    const flat = desktopBundleFiles(zipSync(softn));
    expect([...flat.textFiles.keys()].sort()).toEqual(['manifest.json', 'ui/main.ui']);
    // The folder was zipped, not its files: looked inside, as the browser runtime does. The
    // loader answered "The bundle has no manifest.json".
    const wrapped = desktopBundleFiles(zipSync({ 'Fieldnotes/manifest.json': softn['manifest.json'], 'Fieldnotes/ui/main.ui': softn['ui/main.ui'] }));
    expect([...wrapped.textFiles.keys()].sort()).toEqual(['manifest.json', 'ui/main.ui']);
    expect(wrapped.textFiles.get('ui/main.ui')).toBe('<App><Text>Hi</Text></App>');
  });

  it('not a web container, and says what the file is rather than running its page on SoftN’s engine', () => {
    // A manifest that says so.
    const declared = zipSync({
      'manifest.json': strToU8(JSON.stringify({ name: 'Kanban  Board', version: '1.0.0', engine: 2, main: 'index.html' })),
      'index.html': strToU8(page),
    });
    expect(() => desktopBundleFiles(declared)).toThrow(WebContainerNotRunHereError);
    expect(() => desktopBundleFiles(declared)).toThrow(/^“Kanban Board” is a web app: plain HTML, CSS and scripts.*Open the file in SoftN Web in a browser/);
    // A page and no manifest, at the root or in a folder: named by the page's title.
    expect(() => desktopBundleFiles(zipSync({ 'index.html': strToU8(page) }))).toThrow(/^“Plain Site” is a web app/);
    expect(() => desktopBundleFiles(zipSync({ 'dist/index.html': strToU8(page), 'dist/app.js': strToU8('1') }))).toThrow(/^“Plain Site” is a web app/);
    // A page with no title still gets a sentence.
    expect(() => desktopBundleFiles(zipSync({ 'home.html': strToU8('<p>hi</p>') }))).toThrow(/ is a web app/);
  });

  it('a SoftN bundle whose manifest only looks like a container’s is still SoftN’s', () => {
    for (const fields of [{ engine: '2' }, { engine: 1 }, { container: 1 }]) {
      const bundle = zipSync({
        'manifest.json': strToU8(JSON.stringify({ name: 'Page', version: '1.0.0', main: 'index.html', files: { ui: ['index.html'] }, ...fields })),
        'index.html': strToU8(page),
      });
      expect(desktopBundleFiles(bundle).textFiles.has('index.html'), JSON.stringify(fields)).toBe(true);
    }
  });
});
