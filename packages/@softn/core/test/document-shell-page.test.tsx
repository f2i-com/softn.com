/**
 * A page written as HTML, with its code written for a browser: the code is
 * given the page as its document, and what it does to it is drawn, through
 * the renderer's checks, as if it had been written in the page.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SoftNRenderer } from '../src/loader/SoftNRenderer';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let root: Root | null = null;
let container: HTMLElement;

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = null;
  }
  container?.remove();
});

async function mount(source: string, ready: () => boolean, props: Partial<React.ComponentProps<typeof SoftNRenderer>> = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(<SoftNRenderer source={source} appId="document-shell-page" scriptExecutionMode="main" {...props} />);
  });
  for (let i = 0; i < 100 && !ready(); i++) {
    await act(async () => {
      await sleep(20);
    });
  }
}

const $ = <T extends Element = HTMLElement>(selector: string) => container.querySelector<T>(selector);

async function settle() {
  await act(async () => {
    await sleep(30);
  });
}

async function type(input: HTMLInputElement, text: string) {
  await act(async () => {
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const TODO = `<!DOCTYPE html>
<html>
<head><title>Tasks</title></head>
<body>
  <h1 id="title">Tasks</h1>
  <form id="add"><input id="task" name="task"><button>Add</button></form>
  <ul id="list"></ul>
  <p id="count">0 left</p>
  <script>
    const list = document.getElementById('list');
    function render() {
      const left = list.querySelectorAll('li:not(.done)').length;
      document.getElementById('count').textContent = left + ' left';
    }
    document.getElementById('add').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('task');
      if (!input.value.trim()) return;
      const li = document.createElement('li');
      li.textContent = input.value.trim();
      li.addEventListener('click', () => { li.classList.toggle('done'); render(); });
      list.appendChild(li);
      input.value = '';
      render();
    });
    document.addEventListener('DOMContentLoaded', () => {
      document.getElementById('title').textContent = 'My tasks';
    });
  </script>
</body>
</html>`;

describe('a page whose code is written for a browser', () => {
  it('runs as it would in one: a to-do list', async () => {
    await mount(TODO, () => $('#title')?.textContent === 'My tasks');
    expect($('#title')!.textContent).toBe('My tasks');

    const input = $<HTMLInputElement>('#task')!;
    await type(input, 'Buy milk');
    await act(async () => {
      $('#add')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await settle();
    expect([...container.querySelectorAll('#list li')].map((li) => li.textContent)).toEqual(['Buy milk']);
    expect($('#count')!.textContent).toBe('1 left');
    expect($<HTMLInputElement>('#task')!.value).toBe('');

    await type($<HTMLInputElement>('#task')!, 'Walk the dog');
    await act(async () => {
      $('#add')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await settle();
    expect($('#count')!.textContent).toBe('2 left');

    await act(async () => {
      container.querySelector<HTMLElement>('#list li')!.click();
    });
    await settle();
    expect(container.querySelector('#list li')!.className).toBe('done');
    expect($('#count')!.textContent).toBe('1 left');

    // The input the person typed in is the one that was drawn first: the
    // page was changed around it, not drawn again.
    expect($<HTMLInputElement>('#task')).toBe(input);
  });

  it('shares its state with SoftN’s own markup', async () => {
    await mount(
      `<p id="shown">clicked {n}</p><button id="more">More</button>
<script>
  let n = 0;
  document.getElementById('more').addEventListener('click', () => { n++; });
</script>`,
      () => $('#shown')?.textContent === 'clicked 0'
    );
    await act(async () => {
      $('#more')!.click();
    });
    await settle();
    await act(async () => {
      $('#more')!.click();
    });
    await settle();
    expect($('#shown')!.textContent).toBe('clicked 2');
  });

  it('draws what the code writes only as the page’s own markup could be drawn', async () => {
    await mount(
      `<div id="box"></div>
<script>
  document.getElementById('box').innerHTML =
    '<p id="ok" style="color: red" class="note">fine</p>' +
    '<script>window.stolen = 1<\\/script>' +
    '<iframe src="https://example.com"></iframe>' +
    '<img id="pic" src="x.png" onerror="steal()">' +
    '<a id="bad" href="javascript:alert(1)">bad</a>' +
    '<button id="b" onclick="alert(1)">b</button>';
</script>`,
      () => $('#ok') !== null
    );
    const box = $('#box')!;
    expect($('#ok')!.textContent).toBe('fine');
    expect($<HTMLElement>('#ok')!.style.color).toBe('red');
    expect(box.querySelector('script')).toBeNull();
    expect(box.querySelector('iframe')).toBeNull();
    expect($('#pic')!.getAttribute('onerror')).toBeNull();
    const href = $('#bad')!.getAttribute('href');
    expect(href === null || !/^javascript:/i.test(href)).toBe(true);
    expect($('#b')!.getAttribute('onclick')).toBeNull();
    expect((window as unknown as { stolen?: number }).stolen).toBeUndefined();
  });

  it('keeps the names a page declares itself', async () => {
    await mount(
      `<p id="shown">{label}</p>
<script>
  class Comment { constructor(text) { this.text = text; } }
  let Event = 'launch';
  let label = new Comment('hello').text + ' ' + Event;
  document.getElementById('shown').classList.add('ready');
</script>`,
      () => $('#shown')?.className === 'ready'
    );
    expect($('#shown')!.textContent).toBe('hello launch');
  });

  it('fetches, names the page and goes to another, through its host', async () => {
    const asked: Array<[string, Record<string, unknown>]> = [];
    const titles: string[] = [];
    const links: string[] = [];
    await mount(
      `<p id="out">waiting</p><button id="go">Go</button>
<script>
  fetch('https://api.example.test/books', { method: 'post', headers: { 'X-Mode': 'test' }, body: { n: 1 } })
    .then((response) => response.json().then((books) => {
      document.getElementById('out').textContent = response.status + ' ' + books.length + ' ' + response.headers.get('content-type');
      document.title = 'Books (' + books.length + ')';
    }))
    .catch((error) => { document.getElementById('out').textContent = 'failed: ' + error.message; });
  document.getElementById('go').addEventListener('click', () => { location.href = 'about.html'; });
</script>`,
      () => $('#out')?.textContent !== 'waiting',
      {
        netFetchHandler: async (url, options) => {
          asked.push([url, options]);
          return { ok: true, status: 200, statusText: 'OK', body: '[1,2,3]', headers: { 'content-type': 'application/json' } };
        },
        onTitleChange: (title: string) => titles.push(title),
        onLink: (href: string) => {
          links.push(href);
          return true;
        },
      }
    );
    expect($('#out')!.textContent).toBe('200 3 application/json');
    expect(asked[0][0]).toBe('https://api.example.test/books');
    expect(asked[0][1]).toMatchObject({ method: 'POST', headers: { 'x-mode': 'test' }, body: '{"n":1}' });
    expect(titles).toEqual(['Books (3)']);
    await act(async () => {
      $('#go')!.click();
    });
    await settle();
    expect(links).toEqual(['about.html']);
  });

  it('sees what SoftN drew inside an element, as an event\u2019s target and its ancestors', async () => {
    await mount(
      `<ul id="list">
  #each (book in books) key={book.id}
    <li data-id={book.id} class="book"><b>{book.title}</b></li>
  #end
</ul>
<p id="picked">none</p>
<script>
  let books = [{ id: 'a1', title: 'Dune' }, { id: 'b2', title: 'Emma' }];
  document.getElementById('list').addEventListener('click', (e) => {
    const item = e.target.closest('li.book');
    document.getElementById('picked').textContent = e.target.tagName + ' ' + item.dataset.id + ' ' + item.textContent;
  });
</script>`,
      () => container.querySelectorAll('#list li').length === 2
    );
    await act(async () => {
      container.querySelectorAll<HTMLElement>('#list li b')[1].click();
    });
    await settle();
    expect($('#picked')!.textContent).toBe('B b2 Emma');
  });

  it('shows alert() in the app, as the app’s, and says what to use for confirm()', async () => {
    // Never the browser's own dialog, which says it is the host speaking and
    // holds the whole tab until it is answered.
    const native = vi.spyOn(window, 'alert').mockImplementation(() => {});
    try {
      await mount(
        `<button id="b">Save</button><p id="out">-</p>
<script>
  document.getElementById('b').addEventListener('click', () => {
    alert('Saved ' + 2 + ' notes');
    try { confirm('Sure?'); } catch (error) { document.getElementById('out').textContent = error.message; }
  });
</script>`,
        () => $('#b') !== null && $('#b')!.hasAttribute('data-softn-node')
      );
      await act(async () => {
        $('#b')!.click();
      });
      await settle();
      const notice = $('[data-softn-notice="alert"]');
      expect(notice?.getAttribute('role')).toBe('alertdialog');
      expect(notice?.textContent).toContain('Saved 2 notes');
      expect(native).not.toHaveBeenCalled();
      expect($('#out')!.textContent).toMatch(/^confirm\(\) cannot wait for an answer here/);
      await act(async () => {
        (notice!.querySelector('button') as HTMLButtonElement).click();
      });
      expect($('[data-softn-notice="alert"]')).toBeNull();
    } finally {
      native.mockRestore();
    }
  });

  it('shows no alert() while the permission bar is asking', async () => {
    await mount(
      `<p id="out">-</p>
<script>
  alert('Type your password to continue');
  document.getElementById('out').textContent = 'ran';
</script>`,
      () => $('#out')?.textContent === 'ran',
      { permissionConfig: { consentPending: true, permissions: { net: { enabled: true } } } as never }
    );
    await settle();
    expect($('#out')!.textContent).toBe('ran');
    expect($('[data-softn-notice="alert"]')).toBeNull();
  });

  it('compiles beside a page that declares the window\u2019s names itself, however it declares them', async () => {
    await mount(
      `<p id="out">-</p>
<script>
  const { location = 'home' } = {};
  let a = 1, Text = 'mine';
  class Comment { constructor() { this.kind = 'comment'; } }
  function alert(message) { return 'own ' + message; }
  document.getElementById('out').textContent = [location, Text, new Comment().kind, alert('alert'), typeof fetch].join(' ');
</script>`,
      () => $('#out')?.textContent !== '-'
    );
    expect($('#out')!.textContent).toBe('home mine comment own alert function');
  });

  it('lets the code cancel a link before SoftN follows it', async () => {
    const links: string[] = [];
    await mount(
      `<a id="go" href="about.html">About</a><p id="out">-</p>
<script>
  document.getElementById('go').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('out').textContent = 'stayed';
  });
</script>`,
      () => $('#go')?.hasAttribute('data-softn-node') === true,
      { onLink: (href: string) => (links.push(href), true) }
    );
    await act(async () => {
      $('#go')!.click();
    });
    await settle();
    expect($('#out')!.textContent).toBe('stayed');
    expect(links).toEqual([]);
  });

  it('adds to a class SoftN draws from a value', async () => {
    await mount(
      `<p id="item" class={cls}>item</p><button id="flash">Flash</button>
<script>
  let cls = 'done';
  document.getElementById('flash').addEventListener('click', () => {
    document.getElementById('item').classList.add('flash');
  });
</script>`,
      () => $('#item')?.className === 'done'
    );
    await act(async () => {
      $('#flash')!.click();
    });
    await settle();
    expect($('#item')!.className).toBe('done flash');
  });

  it('draws a page whose code uses the document from it from the first draw, so nothing is drawn twice', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    let removed = 0;
    const watch = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) if (node instanceof Element && (node.id === 'field' || node.querySelector?.('#field'))) removed++;
      }
    });
    watch.observe(container, { childList: true, subtree: true });
    await act(async () => {
      root = createRoot(container);
      root.render(
        <SoftNRenderer
          source={'<input id="field"><p id="out">-</p><script>document.getElementById("out").textContent = "ready";</script>'}
          appId="document-shell-first-draw"
          scriptExecutionMode="main"
        />
      );
    });
    for (let i = 0; i < 100 && $('#out')?.textContent !== 'ready'; i++) {
      await act(async () => {
        await sleep(20);
      });
    }
    watch.disconnect();
    expect($('#out')!.textContent).toBe('ready');
    expect(removed).toBe(0);
  });

  it('leaves a page whose code does not use the document as it was', async () => {
    await mount(`<p id="shown">{n}</p><script>let n = 3</script>`, () => $('#shown')?.textContent === '3');
    expect($('#shown')!.hasAttribute('data-softn-node')).toBe(false);
  });

  it('moves between its own states by hash and history, and hears hashchange and popstate', async () => {
    await mount(
      `<button id="go">Go</button><button id="push">Push</button><button id="back">Back</button><p id="out">-</p>
<script>
  const out = document.getElementById('out');
  const seen = [];
  window.addEventListener('hashchange', () => { seen.push('hash ' + location.hash); out.textContent = seen.join(', '); });
  window.addEventListener('popstate', (e) => { seen.push('pop ' + (e.state ? e.state.n : 'none')); out.textContent = seen.join(', '); });
  document.getElementById('go').addEventListener('click', () => { location.hash = '#two'; });
  document.getElementById('push').addEventListener('click', () => { history.pushState({ n: 3 }, '', '?view=3'); out.textContent = location.search + ' ' + history.state.n; });
  document.getElementById('back').addEventListener('click', () => { history.back(); });
</script>`,
      () => $('#go')?.hasAttribute('data-softn-node') === true
    );
    await act(async () => $('#go')!.click());
    await settle();
    expect($('#out')!.textContent).toBe('hash #two');
    await act(async () => $('#push')!.click());
    await settle();
    expect($('#out')!.textContent).toBe('?view=3 3');
    await act(async () => $('#back')!.click());
    await settle();
    expect($('#out')!.textContent).toBe('hash #two, pop none');
  });

  it('knows a <details> the person opened, and every option of a <select multiple> they chose', async () => {
    await mount(
      `<details id="d"><summary>More</summary>Hidden</details>
<form id="f"><select id="s" name="tags" multiple><option value="x">X</option><option value="y">Y</option><option value="z">Z</option></select></form>
<button id="read">Read</button><p id="out">-</p>
<script>
  document.getElementById('read').addEventListener('click', () => {
    const tags = new FormData(document.getElementById('f')).getAll('tags');
    document.getElementById('out').textContent = document.getElementById('d').open + ' ' + tags.join(',');
  });
</script>`,
      () => $('#read')?.hasAttribute('data-softn-node') === true
    );
    await act(async () => {
      const details = $('#d') as HTMLDetailsElement;
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
      const select = $('#s') as HTMLSelectElement;
      select.options[0].selected = true;
      select.options[2].selected = true;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => $('#read')!.click());
    await settle();
    expect($('#out')!.textContent).toBe('true x,z');
  });

  it('copies a <template>’s content, and never draws the template', async () => {
    await mount(
      `<template id="row"><li class="r"><b></b> <span>left</span></li></template><ul id="list"></ul>
<script>
  const row = document.getElementById('row');
  for (const name of ['tea', 'bun']) {
    const copy = row.content.cloneNode(true);
    copy.querySelector('b').textContent = name;
    document.getElementById('list').appendChild(copy);
  }
</script>`,
      () => container.querySelectorAll('li.r').length === 2
    );
    expect([...container.querySelectorAll('li.r b')].map((b) => b.textContent)).toEqual(['tea', 'bun']);
    expect(container.textContent).not.toContain('Unknown component');
    expect(container.querySelector('template')).toBeNull();
  });

  it('opens a <dialog> over the app, and closes it with its form’s button and Escape', async () => {
    await mount(
      `<button id="open">Open</button>
<dialog id="d"><form method="dialog"><button id="yes" value="yes">Yes</button></form></dialog>
<p id="out">-</p>
<script>
  const d = document.getElementById('d');
  document.getElementById('open').addEventListener('click', () => d.showModal());
  d.addEventListener('close', () => { document.getElementById('out').textContent = 'closed ' + d.returnValue; });
</script>`,
      () => $('#open')?.hasAttribute('data-softn-node') === true
    );
    await act(async () => $('#open')!.click());
    await settle();
    const dialog = $('#d') as HTMLDialogElement;
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(dialog.style.position).toBe('fixed');
    await act(async () => $('#yes')!.click());
    await settle();
    expect($('#out')!.textContent).toBe('closed yes');
    expect(dialog.hasAttribute('open')).toBe(false);
    await act(async () => $('#open')!.click());
    await settle();
    await act(async () => {
      $('#yes')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await settle();
    expect(dialog.hasAttribute('open')).toBe(false);
  });

  it('runs a handler written for a browser, with this and event, on a page with no code of its own', async () => {
    await mount(
      `<button id="b" onclick="this.classList.toggle('on'); document.getElementById('out').textContent = event.type + ' ' + this.id">Toggle</button><p id="out">-</p>`,
      () => $('#b')?.hasAttribute('data-softn-node') === true
    );
    await act(async () => $('#b')!.click());
    await settle();
    expect($('#b')!.classList.contains('on')).toBe(true);
    expect($('#out')!.textContent).toBe('click b');
    // The text never reaches the page as an attribute.
    expect($('#b')!.hasAttribute('onclick')).toBe(false);
  });

  it('draws what the code puts on its html and body on the app’s root', async () => {
    await mount(
      `<p id="out">x</p>
<script>
  document.body.classList.add('dark');
  document.body.dataset.mode = 'night';
  document.documentElement.style.setProperty('--accent', 'red');
  document.body.style.backgroundImage = 'url(https://evil.example/b.png)';
  document.getElementById('out').textContent = 'set';
</script>`,
      () => $('#out')?.textContent === 'set',
      { permissionConfig: { permissions: {} } as never }
    );
    await settle();
    const root = container.querySelector('[data-softn-page]') as HTMLElement;
    expect(root.classList.contains('dark')).toBe(true);
    expect(root.getAttribute('data-mode')).toBe('night');
    expect(root.style.getPropertyValue('--accent')).toBe('red');
    // Checked as any element's style: a remote image the app may not load is not drawn.
    expect(root.style.backgroundImage).toBe('');
  });

  it('keeps the page when its script stops, as a browser does, and says so', async () => {
    await mount(
      `<h1 id="title">Still here</h1><p id="out">-</p>
<script>
  document.getElementById('out').textContent = 'started';
  new SomethingNoBrowserHas();
</script>`,
      () => container.querySelector('[data-softn-notice]') !== null
    );
    expect($('#title')!.textContent).toBe('Still here');
    expect(container.querySelector('[data-softn-notice]')!.textContent).toMatch(/This page's script stopped: .*SomethingNoBrowserHas/);
  });

  it('fetches its own files from where its markup finds them, with no network', async () => {
    const real = globalThis.fetch;
    const asked: string[] = [];
    globalThis.fetch = (async (url: string) => {
      asked.push(String(url));
      return new Response(JSON.stringify([{ name: 'tea' }, { name: 'bun' }]), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      await mount(
        `<ul id="list"></ul><p id="out">-</p>
<script>
  fetch('data/items.json').then((r) => r.json()).then((items) => {
    for (const item of items) { const li = document.createElement('li'); li.textContent = item.name; document.getElementById('list').appendChild(li); }
  });
  fetch('../secret.json').then((r) => { document.getElementById('out').textContent = String(r.status); });
</script>`,
        () => container.querySelectorAll('li').length === 2 && $('#out')?.textContent !== '-',
        { assetResolver: ((path: string) => (path.includes('..') ? '' : `site/${path}`)) as never, permissionConfig: { permissions: {} } as never }
      );
      expect([...container.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['tea', 'bun']);
      expect($('#out')!.textContent).toBe('404');
      expect(asked).toEqual(['site/data/items.json']);
    } finally {
      globalThis.fetch = real;
    }
  });

  // Two thousand rows, each appended on its own, came to more than the
  // engine could hand the host in one read: the page's script stopped, the
  // list was never drawn, and the click listener added after it was lost.
  it('draws a long list the code fills a row at a time, and goes on hearing its clicks', async () => {
    await mount(
      `<ul id="list"></ul><button id="more">More</button><p id="out">-</p>
<script>
  const list = document.getElementById('list');
  for (let i = 0; i < 2500; i++) { const li = document.createElement('li'); li.textContent = 'row ' + i; list.appendChild(li); }
  document.getElementById('more').addEventListener('click', () => {
    list.appendChild(document.createElement('li'));
    document.getElementById('out').textContent = 'rows ' + list.children.length;
  });
</script>`,
      () => container.querySelectorAll('#list li').length === 2500 && $('#more')?.hasAttribute('data-softn-node') === true
    );
    expect(container.querySelectorAll('#list li')).toHaveLength(2500);
    expect(container.querySelector('#list li:last-child')!.textContent).toBe('row 2499');
    await act(async () => $('#more')!.click());
    await settle();
    expect($('#out')!.textContent).toBe('rows 2501');
    expect(container.querySelectorAll('#list li')).toHaveLength(2501);
  }, 30000);

  // A live list the page keeps in its state is read out with the rest of
  // the state, and must not come back as a copy, which would no longer
  // follow the page.
  it('keeps a live list the page holds in its state live across turns', async () => {
    await mount(
      `<ul id="list"><li>a</li></ul><button id="add">Add</button><p id="out">{label}</p>
<script>
  let label = 'start';
  const kids = document.getElementById('list').children;
  document.getElementById('add').addEventListener('click', () => {
    document.getElementById('list').appendChild(document.createElement('li'));
    label = 'kids ' + kids.length;
  });
</script>`,
      () => $('#add')?.hasAttribute('data-softn-node') === true && $('#out')?.textContent === 'start'
    );
    await act(async () => $('#add')!.click());
    await settle();
    await act(async () => $('#add')!.click());
    await settle();
    expect($('#out')!.textContent).toBe('kids 3');
  });

  // A box the person clicked was seen by a click listener as it was before
  // the click; HTML ticks it first, and unticks it if the click is cancelled.
  it('lets a click listener read the box the person just clicked', async () => {
    await mount(
      `<input type="checkbox" id="box"><input type="checkbox" id="locked"><p id="out">-</p>
<script>
  document.getElementById('box').addEventListener('click', (e) => { document.getElementById('out').textContent = 'box ' + e.target.checked; });
  document.getElementById('locked').addEventListener('click', (e) => { e.preventDefault(); });
</script>`,
      () => $('#box')?.hasAttribute('data-softn-node') === true
    );
    await act(async () => $('#box')!.click());
    await settle();
    expect($('#out')!.textContent).toBe('box true');
    expect($<HTMLInputElement>('#box')!.checked).toBe(true);
    await act(async () => $('#locked')!.click());
    await settle();
    expect($<HTMLInputElement>('#locked')!.checked).toBe(false);
  });

  // A drawing the code made had its viewBox written as viewbox, which SVG
  // does not read.
  it('draws an <svg> the code makes with its names in their case', async () => {
    await mount(
      `<div id="box"></div>
<script>
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 10 10');
  svg.innerHTML = '<defs><linearGradient id="g"></linearGradient></defs><rect width="10" height="10"/>';
  document.getElementById('box').appendChild(svg);
</script>`,
      () => container.querySelector('#box svg rect') !== null
    );
    const svg = container.querySelector('#box svg')!;
    expect(svg.getAttribute('viewBox')).toBe('0 0 10 10');
    expect(svg.querySelector('rect')!.parentElement).toBe(svg);
    expect(svg.querySelector('linearGradient')).not.toBeNull();
  });

  it('checks a form before it is sent, as a browser does', async () => {
    await mount(
      `<form id="f"><input id="email" name="email" type="email" required><button id="send">Send</button></form><p id="out">-</p>
<script>
  const form = document.getElementById('f');
  let sent = 0;
  form.addEventListener('submit', (e) => { e.preventDefault(); sent++; document.getElementById('out').textContent = 'sent ' + sent; });
  form.addEventListener('invalid', (e) => { document.getElementById('out').textContent = e.target.validationMessage; }, true);
  document.getElementById('send').addEventListener('click', (e) => { e.preventDefault(); form.requestSubmit(); });
</script>`,
      () => $('#send')?.hasAttribute('data-softn-node') === true
    );
    await act(async () => $('#send')!.click());
    await settle();
    expect($('#out')!.textContent).toBe('Please fill in this field.');
    await type($('#email') as HTMLInputElement, 'a@b.co');
    await act(async () => $('#send')!.click());
    await settle();
    expect($('#out')!.textContent).toBe('sent 1');
  });
});
