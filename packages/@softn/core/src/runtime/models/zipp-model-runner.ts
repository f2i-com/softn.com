/**
 * One local language model, run by ZIPP.
 *
 * The checkpoint is a GGUF file read where it lies: its header is parsed from
 * the first megabytes, its quantized matrices stay in the file's own block
 * format on the device, and a token's embedding is one row read when it is
 * needed. The architecture is ZIPP Python (a plugin from vendor/zipp-models/
 * chosen by the file's `general.architecture`), compiled by the same engine
 * that runs apps' logic, which emits a Graph v2 program; ZIPP's compute
 * runtime runs that program on WebGPU, WebGL2, compiled WebAssembly kernels or
 * plain JavaScript, whichever this device has.
 *
 * Two prepared programs share the work. One reads a token at a time and keeps
 * the keys and values on the device between calls, so a conversation that
 * grows by a message only reads the new message. The other reads a long prompt
 * in chunks, where each weight is read once for many tokens; it is prepared
 * for that prompt and let go after, handing its caches to the first.
 *
 * Nothing here touches the page: a Worker owns the instance
 * (model-worker.ts), so a long generation never holds the app's thread, and
 * terminating the Worker is a hard stop.
 */
import { zippCompute, zippModels, type ComputeRuntime, type ComputeSession, type DecodePlan, type GgufModule, type GgufTokenizer, type ModelLimits, type WeightStore } from './zipp-vendor';
import { chatPrompt, stopTokens, supportsChat, visibleText, type ChatMessage } from './chat-template';

/** GGUF's token types that a tokenizer matches inside text: control (3) and user-defined (4). */
const MATCHED_TYPES = new Set([3, 4]);

/**
 * The text of every token the tokenizer would match inside a message, which
 * the prompt keeps messages from spelling (chat-template.ts, encodePlain).
 * Read from the file's own token types; the loader's index does not pass them
 * on, so the header it already measured is parsed once more for them. A file
 * without them is answered by its vocabulary: every entry shaped like a marker.
 */
async function matchedPieces(gguf: GgufModule, blob: Blob, headerBytes: number, tokenizer: GgufTokenizer): Promise<string[]> {
  const pieces: string[] = [];
  let types: Float64Array | null = null;
  try {
    const header = new gguf.GgufHeader(new Uint8Array(await blob.slice(0, headerBytes).arrayBuffer()));
    try { types = header.numbers('tokenizer.ggml.token_type'); } finally { header.free(); }
  } catch {
    types = null;
  }
  for (let id = 0; id < tokenizer.vocab_size; id++) {
    if (types ? !MATCHED_TYPES.has(types[id]) : false) continue;
    const piece = tokenizer.token(id);
    if (!piece) continue;
    if (types || /^<[^\s<>]{1,40}>$/.test(piece)) pieces.push(piece);
  }
  return pieces;
}

/** What the runner needs of a ZIPP engine: the Python-enabled build SoftN ships. */
export interface ZippEngine {
  setSyncHostCapabilities(operations: unknown): void;
  setInstructionBudget(budget: number): void;
  initPythonProject(files: unknown, entry: string, argv: unknown): unknown;
  pythonCall(name: string, args: unknown): unknown;
  renewInstructionBudget(): boolean;
  dispose(): void;
}

export type ModelBackend = 'auto' | 'webgpu' | 'webgl2' | 'wasm' | 'cpu-js';

export interface RunnerDeps {
  /** A fresh engine, already initialised. */
  engine(): ZippEngine;
  /** gguf-wasm's module, initialised. */
  gguf: GgufModule;
  /** The compute runtime's compiled kernels. */
  kernels: { wasmBytes?: BufferSource; wasmUrl?: string | URL };
  /** Each architecture plugin's files (plugin.json and its Python), by the GGUF `general.architecture` it runs. */
  plugins: Readonly<Record<string, ReadonlyMap<string, Uint8Array>>>;
}

export interface OpenOptions {
  backend?: ModelBackend;
  /** Positions the key/value caches hold: the longest conversation plus reply. */
  context?: number;
  progress?: (phase: string) => void;
  /** The longest new stretch of a prompt read a token at a time; past it, the prompt is read in chunks. */
  stepPrefillMax?: number;
  /** The compute runtime's allocation budget, in bytes (3 GiB unless a host holds less). */
  budgetBytes?: number;
}

