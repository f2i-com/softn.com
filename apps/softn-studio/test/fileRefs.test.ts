/**
 * What names a file follows it when it is renamed or moved (lib/fileRefs.ts).
 *
 * Renaming `logo.png` in the Files panel would leave every page that shows it
 * asking for a file that is no longer there. Each way a SoftN project writes a
 * path is followed; anything that is not written as a path is left alone, and
 * a file where the old path can still be read is reported.
 */

import { describe, expect, it } from 'vitest';
import { followMove, movedPath, namersOf, type FileMove } from '../src/lib/fileRefs';

const project = (entries: Record<string, string | Uint8Array>) =>
  new Map(Object.entries(entries).map(([path, content]) => [path, { content }]));

const rename = (from: string, to: string): FileMove => ({ from, to, folder: false });
const folder = (from: string, to: string): FileMove => ({ from, to, folder: true });

describe('where a path is after a move', () => {
  it('is the new path for the file, and itself for any other', () => {
    expect(movedPath('assets/logo.png', rename('assets/logo.png', 'assets/brand.png'))).toBe('assets/brand.png');
    expect(movedPath('assets/logo.png.bak', rename('assets/logo.png', 'assets/brand.png'))).toBe('assets/logo.png.bak');
  });

  it('is under the new folder for everything in a folder that moved', () => {
    const move = folder('assets/icons', 'img/glyphs');
    expect(movedPath('assets/icons/home.svg', move)).toBe('img/glyphs/home.svg');
    expect(movedPath('assets/icons', move)).toBe('img/glyphs');
    expect(movedPath('assets/iconset.svg', move)).toBe('assets/iconset.svg');
  });
});

describe('a renamed file is followed by what names it', () => {
  it('in asset("…") with any of the three quotes, in an attribute, and in the manifest', () => {
    const files = project({
      'manifest.json': '{ "main": "index.html", "icon": "assets/logo.png" }',
      'index.html': '<img src="assets/logo.png"><Image src={asset(\'assets/logo.png\')} /><p>{`assets/logo.png`}</p>',
      'main.js': 'const logo = asset("assets/logo.png")',
      'assets/logo.png': new Uint8Array([1]),
    });
    const { texts, followed, stillNames } = followMove(files, rename('assets/logo.png', 'assets/brand.png'));
    expect(texts.get('manifest.json')).toBe('{ "main": "index.html", "icon": "assets/brand.png" }');
    expect(texts.get('index.html')).toBe('<img src="assets/brand.png"><Image src={asset(\'assets/brand.png\')} /><p>{`assets/brand.png`}</p>');
    expect(texts.get('main.js')).toBe('const logo = asset("assets/brand.png")');
    expect(followed).toEqual(['index.html', 'main.js', 'manifest.json']);
    expect(stillNames).toEqual([]);
  });

  it('in the manifest’s main, so renaming the main page does not leave the app without one', () => {
    const files = project({ 'manifest.json': '{"name":"Club","main":"ui/main.ui"}', 'ui/main.ui': '<App />' });
    const { texts } = followMove(files, rename('ui/main.ui', 'ui/start.ui'));
    expect(JSON.parse(texts.get('manifest.json')!)).toEqual({ name: 'Club', main: 'ui/start.ui' });
  });

  it('where it is written from the file that names it, with ./ and ../', () => {
    const files = project({
      'ui/main.ui': '<import Card from "./components/card.ui" />\n<logic src="../logic/main.logic" />',
      'ui/components/card.ui': '<Card />',
      'logic/main.logic': 'import "./dates.logic"',
      'logic/dates.logic': 'let today = 1',
    });
    expect(followMove(files, rename('ui/components/card.ui', 'ui/components/tile.ui')).texts.get('ui/main.ui'))
      .toBe('<import Card from "./components/tile.ui" />\n<logic src="../logic/main.logic" />');
    expect(followMove(files, rename('logic/main.logic', 'logic/app.logic')).texts.get('ui/main.ui'))
      .toBe('<import Card from "./components/card.ui" />\n<logic src="../logic/app.logic" />');
    expect(followMove(files, rename('logic/dates.logic', 'logic/calendar.logic')).texts.get('logic/main.logic')).toBe('import "./calendar.logic"');
  });

  it('where an HTML page or a stylesheet names it from its own folder, as a browser reads it', () => {
    const files = project({
      'pages/about.html': '<link rel="stylesheet" href="about.css"><script src="about.js"></script><a href="home.html">Home</a>',
      'pages/about.css': '.hero { background: url(hero.png) } .mark { background: url("../assets/mark.svg") }',
      'pages/about.js': 'let n = 1',
      'pages/home.html': '<h1>Home</h1>',
      'pages/hero.png': new Uint8Array([1]),
      'assets/mark.svg': '<svg/>',
    });
    expect(followMove(files, rename('pages/about.js', 'pages/info.js')).texts.get('pages/about.html'))
      .toBe('<link rel="stylesheet" href="about.css"><script src="info.js"></script><a href="home.html">Home</a>');
    expect(followMove(files, rename('pages/home.html', 'pages/start.html')).texts.get('pages/about.html'))
      .toContain('<a href="start.html">Home</a>');
    expect(followMove(files, rename('pages/hero.png', 'pages/banner.png')).texts.get('pages/about.css'))
      .toBe('.hero { background: url(banner.png) } .mark { background: url("../assets/mark.svg") }');
    expect(followMove(files, rename('assets/mark.svg', 'assets/sign.svg')).texts.get('pages/about.css'))
      .toContain('url("../assets/sign.svg")');
  });

  it('with the ?v=3 a site adds after a file’s name kept', () => {
    const files = project({ 'index.html': '<script src="main.js?v=3"></script><link href="/site.css#top">', 'main.js': '', 'site.css': '' });
    expect(followMove(files, rename('main.js', 'app.js')).texts.get('index.html')).toBe('<script src="app.js?v=3"></script><link href="/site.css#top">');
    expect(followMove(files, rename('site.css', 'style.css')).texts.get('index.html')).toBe('<script src="main.js?v=3"></script><link href="/style.css#top">');
  });

  it('and nothing else: a longer path, words between tags and another file of a like name are left', () => {
    const files = project({
      'index.html': '<p>The logo.png file</p><img src="assets/logo.png.bak"><img src="img/assets/logo.png">',
      'assets/logo.png': new Uint8Array([1]),
    });
    const { texts, stillNames } = followMove(files, rename('assets/logo.png', 'assets/brand.png'));
    expect(texts.size).toBe(0);
    expect(stillNames).toEqual([]);
  });

  it('does not rewrite a quoted ./ that leads to nothing in the project', () => {
    const files = project({ 'main.js': 'const here = "./"; const there = "../outside.js"; import "./real.js"', 'real.js': '' });
    expect(followMove(files, rename('real.js', 'true.js')).texts.get('main.js')).toBe('const here = "./"; const there = "../outside.js"; import "./true.js"');
  });
});

