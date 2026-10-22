/**
 * `softn.ai.*`: local models on ZIPP (`softn.ai.model.*`) and GPU compute
 * (`softn.ai.gpu.*`). Each engine is a chunk of its own, loaded at an app's
 * first call for it (ai-runtime-preload.ts fetches the same modules).
 */

import type { BundleFileProvider } from '../ai-manager';
import type { PendingHostCall } from '../script-runtime-types';
import type { HostGate } from './permissions';

export class AppAI {
  /** Local models on ZIPP, created on the first softn.ai.model.* call (models/model-host.ts). */
  private modelHost: import('../models/model-host').ModelHost | null = null;
  /** Lazy-loaded GPU compute manager (created on first softn.ai.gpu.* call) */
  private gpuComputeManager: import('../ai-gpu-compute-manager').GpuComputeManager | null = null;

  /**
   * @param readBundleFile One of the app's own files, for a model it ships.
   * @param bundleFileProvider The bundle's files, when the host supplies them.
   */
  constructor(
    private readonly gate: HostGate,
    private readonly readBundleFile: (path: string) => Promise<Blob | null>,
    private readonly bundleFileProvider: BundleFileProvider | null
  ) {}

  /**
   * The app's model host, made on its first use. Asked again after the
   * chunk's import, both whether the app is still open (one closed while the
   * chunk was on its way would have started a host nothing disposed: a model's
   * download and a Worker for the rest of the page's life) and whether a call
   * beside this one made the host first.
   */
  private async getModelHost(): Promise<import('../models/model-host').ModelHost> {
    if (this.modelHost) return this.modelHost;
    const { ModelHost } = await import('../models/model-host');
    if (this.gate.disposed()) throw new Error('The app has closed');
    if (!this.modelHost) {
      const permissions = this.gate.permissionConfig()?.permissions;
      // The net declaration rides along: a model URL is egress like any other.
      this.modelHost = new ModelHost({
        ai: permissions?.ai,
        net: permissions?.net,
        readBundleFile: (path) => this.readBundleFile(path),
      });
    }
    return this.modelHost;
  }

  async capabilities(): Promise<unknown> {
    // The only capability-shaped handler that answered anyone. It reports
    // webgpu/webgl/wasm availability and a maxModelSizeMB derived from
    // navigator.deviceMemory — a device fingerprint .logic has no other route
    // to — and it answered a bundle shipping no permission.json, and a bundle
    // whose consent bar was still up.
    this.gate.checkPermission('ai');
    const { detectCapabilities } = await import('../ai-manager');
    return detectCapabilities();
  }

  async releaseAll(): Promise<unknown> {
    this.modelHost?.releaseAll();
    if (this.gpuComputeManager) await this.gpuComputeManager.releaseAll();
    return { released: true };
  }

  async load(call: PendingHostCall): Promise<unknown> {
    this.gate.checkPermission('ai');
    const [spec, optionsJson] = call.args;
    // A string names a Hugging Face repository or a URL; an object says which
    // ({huggingface, file}, {url} or {bundle}).
    const source = typeof spec === 'string' && spec.trimStart().startsWith('{') ? JSON.parse(spec) : spec;
    const options = optionsJson ? JSON.parse(optionsJson) : {};
    const host = await this.getModelHost();
    return host.load(source, options && typeof options === 'object' ? options : {});
  }

  async generate(call: PendingHostCall): Promise<unknown> {
    this.gate.checkPermission('ai');
    const [modelHandle, messagesJson, optionsJson] = call.args;
    const messages = JSON.parse(messagesJson);
    const options = optionsJson ? JSON.parse(optionsJson) : {};
    const host = await this.getModelHost();
    return host.generate(modelHandle, messages, options && typeof options === 'object' ? options : {});
  }

  cancel(call: PendingHostCall): unknown {
    this.gate.checkPermission('ai');
    return { cancelled: this.modelHost?.cancel(String(call.args[0] ?? '')) ?? false };
  }

  async release(call: PendingHostCall): Promise<unknown> {
    this.gate.checkPermission('ai');
    const [modelHandle] = call.args;
    return { released: this.modelHost?.release(String(modelHandle ?? '')) ?? false };
  }

