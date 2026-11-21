/**
 * React and Vue in a web container, as a person brings them: an app built by Vite, and its
 * dist/ folder zipped and run as it is.
 *
 * The app's script runs against a document written for the container, not a browser's, and a
 * page written by hand asked little of it. A framework's production build is written against
 * a browser as a whole. Until this suite neither started: React stopped in its first commit
 * (`element instanceof window.HTMLIFrameElement`, with `window` an object of the engine's own
 * that had no such name), and Vue's template build on a missing `Document`. What each then
 * found is here too, as a page written by hand shows it (the second describe), because none
 * of it was the framework's doing:
 *
 *   - `window` is the global object, and what a browser names is there to be named;
 *   - a click on a checkbox is heard with the box as the person left it (it was heard with
 *     the box ticked back off, so React, which asks on the click, heard no change);
 *   - an element made with `createElementNS` is made in its namespace on the page (an icon
 *     drawn by a framework was an HTML element called `svg`, and drew nothing);
 *   - a small image a bundler writes into the script as a `data:` SVG is drawn.
 *
 * The apps are test/frameworks/react and test/frameworks/vue: the same page in each, built
 * here by Vite itself (test/frameworks/build.mjs) with each framework's own plugin and no
 * setting of ours. The versions are the ones this repository installs; the same page was
 * driven under React 19 by hand when this was written, and is not built here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountSoftNContainer } from '../src/index';
import { SVG_NS } from '../src/host-policy';
import { buildFrameworkApps, readFolder } from './frameworks/build.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LITE_WASM = path.join(PKG_ROOT, 'dist', 'runtime', 'engines', 'zipp-javascript-lite.wasm');

const settle = (ms = 60): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A page in a container, and what a person does to it. */
async function open(source: Uint8Array | Record<string, string>) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const said: string[] = [];
  const titles: string[] = [];
  const handle = await mountSoftNContainer(host, {
    isolation: 'inline',
    engineWasm: { lite: LITE_WASM },
    permissionMode: 'deny',
    onConsole: (level, text) => said.push(`${level}: ${text}`),
    onError: (error) => said.push(`failed: ${error.message}`),
    onTitleChange: (title) => titles.push(title),
    source,
  });
  const root = handle.shadowRoot;
  const find = <T extends Element = HTMLElement>(selector: string): T => {
    const el = root.querySelector(selector);
    if (!el) throw new Error(`${selector} is not on the page`);
    return el as T;
  };
  const text = (selector: string): string => root.querySelector(selector)?.textContent ?? '(not on the page)';
  /** Wait for the page to show `expected` at `selector`: the app's script answers a turn later. */
  const shows = (selector: string, expected: string) => expect.poll(() => text(selector), { timeout: 5_000, interval: 10 }).toBe(expected);
  const click = (selector: string) => find(selector).click();
  const type = (selector: string, value: string) => {
    const field = find<HTMLInputElement>(selector);
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    field.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  };
  return { handle, root, said, titles, find, text, shows, click, type };
}

