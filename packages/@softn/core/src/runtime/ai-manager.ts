/**
 * SoftN AI — the permission shapes and the capability report behind softn.ai.*.
 *
 * Local language models run on ZIPP (models/model-host.ts); raw compute
 * shaders on WebGPU (ai-gpu-compute-manager.ts).
 */

/** What this device can run, as an app with `ai` may ask. */
export interface AICapabilities {
  webgpu: boolean;
  webgl: boolean;
  wasm: boolean;
  gpuCompute: boolean;
  maxModelSizeMB: number;
  /** What softn.ai.model.load reads, and the architectures it has ZIPP plugins for. */
  models: { format: 'gguf'; architectures: string[]; quantizations: string[] };
}

/** GPU compute permission configuration (from permission.json) */
export interface GpuPermissionConfig {
  enabled?: boolean;
  maxBufferMemoryMB?: number;
  allowedShaderSources?: Array<'bundle' | 'inline'>;
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

/** Whether this page can draw with WebGL, once asked: it does not change while the page lives. */
let webglAvailable: boolean | undefined;

/**
 * Whether WebGL is there, asked of one canvas once a page and its context let
 * go at once. A context was made at every `softn.ai.getCapabilities` and kept:
 * a browser keeps some sixteen live at once and, past that, takes the oldest
 * from the page that made it, which can be a scene the app is drawing.
 */
function hasWebGL(): boolean {
  if (webglAvailable !== undefined) return webglAvailable;
  if (typeof document === 'undefined') return false;
  let found = false;
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2') || canvas.getContext('webgl')) as WebGLRenderingContext | null;
    found = !!gl;
    try {
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      /* Let go with the canvas, then. */
    }
  } catch {
    /* WebGL not available */
  }
  webglAvailable = found;
  return found;
}

/**
 * Detect AI runtime capabilities.
 * Checks for WebGPU, WebGL, and WASM availability.
 */
export async function detectCapabilities(): Promise<AICapabilities> {
  let webgpu = false;
  const wasm = typeof WebAssembly !== 'undefined';

  // Check WebGPU
  if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
    try {
      const adapter = await (navigator as unknown as { gpu: { requestAdapter(): Promise<unknown | null> } }).gpu.requestAdapter();
      webgpu = adapter != null;
    } catch { /* WebGPU not available */ }
  }

  // Check WebGL
  const webgl = hasWebGL();

  // Estimate max model size based on device memory
  let maxModelSizeMB = 256; // conservative default
  if (typeof navigator !== 'undefined' && 'deviceMemory' in navigator) {
    const deviceMemGB = (navigator as unknown as { deviceMemory: number }).deviceMemory;
    // Use ~25% of device memory for models
    maxModelSizeMB = Math.floor(deviceMemGB * 1024 * 0.25);
  }

  // The worker's plugins (models/model-worker.ts) and the block formats
  // ZIPP's compute runtime keeps resident; others decode to float32.
  const models = { format: 'gguf' as const, architectures: ['qwen3'], quantizations: ['Q4_K', 'Q6_K'] };
  return { webgpu, webgl, wasm, gpuCompute: webgpu, maxModelSizeMB, models };
}
