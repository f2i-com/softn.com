import { describe, expect, it, vi } from 'vitest';
import { MAX_ZIP_ENTRIES, MAX_ZIP_FILE_BYTES, MAX_ZIP_INPUT_BYTES, openBundleArchive } from '@softn/bundle-format/zip';
import { detectWebContainer } from '@softn/runtime-shell/containerBundle';
import { readLocalWebFolder } from '../src/lib/localWebFolder';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function selected(path: string, content: string | number[] = '', overrideSize?: number) {
  const bytes = typeof content === 'string' ? encoder.encode(content) : Uint8Array.from(content);
  const arrayBuffer = vi.fn(async () => bytes.slice().buffer);
  return {
    file: { name: path.split('/').pop(), webkitRelativePath: path, size: overrideSize ?? bytes.length, arrayBuffer } as unknown as File,
    read: arrayBuffer,
  };
}

describe('opening a built web folder', () => {
  it('keeps nested assets and permission declarations, and gives the same app a stable identity', async () => {
    const files = [
      selected('dist/index.html', '<title>Counter</title><script type="module" src="/assets/main.js"></script>').file,
      selected('dist/assets/main.js', 'document.title = "Ready"').file,
      selected('dist/assets/tile.png', [0, 127, 255]).file,
      selected('dist/permission.json', '{"permissions":{}}').file,
      selected('dist/package.json', '{"type":"module"}').file,
    ];
    const { data, fileName } = await readLocalWebFolder(files);
    expect(fileName).toBe('dist.softn');
    const zip = openBundleArchive(data);
    expect(zip.names().sort()).toEqual(['assets/main.js', 'assets/tile.png', 'index.html', 'package.json', 'permission.json']);
    expect(zip.read('assets/tile.png')).toEqual(new Uint8Array([0, 127, 255]));
    expect(decoder.decode(zip.read('permission.json')!)).toBe('{"permissions":{}}');
    const index = decoder.decode(zip.read('index.html')!);
    expect(detectWebContainer(new Map([['index.html', index]])).inferredManifest?.name).toBe('Counter');
    expect((await readLocalWebFolder([...files].reverse())).data).toEqual(data);
    const changed = selected('dist/assets/main.js', 'document.title = "Newer"').file;
    expect((await readLocalWebFolder([files[0], changed, ...files.slice(2)])).data).not.toEqual(data);
  });

  it('keeps the Web App Manifest fields in the archive while making its entry explicit to the runtime', async () => {
    const manifest = { short_name: 'Counter', start_url: '/', icons: [{ src: '/icon.png' }], display: 'standalone' };
    const source = selected('Counter/manifest.json', JSON.stringify(manifest));
    const page = '<link rel="manifest" href="/manifest.json">';
    const { data } = await readLocalWebFolder([source.file, selected('Counter/index.html', page).file]);
    const zip = openBundleArchive(data);
    const text = decoder.decode(zip.read('manifest.json')!);
    expect(JSON.parse(text)).toEqual({ ...manifest, name: 'Counter', engine: 2, main: 'index.html' });
    expect(detectWebContainer(new Map([['manifest.json', text], ['index.html', page]])).isWebContainer).toBe(true);
    expect(source.read).toHaveBeenCalledTimes(1);
  });

  it('preserves an explicit web container manifest and its nested entry byte for byte', async () => {
    const manifest = '{ "engine": 2, "name": "Counter", "main": "pages/home.html" }';
    const { data } = await readLocalWebFolder([selected('app/pages/home.html').file, selected('app/manifest.json', manifest).file]);
    expect(decoder.decode(openBundleArchive(data).read('manifest.json')!)).toBe(manifest);
  });

  it.each([
    ['{"main":"ui/main.ui","name":"Older app"}', 'exported .softn'],
    ['{"description":"metadata belonging to an app"}', 'cannot identify'],
    ['{', 'valid JSON'],
    ['{"engine":2,"main":"missing.html"}', 'HTML entry'],
  ])('reports an incompatible manifest before reading the rest of the folder', async (manifest, reason) => {
    const page = selected('app/index.html');
    await expect(readLocalWebFolder([page.file, selected('app/manifest.json', manifest).file])).rejects.toThrow(reason);
    expect(page.read).not.toHaveBeenCalled();
  });

  it.each([
    'app/vite.config.ts', 'app/node_modules/lib/index.js', 'app/.git/config', 'app/config/.env.local', 'app/.npmrc',
    'app/../index.js', 'app/C:/index.js', 'app//index.js', 'app/assets\\index.js', 'other/index.html', 'app/index.html',
  ])('rejects a project root, unsafe path, or ambiguous selection before reading %s', async (path) => {
    const page = selected('app/index.html');
    const extra = selected(path);
    await expect(readLocalWebFolder([page.file, extra.file])).rejects.toThrow();
    expect(page.read).not.toHaveBeenCalled();
    expect(extra.read).not.toHaveBeenCalled();
  });

  it('checks the HTML entry, file count, individual size and total ZIP size before allocating', async () => {
    const page = selected('app/index.html');
    const tooBig = selected('app/asset.png', '', MAX_ZIP_FILE_BYTES + 1);
    await expect(readLocalWebFolder([])).rejects.toThrow('empty');
    await expect(readLocalWebFolder([selected('app/src/app.jsx').file])).rejects.toThrow('HTML entry');
    await expect(readLocalWebFolder(Array(MAX_ZIP_ENTRIES + 1).fill(page.file))).rejects.toThrow('too many');
    await expect(readLocalWebFolder([page.file, tooBig.file])).rejects.toThrow('file limit');
    const full = Array.from({ length: MAX_ZIP_INPUT_BYTES / MAX_ZIP_FILE_BYTES }, (_, i) =>
      selected(`app/asset-${i}.png`, '', MAX_ZIP_FILE_BYTES));
    await expect(readLocalWebFolder([page.file, ...full.map((f) => f.file)])).rejects.toThrow('archive limit');
    expect(page.read).not.toHaveBeenCalled();
    expect(tooBig.read).not.toHaveBeenCalled();
    for (const file of full) expect(file.read).not.toHaveBeenCalled();
  });
});
