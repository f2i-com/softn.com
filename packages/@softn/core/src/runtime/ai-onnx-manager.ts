/**
 * SoftN ONNX Manager — lazy-loaded onnxruntime-web integration
 *
 * Provides session lifecycle, execution provider negotiation,
 * bundle/URL/HuggingFace model resolution, and memory guards.
 * Zero cost for apps that don't use AI — the library is loaded on first use.
 */

import type {
  ModelSource,
  OnnxLoadOptions,
  OnnxFeeds,
  OnnxResult,
  OnnxRunOptions,
  TensorDescriptor,
  BundleFileProvider,
  AIPermissionConfig,
} from './ai-manager';

/** onnxruntime-web types (subset we use) */
interface OrtModule {
  InferenceSession: {
    create(
      model: ArrayBuffer | string,
      options?: { executionProviders?: string[] }
    ): Promise<OrtSession>;
  };
  Tensor: new (type: string, data: unknown, dims: number[]) => OrtTensor;
  env: {
    wasm: { wasmPaths?: string };
  };
}

interface OrtSession {
  run(feeds: Record<string, OrtTensor>, options?: { outputNames?: string[] }): Promise<Record<string, OrtTensor>>;
  release(): Promise<void>;
  inputNames: string[];
  outputNames: string[];
}

interface OrtTensor {
  data: Float32Array | Int32Array | BigInt64Array | Uint8Array;
  type: string;
  dims: readonly number[];
  dispose(): void;
}

interface SessionEntry {
  session: OrtSession;
  createdAt: number;
  modelSource: string;
}

const MAX_CONCURRENT_SESSIONS = 3;

export class OnnxManager {
  private ort: OrtModule | null = null;
  private sessions = new Map<string, SessionEntry>();
  private nextSessionId = 1;
  private bundleFileProvider: BundleFileProvider | null = null;
  private permissionConfig: AIPermissionConfig | null = null;

  setBundleFileProvider(provider: BundleFileProvider): void {
    this.bundleFileProvider = provider;
  }

  setPermissionConfig(config: AIPermissionConfig): void {
    this.permissionConfig = config;
  }

  /** Lazy-load onnxruntime-web */
  private async getOrt(): Promise<OrtModule> {
    if (this.ort) return this.ort;
    try {
      this.ort = await import('onnxruntime-web') as unknown as OrtModule;
      return this.ort;
    } catch (e) {
      throw new Error(
        'onnxruntime-web is not installed. Add it to your app dependencies to use softn.ai.onnx.*'
      );
    }
  }

  /** Negotiate the best execution provider */
  private async negotiateEP(preferred?: string[]): Promise<string[]> {
    const chain = preferred || ['webgpu', 'webgl', 'wasm'];
    const available: string[] = [];

    for (const ep of chain) {
      if (ep === 'wasm') {
        if (typeof WebAssembly !== 'undefined') available.push('wasm');
      } else if (ep === 'webgl') {
        try {
          const canvas = document.createElement('canvas');
          if (canvas.getContext('webgl2') || canvas.getContext('webgl')) {
            available.push('webgl');
          }
        } catch { /* skip */ }
      } else if (ep === 'webgpu') {
        if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
          try {
            const gpu = (navigator as unknown as { gpu: { requestAdapter(): Promise<unknown | null> } }).gpu;
            const adapter = await gpu.requestAdapter();
            if (adapter) available.push('webgpu');
          } catch { /* skip */ }
        }
      }
    }

