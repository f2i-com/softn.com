import {check} from './common.mjs';

/**
 * Finding the GGUF WebAssembly module, or finding out that it is not here.
 *
 * GGUF reading is an *optional* capability. It is a second WebAssembly module,
 * separate from the ZIPP engine's and separate from the compute kernels', and
 * it is not built here: the container, the block formats and the tokenizer are
 * generic, so they live in their own project and this consumes a tagged
 * release of it (see `scripts/fetch_gguf_wasm.sh`). A host that only ever
 * loads Safetensors should not have to ship it, and this package must import
 * and work without it -- so nothing here is imported statically, and a missing
 * module is an answer rather than an error.
 *
 * Three ways a host gets one, in order of precedence:
 *
 *   1. It supplies a factory. A bundler, an offline build or a test harness
 *      knows better than we do where the module is.
 *   2. It supplies a URL to the wasm-bindgen glue.
 *   3. Neither, and we probe what `scripts/fetch_gguf_wasm.sh` put next to
 *      this package. In Node that is the CommonJS build; in a browser the
 *      ES-module one, whose default export fetches the `.wasm` beside it.
 *
 * `ggufSupport()` answers the question a UI actually asks -- is it there? --
 * without throwing, so a page can say "GGUF: not fetched" instead of failing.
 */
const NODE = typeof process !== 'undefined' && Boolean(process.versions?.node);
const NODE_GLUE = '../wasm/gguf-node/gguf_wasm.js';
const WEB_GLUE = '../wasm/gguf/gguf_wasm.js';

/** Check the shape of what a factory returned. The module comes from another
 * crate and is coupled to this one by that shape, not by a version. */
export async function loadGgufModule(factory) {
  check(typeof factory === 'function', 'HOST', 'Supply a factory that returns the GGUF WebAssembly module');
  const wasm = await factory();
  check(wasm && typeof wasm.GgufHeader === 'function', 'HOST', 'That module exposes no GgufHeader');
  return wasm;
}

/** The default probe: whatever `scripts/fetch_gguf_wasm.sh` last put there. */
async function probe() {
  if (NODE) {
    const {createRequire} = await import('node:module');
    return createRequire(import.meta.url)(NODE_GLUE);
  }
  const module = await import(new URL(WEB_GLUE, import.meta.url).href);
  // wasm-bindgen's web target fetches its `.wasm` on the first call, not at
  // import; until then every export throws.
  if (typeof module.default === 'function') await module.default();
  return module;
}

/**
 * Is GGUF reading available here?
 *
 * Returns `{available, module, source}` or `{available: false, reason}`. It
 * never throws for a missing module -- that is the case it exists to report.
 * The result is cached per set of options, because probing means a dynamic
 * import and, in a browser, a fetch.
 */
const cache = new Map();
export function ggufSupport({factory, url, reload = false} = {}) {
  const key = factory ? factory : url ?? '';
  if (!reload && cache.has(key)) return cache.get(key);
  const answer = (async () => {
    const attempts = [];
    if (factory) attempts.push(['factory', () => loadGgufModule(factory)]);
    if (url) attempts.push(['url', async () => {
      const module = await import(String(url));
      if (typeof module.default === 'function') await module.default();
      return loadGgufModule(() => module);
    }]);
    if (!factory && !url) attempts.push([NODE ? 'node module' : 'web module', () => loadGgufModule(probe)]);
    let reason = 'no source was tried';
    for (const [source, load] of attempts) {
      try { return {available: true, module: await load(), source}; }
      // First line only: a module-resolution failure carries a whole require
      // stack, and this string goes in a UI.
      catch (error) { reason = `${source}: ${String(error?.message ?? error).split(/\r?\n/)[0]}`; }
    }
    return {
      available: false,
      reason,
      // The one thing a person reading this actually needs to do about it.
      remedy: 'Fetch it: model-plugins/scripts/fetch_gguf_wasm.sh',
    };
  })();
  cache.set(key, answer);
  return answer;
}

/** The module, or a refusal that says how to get one. For a caller that has
 * already decided it needs GGUF. */
export async function requireGgufModule(options) {
  const support = await ggufSupport(options);
  check(support.available, 'HOST', `GGUF reading is unavailable (${support.reason}). ${support.remedy}`);
  return support.module;
}
