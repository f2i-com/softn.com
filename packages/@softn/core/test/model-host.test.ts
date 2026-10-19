// @vitest-environment node
/**
 * `softn.ai.model.*` on the page: which sources an app may name, how much of a
 * model it may hold, where a download may come from, and the Worker each
 * model lives in. The model itself is the runner's (zipp-model-runner.test.ts);
 * here the Worker is a stand-in that answers as the real one does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelHost, chooseGgufFile, evictForRoom, generationOptions, isHubHost, parseModelSpec, type ModelHostConfig } from '../src/runtime/models/model-host';

const MB = 1024 * 1024;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A response with a body, as fetch would give, from `url` after any redirect. */
function respond(bytes: number | Uint8Array, init: { status?: number; headers?: Record<string, string>; url?: string } = {}) {
  const body = typeof bytes === 'number' ? new Uint8Array(bytes) : bytes;
  const response = new Response(body as BodyInit, { status: init.status ?? 200, headers: init.headers });
  Object.defineProperty(response, 'url', { value: init.url ?? '' });
  return response;
}

function listing(files: Array<[string, number]>) {
  return respond(new TextEncoder().encode(JSON.stringify(files.map(([path, size]) => ({ type: 'file', path, size, lfs: { size } })))));
}

describe('what an app may name', () => {
  it('reads a repository, a quantization, a URL and the explicit forms', () => {
    expect(parseModelSpec('unsloth/Some-Model-GGUF')).toMatchObject({ kind: 'huggingface', repo: 'unsloth/Some-Model-GGUF', revision: 'main' });
    expect(parseModelSpec('a/b:Q6_K', { revision: 'v1' })).toMatchObject({ repo: 'a/b', quant: 'Q6_K', revision: 'v1' });
    expect(parseModelSpec('https://models.test/m.gguf')).toMatchObject({ kind: 'url', url: 'https://models.test/m.gguf' });
    expect(parseModelSpec({ huggingface: 'a/b', file: 'm-Q4_K_M.gguf' })).toMatchObject({ kind: 'huggingface', file: 'm-Q4_K_M.gguf' });
    expect(parseModelSpec({ bundle: './models/m.gguf' })).toMatchObject({ kind: 'bundle', path: 'models/m.gguf' });
  });

  it('refuses ONNX repositories by saying what runs instead, and anything that is not a model', () => {
    expect(() => parseModelSpec('onnx-community/Some-Model-ONNX')).toThrow(/ONNX files; SoftN runs GGUF/);
    expect(() => parseModelSpec('just-a-name')).toThrow(/not a Hugging Face repository/);
    expect(() => parseModelSpec('a/b', { file: '../../etc/passwd' })).toThrow(/\.gguf file/);
    expect(() => parseModelSpec({ bundle: '../x.gguf' })).toThrow(/bundled model/);
    expect(() => parseModelSpec('a/b', { revision: 'main/../../x' })).toThrow(/revision/);
    expect(() => parseModelSpec({})).toThrow(/huggingface, url or bundle/);
  });

  it('takes a quantization that stays resident, never a projector or a split file', () => {
    const files = ['README.md', 'm-Q8_0.gguf', 'm-Q4_K_S.gguf', 'm-Q4_K_M.gguf', 'mmproj-F16.gguf', 'big-00001-of-00002.gguf'];
    expect(chooseGgufFile(files)).toBe('m-Q4_K_M.gguf');
    expect(chooseGgufFile(files, 'q8_0')).toBe('m-Q8_0.gguf');
    expect(() => chooseGgufFile(['m-Q8_0.gguf'])).toThrow(/No Q4_K or Q6_K file.*m-Q8_0\.gguf/);
    expect(() => chooseGgufFile(['mmproj.gguf', 'a-00001-of-00003.gguf'])).toThrow(/no single-file/);
  });

  it('knows the hub and its file store, and nothing that only ends like them', () => {
    expect(isHubHost('huggingface.co')).toBe(true);
    expect(isHubHost('cdn-lfs-us-1.hf.co')).toBe(true);
    expect(isHubHost('cas-bridge.xethub.hf.co')).toBe(true);
    expect(isHubHost('evilhf.co')).toBe(false);
    expect(isHubHost('huggingface.co.evil.test')).toBe(false);
  });

  it('maps transformers.js option names and turns sampling off on request', () => {
    expect(generationOptions({ max_new_tokens: 64, temperature: 0.9, top_p: 0.8, top_k: 20, repetition_penalty: 1.1, enable_thinking: true }))
      .toEqual({ maxNewTokens: 64, temperature: 0.9, topP: 0.8, topK: 20, repetitionPenalty: 1.1, thinking: true, seed: undefined });
    expect(generationOptions({ do_sample: false, temperature: 0.9 }).temperature).toBe(0);
    expect(generationOptions({ temperature: 'hot' }).temperature).toBeUndefined();
  });
});

