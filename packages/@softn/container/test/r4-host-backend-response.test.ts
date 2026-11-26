/**
 * Round 4 (container host): what a backend's answer becomes on its way to the page.
 *
 * Both native hosts read an answer the same way (`backend_status` / `parse_headers_json` in
 * apps/softn-host-rust, `clampContainerStatus` in apps/softn-host-php): a status that is no
 * HTTP status is a 500, header pairs that are not a name and a value are dropped, and a HEAD,
 * 204 or 304 answer carries no body, as the browser would give the page.
 */
import { describe, it, expect } from 'vitest';
import { LocalBackendTransport } from '../src/local-backend-transport';
import type { BackendConfig, BackendHttpResponse } from '../src/types';

const dec = new TextDecoder();

function transport(backend: BackendConfig, textFiles: Record<string, string>) {
  return new LocalBackendTransport({
    appId: 'r4-resp',
    storagePrefix: 'r4-resp:',
    persistStorage: false,
    backend,
    textFiles,
    binaryFiles: {},
    runtimeUrl: '/runtime/',
    isolation: 'inline',
  });
}

function within<T>(p: Promise<T>, ms: number): Promise<T | 'timed out'> {
  return Promise.race([p, new Promise<'timed out'>((r) => setTimeout(() => r('timed out'), ms))]);
}

const JS_BACKEND: BackendConfig = { runtime: 'javascript', entry: 'backend/index.js', mode: 'api', routes: ['/api/'] };

describe('r4 host: backend answers are read as the native hosts read them', () => {
  it('answers a request whose headers are not all name and value pairs', async () => {
    const t = transport(JS_BACKEND, {
      'backend/index.js': `function handleRequest(req) {
  return { status: 200, headers: [null, ['X-Ok', 'yes'], [1, 2], { name: 'x' }, ['Bad Name', 'v'], ['X-Nl', 'a\\nb'], ['X-Num', 5], ['Set-Cookie', 'sid=1; Path=/']], body: 'hi' };
}`,
    });
    await t.ready;
    const r = await within(t.fetch({ method: 'GET', path: '/api/x', headers: {} }), 3000);
    expect(r).not.toBe('timed out');
    const resp = r as BackendHttpResponse;
    expect(resp.status).toBe(200);
    expect(dec.decode(resp.body)).toBe('hi');
    expect(resp.headers).toEqual([['X-Ok', 'yes'], ['X-Num', '5'], ['Set-Cookie', 'sid=1; Path=/']]);
    expect(t.cookieJar.getCookieHeader('/')).toBe('sid=1');
    t.dispose();
  });

  it('answers 500 for a status that is no HTTP status', async () => {
    const t = transport(JS_BACKEND, {
      'backend/index.js': `function handleRequest(req) {
  var s = Number(req.query.split('=')[1]);
  return { status: s, body: 'x' };
}`,
    });
    await t.ready;
    const statusFor = async (s: string) => (await t.fetch({ method: 'GET', path: '/api/s', query: `s=${s}`, headers: {} })).status;
    expect(await statusFor('0')).toBe(500);
    expect(await statusFor('999')).toBe(500);
    expect(await statusFor('150')).toBe(500);
    expect(await statusFor('200.5')).toBe(500);
    expect(await statusFor('201')).toBe(201);
    expect(await statusFor('302')).toBe(302);
    expect(await statusFor('599')).toBe(599);
    t.dispose();
  });

  it('gives a HEAD, 204 or 304 answer no body', async () => {
    const t = transport({ runtime: 'php', entry: 'index.php', mode: 'ssr' }, {
      'index.php': `<?php
$m = $_GET['m'] ?? '';
if ($m === '204') { http_response_code(204); echo 'not for the page'; exit; }
if ($m === '304') { http_response_code(304); echo 'not for the page'; exit; }
echo 'the page';
`,
    });
    await t.ready;
    const head = await t.fetch({ method: 'HEAD', path: '/index.php', headers: {} });
    expect(head.status).toBe(200);
    expect(head.body.byteLength).toBe(0);
    const noContent = await t.fetch({ method: 'GET', path: '/index.php', query: 'm=204', headers: {} });
    expect(noContent.status).toBe(204);
    expect(noContent.body.byteLength).toBe(0);
    const notModified = await t.fetch({ method: 'GET', path: '/index.php', query: 'm=304', headers: {} });
    expect(notModified.status).toBe(304);
    expect(notModified.body.byteLength).toBe(0);
    const get = await t.fetch({ method: 'GET', path: '/index.php', headers: {} });
    expect(dec.decode(get.body)).toBe('the page');
    t.dispose();
  });
});
