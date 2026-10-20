/**
 * The document a page's code is given (document-shell/shell-source.ts), run
 * in ZIPP as a page's logic runs: found by id, changed, listened to, and
 * every change told to the host as operations on nodes by id.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ZippWasmAdapter } from '../src/runtime/zipp-wasm-adapter';
import { SHELL_EVENT, SHELL_READY, SHELL_SYNC, SHELL_TAKE, usesDocument } from '../src/document-shell/names';
import { shellPrelude } from '../src/document-shell/shell-source';

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
  const takePage = (failed = false) => run.callFunction(SHELL_TAKE, [failed]) as Op[] | null;
  return {
    // Every page of what the code changed, as the host reads it (takeDocumentChanges).
    take: () => {
      const all: Op[] = [];
      for (let page = takePage(); page; page = takePage()) for (const op of page) all.push(op);
      return all;
    },
    takePage,
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

describe('the document, as a browser keeps it', () => {
  it('does not run a listener taken off by one before it during the same event', async () => {
    const doc = await page(`
      let ran = [];
      const list = document.getElementById('list');
      function second() { ran.push('second'); }
      list.addEventListener('click', () => { ran.push('first'); list.removeEventListener('click', second); });
      list.addEventListener('click', second);
      function read() { return ran; }`);
    doc.take();
    doc.event(4, 'click');
    expect(doc.call('read')).toEqual(['first']);
  });

  it('reads <div/> in HTML as an open <div>, as a browser does, and <circle/> in a drawing as closed', async () => {
    const doc = await page(`
      function read() {
        const list = document.getElementById('list');
        list.innerHTML = '<div/><span>in</span>';
        const box = list.firstChild;
        list.innerHTML = '<svg><circle r="1"/><rect/></svg>';
        return [box.children.length, list.firstChild.children.length];
      }`);
    expect(doc.call('read')).toEqual([1, 2]);
  });

  it('puts a table\u2019s rows in the <tbody> a browser adds', async () => {
    const doc = await page(`
      function read() {
        const list = document.getElementById('list');
        list.innerHTML = '<table><tr><td>a</td></tr><tr><td>b</td></tr></table><table><thead><tr><td>h</td></tr></thead></table>';
        const tables = list.querySelectorAll('table');
        return [tables[0].querySelectorAll('tbody > tr').length, tables[1].querySelectorAll('tbody').length, tables[1].querySelectorAll('thead > tr').length];
      }`);
    expect(doc.call('read')).toEqual([2, 0, 1]);
  });

  it('makes URLSearchParams from another, or from a form', async () => {
    const doc = await page(`
      function read() {
        const a = new URLSearchParams('x=1&y=2');
        const b = new URLSearchParams(a);
        document.querySelector('input[name="task"]').value = 'milk';
        const c = new URLSearchParams(new FormData(document.getElementById('add')));
        return [b.toString(), c.toString()];
      }`);
    expect(doc.call('read')).toEqual(['x=1&y=2', 'task=milk']);
  });

  it('lets go of a node taken off the page: an event for it finds nothing', async () => {
    const doc = await page(`
      function remove() { document.getElementById('title').remove(); }`);
    doc.take();
    doc.call('remove');
    expect(doc.event(2, 'click')).toBe(0);
  });
});

/** The id of the element the code made with this id attribute, from the ops that announced it. */
function idOf(ops: Op[], id: string): number {
  const op = ops.find((o) => o[0] === 'e' && (o[3] as Record<string, string>).id === id);
  if (!op) throw new Error('no element #' + id);
  return op[1] as number;
}

