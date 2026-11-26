/**
 * Round 4: the hosted React 18 runtime an uncompiled .jsx/.tsx app runs on
 * (src/guest-react-vendor.ts), as React itself behaves.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountSoftNContainer } from '../src/index';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LITE_WASM = path.join(PKG_ROOT, 'dist', 'runtime', 'engines', 'zipp-javascript-lite.wasm');

async function open(main: string) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const said: string[] = [];
  const handle = await mountSoftNContainer(host, {
    isolation: 'inline',
    engineWasm: { lite: LITE_WASM },
    permissionMode: 'deny',
    onConsole: (level, text) => said.push(`${level}: ${text}`),
    onError: (error) => said.push(`failed: ${error.message}`),
    source: {
      'index.html': `<!doctype html><html><body><div id="root"></div><p id="seen"></p><script type="module" src="/main.jsx"></script></body></html>`,
      'main.jsx': main,
    },
  });
  const q = <T extends Element = HTMLElement>(selector: string) => handle.shadowRoot.querySelector<T>(selector);
  const text = (selector: string) => q(selector)?.textContent ?? '(not on the page)';
  const shows = (selector: string, expected: string) => expect.poll(() => text(selector), { timeout: 5_000, interval: 10 }).toBe(expected);
  const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));
  return { handle, said, q, text, shows, settle };
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('a field’s onChange', () => {
  it('is called once for each change, for a box and for text (it was called on input and on change both)', async () => {
    const { handle, said, q, shows, settle } = await open(`
      import { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      var calls = 0;
      function App() {
        const [on, setOn] = useState(false);
        const [value, setValue] = useState('');
        return (<div>
          <input id="box" type="checkbox" checked={on} onChange={() => setOn((v) => !v)} />
          <b id="on">{String(on)}</b>
          <input id="field" value={value} onChange={(e) => { calls++; setValue(e.target.value); }} />
          <b id="value">{value + ':' + calls}</b>
        </div>);
      }
      createRoot(document.getElementById('root')).render(<App />);
    `);
    await shows('#on', 'false');
    // A click on a box says input and then change, as a browser says them.
    q<HTMLInputElement>('#box')!.click();
    await shows('#on', 'true');
    await settle();
    expect(q('#on')!.textContent).toBe('true');
    q<HTMLInputElement>('#box')!.click();
    await shows('#on', 'false');
    const field = q<HTMLInputElement>('#field')!;
    field.value = 'a';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await shows('#value', 'a:1');
    // Left: the field says change, and nothing has changed since its input.
    field.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(q('#value')!.textContent).toBe('a:1');
    expect(said.filter((line) => line.startsWith('failed') || line.startsWith('error'))).toEqual([]);
    handle.dispose();
  });
});

describe('what a place in the tree renders', () => {
  it('changes from one kind of node to another (it threw, and the rest of the render was left undone)', async () => {
    const { handle, q, shows, said } = await open(`
      import { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      function A() { return <em>A</em>; }
      function App() {
        const [s, setS] = useState(0);
        const odd = s % 2 === 1;
        return <div>
          <button id="next" onClick={() => setS((v) => v + 1)}>next</button>
          <p id="host">{odd ? <span>span</span> : <b>b</b>}</p>
          <p id="comp">{odd ? <A /> : <i>i</i>}</p>
          <p id="text">{odd ? 'text' : <u>u</u>}</p>
          <p id="frag">{odd ? <>f1<s>f2</s></> : null}</p>
          <p id="count">{s}</p>
        </div>;
      }
      createRoot(document.getElementById('root')).render(<App />);
    `);
    const shown = () => ['#host', '#comp', '#text', '#frag', '#count'].map((s) => q(s)?.textContent).join('|');
    await expect.poll(shown, { timeout: 5_000 }).toBe('b|i|u||0');
    q('#next')!.click();
    await expect.poll(shown, { timeout: 5_000 }).toBe('span|A|text|f1f2|1');
    q('#next')!.click();
    await expect.poll(shown, { timeout: 5_000 }).toBe('b|i|u||2');
    expect(q('#host')!.children.length + q('#comp')!.children.length + q('#text')!.children.length).toBe(3);
    await shows('#count', '2');
    expect(said.filter((line) => line.startsWith('failed') || line.startsWith('error'))).toEqual([]);
    handle.dispose();
  });

  it('says a component’s render that throws, and still renders the others updated with it', async () => {
    const { handle, q, shows, said } = await open(`
      import { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      var setFaulty = null;
      var setCounter = null;
      function Faulty() { const [n, setN] = useState(0); setFaulty = setN; if (n > 0) throw new Error('faulty render'); return <i id="faulty">ok</i>; }
      function Counter() { const [n, setN] = useState(0); setCounter = setN; return <b id="counter">{n}</b>; }
      // The faulty one is asked to render first, the counter after it, in one batch.
      createRoot(document.getElementById('root')).render(<div><Faulty /><Counter /><button id="go" onClick={() => { setFaulty((v) => v + 1); setCounter((v) => v + 1); }}>go</button></div>);
    `);
    await shows('#counter', '0');
    q('#go')!.click();
    await shows('#counter', '1');
    await expect.poll(() => said.some((line) => line.startsWith('error') && line.includes('faulty render')), { timeout: 5_000 }).toBe(true);
    handle.dispose();
  });
});

describe('a component’s defaultProps', () => {
  it('fill in the props it is not given, as React 18 fills them in', async () => {
    const { handle, shows } = await open(`
      import { memo, Component } from 'react';
      import { createRoot } from 'react-dom/client';
      function Label({ size, tone, children }) { return <span id="label">{size + '/' + tone + ':' + children}</span>; }
      Label.defaultProps = { size: 'md', tone: 'plain' };
      class Badge extends Component { render() { return <span id="badge">{this.props.kind}</span>; } }
      Badge.defaultProps = { kind: 'new' };
      function Inner({ n }) { return <span id="memo">{n}</span>; }
      Inner.defaultProps = { n: 7 };
      const Memo = memo(Inner);
      createRoot(document.getElementById('root')).render(<div><Label tone={undefined} size="lg">x</Label><Badge /><Memo /></div>);
    `);
    await shows('#label', 'lg/plain:x');
    await shows('#badge', 'new');
    await shows('#memo', '7');
    handle.dispose();
  });
});

describe('an effect’s cleanup', () => {
  it('runs for an effect replaced twice before effects ran (rendered again from its own render)', async () => {
    const { handle, q, shows } = await open(`
      import { useState, useEffect } from 'react';
      import { createRoot } from 'react-dom/client';
      var active = 0;
      function Ticker({ n }) {
        const [m, setM] = useState(0);
        // State derived from a prop, set while rendering, as React's documentation does it.
        if (m !== n) setM(n);
        useEffect(() => { active++; return () => { active--; }; }, [n, m]);
        return <i id="m">{m}</i>;
      }
      function App() {
        const [n, setN] = useState(0);
        return <div><button id="bump" onClick={() => setN((v) => v + 1)}>bump</button><Ticker n={n} /></div>;
      }
      createRoot(document.getElementById('root')).render(<App />);
      setInterval(function () { document.getElementById('seen').textContent = 'active ' + active; }, 20);
    `);
    await shows('#seen', 'active 1');
    q('#bump')!.click();
    await shows('#m', '1');
    q('#bump')!.click();
    await shows('#m', '2');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(q('#seen')!.textContent).toBe('active 1');
    handle.dispose();
  });

  it('runs for an effect replaced just before its component is unmounted', async () => {
    const { handle, q, shows } = await open(`
      import { useState, useEffect } from 'react';
      import { createRoot } from 'react-dom/client';
      var active = 0;
      function Child({ hide }) {
        const [v, setV] = useState(0);
        useEffect(() => { active++; return () => { active--; }; }, [v]);
        return <button id="go" onClick={() => { setV((x) => x + 1); hide(); }}>go</button>;
      }
      function App() {
        const [shown, setShown] = useState(true);
        return <div>{shown ? <Child hide={() => setShown(false)} /> : <b id="gone">gone</b>}</div>;
      }
      createRoot(document.getElementById('root')).render(<App />);
      setInterval(function () { document.getElementById('seen').textContent = 'active ' + active; }, 20);
    `);
    await shows('#seen', 'active 1');
    q('#go')!.click();
    await shows('#gone', 'gone');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(q('#seen')!.textContent).toBe('active 0');
    handle.dispose();
  });
});
