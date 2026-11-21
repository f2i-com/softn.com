import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { computeBundleAppId, desktopBundleFiles, isSoftnPath } from '../src/bundleFile';

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

  it('a v2 web container, including full-stack backend and zero-config HTML bundles', () => {
    // A manifest declaring engine: 2 with an embedded PHP backend.
    const declared = zipSync({
      'manifest.json': strToU8(
        JSON.stringify({
          name: 'Kanban Board',
          version: '1.0.0',
          engine: 2,
          main: 'public/index.html',
          frontendRoot: 'public',
          backend: { runtime: 'php', entry: 'server/public/index.php', mode: 'api', routes: ['/api/'] },
        })
      ),
      'public/index.html': strToU8(page),
      'server/public/index.php': strToU8('<?php echo json_encode(["ok" => true]);'),
    });
    const opened = desktopBundleFiles(declared);
    expect(opened.isWebContainer).toBe(true);
    expect(opened.textFiles.has('public/index.html')).toBe(true);
    expect(opened.binaryFiles.has('server/public/index.php')).toBe(true);
    opened.binaryFiles.release();

    // A zero-config page with no manifest, at the root or wrapped in a folder.
    const rootPage = desktopBundleFiles(zipSync({ 'index.html': strToU8(page) }));
    expect(rootPage.isWebContainer).toBe(true);
    expect(rootPage.inferredManifest?.name).toBe('Plain Site');
    rootPage.binaryFiles.release();

    const wrappedPage = desktopBundleFiles(zipSync({ 'dist/index.html': strToU8(page), 'dist/app.js': strToU8('1') }));
    expect(wrappedPage.isWebContainer).toBe(true);
    expect(wrappedPage.inferredManifest?.main).toBe('index.html');
    wrappedPage.binaryFiles.release();
  });

  it('a SoftN bundle whose manifest only looks like a container’s is still SoftN’s', () => {
    for (const fields of [{ engine: '2' }, { engine: 1 }, { container: 1 }]) {
      const bundle = zipSync({
        'manifest.json': strToU8(JSON.stringify({ name: 'Page', version: '1.0.0', main: 'index.html', files: { ui: ['index.html'] }, ...fields })),
        'index.html': strToU8(page),
      });
      const result = desktopBundleFiles(bundle);
      expect(result.isWebContainer, JSON.stringify(fields)).toBe(false);
      expect(result.textFiles.has('index.html'), JSON.stringify(fields)).toBe(true);
      result.binaryFiles.release();
    }
  });
});