describe('a long list built a row at a time', () => {
  // Each row told the host the list's children whole, so 2,000 rows came to
  // two million ids in one turn: more than the engine hands the host in one
  // read. The read failed, and the turn's other changes (its listeners too)
  // went with it.
  it('tells the host each parent once a turn, with its children as the turn leaves them', async () => {
    const doc = await page(`
      function fill(n) {
        const list = document.getElementById('list');
        for (let i = 0; i < n; i++) { const li = document.createElement('li'); li.textContent = 'row ' + i; list.appendChild(li); }
        list.addEventListener('dblclick', () => {});
      }`);
    doc.take();
    doc.call('fill', 3000);
    const ops = doc.take();
    const lists = ops.filter((op) => op[0] === 'c' && op[1] === 4);
    expect(lists).toHaveLength(1);
    expect(lists[0][2] as number[]).toHaveLength(3001);
    const told = ops.filter((op) => op[0] === 'c').reduce((n, op) => n + (op[2] as number[]).length, 0);
    expect(told).toBeLessThan(7000);
    expect(ops).toContainEqual(['l', 'dblclick']);
  });

  // A list given a row and taken off the page in one turn: the host is told
  // of the row with the list, so it lets go of both, rather than keeping the
  // row in its mirror for good.
  it('tells the host of a parent taken off the page in the same turn', async () => {
    const doc = await page(`
      function change() {
        const list = document.getElementById('list');
        const li = document.createElement('li');
        list.appendChild(li);
        list.remove();
        return li.__softnNode;
      }`);
    doc.take();
    const row = doc.call('change') as number;
    const ops = doc.take();
    expect(ops).toContainEqual(['c', 4, [5, row]]);
    expect(ops).toContainEqual(['c', 1, [2, 7, 11, 12]]);
  });

  // The host reads a page at a time; a page it could not read is not lost,
  // but asked for again and sent in halves.
  it('hands a big turn over a page at a time, and a page the host could not read again', async () => {
    const doc = await page(`
      function fill(n) { const list = document.getElementById('list'); for (let i = 0; i < n; i++) list.appendChild(document.createElement('li')); }`);
    doc.take();
    doc.call('fill', 25000);
    const first = doc.takePage()!;
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(25000);
    const again = doc.takePage(true)!;
    expect(again.length).toBeLessThan(first.length);
    expect(again).toEqual(first.slice(0, again.length));
    const ops = [...again];
    for (let page = doc.takePage(); page; page = doc.takePage()) ops.push(...page);
    expect(ops.filter((op) => op[0] === 'e')).toHaveLength(25000);
    const list = ops.find((op) => op[0] === 'c' && op[1] === 4)!;
    expect(list[2] as number[]).toHaveLength(25001);
  });
});

describe('lists, as a browser keeps them live', () => {
  // The lists were copies, so the usual loop that takes items off a list as
  // it goes (while (items.length) items[0].classList.remove('x')) never
  // ended, and ran the engine out of its budget for good.
  it('reads children, childNodes and getElementsBy… again as the page changes', async () => {
    const doc = await page(`
      function read() {
        const list = document.getElementById('list');
        list.innerHTML = '<li class="x">a</li><li class="x">b</li><li class="x">c</li>';
        const items = document.getElementsByClassName('x');
        const kids = list.children;
        const nodes = list.childNodes;
        const lis = list.getElementsByTagName('li');
        const out = [items.length, kids === list.children, nodes === list.childNodes];
        let turns = 0;
        while (items.length && turns < 10) { items[0].classList.remove('x'); turns++; }
        out.push(turns, items.length);
        list.appendChild(document.createElement('li')).id = 'last';
        list.appendChild(document.createTextNode('t'));
        out.push(kids.length, nodes.length, lis.length, kids.item(3).id, kids.namedItem('last') === kids[3], kids.last === kids[3]);
        let seen = 0;
        nodes.forEach(() => { seen++; });
        out.push(seen, [...kids].length);
        return out;
      }`);
    expect(doc.call('read')).toEqual([3, true, true, 3, 0, 4, 5, 4, 'last', true, true, 5, 4]);
  });
});

