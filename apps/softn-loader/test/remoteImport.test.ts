import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBundleImportResolver } from '../src/remoteImport';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('loader remote imports', () => {
  it('requires an explicit net.enabled permission', async () => {
    const fetchImpl = vi.fn(async () => new Response('remote logic'));
    const omitted = createBundleImportResolver(new Map(), {
      permissionConfig: null,
      fetchImpl,
    });
    const disabled = createBundleImportResolver(new Map(), {
      permissionConfig: { permissions: {} },
      fetchImpl,
    });

    expect(await omitted('https://modules.example/main.logic')).toBeNull();
    expect(await disabled('https://modules.example/main.logic')).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('enforces protocol, host allowlists and redirect destinations', async () => {
    const redirected = new Response('wrong host');
    Object.defineProperty(redirected, 'url', { value: 'https://other.example/main.logic' });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('allowed'))
      .mockResolvedValueOnce(redirected)
      .mockResolvedValueOnce(new Response('http allowed'));
    const httpsOnly = createBundleImportResolver(new Map(), {
      permissionConfig: {
        permissions: { net: { enabled: true, allowed_hosts: ['modules.example'] } },
      },
      fetchImpl,
    });

    expect(await httpsOnly('https://modules.example/ok.logic')).toBe('allowed');
    expect(await httpsOnly('https://other.example/no.logic')).toBeNull();
    expect(await httpsOnly('http://modules.example/no.logic')).toBeNull();
    expect(await httpsOnly('https://modules.example/redirect.logic')).toBeNull();

    const httpAllowed = createBundleImportResolver(new Map(), {
      permissionConfig: {
        permissions: {
          net: { enabled: true, allow_http: true, allowed_hosts: ['modules.example'] },
        },
      },
      fetchImpl,
    });
    expect(await httpAllowed('http://modules.example/ok.logic')).toBe('http allowed');
  });

  it('stops oversized streaming responses', async () => {
    const resolve = createBundleImportResolver(new Map(), {
      permissionConfig: { permissions: { net: { enabled: true } } },
      maxRemoteBytes: 4,
      fetchImpl: vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4, 5]))),
    });

    expect(await resolve('https://modules.example/large.logic')).toBeNull();
  });

  it('aborts on timeout and always releases controller tracking', async () => {
    vi.useFakeTimers();
    const released = vi.fn();
    const tracked: AbortController[] = [];
    const fetchImpl = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          );
        })
    );
    const resolve = createBundleImportResolver(new Map(), {
      permissionConfig: { permissions: { net: { enabled: true } } },
      timeoutMs: 25,
      fetchImpl,
      trackController: (controller) => {
        tracked.push(controller);
        return released;
      },
    });

    const result = resolve('https://modules.example/slow.logic');
    await vi.advanceTimersByTimeAsync(25);
    expect(await result).toBeNull();
    expect(tracked[0].signal.aborted).toBe(true);
    expect(released).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
