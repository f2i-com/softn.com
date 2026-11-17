/**
 * Which archives are web containers, the unwrapping of one zipped as its folder, and the
 * files of the container's folder an app is run with.
 */
import { describe, expect, it } from 'vitest';
import { detectWebContainer, unwrapContainerZipEntries } from '../src/containerBundle';
import { hostedContainerFiles } from '../src/containerHost';
import type { BundleBinaryStore } from '../src/bundleProcessor';

/** An archive's text files as readZip gives them: decoded when read, and counted here. */
class CountingTexts extends Map<string, string> {
  readonly read: string[] = [];
  override get(key: string): string | undefined {
    this.read.push(key);
    return super.get(key);
  }
}

function binaries(names: string[] = []): BundleBinaryStore {
  const held = new Map(names.map((name) => [name, new Uint8Array([1])] as const));
  const store: BundleBinaryStore = {
    get: (p) => held.get(p),
    has: (p) => held.has(p),
    keys: () => held.keys(),
    get size() {
      return held.size;
    },
    declaredSize: (p) => held.get(p)?.byteLength,
    isRead: () => false,
    release: () => undefined,
    entries: () => held.entries(),
    forEach: (cb) => held.forEach((b, p) => cb(b, p, store)),
    [Symbol.iterator]: () => held.entries(),
  };
  return store;
}

const PAGE = '<!doctype html><html><head><title>Wrapped Site</title></head><body><script src="./app.js"></script></body></html>';

describe('an archive zipped as its folder', () => {
  it('is read through to its files without any of them being decoded', () => {
    const texts = new CountingTexts([
      ['dist/index.html', PAGE],
      ['dist/app.js', 'document.title = "x";'],
      ['dist/data/big-1.json', ' '.repeat(1000)],
      ['dist/data/big-2.json', ' '.repeat(1000)],
    ]);
    const { textFiles, binaryFiles, unwrappedPrefix } = unwrapContainerZipEntries(texts, binaries(['dist/logo.png']));
    expect(unwrappedPrefix).toBe('dist/');
    // v0.0.44 copied every entry into a plain Map here, which decoded all of them: 445 MB of
    // text for a 451 KB archive of nine large files, before the app had started.
    expect(texts.read).toEqual([]);
    expect([...textFiles.keys()].sort()).toEqual(['app.js', 'data/big-1.json', 'data/big-2.json', 'index.html']);
    expect(textFiles.size).toBe(4);
    expect(textFiles.has('index.html')).toBe(true);
    expect(textFiles.has('dist/index.html')).toBe(false);
    expect(binaryFiles.has('logo.png')).toBe(true);
    expect(texts.read).toEqual([]);

    // Deciding what the archive is reads its page, and nothing else.
    const detected = detectWebContainer(textFiles, (p) => binaryFiles.has(p), 'site.zip');
    expect(detected).toMatchObject({ isWebContainer: true, inferredManifest: { name: 'Wrapped Site', main: 'index.html' } });
    expect(texts.read).toEqual(['dist/index.html']);
    expect(textFiles.get('app.js')).toBe('document.title = "x";');
    expect(textFiles.get('missing.js')).toBeUndefined();
    expect(texts.read).toEqual(['dist/index.html', 'dist/app.js']);
  });

  it('is a Map to whoever holds it: it can be added to, taken from and walked', () => {
    const texts = new CountingTexts([
      ['site/index.html', PAGE],
      ['site/app.js', 'a'],
    ]);
    const { textFiles } = unwrapContainerZipEntries(texts, binaries());
    expect(textFiles).toBeInstanceOf(Map);
    textFiles.set('manifest.json', '{"engine":2}');
    expect(textFiles.get('manifest.json')).toBe('{"engine":2}');
    expect(textFiles.size).toBe(3);
    // What was put into the view is not looked for in the archive.
    expect(texts.read).toEqual([]);
    expect(textFiles.delete('app.js')).toBe(true);
    expect(textFiles.has('app.js')).toBe(false);
    expect(textFiles.get('app.js')).toBeUndefined();
    expect(Object.fromEntries(textFiles)).toEqual({ 'index.html': PAGE, 'manifest.json': '{"engine":2}' });
    expect([...textFiles.values()]).toEqual([PAGE, '{"engine":2}']);
    const seen: string[] = [];
    textFiles.forEach((_value, key) => seen.push(key));
    expect(seen).toEqual(['index.html', 'manifest.json']);
    textFiles.clear();
    expect(textFiles.size).toBe(0);
  });

  it('is left as it is when its files are at the root, or the folder is not the whole of it', () => {
    const flat = new CountingTexts([['index.html', PAGE]]);
    expect(unwrapContainerZipEntries(flat, binaries()).textFiles).toBe(flat);
    const withManifest = new CountingTexts([
      ['manifest.json', '{}'],
      ['dist/index.html', PAGE],
    ]);
    expect(unwrapContainerZipEntries(withManifest, binaries()).unwrappedPrefix).toBeNull();
    const twoFolders = new CountingTexts([
      ['a/index.html', PAGE],
      ['b/index.html', PAGE],
    ]);
    expect(unwrapContainerZipEntries(twoFolders, binaries()).unwrappedPrefix).toBeNull();
    // A folder with no page and no manifest is not an app's folder.
    const notes = new CountingTexts([['notes/readme.md', '# notes']]);
    expect(unwrapContainerZipEntries(notes, binaries()).unwrappedPrefix).toBeNull();
  });

  it('does not take a SoftN bundle’s own ui/ folder for a wrapper, as the container does not', () => {
    // ui/ is where a SoftN bundle keeps its pages. Unwrapped, the page beside main.ui was at
    // the root, and the host called a web container what the container then ran as SoftN's.
    const bundle = new CountingTexts([
      ['ui/main.ui', '<App><Text>hello</Text></App>'],
      ['ui/index.html', PAGE],
    ]);
    const read = unwrapContainerZipEntries(bundle, binaries());
    expect(read.unwrappedPrefix).toBeNull();
    expect(read.textFiles).toBe(bundle);
    expect(detectWebContainer(read.textFiles).isWebContainer).toBe(false);
    // A site whose one folder happens to be called ui/ is still a site.
    const site = new CountingTexts([['ui/index.html', PAGE], ['ui/app.js', '1']]);
    expect(unwrapContainerZipEntries(site, binaries()).unwrappedPrefix).toBe('ui/');
  });
});

