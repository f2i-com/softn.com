/**
 * SoftN GPU Compute Manager — raw WebGPU compute shader support
 *
 * Provides device, buffer, shader, pipeline, and dispatch lifecycle for
 * softn.ai.gpu.* bridge calls. Zero cost for apps that don't use GPU compute —
 * the WebGPU device is acquired lazily on first requestDevice() call.
 */

import type { GpuPermissionConfig, BundleFileProvider } from './ai-manager';

// ── Resource limits ──

const MAX_BUFFERS = 64;
const MAX_SHADERS = 32;
const MAX_PIPELINES = 32;
const DEFAULT_MAX_BUFFER_MEMORY_MB = 256;

// ── Data types ──

type DType = 'float32' | 'int32' | 'uint32' | 'uint8';

type TypedArrayCtor = Float32ArrayConstructor | Int32ArrayConstructor | Uint32ArrayConstructor | Uint8ArrayConstructor;

function getTypedArrayCtor(dtype: DType): TypedArrayCtor {
  switch (dtype) {
    case 'float32': return Float32Array;
    case 'int32': return Int32Array;
    case 'uint32': return Uint32Array;
    case 'uint8': return Uint8Array;
  }
}

// ── Internal types ──

interface BufferEntry {
  buffer: GPUBuffer;
  size: number;
  usage: number;
  dtype: DType;
}

interface ShaderEntry {
  module: GPUShaderModule;
}

interface PipelineEntry {
  pipeline: GPUComputePipeline;
  layouts: GPUBindGroupLayout[];
}

// ── Usage flag parsing ──

function parseUsageFlags(usage: string): number {
  const GPUBufferUsage = {
    MAP_READ: 0x0001,
    MAP_WRITE: 0x0002,
    COPY_SRC: 0x0004,
    COPY_DST: 0x0008,
    INDEX: 0x0010,
    VERTEX: 0x0020,
    UNIFORM: 0x0040,
    STORAGE: 0x0080,
    INDIRECT: 0x0100,
    QUERY_RESOLVE: 0x0200,
  };

  let flags = 0;
  const parts = usage.split('|').map(s => s.trim().toLowerCase());

  for (const part of parts) {
    switch (part) {
      case 'storage':
        flags |= GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
        break;
      case 'uniform':
        flags |= GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
        break;
      case 'read':
        flags |= GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST;
        break;
      case 'vertex':
        flags |= GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST;
        break;
      case 'index':
        flags |= GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST;
        break;
      default:
        throw new Error(`Unknown buffer usage flag: "${part}"`);
    }
  }

  return flags;
}

// ── GpuComputeManager ──

export class GpuComputeManager {
  private device: GPUDevice | null = null;
  private buffers = new Map<string, BufferEntry>();
  private shaders = new Map<string, ShaderEntry>();
  private pipelines = new Map<string, PipelineEntry>();
  private nextId = 1;
  private totalBufferBytes = 0;
  private permissionConfig: GpuPermissionConfig | null = null;
  private bundleFileProvider: BundleFileProvider | null = null;

  setPermissionConfig(config: GpuPermissionConfig): void {
    this.permissionConfig = config;
  }

  setBundleFileProvider(provider: BundleFileProvider): void {
    this.bundleFileProvider = provider;
  }

  private get maxBufferMemoryBytes(): number {
    const mb = this.permissionConfig?.maxBufferMemoryMB ?? DEFAULT_MAX_BUFFER_MEMORY_MB;
    return mb * 1024 * 1024;
  }

  private genId(prefix: string): string {
    return `${prefix}_${this.nextId++}`;
  }

  // ── Device ──

  async requestDevice(options?: Record<string, unknown>): Promise<{ deviceId: string; limits: Record<string, number> }> {
    if (this.device) {
      return {
        deviceId: 'device_0',
        limits: this.extractLimits(),
      };
    }

    const nav = globalThis.navigator as any;
    if (!nav?.gpu) {
      throw new Error('WebGPU is not supported in this browser');
    }

    const adapter = await nav.gpu.requestAdapter(options);
    if (!adapter) {
      throw new Error('Failed to get WebGPU adapter');
    }

    this.device = await (adapter as any).requestDevice() as GPUDevice;

    // Listen for device loss
    this.device!.lost.then((info: any) => {
      console.warn(`[GpuComputeManager] Device lost: ${info.message}`);
      this.device = null;
    });

    return {
      deviceId: 'device_0',
      limits: this.extractLimits(),
    };
  }