describe('a click on a box', () => {
  // The box changed only once the host told of the input and change after
  // it, so a click listener read the state the box had before the click.
  // HTML changes it before the click is dispatched, and back if the click
  // is cancelled.
  const BOXES = `
    document.getElementById('list').innerHTML =
      '<li><input type="checkbox" id="c"><input type="radio" name="r" id="r1" checked><input type="radio" name="r" id="r2"></li>';
    const seen = [];
    let cancel = false;
    for (const id of ['c', 'r2']) {
      document.getElementById(id).addEventListener('click', function (e) {
        seen.push(id + ':' + this.checked + ':' + document.getElementById('r1').checked);
        if (cancel) e.preventDefault();
      });
      document.getElementById(id).addEventListener('change', () => seen.push(id + ':change'));
    }
    function click(id, cancelIt) { cancel = cancelIt; document.getElementById(id).click(); return state(); }
    function state() { return [document.getElementById('c').checked, document.getElementById('r1').checked, document.getElementById('r2').checked]; }
    function read() { const out = seen.slice(); seen.length = 0; return out; }`;

  it('when the code clicks it', async () => {
    const doc = await page(BOXES);
    expect(doc.call('click', 'c', false)).toEqual([true, true, false]);
    expect(doc.call('read')).toEqual(['c:true:true', 'c:change']);
    expect(doc.call('click', 'c', true)).toEqual([true, true, false]);
    expect(doc.call('read')).toEqual(['c:false:true']);
    expect(doc.call('click', 'r2', true)).toEqual([true, true, false]);
    expect(doc.call('read')).toEqual(['r2:true:false']);
    expect(doc.call('click', 'r2', false)).toEqual([true, false, true]);
    expect(doc.call('read')).toEqual(['r2:true:false', 'r2:change']);
  });

  it('when the person clicks it on the page', async () => {
    const doc = await page(BOXES);
    const ops = doc.take();
    expect(doc.event(idOf(ops, 'c'), 'click')).toBe(0);
    expect(doc.call('state')).toEqual([true, true, false]);
    expect(doc.call('read')).toEqual(['c:true:true']);
    // The page already shows it: nothing is told back.
    expect(doc.take()).toEqual([]);
    doc.call('click', 'r2', true);
    doc.call('read');
    doc.take();
    expect(doc.event(idOf(ops, 'r2'), 'click') & 1).toBe(1);
    expect(doc.call('state')).toEqual([true, true, false]);
    expect(doc.call('read')).toEqual(['r2:true:false']);
  });
});

describe('style, as CSS reads it', () => {
  // A ; inside url("data:…;base64,…") ended the declaration, so the next
  // write cut the image; !important was lost, and cssFloat and webkit…
  // names were written as no property CSS has.
  it('keeps a data: URL whole, a priority, and the names a browser maps', async () => {
    const doc = await page(`
      function read() {
        const el = document.getElementById('title');
        el.style.backgroundImage = 'url("data:image/gif;base64,AAAA")';
        el.style.color = 'red';
        el.style.setProperty('width', '1px', 'important');
        el.style.cssFloat = 'left';
        el.style.webkitTransform = 'none';
        return [
          el.getAttribute('style'), el.style.backgroundImage, el.style.getPropertyPriority('width'), el.style.width,
          el.style.length, el.style[0], el.style.item(4), el.style.cssFloat,
        ];
      }`);
    expect(doc.call('read')).toEqual([
      'background-image: url("data:image/gif;base64,AAAA"); color: red; width: 1px !important; float: left; transform: none;',
      'url("data:image/gif;base64,AAAA")', 'important', '1px', 5, 'background-image', 'transform', 'left',
    ]);
  });
});

