/**
 * Pages an app's backend renders (SSR, PHP), as a browser would show and follow them.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mountSoftNContainer, type BackendTransport, type SoftNContainerHandle } from '../src/index';

const PKG_ROOT = path.resolve(__dirname, '..');
const LITE_WASM = new Uint8Array(fs.readFileSync(path.join(PKG_ROOT, 'dist', 'runtime', 'engines', 'zipp-javascript-lite.wasm')));

type Seen = { method: string; path: string; query: string };

function backend(answer: (req: Seen) => { type: string; body: Uint8Array }) {
  const seen: Seen[] = [];
  const transport: BackendTransport = {
    kind: 'remote',
    ready: Promise.resolve(),
    fetch: async (req) => {
      const asked = { method: req.method, path: req.path, query: req.query ?? '' };
      seen.push(asked);
      const { type, body } = answer(asked);
      return { status: 200, statusText: 'OK', headers: [['Content-Type', type]], body };
    },
    dispose: () => undefined,
  };
  return { transport, seen };
}

const SSR_APP = {
  'manifest.json': JSON.stringify({ name: 'Shop', engine: 2, main: 'index.php', backend: { runtime: 'php', entry: 'index.php', mode: 'ssr' } }),
  'index.php': '<?php echo "rendered by the backend";',
};

let handle: SoftNContainerHandle | null = null;

async function mountSsr(transport: BackendTransport) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  handle = await mountSoftNContainer(host, {
    isolation: 'inline',
    persistStorage: false,
    permissionMode: 'deny',
    engineWasm: { lite: LITE_WASM },
    backendTransport: transport,
    source: SSR_APP,
  });
  return handle;
}

afterEach(() => {
  handle?.dispose();
  handle = null;
  document.body.innerHTML = '';
});

describe('pages the backend renders', () => {
  it('reads a page in the character set its Content-Type names, as a browser does', async () => {
    const latin1 = (text: string) => Uint8Array.from(text, (ch) => ch.charCodeAt(0));
    const { transport } = backend(() => ({
      type: 'text/html; charset=ISO-8859-1',
      body: latin1('<!doctype html><html><body><p id="t">Café crème £</p></body></html>'),
    }));
    const shown = await mountSsr(transport);
    expect(shown.shadowRoot.getElementById('t')?.textContent).toBe('Café crème £');
  });

  it('still reads a page with no character set named as UTF-8', async () => {
    const { transport } = backend(() => ({
      type: 'text/html',
      body: new TextEncoder().encode('<!doctype html><html><body><p id="t">Café ✓</p></body></html>'),
    }));
    const shown = await mountSsr(transport);
    expect(shown.shadowRoot.getElementById('t')?.textContent).toBe('Café ✓');
  });

  it('sends a GET form as a browser does: its fields are the query, in place of the one the action had', async () => {
    const { transport, seen } = backend((req) => ({
      type: 'text/html; charset=utf-8',
      body: new TextEncoder().encode(
        req.path === '/search'
          ? `<!doctype html><html><body><p id="results">results for ${req.query}</p></body></html>`
          : '<!doctype html><html><body><form id="f" action="/search?page=2" method="get"><input name="q" value="red hats"><button>Go</button></form></body></html>'
      ),
    }));
    const shown = await mountSsr(transport);
    const form = shown.shadowRoot.getElementById('f') as HTMLFormElement;
    form.requestSubmit();
    await expect.poll(() => seen.find((req) => req.path === '/search')?.query, { timeout: 5_000 }).toBeDefined();
    expect(seen.find((req) => req.path === '/search')?.query).toBe('q=red+hats');
    await expect.poll(() => shown.currentPath, { timeout: 5_000 }).toBe('/search?q=red+hats');
  });

  it("hands the app's fetch every header the backend sent, one named like an Object method too", async () => {
    const transport: BackendTransport = {
      kind: 'remote',
      ready: Promise.resolve(),
      fetch: async () => ({
        status: 200,
        statusText: 'OK',
        headers: [['Content-Type', 'text/plain'], ['Constructor', 'kept'], ['toString', 'also'], ['X-Twice', 'a'], ['X-Twice', 'b']],
        body: new TextEncoder().encode('ok'),
      }),
      dispose: () => undefined,
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    handle = await mountSoftNContainer(host, {
      isolation: 'inline',
      persistStorage: false,
      permissionMode: 'deny',
      engineWasm: { lite: LITE_WASM },
      backendTransport: transport,
      source: {
        'index.html': `<!doctype html><html><body><p id="out">-</p><script>
          fetch('/api/headers').then(function (r) {
            document.getElementById('out').textContent = [r.headers.get('constructor'), r.headers.get('tostring'), r.headers.get('x-twice')].join('|');
          });
        </script></body></html>`,
      },
    });
    await expect.poll(() => handle!.shadowRoot.getElementById('out')?.textContent, { timeout: 10_000 }).not.toBe('-');
    expect(handle.shadowRoot.getElementById('out')?.textContent).toBe('kept|also|a, b');
  });

  it('sends a form of a method no browser sends (method="put") as a GET, and a dialog form not at all', async () => {
    const { transport, seen } = backend((req) => ({
      type: 'text/html; charset=utf-8',
      body: new TextEncoder().encode(
        req.path === '/'
          ? `<!doctype html><html><body>
              <form id="put" action="/items" method="put"><input name="a" value="1"></form>
              <dialog open><form id="dlg" method="dialog"><button value="ok">OK</button></form></dialog>
            </body></html>`
          : `<!doctype html><html><body><p id="page">${req.method} ${req.path}</p></body></html>`
      ),
    }));
    const shown = await mountSsr(transport);
    const dialogForm = shown.shadowRoot.getElementById('dlg') as HTMLFormElement;
    dialogForm.requestSubmit();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(seen.map((req) => `${req.method} ${req.path}`)).toEqual(['GET /']);
    (shown.shadowRoot.getElementById('put') as HTMLFormElement).requestSubmit();
    await expect.poll(() => seen.length, { timeout: 5_000 }).toBe(2);
    expect(seen[1]).toEqual({ method: 'GET', path: '/items', query: 'a=1' });
  });
});
