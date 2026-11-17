import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountSoftNContainer } from '../src/index';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LITE_WASM = path.join(PKG_ROOT, 'dist', 'runtime', 'engines', 'zipp-javascript-lite.wasm');
const TS_WASM = path.join(PKG_ROOT, 'dist', 'runtime', 'engines', 'zipp-typescript.wasm');

function flushAsync(ms = 35): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Hosted /runtime/vendor/ Libraries, Zero-Build TypeScript, softn:db & <softn-*> Extensions', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('runs a zero-build Preact + Hooks + HTM app importing directly from SoftN hosted vendor modules', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);

    const handle = await mountSoftNContainer(host, {
      isolation: 'inline',
      engineWasm: { lite: LITE_WASM },
      source: {
        'index.html': `<!DOCTYPE html>
          <html><body>
            <div id="root"></div>
            <script type="module" src="./app.js"></script>
          </body></html>`,
        'app.js': `
          import { h, render } from 'preact';
          import { useState } from 'preact/hooks';
          import htm from 'htm';

          const html = htm.bind(h);

          function Counter() {
            const [count, setCount] = useState(5);
            return html\`
              <div class="counter-box">
                <span id="val">Count is \${count}</span>
                <button id="inc" onClick=\${() => setCount(c => c + 1)}>+1</button>
              </div>
            \`;
          }

          render(html\`<\${Counter} />\`, document.getElementById('root'));
        `,
      },
    });

    await flushAsync(40);
    expect(handle.shadowRoot.querySelector('#val')?.textContent).toBe('Count is 5');

    (handle.shadowRoot.querySelector('#inc') as HTMLButtonElement).click();
    await flushAsync(30);

    expect(handle.shadowRoot.querySelector('#val')?.textContent).toBe('Count is 6');
    handle.dispose();
  });

  it('runs zero-build TypeScript (<script type="module" src="./app.ts">) + synchronous Worker-local softn:db + hosted marked', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);

    const handle = await mountSoftNContainer(host, {
      isolation: 'inline',
      engineWasm: { typescript: TS_WASM },
      source: {
        'tasks.xdb': JSON.stringify({
          collection: 'tasks',
          records: [{ id: 't1', title: 'Write **TypeScript** directly', done: false }],
        }),
        'index.html': `<!DOCTYPE html>
          <html>
          <head><link rel="stylesheet" href="softn:ui.css"></head>
          <body class="container stack gap-md">
            <div id="notes"></div>
            <button id="add-ts" class="btn primary">Add Typed Task</button>
            <script type="module" src="./app.ts"></script>
          </body></html>`,
        'app.ts': `
          import { db } from 'softn:db';
          import { marked } from 'marked';

          interface TaskRecord {
            id: string;
            title: string;
            done: boolean;
          }

          function renderTasks(): void {
            const rows = db.query('tasks') as TaskRecord[];
            const box = document.getElementById('notes')!;
            box.innerHTML = rows.map((r: TaskRecord) => marked.parse('- ' + r.title)).join('');
          }

          renderTasks();

          document.getElementById('add-ts')!.addEventListener('click', (): void => {
            db.create('tasks', { title: 'Zero transpile step!', done: false });
            renderTasks();
          });
        `,
      },
    });

    await flushAsync(50);

    expect(handle.engineTier).toBe('typescript');
    expect(handle.shadowRoot.querySelector('#notes strong')?.textContent).toBe('TypeScript');
    expect(handle.shadowRoot.querySelectorAll('#notes li').length).toBe(1);

    (handle.shadowRoot.querySelector('#add-ts') as HTMLButtonElement).click();
    await flushAsync(30);

    expect(handle.shadowRoot.querySelectorAll('#notes li').length).toBe(2);
    handle.dispose();
  });

  it('auto-loads <softn-datagrid> and <softn-chart> Custom Elements when present in HTML', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);

    const handle = await mountSoftNContainer(host, {
      isolation: 'inline',
      engineWasm: { lite: LITE_WASM },
      source: {
        'index.html': `<!DOCTYPE html>
          <html><body>
            <softn-chart id="my-chart" type="bar" values="[10, 25, 40]"></softn-chart>
            <softn-datagrid id="my-grid" columns="name,score" rows='[{"name":"Alice","score":98},{"name":"Bob","score":87}]'></softn-datagrid>
          </body></html>`,
      },
    });

    await flushAsync(60);

    expect(customElements.get('softn-chart')).toBeDefined();
    expect(customElements.get('softn-datagrid')).toBeDefined();

    const gridEl = handle.shadowRoot.querySelector('#my-grid') as HTMLElement & { shadowRoot: ShadowRoot };
    expect(gridEl.shadowRoot.querySelectorAll('tbody tr').length).toBe(2);

    const chartEl = handle.shadowRoot.querySelector('#my-chart') as HTMLElement & { shadowRoot: ShadowRoot };
    expect(chartEl.shadowRoot.querySelectorAll('svg rect').length).toBe(3);

    handle.dispose();
  });

  it('supports Split-Realm hosted Three.js ("import * as THREE from \'three\'") and custom external vendor modules', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);

    const logs: string[] = [];
    const handle = await mountSoftNContainer(host, {
      isolation: 'inline',
      engineWasm: { lite: LITE_WASM },
      vendorModules: {
        confetti: `export function burst(n) { return 'confetti:' + n; }`,
      },
      onConsole: (_lvl, text) => logs.push(text),
      source: {
        'index.html': `<!DOCTYPE html>
          <html><body>
            <canvas id="gl" width="400" height="300"></canvas>
            <div id="status"></div>
            <script type="module">
              import * as THREE from 'three';
              import { burst } from 'confetti';

              const canvas = document.getElementById('gl');
              const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
              renderer.setSize(400, 300);

              const scene = new THREE.Scene();
              const camera = new THREE.PerspectiveCamera(60, 400 / 300, 0.1, 100);
              camera.position.set(0, 1.5, 4);

              const cube = new THREE.Mesh(
                new THREE.BoxGeometry(1, 1, 1),
                new THREE.MeshStandardMaterial({ color: 0x3b82f6 })
              );
              scene.add(cube);
              scene.add(new THREE.DirectionalLight(0xffffff, 1.2));
              renderer.render(scene, camera);

              document.getElementById('status').textContent = burst(3) + ' | children:' + scene.children.length;
            </script>
          </body></html>`,
      },
    });

    await flushAsync(50);

    expect(handle.shadowRoot.querySelector('#status')?.textContent).toBe('confetti:3 | children:2');
    handle.dispose();
  });

  it('renders non-blocking consent bar for declared permissions and detects legacy v1 .ui bundles', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);

    const handle = await mountSoftNContainer(host, {
      isolation: 'inline',
      permissionMode: 'prompt',
      engineWasm: { lite: LITE_WASM },
      source: {
        'permission.json': JSON.stringify({
          permissions: {
            net: { enabled: true, allowed_hosts: ['api.softn.test'] },
          },
        }),
        'index.html': `<!DOCTYPE html><html><body><p id="hello">App Ready</p></body></html>`,
      },
    });

    await flushAsync(25);
    // The bar has a place above the app's box, and is drawn in a shadow root of its own, out
    // of reach of the app's stylesheet (and of this test).
    expect(handle.frameRoot.querySelector('[data-softn-container-consent]')).not.toBeNull();
    expect(handle.frameRoot.querySelector('[data-softn-consent-bar]')).toBeNull();
    // And not in the root the app's page and its stylesheets are in: a stylesheet matches
    // only what is in its own root, so no rule of the app's reaches the bar's place, the
    // frame or the box, or anything a rule could draw on them.
    expect(handle.shadowRoot.querySelector('[data-softn-container-consent], [data-softn-frame], [data-softn-box]')).toBeNull();
    expect(handle.shadowRoot.querySelector('[data-softn-docroot]')).not.toBeNull();
    expect([...handle.frameRoot.querySelectorAll('style')].map((sheet) => sheet.textContent ?? '').join('')).not.toContain('softn-viewport');
    expect(handle.shadowRoot.querySelector('#hello')?.textContent).toBe('App Ready');
    handle.dispose();

    // Legacy v1 .ui bundle detection
    const legacyHost = document.createElement('div');
    document.body.appendChild(legacyHost);
    const legacyHandle = await mountSoftNContainer(legacyHost, {
      isolation: 'inline',
      source: {
        'manifest.json': JSON.stringify({ name: 'OldV1App', version: '1.0.0', main: 'ui/main.ui' }),
        'ui/main.ui': `<App><Text>Legacy</Text></App>`,
      },
    });
    expect(legacyHandle.manifest.mode).toBe('legacy-ui');
    expect(legacyHandle.shadowRoot.textContent).toContain('OldV1App');
    legacyHandle.dispose();
  });
});
