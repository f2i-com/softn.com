import { zippEngineBytes, zippWasmUrl } from '@softn/core/web-host';

async function isCompleteEngine(response: Response): Promise<boolean> {
  const bytes = await response.arrayBuffer();
  return (zippEngineBytes === undefined || bytes.byteLength === zippEngineBytes) && WebAssembly.validate(bytes);
}

/** Called after a worker controls the page, even if it compiled the engine before then.
 * The cache key must be exactly the URL used by the compiler in this build. */
export async function installFullEngine(signal?: AbortSignal): Promise<void> {
  const url = zippWasmUrl();
  const cache = await caches.open('softn-full-engine');
  const saved = await cache.match(url);
  if (saved) {
    if (await isCompleteEngine(saved)) return;
    await cache.delete(url);
  }
  signal?.throwIfAborted();
  const response = await fetch(url, { cache: 'reload', credentials: 'same-origin', signal });
  if (!response.ok) throw new Error(`Engine download returned HTTP ${response.status}.`);
  if (!await isCompleteEngine(response.clone())) {
    await cache.delete(url);
    throw new Error('The engine download did not contain a complete WebAssembly engine.');
  }
  signal?.throwIfAborted();
  // Workbox can finish sending the response before its cache write. Only mark the
  // app ready after storage actually holds the engine, including on a first visit.
  if (!(await cache.match(url))) await cache.put(url, response);
}