export interface GenerateOptions {
  maxNewTokens?: number;
  /** 0 is greedy. */
  temperature?: number;
  topK?: number;
  topP?: number;
  repetitionPenalty?: number;
  thinking?: boolean;
  seed?: number;
}

export interface GenerateHooks {
  /** Polled between tokens. */
  cancelled?: () => boolean;
  /** The reply so far, reasoning removed. */
  onText?: (text: string) => void;
}

export interface GenerateResult {
  text: string;
  finishReason: 'stop' | 'length' | 'context' | 'cancelled';
  promptTokens: number;
  reusedTokens: number;
  generatedTokens: number;
  msPerToken: number;
  backend: string;
}

export interface ModelInfo {
  architecture: string;
  family: string;
  name: string;
  context: number;
  vocabSize: number;
  backend: string;
  residentMB: number;
  plugin: { id: string; version: string };
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** The most a host opens: positions in the caches, and tokens in one reply. */
export const MAX_CONTEXT = 4096;
export const MAX_NEW_TOKENS = 2048;
const DEFAULT_CONTEXT = 2048;
/** Tokens a chunk reads at once, and the longest new stretch read a token at a time instead. */
const CHUNK = 16;
const STEP_PREFILL_MAX = 48;

/** The loader's limits, sized for a model a page can hold (ZIPP's lab uses the same). */
function loaderLimits(context: number): ModelLimits {
  return zippModels.resolveLimits({
    maxModelFileBytes: 16 * GB, maxModelBytes: 16 * GB, maxDecodedBytes: 2 * GB,
    maxBoundInputBytes: 2 * GB, maxTensorElements: 2 ** 31, maxDimension: 1 << 21,
    maxTensors: 4096, maxNodes: 8192, maxContext: context,
  });
}

/** The compute runtime's limits. Every carried cache counts as an output, which is why those are far past the defaults. */
const COMPUTE_LIMITS = {
  maxNodes: 8192, maxElements: 4194304, maxInputElements: 300_000_000,
  maxOutputElements: 300_000_000, maxLogicalBytes: 3 * GB, maxWork: 200_000_000_000,
  maxDimension: 1 << 21, maxSessions: 4, maxStepsPerRun: 64, maxWebGLTextureBytes: 2 * GB,
};

/** The least context a model is opened with when the budget refuses more. */
const MIN_CONTEXT = 256;

/** Whether the compute runtime refused a program for its size, which a smaller one may not be. */
function overBudget(error: unknown): boolean {
  const failure = error as { code?: unknown; message?: unknown } | null;
  return failure?.code === 'LIMIT' && /budget/i.test(String(failure.message ?? ''));
}

const clampInt = (value: unknown, low: number, high: number, fallback: number): number => {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(high, Math.max(low, n));
};

export class ZippModelRunner {
  #cached: number[] = [];
  #seed: Record<string, unknown> | null = null;
  #busy = false;
  #closed = false;
  /** The compute runtime refused the chunk program once; prompts are read a token at a time from then on. */
  #chunkRefused = false;

  private constructor(
    private readonly engine: ZippEngine,
    private readonly tokenizer: GgufTokenizer,
    private readonly store: WeightStore,
    private readonly runtime: ComputeRuntime,
    private readonly stepPlan: DecodePlan,
    private readonly stepSession: ComputeSession,
    private readonly config: unknown,
    private readonly stepPrefillMax: number,
    private readonly specials: readonly string[],
    readonly info: ModelInfo,
  ) {}

