/**
 * SoftN AI Manager — shared types and interfaces
 *
 * Used by OnnxManager and TransformersManager for the softn.ai.* bridge.
 */

/** GPU/runtime capabilities detected at runtime */
export interface AICapabilities {
  webgpu: boolean;
  webgl: boolean;
  wasm: boolean;
  gpuCompute: boolean;
  maxModelSizeMB: number;
}

/** GPU compute permission configuration (from permission.json) */
export interface GpuPermissionConfig {
  enabled?: boolean;
  maxBufferMemoryMB?: number;
  allowedShaderSources?: Array<'bundle' | 'inline'>;
}

/** Where to load a model from */
export interface ModelSource {
  /** File path within the .softn bundle */
  bundle?: string;
  /** HuggingFace model ID (e.g. "Xenova/distilgpt2") */
  huggingface?: string;
  /** Direct URL to an ONNX model file */
  url?: string;
}

/** Options for loading an ONNX model */
export interface OnnxLoadOptions {
  /** Execution provider preference order (default: ['webgpu', 'webgl', 'wasm']) */
  executionProviders?: string[];
  /** Max model size in MB (enforced by permission system) */
  maxSizeMB?: number;
}

/** Tensor descriptor for ONNX model input/output */
export interface TensorDescriptor {
  /** Tensor data (flat array of numbers or bigints) */
  data: number[] | BigInt64Array | Float32Array;
  /** Data type (e.g. "float32", "int64", "uint8") */
  type: string;
  /** Shape dimensions */
  dims: number[];
}

/** ONNX inference feeds — map of input name to tensor */
export type OnnxFeeds = Record<string, TensorDescriptor>;

/** ONNX inference result — map of output name to tensor */
export type OnnxResult = Record<string, TensorDescriptor>;

/** ONNX run options */
export interface OnnxRunOptions {
  /** Output names to request (default: all) */
  outputNames?: string[];
}

/** Supported Transformers.js pipeline tasks */
export type PipelineTask =
  | 'text-generation'
  | 'text2text-generation'
  | 'summarization'
  | 'translation'
  | 'fill-mask'
  | 'question-answering'
  | 'sentiment-analysis'
  | 'text-classification'
  | 'zero-shot-classification'
  | 'token-classification'
  | 'feature-extraction'
  | 'automatic-speech-recognition'
  | 'image-to-text'
  | 'image-classification'
  | 'object-detection'
  | 'image-segmentation';

/** Options for creating a Transformers.js pipeline */
export interface PipelineOptions {
  /** Device preference: 'webgpu', 'wasm', or 'auto' (default: 'auto') */
  device?: 'webgpu' | 'wasm' | 'auto';
  /** Data type: 'fp32', 'fp16', 'q8', 'q4' */
  dtype?: string;
  /** Revision/branch of the model (default: 'main') */
  revision?: string;
}

/** Options for text generation */
export interface GenerateOptions {
  max_new_tokens?: number;
  temperature?: number;
  top_k?: number;
  top_p?: number;
  do_sample?: boolean;
  repetition_penalty?: number;
  presence_penalty?: number;
}

/** Options for loading a model directly via from_pretrained (not pipeline) */
export interface DirectModelOptions {
  /** Device preference: 'webgpu', 'wasm', or 'auto' (default: 'auto') */
  device?: 'webgpu' | 'wasm' | 'auto';
  /** Per-component dtype config, e.g. { embed_tokens: "q4", decoder_model_merged: "q4" } */
  dtype?: string | Record<string, string>;
  /** Revision/branch of the model (default: 'main') */
  revision?: string;
}

/** Chat message for conversational models */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: string; text?: string; image?: string }>;
}

/** Provider for reading files from a .softn bundle */
export interface BundleFileProvider {
  /** Read a file from the bundle as an ArrayBuffer */
  readFile(path: string): Promise<ArrayBuffer | null>;
  /** Check if a file exists in the bundle */
  hasFile(path: string): Promise<boolean>;
}

/** AI permission configuration (from permission.json) */
export interface AIPermissionConfig {
  enabled?: boolean;
  maxModelSizeMB?: number;
  allowedSources?: Array<'bundle' | 'huggingface' | 'url'>;
}

/**
 * Detect AI runtime capabilities.
 * Checks for WebGPU, WebGL, and WASM availability.
 */
export async function detectCapabilities(): Promise<AICapabilities> {
  let webgpu = false;
  let webgl = false;
  const wasm = typeof WebAssembly !== 'undefined';

  // Check WebGPU
  if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
    try {
      const adapter = await (navigator as unknown as { gpu: { requestAdapter(): Promise<unknown | null> } }).gpu.requestAdapter();
      webgpu = adapter != null;
    } catch { /* WebGPU not available */ }
  }

  // Check WebGL
  if (typeof document !== 'undefined') {
    try {
      const canvas = document.createElement('canvas');
      webgl = !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
    } catch { /* WebGL not available */ }
  }

  // Estimate max model size based on device memory
  let maxModelSizeMB = 256; // conservative default
  if (typeof navigator !== 'undefined' && 'deviceMemory' in navigator) {
    const deviceMemGB = (navigator as unknown as { deviceMemory: number }).deviceMemory;
    // Use ~25% of device memory for models
    maxModelSizeMB = Math.floor(deviceMemGB * 1024 * 0.25);
  }

  return { webgpu, webgl, wasm, gpuCompute: webgpu, maxModelSizeMB };
}
