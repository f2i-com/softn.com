// Build apps/formlogic-host, then run node apps/formlogic-host/test/web-frame.smoke.mjs [chromium|firefox|webkit].
// FORMLOGIC_REPO runs the guest's request against the checkout's real SQLite service.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium, firefox, webkit } from 'playwright';

const engines = { chromium, firefox, webkit };
const browserName = process.argv[2] ?? 'chromium';
assert.ok(Object.hasOwn(engines, browserName), 'Choose chromium, firefox or webkit.');
const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><body></body>'); return; }
  const file = path.resolve(dist, pathname.replace(/^\/hosted-runtime\//, ''));
  if (!file.startsWith(dist)) { response.writeHead(404).end(); return; }
  try {
    const bytes = await readFile(file);
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' })[path.extname(file)] ?? 'application/octet-stream');
    response.end(bytes);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
let temporary;
try {
  browser = await engines[browserName].launch();
  const page = await browser.newPage();
  await keepTestRoots(page);
  const requested = [];
  page.on('request', request => requested.push(new URL(request.url()).pathname));
  await page.goto('http://127.0.0.1:' + server.address().port);
  let client = {
    'manifest.json': JSON.stringify({ engine: 2, main: 'index.html' }),
    'index.html': '<main id="notes">Opening</main><script type="module" src="./client.js"></script>',
    'client.js': `
      import { db } from 'softn:db';
      import { api } from 'softn:api';
      async function run() {
        const response = await api.fetch('/api/notes', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'Browser note' })
        });
        const note = await response.json();
        db.create('notes', { title: note.title });
        document.querySelector('#notes').textContent = note.title + ' ' + db.query('notes').length;
      }
      run();
    `,
  };
  if (process.env.FORMLOGIC_REPO) {
    temporary = await mkdtemp(path.join(tmpdir(), 'softn-formlogic-browser-'));
    const backend = path.resolve(process.env.FORMLOGIC_REPO, 'formlogic/backend');
    const invoke = (operation, input) => JSON.parse(execFileSync('php', ['-r', `
      require $argv[1] . '/vendor/autoload.php';
      $service = new FormLogic\\Services\\NativeAppService($argv[2], $argv[1] . '/resources/softn-native', $argv[3]);
      $input = json_decode(stream_get_contents(STDIN), true, 512, JSON_THROW_ON_ERROR);
      if ($argv[4] === 'install') {
        $service->install('notes', $input, 0);
        $out = FormLogic\\Services\\NativeAppService::clientFiles($service->get('notes'));
      } else {
        $out = $service->request('notes', $input);
      }
      echo json_encode($out, JSON_THROW_ON_ERROR);
    `, backend, temporary, process.execPath, operation], { input: JSON.stringify(input), encoding: 'utf8' }));
    client = invoke('install', { access: 'application', assets: {}, files: { ...client,
      'manifest.json': JSON.stringify({ ...JSON.parse(client['manifest.json']), id: 'fixture.notes', version: '1.0.0', server: {
        entry: 'server/main.logic', requires: { apiVersion: 1, capabilities: ['sql'] },
        database: { kind: 'private-sqlite', migrations: ['server/migrations/001.sql'] },
        routes: [{ method: 'POST', path: '/api/notes', handler: 'createNote', authorization: 'anonymous', transaction: 'write' }],
      } }),
      'server/migrations/001.sql': 'CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL);',
      'server/main.logic': 'function createNote(req) { softn.sql.execute("INSERT INTO notes(title) VALUES (?)", [req.body.title]); return {status:201, body:softn.sql.first("SELECT id,title FROM notes ORDER BY id DESC LIMIT 1", [])}; }',
    } });
    await page.exposeFunction('runBackend', ({ url, options }) => {
      const result = invoke('request', { path: url, method: options.method, body: options.body, client_ip: '127.0.0.1' });
      assert.equal(result.status, 201);
      assert.deepEqual(result.body, { id: 1, title: 'Browser note' });
      return result;
    });
  }
  await page.evaluate(client => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    window.events = [];
    window.addEventListener('message', event => {
      if (event.source !== frame.contentWindow || event.data.type !== 'formlogic:ready') return;
      const channel = new MessageChannel();
      channel.port1.onmessage = async ({ data }) => {
        window.events.push(data);
        if (data.type !== 'call') return;
        if (data.action === 'nativeRequest') {
          const result = window.runBackend ? await window.runBackend(data.input) : { status: 201, body: data.input.options.body };
          channel.port1.postMessage({ id: data.id, result: { result } });
        } else if (data.action === 'nativeStorage') {
          channel.port1.postMessage({ id: data.id, result: { result: { ok: true } } });
        }
      };
      frame.contentWindow.postMessage({ type: 'formlogic:init', client, native: true, engine: 'web-container',
        appId: 'notes', storage: {}, assets: {} }, '*', [channel.port2]);
    });
    frame.src = '/hosted-runtime/index.html?format=web';
    document.body.appendChild(frame);
  }, client);
  await page.waitForFunction(() => window.events.some(event => event.type === 'error' || event.action === 'nativeStorage'));
  const events = await page.evaluate(() => window.events);
  assert.ok(!events.some(event => event.type === 'error'), JSON.stringify(events));
  const request = events.find(event => event.action === 'nativeRequest');
  assert.deepEqual(request.input, { url: '/api/notes', options: { method: 'POST', headers: { 'content-type': 'application/json' }, body: { title: 'Browser note' } } });
  const frame = page.frames()[1];
  await frame.waitForFunction(() => window.testRoots.some(root => root.querySelector('#notes')?.textContent === 'Browser note 1'));
  assert.deepEqual(requested.filter(path => path.endsWith('.wasm')).map(path => path.split('/').pop()), ['zipp-javascript-lite.wasm']);
  assert.deepEqual(requested.filter(path => /\/assets\/(?:main|react|jsx-runtime)-[\w-]+\.js$/.test(path)), [],
    'The vanilla web frame must open without fetching the classic renderer or React.');
  console.log(`The ${browserName} frame rendered the backend response and saved the record using the lite engine.`);
  await checkWebPages(browser, page.url());
  await checkHostContainerBackend(browser, page.url());
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  if (temporary) {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(tmpdir()));
    assert.match(path.basename(temporary), /^softn-formlogic-browser-[a-zA-Z0-9]+$/);
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Keep the host's closed roots in the test so Playwright can select a file and click links. */
function keepTestRoots(page) {
  return page.addInitScript(() => {
    const attach = Element.prototype.attachShadow;
    window.testRoots = [];
    Element.prototype.attachShadow = function (options) {
      const root = attach.call(this, options);
      window.testRoots.push(root);
      return root;
    };
  });
}

/** Use the public handshake a FormLogic parent uses to reopen an app at its last page. */
async function checkWebPages(browser, origin) {
  const page = await browser.newPage();
  try {
    await keepTestRoots(page);
    const open = async (place, allowFiles) => {
      await page.goto(origin);
      await page.evaluate(({ place, allowFiles }) => {
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts');
        window.events = [];
        window.addEventListener('message', event => {
          if (event.source !== frame.contentWindow || event.data?.type !== 'formlogic:ready') return;
          const channel = new MessageChannel();
          channel.port1.onmessage = ({ data }) => window.events.push(data);
          const client = {
            'manifest.json': JSON.stringify({ engine: 2, main: 'index.html' }),
            'index.html': '<h1>Home page</h1><a id="details" href="pages/details.html">Open details</a>',
            'pages/details.html': `<h1>Details</h1><a id="site" href="https://example.org/help">Help</a>
              <input id="pick" type="file"><p id="picked"></p><script>
                document.getElementById('pick').onchange = async function () {
                  var f = this.files[0];
                  document.getElementById('picked').textContent = f ? await f.text() : 'No file available';
                };
              </script>`,
          };
          frame.contentWindow.postMessage({ type: 'formlogic:init', native: true, engine: 'web-container',
            appId: 'page-fixture', client, ...(event.data.places === 1 ? { place } : {}),
            permissions: { files: allowFiles } }, '*', [channel.port2]);
        });
        frame.src = '/hosted-runtime/index.html?format=web';
        document.body.appendChild(frame);
      }, { place, allowFiles });
      await page.waitForFunction(() => window.events.some(e => e.type === 'shown' || e.type === 'error'));
      assert.ok(!await page.evaluate(() => window.events.some(e => e.type === 'error')));
      return page.frames()[1];
    };
    const element = async (frame, selector) => {
      const found = await frame.waitForFunction(s => window.testRoots.map(root => root.querySelector(s)).find(Boolean), selector);
      return found.asElement();
    };
    const places = () => page.evaluate(() => window.events.filter(e => e.type === 'place').map(e => e.place));
    const home = await open('/removed.html', false);
    assert.deepEqual(await places(), ['/']);
    await (await element(home, '#details')).click();
    await page.waitForFunction(() => window.events.some(e => e.type === 'place' && e.place === '/pages/details.html'));
    const lastPlace = (await places()).at(-1);
    for (const allowed of [false, true]) {
      const frame = await open(lastPlace, allowed);
      assert.deepEqual(await places(), [lastPlace]);
      await (await element(frame, '#site')).click();
      await page.waitForFunction(() => window.events.some(e => e.type === 'link' && e.href === 'https://example.org/help'));
      await (await element(frame, '#pick')).setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Picked note') });
      await frame.waitForFunction(text => window.testRoots.some(root => root.querySelector('#picked')?.textContent === text),
        allowed ? 'Picked note' : 'No file available');
    }
    console.log('Hosted HTML navigation, a restored page, a removed page, external links and both file grant settings passed.');
  } finally { await page.close(); }
}

/** Verify full-stack containerBackend:'host' routes fetch('/api/*') over MessagePort containerHttp without booting local PHP/SQLite WASM. */
async function checkHostContainerBackend(browser, origin) {
  const page = await browser.newPage();
  try {
    await keepTestRoots(page);
    const requested = [];
    page.on('request', req => requested.push(new URL(req.url()).pathname));
    await page.goto(origin);
    await page.evaluate(() => {
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts');
      window.events = [];
      window.readyMsg = null;
      window.addEventListener('message', event => {
        if (event.source !== frame.contentWindow || event.data?.type !== 'formlogic:ready') return;
        window.readyMsg = event.data;
        const channel = new MessageChannel();
        channel.port1.onmessage = ({ data }) => {
          window.events.push(data);
          if (data.type === 'call' && data.action === 'containerHttp') {
            const payload = data.input.bodyBase64 ? JSON.parse(atob(data.input.bodyBase64)) : {};
            const replyBody = JSON.stringify({ ok: true, method: data.input.method, path: data.input.path, echo: payload.name || null });
            channel.port1.postMessage({
              id: data.id,
              result: { result: { status: 201, headers: [['Content-Type', 'application/json']], bodyBase64: btoa(replyBody) } },
            });
          } else if (data.type === 'call' && data.action === 'nativeStorage') {
            channel.port1.postMessage({ id: data.id, result: { result: { ok: true } } });
          }
        };
        const client = {
          'manifest.json': JSON.stringify({
            engine: 2,
            main: 'public/index.html',
            frontendRoot: 'public',
            backend: { runtime: 'php', entry: 'backend/index.php', mode: 'api', routes: ['/api/'] },
            databases: [{ name: 'app', engine: 'sqlite', file: 'app.db', persist: true }],
          }),
          'public/index.html': '<div id="out">loading</div><script type="module" src="./app.js"></script>',
          'public/app.js': `
            const r = await fetch('/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Latte' }) });
            const d = await r.json();
            document.getElementById('out').textContent = r.status + ':' + d.method + ':' + d.path + ':' + d.echo;
          `,
        };
        frame.contentWindow.postMessage({
          type: 'formlogic:init',
          native: true,
          engine: 'web-container',
          containerBackend: 'host',
          appId: 'hosted-php-app',
          client,
          storage: {},
          assets: {},
        }, '*', [channel.port2]);
      });
      frame.src = '/hosted-runtime/index.html?format=web';
      document.body.appendChild(frame);
    });
    await page.waitForFunction(() => window.events.some(e => e.type === 'error' || e.action === 'containerHttp'));
    const readyMsg = await page.evaluate(() => window.readyMsg);
    assert.equal(readyMsg.containerBackend, 1);
    const frame = page.frames()[1];
    await frame.waitForFunction(() => window.testRoots.some(r => r.querySelector('#out')?.textContent === '201:POST:/api/orders:Latte'));
    const fetchedWasms = requested.filter(p => p.endsWith('.wasm')).map(p => p.split('/').pop());
    assert.deepEqual(fetchedWasms, ['zipp-javascript-lite.wasm'], 'Hosted container backend must not download local zipp-php.wasm or xdb-wasm.wasm into the browser');
    console.log('Full-stack containerBackend:host routed fetch("/api/orders") over MessagePort containerHttp with zero local backend WASM.');
  } finally { await page.close(); }
}
