/**
 * More of what a browser gives a page's code, in the document SoftN gives it
 * (document-shell/shell-source.ts): a form's checks and its fields by name,
 * FormData as a list, URL, base64, text as bytes, random numbers to rely on,
 * copies of values, changes watched, things stopped, and the window's size
 * and what the person prefers. Each was missing, and code written for a
 * browser stopped at the first one it used.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ZippWasmAdapter } from '../src/runtime/zipp-wasm-adapter';
import { SHELL_SYNC, SHELL_TAKE, usesDocument } from '../src/document-shell/names';
import { shellPrelude } from '../src/document-shell/shell-source';

type Op = [string, ...unknown[]];

const KEY = Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 255);

const SEED = {
  next: 40,
  r: KEY,
  v: [800, 600, 1, 0, 2, 0],
  body: [
    {
      i: 2,
      t: 'form',
      a: { id: 'f' },
      c: [
        { i: 3, t: 'input', a: { type: 'email', name: 'email', required: '' } },
        { i: 4, t: 'input', a: { name: 'code', pattern: '[A-Z]{3}-\\d{3}' } },
        { i: 5, t: 'input', a: { type: 'number', name: 'qty', min: '1', max: '5', step: '1' } },
        { i: 6, t: 'input', a: { name: 'note', value: 'hi', id: 'note' } },
        { i: 7, t: 'input', a: { type: 'checkbox', name: 'ok', checked: '' } },
        { i: 8, t: 'input', a: { type: 'radio', name: 'size', value: 's' } },
        { i: 9, t: 'input', a: { type: 'radio', name: 'size', value: 'l', checked: '' } },
        {
          i: 10,
          t: 'select',
          a: { name: 'tags', multiple: '' },
          c: [
            { i: 11, t: 'option', a: { value: 'x' }, c: [{ i: 12, x: 'X' }] },
            { i: 13, t: 'option', a: { value: 'y' }, c: [{ i: 14, x: 'Y' }] },
            { i: 15, t: 'option', a: { value: 'z' }, c: [{ i: 16, x: 'Z' }] },
          ],
        },
        { i: 17, t: 'output', a: { name: 'total' }, c: [{ i: 18, x: '0' }] },
      ],
    },
    { i: 20, t: 'ul', a: { id: 'list' }, c: [{ i: 21, t: 'li', a: { class: 'a b', 'data-user-id': '7' }, c: [{ i: 22, x: 'One' }] }] },
    { i: 23, t: 'a', a: { id: 'link', href: 'docs/page.html?x=1#top' }, c: [{ i: 24, x: 'Docs' }] },
    { i: 25, t: 'input', a: { id: 'when', type: 'date', value: '2026-10-20' } },
  ],
  url: 'https://example.com/app/index.html',
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
    sync: (changes: unknown[]) => run.callFunction(SHELL_SYNC, [changes]),
    call: (name: string, ...args: unknown[]) => run.callFunction(name, args),
  };
}

describe('a form, as a browser checks it', () => {
  it('works out each field’s validity, message and the form’s', async () => {
    const doc = await page(`
      function check() {
        const form = document.getElementById('f');
        const out = [];
        const email = form.elements.email;
        let invalid = 0;
        email.addEventListener('invalid', () => { invalid++; });
        out.push(email.checkValidity(), invalid, email.validity.valueMissing, email.validationMessage, email.willValidate);
        email.value = 'not an address';
        out.push(email.validity.typeMismatch);
        email.value = 'a@b.co';
        out.push(email.validity.valid);
        const code = form.code;
        code.value = 'ABC-12';
        out.push(code.validity.patternMismatch);
        code.value = 'ABC-123';
        out.push(code.validity.patternMismatch);
        form.qty.value = '9';
        out.push(form.qty.validity.rangeOverflow);
        form.qty.value = '2.5';
        out.push(form.qty.validity.stepMismatch);
        form.qty.value = '3';
        code.setCustomValidity('That code is taken');
        out.push(code.validity.customError, code.validationMessage, form.checkValidity());
        code.setCustomValidity('');
        out.push(form.checkValidity());
        return out;
      }
    `);
    expect(doc.call('check')).toEqual([
      false, 1, true, 'Please fill in this field.', true,
      true,
      true,
      true,
      false,
      true,
      true,
      true, 'That code is taken', false,
      true,
    ]);
  });

  it('keeps a submit from going until the form is valid, unless it says not to check', async () => {
    const doc = await page(`
      let sent = 0;
      function submit() {
        const form = document.getElementById('f');
        form.addEventListener('submit', (e) => { e.preventDefault(); sent++; });
        form.requestSubmit();
        const before = sent;
        form.elements.email.value = 'a@b.co';
        form.requestSubmit();
        const after = sent;
        form.elements.email.value = '';
        form.noValidate = true;
        form.requestSubmit();
        return [before, after, sent];
      }
    `);
    expect(doc.call('submit')).toEqual([0, 1, 2]);
  });

  it('answers to its fields’ names, and gives FormData as a list', async () => {
    const doc = await page(`
      function read() {
        const form = document.getElementById('f');
        const data = new FormData(form);
        return [
          form.note.value, form.elements.namedItem('note') === form.note, form.size.value, form.elements.size.length,
          Object.fromEntries(new FormData(form)).note, [...data].length > 0, data.getAll('tags').join(','),
          form.total.value,
        ];
      }
    `);
    expect(doc.call('read')).toEqual(['hi', true, 'l', 2, 'hi', true, '', '0']);
    // The person chose two options of the select with multiple.
    doc.sync([['S', 10, [0, 2]]]);
    expect(doc.call('read')).toEqual(['hi', true, 'l', 2, 'hi', true, 'x,z', '0']);
  });
});

describe('the rest of what a browser gives', () => {
  it('lists, class lists, data attributes and addresses as a browser has them', async () => {
    const doc = await page(`
      function read() {
        const li = document.querySelector('li');
        const link = document.getElementById('link');
        return [
          document.querySelectorAll('li').item(0) === li, [...li.classList].join('|'), Object.keys(li.dataset).join(','),
          link.href, link.pathname, link.search, link.hash, document.getElementById('when').valueAsDate.getTime(),
        ];
      }
    `);
    expect(doc.call('read')).toEqual([
      true, 'a|b', 'userId',
      'https://example.com/app/docs/page.html?x=1#top', '/app/docs/page.html', '?x=1', '#top', Date.UTC(2026, 9, 20),
    ]);
  });

  it('URL, base64, text as bytes, and copies of values', async () => {
    const doc = await page(`
      function run() {
        const u = new URL('../b/c?x=1#h', 'https://example.com/a/d/e');
        u.searchParams.append('y', '2 3');
        const cycle = { name: 'loop' };
        cycle.self = cycle;
        const copy = structuredClone({ when: new Date(0), map: new Map([['k', [1, 2]]]), set: new Set(['s']), cycle });
        let refused = '';
        try { structuredClone({ f() {} }) } catch (e) { refused = e.name }
        return [
          u.href, u.origin, new URL('HTTPS://Example.COM:443/./p/../q').href, URL.canParse('nope'),
          btoa('hi!'), atob('aGkh'), new TextDecoder().decode(new TextEncoder().encode('héllo € \u{1f600}')),
          copy.when instanceof Date, copy.map.get('k').join(','), copy.set.has('s'), copy.cycle.self === copy.cycle, refused,
        ];
      }
    `);
    expect(doc.call('run')).toEqual([
      'https://example.com/a/b/c?x=1&y=2+3#h', 'https://example.com', 'https://example.com/q', false,
      'aGkh', 'hi!', 'héllo € \u{1f600}',
      true, '1,2', true, true, 'DataCloneError',
    ]);
  });

  it('random numbers from the key the host gave, and none without one', async () => {
    const doc = await page(`
      function draw() {
        const bytes = crypto.getRandomValues(new Uint8Array(64));
        const words = crypto.getRandomValues(new Uint32Array(4));
        return [crypto.randomUUID(), Array.from(bytes).some((b) => b !== bytes[0]), words.length];
      }
    `);
    const [uuid, varied, words] = doc.call('draw') as [string, boolean, number];
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(varied).toBe(true);
    expect(words).toBe(4);
    engine?.dispose();
    const keyless = await page(`
      function draw() { try { crypto.randomUUID(); return 'drawn'; } catch (e) { return e.name; } }
    `, { ...SEED, r: undefined });
    expect(keyless.call('draw')).toBe('OperationError');
  });

  it('tells a MutationObserver what changed, and stops what an AbortController stops', async () => {
    const doc = await page(`
      const seen = [];
      let aborted = '';
      function change() {
        const list = document.getElementById('list');
        new MutationObserver((records) => {
          for (const r of records) seen.push(r.type + ':' + r.addedNodes.length + ':' + r.removedNodes.length + ':' + (r.attributeName || '') + ':' + (r.oldValue || ''));
        }).observe(list, { childList: true, subtree: true, attributeOldValue: true });
        const li = document.createElement('li');
        list.appendChild(li);
        li.setAttribute('class', 'new');
        list.firstElementChild.className = 'changed';
        list.firstElementChild.remove();
        const controller = new AbortController();
        controller.signal.addEventListener('abort', () => { aborted += 'heard;'; });
        controller.abort();
        aborted += controller.signal.aborted + ';' + controller.signal.reason.name;
        try { AbortSignal.abort().throwIfAborted(); } catch (e) { aborted += ';' + e.name; }
      }
      function report() { return [seen, aborted]; }
    `);
    doc.call('change');
    expect(doc.call('report')).toEqual([
      ['childList:1:0::', 'attributes:0:0:class:', 'attributes:0:0:class:a b', 'childList:0:1::'],
      'heard;true;AbortError;AbortError',
    ]);
  });

  it('the window’s size and the person’s preferences, as the host tells them', async () => {
    const doc = await page(`
      let changes = 0;
      let wide;
      function read() {
        wide = matchMedia('(min-width: 600px)');
        wide.addEventListener('change', () => { changes++; });
        return [
          innerWidth, innerHeight, window.innerWidth, devicePixelRatio, wide.matches,
          matchMedia('(prefers-color-scheme: dark)').matches, window.matchMedia('screen and (orientation: landscape)').matches,
          matchMedia('(prefers-reduced-motion: reduce)').matches, matchMedia('not print').matches,
        ];
      }
      function after() { return [innerWidth, wide.matches, changes, matchMedia('(prefers-reduced-motion: reduce)').matches]; }
    `);
    expect(doc.call('read')).toEqual([800, 600, 800, 2, true, true, true, false, true]);
    expect(doc.take()).toContainEqual(['l', 'softn:viewport']);
    doc.sync([['W', [500, 400, 0, 1, 1, 0]]]);
    expect(doc.call('after')).toEqual([500, false, 1, true]);
  });

  it('an element’s size, once the host has measured it', async () => {
    const doc = await page(`
      const told = [];
      function ask() {
        const li = document.querySelector('li');
        new ResizeObserver((entries) => { for (const e of entries) told.push(e.contentRect.width + 'x' + e.contentRect.height); }).observe(li);
        return li.offsetWidth;
      }
      function read() { const li = document.querySelector('li'); const r = li.getBoundingClientRect(); return [li.offsetWidth, r.top, r.height, told]; }
    `);
    expect(doc.call('ask')).toBe(0);
    expect(doc.take()).toContainEqual(['p', 21, 'measure', true]);
    doc.sync([['B', [[21, 10, 20, 300, 40]]]]);
    expect(doc.call('read')).toEqual([300, 20, 40, ['300x40']]);
  });
});

describe('pointers and dragging', () => {
  it('give a drag’s data from dragstart to drop, and a pointer’s details', async () => {
    const doc = await page(`
      const seen = [];
      function setUp() {
        const li = document.querySelector('li');
        li.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', li.dataset.userId); });
        document.getElementById('list').addEventListener('dragover', (e) => { e.preventDefault(); });
        document.getElementById('list').addEventListener('drop', (e) => { seen.push('dropped ' + e.dataTransfer.getData('text/plain') + ' ' + e.dataTransfer.types.join(',')); });
        li.addEventListener('pointerdown', (e) => { li.setPointerCapture(e.pointerId); seen.push(e.pointerType + ' ' + e.pointerId + ' ' + (e instanceof PointerEvent)); });
      }
      function report() { return seen; }
    `);
    doc.call('setUp');
    const event = (id: number, type: string, props: Record<string, unknown> = {}) => doc.call('__softnDocEvent', id, type, props, []) as number;
    event(21, 'pointerdown', { pointerId: 7, pointerType: 'pen' });
    event(21, 'dragstart');
    expect(event(20, 'dragover') & 1).toBe(1);
    event(20, 'drop');
    expect(doc.call('report')).toEqual(['pen 7 true', 'dropped 7 text/plain']);
  });
});

describe('a page that uses these', () => {
  it('is given the document', () => {
    for (const code of ['const id = crypto.randomUUID()', 'new URL(x)', 'btoa(s)', 'history.pushState({}, "", "/x")', 'new MutationObserver(f)', 'if (innerWidth < 600) small()', 'window.matchMedia("(max-width: 600px)")']) {
      expect(usesDocument(code), code).toBe(true);
    }
    expect(usesDocument('const url = "x"; user.history = []; item.crypto')).toBe(false);
  });
});