describe('React and Vue apps built by Vite, run as their dist/ folder', () => {
  // Made when the apps are built, not when the file is read: a run that skips these tests
  // (by name) runs neither hook, and a folder made here would be left behind.
  let built = '';

  beforeAll(() => {
    built = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-frameworks-'));
    buildFrameworkApps(built);
  }, 120_000);

  afterAll(() => {
    if (built) fs.rmSync(built, { recursive: true, force: true });
  });

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });

  for (const framework of ['react', 'vue'] as const) {
    it(`${framework}: the app starts, and everything a person does to it reaches it and comes back`, async () => {
      const files = readFolder(path.join(built, framework));
      // What Vite wrote: the page names its script and stylesheet from the root, and the lazy part is a file of its own.
      const page_ = new TextDecoder().decode(files['index.html']);
      expect(page_).toMatch(/<script type="module" crossorigin src="\/assets\/index-[\w-]+\.js"><\/script>/);
      expect(page_).toMatch(/<link rel="stylesheet" crossorigin href="\/assets\/index-[\w-]+\.css">/);
      expect(Object.keys(files).some((name) => /^assets\/Lazy-[\w-]+\.js$/.test(name))).toBe(true);

      const { handle, root, said, titles, find, text, shows, click, type } = await open(zipSync(files));
      const rows = () => [...root.querySelectorAll('#list .row .text')].map((el) => el.textContent).join(',');

      // It starts, on the smallest engine, and draws its first page.
      await shows('#count', 'Count: 0');
      expect(handle.engineTier).toBe('lite');
      expect(root.querySelectorAll('.static').length).toBe(25);
      // An effect that measured an element, a store read from window, markup set as text.
      await shows('#measured', 'yes');
      expect(text('#width')).toBe('wide');
      expect(find('#html').querySelector('b')?.textContent).toBe('bold');
      // A file of the app's fetched from the root, as Vite's public/ folder is addressed.
      await shows('#data', 'hello from data.json');
      // The stylesheet the page links to.
      expect([...root.querySelectorAll('style')].some((sheet) => /#count\s*\{\s*font-weight:\s*700/.test(sheet.textContent ?? ''))).toBe(true);
      // A drawing made by the framework is a drawing on the page.
      const circle = find<SVGCircleElement>('#icon circle');
      expect(circle.namespaceURI).toBe(SVG_NS);
      expect(find('#icon').namespaceURI).toBe(SVG_NS);
      expect(circle.getAttribute('r')).toBe('4');
      // An image imported by the script (written into it by Vite) and one of public/.
      expect(find('#mark').getAttribute('src')).toMatch(/^data:image\/svg\+xml,/);
      expect(find('#logo').getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/);

      // A button, state, and an effect that sets the title.
      click('#inc');
      await shows('#count', 'Count: 1');
      click('#inc');
      await shows('#count', 'Count: 2');
      await expect.poll(() => titles.at(-1)).toBe('Count 2');

      // A field the framework controls: what is typed stays, and what is derived follows.
      type('#note', 'hello');
      await shows('#echo', 'HELLO');
      expect(find<HTMLInputElement>('#note').value).toBe('hello');

      // A checkbox, ticked and unticked.
      click('#agree');
      await shows('#agreed', 'yes');
      expect(find<HTMLInputElement>('#agree').checked).toBe(true);
      await expect.poll(() => find('.app').getAttribute('class')).toBe('app agreed');
      click('#agree');
      await shows('#agreed', 'no');
      expect(find<HTMLInputElement>('#agree').checked).toBe(false);
      click('#agree');
      await shows('#agreed', 'yes');

      // A select, a group of radio buttons, a textarea.
      const size = find<HTMLSelectElement>('#size');
      expect(size.value).toBe('m');
      size.value = 'l';
      size.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      await shows('#chosen', 'l');
      click('#kind-b');
      await shows('#kind', 'b');
      expect(find<HTMLInputElement>('#kind-a').checked).toBe(false);
      expect(find<HTMLInputElement>('#kind-b').checked).toBe(true);
      await expect.poll(() => find('.app').getAttribute('data-kind')).toBe('b');
      type('#notes', 'some notes');
      await shows('#length', '10');

      // A form: its submit is the app's (the page goes nowhere), the list grows, the field empties.
      type('#new', 'third');
      await settle();
      click('#push');
      await expect.poll(rows).toBe('first,second,third');
      await expect.poll(() => find<HTMLInputElement>('#new').value).toBe('');
      // Rows by key: reordered, then one removed.
      click('#reverse');
      await expect.poll(rows).toBe('third,second,first');
      find('#list .row .remove').click();
      await expect.poll(rows).toBe('second,first');
      // Implicit submission uses the same form listener and updates the list once.
      type('#new', 'by keyboard');
      await settle();
      find('#new').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await expect.poll(rows).toBe('second,first,by keyboard');
      await expect.poll(() => find<HTMLInputElement>('#new').value).toBe('');

      // A portal (React) or a teleport (Vue): drawn outside the app's root, and its button works.
      click('#open');
      await expect.poll(() => root.querySelector('#modal')?.getAttribute('role')).toBe('dialog');
      click('#close');
      await expect.poll(() => root.querySelector('#modal')).toBeNull();

      // A part of the app loaded when asked for: a chunk of its own with a stylesheet of its
      // own. Vite adds a <link> for the stylesheet to document.head and runs the chunk only
      // once the link says it has loaded; the head went nowhere and the link said nothing.
      const sheets = () => [...root.querySelectorAll('style')].map((sheet) => sheet.textContent ?? '').join('\n');
      expect(Object.keys(files).some((name) => /^assets\/Lazy-[\w-]+\.css$/.test(name))).toBe(true);
      expect(sheets()).not.toContain('letter-spacing');
      click('#lazy-load');
      await shows('#lazy', 'Lazy loaded');
      expect(sheets()).toMatch(/\.lazy\s*\{\s*letter-spacing:\s*3px/);
      expect(root.querySelector('link')).toBeNull();

      // A class the script sets on <html> (a dark mode) is on the app's root, where its stylesheet finds it.
      click('#dark');
      await expect.poll(() => root.querySelector('[data-softn-docroot]')?.classList.contains('dark')).toBe(true);
      click('#dark');
      await expect.poll(() => root.querySelector('[data-softn-docroot]')?.classList.contains('dark')).toBe(false);

      // The pointer over an element, the focus on a field and off it.
      const hover = find('#hover');
      hover.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, composed: true }));
      hover.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, composed: true }));
      await shows('#hovered', 'yes');
      // The pointer's place, told from the corner of the app's box: what the app puts there
      // with position: fixed is placed from that corner too. (The box is 100 across and 50
      // down the window here; a click at 130, 75 in the window is at 30, 25 in the app.)
      const box = root.querySelector('[data-softn-docroot]') as HTMLElement;
      box.getBoundingClientRect = () => ({ left: 100, top: 50, right: 900, bottom: 650, width: 800, height: 600, x: 100, y: 50, toJSON: () => ({}) });
      find('#pad').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, clientX: 130, clientY: 75 }));
      await shows('#at', '30,25');
      expect(find('#marker').style.left).toBe('30px');
      expect(find('#marker').style.top).toBe('25px');

      // An animation the script starts and waits on. (This page runs none: it ends at once,
      // and what waited on it goes on. A browser runs it: the e2e spec.)
      click('#fade-now');
      await shows('#faded', 'faded');

      find('#focus-me').focus();
      await shows('#focused', 'yes');
      find('#focus-me').blur();
      await shows('#focused', 'no');
      // The same field focused by the script, through the ref the framework holds it in.
      // (Vue took the element in a ref for a plain object and made a proxy of it: focus()
      // through the proxy did nothing.)
      click('#focus-by-ref');
      await shows('#focused', 'yes');
      expect(root.activeElement?.id).toBe('focus-me');
      find('#focus-me').blur();
      await shows('#focused', 'no');

      // The address, moved by the app (a router's pushState).
      click('#go');
      await shows('#path', '/about');
      // A router's links: each names an address, and the click is the script's to keep. The
      // page follows neither ("/" is the app's own page: followed, the app started again).
      click('#team-link');
      await shows('#path', '/team');
      click('#home-link');
      await shows('#path', '/');
      await settle(100);
      expect(text('#count')).toBe('Count: 2');
      expect(find<HTMLInputElement>('#note').value).toBe('hello');

      if (framework === 'vue') {
        // A transition out and in, v-show, and a watcher that waited for nextTick.
        click('#toggle');
        await expect.poll(() => root.querySelector('#fade'), { timeout: 5_000 }).toBeNull();
        click('#toggle');
        await expect.poll(() => root.querySelector('#fade')?.textContent, { timeout: 5_000 }).toBe('fading');
        expect(find('#shown-when-agreed').style.display).toBe('');
        expect(text('#ticked')).toBe('yes');
      }

      // A component that throws is caught by the app, and the rest of it is still there.
      click('#boom');
      await shows('#caught', 'Caught: boom');
      expect(text('#count')).toBe('Count: 2');
      click('#inc');
      await shows('#count', 'Count: 3');

      // Nothing failed on the way. (React prints an error its boundary caught; that is the app's own.)
      expect(said.filter((line) => line.startsWith('failed:') || /Script startup error|async-callback/.test(line))).toEqual([]);
      handle.dispose();
    }, 60_000);
  }
});

