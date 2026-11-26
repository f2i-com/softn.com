/**
 * Round 4 (container host): what a PHP script reads of a request.
 *
 * zipp-php takes each character of the request's text as one byte of a PHP string, so text
 * the host decoded (a form field, a cookie, a path) reached PHP as Latin-1 unless it was
 * handed over as its UTF-8 bytes. The engine reads a form body itself, as PHP does
 * (`a[]=1&a[]=2` is an array).
 */
import { describe, it, expect } from 'vitest';
import { LocalBackendTransport } from '../src/local-backend-transport';
import { BackendWorkerSession, type BackendToHostMsg } from '../src/backend-runtime';
import type { BackendConfig } from '../src/types';

const dec = new TextDecoder();
const PHP: BackendConfig = { runtime: 'php', entry: 'index.php', mode: 'ssr' };

function transport(textFiles: Record<string, string>) {
  return new LocalBackendTransport({
    appId: 'r4-sapi',
    storagePrefix: 'r4-sapi:',
    persistStorage: false,
    backend: PHP,
    textFiles,
    binaryFiles: {},
    runtimeUrl: '/runtime/',
    isolation: 'inline',
  });
}

async function json(t: LocalBackendTransport, req: { method?: string; path: string; query?: string; headers?: Record<string, string>; body?: string }) {
  const r = await t.fetch({ method: req.method ?? 'GET', path: req.path, query: req.query ?? '', headers: req.headers ?? {}, body: req.body });
  return { status: r.status, body: JSON.parse(dec.decode(r.body)) as Record<string, unknown> };
}

describe('r4 host: a PHP script reads the request as PHP would', () => {
  it('reads a form with letters outside ASCII and with array fields', async () => {
    const t = transport({
      'index.php': `<?php echo json_encode(['post' => $_POST, 'name' => bin2hex($_POST['name'] ?? '')]);`,
    });
    await t.ready;
    const r = await json(t, {
      method: 'POST',
      path: '/index.php',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: 'name=Jos%C3%A9&tags%5B%5D=a&tags%5B%5D=b&m%5Bk%5D=v&plus=a+b',
    });
    expect(r.status).toBe(200);
    // "José" as UTF-8, as PHP reads it.
    expect(r.body.name).toBe('4a6f73c3a9');
    expect(r.body.post).toEqual({ name: 'José', tags: ['a', 'b'], m: { k: 'v' }, plus: 'a b' });
    t.dispose();
  });

  it('reads a cookie with letters outside ASCII, and the most specific of two with one name', async () => {
    const t = transport({
      'index.php': `<?php echo json_encode(['c' => bin2hex($_COOKIE['c'] ?? ''), 'dup' => $_COOKIE['dup'] ?? null]);`,
    });
    await t.ready;
    t.cookieJar.setCookieHeader('c=Jos%C3%A9; Path=/');
    t.cookieJar.setCookieHeader('dup=general; Path=/');
    t.cookieJar.setCookieHeader('dup=specific; Path=/index.php');
    const r = await json(t, { path: '/index.php' });
    expect(r.body).toEqual({ c: '4a6f73c3a9', dup: 'specific' });
    t.dispose();
  });

  it('names the server without its port, and takes no header whose name has an underscore', async () => {
    // Driven at the session itself: the transport in front of it already drops `host` and such names.
    let ready!: () => void;
    const isReady = new Promise<void>((r) => (ready = r));
    let answer!: (m: Extract<BackendToHostMsg, { type: 'response' }>) => void;
    const answered = new Promise<Extract<BackendToHostMsg, { type: 'response' }>>((r) => (answer = r));
    const s = new BackendWorkerSession((m) => {
      if (m.type === 'ready') ready();
      if (m.type === 'response') answer(m);
    });
    void s.handleMessage({
      type: 'init',
      appId: 'r4-sapi-server',
      backend: PHP,
      databases: [],
      textFiles: {
        'index.php': `<?php echo json_encode(['name' => $_SERVER['SERVER_NAME'], 'host' => $_SERVER['HTTP_HOST'], 'port' => $_SERVER['SERVER_PORT'], 'https' => $_SERVER['HTTPS'], 'xff' => $_SERVER['HTTP_X_FORWARDED_FOR'] ?? null]);`,
      },
      binaryFiles: {},
      runtimeUrl: '/runtime/',
    });
    await isReady;
    void s.handleMessage({
      type: 'fetch',
      reqId: 1,
      method: 'GET',
      path: '/index.php',
      query: '',
      headers: { host: 'app.example.test:8443', 'x-forwarded-for': '203.0.113.7', x_forwarded_for: '10.0.0.1' },
    });
    const r = await answered;
    expect(JSON.parse(dec.decode(r.bodyBytes))).toEqual({
      name: 'app.example.test',
      host: 'app.example.test:8443',
      port: '443',
      https: 'on',
      xff: '203.0.113.7',
    });
    s.dispose();
  });

  it('reads a query that a rewrite filled from a path outside ASCII', async () => {
    const t = transport({
      '.htaccess': 'RewriteEngine On\nRewriteRule ^search/(.*)$ find.php?q=$1 [L,QSA]\n',
      'index.php': `<?php echo json_encode(['front' => true]);`,
      'find.php': `<?php echo json_encode(['q' => bin2hex($_GET['q'] ?? ''), 'page' => $_GET['page'] ?? null, 'uri' => bin2hex($_SERVER['REQUEST_URI'])]);`,
    });
    await t.ready;
    const r = await json(t, { path: '/search/caf%C3%A9', query: 'page=2' });
    expect(r.status).toBe(200);
    expect(r.body.q).toBe('636166c3a9');
    expect(r.body.page).toBe('2');
    const utf8Hex = (s: string) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('');
    expect(r.body.uri).toBe(utf8Hex('/search/café?page=2'));
    t.dispose();
  });
});