describe('which engine runs a bundle', () => {
  const manifest = (fields: Record<string, unknown>) =>
    new Map([
      ['manifest.json', JSON.stringify({ name: 'App', version: '1.0.0', main: 'index.html', ...fields })],
      ['index.html', PAGE],
    ]);

  it('a manifest says so, by "engine": 2', () => {
    expect(detectWebContainer(manifest({ engine: 2 })).isWebContainer).toBe(true);
    // JSON has one kind of number: 2.0 is 2.
    expect(detectWebContainer(new Map([['manifest.json', '{"name":"A","version":"1","main":"index.html","engine":2.0}'], ['index.html', PAGE]])).isWebContainer).toBe(true);
    expect(detectWebContainer(manifest({ container: true })).isWebContainer).toBe(true);
    for (const fields of [{}, { engine: '2' }, { engine: [2] }, { engine: 1 }, { container: 1 }]) {
      expect(detectWebContainer(manifest(fields)).isWebContainer, JSON.stringify(fields)).toBe(false);
    }
  });

  it('an archive with no manifest is a web container when it has a page', () => {
    expect(detectWebContainer(new Map([['index.html', PAGE]])).isWebContainer).toBe(true);
    expect(detectWebContainer(new Map([['readme.md', '# notes']])).isWebContainer).toBe(false);
    // The first page by name, as every other reader has it.
    expect(detectWebContainer(new Map([['b.html', PAGE], ['a.html', PAGE]])).inferredManifest?.main).toBe('a.html');
  });
});

describe('the files of the container’s folder an app is run with', () => {
  const container = {
    engineFileFor: (tier: string) => `zipp-${tier === 'lite' ? 'javascript-lite' : tier}.wasm`,
    glueFileFor: (tier: string, meta: Record<string, unknown> | null) =>
      meta?.variant === 'javascript-python-base' ? 'zipp-python-base.glue.js' : `zipp-${tier === 'lite' ? 'javascript-lite' : tier}.glue.js`,
  };
  const FOLDER = 'https://softn.test/shared/container-runtime/e03138f892dd/';
  const names = (tiers: Parameters<typeof hostedContainerFiles>[0]) =>
    hostedContainerFiles(tiers, container, FOLDER).map((url) => url.slice(FOLDER.length)).sort();

  it('are the Worker, and for the two engines only the container has, the engine and its bindings', () => {
    expect(names(['lite'])).toEqual(['container-worker.js', 'engines/zipp-javascript-lite.glue.js', 'engines/zipp-javascript-lite.wasm']);
    expect(names(['typescript'])).toEqual(['container-worker.js', 'engines/zipp-typescript.glue.js', 'engines/zipp-typescript.wasm']);
  });

  it('are the Worker and core’s engine’s bindings alone, for a tier that runs on the engine the page has', () => {
    for (const tier of ['javascript', 'python', 'python-torch'] as const) {
      expect(names([tier]), tier).toEqual(['container-worker.js', 'engines/zipp-python-base.glue.js']);
    }
  });

  it('name each file once for an app on several tiers, and the Worker alone for none', () => {
    expect(names(['lite', 'javascript', 'python'])).toEqual([
      'container-worker.js',
      'engines/zipp-javascript-lite.glue.js',
      'engines/zipp-javascript-lite.wasm',
      'engines/zipp-python-base.glue.js',
    ]);
    expect(names([])).toEqual(['container-worker.js']);
  });
});