describe('a file that moves to another folder', () => {
  it('has its own ./ and ../ written from where it is now', () => {
    const files = project({
      'pages/about.html': '<script src="./about.js"></script><img src="../assets/logo.png"><a href="home.html">Home</a>',
      'pages/about.js': '',
      'pages/home.html': '',
      'assets/logo.png': new Uint8Array([1]),
    });
    const { texts } = followMove(files, rename('pages/about.html', 'pages/info/about.html'));
    expect(texts.get('pages/about.html')).toBe('<script src="../about.js"></script><img src="../../assets/logo.png"><a href="../home.html">Home</a>');
  });

  // A page's script is read from the page's folder; a picture's path is from the root wherever
  // the page is (the guide: "never ../"), so it stays as it is written.
  it('a page moved from the top of the project into a folder still finds its script, and its picture is left as written', () => {
    const files = project({ 'index.html': '<script src="main.js"></script><img src="assets/logo.png">', 'main.js': '', 'assets/logo.png': new Uint8Array([1]) });
    const { texts } = followMove(files, rename('index.html', 'pages/index.html'));
    expect(texts.get('index.html')).toBe('<script src="../main.js"></script><img src="assets/logo.png">');
  });

  it('keeps asset("…") as it is: that path is from the root wherever the page is', () => {
    const files = project({ 'ui/main.ui': '<Image src={asset("assets/logo.png")} />', 'assets/logo.png': new Uint8Array([1]) });
    expect(followMove(files, rename('ui/main.ui', 'ui/pages/main.ui')).texts.size).toBe(0);
  });
});

describe('a folder that is renamed or moved', () => {
  const files = project({
    'manifest.json': '{ "icon": "assets/icons/app.svg" }',
    'index.html': '<img src="assets/icons/home.svg"><p>{asset("assets/icons/" + name)}</p><link href="./assets/icons/set.css">',
    'assets/icons/set.css': '.a { background: url(home.svg) } .b { background: url("../logo.png") }',
    'assets/icons/home.svg': '<svg/>',
    'assets/icons/app.svg': '<svg/>',
    'assets/logo.png': new Uint8Array([1]),
  });

  it('takes every path under it along, and the start of a path built from it', () => {
    const { texts, followed } = followMove(files, folder('assets/icons', 'assets/glyphs'));
    expect(texts.get('manifest.json')).toBe('{ "icon": "assets/glyphs/app.svg" }');
    expect(texts.get('index.html')).toBe('<img src="assets/glyphs/home.svg"><p>{asset("assets/glyphs/" + name)}</p><link href="./assets/glyphs/set.css">');
    // Renamed where it is, the stylesheet's own references lead where they led.
    expect(texts.has('assets/icons/set.css')).toBe(false);
    expect(followed).toEqual(['index.html', 'manifest.json']);
  });

  it('moved elsewhere, has what is in it name the files outside it from the new place', () => {
    const { texts, followed } = followMove(files, folder('assets/icons', 'icons'));
    expect(texts.get('assets/icons/set.css')).toBe('.a { background: url(home.svg) } .b { background: url("../assets/logo.png") }');
    expect(texts.get('index.html')).toBe('<img src="icons/home.svg"><p>{asset("icons/" + name)}</p><link href="./icons/set.css">');
    // By the path each has after the move.
    expect(followed).toEqual(['icons/set.css', 'index.html', 'manifest.json']);
  });
});

