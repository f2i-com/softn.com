import { describe, expect, it } from 'vitest';
import { lintTemplates } from '../src/lib/agent/appCheck';
import { buildGuide } from '../src/lib/agent/guide';
import { bareAssetPaths, createPreviewAssetResolver } from '../src/lib/previewAssets';
import type { VFSFile } from '../src/types/studio';

const file = (path: string, content: string | Uint8Array): VFSFile => ({
  path, content, mimeType: 'application/octet-stream', lastModified: 1,
  lastModifiedBy: 'user', version: 1,
});

describe('Studio bundle asset previews', () => {
  it('renders assets outside assets/ with the same MIME classification as the runtime', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Portable</text></svg>';
    const files = new Map([
      ['images/logo.svg', file('images/logo.svg', svg)],
      ['media/voice.wav', file('media/voice.wav', new Uint8Array([82, 73, 70, 70]))],
      ['images/photo.webp', file('images/photo.webp', new Uint8Array([1, 2, 3]))],
    ]);
    const resolve = createPreviewAssetResolver(files, 'ui/main.ui');
    expect(resolve('images/logo.svg')).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    expect(resolve('media/voice.wav')).toMatch(/^data:audio\/wav;base64,/);
    expect(resolve('images/photo.webp')).toBe('data:image/webp;base64,AQID');
    expect(resolve('../images/logo.svg')).toBe(resolve('images/logo.svg'));
  });

  it('keeps the assets/ shorthand and refreshes after an asset edit', () => {
    const before = new Map([['assets/logo.svg', file('assets/logo.svg', '<svg>Before</svg>')]]);
    const after = new Map([['assets/logo.svg', file('assets/logo.svg', '<svg>After</svg>')]]);
    const resolveBefore = createPreviewAssetResolver(before, 'ui/main.ui');
    const resolveAfter = createPreviewAssetResolver(after, 'ui/main.ui');
    expect(resolveBefore('logo.svg')).toBe(resolveBefore('./assets/logo.svg'));
    expect(decodeURIComponent(resolveBefore('logo.svg'))).toContain('Before');
    expect(decodeURIComponent(resolveAfter('logo.svg'))).toContain('After');
  });

  it('leaves missing assets empty and never exposes private editor state', () => {
    const files = new Map([['builder/brief.json', file('builder/brief.json', '{"private":true}')]]);
    const resolve = createPreviewAssetResolver(files, 'ui/main.ui');
    for (const path of ['missing.png', '../../outside.svg', '/images/logo.svg', 'builder/brief.json', '../builder/brief.json']) {
      expect(resolve(path)).toBe('');
    }
    expect(resolve('data:image/png;base64,AQID')).toBe('data:image/png;base64,AQID');
  });
});