describe('HTML the code writes, read as a browser reads it', () => {
  // A table of about 40 names, each needing its ;: &eacute;, &copy 2026,
  // &#X41; and &#x80; were left as written.
  it('reads character references as HTML does, from SoftN\u2019s own table', async () => {
    const doc = await page(`
      function read() {
        const list = document.getElementById('list');
        list.innerHTML = '<li title="?a=1&copy=2" lang="&amp;b">Caf&eacute; &copy 2026 &#X41; &#x80; &hellip; &rsaquo;&Omega; &notit; &#0;</li>';
        return [list.textContent, list.firstChild.title, list.firstChild.lang];
      }`);
    expect(doc.call('read')).toEqual(['Café © 2026 A € … ›Ω ¬it; \ufffd', '?a=1&copy=2', '&b']);
  });

  // Attribute names were lowercased (a viewBox the drawing ignores), <defs/>
  // was left open, and an <svg>'s tagName was SVG.
  it('reads a drawing\u2019s names in their case, and /> as the end of one of its elements', async () => {
    const doc = await page(`
      function read() {
        const list = document.getElementById('list');
        list.innerHTML = '<li><svg viewBox="0 0 10 10"><defs/><lineargradient id="g"/><rect/></svg></li>';
        const svg = list.querySelector('svg');
        const made = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        made.setAttribute('viewBox', '0 0 1 1');
        made.innerHTML = '<circle r="1"/>';
        return [
          svg.outerHTML, svg.tagName, svg.namespaceURI, made.outerHTML, made.tagName, made.firstChild.namespaceURI,
          made.getAttribute('viewbox'), list.querySelectorAll('linearGradient').length, made instanceof SVGElement,
        ];
      }`);
    expect(doc.call('read')).toEqual([
      '<svg viewBox="0 0 10 10"><defs></defs><linearGradient id="g"></linearGradient><rect></rect></svg>', 'svg', 'http://www.w3.org/2000/svg',
      '<svg viewBox="0 0 1 1"><circle r="1"></circle></svg>', 'svg', 'http://www.w3.org/2000/svg', null, 1, true,
    ]);
    // Told to the host in its case, for the page to draw.
    expect(doc.take()).toContainEqual(expect.arrayContaining(['e', expect.any(Number), 'linearGradient', { id: 'g' }]));
  });

  // Names in a drawing keep their case in the page's document, but the host
  // is told them as it always was: in lower case but for SVG's own, and
  // never a handler, whatever its case. A Capitalised tag is a component's
  // name to SoftN, not one the code may choose by way of a drawing.
  it('tells the host a drawing\u2019s names in lower case but for SVG\u2019s own, and no handler', async () => {
    const doc = await page(`
      function make() {
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', '0 0 1 1');
        svg.setAttribute('OnClick', 'steal()');
        svg.setAttribute('DATA-X', '1');
        const card = document.createElementNS(ns, 'Card');
        card.setAttribute('onLoad', 'steal()');
        svg.appendChild(card);
        svg.appendChild(document.createElementNS(ns, 'linearGradient'));
        document.getElementById('list').appendChild(svg);
        svg.setAttribute('ONMOUSEOVER', 'steal()');
        svg.setAttribute('preserveAspectRatio', 'none');
        return [card.tagName, svg.getAttribute('OnClick')];
      }`);
    doc.take();
    expect(doc.call('make')).toEqual(['Card', 'steal()']);
    const ops = doc.take();
    const tags = ops.filter((op) => op[0] === 'e').map((op) => op[2]);
    expect(tags).toEqual(['svg', 'card', 'linearGradient']);
    const names = ops.flatMap((op) => (op[0] === 'e' ? Object.keys(op[3] as object) : op[0] === 'a' ? [op[2] as string] : []));
    expect(names.sort()).toEqual(['data-x', 'preserveAspectRatio', 'viewBox']);
  });

  // What a <template> was given went into the template, where the page found
  // it, rather than into its content.
  it('puts a <template>\u2019s children in its content, and writes them out with it', async () => {
    const doc = await page(`
      function read() {
        const list = document.getElementById('list');
        list.innerHTML = '<template><li class="in">x</li></template>';
        const t = list.firstChild;
        const made = document.createElement('template');
        made.innerHTML = '<b>y</b>';
        return [t.content.childNodes.length, t.childNodes.length, document.querySelectorAll('.in').length, t.innerHTML, made.outerHTML];
      }`);
    expect(doc.call('read')).toEqual([1, 0, 0, '<li class="in">x</li>', '<template><b>y</b></template>']);
  });

  // The cheap parts of HTML's tree building: a <p> a block ends, the text of
  // an <xmp> or <iframe>, the first of two attributes, the newline a <pre>
  // starts with, cells and rows a browser closes, and \r\n as \n.
  it('ends what HTML ends, and keeps what it keeps', async () => {
    const doc = await page(`
      function html(text) { const box = document.createElement('div'); box.innerHTML = text; return box.innerHTML; }
      function read() {
        const pre = document.createElement('div');
        pre.innerHTML = '<pre>\\nx</pre><textarea>\\ny</textarea>a\\r\\nb';
        return [
          html('<p>a<div>b</div>'), html('<p>a<ul><li>x<li>y</ul>'), html('<xmp><b>x</b></xmp>'), html('<div id="a" id="b"></div>'),
          html('<script>a</scriptx>b</script>c'), html('<table><tr><td>a<td>b<tr><td>c</table>'), html('<style>a > b</style>'),
          html('<p title="<a>">x</p>'), html('<form><form>x</form></form>'), html('<!--a--!>b'),
          pre.firstChild.textContent, pre.childNodes[1].value, pre.lastChild.data,
        ];
      }`);
    expect(doc.call('read')).toEqual([
      '<p>a</p><div>b</div>', '<p>a</p><ul><li>x</li><li>y</li></ul>', '<xmp><b>x</b></xmp>', '<div id="a"></div>',
      '<script>a</scriptx>b</script>c', '<table><tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></tbody></table>',
      '<style>a > b</style>', '<p title="&lt;a&gt;">x</p>', '<form>x</form>', '<!--a-->b',
      'x', 'y', 'a\nb',
    ]);
  });
});

