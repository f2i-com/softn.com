/**
 * SoftN Transformers Manager — lazy-loaded @huggingface/transformers integration
 *
 * Provides high-level pipeline lifecycle for text-generation, embeddings,
 * classification, and other Transformers.js tasks.
 * Zero cost for apps that don't use AI — the library is loaded on first use.
 */

import type {
  PipelineTask,
  PipelineOptions,
  GenerateOptions,
  DirectModelOptions,
  ChatMessage,
  AIPermissionConfig,
} from './ai-manager';

/** @huggingface/transformers types (subset we use) */
interface TransformersModule {
  pipeline(
    task: string,
    model?: string,
    options?: Record<string, unknown>
  ): Promise<TransformersPipeline>;
  AutoProcessor: {
    from_pretrained(modelId: string, options?: Record<string, unknown>): Promise<TFProcessor>;
  };
  AutoTokenizer: {
    from_pretrained(modelId: string, options?: Record<string, unknown>): Promise<TFTokenizer>;
  };
  AutoModelForCausalLM: {
    from_pretrained(modelId: string, options?: Record<string, unknown>): Promise<TFModel>;
  };
  AutoModelForImageTextToText: {
    from_pretrained(modelId: string, options?: Record<string, unknown>): Promise<TFModel>;
  };
  TextStreamer: new (tokenizer: TFTokenizer, options?: Record<string, unknown>) => TFStreamer;
  env: {
    backends: {
      onnx: {
        wasm?: { wasmPaths?: string };
      };
    };
  };
  // Image support for VLMs
  RawImage: {
    fromURL(url: string): Promise<unknown>;
  };
  // Dynamic access to named model classes (e.g. Qwen3_5ForConditionalGeneration)
  [key: string]: unknown;
}

interface TransformersPipeline {
  (input: unknown, options?: Record<string, unknown>): Promise<unknown>;
  dispose?(): Promise<void>;
}

interface TFProcessor {
  apply_chat_template(messages: unknown[], options?: Record<string, unknown>): string;
  (text: string, ...args: unknown[]): Promise<Record<string, unknown>>;
  batch_decode(outputs: unknown, options?: Record<string, unknown>): string[];
  tokenizer: TFTokenizer;
}

interface TFTokenizer {
  apply_chat_template(messages: unknown[], options?: Record<string, unknown>): string;
  (text: string, options?: Record<string, unknown>): Record<string, unknown>;
  batch_decode?(outputs: unknown, options?: Record<string, unknown>): string[];
  decode?(ids: unknown, options?: Record<string, unknown>): string;
}

interface TFModel {
  generate(inputs: Record<string, unknown>): Promise<TFModelOutput>;
  dispose?(): Promise<void>;
}

interface TFModelOutput {
  [key: string]: unknown;
  slice?(start: unknown, end: unknown): unknown;
}

interface TFStreamer {
  // Callback-based streamer
}

interface PipelineEntry {
  pipeline: TransformersPipeline;
  task: PipelineTask;
  modelId: string;
  createdAt: number;
}

interface DirectModelEntry {
  model: TFModel;
  processor: TFProcessor | null;
  tokenizer: TFTokenizer;
  modelId: string;
  createdAt: number;
}

export class TransformersManager {
  private transformers: TransformersModule | null = null;
  private pipelines = new Map<string, PipelineEntry>();
  private models = new Map<string, DirectModelEntry>();
  private nextPipelineId = 1;
  private nextModelId = 1;
  private permissionConfig: AIPermissionConfig | null = null;

  setPermissionConfig(config: AIPermissionConfig): void {
    this.permissionConfig = config;
  }

  /** Lazy-load @huggingface/transformers */
  private async getTransformers(): Promise<TransformersModule> {
    if (this.transformers) return this.transformers;
    try {
      this.transformers = await import('@huggingface/transformers') as unknown as TransformersModule;
      return this.transformers;
    } catch (e) {
      throw new Error(
        '@huggingface/transformers is not installed. Add it to your app dependencies to use softn.ai.pipeline/generate/embed/classify.'
      );
    }
  }

