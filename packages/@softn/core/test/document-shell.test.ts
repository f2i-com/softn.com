/**
 * The document a page's code is given (document-shell/shell-source.ts), run
 * in ZIPP as a page's logic runs: found by id, changed, listened to, and
 * every change told to the host as operations on nodes by id.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ZippWasmAdapter } from '../src/runtime/zipp-wasm-adapter';
import { SHELL_EVENT, SHELL_READY, SHELL_SYNC, SHELL_TAKE, shellPrelude, usesDocument } from '../src/document-shell/shell-source';

type Op = [string, ...unknown[]];

const SEED = {
  next: 20,
  body: [
    { i: 2, t: 'h1', a: { id: 'title', class: 'big' }, c: [{ i: 3, x: 'Tasks' }] },
    { i: 4, t: 'ul', a: { id: 'list' }, c: [{ i: 5, t: 'li', a: { class: 'item' }, c: [{ i: 6, x: 'One' }] }] },
    {
      i: 7,
      t: 'form',
      a: { id: 'add' },
      c: [
        { i: 8, t: 'input', a: { name: 'task', value: '' } },
        { i: 9, t: 'button', a: {}, c: [{ i: 10, x: 'Add' }] },
      ],
    },
    { i: 11, o: 1 },
    { i: 12, o: 1, t: 'Card', a: { id: 'card' } },
  ],
};

let engine: ZippWasmAdapter | null = null;
afterEach(() => {
  engine?.dispose();
  engine = null;
});

async function page(code: string, seed: object = SEED) {
  engine = await ZippWasmAdapter.create();
  await engine.initializeScript(shellPrelude(JSON.stringify(seed)) + '\n' + code);
  const run = engine;
  return {
    take: () => (run.callFunction(SHELL_TAKE, []) as Op[] | null) ?? [],
    event: (id: number, type: string, props: Record<string, unknown> = {}) => run.callFunction(SHELL_EVENT, [id, type, props]) as number,
    sync: (changes: unknown[]) => run.callFunction(SHELL_SYNC, [changes]),
    ready: () => run.callFunction(SHELL_READY, []),
    call: (name: string, ...args: unknown[]) => run.callFunction(name, args),
  };
}

describe('the document a page’s code is given', () => {
  it('has the page’s HTML in it from the start', async () => {
    const doc = await page(`
      function read() {
        return [
          document.getElementById('title').textContent,
          document.querySelector('#list > li.item').textContent,
          document.querySelectorAll('li').length,
          document.body.children.length,
          document.getElementById('card').tagName,
          document.getElementById('title').className,
          document.querySelector('form input[name="task"]').value,
        ];
      }`);
    expect(doc.call('read')).toEqual(['Tasks', 'One', 1, 4, 'CARD', 'big', '']);
  });

  it('tells the host what changed, by id', async () => {
    const doc = await page(`
      const list = document.getElementById('list');
      function add(text) {
        const li = document.createElement('li');
        li.className = 'item';
        li.textContent = text;
        list.appendChild(li);
        document.getElementById('title').classList.add('done');
        return li.outerHTML;
      }`);
    expect(doc.take()).toEqual([]);
    expect(doc.call('add', 'Two')).toBe('<li class="item">Two</li>');
    const ops = doc.take();
    expect(ops).toContainEqual(['e', 20, 'li', { class: 'item' }]);
    expect(ops).toContainEqual(['x', 21, 'Two']);
    expect(ops).toContainEqual(['c', 20, [21]]);
    expect(ops).toContainEqual(['c', 4, [5, 20]]);
    expect(ops).toContainEqual(['a', 2, 'class', 'big done']);
    // A node made and changed before it joins the page is told once, whole.
    expect(ops.filter((op) => op[0] === 'e')).toHaveLength(1);
  });

  it('reads and writes HTML', async () => {
    const doc = await page(`
      function fill() {
        const list = document.getElementById('list');
        list.innerHTML = '<li data-id="7">A &amp; B</li><li>C<br>D</li><!-- note --><script>steal()</script>';
        return [list.children.length, list.firstElementChild.dataset.id, list.firstElementChild.textContent, list.innerHTML];
      }`);
    const [count, id, text, html] = doc.call('fill') as [number, string, string, string];
    expect(count).toBe(3);
    expect(id).toBe('7');
    expect(text).toBe('A & B');
    expect(html).toBe('<li data-id="7">A &amp; B</li><li>C<br>D</li><!-- note --><script>steal()</script>');
  });

  it('dispatches the page’s events along its tree, capture, target and bubble', async () => {
    const doc = await page(`
      let seen = [];
      document.getElementById('list').addEventListener('click', function (e) { seen.push('list:' + e.target.textContent + ':' + (this === e.currentTarget)); });
      document.addEventListener('click', (e) => seen.push('doc-capture'), true);
      document.body.addEventListener('click', (e) => { seen.push('body'); });
      document.querySelector('li').addEventListener('click', (e) => { seen.push('li'); e.preventDefault(); });
      function read() { return seen; }`);
    const ops = doc.take();
    expect(ops).toContainEqual(['l', 'click']);
    expect(doc.event(5, 'click', { clientX: 3 })).toBe(1);
    expect(doc.call('read')).toEqual(['doc-capture', 'li', 'list:One:true', 'body']);
  });

  it('runs a form’s submit with what was typed in it', async () => {
    const doc = await page(`
      let added = [];
      document.getElementById('add').addEventListener('submit', (e) => {
        e.preventDefault();
        const data = new FormData(e.target);
        added.push(data.get('task'));
        e.target.querySelector('input').value = '';
      });
      function read() { return added; }`);
    doc.take();
    doc.sync([['v', 8, 'Buy milk']]);
    expect(doc.event(7, 'submit')).toBe(1);
    expect(doc.call('read')).toEqual(['Buy milk']);
    expect(doc.take()).toContainEqual(['p', 8, 'value', '']);
  });

  it('runs onclick="…" in HTML the code wrote, as a call of one of its functions', async () => {
    const doc = await page(
      `
      let removed = [];
      function remove(id, el) { removed.push(id + ':' + el.tagName); }
      document.getElementById('list').innerHTML = '<li><button onclick="remove(3, this)">x</button></li>';
      function read() { return removed; }`
    );
    const ops = doc.take();
    const button = ops.find((op) => op[0] === 'e' && op[2] === 'button')!;
    // The handler is the shell's: it is not an attribute the page is drawn with.
    expect(button[3]).toEqual({});
    doc.event(button[1] as number, 'click');
    expect(doc.call('read')).toEqual(['3:BUTTON']);
  });

  it('sends DOMContentLoaded and load once the page is drawn', async () => {
    const doc = await page(`
      let order = [document.readyState];
      document.addEventListener('DOMContentLoaded', () => order.push('ready:' + document.readyState));
      window.addEventListener('load', () => order.push('load:' + document.readyState));
      function read() { return order; }`);
    doc.ready();
    doc.ready();
    expect(doc.call('read')).toEqual(['loading', 'ready:interactive', 'load:complete']);
  });

  it('keeps what SoftN draws to SoftN', async () => {
    const doc = await page(`
      function read() {
        const card = document.getElementById('card');
        card.appendChild(document.createElement('p'));
        card.setAttribute('id', 'other');
        card.remove();
        return [card.children.length, card.id, document.getElementById('card'), document.body.childNodes.length];
      }`);
    expect(doc.call('read')).toEqual([0, 'card', null, 4]);
    expect(doc.take()).toContainEqual(['c', 1, [2, 4, 7, 11]]);
  });

  it('finds by the selectors pages use', async () => {
    const doc = await page(`
      function read() {
        const list = document.getElementById('list');
        list.innerHTML = '<li class="a">1</li><li class="b" data-x="yes">2</li><li class="a b">3</li>';
        return [
          document.querySelectorAll('li.a').length,
          document.querySelectorAll('.a.b').length,
          document.querySelector('li:nth-child(2)').textContent,
          document.querySelector('li:last-child').textContent,
          document.querySelectorAll('li:not(.a)').length,
          document.querySelector('[data-x^="ye"]').textContent,
          document.querySelectorAll('ul li, h1').length,
          document.querySelector('li.a + li').textContent,
          document.querySelector('h1 ~ form') !== null,
          list.querySelector(':scope') === null,
        ];
      }`);
    let result: unknown;
    try {
      result = doc.call('read');
    } catch (error) {
      result = String(error);
    }
    expect(result).toEqual([2, 1, '2', '3', 1, '2', 4, '2', true, true]);
  });

  it('runs on…="…" in HTML the code wrote as code, with this and event, in the page\u2019s scope', async () => {
    const doc = await page(`
      let count = 0;
      document.getElementById('list').innerHTML =
        '<li><button id="b" onclick="count++; this.textContent = count + \\':\\' + event.type">0</button></li>' +
        '<li><a id="a" href="#" onclick="count = 10; return false">ten</a></li>';
      function read() { return [count, document.getElementById('b').textContent]; }`);
    const ops = doc.take();
    const ids = Object.fromEntries(ops.filter((op) => op[0] === 'e').map((op) => [(op[3] as Record<string, string>).id, op[1] as number]));
    doc.event(ids.b, 'click');
    doc.event(ids.b, 'click');
    expect(doc.call('read')).toEqual([2, '2:click']);
    expect(doc.event(ids.a, 'click')).toBe(1);
    expect(doc.call('read')).toEqual([10, '2:click']);
  });

  it('gives the rest of a browser\u2019s window: location, URLSearchParams and the small helpers', async () => {
    const doc = await page(
      `
      function read() {
        const params = new URLSearchParams(location.search);
        params.append('q', 'a b&c');
        const copy = structuredClone({ a: [1, { b: 2 }] });
        sessionStorage.setItem('k', 'v');
        let queued = 'no';
        queueMicrotask(() => { queued = 'yes'; });
        return [location.pathname, location.search, location.hash, params.get('tab'), params.toString(), copy.a[1].b, sessionStorage.getItem('k'), sessionStorage.length, typeof fetch, typeof requestAnimationFrame];
      }
      function go() { location.href = 'about.html'; }
      function jump() { location.hash = 'top'; return location.hash; }`,
      { ...SEED, url: 'https://example.test/app/index.html?tab=2#intro' }
    );
    expect(doc.call('read')).toEqual(['/app/index.html', '?tab=2', '#intro', '2', 'tab=2&q=a+b%26c', 2, 'v', 1, 'function', 'function']);
    doc.take();
    // A fragment stays on the page; another page is asked of the host.
    expect(doc.call('jump')).toBe('#top');
    expect(doc.take()).toEqual([]);
    doc.call('go');
    expect(doc.take()).toEqual([['n', 'about.html']]);
  });
});

describe('code written for a browser', () => {
  it('is told by a name of the window used as one, not by a property of the same name', () => {
    for (const code of ['document.getElementById("a")', 'fetch("/api")', 'location.href = "a.html"', 'new URLSearchParams(location.search)', 'requestAnimationFrame(draw)', 'x = sessionStorage.getItem("k")']) {
      expect(usesDocument(code), code).toBe(true);
    }
    for (const code of ['let city = user.location.city', 'api.fetch(url)', 'let n = 1', 'softn.net.fetch(url, {}, done)', 'my_location.x = 1']) {
      expect(usesDocument(code), code).toBe(false);
    }
  });
});