describe('the tree, changed as a browser changes it', () => {
  // outerHTML could not be set; innerText kept a newline as text; classList
  // kept duplicates, could not be read by index, and remove() gave an
  // element with no class an empty one.
  it('sets outerHTML and innerText, and keeps a class list as a browser does', async () => {
    const doc = await page(`
      function read() {
        const list = document.getElementById('list');
        list.innerHTML = '<li>old</li>';
        list.firstChild.outerHTML = '<li>new</li><li>two</li>';
        const out = [list.innerHTML];
        const title = document.getElementById('title');
        title.innerText = 'a\\nb';
        out.push(title.innerHTML, title.innerText);
        title.className = 'a a b';
        title.classList.add('c');
        const plain = document.createElement('p');
        plain.classList.remove('z');
        out.push(title.className, title.classList[0], title.classList[2], title.classList.length, plain.hasAttribute('class'));
        return out;
      }`);
    expect(doc.call('read')).toEqual(['<li>new</li><li>two</li>', 'a<br>b', 'a\nb', 'a b c', 'a', 'c', 3, false]);
  });

  // replaceWith() and replaceChild() of a node with itself took it out;
  // a ref that is not a child was used anyway; a text and a comment had no
  // before(), after() or replaceWith().
  it('moves nodes among their siblings, and refuses what a browser refuses', async () => {
    const doc = await page(`
      function tryit(f) { try { return f(); } catch (e) { return e.name + ':' + (e instanceof DOMException); } }
      function read() {
        const list = document.getElementById('list');
        list.innerHTML = '<li id="a"></li><li id="b"></li>';
        const a = list.firstChild;
        a.replaceWith(a);
        list.replaceChild(list.lastChild, list.lastChild);
        const out = [list.children.length];
        out.push(tryit(() => list.insertBefore(document.createElement('li'), document.createElement('li'))));
        out.push(tryit(() => list.removeChild(document.createElement('li'))));
        out.push(tryit(() => a.appendChild(list)));
        out.push(tryit(() => document.createTextNode('t').appendChild(a)));
        const text = document.createTextNode('t');
        a.appendChild(text);
        text.before('<', document.createElement('i'));
        text.after(document.createComment('c'));
        text.replaceWith(document.createElement('b'));
        out.push(a.innerHTML);
        return out;
      }`);
    expect(doc.call('read')).toEqual([2, 'NotFoundError:true', 'NotFoundError:true', 'HierarchyRequestError:true', 'HierarchyRequestError:true', '&lt;<i></i><b></b><!--c-->']);
  });

  // A box's value was '' (a browser gives 'on'), and a button's tabIndex -1.
  it('reflects a field\u2019s properties with a browser\u2019s defaults', async () => {
    const doc = await page(`
      function read() {
        const box = document.createElement('input');
        box.type = 'checkbox';
        const odd = document.createElement('input');
        odd.setAttribute('type', 'bogus');
        const number = document.createElement('input');
        number.type = 'number';
        number.value = 'abc';
        return [box.value, document.createElement('button').tabIndex, document.createElement('div').tabIndex, odd.type, number.value];
      }`);
    expect(doc.call('read')).toEqual(['on', 0, -1, 'text', '']);
  });

  // getElementById walked the whole page each time; now an index, which
  // must still answer as the page changes.
  it('finds by id from an index kept as the page changes', async () => {
    const doc = await page(`
      function read() {
        const list = document.getElementById('list');
        const out = [document.getElementById('card').tagName];
        list.innerHTML = '<li id="x">1</li><li id="x">2</li>';
        out.push(document.getElementById('x').textContent);
        list.firstChild.remove();
        out.push(document.getElementById('x').textContent);
        list.firstChild.id = 'y';
        out.push(document.getElementById('x'), document.getElementById('y').textContent);
        const apart = document.createElement('p');
        apart.id = 'z';
        out.push(document.getElementById('z'));
        list.appendChild(apart);
        out.push(document.getElementById('z') === apart);
        return out;
      }`);
    expect(doc.call('read')).toEqual(['CARD', '1', '2', null, '2', null, true]);
  });

  // A name of Object's own: 'constructor' found Object's constructor in the
  // selector cache, and an event type 'toString' its function.
  it('takes constructor and toString as names like any other', async () => {
    const doc = await page(`
      function read() {
        const list = document.getElementById('list');
        let heard = 0;
        list.addEventListener('toString', () => { heard++; });
        list.dispatchEvent(new Event('toString'));
        return [document.querySelectorAll('constructor').length, heard, document.createElement('constructor').tagName];
      }`);
    expect(doc.call('read')).toEqual([0, 1, 'CONSTRUCTOR']);
  });

  // innerHTML told an observer two records where a browser tells one, and
  // setting an attribute to the value it had told none.
  it('tells a MutationObserver what a browser tells it', async () => {
    const doc = await page(`
      function read() {
        const list = document.getElementById('list');
        list.setAttribute('x', '1');
        const o = new MutationObserver(() => {});
        o.observe(list, { childList: true, attributes: true });
        list.innerHTML = '<li></li>';
        list.setAttribute('x', '1');
        return o.takeRecords().map((r) => r.type + ' +' + r.addedNodes.length + ' -' + r.removedNodes.length);
      }`);
    expect(doc.call('read')).toEqual(['childList +1 -1', 'attributes +0 -0']);
  });
});

