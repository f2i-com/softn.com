/**
 * A page written as HTML, with its code written for a browser: the code is
 * given the page as its document, and what it does to it is drawn, through
 * the renderer's checks, as if it had been written in the page.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
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

async function mount(source: string, ready: () => boolean) {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(<SoftNRenderer source={source} appId="document-shell-page" scriptExecutionMode="main" />);
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

  it('leaves a page whose code does not use the document as it was', async () => {
    await mount(`<p id="shown">{n}</p><script>let n = 3</script>`, () => $('#shown')?.textContent === '3');
    expect($('#shown')!.hasAttribute('data-softn-node')).toBe(false);
  });
});
