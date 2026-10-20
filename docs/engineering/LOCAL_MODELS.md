# Local language models on ZIPP

`softn.ai.model.*` runs a chat model in the person's browser on ZIPP: the same engine that runs apps' logic compiles the model's architecture, and ZIPP's compute runtime runs it on WebGPU, WebGL2, compiled WebAssembly kernels or plain JavaScript, whichever the device has. Nothing third-party does inference. ONNX Runtime, transformers.js and Kokoro were removed, and with them about 80 MB of WebAssembly per deployment and 850 MB of `node_modules`.

## For an app

```js
softn.ai.model.load("owner/Model-GGUF", { context: 2048 }, function (r) {
  if (r.error) return show(r.error);
  softn.ai.model.generate(r.modelHandle, [
    { role: "system", content: "You answer briefly." },
    { role: "user", content: "What is the capital of France?" }
  ], { max_new_tokens: 128, temperature: 0.7 }, function (reply) {
    show(reply.text);           // reasoning (<think>…</think>) already removed
  });
});
```

- **What to load.** A GGUF checkpoint: a Hugging Face repository (`"owner/name"`, or `"owner/name:Q4_K_M"` to pick one of its files, or `{huggingface, file, revision}`), a URL (`{url}`), or a file of the app's own bundle (`{bundle: "models/m.gguf"}`). With no file named, the repository's Q4_K_M (then Q4_K_S, then Q6_K) file is taken: those are the block formats ZIPP keeps resident, so a 0.6B model holds about 400 MB rather than 2.3 GB. An ONNX repository is refused by name.
- **Which models.** Architectures SoftN has a ZIPP plugin for: today `qwen3` (tied embeddings). `softn.ai.getCapabilities` lists them under `models`. Anything else is refused when it is opened, naming its architecture.
- **Options.** `load`: `device` (`auto`, `webgpu` or `wasm`), `context` (64–4096 positions, default 2048; when the compute runtime's budget refuses the caches that many positions need, it is halved until they fit, down to 256, and the load's answer says the `context` it got), `file`, `revision`. `generate`: `max_new_tokens` (up to 2048), `temperature` (0 is greedy; `do_sample: false` means 0), `top_k`, `top_p`, `repetition_penalty`, `enable_thinking`, `seed`. transformers.js's names and camelCase both work.
- **The answer.** `{text, finishReason: "stop" | "length" | "context" | "cancelled", promptTokens, reusedTokens, generatedTokens, msPerToken, backend}`. `cancel(handle)` stops a reply where it is; `release(handle)` frees the model.
- **Offline.** SoftN Web installs the AI runtime with an app that asks for `ai` (the model host's chunks and the local-model worker's files, `docs/engineering/COMPONENT_LOADING.md`), and a model is kept in Cache Storage the first time the app loads it, so the app runs a model it has loaded before, or one in its own bundle, with no connection. A worker-mode app reads a model in its bundle as a main-thread one does.
- **Permission.** `ai` in permission.json. `allowedSources` (`huggingface`, `url`, `bundle`) limits where a model may come from; `maxModelSizeMB` (default 1024) is checked against the declared size before downloading and against the bytes while they arrive. A URL is egress: it also needs `net`, judged as `softn.net.fetch` is, and its redirects are refused. The hub's `resolve` URLs redirect to its file store; that redirect is followed, and the bytes are refused unless they came from `huggingface.co`, `*.huggingface.co`, `hf.co` or `*.hf.co`.

## How it runs

| Piece | Where | What it does |
| --- | --- | --- |
| `models/model-host.ts` | the page (a lazy chunk, `model-host-*`) | Resolves the source, enforces the permission, streams the download into Cache Storage (`softn-models-v1`) and reads it back as a Blob the browser keeps on disk, starts one Worker per model, at most two models per app. A download stops when the app closes and when nothing has arrived for a minute. The cache is the site's, shared by every app, so it holds four files and 4 GB at most, the oldest let go first; when the origin has no room, or the cache refuses the file, it is downloaded again and held for that load only. |
| `models/model-worker.ts` | `core-runtime/runtime/model-worker.js` | Owns one model: the engine, the weights, the device. The engine is the page's own, compiled once and posted with the request that opens the model, so the worker downloads no engine. Releasing is terminating it, and so is a reply that will not stop (15-minute watchdog). |
| `models/zipp-model-runner.ts` | inside the worker | Opens the GGUF where it lies (the header from the first megabytes, each tensor a byte range), installs the architecture's plugin (its `plugin.json` pins every Python file's sha256), compiles it on SoftN's own engine, and prepares a one-token decode program whose key/value caches stay on the device between calls. |
| `models/chat-template.ts` | inside the worker | ChatML as Qwen's template writes it, built from token ids; a message that spells a control token (`<|im_end|>`, `<think>`, any token the file marks control or user-defined) is cut so it encodes as plain characters and cannot open a turn of its own. |
| `vendor/zipp-models/` | source, bundled into the worker | ZIPP's `gpu-lab` (the compute runtime and its kernels), `model-plugins` (the loader, the decode planner, the Qwen3 plugin) and gguf-wasm's browser build, at the commit `SOURCE.json` records. |

A conversation that grows by a message only reads the new part: the runner remembers which token ids its caches hold and reuses the shared prefix. A long new stretch (over 48 tokens) is read in chunks of 16 by a second program prepared for that prompt and let go after, whose caches seed the first; when the budget will not hold that program beside the first, prompts are read a token at a time instead. Measured with Qwen3-0.6B Q4_K_M on an NVIDIA GPU in Chromium: about 17 ms a token generating and 44 ms a token reading a prompt on WebGPU; about 360 ms a token on the single-threaded WebAssembly kernels in Node.

## Updating ZIPP's model stack

```sh
cd packages/@softn/core
node scripts/vendor-zipp-models.mjs --zipp ../../../../zipp.org --ref v0.0.27
node scripts/vendor-zipp-models.mjs --check
```

The first copies the listed files at that git ref byte for byte (`.gitattributes` keeps the folder out of line-ending conversion, because a plugin's hashes would otherwise refuse it), checks the GPU runtime against the release's embed kit when `.zipp-release/` holds it, checks gguf-wasm's files against ZIPP's own lock, and records each file's sha256. The licence inventory (`scripts/generate-third-party-notices.mjs`) refuses a vendored tree that differs from `SOURCE.json`. A new architecture is a new plugin folder in ZIPP, listed in `VENDORED`, bundled in `model-worker.ts`, and named in `ai-manager.ts`'s capability report.

## Tests

`packages/@softn/core/test/zipp-model-runner.test.ts` writes a tiny Qwen3 GGUF (helpers/tiny-gguf.ts) and runs it on the compute runtime's CPU and WebAssembly backends: chunked reading equal to token-at-a-time reading, cache reuse equal to a fresh model, cancellation, the chat format and its injection guard, refusals. With a real checkpoint on disk (`SOFTN_TEST_GGUF`) it also asks one a question with one answer. `model-host.test.ts` covers sources, limits, redirects, caching and the worker protocol with a stand-in worker.
