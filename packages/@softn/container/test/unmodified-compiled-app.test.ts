import { describe, it, expect, beforeEach } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceModuleHeader, GENERATED_SOURCE_HEADER } from '@softn/bundle-format/source-modules';
import { ContainerArchive, mountSoftNContainer } from '../src/index';

it.each(['file map', 'ZIP'])('checks component freshness before mounting a %s, including older exports', async format => {
  const path = 'src/Card.jsx';
  const files = { 'index.html': '<main></main>', [path]: 'export default () => <p>First</p>;' };
  const module = '__softn_generated__/' + path + '.js';
  const open = (code: string) => {
    const entries = { ...files, [module]: code };
    if (format === 'file map') return ContainerArchive.open(entries);
    const bytes = Object.fromEntries(Object.entries(entries).map(([key, text]) => [key, strToU8(text)]));
    return ContainerArchive.open(zipSync(bytes));
  };
  const prepared = await sourceModuleHeader(path, files[path]) + 'export default function Card() {}';
  (await open(prepared)).dispose();
  files[path] = files[path].replace('First', 'Second');
  await expect(open(prepared)).rejects.toThrow(path + ' has changed');
  (await open(GENERATED_SOURCE_HEADER + 'export default function Card() {}')).dispose();
});

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LITE_WASM = path.join(PKG_ROOT, 'dist', 'runtime', 'engines', 'zipp-javascript-lite.wasm');

