import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBundleAssetResolver } from '../src/bundleAssets';
import { isSoftnPath, resolveServerConfig } from '../src/runtimeConfig';

afterEach(() => vi.restoreAllMocks());

describe('desktop bundle parity', () => {
  it('resolves a model and its sibling resources with reverse paths and releases them', () => {
    const created = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:asset-${created.mock.calls.length}`);
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const assets = createBundleAssetResolver(
      new Map([['models/mesh.bin', new Uint8Array([1, 2])]]),
      new Map([['models/scene.gltf', '{"buffers":[{"uri":"mesh.bin"}]}']]),
    );
    const scene = assets('models/scene.gltf');
    expect(assets.pathOf?.(scene)).toBe('models/scene.gltf');
    const sibling = assets('models/mesh.bin');
    expect(assets.pathOf?.(sibling)).toBe('models/mesh.bin');
    expect(assets('./models/scene.gltf')).toBe(scene);
    expect(created).toHaveBeenCalledTimes(2);
    expect(assets('../scene.gltf')).toBe('');
    expect(assets('missing.png')).toBe('');
    assets.dispose?.();
    assets.dispose?.();
    expect(revoked.mock.calls).toEqual([[scene], [sibling]]);
    expect(assets('models/scene.gltf')).toBe('');
    expect(assets.pathOf?.(scene)).toBeUndefined();
  });

  it('accepts current browser server settings and older desktop token spelling', () => {
    expect(resolveServerConfig({ url: 'https://backend.example/app/?room=demo', token: 'current', auth_token: 'old', collections: ['tasks'] }))
      .toEqual({ serverUrl: 'wss://backend.example/app/sync?room=demo', serverToken: 'current', serverCollections: ['tasks'] });
    expect(resolveServerConfig({ url: 'ws://localhost:8080/sync/', auth_token: 'legacy' }))
      .toEqual({ serverUrl: 'ws://localhost:8080/sync', serverToken: 'legacy', serverCollections: undefined });
    expect(resolveServerConfig().serverUrl).toBeUndefined();
    expect(() => resolveServerConfig({ url: 'file:///app' })).toThrow('HTTP or WebSocket');
  });

  it('recognizes app files regardless of extension casing', () => {
    expect(isSoftnPath('C:\\Apps\\Fieldnotes.SOFTN')).toBe(true);
    expect(isSoftnPath('C:\\Apps\\Fieldnotes.softn.zip')).toBe(false);
  });
});
