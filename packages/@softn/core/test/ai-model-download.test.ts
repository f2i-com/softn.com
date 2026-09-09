/**
 * Model downloads: where a bundle may fetch a model from, and how much of
 * it the runtime will hold before giving up.
 *
 * `resolveModel` is driven directly — everything after it needs the ONNX
 * runtime, and nothing here is about inference.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { OnnxManager } from '../src/runtime/ai-onnx-manager';
import type { AIPermissionConfig } from '../src/runtime/ai-manager';
import type { NetPermission } from '../src/runtime/egress-policy';

interface Internals {
  resolveModel(source: { url?: string; huggingface?: string }, maxBytes: number): Promise<ArrayBuffer>;
}

const MB = 1024 * 1024;

function manager(ai: AIPermissionConfig, net?: NetPermission): Internals {
  const mgr = new OnnxManager();
  mgr.setPermissionConfig(ai, net);
  return mgr as unknown as Internals;
}

/** A response whose body arrives in the given chunks. */
function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  let index = 0;
  const cancel = vi.fn(async () => {});
  const releaseLock = vi.fn();
  const bodyCancel = vi.fn(async () => {});
  const response = {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    body: {
      cancel: bodyCancel,
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
  return { response, cancel, releaseLock, bodyCancel };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('model URL egress', () => {
  it('refuses a host the bundle scoped itself away from, before any fetch', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const mgr = manager({ allowedSources: ['url'] }, { enabled: true, allowed_hosts: ['models.test'] });
    await expect(mgr.resolveModel({ url: 'https://attacker.test/m.onnx' }, MB)).rejects.toThrow(
      /Host not allowed/
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses plain http unless the bundle allowed it', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const mgr = manager({ allowedSources: ['url'] }, { enabled: true });
    await expect(mgr.resolveModel({ url: 'http://models.test/m.onnx' }, MB)).rejects.toThrow(
      /HTTP not allowed/
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fetches a permitted host', async () => {
    const { response } = streamed([new Uint8Array([1, 2, 3])]);
    const fetch = vi.fn(async () => response);
    vi.stubGlobal('fetch', fetch);
    const mgr = manager({ allowedSources: ['url'] }, { enabled: true, allowed_hosts: ['models.test'] });
    const data = await mgr.resolveModel({ url: 'https://models.test/m.onnx' }, MB);
    expect(data.byteLength).toBe(3);
    expect(new Uint8Array(data)).toEqual(new Uint8Array([1, 2, 3]));
    expect(fetch).toHaveBeenCalledWith('https://models.test/m.onnx');
  });
});

describe('model size cap', () => {
  it('turns a declared size over the cap away without reading the body', async () => {
    const { response, bodyCancel, releaseLock } = streamed([new Uint8Array(1)], {
      'content-length': String(2 * MB),
    });
    vi.stubGlobal('fetch', vi.fn(async () => response));
    const mgr = manager({ allowedSources: ['url'] });
    await expect(mgr.resolveModel({ url: 'https://models.test/m.onnx' }, MB)).rejects.toThrow(
      /exceeds limit/
    );
    expect(bodyCancel).toHaveBeenCalledOnce();
    expect(releaseLock).not.toHaveBeenCalled();
  });

  it('stops reading once the stream passes the cap, whatever the header said', async () => {
    const { response, cancel, releaseLock } = streamed([
      new Uint8Array(MB),
      new Uint8Array(1),
      new Uint8Array(MB),
    ]);
    vi.stubGlobal('fetch', vi.fn(async () => response));
    const mgr = manager({ allowedSources: ['huggingface'] });
    await expect(mgr.resolveModel({ huggingface: 'org/model' }, MB)).rejects.toThrow(
      /exceeds limit/
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });
});