  static async open(blob: Blob, deps: RunnerDeps, options: OpenOptions = {}): Promise<ZippModelRunner> {
    const progress = options.progress ?? (() => {});
    const requested = clampInt(options.context, 64, MAX_CONTEXT, DEFAULT_CONTEXT);
    const limits = loaderLimits(requested);
    progress('reading');
    const source = new zippModels.FileMapSource(new Map([['model.gguf', blob]]), { maxTotalBytes: 16 * GB });
    const index = await zippModels.openGGUF(source, 'model.gguf', deps.gguf, limits);
    const metadata = index.metadata();
    const architecture = String(metadata['general.architecture'] ?? '');
    const pluginFiles = deps.plugins[architecture];
    if (!pluginFiles) {
      throw new Error(`This checkpoint is a ${architecture || 'model of no named'} architecture, which SoftN has no ZIPP plugin for (it runs ${Object.keys(deps.plugins).join(', ')})`);
    }
    // The plugin projects to logits through the tied token embedding. A
    // checkpoint with its own output matrix would run through the tied path and
    // give plausible-looking wrong answers, so it is refused instead.
    if (index.tensors.has('output.weight')) {
      throw new Error('This checkpoint has a separate output matrix; the plugin runs tied embeddings only');
    }
    const plugin = await new zippModels.PluginRegistry().install(new zippModels.FileMapSource(new Map(pluginFiles)), { approve: () => true });

    progress('compiling');
    const engine = deps.engine();
    let store: WeightStore | null = null;
    let runtime: ComputeRuntime | null = null;
    try {
      engine.setSyncHostCapabilities([]);
      engine.setInstructionBudget(limits.instructionBudget);
      engine.initPythonProject({ ...plugin.files }, plugin.entry, []);
      const call = (name: string, args: unknown[]): unknown => {
        engine.renewInstructionBudget();
        return JSON.parse(String(engine.pythonCall(name, args)));
      };
      const tokenizer = index.tokenizer();
      const specials = await matchedPieces(deps.gguf, blob, index.headerBytes, tokenizer);
      const config = call('zipp_model_config', [JSON.stringify(metadata), JSON.stringify(tokenizer.vocab_size)]);
      const described = call('zipp_model_describe', [JSON.stringify(config)]) as { family: string; vocab_size: number; max_context: number };
      if (!supportsChat(described.family)) throw new Error(`The ${described.family} family has no chat format here`);
      const layers = (config as { num_layers: number }).num_layers;
      store = new zippModels.WeightStore([index], limits);
      const weights = store;
      const backend = options.backend ?? 'auto';
      const computeLimits = options.budgetBytes ? { ...COMPUTE_LIMITS, maxLogicalBytes: Math.floor(options.budgetBytes) } : COMPUTE_LIMITS;

      /** The one-token program for `context` positions, prepared on the backend asked for or, chosen by us, the CPU kernels. */
      const prepareAt = async (context: number) => {
        progress('binding');
        const plan = await zippModels.prepareDecode(
          call('zipp_model_decode_stage', [JSON.stringify(config), JSON.stringify(context), '0', JSON.stringify(layers - 1), 'null', '1']),
          weights, loaderLimits(context));
        progress('preparing');
        const attempt = async (on: ModelBackend) => {
          const made = await zippCompute.createRuntime({ backend: on, limits: computeLimits, ...deps.kernels });
          try {
            return { plan, runtime: made, session: await made.prepare(plan.program, { typedOutputs: true }) };
          } catch (error) {
            made.dispose();
            throw error;
          }
        };
        try {
          return await attempt(backend);
        } catch (error) {
          // A GPU that offers an adapter can still refuse the program (memory,
          // a lost device). Chosen by us, the device falls back to the CPU
          // kernels; asked for by name, the failure is the answer. A program
          // past the budget is past it on every backend.
          if (backend !== 'auto' || overBudget(error)) throw error;
          return attempt('wasm');
        }
      };

      // A context the compute runtime's budget refuses is halved until one
      // fits: the key/value caches and their working copies grow with it, so
      // a model's own ceiling is no promise this device can hold that much.
      let context = Math.min(requested, described.max_context);
      let prepared: { plan: DecodePlan; runtime: ComputeRuntime; session: ComputeSession };
      for (;;) {
        try {
          prepared = await prepareAt(context);
          break;
        } catch (error) {
          if (!overBudget(error) || context <= MIN_CONTEXT) throw error;
          context = Math.max(MIN_CONTEXT, context >> 1);
        }
      }
      runtime = prepared.runtime;
      const stepPlan = prepared.plan;
      const info: ModelInfo = {
        architecture,
        family: described.family,
        name: String(metadata['general.name'] ?? architecture),
        context,
        vocabSize: described.vocab_size,
        backend: runtime.info().backend,
        residentMB: Math.round(runtime.residentBytes() / MB),
        plugin: { id: plugin.identity.id, version: plugin.identity.version },
      };
      progress('ready');
      return new ZippModelRunner(engine, tokenizer, store, runtime, stepPlan, prepared.session, config,
        clampInt(options.stepPrefillMax, 0, MAX_CONTEXT, STEP_PREFILL_MAX), specials, info);
    } catch (error) {
      try { runtime?.dispose(); } catch { /* already failing */ }
      try { store?.dispose(); } catch { /* already failing */ }
      try { engine.dispose(); } catch { /* already failing */ }
      throw error;
    }
  }

