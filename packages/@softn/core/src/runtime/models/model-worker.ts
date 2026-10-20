/**
 * The Worker that owns one local model (scripts/build-model-worker.mjs bundles
 * it to dist/runtime/model-worker.js, with gguf-wasm's and the compute
 * kernels' modules beside it in dist/runtime/models/).
 *
 * It holds the engine, the weights and the device for exactly one model, so
 * releasing the model is terminating the Worker, and a generation that will
 * not stop is stopped the same way. Every message in is from model-host.ts on
 * the page; nothing here reaches the network: the checkpoint arrives as a
 * Blob the page already holds.
 */
import initEngine, { Engine, zipp_install_panic_hook } from '../../../wasm-zipp/zipp_wasm.js';
// @ts-expect-error -- vendored JavaScript
import initGguf, * as gguf from '../../../vendor/zipp-models/model-plugins/wasm/gguf/gguf_wasm.js';
import qwen3Manifest from '../../../vendor/zipp-models/model-plugins/plugins/qwen3/plugin.json?raw';
import qwen3Architecture from '../../../vendor/zipp-models/model-plugins/plugins/qwen3/architecture.py?raw';
import qwen3Graph from '../../../vendor/zipp-models/model-plugins/plugins/qwen3/graph.py?raw';
import { ZippModelRunner, type ModelBackend, type GenerateOptions } from './zipp-model-runner';
import type { ChatMessage } from './chat-template';

export type WorkerRequest =
  | { type: 'open'; id: number; blob: Blob; engine: WebAssembly.Module | BufferSource; backend?: ModelBackend; context?: number }
  | { type: 'generate'; id: number; messages: ChatMessage[]; options: GenerateOptions }
  | { type: 'cancel'; id: number };

export type WorkerReply =
  | { type: 'progress'; phase: string }
  | { type: 'text'; id: number; text: string }
  | { type: 'result'; id: number; value: unknown }
  | { type: 'error'; id: number; message: string };

const scope = self as unknown as {
  postMessage(message: WorkerReply): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

const encode = (text: string) => new TextEncoder().encode(text);
// The plugin's files exactly as vendored; plugin.json pins each Python file's
// sha256, so a byte changed between here and the engine refuses to install.
const PLUGINS = {
  qwen3: new Map([['plugin.json', encode(qwen3Manifest)], ['architecture.py', encode(qwen3Architecture)], ['graph.py', encode(qwen3Graph)]]),
};

let runner: ZippModelRunner | null = null;
let ready: Promise<void> | null = null;
const cancelled = new Set<number>();

/** The engine is the page's, compiled once and posted with `open`: there is no copy beside this worker. */
function boot(engine: WebAssembly.Module | BufferSource): Promise<void> {
  ready ??= (async () => {
    await initEngine({ module_or_path: engine });
    zipp_install_panic_hook();
    await initGguf({ module_or_path: new URL('./models/gguf_wasm_bg.wasm', import.meta.url) });
  })();
  return ready;
}

async function handle(request: WorkerRequest): Promise<unknown> {
  if (request.type === 'open') {
    if (runner) throw new Error('This worker already holds a model');
    await boot(request.engine);
    runner = await ZippModelRunner.open(request.blob, {
      engine: () => new Engine(),
      gguf,
      kernels: { wasmUrl: new URL('./models/kernels.wasm', import.meta.url) },
      plugins: PLUGINS,
    }, {
      backend: request.backend,
      context: request.context,
      progress: (phase) => scope.postMessage({ type: 'progress', phase }),
    });
    return runner.info;
  }
  if (request.type === 'generate') {
    if (!runner) throw new Error('No model is open');
    let last = 0;
    try {
      return await runner.generate(request.messages, request.options, {
        cancelled: () => cancelled.has(request.id),
        // The reply so far, at most ten times a second.
        onText: (text) => {
          const now = performance.now();
          if (now - last < 100) return;
          last = now;
          scope.postMessage({ type: 'text', id: request.id, text });
        },
      });
    } finally {
      cancelled.delete(request.id);
    }
  }
  return null;
}

scope.onmessage = (event) => {
  const request = event.data;
  if (!request || typeof request !== 'object') return;
  if (request.type === 'cancel') {
    cancelled.add(request.id);
    return;
  }
  handle(request).then(
    (value) => scope.postMessage({ type: 'result', id: request.id, value }),
    (error: unknown) => scope.postMessage({ type: 'error', id: request.id, message: String(error instanceof Error ? error.message : error).slice(0, 500) }),
  );
};