// A bundle file named by its bare path draws nothing when the app is run: only asset("…")
// resolves one. The preview used to swap every quoted "assets/…" that named a file for a
// data: URL before the page was parsed, so `<Image src="assets/logo.png" />` drew in Studio
// and was broken wherever the app ran, with nothing said. The preview hands the page over as
// written now (previewLoading.test.tsx), and the check says where such a path is.
describe('a bundle file named by its bare path', () => {
  const files = new Map<string, VFSFile>([
    ['assets/logo.svg', file('assets/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg" />')],
    ['assets/avatars/ada.png', file('assets/avatars/ada.png', new Uint8Array([137, 80, 78, 71]))],
    ['assets/intro.mp4', file('assets/intro.mp4', new Uint8Array([0, 0, 0, 24]))],
  ]);

  it('is found on a src, however the literal is written, with its line and what to write', () => {
    const source = [
      '<App>',
      '  <Image src="assets/logo.svg" alt="Logo" />',
      "  <Avatar src={'./assets/avatars/ada.png'} name=\"Ada\" />",
      '  <video poster="../assets/logo.svg" src={"assets/intro.mp4"}></video>',
      '</App>',
    ].join('\n');
    expect(bareAssetPaths('ui/main.ui', source, files)).toEqual([
      'ui/main.ui line 2: src="assets/logo.svg" names a file in the bundle by its bare path, which nothing loads when the app runs (it is asked of the site the app is served from). Write src={asset("assets/logo.svg")}: asset() is what resolves a bundle file.',
      expect.stringMatching(/^ui\/main\.ui line 3: src="\.\/assets\/avatars\/ada\.png" names a file .* Write src=\{asset\("assets\/avatars\/ada\.png"\)\}/),
      expect.stringMatching(/^ui\/main\.ui line 4: src="assets\/intro\.mp4" names a file /),
    ]);
  });

  it('is not found on an HTML element in quotes, which the runtime shows from the bundle', () => {
    const page = [
      '<link rel="stylesheet" href="styles.css">',
      '<img src="assets/logo.svg" alt="Logo">',
      '<video poster="../assets/logo.svg"></video>',
      '<a href="pages/about.html">About</a>',
      '<Image src="assets/logo.svg" />',
    ].join('\n');
    const project = new Map(files)
      .set('styles.css', file('styles.css', 'p {}'))
      .set('pages/about.html', file('pages/about.html', '<p>About</p>'));
    expect(bareAssetPaths('index.html', page, project)).toEqual([
      expect.stringMatching(/^index\.html line 5: src="assets\/logo\.svg" names a file /),
    ]);
  });

  it('is not found where asset() is given the path, where the path is worked out, or where it names no file', () => {
    const withLogic = new Map(files).set('logic/main.logic', file('logic/main.logic', 'let name = "ada"'));
    // Where a page says which file its logic is in: read by the composer, and not a picture.
    expect(bareAssetPaths('ui/main.ui', '<logic src="../logic/main.logic" />\n<App />\n', withLogic)).toEqual([]);
    const source = [
      '<App>',
      '  <Image src={asset("assets/logo.svg")} />',
      '  <Image src={asset("assets/avatars/" + person.id + ".png")} />',
      '  <Image src={"assets/avatars/" + person.id + ".png"} />',
      '  <Image src="assets/gone.png" />',
      '  <Image src="https://example.com/assets/logo.svg" />',
      '  <a href="#assets">Assets</a>',
      '  <Text>src="assets/logo.svg" is how not to write it</Text>',
      '</App>',
      '<logic>',
      'const src = "assets/logo.svg"',
      '</logic>',
    ].join('\n');
    // Not even the words in the Text, which only look like an attribute: nothing stands before
    // them but the end of a tag.
    expect(bareAssetPaths('ui/main.ui', source, files)).toEqual([]);
  });

  it('is reported by the check as an error, so a run does not finish on a picture that will not load', () => {
    const project = new Map<string, VFSFile>([
      ...files,
      ['manifest.json', file('manifest.json', JSON.stringify({ name: 'Logo', version: '1.0.0', main: 'ui/main.ui' }))],
      ['ui/main.ui', file('ui/main.ui', '<App>\n  <Image src="assets/logo.svg" alt="Logo" />\n</App>\n')],
    ]);
    const { errors } = lintTemplates(project);
    expect(errors).toEqual([expect.stringMatching(/^ui\/main\.ui line 2: src="assets\/logo\.svg" names a file in the bundle by its bare path/)]);
    const mended = new Map(project).set('ui/main.ui', file('ui/main.ui', '<App>\n  <Image src={asset("assets/logo.svg")} alt="Logo" />\n</App>\n'));
    expect(lintTemplates(mended).errors).toEqual([]);
  });

  it('is what the guide tells the agent not to write', () => {
    for (const python of [false, true]) {
      const guide = buildGuide({ python, torch: false, style: 'clean' });
      expect(guide).toContain('<Image src={asset("assets/logo.png")} alt="Logo" />');
      expect(guide).toMatch(/on a component a bare path \(`src="assets\/logo\.png"`\) loads nothing when the app runs/);
      // On an HTML element it shows the file, which the check no longer reports.
      expect(guide).toContain('`<img src="assets/logo.png">` and `<video poster="…">` show the bundle\'s file as written');
    }
  });
});