function flushAsync(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Unmodified & Pre-Compiled Web Apps in .softn Containers ("Docker for Web Apps")', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('runs a zipped Vite-style dist/ folder with NO manifest.json, minified ESM chunks, and intra-bundle fetch()', async () => {
    // Simulate a real `zip -r app.softn dist/` output where every entry lives under `dist/`
    // and there is NO manifest.json or permission.json at all!
    const distZip = zipSync({
      'dist/index.html': strToU8(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Compiled Kanban Dist</title>
  <link rel="stylesheet" href="/assets/index-C91a.css">
  <script type="module" src="/assets/index-B7f2.js"></script>
</head>
<body>
  <div id="app">Loading...</div>
</body>
</html>`),
      'dist/assets/index-C91a.css': strToU8(`
        body { background: #111827; color: #f9fafb; }
        .board { display: flex; gap: 12px; }
      `),
      'dist/assets/vendor-A10e.js': strToU8(
        `const fmt=(n)=>\`\${n} item\${n===1?"":"s"}\`;export{fmt as f};`
      ),
      'dist/data/seed.json': strToU8(
        JSON.stringify([
          { id: 1, title: 'Ship container kernel' },
          { id: 2, title: 'Verify zero-rewrite dist zip' },
        ])
      ),
      'dist/assets/index-B7f2.js': strToU8(`
        import{f as formatCount}from"./vendor-A10e.js";
        async function boot(){
          const res = await fetch(new URL("../data/seed.json", import.meta.url));
          const items = await res.json();
          const root = document.getElementById("app");
          root.innerHTML = '<h1 id="hdr"></h1><ul id="list"></ul><button id="add-btn" type="button">Add</button>';
          const render = () => {
            document.getElementById("hdr").textContent = "Kanban (" + formatCount(items.length) + ")";
            const ul = document.getElementById("list");
            ul.innerHTML = "";
            for (const it of items) {
              const li = document.createElement("li");
              li.textContent = it.title;
              ul.appendChild(li);
            }
          };
          render();
          document.getElementById("add-btn").addEventListener("click", () => {
            items.push({ id: items.length + 1, title: "Task #" + (items.length + 1) });
            render();
          });
        }
        boot();
      `),
    });

    const host = document.createElement('div');
    document.body.appendChild(host);

    const handle = await mountSoftNContainer(host, {
      source: distZip,
      isolation: 'inline',
      engineWasm: { lite: LITE_WASM },
    });

    await flushAsync(50);

    // 1. Auto-inferred manifest from <title>, stripped `dist/` prefix, selected `lite` tier
    expect(handle.manifest.inferred).toBe(true);
    expect(handle.manifest.name).toBe('Compiled Kanban Dist');
    expect(handle.manifest.main).toBe('index.html');
    expect(handle.engineTier).toBe('lite');

    // 2. Rendered initial fetched seed items inside closed ShadowRoot
    const hdr = handle.shadowRoot.querySelector('#hdr');
    expect(hdr?.textContent).toBe('Kanban (2 items)');
    expect(handle.shadowRoot.querySelectorAll('#list li').length).toBe(2);

    // 3. Dispatch real click event on host DOM -> handled inside ZIPP -> patches real DOM
    const addBtn = handle.shadowRoot.querySelector('#add-btn') as HTMLButtonElement;
    addBtn.click();
    await flushAsync(20);

    expect(handle.shadowRoot.querySelector('#hdr')?.textContent).toBe('Kanban (3 items)');
    expect(handle.shadowRoot.querySelectorAll('#list li').length).toBe(3);

    handle.dispose();
  });

  it('supports code-split dynamic import("./chunk.js") on user interaction', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);

    const handle = await mountSoftNContainer(host, {
      isolation: 'inline',
      engineWasm: { lite: LITE_WASM },
      source: {
        'index.html': `<!DOCTYPE html>
          <html><body>
            <button id="load-calc">Open Calculator</button>
            <div id="result">idle</div>
            <script type="module" src="./main.js"></script>
          </body></html>`,
        'main.js': `
          document.getElementById('load-calc').addEventListener('click', async () => {
            const mod = await import('./lazy-calc.js');
            document.getElementById('result').textContent = 'Sum: ' + mod.compute(19, 23);
          });
        `,
        'lazy-calc.js': `
          export function compute(a, b) {
            return a + b;
          }
        `,
      },
    });

    await flushAsync(30);
    expect(handle.shadowRoot.querySelector('#result')?.textContent).toBe('idle');

    (handle.shadowRoot.querySelector('#load-calc') as HTMLButtonElement).click();
    await flushAsync(50);

    expect(handle.shadowRoot.querySelector('#result')?.textContent).toBe('Sum: 42');
    handle.dispose();
  });

  it('records and replays HTML5 <canvas> 2D context commands onto the host <canvas>', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);

    const calls: Array<[string, unknown[]]> = [];
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type: string) {
      if (type === '2d') {
        return new Proxy(
          {
            fillStyle: '#000',
            font: '10px sans-serif',
            clearRect: (...a: unknown[]) => calls.push(['clearRect', a]),
            fillRect: (...a: unknown[]) => calls.push(['fillRect', a]),
            beginPath: () => calls.push(['beginPath', []]),
            arc: (...a: unknown[]) => calls.push(['arc', a]),
            fill: () => calls.push(['fill', []]),
            fillText: (...a: unknown[]) => calls.push(['fillText', a]),
          },
          {}
        ) as unknown as RenderingContext;
      }
      return null;
    } as typeof HTMLCanvasElement.prototype.getContext;

    try {
      const handle = await mountSoftNContainer(host, {
        isolation: 'inline',
        engineWasm: { lite: LITE_WASM },
        source: {
          'index.html': `<!DOCTYPE html>
            <html><body>
              <canvas id="stage" width="320" height="200"></canvas>
              <script>
                const canvas = document.getElementById('stage');
                const ctx = canvas.getContext('2d');
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.fillStyle = '#3b82f6';
                ctx.fillRect(10, 20, 100, 50);
                ctx.fillText('Hello Canvas', 15, 40);
              </script>
            </body></html>`,
        },
      });

      await flushAsync(40);

      expect(calls).toContainEqual(['clearRect', [0, 0, 320, 200]]);
      expect(calls).toContainEqual(['fillRect', [10, 20, 100, 50]]);
      expect(calls).toContainEqual(['fillText', ['Hello Canvas', 15, 40]]);

      handle.dispose();
    } finally {
      HTMLCanvasElement.prototype.getContext = origGetContext;
    }
  });

  it('navigates between multiple HTML pages in one .softn container while preserving scoped localStorage', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);

    const handle = await mountSoftNContainer(host, {
      appId: 'multipage-test',
      isolation: 'inline',
      engineWasm: { lite: LITE_WASM },
      source: {
        'index.html': `<!DOCTYPE html>
          <html><body>
            <a id="nav-link" href="profile.html">Profile</a>
            <script>
              localStorage.setItem('username', 'Ada Lovelace');
            </script>
          </body></html>`,
        'profile.html': `<!DOCTYPE html>
          <html><body>
            <p id="who"></p>
            <script>
              document.getElementById('who').textContent = localStorage.getItem('username') || 'guest';
            </script>
          </body></html>`,
      },
    });

    await flushAsync(30);
    await handle.navigate('profile.html');
    await flushAsync(40);

    expect(handle.shadowRoot.querySelector('#who')?.textContent).toBe('Ada Lovelace');
    handle.dispose();
  });
});
