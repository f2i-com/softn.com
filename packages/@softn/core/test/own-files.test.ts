/**
 * An app's own files, read where its markup finds them: a page's
 * `fetch('data.json')`, a model it ships, a shader it ships. Studio's
 * preview gives every file as a `data:` address, which was refused with
 * the addresses that would reach the network; and a shader was read only
 * from a bundle provider, which no host supplies.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppNetwork } from '../src/runtime/host-calls/network';
import { AppAI } from '../src/runtime/host-calls/ai';
import type { HostGate } from '../src/runtime/host-calls/permissions';
import type { PendingHostCall } from '../src/runtime/script-runtime-types';

const gate: HostGate = {
  checkPermission: () => {},
  checkNetHost: () => {},
  permissionConfig: () => ({ permissions: { gpu: { enabled: true } } }),
  disposed: () => false,
  pressedHere: () => true,
};

const call = (...args: string[]) => ({ args }) as unknown as PendingHostCall;

/** jsdom's Blob has no text() or arrayBuffer(), which every browser's has. */
const textOf = (blob: Blob) =>
  new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(blob);
  });
const blobOf = (text: string) => ({ arrayBuffer: async () => new TextEncoder().encode(text).buffer }) as Blob;

function network(files: Record<string, string>) {
  return new AppNetwork(gate, {
    assetResolver: (path) => files[path] ?? '',
    bundleFileProvider: null,
    storageEndpoint: null,
    visitorToken: null,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (navigator as unknown as { gpu?: unknown }).gpu;
});

describe('a page\'s own file', () => {
  const files = {
    'data.json': `data:application/json;charset=utf-8,${encodeURIComponent('{"n":1}')}`,
    'away.json': 'https://example.test/away.json',
    'host.json': '//example.test/host.json',
  };

  it('is read from a data: address, as Studio\'s preview gives it', async () => {
    const read = (await network(files).readFile(call('data.json'))) as { ok: boolean; body: string };
    expect(read.ok).toBe(true);
    expect(JSON.parse(read.body)).toEqual({ n: 1 });
    const blob = await network(files).readBlob('data.json');
    expect(blob && (await textOf(blob))).toBe('{"n":1}');
  });

  it('is not found at an address that would reach the network', async () => {
    const fetched = vi.fn();
    vi.stubGlobal('fetch', fetched);
    for (const path of ['away.json', 'host.json']) {
      expect(((await network(files).readFile(call(path))) as { status: number }).status).toBe(404);
      expect(await network(files).readBlob(path)).toBeNull();
    }
    expect(fetched).not.toHaveBeenCalled();
  });
});

describe('a shader the app ships', () => {
  it('is read where its models are, with no bundle provider', async () => {
    const createShaderModule = vi.fn(() => ({ getCompilationInfo: async () => ({ messages: [] }) }));
    const device = { destroy: vi.fn(), lost: new Promise(() => {}), limits: {}, createShaderModule };
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: { requestAdapter: async () => ({ requestDevice: async () => device }) },
    });
    const wgsl = '@compute @workgroup_size(1) fn main() {}';
    const ai = new AppAI(gate, async (path) => (path === 'shaders/add.wgsl' ? blobOf(wgsl) : null));
    await ai.gpuRequestDevice(call());
    const made = (await ai.gpuCreateShader(call(JSON.stringify({ bundle: 'shaders/add.wgsl' })))) as { shaderId: string };
    expect(made.shaderId).toMatch(/^shader/);
    expect(createShaderModule).toHaveBeenCalledWith({ code: wgsl });
    await expect(ai.gpuCreateShader(call(JSON.stringify({ bundle: 'shaders/none.wgsl' })))).rejects.toThrow(/not found/);
  });
});