  private extractLimits(): Record<string, number> {
    if (!this.device) return {};
    const limits = (this.device as any).limits;
    return {
      maxBufferSize: limits?.maxBufferSize ?? 0,
      maxStorageBufferBindingSize: limits?.maxStorageBufferBindingSize ?? 0,
      maxComputeWorkgroupSizeX: limits?.maxComputeWorkgroupSizeX ?? 0,
      maxComputeWorkgroupSizeY: limits?.maxComputeWorkgroupSizeY ?? 0,
      maxComputeWorkgroupSizeZ: limits?.maxComputeWorkgroupSizeZ ?? 0,
      maxComputeInvocationsPerWorkgroup: limits?.maxComputeInvocationsPerWorkgroup ?? 0,
    };
  }

  private ensureDevice(): GPUDevice {
    if (!this.device) {
      throw new Error('No GPU device. Call softn.ai.gpu.requestDevice() first.');
    }
    return this.device;
  }

  // ── Buffers ──

  async createBuffer(
    source: { data?: number[]; size?: number; dtype?: DType },
    usage: string
  ): Promise<{ bufferId: string; size: number }> {
    const device = this.ensureDevice();

    if (this.buffers.size >= MAX_BUFFERS) {
      throw new Error(`Buffer limit reached (max ${MAX_BUFFERS})`);
    }

    const usageFlags = parseUsageFlags(usage);
    const dtype: DType = source.dtype || 'float32';
    const Ctor = getTypedArrayCtor(dtype);

    let size: number;
    let initialData: InstanceType<TypedArrayCtor> | null = null;

    if (source.data) {
      initialData = new Ctor(source.data);
      size = initialData.byteLength;
    } else if (source.size != null) {
      size = source.size;
    } else {
      throw new Error('Buffer source must have "data" or "size"');
    }

    // Align to 4 bytes (WebGPU requirement)
    size = Math.ceil(size / 4) * 4;

    if (this.totalBufferBytes + size > this.maxBufferMemoryBytes) {
      throw new Error(
        `Buffer memory limit exceeded: ${((this.totalBufferBytes + size) / (1024 * 1024)).toFixed(1)}MB > ${(this.maxBufferMemoryBytes / (1024 * 1024)).toFixed(0)}MB allowed`
      );
    }

    const buffer = device.createBuffer({
      size,
      usage: usageFlags,
      mappedAtCreation: !!initialData,
    });

    if (initialData) {
      new Ctor(buffer.getMappedRange()).set(initialData);
      buffer.unmap();
    }

    const id = this.genId('buf');
    this.buffers.set(id, { buffer, size, usage: usageFlags, dtype });
    this.totalBufferBytes += size;

    return { bufferId: id, size };
  }

  async writeBuffer(
    bufferId: string,
    data: number[],
    dtype?: DType
  ): Promise<{ ok: boolean }> {
    const device = this.ensureDevice();
    const entry = this.buffers.get(bufferId);
    if (!entry) throw new Error(`Buffer not found: ${bufferId}`);

    const Ctor = getTypedArrayCtor(dtype || entry.dtype);
    const src = new Ctor(data);
    device.queue.writeBuffer(entry.buffer, 0, src);
    return { ok: true };
  }

  // ── Shaders ──

  async createShader(
    source: { code?: string; bundle?: string }
  ): Promise<{ shaderId: string }> {
    const device = this.ensureDevice();

    if (this.shaders.size >= MAX_SHADERS) {
      throw new Error(`Shader limit reached (max ${MAX_SHADERS})`);
    }

    // Validate source type against permissions
    if (this.permissionConfig?.allowedShaderSources) {
      const allowed = this.permissionConfig.allowedShaderSources;
      if (source.code && !allowed.includes('inline')) {
        throw new Error('Inline shaders not allowed by permissions');
      }
      if (source.bundle && !allowed.includes('bundle')) {
        throw new Error('Bundle shaders not allowed by permissions');
      }
    }

    let wgslCode: string;

    if (source.code) {
      wgslCode = source.code;
    } else if (source.bundle) {
      if (!this.bundleFileProvider) {
        throw new Error('No bundle file provider available for loading shaders');
      }
      const data = await this.bundleFileProvider.readFile(source.bundle);
      if (!data) {
        throw new Error(`Shader file not found in bundle: ${source.bundle}`);
      }
      if (typeof data === 'string') {
        wgslCode = data;
      } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        wgslCode = new TextDecoder().decode(data);
      } else {
        wgslCode = new TextDecoder().decode(data);
      }
    } else {
      throw new Error('Shader source must have "code" or "bundle"');
    }

    const module = device.createShaderModule({ code: wgslCode });