describe('selectors, as CSS reads them', () => {
  // Each of these threw, and a page's querySelector stopped its script.
  it('reads escapes, strings, :has(), :nth-of-type() and the pseudo-classes pages use', async () => {
    const doc = await page(`
      function read() {
        const list = document.getElementById('list');
        list.innerHTML = '<li class="md:flex" title=")"><a href="#">1</a></li><li lang="en-GB">2</li><li>3</li>' +
          '<li><input required><input readonly><textarea></textarea><x-y></x-y></li>';
        const n = (s) => list.querySelectorAll(s).length;
        return [
          n('li:nth-of-type(2)'), n('li:nth-last-of-type(1)'), n('li:has(a)'), n('li:has(> a[href])'), n('.md\\\\:flex'),
          n('li:not([title=")"])'), n(':optional'), n(':read-only'), n(':read-write'), n(':defined'), n(':lang(en)'),
          n(':dir(ltr)'), n(':any-link'), n(':target'), n('li::before'), n(':is(.md\\\\:flex, :nth-child(2 of li))'),
          list.matches(':scope'), list.closest(':scope') === list,
        ];
      }`);
    expect(doc.call('read')).toEqual([1, 1, 1, 1, 1, 3, 2, 7, 2, 8, 1, 9, 1, 0, 0, 2, true, true]);
  });

  // What CSS refuses was taken, or refused with a plain Error.
  it('refuses what CSS refuses, with a SyntaxError DOMException', async () => {
    const doc = await page(`
      function read() {
        return ['', 'div,', 'div >', '.1a', ':nth-child()', 'a!b', ':foo', '[x=1]', ':not(::before)'].map((s) => {
          try { document.querySelectorAll(s); return 'taken'; } catch (e) { return e.name + ':' + (e instanceof DOMException); }
        });
      }`);
    expect(doc.call('read')).toEqual(new Array(9).fill('SyntaxError:true'));
  });

  // [class~=""] matched, :empty did not see past a comment, :checked matched
  // a text field, and [type=checkbox] did not find type="CHECKBOX".
  it('matches as a browser matches', async () => {
    const doc = await page(`
      function read() {
        const list = document.getElementById('list');
        list.innerHTML = '<li class=" a"><!--c--></li><li><input type="text" checked><input type="CHECKBOX" checked></li>';
        const n = (s) => list.querySelectorAll(s).length;
        return [n('[class~=""]'), n('li:empty'), n(':checked'), n('[type=checkbox]')];
      }`);
    expect(doc.call('read')).toEqual([0, 1, 1, 1]);
  });
});