describe('where a model may come from', () => {
  const host = (config: ModelHostConfig) => new ModelHost(config);

  it('holds a URL to the app\'s net entry, before any fetch, and follows no redirect', async () => {
    const fetch = vi.fn(async () => respond(3, { url: 'https://models.test/m.gguf' }));
    vi.stubGlobal('fetch', fetch);
    await expect(host({ ai: { allowedSources: ['url'] } }).fetchCheckpoint('https://models.test/m.gguf', {})).rejects.toThrow(/needs net/);
    await expect(host({ ai: { allowedSources: ['url'] }, net: { enabled: true, allowed_hosts: ['models.test'] } }).fetchCheckpoint('https://attacker.test/m.gguf', {})).rejects.toThrow(/Host not allowed/);
    await expect(host({ ai: { allowedSources: ['url'] }, net: { enabled: true } }).fetchCheckpoint('http://models.test/m.gguf', {})).rejects.toThrow(/HTTP not allowed/);
    await expect(host({ ai: { allowedSources: ['url'] }, net: { enabled: true } }).fetchCheckpoint('https://models.test/m.onnx', {})).rejects.toThrow(/\.gguf/);
    await expect(host({ ai: { allowedSources: ['huggingface'] }, net: { enabled: true } }).fetchCheckpoint('https://models.test/m.gguf', {})).rejects.toThrow(/does not allow models from a URL/);
    expect(fetch).not.toHaveBeenCalled();
    const { blob } = await host({ ai: { allowedSources: ['url'] }, net: { enabled: true, allowed_hosts: ['models.test'] } }).fetchCheckpoint('https://models.test/m.gguf', {});
    expect(blob.size).toBe(3);
    expect(fetch).toHaveBeenCalledWith('https://models.test/m.gguf', { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store', signal: expect.any(AbortSignal) });
  });

  it('lists a repository on the hub, takes its resident quantization, and refuses one past the limit before downloading it', async () => {
    const fetch = vi.fn(async (url: string) => (url.includes('/api/models/')
      ? listing([['m-Q8_0.gguf', 900 * MB], ['m-Q4_K_M.gguf', 3 * MB]])
      : respond(3, { url: 'https://cas-bridge.xethub.hf.co/x' })));
    vi.stubGlobal('fetch', fetch);
    const { blob, label } = await host({ ai: { maxModelSizeMB: 8 } }).fetchCheckpoint('owner/model-GGUF', {});
    expect(label).toBe('owner/model-GGUF/m-Q4_K_M.gguf');
    expect(blob.size).toBe(3);
    expect(fetch).toHaveBeenLastCalledWith('https://huggingface.co/owner/model-GGUF/resolve/main/m-Q4_K_M.gguf', expect.objectContaining({ redirect: 'follow', credentials: 'omit' }));
    fetch.mockClear();
    await expect(host({ ai: { maxModelSizeMB: 2 } }).fetchCheckpoint('owner/model-GGUF', {})).rejects.toThrow(/3 MB, past the app's limit of 2 MB/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses bytes the hub redirected somewhere else, and a size that passes the limit on the way in', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(3, { url: 'https://evil.test/x' })));
    await expect(host({}).fetchCheckpoint('a/b', { file: 'm.gguf' })).rejects.toThrow(/redirected to evil\.test/);
    vi.stubGlobal('fetch', vi.fn(async () => respond(1, { url: 'https://huggingface.co/a/b', headers: { 'content-length': String(5 * MB) } })));
    await expect(host({ ai: { maxModelSizeMB: 1 } }).fetchCheckpoint('a/b', { file: 'm.gguf' })).rejects.toThrow(/5 MB, past/);
    // A server that says nothing of its size is cut off where the limit is.
    vi.stubGlobal('fetch', vi.fn(async () => respond(2 * MB, { url: 'https://huggingface.co/a/b' })));
    await expect(host({ ai: { maxModelSizeMB: 1 } }).fetchCheckpoint('a/b', { file: 'm.gguf' })).rejects.toThrow(/passes the app's limit of 1 MB/);
  });

  it('keeps a download in Cache Storage and reads it from there next time', async () => {
    const store = new Map<string, Response>();
    vi.stubGlobal('caches', {
      open: async () => ({
        keys: async () => [...store.keys()].map((url) => new Request(url)),
        match: async (key: string | Request) => store.get(typeof key === 'string' ? key : key.url)?.clone(),
        put: async (key: string, response: Response) => { store.set(key, new Response(await response.arrayBuffer())); },
        delete: async (key: string | Request) => store.delete(typeof key === 'string' ? key : key.url),
      }),
    });
    const fetch = vi.fn(async () => respond(new Uint8Array([1, 2, 3]), { url: 'https://huggingface.co/a/b' }));
    vi.stubGlobal('fetch', fetch);
    const first = await host({}).fetchCheckpoint('a/b', { file: 'm.gguf' });
    const second = await host({}).fetchCheckpoint('a/b', { file: 'm.gguf' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(await second.blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(first.blob.size).toBe(3);
  });

  it('still loads when the cache will not keep the file, by downloading it again for this load only', async () => {
    const put = vi.fn(async (_key: string, response: Response) => {
      await response.arrayBuffer();
      throw Object.assign(new Error("Failed to execute 'put' on 'Cache': Unexpected internal error."), { name: 'UnknownError' });
    });
    const remove = vi.fn(async () => true);
    vi.stubGlobal('caches', { open: async () => ({ keys: async () => [], match: async () => undefined, put, delete: remove }) });
    const fetch = vi.fn(async () => respond(new Uint8Array([7, 8]), { url: 'https://huggingface.co/a/b' }));
    vi.stubGlobal('fetch', fetch);
    const { blob } = await host({}).fetchCheckpoint('a/b', { file: 'm.gguf' });
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([7, 8]));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledOnce();
    // Past the limit is the app's answer even when the cache is the one that saw it.
    vi.stubGlobal('caches', { open: async () => ({ match: async () => undefined, put: async (_k: string, r: Response) => { await r.arrayBuffer(); }, delete: remove }) });
    vi.stubGlobal('fetch', vi.fn(async () => respond(2 * MB, { url: 'https://huggingface.co/a/b' })));
    await expect(host({ ai: { maxModelSizeMB: 1 } }).fetchCheckpoint('a/b', { file: 'm.gguf' })).rejects.toThrow(/passes the app's limit of 1 MB/);
  });

  it('stops a download when the app closes, and starts no Worker for it', async () => {
    let started!: () => void;
    const begun = new Promise<void>((resolve) => { started = resolve; });
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      started();
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      });
    }));
    const createWorker = vi.fn();
    const closing = new ModelHost({ createWorker });
    const load = closing.load('a/b', { file: 'm.gguf' });
    await begun;
    closing.dispose();
    await expect(load).rejects.toThrow(/app has closed/);
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('gives up on a server that stops sending', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(8));
            init.signal?.addEventListener('abort', () => controller.error(init.signal!.reason));
          },
        });
        return respond(0, { url: 'https://huggingface.co/a/b' }) && Object.defineProperty(new Response(body), 'url', { value: 'https://huggingface.co/a/b' });
      }));
      const pending = host({}).fetchCheckpoint('a/b', { file: 'm.gguf' });
      const settled = expect(pending).rejects.toThrow(/stopped arriving/);
      await vi.advanceTimersByTimeAsync(61_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds the site\'s model cache to a few files, letting the oldest go first', async () => {
    const store = new Map<string, Response>();
    const cache = {
      keys: async () => [...store.keys()].map((url) => new Request(url)),
      match: async (key: string | Request) => store.get(typeof key === 'string' ? key : key.url)?.clone(),
      delete: async (key: string | Request) => store.delete(typeof key === 'string' ? key : key.url),
    };
    for (let i = 1; i <= 4; i++) store.set(`https://huggingface.co/m${i}`, new Response(new Uint8Array(10)));
    await evictForRoom(cache as unknown as Cache, 'https://huggingface.co/m5', 10);
    expect([...store.keys()]).toEqual(['https://huggingface.co/m2', 'https://huggingface.co/m3', 'https://huggingface.co/m4']);
    // Reloading what is there already makes no room for itself.
    await evictForRoom(cache as unknown as Cache, 'https://huggingface.co/m4', 10);
    expect(store.size).toBe(3);
  });

  it('keeps no copy when the origin has no room for one', async () => {
    const put = vi.fn();
    vi.stubGlobal('caches', { open: async () => ({ match: async () => undefined, put, delete: vi.fn() }) });
    vi.stubGlobal('navigator', { storage: { estimate: async () => ({ quota: 4 * MB, usage: 3 * MB }) } });
    vi.stubGlobal('fetch', vi.fn(async () => respond(MB, { url: 'https://huggingface.co/a/b', headers: { 'content-length': String(MB) } })));
    expect((await host({}).fetchCheckpoint('a/b', { file: 'm.gguf' })).blob.size).toBe(MB);
    expect(put).not.toHaveBeenCalled();
  });

  it('reads a bundled model through the bundle, held to the same limit', async () => {
    const readBundleFile = vi.fn(async (path: string) => (path === 'models/m.gguf' ? new Blob([new Uint8Array(4)]) : path === 'models/big.gguf' ? new Blob([new Uint8Array(2 * MB)]) : null));
    expect((await host({ readBundleFile }).fetchCheckpoint({ bundle: 'models/m.gguf' }, {})).blob.size).toBe(4);
    await expect(host({ readBundleFile }).fetchCheckpoint({ bundle: 'models/x.gguf' }, {})).rejects.toThrow(/no models\/x\.gguf/);
    await expect(host({ readBundleFile, ai: { allowedSources: ['huggingface'] } }).fetchCheckpoint({ bundle: 'models/m.gguf' }, {})).rejects.toThrow(/its bundle/);
    await expect(host({ readBundleFile, ai: { maxModelSizeMB: 1 } }).fetchCheckpoint({ bundle: 'models/big.gguf' }, {})).rejects.toThrow(/passes the app's limit of 1 MB/);
  });
});