describe('what is not rewritten is said', () => {
  it('a mention that is not a quoted path: a comment, an attribute with no quotes', () => {
    const files = project({
      'index.html': '<!-- see assets/logo.png --><img src=assets/logo.png>',
      'main.js': 'const logo = asset("assets/logo.png")',
      'assets/logo.png': new Uint8Array([1]),
    });
    const { texts, stillNames, followed } = followMove(files, rename('assets/logo.png', 'assets/brand.png'));
    expect(texts.has('index.html')).toBe(false);
    expect(stillNames).toEqual(['index.html']);
    expect(followed).toEqual(['main.js']);
  });

  it('a Python module that is imported by its name', () => {
    const files = project({ 'main.py': 'import helpers\nfrom helpers import clean\n', 'other.py': 'import os\n', 'helpers.py': 'def clean(): pass\n' });
    expect(followMove(files, rename('helpers.py', 'tools.py')).stillNames).toEqual(['main.py']);
    // Moved to another folder under the same name, it is still that module.
    expect(followMove(files, rename('helpers.py', 'lib/helpers.py')).stillNames).toEqual([]);
  });

  it('a page’s neighbour of the same name is not taken for the file at the root, either way round', () => {
    const files = project({
      'pages/about.html': '<script src="main.js"></script><p>{asset("main.js")}</p>',
      'pages/main.js': '',
      'main.js': '',
    });
    // The script is read from the page's folder: it names pages/main.js, which did not move.
    const root = followMove(files, rename('main.js', 'app.js'));
    expect(root.texts.get('pages/about.html')).toBe('<script src="main.js"></script><p>{asset("app.js")}</p>');
    expect(root.stillNames).toEqual([]);
    const beside = followMove(files, rename('pages/main.js', 'pages/app.js'));
    expect(beside.texts.get('pages/about.html')).toBe('<script src="app.js"></script><p>{asset("main.js")}</p>');
    expect(beside.stillNames).toEqual([]);
  });

  it('a page’s import without ./ is read from the page’s folder, as the composer reads it', () => {
    const files = project({ 'ui/main.ui': '<import Card from="components/card.ui" />', 'ui/components/card.ui': '<Card />' });
    expect(followMove(files, rename('ui/components/card.ui', 'ui/components/tile.ui')).texts.get('ui/main.ui')).toBe('<import Card from="components/tile.ui" />');
    expect(followMove(files, rename('ui/components/card.ui', 'shared/card.ui')).texts.get('ui/main.ui')).toBe('<import Card from="../shared/card.ui" />');
  });

  it('a picture named in a page’s own style, alone in url(), follows too', () => {
    const files = project({ 'index.html': '<div style="background: url(assets/bg.png)">Hi</div>', 'assets/bg.png': new Uint8Array([1]) });
    const { texts, stillNames } = followMove(files, rename('assets/bg.png', 'assets/back.png'));
    expect(texts.get('index.html')).toBe('<div style="background: url(assets/back.png)">Hi</div>');
    expect(stillNames).toEqual([]);
  });

  it('Studio’s own notes are not the app’s, and are neither rewritten nor reported', () => {
    const files = project({ 'builder/requirements.md': 'The logo is "assets/logo.png" (assets/logo.png).', 'assets/logo.png': new Uint8Array([1]) });
    const { texts, stillNames } = followMove(files, rename('assets/logo.png', 'assets/brand.png'));
    expect(texts.size).toBe(0);
    expect(stillNames).toEqual([]);
  });
});

describe('what names a file, asked before it is deleted', () => {
  const files = project({
    'manifest.json': '{ "main": "index.html", "icon": "assets/icons/app.svg" }',
    'index.html': '<img src="assets/logo.png"><script src="main.js"></script>',
    'main.js': 'const icon = asset("assets/icons/home.svg")',
    'assets/icons/home.svg': '<svg/>',
    'assets/icons/app.svg': '<svg/>',
    'assets/icons/set.css': '.a { background: url(home.svg) }',
    'assets/logo.png': new Uint8Array([1]),
    'assets/unused.png': new Uint8Array([1]),
  });

  it('is every file that asks for it by its path', () => {
    expect(namersOf(files, 'assets/logo.png', false)).toEqual(['index.html']);
    expect(namersOf(files, 'index.html', false)).toEqual(['manifest.json']);
    expect(namersOf(files, 'assets/unused.png', false)).toEqual([]);
  });

  it('for a folder, every file outside it that asks for something in it', () => {
    expect(namersOf(files, 'assets/icons', true)).toEqual(['main.js', 'manifest.json']);
  });
});
