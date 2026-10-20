import { describe, expect, it, vi } from 'vitest';
import { createNativeFetch, createNativeNetFetch } from '../src/nativeNetFetch';
import { createImportResolver } from '@softn/runtime-shell/bundleProcessor';
import { withheldPermissions } from '@softn/runtime-shell/consent';

const granted = { permissions: { net: { enabled: true, allowed_hosts: ['api.example.com'] } } };
const reply = { ok: true, status: 200, statusText: 'OK', body: 'hello', headers: { 'content-type': 'text/plain' } };

describe('softn.net.fetch through the native side', () => {
  // The renderer skips its own net check and host allowlist when a handler is
  // supplied, so every refusal here is one nothing else would make.
  it('refuses, without asking the native side, what the running config does not grant', async () => {
    const invoke = vi.fn(async () => reply);
    await expect(createNativeNetFetch(withheldPermissions(granted), invoke)('https://api.example.com/', {})).rejects.toThrow(
      'net access not permitted yet: this app has asked for it and you have not allowed it.'
    );
    await expect(createNativeNetFetch({ permissions: {} }, invoke)('https://api.example.com/', {})).rejects.toThrow(
      'Network access not permitted. Add net.enabled to permission.json'
    );
    await expect(createNativeNetFetch(granted, invoke)('https://evil.example.net/', {})).rejects.toThrow('Host not allowed: evil.example.net');
    await expect(createNativeNetFetch(granted, invoke)('http://api.example.com/', {})).rejects.toThrow('HTTP not allowed');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('sends a permitted request with the grant the native side re-checks', async () => {
    const invoke = vi.fn(async () => reply);
    // This computer is reached only when the grant names it.
    const fetch = createNativeNetFetch({ permissions: { net: { enabled: true, allow_http: true, allowed_hosts: ['localhost'] } } }, invoke);
    await expect(fetch('http://localhost:8080/items', { headers: { 'X-Count': 2, bad: {} }, body: 'a=1' })).resolves.toEqual(reply);
    expect(invoke).toHaveBeenCalledWith('net_fetch', {
      request: {
        url: 'http://localhost:8080/items',
        method: 'GET',
        headers: { 'X-Count': '2' },
        body: 'a=1',
        timeoutMs: undefined,
        allowHttp: true,
        allowedHosts: ['localhost'],
      },
    });
  });

  it('does not reach this computer or its network with net alone', async () => {
    const invoke = vi.fn(async () => reply);
    const fetch = createNativeNetFetch({ permissions: { net: { enabled: true, allow_http: true } } }, invoke);
    await expect(fetch('http://localhost:8080/items', {})).rejects.toThrow(/local network/);
    await expect(fetch('http://192.168.1.1/', {})).rejects.toThrow(/local network/);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('remote imports through the native side', () => {
  it('resolves a granted import and never asks for a withheld one', async () => {
    const invoke = vi.fn(async () => ({ ...reply, body: 'export const x = 1;' }));
    const url = 'https://api.example.com/lib.logic';
    const withheld = withheldPermissions(granted);
    const pending = createImportResolver(new Map(), withheld, { fetchImpl: createNativeFetch(withheld, invoke) });
    expect(await pending(url)).toBeNull();
    expect(invoke).not.toHaveBeenCalled();

    const allowed = createImportResolver(new Map(), granted, { fetchImpl: createNativeFetch(granted, invoke) });
    expect(await allowed(url)).toBe('export const x = 1;');
    expect(invoke).toHaveBeenCalledWith('net_fetch', { request: { url, method: 'GET', allowHttp: false, allowedHosts: ['api.example.com'] } });
  });

  it('treats a failed or bodiless native answer as no module', async () => {
    const invoke = vi.fn().mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found', body: 'missing', headers: {} }).mockResolvedValueOnce({ ok: true, status: 204, body: '', headers: {} });
    const resolve = createImportResolver(new Map(), granted, { fetchImpl: createNativeFetch(granted, invoke) });
    expect(await resolve('https://api.example.com/a.logic')).toBeNull();
    expect(await resolve('https://api.example.com/b.logic')).toBe('');
  });

  it('does not ask the native side for an import on this computer or its network unless the grant names the host', async () => {
    // The loader's own copy of the import rule judged scheme and host list
    // only, so `import "https://192.168.1.1/x.logic"` under a bare `net`
    // went out where softn.net.fetch to the same host was refused.
    const invoke = vi.fn(async () => ({ ...reply, body: 'let x = 1' }));
    const bare = { permissions: { net: { enabled: true, allow_http: true } } };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const resolve = createImportResolver(new Map(), bare, { fetchImpl: createNativeFetch(bare, invoke) });
    expect(await resolve('https://192.168.1.1/x.logic')).toBeNull();
    expect(await resolve('http://localhost:8080/x.logic')).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    warn.mockRestore();

    const named = { permissions: { net: { enabled: true, allow_http: true, allowed_hosts: ['localhost'] } } };
    const local = createImportResolver(new Map(), named, { fetchImpl: createNativeFetch(named, invoke) });
    expect(await local('http://localhost:8080/x.logic')).toBe('let x = 1');
  });
});
