/**
 * Round 4 (container host, archive reading): what an archive's own names, manifest paths and
 * litter come to, and the type of a blob the app's script made.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { ContainerArchive } from '../src/archive';
import { prepareHtmlDocument } from '../src/sanitize';

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const OTHER_PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9, 9, 9]);
const PERMS = { permissions: {} };

let minted: Blob[] = [];
let realCreate: typeof URL.createObjectURL | undefined;
beforeEach(() => {
  minted = [];
  realCreate = URL.createObjectURL;
  URL.createObjectURL = ((blob: Blob) => {
    minted.push(blob);
    return `blob:https://embedder.example/${minted.length}`;
  }) as typeof URL.createObjectURL;
});
afterEach(() => {
  if (realCreate) URL.createObjectURL = realCreate;
});

function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

function mount(archive: ContainerArchive, page = 'index.html'): HTMLElement {
  const prepared = prepareHtmlDocument(archive.readText(page)!, page, archive, PERMS, false);
  const viewport = document.createElement('div');
  prepared.mountInitialDom(viewport, new Map(), document.createElement('div'));
  return viewport;
}

describe('a file whose name has %, ? or # in it', () => {
  it('is read, handed to the Worker, drawn and linked to by its own name', async () => {
    const archive = await ContainerArchive.open(
      zipSync({
        'index.html': strToU8(
          '<!doctype html><img id="pct" src="img/100%25.png"><img id="q" src="img/what%3F.png">' +
            '<img id="hash" src="img/C%23.png"><img id="lit" src="img/a%2520b.png"><a id="go" href="sale%25.html">sale</a>'
        ),
        'sale%.html': strToU8('<!doctype html><p>sale</p>'),
        'img/100%.png': PNG,
        'img/what?.png': PNG,
        'img/C#.png': PNG,
        // A name with an escape in it, and the file that escape would read as.
        'img/a%20b.png': PNG,
        'img/a b.png': OTHER_PNG,
      })
    );
    for (const name of ['img/100%.png', 'img/what?.png', 'img/C#.png', 'img/a%20b.png']) {
      expect(archive.readBytes(name), name).toEqual(PNG);
      expect(archive.has(name), name).toBe(true);
    }
    // Read as its own name, never as the file its name would be the address of.
    expect(archive.readBytes('img/a b.png')).toEqual(OTHER_PNG);
    // An address is still read as one: `a%20b.png` is the address of `a b.png`.
    expect(archive.resolveExistingPath('img/a%20b.png')).toBe('img/a b.png');
    expect(archive.readText('sale%.html')).toContain('sale');

    const { binaryFiles } = archive.exportFrontendVfs();
    expect(Object.keys(binaryFiles).sort()).toEqual(['img/100%.png', 'img/C#.png', 'img/a b.png', 'img/a%20b.png', 'img/what?.png']);

    const viewport = mount(archive);
    for (const id of ['pct', 'q', 'hash', 'lit']) {
      expect(viewport.querySelector(`#${id}`)!.getAttribute('src'), id).toMatch(/^blob:https:\/\/embedder\.example\//);
    }
    // `#lit` is the file named `a%20b.png`, not `a b.png`.
    const litUrl = viewport.querySelector('#lit')!.getAttribute('src')!;
    expect(litUrl).not.toBe(archive.getBlobUrl('img/a b.png'));
    expect(await blobBytes(minted[Number(litUrl.slice(litUrl.lastIndexOf('/') + 1)) - 1])).toEqual(PNG);
    // A link keeps the page's path, written so that it reads back as that page.
    const href = viewport.querySelector('#go')!.getAttribute('href')!;
    expect(href).toBe('sale%25.html');
    expect(archive.resolveFrontendPath(`/${href}`)).toBe('sale%.html');
  });

  it('is listed at an address that reads back as it', async () => {
    const archive = await ContainerArchive.open({
      'index.html': '<!doctype html>',
      'docs/100%.html': '<!doctype html>',
      'docs/q?.html': '<!doctype html>',
      'C# notes/a.html': '<!doctype html>',
    });
    const files = archive.listVirtualDirectory('/docs');
    for (const entry of files) expect(archive.resolveFrontendPath(entry.urlPath), entry.urlPath).toBe(entry.path);
    const dir = archive.listVirtualDirectory('/').find((entry) => entry.name === 'C# notes')!;
    expect(dir.urlPath).toBe('/C%23 notes/');
    expect(archive.resolveFrontendPath(`${dir.urlPath}a.html`)).toBe('C# notes/a.html');
  });
});

describe('the paths manifest.json names', () => {
  it('are read as both servers read them: ./, backslashes and empty segments', async () => {
    const archive = await ContainerArchive.open({
      'manifest.json': JSON.stringify({ engine: 2, main: './app/index.html', frontendRoot: './app/' }),
      'app/index.html': '<!doctype html><p>home</p>',
      // A page that sorts before index.html: what the container started on when `main` named no file.
      'app/about.html': '<!doctype html><p>about</p>',
      'app/style.css': 'p{color:red}',
    });
    expect(archive.manifest.main).toBe('app/index.html');
    expect(archive.manifest.frontendRoot).toBe('app');
    expect(archive.isFrontendPath('app/style.css')).toBe(true);
    expect(archive.resolveFrontendPath('/style.css')).toBe('app/style.css');
  });

  it('name the backend entry and root the same way', async () => {
    const archive = await ContainerArchive.open({
      'manifest.json': JSON.stringify({
        engine: 2,
        main: 'public\\index.html',
        frontendRoot: 'public',
        backend: { runtime: 'php', entry: './backend//public/index.php', root: './backend/' },
      }),
      'public/index.html': '<!doctype html>',
      'backend/public/index.php': '<?php echo 1;',
    });
    expect(archive.manifest.main).toBe('public/index.html');
    expect(archive.manifest.backend?.entry).toBe('backend/public/index.php');
    expect(archive.manifest.backend?.root).toBe('backend');
    expect(archive.isFrontendPath('backend/public/index.php')).toBe(false);
  });
});

describe('what a Mac puts in a folder it compressed', () => {
  it('is not an app file, and does not keep the folder from being the app', async () => {
    const appleDouble = new Uint8Array([0, 5, 22, 7, 0, 2, 0, 0]);
    const archive = await ContainerArchive.open(
      zipSync({
        'site/index.html': strToU8('<!doctype html><script type="module" src="/assets/app.js"></script>'),
        'site/assets/app.js': strToU8('console.log(1)'),
        'site/.DS_Store': new Uint8Array([0, 0, 0, 1]),
        '__MACOSX/site/._index.html': appleDouble,
        '__MACOSX/site/assets/._app.js': appleDouble,
        '.DS_Store': new Uint8Array([0, 0, 0, 1]),
      })
    );
    expect(archive.manifest.main).toBe('index.html');
    expect(archive.names().sort()).toEqual(['assets/app.js', 'index.html']);
    expect(archive.resolveFrontendExistingPath('/assets/app.js')).toBe('assets/app.js');
  });

  it('is not the page an app with a lower-case folder runs', async () => {
    const archive = await ContainerArchive.open({
      'myapp/index.html': '<!doctype html><p>home</p>',
      '__MACOSX/myapp/._index.html': new Uint8Array([0, 5, 22, 7]),
    });
    expect(archive.manifest.main).toBe('index.html');
    expect(archive.readText(archive.manifest.main)).toContain('home');
  });
});

describe('a disposed archive', () => {
  it('reads nothing, and holds none of the text it decoded', async () => {
    const archive = await ContainerArchive.open(zipSync({ 'index.html': strToU8('<!doctype html>'), 'app.js': strToU8('console.log(1)') }));
    expect(archive.readText('app.js')).toBe('console.log(1)');
    archive.dispose();
    expect(archive.readText('app.js')).toBeNull();
    expect(archive.readText('index.html')).toBeNull();
    expect(Object.keys(archive.exportFrontendVfs().textFiles)).toEqual([]);
  });
});

describe('a blob the app made an address for', () => {
  it('keeps its type when the type is written with parameters', async () => {
    const archive = await ContainerArchive.open({ 'index.html': '<!doctype html>' });
    const svg = strToU8('<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(archive.putRuntimeBlob('b1-svg', 'image/svg+xml;charset=utf-8', svg)).toBe(true);
    // A drawing is handed to the page as a picture, which it is drawn as.
    expect(archive.getRuntimeBlobUrl('b1-svg')).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(archive.getRuntimeBlob('b1-svg')?.type).toBe('image/svg+xml');

    expect(archive.putRuntimeBlob('b2-rec', 'audio/webm;codecs=opus', new Uint8Array([26, 69, 223, 163]))).toBe(true);
    expect(archive.getRuntimeBlob('b2-rec')?.type).toBe('audio/webm');
    archive.getRuntimeBlobUrl('b2-rec');
    expect(minted[minted.length - 1].type).toBe('audio/webm');

    // Still nothing but a type: anything else is bytes of no kind.
    expect(archive.putRuntimeBlob('b3-bad', 'text/html"><x', new Uint8Array([1]))).toBe(true);
    expect(archive.getRuntimeBlob('b3-bad')?.type).toBe('application/octet-stream');
  });
});
