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

  it('shows alert(), and says what to use for confirm()', async () => {
    const shown: string[] = [];
    const alert = vi.spyOn(window, 'alert').mockImplementation((message?: unknown) => {
      shown.push(String(message));
    });
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
      expect(shown).toEqual(['Saved 2 notes']);
      expect($('#out')!.textContent).toMatch(/^confirm\(\) cannot wait for an answer here/);
    } finally {
      alert.mockRestore();
    }
  });

  it('leaves a page whose code does not use the document as it was', async () => {
    await mount(`<p id="shown">{n}</p><script>let n = 3</script>`, () => $('#shown')?.textContent === '3');
    expect($('#shown')!.hasAttribute('data-softn-node')).toBe(false);
  });
});
