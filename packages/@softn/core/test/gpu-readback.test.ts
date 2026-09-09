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