    // Always fall back to wasm if nothing else works
    if (available.length === 0) available.push('wasm');
    return available;
  }

  /** Resolve a ModelSource to an ArrayBuffer */
  private async resolveModel(source: ModelSource): Promise<ArrayBuffer> {
    // Permission check: which sources are allowed?
    if (this.permissionConfig?.allowedSources) {
      const allowed = this.permissionConfig.allowedSources;
      if (source.bundle && !allowed.includes('bundle')) {
        throw new Error('Bundle model loading not permitted');
      }
      if (source.huggingface && !allowed.includes('huggingface')) {
        throw new Error('HuggingFace model loading not permitted');
      }
      if (source.url && !allowed.includes('url')) {
        throw new Error('URL model loading not permitted');
      }
    }

    if (source.bundle) {
      if (!this.bundleFileProvider) {
        throw new Error('No bundle file provider — cannot load bundled model');
      }
      const data = await this.bundleFileProvider.readFile(source.bundle);
      if (!data) throw new Error(`Model not found in bundle: ${source.bundle}`);
      return data;
    }

    if (source.huggingface) {
      // Download from HuggingFace Hub with IndexedDB caching
      return this.downloadWithCache(source.huggingface);
    }

    if (source.url) {
      const resp = await fetch(source.url);
      if (!resp.ok) throw new Error(`Failed to fetch model: ${resp.status} ${resp.statusText}`);
      return resp.arrayBuffer();
    }

    throw new Error('ModelSource must specify bundle, huggingface, or url');
  }

  /** Download model from HuggingFace with IndexedDB caching */
  private async downloadWithCache(modelId: string): Promise<ArrayBuffer> {
    const cacheKey = `softn-ai-model:${modelId}`;

    // Try IndexedDB cache first
    try {
      const cached = await this.readCache(cacheKey);
      if (cached) {
        console.log(`[SoftN AI] Using cached model: ${modelId}`);
        return cached;
      }
    } catch { /* cache miss */ }

    // Download from HuggingFace
    const url = `https://huggingface.co/${modelId}/resolve/main/model.onnx`;
    console.log(`[SoftN AI] Downloading model: ${modelId}`);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to download model ${modelId}: ${resp.status}`);
    const data = await resp.arrayBuffer();

    // Size guard
    const sizeMB = data.byteLength / (1024 * 1024);
    const maxMB = this.permissionConfig?.maxModelSizeMB ?? 500;
    if (sizeMB > maxMB) {
      throw new Error(`Model size ${sizeMB.toFixed(1)}MB exceeds limit of ${maxMB}MB`);
    }

    // Cache for next time
    try {
      await this.writeCache(cacheKey, data);
    } catch { /* cache write failed — non-fatal */ }

    return data;
  }

  private async readCache(key: string): Promise<ArrayBuffer | null> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('softn-ai-cache', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('models');
      };
      req.onsuccess = () => {
        const tx = req.result.transaction('models', 'readonly');
        const store = tx.objectStore('models');
        const get = store.get(key);
        get.onsuccess = () => resolve(get.result ?? null);
        get.onerror = () => reject(get.error);
      };
      req.onerror = () => reject(req.error);
    });
  }

  private async writeCache(key: string, data: ArrayBuffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('softn-ai-cache', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('models');
      };
      req.onsuccess = () => {
        const tx = req.result.transaction('models', 'readwrite');
        const store = tx.objectStore('models');
        const put = store.put(data, key);
        put.onsuccess = () => resolve();
        put.onerror = () => reject(put.error);
      };
      req.onerror = () => reject(req.error);
    });
  }

  /** Evict the oldest session if at capacity */
  private evictIfNeeded(): void {
    if (this.sessions.size < MAX_CONCURRENT_SESSIONS) return;

    let oldestId: string | null = null;
    let oldestTime = Infinity;
    for (const [id, entry] of this.sessions) {
      if (entry.createdAt < oldestTime) {
        oldestTime = entry.createdAt;
        oldestId = id;
      }
    }

    if (oldestId) {
      console.log(`[SoftN AI] Evicting oldest ONNX session: ${oldestId}`);
      const entry = this.sessions.get(oldestId)!;
      entry.session.release().catch(() => {});
      this.sessions.delete(oldestId);
    }
  }

  /**
   * Load an ONNX model and create an inference session.
   * Returns a session ID for subsequent run/release calls.
   */
  async loadModel(source: ModelSource, options?: OnnxLoadOptions): Promise<{ sessionId: string; inputNames: string[]; outputNames: string[] }> {
    const ort = await this.getOrt();

    // Size guard before download
    const maxMB = options?.maxSizeMB ?? this.permissionConfig?.maxModelSizeMB ?? 500;

    const modelBuffer = await this.resolveModel(source);

    // Check size
    const sizeMB = modelBuffer.byteLength / (1024 * 1024);
    if (sizeMB > maxMB) {
      throw new Error(`Model size ${sizeMB.toFixed(1)}MB exceeds limit of ${maxMB}MB`);
    }

    // Evict oldest session if at capacity
    this.evictIfNeeded();

    // Negotiate execution providers
    const eps = await this.negotiateEP(options?.executionProviders);
    console.log(`[SoftN AI] Creating ONNX session with EPs: ${eps.join(', ')}`);

    const session = await ort.InferenceSession.create(modelBuffer, {
      executionProviders: eps,
    });

    const sessionId = `onnx-${this.nextSessionId++}`;
    const sourceLabel = source.bundle || source.huggingface || source.url || 'unknown';
    this.sessions.set(sessionId, {
      session,
      createdAt: Date.now(),
      modelSource: sourceLabel,
    });

    console.log(`[SoftN AI] ONNX session created: ${sessionId} (${sizeMB.toFixed(1)}MB, ${sourceLabel})`);

    return {
      sessionId,
      inputNames: session.inputNames,
      outputNames: session.outputNames,
    };
  }

  /**
   * Run inference on an existing session.
   */
  async run(sessionId: string, feeds: OnnxFeeds, options?: OnnxRunOptions): Promise<OnnxResult> {
    const ort = await this.getOrt();
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`ONNX session not found: ${sessionId}`);

    // Convert TensorDescriptor feeds to ORT tensors
    const ortFeeds: Record<string, OrtTensor> = {};
    for (const [name, desc] of Object.entries(feeds)) {
      ortFeeds[name] = new ort.Tensor(desc.type, desc.data, desc.dims);
    }

    const runOptions = options?.outputNames ? { outputNames: options.outputNames } : undefined;
    const output = await entry.session.run(ortFeeds, runOptions);

    // Convert ORT output tensors to TensorDescriptors
    const result: OnnxResult = {};
    for (const [name, tensor] of Object.entries(output)) {
      result[name] = {
        data: Array.from(tensor.data as ArrayLike<number>),
        type: tensor.type,
        dims: [...tensor.dims],
      };
      tensor.dispose();
    }

    return result;
  }

  /** Release an ONNX session */
  async release(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    await entry.session.release();
    this.sessions.delete(sessionId);
    console.log(`[SoftN AI] ONNX session released: ${sessionId}`);
  }

  /** Release all sessions */
  async releaseAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [id, entry] of this.sessions) {
      promises.push(entry.session.release().catch(() => {}));
    }
    await Promise.all(promises);
    this.sessions.clear();
    console.log('[SoftN AI] All ONNX sessions released');
  }
}