    // Check for compilation errors
    const info = await (module as any).getCompilationInfo();
    if (info?.messages) {
      const errors = info.messages.filter((m: any) => m.type === 'error');
      if (errors.length > 0) {
        const msg = errors.map((e: any) => `Line ${e.lineNum}: ${e.message}`).join('\n');
        throw new Error(`WGSL compilation error:\n${msg}`);
      }
    }

    const id = this.genId('shader');
    this.shaders.set(id, { module });
    return { shaderId: id };
  }

  // ── Pipelines ──

  async createPipeline(
    options: { shader: string; entryPoint?: string; bindGroupCount?: number }
  ): Promise<{ pipelineId: string }> {
    const device = this.ensureDevice();

    if (this.pipelines.size >= MAX_PIPELINES) {
      throw new Error(`Pipeline limit reached (max ${MAX_PIPELINES})`);
    }

    const shaderEntry = this.shaders.get(options.shader);
    if (!shaderEntry) throw new Error(`Shader not found: ${options.shader}`);

    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: shaderEntry.module,
        entryPoint: options.entryPoint || 'main',
      },
    });

    const count = options.bindGroupCount || 1;
    const layouts: GPUBindGroupLayout[] = [];
    for (let i = 0; i < count; i++) {
      layouts.push(pipeline.getBindGroupLayout(i));
    }

    const id = this.genId('pipe');
    this.pipelines.set(id, { pipeline, layouts });
    return { pipelineId: id };
  }

  // ── Dispatch ──

  async dispatch(
    pipelineId: string,
    bindings: Array<{ binding: number; buffer: string; group?: number }>,
    workgroups: [number, number, number]
  ): Promise<{ ok: boolean }> {
    const device = this.ensureDevice();
    const pipeEntry = this.pipelines.get(pipelineId);
    if (!pipeEntry) throw new Error(`Pipeline not found: ${pipelineId}`);

    // Group bindings by bind group index
    const grouped = new Map<number, GPUBindGroupEntry[]>();
    for (const b of bindings) {
      const g = b.group ?? 0;
      if (!grouped.has(g)) grouped.set(g, []);
      const bufEntry = this.buffers.get(b.buffer);
      if (!bufEntry) throw new Error(`Buffer not found: ${b.buffer}`);
      grouped.get(g)!.push({
        binding: b.binding,
        resource: { buffer: bufEntry.buffer },
      });
    }

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeEntry.pipeline);

    for (const [groupIdx, entries] of grouped) {
      const layout = pipeEntry.layouts[groupIdx];
      if (!layout) throw new Error(`No layout for bind group ${groupIdx}. Pipeline has ${pipeEntry.layouts.length} group(s).`);
      const bg = device.createBindGroup({ layout, entries });
      pass.setBindGroup(groupIdx, bg);
    }

    pass.dispatchWorkgroups(workgroups[0], workgroups[1], workgroups[2]);
    pass.end();

    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();

    return { ok: true };
  }

  // ── Read back ──

  async readBuffer(bufferId: string): Promise<{ data: number[] }> {
    const device = this.ensureDevice();
    const entry = this.buffers.get(bufferId);
    if (!entry) throw new Error(`Buffer not found: ${bufferId}`);

    // Create a staging buffer for readback
    const staging = device.createBuffer({
      size: entry.size,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(entry.buffer, 0, staging, 0, entry.size);
    device.queue.submit([encoder.finish()]);

    await staging.mapAsync(GPUMapMode.READ);
    const Ctor = getTypedArrayCtor(entry.dtype);
    const result = new Ctor(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();

    return { data: Array.from(result) };
  }

  // ── Release ──

  async release(resourceId: string): Promise<{ released: boolean }> {
    // Try buffers
    const bufEntry = this.buffers.get(resourceId);
    if (bufEntry) {
      bufEntry.buffer.destroy();
      this.totalBufferBytes -= bufEntry.size;
      this.buffers.delete(resourceId);
      return { released: true };
    }

    // Try shaders (shader modules don't have destroy, just remove reference)
    if (this.shaders.has(resourceId)) {
      this.shaders.delete(resourceId);
      return { released: true };
    }

    // Try pipelines (pipelines don't have destroy, just remove reference)
    if (this.pipelines.has(resourceId)) {
      this.pipelines.delete(resourceId);
      return { released: true };
    }

    throw new Error(`Resource not found: ${resourceId}`);
  }

  async releaseAll(): Promise<{ released: boolean }> {
    // Destroy all buffers
    for (const entry of this.buffers.values()) {
      entry.buffer.destroy();
    }
    this.buffers.clear();
    this.shaders.clear();
    this.pipelines.clear();
    this.totalBufferBytes = 0;

    // Destroy device
    if (this.device) {
      this.device.destroy();
      this.device = null;
    }

    return { released: true };
  }
}
