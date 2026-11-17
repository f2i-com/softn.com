/**
 * A shadow tree in a web container: `attachShadow` on an element of the app's own.
 *
 * The app's document keeps the tree (core's shell), and the page attaches a real shadow root
 * to the real element, so the tree's stylesheets are its own and the browser fills its
 * slots. What that asks of the page is here, because each is a way out of the app's box if
 * it is missed:
 *
 *   - a link inside a shadow tree is followed by the container, never by the browser (the
 *     click reaches the app's page with the tree's host as its target, which is no link);
 *   - a form sent inside one is the app's to hear, and is never sent by the browser (a
 *     `submit` does not leave the tree it happened in, so the app's page never hears it);
 *   - a stylesheet inside one is read by the host's rule as every stylesheet is, with
 *     `:host` left to mean the app's own element, which it means only there.
 *
 * Slots are a browser's to fill, and this test's page fills none: e2e/tests/web-container.spec.ts
 * has them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountSoftNContainer } from '../src/index';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LITE_WASM = path.join(PKG_ROOT, 'dist', 'runtime', 'engines', 'zipp-javascript-lite.wasm');
const settle = (ms = 80): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function open(source: Record<string, string>) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const said: string[] = [];
  const handle = await mountSoftNContainer(host, {
    isolation: 'inline',
    engineWasm: { lite: LITE_WASM },
    permissionMode: 'deny',
    onConsole: (level, text) => said.push(`${level}: ${text}`),
    onError: (error) => said.push(`failed: ${error.message}`),
    source,
  });
  return { handle, root: handle.shadowRoot, said };
}

const CARD = `<!doctype html><html><head><title>t</title><style>:host { position: fixed } p { margin: 0 }</style></head><body>
<user-card id="card"><span id="light">light</span></user-card>
<p id="seen">none</p><p id="found">…</p>
<script>
  var seen = [];
  var say = function (what) { seen.push(what); document.getElementById('seen').textContent = seen.join(' '); };
  class InnerPart extends HTMLElement {
    connectedCallback() { this.textContent = 'part ' + (this.getRootNode() instanceof ShadowRoot ? 'in a shadow tree' : 'on the page'); }
  }
  class UserCard extends HTMLElement {
    constructor() {
      super();
      var root = this.attachShadow({ mode: 'open' });
      root.innerHTML = '<style>:host { display: block; outline: 1px solid rgb(1, 2, 3) } :host-context(body.dark) p { color: red } p { color: rgb(4, 5, 6) } .x { background: url(https://evil.example/x.png) }</style>' +
        '<p id="inner">inside <b id="count">0</b></p><button id="add" type="button">add</button><input id="box" type="checkbox">' +
        '<a id="away" href="https://example.org/away" target="_top">away</a><a id="next" href="second.html">next</a>' +
        '<form id="form" action="https://example.org/post"><input name="q" value="x"><button id="send">send</button></form><inner-part id="part"></inner-part>';
      var count = 0;
      root.getElementById('add').addEventListener('click', function (e) { count++; root.getElementById('count').textContent = String(count); say('add:' + e.target.id); });
      root.getElementById('box').addEventListener('change', function (e) { say('box:' + e.target.checked); });
      root.getElementById('form').addEventListener('submit', function (e) { e.preventDefault(); say('sent:' + new FormData(e.target).get('q')); });
    }
  }
  customElements.define('inner-part', InnerPart);
  customElements.define('user-card', UserCard);
  // Outside the tree, what happened inside it is the element's own.
  document.addEventListener('click', function (e) { say('page:' + e.target.id); });
  document.addEventListener('change', function () { say('page-change'); });
  document.getElementById('found').textContent = [document.querySelector('#inner') === null, document.getElementById('count') === null, document.querySelectorAll('button').length,
    document.getElementById('card').shadowRoot.querySelector('#inner').textContent].join('|');
</script></body></html>`;

describe('a shadow tree an app attaches to an element of its own', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is a real one on the page, with what is in it out of the page’s own reach and the app’s script hearing what happens there', async () => {
    const { handle, root, said } = await open({ 'index.html': CARD });
    await settle();
    const card = root.querySelector('#card') as HTMLElement;
    const tree = card.shadowRoot!;
    expect(tree).toBeInstanceOf(ShadowRoot);
    // In the tree, not beside the element's own children.
    expect(tree.querySelector('#inner')?.textContent).toBe('inside 0');
    expect(root.querySelector('#inner')).toBeNull();
    expect(card.querySelector('#light')?.textContent).toBe('light');
    expect(root.querySelector('#found')?.textContent).toBe('true|true|0|inside 0');
    // An element of the app's own inside the tree is one too.
    expect(tree.querySelector('#part')?.textContent).toBe('part in a shadow tree');

    // A click inside reaches the listener inside, and the page's as the element's.
    (tree.querySelector('#add') as HTMLElement).click();
    await expect.poll(() => tree.querySelector('#count')?.textContent).toBe('1');
    expect(root.querySelector('#seen')?.textContent).toBe('add:add page:card');
    // A change does not leave the tree: heard inside, by the app, and not on its page.
    (tree.querySelector('#box') as HTMLElement).click();
    await expect.poll(() => root.querySelector('#seen')?.textContent).toBe('add:add page:card page:card box:true');
    expect(said.filter((line) => line.startsWith('failed'))).toEqual([]);
    handle.dispose();
  });

  it('reads the tree’s stylesheet by the host’s rule, with :host the app’s own element there and nowhere else', async () => {
    const { handle, root } = await open({ 'index.html': CARD });
    await settle();
    const tree = (root.querySelector('#card') as HTMLElement).shadowRoot!;
    const inner = tree.querySelector('style')?.textContent ?? '';
    expect(inner).toContain(':host { display: block; outline: 1px solid rgb(1, 2, 3) }');
    expect(inner).toContain('p { color: rgb(4, 5, 6) }');
    // What is around the element, out to the embedding page, is not the app's to ask about.
    expect(inner).not.toContain(':host-context');
    expect(inner).not.toContain('evil.example');
    // In the app's page, :host is the element the app is embedded in: it never matches.
    const pageSheets = [...root.querySelectorAll('style')].map((sheet) => sheet.textContent ?? '').join('\n');
    expect(pageSheets).not.toMatch(/:host\s*\{\s*position/);
    handle.dispose();
  });

  it('follows a link inside the tree itself, and never lets the browser send a form in there', async () => {
    const opened: string[] = [];
    vi.spyOn(window, 'open').mockImplementation((url) => {
      opened.push(String(url));
      return null;
    });
    const { handle, root } = await open({
      'index.html': CARD,
      'second.html': '<!doctype html><html><body><p id="where">second page</p></body></html>',
    });
    await settle();
    const tree = (root.querySelector('#card') as HTMLElement).shadowRoot!;
    const click = (selector: string) => {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true });
      tree.querySelector(selector)!.dispatchEvent(event);
      return event;
    };
    // A link out: the page does not go there (target="_top" or not); a tab of its own does.
    expect(click('#away').defaultPrevented).toBe(true);
    expect(opened).toEqual(['https://example.org/away']);
    // A form sent: the browser never sends it, and the app's own listener hears it.
    const sent = new Event('submit', { bubbles: true, cancelable: true });
    tree.querySelector('#form')!.dispatchEvent(sent);
    expect(sent.defaultPrevented).toBe(true);
    await expect.poll(() => root.querySelector('#seen')?.textContent).toContain('sent:x');
    // A link to a page of the app's: the container's to show.
    expect(click('#next').defaultPrevented).toBe(true);
    await expect.poll(() => root.querySelector('#where')?.textContent, { timeout: 5_000 }).toBe('second page');
    handle.dispose();
  });

  it('is told again with its element when the element is taken off the page and put back', async () => {
    const { handle, root } = await open({
      'index.html': `<!doctype html><html><body><div id="a"></div><div id="b"></div><button id="move" type="button">move</button><script>
        var box = document.createElement('div');
        box.id = 'box';
        box.attachShadow({ mode: 'closed' }).innerHTML = '<p id="kept">kept</p>';
        document.getElementById('a').appendChild(box);
        document.getElementById('move').addEventListener('click', function () { document.getElementById('b').appendChild(box); });
      </script></body></html>`,
    });
    await settle();
    // Closed to the app's script; on the page it is the page's own to read.
    expect((root.querySelector('#a #box') as HTMLElement).shadowRoot?.querySelector('#kept')?.textContent).toBe('kept');
    (root.querySelector('#move') as HTMLElement).click();
    await expect.poll(() => (root.querySelector('#b #box') as HTMLElement | null)?.shadowRoot?.querySelector('#kept')?.textContent).toBe('kept');
    expect(root.querySelector('#a #box')).toBeNull();
    handle.dispose();
  });

  it('holds to its rules against operations written by hand, which the app’s own document would never send', async () => {
    // What the page is told to do comes from the app's side, where a script can write an
    // operation itself. Two that the document never sends: a stylesheet moved out of a
    // shadow tree as it is (its `:host` would then be the page's), and children given to
    // the page's own scroller, beside the body everything of the app's is held in.
    const { handle, root } = await open({
      'index.html': `<!doctype html><html><body><div id="target"></div><form id="loose" action="https://example.org/post"><button id="go">go</button></form>
        <div id="card"></div><button id="forge" type="button">forge</button><p id="seen">none</p><script>
        var tree = document.getElementById('card').attachShadow({ mode: 'open' });
        tree.innerHTML = '<style id="sheet">:host { position: fixed; inset: 0 } p { color: rgb(1, 2, 3) }</style><p>in</p>';
        document.getElementById('forge').addEventListener('click', function () {
          __softnPushExtraOp(['c', document.getElementById('target').__softnNode, [tree.getElementById('sheet').__softnNode]]);
          __softnPushExtraOp(['c', 0, [1, document.getElementById('loose').__softnNode]]);
          __softnPushExtraOp(['c', document.getElementById('target').__softnNode, [0, 1, -3, tree.__softnNode]]);
          document.getElementById('seen').textContent = 'forged';
        });
      </script></body></html>`,
    });
    await settle();
    const scroller = root.querySelector('[data-softn-docroot]') as HTMLElement;
    const before = [...scroller.children];
    expect((root.querySelector('#card') as HTMLElement).shadowRoot?.querySelector('style')?.textContent).toMatch(/:host\s*\{\s*position/);
    (root.querySelector('#forge') as HTMLElement).click();
    await expect.poll(() => root.querySelector('#seen')?.textContent).toBe('forged');
    await settle();
    // The scroller holds what it held: the app's head and its body, and nothing beside them.
    expect([...scroller.children]).toEqual(before);
    expect(root.querySelector('#loose')?.closest('[data-softn-viewport]')).not.toBeNull();
    // No sheet anywhere in the app's page says `:host` any more.
    const pageSheets = [...root.querySelectorAll('style')].map((sheet) => sheet.textContent ?? '').join('\n');
    expect(pageSheets).not.toMatch(/:host\s*\{\s*position/);
    // And the page's own elements were nobody's children to give.
    expect(root.querySelector('#target [data-softn-viewport], #target [data-softn-docroot], #target [data-softn-head]')).toBeNull();
    handle.dispose();
  });

  it('makes no part of a formula a link, written on the page or set by the script', async () => {
    // Firefox follows `href` on any MathML element by itself; it is no <a>, so the click is
    // not heard as a link's, and the embedding page would go where the app said.
    const { handle, root } = await open({
      'index.html': `<!doctype html><html><body><math><mtext id="first" href="https://example.org/away">one</mtext><mi id="later">x</mi></math><a id="link" href="https://example.org/fine">a link</a><script>
        document.getElementById('later').setAttribute('href', 'https://example.org/away');
        var made = document.createElementNS('http://www.w3.org/1998/Math/MathML', 'mo');
        made.id = 'made';
        made.setAttribute('xlink:href', 'https://example.org/away');
        document.querySelector('math').appendChild(made);
      </script></body></html>`,
    });
    await settle();
    for (const id of ['first', 'later', 'made']) {
      const el = root.querySelector('#' + id)!;
      expect(el.namespaceURI, id).toBe('http://www.w3.org/1998/Math/MathML');
      expect([el.getAttribute('href'), el.getAttribute('xlink:href')], id).toEqual([null, null]);
    }
    // A link is a link still, and opens in a tab of its own.
    expect(root.querySelector('#link')?.getAttribute('href')).toBe('https://example.org/fine');
    handle.dispose();
  });

  it('hears what happens inside a component of the page’s own as happening on the component', async () => {
    // A grid or a chart draws in a shadow tree of its own, which is none of the app's: a
    // click on a cell is, to the app, a click on the grid. (Read as the innermost element
    // wherever it was, it was an element the app had never heard of, and was dropped.)
    const { handle, root } = await open({
      'index.html': `<!doctype html><html><body><div id="widget"></div><p id="seen">none</p><script>
        document.getElementById('widget').addEventListener('click', function (e) { document.getElementById('seen').textContent = 'clicked:' + e.target.id; });
      </script></body></html>`,
    });
    await settle();
    const inner = (root.querySelector('#widget') as HTMLElement).attachShadow({ mode: 'open' });
    inner.innerHTML = '<button id="cell" type="button">cell</button>';
    (inner.querySelector('#cell') as HTMLElement).click();
    await expect.poll(() => root.querySelector('#seen')?.textContent).toBe('clicked:widget');
    handle.dispose();
  });
});
