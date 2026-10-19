/**
 * ZIPP's model stack, vendored as plain JavaScript (vendor/zipp-models/), with
 * the types this runtime relies on. Only the model worker and its tests import
 * this file; no chunk of the app's own runtime reaches it.
 */
// @ts-expect-error -- vendored JavaScript; its shape is declared below
import * as modelPlugins from '../../../vendor/zipp-models/model-plugins/src/index.mjs';
// @ts-expect-error -- vendored JavaScript; its shape is declared below
import * as gpuLab from '../../../vendor/zipp-models/gpu-lab/src/runtime.mjs';

export interface ModelLimits {
  readonly instructionBudget: number;
  readonly maxContext: number;
  readonly [name: string]: number;
}

export interface GgufTokenizer {
  encode(text: string): Uint32Array;
  decode(ids: Uint32Array): string;
  id_of(piece: string): number | undefined;
  token(id: number): string | undefined;
  readonly eos: number | undefined;
  readonly bos: number | undefined;
  readonly vocab_size: number;
  readonly pre: string;
}

/** gguf-wasm's own reader, for what the loader's index does not pass on. */
export interface GgufModule {
  GgufHeader: new (bytes: Uint8Array) => { numbers(key: string): Float64Array; free(): void };
}

export interface GgufIndex {
  /** How much of the file the header took to parse. */
  readonly headerBytes: number;
  readonly tensors: Map<string, { dtype: string; shape: readonly number[]; bytes: number }>;
  metadata(): Record<string, unknown>;
  tokenizer(): GgufTokenizer;
}

export interface WeightStore {
  dispose(): void;
}

export interface GraphProgram {
  nodes: Array<{ id: string; op: string; carry?: string; data?: unknown; dtype?: string }>;
}

export interface DecodePlan {
  program: GraphProgram;
  resident: string[];
  context: number;
  tokens: number;
}

export interface StepInput {
  inputs: Record<string, unknown>;
}

export interface TensorOutput {
  shape: number[];
  data: Float32Array;
}

export interface ComputeSession {
  run(steps: StepInput[], options: { readback: string[] }): Promise<{ outputs: Record<string, TensorOutput> }>;
  download(names: string[]): Promise<{ outputs: Record<string, TensorOutput> }>;
  dispose(): void;
}

export interface ComputeRuntime {
  prepare(program: GraphProgram, options?: { resident?: string[]; typedOutputs?: boolean }): Promise<ComputeSession>;
  info(): { backend: string; [key: string]: unknown };
  residentBytes(): number;
  dispose(): void;
}

export interface InstalledPlugin {
  readonly identity: { id: string; version: string; sha256: string };
  readonly files: Record<string, string>;
  readonly entry: string;
}

export interface FileSource {
  size(path: string): number;
  read(path: string, offset: number, length: number): Promise<Uint8Array>;
}

export interface SampleOptions {
  temperature?: number;
  topK?: number;
  topP?: number;
  repetitionPenalty?: number;
  recent?: number[] | null;
  random?: () => number;
}

interface ModelPlugins {
  FileMapSource: new (entries: Map<string, Blob | Uint8Array>, options?: { maxEntries?: number; maxTotalBytes?: number }) => FileSource;
  PluginRegistry: new (limits?: Record<string, number>) => {
    install(source: FileSource, options: { approve: (identity: unknown) => boolean | Promise<boolean>; expectedHash?: string }): Promise<InstalledPlugin>;
  };
  openGGUF(source: FileSource, path: string, wasm: unknown, limits: ModelLimits): Promise<GgufIndex>;
  WeightStore: new (indexes: GgufIndex[], limits: ModelLimits) => WeightStore;
  prepareDecode(template: unknown, store: WeightStore, limits: ModelLimits): Promise<DecodePlan>;
  stepInputs(plan: DecodePlan, store: WeightStore, step: { position: number; token?: number; tokens?: number[]; count?: number }): Promise<StepInput>;
  resolveLimits(overrides: Record<string, number>): ModelLimits;
  sampleLogits(logits: Float32Array, options: SampleOptions): number;
  seededRandom(seed: number): () => number;
}

interface GpuLab {
  createRuntime(options: {
    backend?: string;
    limits?: Record<string, number>;
    wasmBytes?: BufferSource;
    wasmUrl?: string | URL;
  }): Promise<ComputeRuntime>;
}

export const zippModels = modelPlugins as ModelPlugins;
export const zippCompute = gpuLab as GpuLab;