describe('a disabled fieldset', () => {
  // Its fields were still checked, :disabled and sent; and :disabled or
  // :enabled matched any element, a <div> included.
  it('disables what is in it, as HTML has it', async () => {
    const doc = await page(`
      function read() {
        const list = document.getElementById('list');
        list.innerHTML = '<li><form><fieldset disabled><legend><input name="kept" value="1"></legend><input name="a" value="1" required></fieldset><input name="b" value="2"></form><div disabled></div></li>';
        const form = list.querySelector('form');
        return [
          form.querySelectorAll(':disabled').length, form.checkValidity(), Array.from(new FormData(form)).map((e) => e.join('=')).join('&'),
          list.querySelectorAll('div:disabled, div:enabled').length, list.querySelectorAll(':enabled').length,
        ];
      }`);
    expect(doc.call('read')).toEqual([2, true, 'kept=1&b=2', 0, 2]);
  });
});

describe('events at their target', () => {
  // At the target, bubble listeners ran before capture ones and a stop in a
  // capture listener did not stop them; on… ran last whenever it was set;
  // and { signal }, { passive }, cancelBubble and returnValue were not read.
  it('run as browsers run them now', async () => {
    const doc = await page(`
      function read() {
        const log = [];
        const el = document.getElementById('title');
        el.addEventListener('x', () => log.push('bubble'));
        el.addEventListener('x', () => log.push('capture'), true);
        el.dispatchEvent(new Event('x'));
        const stop = document.createElement('p');
        stop.addEventListener('y', (e) => { log.push('stop'); e.stopPropagation(); }, true);
        stop.addEventListener('y', () => log.push('not run'));
        stop.dispatchEvent(new Event('y'));
        el.onclick = () => log.push('onclick');
        el.addEventListener('click', () => log.push('listener'));
        el.dispatchEvent(new MouseEvent('click'));
        const controller = new AbortController();
        el.addEventListener('z', () => log.push('aborted'), { signal: controller.signal });
        controller.abort();
        el.addEventListener('z', (e) => e.preventDefault(), { passive: true });
        el.addEventListener('w', (e) => { e.returnValue = false; e.cancelBubble = true; });
        document.body.addEventListener('w', () => log.push('bubbled'));
        const z = new Event('z', { cancelable: true });
        const w = new Event('w', { cancelable: true, bubbles: true });
        el.dispatchEvent(z);
        el.dispatchEvent(w);
        return [log, z.defaultPrevented, w.defaultPrevented, w.srcElement === el];
      }`);
    expect(doc.call('read')).toEqual([['capture', 'bubble', 'stop', 'onclick', 'listener'], false, true, true]);
  });
});