describe('what a framework asked of the page, as a page written by hand shows it', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });

  const page = (body: string, script: string) => ({ 'index.html': `<!doctype html><html><head><title>t</title></head><body>${body}<script>${script}</script></body></html>` });

  it('window is the global object, and names what a browser names', async () => {
    const { handle, text } = await open(
      page(
        '<p id="out">…</p><div id="box"></div><input id="field">',
        `var out = {};
        out.same = window === globalThis && self === window && top === window && parent === window && frames === window;
        window.setOnWindow = 1; out.fromWindow = typeof setOnWindow;
        globalThis.setOnGlobal = 2; out.fromGlobal = window.setOnGlobal;
        out.view = document.defaultView === window;
        out.listens = typeof window.addEventListener + ' ' + typeof window.removeEventListener + ' ' + typeof window.dispatchEvent;
        var box = document.getElementById('box');
        var field = document.getElementById('field');
        // Each of these threw ("Right-hand side of 'instanceof' is not callable") before.
        out.is = [
          document instanceof Document, document instanceof HTMLDocument, window instanceof Window,
          box instanceof HTMLDivElement, box instanceof HTMLElement, box instanceof Element, box instanceof Node,
          field instanceof HTMLInputElement,
        ].join(',');
        out.isNot = [
          box instanceof HTMLIFrameElement, box instanceof HTMLCanvasElement, box instanceof HTMLSpanElement,
          box.getRootNode() instanceof ShadowRoot, document instanceof ShadowRoot, {} instanceof HTMLDivElement, box instanceof SVGElement,
        ].join(',');
        out.agent = typeof navigator.userAgent + ' ' + (window.navigator === navigator) + ' ' + /SoftN/.test(navigator.userAgent);
        var selection = window.getSelection();
        out.selection = selection.rangeCount + ' ' + selection.isCollapsed + ' ' + String(selection) + '|' + (document.getSelection() === selection);
        var heard = 0;
        window.addEventListener('ping', function () { heard++; });
        window.dispatchEvent(new Event('ping'));
        out.heard = heard;
        document.getElementById('out').textContent = JSON.stringify(out);`
      )
    );
    await settle();
    expect(JSON.parse(text('#out'))).toEqual({
      same: true,
      fromWindow: 'number',
      fromGlobal: 2,
      view: true,
      listens: 'function function function',
      is: 'true,true,true,true,true,true,true,true',
      isNot: 'false,false,false,false,false,false,false',
      agent: 'string true true',
      selection: '0 true |true',
      heard: 1,
    });
    handle.dispose();
  });

  it('hears a click on a checkbox with the box as the person left it, and unticks the page’s box when the click is cancelled', async () => {
    const { handle, find, shows, click, text } = await open(
      page(
        '<input id="box" type="checkbox"><input id="held" type="checkbox"><input id="one" type="radio" name="n" checked><input id="two" type="radio" name="n"><p id="out">none</p><p id="radio">none</p>',
        `var out = document.getElementById('out');
        // Only the click is listened for: no change event follows to put it right.
        document.getElementById('box').addEventListener('click', function (e) { out.textContent = 'checked=' + e.target.checked; });
        document.getElementById('held').addEventListener('click', function (e) { e.preventDefault(); out.textContent = 'held'; });
        document.getElementById('two').addEventListener('click', function (e) {
          document.getElementById('radio').textContent = 'two=' + e.target.checked + ' one=' + document.getElementById('one').checked;
        });`
      )
    );
    click('#box');
    await shows('#out', 'checked=true');
    click('#box');
    await shows('#out', 'checked=false');
    click('#box');
    await shows('#out', 'checked=true');
    expect(find<HTMLInputElement>('#box').checked).toBe(true);

    // The code said no: the page had ticked the box before the app heard of it, and is told to untick it.
    click('#held');
    await shows('#out', 'held');
    await expect.poll(() => find<HTMLInputElement>('#held').checked).toBe(false);

    // A radio button chosen: the one clicked is on and the group's other is off, in the click.
    click('#two');
    await shows('#radio', 'two=true one=false');
    expect(text('#out')).toBe('held');
    handle.dispose();
  });

  it('shows the option a script chose and focuses the field it focused, in the turn it put them on the page', async () => {
    // What a framework does on its first render: makes the select and its options, puts
    // them on the page, and chooses, all in one turn. The page is told a parent's children
    // at the end of a turn, so the choice reached a select that had no options yet.
    const { handle, find, root } = await open(
      page(
        '<div id="root"></div>',
        `var root = document.getElementById('root');
        function select(id, multiple) {
          var s = document.createElement('select'); s.id = id; if (multiple) s.multiple = true;
          ['s', 'm', 'l'].forEach(function (v) { var o = document.createElement('option'); o.value = v; o.textContent = v.toUpperCase(); s.appendChild(o); });
          return s;
        }
        // On the page, then chosen (Vue's v-model on a select).
        var after = select('after'); root.appendChild(after); after.selectedIndex = 1;
        // Chosen by value.
        var byValue = select('by-value'); root.appendChild(byValue); byValue.value = 'l';
        // Chosen while apart, then put on the page.
        var before = select('before'); before.selectedIndex = 2; root.appendChild(before);
        // Several.
        var many = select('many', true); root.appendChild(many); many.options[0].selected = true; many.options[2].selected = true;
        // A field focused as it arrives (React's autoFocus, a dialog's first field).
        var field = document.createElement('input'); field.id = 'field'; root.appendChild(field); field.focus();`
      )
    );
    await settle();
    expect(find<HTMLSelectElement>('#after').value).toBe('m');
    expect(find<HTMLSelectElement>('#by-value').value).toBe('l');
    expect(find<HTMLSelectElement>('#before').value).toBe('l');
    expect([...find<HTMLSelectElement>('#many').selectedOptions].map((option) => option.value)).toEqual(['s', 'l']);
    expect(root.activeElement?.id).toBe('field');
    handle.dispose();
  });

  it('follows a link to a page of the app’s only once the script has heard the click and not cancelled it', async () => {
    const second = '<!doctype html><html><body><p id="where">second page</p></body></html>';
    const { handle, root, click, shows, text } = await open({
      'second.html': second,
      'index.html': `<!doctype html><html><body>
        <p id="where">first page</p><p id="clicks">0</p>
        <a id="kept" href="second.html">kept by the script</a>
        <a id="home" href="/">home</a>
        <a id="plain" href="second.html">followed</a>
        <script>
          var clicks = 0;
          document.addEventListener('click', function (e) {
            clicks++;
            document.getElementById('clicks').textContent = String(clicks);
            var link = e.target.closest('a');
            if (link && link.id !== 'plain') e.preventDefault();
          });
        </script></body></html>`,
    });
    // Cancelled: a page of the app's is named, and it is not shown.
    click('#kept');
    await shows('#clicks', '1');
    await settle(100);
    expect(text('#where')).toBe('first page');
    // "/" is this very page: followed, the app would start again and the count with it.
    click('#home');
    await shows('#clicks', '2');
    await settle(100);
    expect(text('#where')).toBe('first page');
    // Not cancelled: followed, after the script heard it.
    click('#plain');
    await expect.poll(() => root.querySelector('#where')?.textContent, { timeout: 5_000 }).toBe('second page');
    handle.dispose();
  });

  it('follows a link at once where no script listens for clicks', async () => {
    const { handle, root, click } = await open({
      'second.html': '<!doctype html><html><body><p id="where">second page</p></body></html>',
      'index.html': '<!doctype html><html><body><p id="where">first page</p><a id="plain" href="second.html">go</a></body></html>',
    });
    click('#plain');
    await expect.poll(() => root.querySelector('#where')?.textContent, { timeout: 5_000 }).toBe('second page');
    handle.dispose();
  });

  it('gives a <style> a sheet to write rules into one at a time, and the page reads them by the stylesheet’s rule', async () => {
    // emotion and styled-components in production: a <style> with an empty text node, then
    // sheet.insertRule() for every rule, and deleteRule() when a component goes.
    const { handle, root, text } = await open(
      page(
        '<p id="out">…</p><p class="a b">styled</p>',
        `var out = {};
        var tag = document.createElement('style');
        tag.setAttribute('data-emotion', 'css');
        tag.appendChild(document.createTextNode(''));
        document.head.appendChild(tag);
        var sheet = tag.sheet;
        out.found = !!sheet && document.styleSheets.length >= 1 && document.styleSheets[document.styleSheets.length - 1] === sheet && sheet.ownerNode === tag;
        out.kind = sheet instanceof CSSStyleSheet;
        sheet.insertRule('.a{color:rgb(1, 2, 3)}', sheet.cssRules.length);
        sheet.insertRule('.b{outline:3px solid rgb(4, 5, 6)}', sheet.cssRules.length);
        sheet.insertRule('.gone{color:red}', sheet.cssRules.length);
        sheet.insertRule('@media (min-width:1px){.a{margin:7px}}', sheet.cssRules.length);
        sheet.insertRule('.first{top:0}', 0);
        // Somewhere else, and a sheet of its own to load: neither reaches the page.
        sheet.insertRule('.b{background:url(https://evil.example/pixel.png)}', sheet.cssRules.length);
        sheet.insertRule('@import url("https://evil.example/sheet.css");', 0);
        out.count = sheet.cssRules.length;
        out.second = sheet.cssRules[1].cssText + ' | ' + sheet.cssRules[1].selectorText;
        sheet.deleteRule(4);
        out.after = sheet.cssRules.length + ' ' + sheet.cssRules.map(function (r) { return r.selectorText || '@'; }).join(',');
        // What is not a rule is refused, as a browser refuses it (a library tries, and goes on).
        out.refused = [];
        ['.broken{color:red', '', 'not a rule'].forEach(function (bad) { try { sheet.insertRule(bad, 0); out.refused.push('taken'); } catch (e) { out.refused.push(e.name); } });
        try { sheet.insertRule('.x{}', 99); out.refused.push('taken'); } catch (e) { out.refused.push(e.name); }
        document.getElementById('out').textContent = JSON.stringify(out);`
      )
    );
    await settle();
    expect(JSON.parse(text('#out'))).toEqual({
      found: true,
      kind: true,
      count: 7,
      second: '.first{top:0} | .first',
      after: '6 @,.first,.a,.b,@,.b',
      refused: ['SyntaxError', 'SyntaxError', 'SyntaxError', 'IndexSizeError'],
    });
    const css = [...root.querySelectorAll('style')].map((el) => el.textContent ?? '').join('\n');
    expect(css).toContain('.a{color:rgb(1, 2, 3)}');
    expect(css).toContain('.b{outline:3px solid rgb(4, 5, 6)}');
    expect(css).toContain('@media (min-width:1px){.a{margin:7px}}');
    expect(css).not.toContain('.gone');
    expect(css).not.toContain('evil.example');
    expect(css).not.toMatch(/@import/);
    handle.dispose();
  });

  it('writes a rule added in a later turn, and keeps the sheet when its <style> is moved', async () => {
    const { handle, root, click } = await open(
      page(
        '<button id="more" type="button">more</button><button id="move" type="button">move</button><div id="there"></div>',
        `var tag = document.createElement('style');
        document.head.appendChild(tag);
        tag.sheet.insertRule('.one{color:rgb(1, 1, 1)}', 0);
        document.getElementById('more').addEventListener('click', function () { tag.sheet.insertRule('.two{color:rgb(2, 2, 2)}', tag.sheet.cssRules.length); });
        document.getElementById('move').addEventListener('click', function () { document.getElementById('there').appendChild(tag); });`
      )
    );
    const css = () => [...root.querySelectorAll('style')].map((el) => el.textContent ?? '').join('\n');
    await expect.poll(css).toContain('.one{color:rgb(1, 1, 1)}');
    click('#more');
    await expect.poll(css).toContain('.two{color:rgb(2, 2, 2)}');
    click('#move');
    await settle(100);
    expect(css()).toContain('.one{color:rgb(1, 1, 1)}');
    expect(css()).toContain('.two{color:rgb(2, 2, 2)}');
    handle.dispose();
  });

  it('has the events, lists and small names a build asks for, and scrolls nothing but the app', async () => {
    const { handle, text } = await open(
      page(
        '<p id="out">…</p><p class="x">one</p><p class="x">two</p><div id="box"></div>',
        `var out = {};
        var pop = new PopStateEvent('popstate', { state: { page: 2 } });
        var heard = null;
        window.addEventListener('popstate', function (e) { heard = e.state.page; });
        window.dispatchEvent(pop);
        out.pop = (pop instanceof Event) + ' ' + pop.type + ' ' + heard;
        var failed = new ErrorEvent('error', { message: 'broke', error: new Error('broke'), cancelable: true });
        out.error = failed.message + ' ' + (failed.error instanceof Error) + ' ' + failed.cancelable;
        out.made = [new TransitionEvent('transitionend', { propertyName: 'opacity' }).propertyName, new WheelEvent('wheel', { deltaY: 3 }).deltaY,
          new HashChangeEvent('hashchange', { newURL: 'b' }).newURL, new StorageEvent('storage', { key: 'k' }).key, new UIEvent('x', { detail: 2 }).detail].join(',');
        out.lists = (document.querySelectorAll('.x') instanceof NodeList) + ' ' + (document.body.children instanceof HTMLCollection) + ' ' + ([] instanceof NodeList);
        var rect = new DOMRect(1, 2, 3, 4);
        out.rect = rect.right + ' ' + rect.bottom + ' ' + JSON.stringify(DOMRect.fromRect({ x: 5 }).toJSON().x);
        out.doc = [document.cookie === '', document.visibilityState, document.hidden, typeof document.fonts.ready.then, document.characterSet, document.scrollingElement === document.documentElement, document.URL === location.href].join(',');
        document.cookie = 'a=1';
        out.cookie = document.cookie;
        out.screen = (screen.width === innerWidth) + ' ' + (outerHeight === innerHeight) + ' ' + scrollY + ' ' + pageXOffset;
        // None of these throws, and none moves the page the app is drawn in.
        window.scrollTo(0, 0); window.scrollTo({ top: 10, behavior: 'smooth' }); window.scrollBy(0, 5);
        var box = document.getElementById('box');
        box.scrollTop = 40; box.scrollTo({ left: 7 }); box.scrollBy(0, 2);
        out.scroll = scrollY + ' ' + box.scrollTop + ' ' + box.scrollLeft;
        requestIdleCallback(function (deadline) {
          out.idle = typeof deadline.timeRemaining() + ' ' + deadline.didTimeout;
          document.getElementById('out').textContent = JSON.stringify(out);
        });`
      )
    );
    await expect.poll(() => text('#out'), { timeout: 5_000 }).not.toBe('…');
    expect(JSON.parse(text('#out'))).toEqual({
      pop: 'true popstate 2',
      error: 'broke true true',
      made: 'opacity,3,b,k,2',
      lists: 'true true false',
      rect: '4 6 5',
      doc: 'true,visible,false,function,UTF-8,true,true',
      cookie: '',
      screen: 'true true 0 0',
      scroll: '15 42 7',
      idle: 'number false',
    });
    handle.dispose();
  });

  it('hears on the window what a page written by hand listens for there: a handler set as a property, and an event that bubbles up', async () => {
    const { handle, click, shows, text, find } = await open(
      page(
        '<p id="out">none</p><button id="b" type="button">b</button><a id="hash" href="#two">two</a>',
        `var heard = [];
        var say = function (what) { heard.push(what); document.getElementById('out').textContent = heard.join(','); };
        // A router written by hand: the handler is a property of the window.
        window.onhashchange = function () { say('hash:' + location.hash); };
        window.onpopstate = function () { say('pop'); };
        // And what bubbles: a click anywhere, heard on the window (a menu closing, a shortcut).
        window.addEventListener('click', function (e) { say('click:' + e.target.id); });
        var key = function (e) { say('key:' + e.key); };
        window.addEventListener('keydown', key);
        var gone = function () { say('gone'); };
        window.addEventListener('click', gone);
        window.removeEventListener('click', gone);
        // An event sent to the window itself is still the window's alone, heard once.
        window.addEventListener('ping', function () { say('ping'); });
        window.dispatchEvent(new Event('ping'));
        document.getElementById('b').addEventListener('click', function () { location.hash = '#one'; });`
      )
    );
    await shows('#out', 'ping');
    click('#b');
    await shows('#out', 'ping,click:b,hash:#one');
    find('#b').dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true, composed: true }));
    await shows('#out', 'ping,click:b,hash:#one,key:k');
    // A link to a place on the page moves the hash too.
    click('#hash');
    await expect.poll(() => text('#out'), { timeout: 5_000 }).toContain('hash:#two');
    handle.dispose();
  });

  it('says what a node is when asked as a library asks, so none takes an element for a plain object', async () => {
    const { handle, text } = await open(
      page(
        '<p id="out">…</p><input id="field"><svg id="drawing"><circle r="1"/></svg>',
        `var say = function (value) { return Object.prototype.toString.call(value).slice(8, -1); };
        var div = document.createElement('div');
        document.getElementById('out').textContent = [
          say(div), say(document.getElementById('field')), say(document.getElementById('out')), say(document.querySelector('circle')),
          say(document.createTextNode('x')), say(document.createComment('x')), say(document), say(document.createDocumentFragment()),
          say({}), say([]), say(new Map()),
          // The methods are the element's own, on the element itself.
          typeof div.focus, div.isConnected,
        ].join(',');`
      )
    );
    await settle();
    expect(text('#out')).toBe('HTMLDivElement,HTMLInputElement,HTMLParagraphElement,SVGElement,Text,Comment,HTMLDocument,DocumentFragment,Object,Array,Map,function,false');
    handle.dispose();
  });

  it('makes an element of a drawing in the drawing’s namespace, however the script made it', async () => {
    const { handle, find, root } = await open(
      page(
        '<div id="made"></div><div id="parsed"></div>',
        `var NS = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('id', 'drawing'); svg.setAttribute('viewBox', '0 0 10 10');
        var gradient = document.createElementNS(NS, 'linearGradient'); gradient.setAttribute('id', 'g');
        var title = document.createElementNS(NS, 'title'); title.textContent = 'a drawing';
        var link = document.createElementNS(NS, 'a'); link.setAttribute('id', 'svg-link');
        var circle = document.createElementNS(NS, 'circle'); circle.setAttribute('r', '4');
        link.appendChild(circle); svg.appendChild(title); svg.appendChild(gradient); svg.appendChild(link);
        document.getElementById('made').appendChild(svg);
        document.getElementById('parsed').innerHTML = '<svg id="second"><rect id="rect" width="2" height="2"/></svg><a id="html-link">x</a>';`
      )
    );
    await settle();
    for (const selector of ['#drawing', '#drawing circle', '#drawing title', '#svg-link', '#second', '#rect']) {
      expect(find(selector).namespaceURI, selector).toBe(SVG_NS);
    }
    // Names that keep their case in a drawing do.
    expect(root.querySelector('#g')?.localName).toBe('linearGradient');
    // And what is the page's own stays the page's.
    expect(find('#html-link').namespaceURI).toBe('http://www.w3.org/1999/xhtml');
    expect(find('#made').namespaceURI).toBe('http://www.w3.org/1999/xhtml');
    handle.dispose();
  });
});
