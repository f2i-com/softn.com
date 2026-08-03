import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createConsoleModule,
  createMockNavModule,
  createMockXDBModule,
  createScriptRuntime,
  type PermissionConfig,
  type ScriptContext,
} from '../src/runtime/script-runtime';

interface NetworkRuntimeInternals {
  setPermissionConfig(config: PermissionConfig): void;
  handleNetFetch(call: { id: number; kind: string; args: string[] }): Promise<unknown>;
}

function makeRuntime() {
  const context: ScriptContext = {
    state: {},
    setState: () => {},
    data: {},
    xdb: createMockXDBModule(),
    nav: createMockNavModule(),
    console: createConsoleModule(),
  };
  const runtime = createScriptRuntime(context, undefined, 'net-lifecycle-test');
  (runtime as unknown as NetworkRuntimeInternals).setPermissionConfig({
    permissions: { net: { enabled: true, allowed_hosts: ['api.test'] } },
  });
  return runtime;
}

function fetchCall() {
  return { id: 1, kind: 'net.fetch', args: ['https://api.test/data', '{}'] };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('softn.net.fetch lifecycle', () => {
  it('aborts an outstanding request when its runtime is cleaned up', async () => {
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        if (!init?.signal) throw new Error('Expected an abort signal');
        const signal = init.signal as AbortSignal;
        requestSignal = signal;
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      })
    );

    const runtime = makeRuntime();
    const request = (runtime as unknown as NetworkRuntimeInternals).handleNetFetch(fetchCall());
    await Promise.resolve();

    expect(requestSignal?.aborted).toBe(false);
    runtime.cleanup();
    expect(requestSignal?.aborted).toBe(true);
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('cancels a streaming response before buffering more than 10 MiB', async () => {
    const cancel = vi.fn(async () => {
      throw new Error('stream already disturbed');
    });
    const releaseLock = vi.fn();
    const chunks = [new Uint8Array(10 * 1024 * 1024), new Uint8Array(1)];
    let index = 0;
    const response = {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () =>
            index < chunks.length
              ? { done: false, value: chunks[index++] }
              : { done: true, value: undefined },
          cancel,
          releaseLock,
        }),
      },
    } as unknown as Response;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response)
    );

    const runtime = makeRuntime();
    await expect(
      (runtime as unknown as NetworkRuntimeInternals).handleNetFetch(fetchCall())
    ).rejects.toThrow('Network response is too large');
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
    runtime.cleanup();
  });
});