describe('the rest of what a browser does with a click, a name or a node', () => {
  const BOX = `
    function box(html) { const d = document.createElement('div'); document.body.appendChild(d); d.innerHTML = html; return d; }`;

  // A label's click did not reach its field, a reset button did not reset,
  // a <summary> did not open its <details>, and a disabled button was clicked.
  it('does what a click does', async () => {
    const doc = await page(BOX + `
      function read() {
        const d = box('<form><label for="c">L</label><input type="checkbox" id="c"><input id="t" value="a"><button type="reset">R</button></form>' +
          '<details><summary>S</summary>x</details><button id="off" disabled>D</button>');
        let heard = 0;
        d.querySelector('#off').addEventListener('click', () => { heard++; });
        d.querySelector('label').click();
        const ticked = d.querySelector('#c').checked;
        d.querySelector('#t').value = 'b';
        d.querySelector('button[type=reset]').click();
        d.querySelector('summary').click();
        d.querySelector('#off').click();
        return [ticked, d.querySelector('#c').checked, d.querySelector('#t').value, d.querySelector('details').open, heard];
      }`);
    expect(doc.call('read')).toEqual([true, false, 'a', true, 0]);
  });

  // Each of these was taken, or refused with a plain Error.
  it('refuses the names and places a browser refuses, with its DOMException', async () => {
    const doc = await page(BOX + `
      function read() {
        const p = box('<p>x</p>').firstChild;
        return [
          () => document.createElement('a b'), () => p.setAttribute('a b', '1'), () => { p.dataset['a-b'] = '1'; },
          () => p.classList.add('a b'), () => p.classList.add(''), () => p.insertAdjacentHTML('middle', 'x'),
          () => document.createElement('i').insertAdjacentHTML('afterend', 'x'),
        ].map((f) => { try { f(); return 'taken'; } catch (e) { return e.name + ':' + e.code; } });
      }`);
    expect(doc.call('read')).toEqual([
      'InvalidCharacterError:5', 'InvalidCharacterError:5', 'SyntaxError:12', 'InvalidCharacterError:5', 'SyntaxError:12',
      'SyntaxError:12', 'NoModificationAllowedError:7',
    ]);
  });

  // normalize() did nothing; a text had no splitText(), appendData() and the
  // rest; attributes was a copy with no names; a copy of a button kept a
  // handler set as a property, and lost one written as an attribute.
  it('changes text in parts, keeps attributes live, and copies what a browser copies', async () => {
    const doc = await page(BOX + `
      let clicked = 0;
      function read() {
        const d = box('');
        d.append('a', 'b', '');
        d.normalize();
        const out = [d.childNodes.length, d.firstChild.data];
        const rest = d.firstChild.splitText(1);
        const t = d.firstChild;
        t.appendData('c');
        t.insertData(0, '[');
        t.replaceData(1, 1, 'A');
        out.push(d.childNodes.length, rest.data, t.data, t.substringData(1, 2), t.length);
        const p = box('<p x="1" y="2"></p>').firstChild;
        const at = p.attributes;
        out.push(at.length, at[0].name, at.y.value, at.getNamedItem('x').value, at === p.attributes);
        p.setAttribute('z', '3');
        out.push(at.length);
        const b = document.createElement('button');
        b.setAttribute('onclick', 'clicked++');
        b.onmouseover = () => {};
        const copy = b.cloneNode(true);
        copy.click();
        out.push(clicked, copy.getAttribute('onclick'), copy.onmouseover);
        return out;
      }`);
    expect(doc.call('read')).toEqual([1, 'ab', 2, 'b', '[Ac', 'Ac', 3, 2, 'x', '2', '1', true, 3, 1, 'clicked++', null]);
  });

  // :scope of the document is its root element and of a fragment nothing;
  // :is() leaves out what it cannot read; *| and | prefixes, and a selector
  // the end of the text leaves open, are read as CSS reads them.
  it('reads :scope, forgiving lists, namespaces and an unclosed end as CSS does', async () => {
    const doc = await page(BOX + `
      function read() {
        const d = box('<p class="a">a</p><svg><rect/></svg>');
        const f = document.createDocumentFragment();
        f.appendChild(document.createElement('p'));
        const n = (root, s) => root.querySelectorAll(s).length;
        return [
          n(document, ':scope'), n(document, ':scope > body'), n(f, ':scope > p'), n(d, ':is(:nope, .a)'), n(d, ':where()'),
          n(d, '*|rect'), n(d, '|p'), n(d, 'p[class="a'), n(d, 'p:not(.b'),
        ];
      }`);
    expect(doc.call('read')).toEqual([1, 1, 0, 1, 0, 1, 0, 1, 1]);
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
