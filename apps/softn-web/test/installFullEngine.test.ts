import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFullEngine } from '../src/lib/installFullEngine';

const engine = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
vi.mock('@softn/core/web-host', () => ({ zippEngineBytes: 8, zippWasmUrl: () => new URL('https://softn.test/shared/assets/zipp_wasm_bg-abc.wasm') }));

function storage(saved?: Response) {
  const cache = {
    match: vi.fn(async () => saved?.clone()),
    delete: vi.fn(async () => { saved = undefined; }),
    put: vi.fn(async (_url: URL, response: Response) => { saved = response; }),
  };
  vi.stubGlobal('caches', { open: async () => cache });
  return cache;
}
afterEach(() => vi.unstubAllGlobals());

describe('the offline copy of the full engine', () => {
  it('reuses the complete module an earlier app or first-visit preview already saved', async () => {
    storage(new Response(engine));
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    await installFullEngine();
    expect(network).not.toHaveBeenCalled();
  });

  it('removes a corrupt cache hit and waits until the replacement is stored', async () => {
    const cache = storage(new Response('not wasm'));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(engine)));
    await installFullEngine();
    expect(cache.delete).toHaveBeenCalledOnce();
    expect(cache.put).toHaveBeenCalledOnce();
    expect(new Uint8Array(await (await cache.match())!.arrayBuffer())).toEqual(engine);
  });

  it('refuses a fresh incomplete response or an unavailable cache', async () => {
    const cache = storage();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(engine.subarray(0, 4))));
    await expect(installFullEngine()).rejects.toThrow('complete WebAssembly engine');
    expect(cache.put).not.toHaveBeenCalled();
    cache.put.mockRejectedValueOnce(new Error('quota'));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(engine)));
    await expect(installFullEngine()).rejects.toThrow('quota');
  });
});
