/**
 * GPU buffer read-back: the staging buffer it allocates is released whether
 * or not the map succeeds.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { GpuComputeManager } from '../src/runtime/ai-gpu-compute-manager';

interface Internals {
  device: unknown;
  buffers: Map<string, { buffer: unknown; size: number; usage: number; dtype: string }>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (navigator as unknown as { gpu?: unknown }).gpu;
});

/** A WebGPU whose device arrives when `arrive` is called, and is lost when `lose` is. */
function fakeGpu() {
  let arrive!: () => void;
  let lose!: (info: { message: string }) => void;
  const lost = new Promise<{ message: string }>((resolve) => (lose = resolve));
  const device = { destroy: vi.fn(), lost, limits: {} };
  const arrived = new Promise<void>((resolve) => (arrive = resolve));
  const requestDevice = vi.fn(async () => {
    await arrived;
    return device;
  });
  Object.defineProperty(navigator, 'gpu', {
    configurable: true,
    value: { requestAdapter: async () => ({ requestDevice }) },
  });
  return { device, requestDevice, arrive: () => arrive(), lose: (message: string) => lose({ message }) };
}

describe('the device', () => {
  it('is requested once when two calls ask for it together', async () => {
    const gpu = fakeGpu();
    const mgr = new GpuComputeManager();
    const both = Promise.all([mgr.requestDevice(), mgr.requestDevice()]);
    gpu.arrive();
    await both;
    expect(gpu.requestDevice).toHaveBeenCalledOnce();
  });

  it('is destroyed, not kept, when it arrives after a release', async () => {
    const gpu = fakeGpu();
    const mgr = new GpuComputeManager();
    const asked = mgr.requestDevice();
    await mgr.releaseAll();
    gpu.arrive();
    await expect(asked).rejects.toThrow(/released/);
    expect(gpu.device.destroy).toHaveBeenCalledOnce();
    expect((mgr as unknown as Internals).device).toBeNull();
  });

  it('takes what lived on it when it is lost', async () => {
    const gpu = fakeGpu();
    const mgr = new GpuComputeManager();
    const asked = mgr.requestDevice();
    gpu.arrive();
    await asked;
    const internals = mgr as unknown as Internals & { totalBufferBytes: number };
    internals.buffers.set('b1', { buffer: {}, size: 64, usage: 0, dtype: 'float32' });
    internals.totalBufferBytes = 64;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    gpu.lose('reset');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(internals.device).toBeNull();
    expect(internals.buffers.size).toBe(0);
    expect(internals.totalBufferBytes).toBe(0);
  });
});

describe('readBuffer', () => {
  it('destroys the staging buffer when mapAsync rejects', async () => {
    vi.stubGlobal('GPUBufferUsage', { MAP_READ: 1, COPY_DST: 8 });
    vi.stubGlobal('GPUMapMode', { READ: 1 });

    const destroy = vi.fn();
    const staging = {
      mapAsync: vi.fn(async () => {
        throw new Error('Device lost');
      }),
      getMappedRange: vi.fn(),
      unmap: vi.fn(),
      destroy,
    };
    const device = {
      createBuffer: vi.fn(() => staging),
      createCommandEncoder: () => ({
        copyBufferToBuffer: () => {},
        finish: () => ({}),
      }),
      queue: { submit: () => {} },
    };

    const mgr = new GpuComputeManager();
    const internals = mgr as unknown as Internals;
    internals.device = device;
    internals.buffers.set('b1', { buffer: {}, size: 16, usage: 0, dtype: 'float32' });

    await expect(mgr.readBuffer('b1')).rejects.toThrow('Device lost');
    expect(destroy).toHaveBeenCalledOnce();
    expect(staging.unmap).not.toHaveBeenCalled();
  });

  it('still reads a buffer back and destroys the staging copy after', async () => {
    vi.stubGlobal('GPUBufferUsage', { MAP_READ: 1, COPY_DST: 8 });
    vi.stubGlobal('GPUMapMode', { READ: 1 });

    const bytes = new Float32Array([1.5, 2.5]).buffer;
    const staging = {
      mapAsync: vi.fn(async () => {}),
      getMappedRange: () => bytes,
      unmap: vi.fn(),
      destroy: vi.fn(),
    };
    const device = {
      createBuffer: vi.fn(() => staging),
      createCommandEncoder: () => ({
        copyBufferToBuffer: () => {},
        finish: () => ({}),
      }),
      queue: { submit: () => {} },
    };

    const mgr = new GpuComputeManager();
    const internals = mgr as unknown as Internals;
    internals.device = device;
    internals.buffers.set('b1', { buffer: {}, size: 8, usage: 0, dtype: 'float32' });

    await expect(mgr.readBuffer('b1')).resolves.toEqual({ data: [1.5, 2.5] });
    expect(staging.unmap).toHaveBeenCalledOnce();
    expect(staging.destroy).toHaveBeenCalledOnce();
  });
});