  /** The app's GPU compute manager, made on its first use; asked again after the import, as getModelHost is. */
  private async getGpuComputeManager(): Promise<
    import('../ai-gpu-compute-manager').GpuComputeManager
  > {
    if (this.gpuComputeManager) return this.gpuComputeManager;
    const { GpuComputeManager } = await import('../ai-gpu-compute-manager');
    if (this.gate.disposed()) throw new Error('The app has closed');
    if (!this.gpuComputeManager) {
      this.gpuComputeManager = new GpuComputeManager();
      if (this.bundleFileProvider) {
        this.gpuComputeManager.setBundleFileProvider(this.bundleFileProvider);
      }
      const gpu = this.gate.permissionConfig()?.permissions.gpu;
      if (gpu) {
        this.gpuComputeManager.setPermissionConfig(gpu);
      }
    }
    return this.gpuComputeManager;
  }

  async gpuRequestDevice(call: PendingHostCall): Promise<unknown> {
    this.gate.checkPermission('gpu');
    const options = call.args[0] ? JSON.parse(call.args[0]) : {};
    const mgr = await this.getGpuComputeManager();
    return mgr.requestDevice(options);
  }

  async gpuCreateBuffer(call: PendingHostCall): Promise<unknown> {
    this.gate.checkPermission('gpu');
    const [sourceJson, usage] = call.args;
    const source = JSON.parse(sourceJson);
    const mgr = await this.getGpuComputeManager();
    return mgr.createBuffer(source, usage);
  }

  async gpuWriteBuffer(call: PendingHostCall): Promise<unknown> {
    this.gate.checkPermission('gpu');
    const [bufferId, dataJson, dtype] = call.args;
    const data = JSON.parse(dataJson);
    const mgr = await this.getGpuComputeManager();
    return mgr.writeBuffer(bufferId, data, dtype || undefined);
  }

  async gpuCreateShader(call: PendingHostCall): Promise<unknown> {
    this.gate.checkPermission('gpu');
    const [sourceJson] = call.args;
    const source = JSON.parse(sourceJson);
    const mgr = await this.getGpuComputeManager();
    return mgr.createShader(source);
  }

  async gpuCreatePipeline(call: PendingHostCall): Promise<unknown> {
    this.gate.checkPermission('gpu');
    const [optionsJson] = call.args;
    const options = JSON.parse(optionsJson);
    const mgr = await this.getGpuComputeManager();
    return mgr.createPipeline(options);
  }

  async gpuDispatch(call: PendingHostCall): Promise<unknown> {
    this.gate.checkPermission('gpu');
    const [pipelineId, bindingsJson, workgroupsJson] = call.args;
    const bindings = JSON.parse(bindingsJson);
    const workgroups = JSON.parse(workgroupsJson);
    const mgr = await this.getGpuComputeManager();
    return mgr.dispatch(pipelineId, bindings, workgroups);
  }

  async gpuReadBuffer(call: PendingHostCall): Promise<unknown> {
    this.gate.checkPermission('gpu');
    const [bufferId] = call.args;
    const mgr = await this.getGpuComputeManager();
    return mgr.readBuffer(bufferId);
  }

  async gpuRelease(call: PendingHostCall): Promise<unknown> {
    this.gate.checkPermission('gpu');
    const [resourceId] = call.args;
    const mgr = await this.getGpuComputeManager();
    return mgr.release(resourceId);
  }

  async gpuReleaseAll(): Promise<unknown> {
    // The only gpu handler that reached getGpuComputeManager unchecked, and the
    // getter only wires the declared limits into a manager it is creating. A
    // denied app calling this built the manager with no config at all, and the
    // `if (!this.gpuComputeManager)` cache meant the buffer cap and the shader
    // allowlist were then missing for the rest of the session.
    this.gate.checkPermission('gpu');
    const mgr = await this.getGpuComputeManager();
    return mgr.releaseAll();
  }

  /** Release every model and GPU resource: each loaded model's Worker is terminated. */
  dispose(): void {
    this.modelHost?.dispose();
    this.modelHost = null;
    if (this.gpuComputeManager) {
      this.gpuComputeManager.releaseAll().catch(() => {});
      this.gpuComputeManager = null;
    }
  }
}
