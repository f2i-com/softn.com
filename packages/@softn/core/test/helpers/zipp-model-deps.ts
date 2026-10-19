/** The model runner's dependencies in Node: the engine, gguf-wasm and the kernels, from their files. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import initEngine, { Engine } from '../../wasm-zipp/zipp_wasm.js';
// @ts-expect-error -- vendored JavaScript
import initGguf, * as gguf from '../../vendor/zipp-models/model-plugins/wasm/gguf/gguf_wasm.js';
import type { RunnerDeps } from '../../src/runtime/models/zipp-model-runner';

const core = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const vendor = path.join(core, 'vendor', 'zipp-models');

/** The architecture plugins as the worker bundles them: every file of each folder. */
export function vendoredPlugins(): RunnerDeps['plugins'] {
  const out: Record<string, Map<string, Uint8Array>> = {};
  for (const name of ['qwen3']) {
    const dir = path.join(vendor, 'model-plugins', 'plugins', name);
    out[name] = new Map(fs.readdirSync(dir).map((file) => [file, new Uint8Array(fs.readFileSync(path.join(dir, file)))]));
  }
  return out;
}

export async function modelDeps(): Promise<RunnerDeps> {
  await initEngine({ module_or_path: fs.readFileSync(path.join(core, 'wasm-zipp', 'zipp_wasm_bg.wasm')) });
  await initGguf({ module_or_path: fs.readFileSync(path.join(vendor, 'model-plugins', 'wasm', 'gguf', 'gguf_wasm_bg.wasm')) });
  return {
    engine: () => new Engine(),
    gguf,
    kernels: { wasmBytes: new Uint8Array(fs.readFileSync(path.join(vendor, 'gpu-lab', 'wasm', 'kernels.wasm'))) },
    plugins: vendoredPlugins(),
  };
}