  /** Determine the device option based on availability */
  private async resolveDevice(preferred?: 'webgpu' | 'wasm' | 'auto'): Promise<string> {
    if (preferred && preferred !== 'auto') return preferred;

    // Auto-detect: prefer WebGPU, fall back to WASM
    if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
      try {
        const gpu = (navigator as unknown as { gpu: { requestAdapter(): Promise<unknown | null> } }).gpu;
        const adapter = await gpu.requestAdapter();
        if (adapter) return 'webgpu';
      } catch { /* fall through */ }
    }
    return 'wasm';
  }

  /**
   * Create a Transformers.js pipeline.
   * Returns a pipeline ID for subsequent generate/embed/classify/run calls.
   */
  async createPipeline(
    task: PipelineTask,
    model?: string,
    options?: PipelineOptions
  ): Promise<{ pipelineId: string; task: PipelineTask; model: string }> {
    const tf = await this.getTransformers();

    // Check source permission
    if (this.permissionConfig?.allowedSources) {
      if (!this.permissionConfig.allowedSources.includes('huggingface')) {
        throw new Error('HuggingFace model loading not permitted');
      }
    }

    const device = await this.resolveDevice(options?.device);
    const modelId = model || this.getDefaultModel(task);

    console.log(`[SoftN AI] Creating pipeline: ${task} with ${modelId} on ${device}`);

    const pipelineOpts: Record<string, unknown> = { device };
    if (options?.dtype) pipelineOpts.dtype = options.dtype;
    if (options?.revision) pipelineOpts.revision = options.revision;

    const pipeline = await tf.pipeline(task, modelId, pipelineOpts);

    const pipelineId = `tf-${this.nextPipelineId++}`;
    this.pipelines.set(pipelineId, {
      pipeline,
      task,
      modelId,
      createdAt: Date.now(),
    });

    console.log(`[SoftN AI] Pipeline created: ${pipelineId} (${task}, ${modelId})`);

    return { pipelineId, task, model: modelId };
  }

  /** Get a sensible default model for each task */
  private getDefaultModel(task: PipelineTask): string {
    const defaults: Record<string, string> = {
      'text-generation': 'Xenova/distilgpt2',
      'text2text-generation': 'Xenova/flan-t5-small',
      'summarization': 'Xenova/distilbart-cnn-6-6',
      'translation': 'Xenova/nllb-200-distilled-600M',
      'fill-mask': 'Xenova/bert-base-uncased',
      'question-answering': 'Xenova/distilbert-base-uncased-distilled-squad',
      'sentiment-analysis': 'Xenova/distilbert-base-uncased-finetuned-sst-2-english',
      'text-classification': 'Xenova/distilbert-base-uncased-finetuned-sst-2-english',
      'zero-shot-classification': 'Xenova/nli-deberta-v3-xsmall',
      'token-classification': 'Xenova/bert-base-NER',
      'feature-extraction': 'Xenova/all-MiniLM-L6-v2',
      'automatic-speech-recognition': 'Xenova/whisper-tiny.en',
      'image-to-text': 'Xenova/vit-gpt2-image-captioning',
      'image-classification': 'Xenova/vit-base-patch16-224',
      'object-detection': 'Xenova/detr-resnet-50',
      'image-segmentation': 'Xenova/detr-resnet-50-panoptic',
    };
    return defaults[task] || task;
  }

  private getEntry(pipelineId: string): PipelineEntry {
    const entry = this.pipelines.get(pipelineId);
    if (!entry) throw new Error(`Pipeline not found: ${pipelineId}`);
    return entry;
  }

  /** Generate text using a text-generation pipeline */
  async generate(pipelineId: string, prompt: string, options?: GenerateOptions): Promise<unknown> {
    const entry = this.getEntry(pipelineId);
    const genOpts: Record<string, unknown> = {};
    if (options?.max_new_tokens) genOpts.max_new_tokens = options.max_new_tokens;
    if (options?.temperature != null) genOpts.temperature = options.temperature;
    if (options?.top_k != null) genOpts.top_k = options.top_k;
    if (options?.top_p != null) genOpts.top_p = options.top_p;
    if (options?.do_sample != null) genOpts.do_sample = options.do_sample;
    if (options?.repetition_penalty != null) genOpts.repetition_penalty = options.repetition_penalty;

    const result = await entry.pipeline(prompt, genOpts);
    return result;
  }

  /** Generate embeddings using a feature-extraction pipeline */
  async embed(pipelineId: string, texts: string | string[]): Promise<unknown> {
    const entry = this.getEntry(pipelineId);
    const input = Array.isArray(texts) ? texts : [texts];
    const result = await entry.pipeline(input, { pooling: 'mean', normalize: true });
    return result;
  }

  /** Classify text using a text-classification/sentiment-analysis pipeline */
  async classify(pipelineId: string, text: string): Promise<unknown> {
    const entry = this.getEntry(pipelineId);
    return entry.pipeline(text);
  }

  /** Generic pipeline run — passes input and options directly to the pipeline */
  async run(pipelineId: string, input: unknown, options?: Record<string, unknown>): Promise<unknown> {
    const entry = this.getEntry(pipelineId);
    return entry.pipeline(input, options);
  }

  // ── Direct model loading (from_pretrained) ──

  /**
   * Load a model directly via from_pretrained.
   * Supports named model classes (e.g. "Qwen3_5ForConditionalGeneration")
   * or auto classes (AutoModelForCausalLM, AutoModelForImageTextToText).
   */
  async loadModel(
    modelId: string,
    options?: DirectModelOptions & { modelClass?: string }
  ): Promise<{ modelHandle: string; modelId: string }> {
    const tf = await this.getTransformers();

    if (this.permissionConfig?.allowedSources) {
      if (!this.permissionConfig.allowedSources.includes('huggingface')) {
        throw new Error('HuggingFace model loading not permitted');
      }
    }

    const device = await this.resolveDevice(options?.device);
    const modelOpts: Record<string, unknown> = { device };
    if (options?.dtype) modelOpts.dtype = options.dtype;
    if (options?.revision) modelOpts.revision = options.revision;

    console.log(`[SoftN AI] Loading model: ${modelId} (class=${options?.modelClass || 'auto'}, device=${device})`);

    // Resolve model class
    let model: TFModel;
    const className = options?.modelClass;
    if (className && tf[className]) {
      // Use named class (e.g. Qwen3_5ForConditionalGeneration)
      const cls = tf[className] as { from_pretrained(id: string, opts?: Record<string, unknown>): Promise<TFModel> };
      model = await cls.from_pretrained(modelId, modelOpts);
    } else {
      // Auto-detect: try AutoModelForImageTextToText first, fall back to AutoModelForCausalLM
      try {
        model = await tf.AutoModelForCausalLM.from_pretrained(modelId, modelOpts);
      } catch {
        model = await tf.AutoModelForImageTextToText.from_pretrained(modelId, modelOpts);
      }
    }

    // Load processor (handles chat template + tokenization for VLMs)
    let processor: TFProcessor | null = null;
    let tokenizer: TFTokenizer;
    try {
      processor = await tf.AutoProcessor.from_pretrained(modelId);
      tokenizer = processor.tokenizer;
    } catch {
      // No processor — use tokenizer directly (text-only models)
      tokenizer = await tf.AutoTokenizer.from_pretrained(modelId);
    }

    const handle = `model-${this.nextModelId++}`;
    this.models.set(handle, { model, processor, tokenizer, modelId, createdAt: Date.now() });

    console.log(`[SoftN AI] Model loaded: ${handle} (${modelId})`);
    return { modelHandle: handle, modelId };
  }

  /**
   * Generate text from a loaded model using chat messages.
   */
  async generateFromModel(
    modelHandle: string,
    messages: ChatMessage[],
    options?: GenerateOptions
  ): Promise<{ text: string }> {
    const entry = this.models.get(modelHandle);
    if (!entry) throw new Error(`Model not found: ${modelHandle}`);

    const { model, processor, tokenizer } = entry;
    const tf = await this.getTransformers();

    // Extract images from messages for VLM support
    // Messages may contain array content with {type:"image", image:"data:..."} entries
    let image: unknown = null;
    for (const msg of messages) {
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part && typeof part === 'object' && (part as Record<string, unknown>).type === 'image') {
            const imageUrl = (part as Record<string, unknown>).image as string;
            if (imageUrl && tf.RawImage) {
              try {
                image = await tf.RawImage.fromURL(imageUrl);
              } catch (e) {
                console.warn('[SoftN AI] Failed to load image for VLM:', e);
              }
            }
          }
        }
      }
    }

    // Apply chat template to get the prompt text
    const templateOpts = { add_generation_prompt: true };
    let promptText: string;
    if (processor) {
      promptText = processor.apply_chat_template(messages, templateOpts);
    } else {
      promptText = tokenizer.apply_chat_template(messages, templateOpts);
    }

    // Tokenize — pass image to processor for VLMs
    let inputs: Record<string, unknown>;
    if (processor && image) {
      inputs = await processor(promptText, image);
    } else if (processor) {
      inputs = await processor(promptText);
    } else {
      inputs = tokenizer(promptText, { return_tensors: 'pt' });
    }

    // Build generate options
    const genOpts: Record<string, unknown> = { ...inputs };
    if (options?.max_new_tokens) genOpts.max_new_tokens = options.max_new_tokens;
    if (options?.temperature != null) genOpts.temperature = options.temperature;
    if (options?.top_k != null) genOpts.top_k = options.top_k;
    if (options?.top_p != null) genOpts.top_p = options.top_p;
    if (options?.do_sample != null) genOpts.do_sample = options.do_sample;
    if (options?.repetition_penalty != null) genOpts.repetition_penalty = options.repetition_penalty;
    if (options?.presence_penalty != null) genOpts.presence_penalty = options.presence_penalty;

    console.log(`[SoftN AI] Generating from ${modelHandle}...`);
    const outputs = await model.generate(genOpts);

    // Decode — skip the prompt tokens
    let decoded: string;
    const inputLength = (inputs.input_ids as { dims?: number[] })?.dims?.at?.(-1) ?? 0;
    if (processor) {
      const sliced = (outputs as TFModelOutput).slice?.(null, [inputLength, null]) ?? outputs;
      const texts = processor.batch_decode(sliced, { skip_special_tokens: true });
      decoded = texts[0] || '';
    } else if (tokenizer.batch_decode) {
      const sliced = (outputs as TFModelOutput).slice?.(null, [inputLength, null]) ?? outputs;
      const texts = tokenizer.batch_decode(sliced, { skip_special_tokens: true });
      decoded = texts[0] || '';
    } else {
      decoded = String(outputs);
    }

    console.log(`[SoftN AI] Generation complete: ${decoded.length} chars`);
    return { text: decoded };
  }

  /** Release a direct model */
  async releaseModel(modelHandle: string): Promise<void> {
    const entry = this.models.get(modelHandle);
    if (!entry) return;
    if (entry.model.dispose) {
      await entry.model.dispose();
    }
    this.models.delete(modelHandle);
    console.log(`[SoftN AI] Model released: ${modelHandle}`);
  }

  /** Release a pipeline */
  async releasePipeline(pipelineId: string): Promise<void> {
    const entry = this.pipelines.get(pipelineId);
    if (!entry) return;
    if (entry.pipeline.dispose) {
      await entry.pipeline.dispose();
    }
    this.pipelines.delete(pipelineId);
    console.log(`[SoftN AI] Pipeline released: ${pipelineId}`);
  }

  /** Release all pipelines and models */
  async releaseAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [, entry] of this.pipelines) {
      if (entry.pipeline.dispose) {
        promises.push(entry.pipeline.dispose().catch(() => {}));
      }
    }
    for (const [, entry] of this.models) {
      if (entry.model.dispose) {
        promises.push(entry.model.dispose().catch(() => {}));
      }
    }
    await Promise.all(promises);
    this.pipelines.clear();
    this.models.clear();
    console.log('[SoftN AI] All pipelines and models released');
  }
}