  /** The prompt's ids for these messages, oldest turns dropped until it fits beside room for the reply. */
  prompt(messages: readonly ChatMessage[], options: GenerateOptions = {}): number[] {
    const room = Math.min(clampInt(options.maxNewTokens, 1, MAX_NEW_TOKENS, 256), Math.floor(this.info.context / 2));
    let list = [...messages];
    for (;;) {
      const ids = chatPrompt(this.info.family, list, this.tokenizer, { thinking: options.thinking === true, specials: this.specials });
      if (ids.length + room <= this.info.context) return ids;
      // Keep a leading system message and the latest turn; drop the oldest of the rest.
      const first = list[0]?.role === 'system' ? 1 : 0;
      if (list.length - first <= 1) {
        throw new Error(`The message is ${ids.length} tokens; this model was opened with room for ${this.info.context}, reply included`);
      }
      list = [...list.slice(0, first), ...list.slice(first + 1)];
    }
  }

  async generate(messages: readonly ChatMessage[], options: GenerateOptions = {}, hooks: GenerateHooks = {}): Promise<GenerateResult> {
    if (this.#closed) throw new Error('The model was released');
    if (this.#busy) throw new Error('The model is still answering the previous message');
    this.#busy = true;
    try {
      return await this.#generate(messages, options, hooks);
    } catch (error) {
      // What the caches hold is unknown after a failed step, so nothing in
      // them is trusted again: the next prompt is read from its first token.
      this.#cached = [];
      this.#seed = null;
      throw error;
    } finally {
      this.#busy = false;
    }
  }

  async #step(token: number, position: number, readback: boolean): Promise<Float32Array | null> {
    const step = await zippModels.stepInputs(this.stepPlan, this.store, { position, token });
    if (this.#seed) {
      // The chunked prompt's caches, fed in once and carried from there as
      // though this program had written them.
      Object.assign(step.inputs, this.#seed);
      this.#seed = null;
    }
    const out = await this.stepSession.run([step], { readback: readback ? ['logits'] : [] });
    return readback ? out.outputs.logits.data : null;
  }

  /** The prompt a chunk at a time, in a program prepared for it and let go after; its caches seed the step program. */
  async #chunked(prompt: number[]): Promise<Float32Array> {
    const limits = loaderLimits(this.info.context);
    this.engine.renewInstructionBudget();
    const layers = (this.config as { num_layers: number }).num_layers;
    const template = JSON.parse(String(this.engine.pythonCall('zipp_model_decode_stage',
      [JSON.stringify(this.config), JSON.stringify(this.info.context), '0', JSON.stringify(layers - 1), 'null', JSON.stringify(CHUNK)])));
    const plan = await zippModels.prepareDecode(template, this.store, limits);
    const session = await this.runtime.prepare(plan.program, { resident: plan.resident, typedOutputs: true });
    try {
      let logits: Float32Array | null = null;
      for (let position = 0; position < prompt.length; position += CHUNK) {
        const tokens = prompt.slice(position, position + CHUNK);
        const step = await zippModels.stepInputs(plan, this.store, { position, tokens, count: tokens.length });
        const last = position + CHUNK >= prompt.length;
        logits = (await session.run([step], { readback: last ? ['logits'] : [] })).outputs.logits?.data ?? null;
      }
      const caches = await session.download(plan.resident);
      const seed: Record<string, unknown> = {};
      for (const node of this.stepPlan.program.nodes) {
        if (node.carry !== undefined) seed[node.id] = caches.outputs[node.carry].data;
      }
      this.#seed = seed;
      if (!logits) throw new Error('The prompt produced no logits');
      return logits;
    } finally {
      session.dispose();
    }
  }

  async #generate(messages: readonly ChatMessage[], options: GenerateOptions, hooks: GenerateHooks): Promise<GenerateResult> {
    const prompt = this.prompt(messages, options);
    const maxNewTokens = clampInt(options.maxNewTokens, 1, MAX_NEW_TOKENS, 256);
    const temperature = typeof options.temperature === 'number' && Number.isFinite(options.temperature) ? Math.min(Math.max(options.temperature, 0), 2) : 0.7;
    const sample = {
      temperature,
      topK: clampInt(options.topK, 0, this.info.vocabSize, 20),
      topP: typeof options.topP === 'number' && options.topP > 0 && options.topP <= 1 ? options.topP : 0.8,
      repetitionPenalty: typeof options.repetitionPenalty === 'number' && options.repetitionPenalty >= 1 && options.repetitionPenalty <= 4 ? options.repetitionPenalty : 1.05,
      random: zippModels.seededRandom(clampInt(options.seed, 0, 0xffffffff, Math.floor(Math.random() * 0xffffffff))),
    };

    // The caches already hold every position up to where this prompt first
    // differs from what they were written with; at least the last prompt token
    // is read again, for its logits. Positions past that are stale and are
    // written before anything can attend to them.
    let shared = 0;
    const limit = Math.min(this.#cached.length, prompt.length - 1);
    while (shared < limit && this.#cached[shared] === prompt[shared]) shared++;
    let logits: Float32Array | null = null;
    let written = shared;
    let chunked = false;
    if (prompt.length - shared > this.stepPrefillMax && !this.#chunkRefused) {
      try {
        logits = await this.#chunked(prompt);
        shared = 0;
        written = prompt.length;
        chunked = true;
      } catch (error) {
        // A chunk program past the compute budget: the prompt is read a token
        // at a time instead, slower and the same. Not asked again.
        if (!overBudget(error)) throw error;
        this.#chunkRefused = true;
      }
    }
    if (!chunked) {
      for (let position = shared; position < prompt.length && !hooks.cancelled?.(); position++) {
        logits = await this.#step(prompt[position], position, position === prompt.length - 1);
        written = position + 1;
      }
    }
    // The ids whose keys and values the step program's caches now hold.
    const fed = prompt.slice(0, written);
    this.#cached = fed;

    const stops = stopTokens(this.tokenizer);
    const generated: number[] = [];
    const times: number[] = [];
    let finishReason: GenerateResult['finishReason'] = written < prompt.length ? 'cancelled' : 'length';
    let text = '';
    while (logits && written === prompt.length) {
      if (hooks.cancelled?.()) { finishReason = 'cancelled'; break; }
      const next = zippModels.sampleLogits(logits, { ...sample, recent: [...prompt, ...generated].slice(-64) });
      if (stops.has(next)) { finishReason = 'stop'; break; }
      generated.push(next);
      text = this.tokenizer.decode(Uint32Array.from(generated));
      hooks.onText?.(visibleText(text));
      if (generated.length >= maxNewTokens) { finishReason = 'length'; break; }
      const position = prompt.length + generated.length - 1;
      if (position >= this.info.context) { finishReason = 'context'; break; }
      const began = performance.now();
      logits = await this.#step(next, position, true);
      times.push(performance.now() - began);
      fed.push(next);
    }
    times.sort((a, b) => a - b);
    return {
      text: visibleText(text),
      finishReason,
      promptTokens: prompt.length,
      reusedTokens: shared,
      generatedTokens: generated.length,
      msPerToken: times.length ? Math.round(times[times.length >> 1]) : 0,
      backend: this.info.backend,
    };
  }

  dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    try { this.stepSession.dispose(); } catch { /* closing */ }
    try { this.runtime.dispose(); } catch { /* closing */ }
    try { this.store.dispose(); } catch { /* closing */ }
    try { this.engine.dispose(); } catch { /* closing */ }
  }
}