/** A Worker that answers as model-worker.ts does, after a tick. */
class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message?: string; preventDefault?: () => void }) => void) | null = null;
  posted: Array<Record<string, unknown>> = [];
  terminated = false;
  hold = false;
  constructor(private readonly answer: (message: Record<string, unknown>) => unknown) {}
  postMessage(message: Record<string, unknown>) {
    this.posted.push(message);
    if (message.type === 'cancel' || this.hold) return;
    setTimeout(() => {
      try {
        this.onmessage?.({ data: { type: 'result', id: message.id, value: this.answer(message) } });
      } catch (error) {
        this.onmessage?.({ data: { type: 'error', id: message.id, message: (error as Error).message } });
      }
    }, 0);
  }
  reply(data: unknown) { this.onmessage?.({ data }); }
  terminate() { this.terminated = true; }
}

describe('the Worker a model lives in', () => {
  const info = { architecture: 'qwen3', family: 'qwen3', name: 'm', context: 2048, vocabSize: 10, backend: 'webgpu', residentMB: 1, plugin: { id: 'p', version: '1' } };
  function setup() {
    vi.stubGlobal('fetch', vi.fn(async () => respond(3, { url: 'https://huggingface.co/a/b' })));
    const workers: FakeWorker[] = [];
    const host = new ModelHost({
      createWorker: () => {
        const worker = new FakeWorker((m) => (m.type === 'open' ? info : { text: 'hello', finishReason: 'stop' }));
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });
    return { host, workers };
  }

  it('opens a model in its own Worker, answers through it, and terminates it on release', async () => {
    const { host, workers } = setup();
    const loaded = await host.load('a/b', { file: 'm.gguf', device: 'webgpu', context: 1024 });
    expect(loaded).toMatchObject({ modelHandle: 'model-1', modelId: 'a/b/m.gguf', backend: 'webgpu' });
    expect(workers[0].posted[0]).toMatchObject({ type: 'open', backend: 'webgpu', context: 1024 });
    expect(workers[0].posted[0].blob).toBeInstanceOf(Blob);
    const reply = await host.generate('model-1', [{ role: 'user', content: 'hi' }], { do_sample: false, max_new_tokens: 5 });
    expect(reply).toMatchObject({ text: 'hello' });
    expect(workers[0].posted[1]).toMatchObject({ type: 'generate', options: { temperature: 0, maxNewTokens: 5 } });
    expect(host.release('model-1')).toBe(true);
    expect(workers[0].terminated).toBe(true);
    await expect(host.generate('model-1', [{ role: 'user', content: 'hi' }])).rejects.toThrow(/No model/);
  });

  it('holds at most two models, one reply at a time each, and cancels the one in progress', async () => {
    const { host, workers } = setup();
    await host.load('a/b', { file: 'm.gguf' });
    await host.load('a/b', { file: 'm.gguf' });
    await expect(host.load('a/b', { file: 'm.gguf' })).rejects.toThrow(/at most 2 models/);
    workers[0].hold = true;
    const pending = host.generate('model-1', [{ role: 'user', content: 'hi' }]);
    await expect(host.generate('model-1', [{ role: 'user', content: 'again' }])).rejects.toThrow(/still answering/);
    expect(host.cancel('model-1')).toBe(true);
    const generateId = workers[0].posted[1].id;
    expect(workers[0].posted[2]).toEqual({ type: 'cancel', id: generateId });
    workers[0].reply({ type: 'text', id: generateId, text: 'part' });
    workers[0].reply({ type: 'result', id: generateId, value: { text: 'part', finishReason: 'cancelled' } });
    await expect(pending).resolves.toMatchObject({ finishReason: 'cancelled' });
    await expect(host.generate('model-1', [])).rejects.toThrow(/between 1 and 400/);
  });

  it('drops a model whose Worker failed, and terminates everything when the app closes', async () => {
    const { host, workers } = setup();
    await host.load('a/b', { file: 'm.gguf' });
    workers[0].hold = true;
    const pending = host.generate('model-1', [{ role: 'user', content: 'hi' }]);
    workers[0].onerror?.({ message: 'out of memory' });
    await expect(pending).rejects.toThrow(/model worker failed: out of memory/);
    await expect(host.generate('model-1', [{ role: 'user', content: 'hi' }])).rejects.toThrow(/released after it stopped answering/);
    await host.load('a/b', { file: 'm.gguf' });
    host.dispose();
    expect(workers[1].terminated).toBe(true);
    await expect(host.load('a/b', { file: 'm.gguf' })).rejects.toThrow(/closed/);
  });

  it('refuses a model the Worker could not open, and lets its Worker go', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(3, { url: 'https://huggingface.co/a/b' })));
    const worker = new FakeWorker(() => { throw new Error('This checkpoint is a llama architecture'); });
    const host = new ModelHost({ createWorker: () => worker as unknown as Worker });
    await expect(host.load('a/b', { file: 'm.gguf' })).rejects.toThrow(/llama architecture/);
    expect(worker.terminated).toBe(true);
  });
});
