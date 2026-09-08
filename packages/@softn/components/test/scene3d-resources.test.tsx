/**
 * What a model is allowed to fetch, decided before the request goes out.
 *
 * These run the real GLTFLoader against a stubbed `fetch`, so the URL its
 * FileLoader asks for is the URL that would have left the page. A glTF that
 * names a buffer on a host the bundle was not granted must never produce a
 * request to that host; one inside a bundle must find its buffer by archive
 * path through the host's resolver, and fail closed when the path climbs out.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createRoot, type Root } from 'react-dom/client';
import {
  AppScopeProvider,
  CapabilityProvider,
  type AppAssetResolver,
  type CapabilityState,
  type XDBService,
} from '@softn/core';
import { Scene3D, type Scene3DModelStateInfo } from '../src/threed/Scene3D';
import { modelTemplateCache } from '../src/threed/model-cache';
import {
  createLoadResources,
  NO_REQUEST_URL,
  resolveBundleRelative,
  type ModelResourcePolicy,
} from '../src/threed/model-resources';
import {
  gltfNeeding,
  stubFetch,
  stubFrames,
  triangleBytes,
  waitFor,
  type FetchRoute,
  type FetchStub,
} from './scene3d-doubles';

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  const { TestWebGLRenderer } = await import('./scene3d-doubles');
  return { ...actual, WebGLRenderer: TestWebGLRenderer };
});

let container: HTMLDivElement;
let root: Root;
let states: Scene3DModelStateInfo[];
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  states = [];
  stubFrames();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  // Every test's URLs are its own, so nothing is served from a previous test.
  modelTemplateCache.clearIdle();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  consoleError.mockRestore();
});

const onModelState = (info: Scene3DModelStateInfo) => states.push(info);
const settled = (id: string) => () => states.some((s) => s.objectId === id && s.state !== 'pending');
const last = (id: string) => states.filter((s) => s.objectId === id).at(-1);

const netTo = (...hosts: string[]): CapabilityState => ({
  consentPending: false,
  permissions: { net: { enabled: true, allowed_hosts: hosts } as { enabled: boolean } },
});

describe('a remote model under a host allowlist', () => {
  it('never requests a buffer on a host the bundle was not granted, and reports the refusal', async () => {
    const fetched: FetchStub = stubFetch({
      'https://allowed.example/m.gltf': () => gltfNeeding('https://forbidden.example/buf.bin'),
      'https://forbidden.example/buf.bin': () => triangleBytes(),
    });
    act(() =>
      root.render(
        <CapabilityProvider value={netTo('allowed.example')}>
          <Scene3D
            objects={[{ id: 'm', type: 'model', modelUrl: 'https://allowed.example/m.gltf' }]}
            onModelState={onModelState}
          />
        </CapabilityProvider>
      )
    );
    await waitFor(settled('m'), 'the model to settle');
    expect(fetched.calls.some((url) => url.includes('forbidden.example'))).toBe(false);
    expect(fetched.calls).toContain('https://allowed.example/m.gltf');
    expect(last('m')?.state).toBe('error');
    expect(last('m')?.error).toContain('https://forbidden.example/buf.bin');
    expect(last('m')?.error).toMatch(/Host not allowed/);
  });

  it('fetches a buffer on a granted host, relative to the model', async () => {
    const fetched = stubFetch({
      'https://allowed.example/models/m.gltf': () => gltfNeeding('parts/buf.bin'),
      'https://allowed.example/models/parts/buf.bin': () => triangleBytes(),
    });
    act(() =>
      root.render(
        <CapabilityProvider value={netTo('allowed.example')}>
          <Scene3D
            objects={[{ id: 'm', type: 'model', modelUrl: 'https://allowed.example/models/m.gltf' }]}
            onModelState={onModelState}
          />
        </CapabilityProvider>
      )
    );
    await waitFor(settled('m'), 'the model to settle');
    expect(last('m')?.state).toBe('loaded');
    expect(fetched.calls).toContain('https://allowed.example/models/parts/buf.bin');
    const scene = (container.querySelector('canvas') as HTMLCanvasElement & { __softnScene: THREE.Scene })
      .__softnScene;
    let vertices = 0;
    scene.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh) vertices += mesh.geometry.getAttribute('position').count;
    });
    expect(vertices).toBe(3);
  });

  it('leaves three’s global loading manager alone', () => {
    expect(THREE.DefaultLoadingManager.resolveURL('probe.bin')).toBe('probe.bin');
  });
});

/**
 * A bundle of two files, minting the kind of URL the web host mints. `open`
 * tells one minting from another, as the host's fresh resolver per open does.
 */
function fakeBundle(files: Record<string, string | Uint8Array<ArrayBuffer>>, open = 'open') {
  const urls = new Map<string, string>();
  const paths = new Map<string, string>();
  const bodies: Record<string, FetchRoute> = {};
  for (const [path, body] of Object.entries(files)) {
    const url = `blob:https://host.test/${open}/${path.replace(/\//g, '-')}`;
    urls.set(path, url);
    paths.set(url, path);
    bodies[url] = () => body;
  }
  const assets = ((path: string) => urls.get(path) ?? '') as AppAssetResolver;
  assets.pathOf = (url: string) => paths.get(url);
  return { assets, bodies, url: (path: string) => urls.get(path) as string };
}

function underApp(assets: AppAssetResolver, child: React.ReactElement): React.ReactElement {
  return (
    <AppScopeProvider value={{ appId: 'app-a', xdb: {} as XDBService, active: true, assets }}>
      <CapabilityProvider value={{ consentPending: false, permissions: {} }}>{child}</CapabilityProvider>
    </AppScopeProvider>
  );
}

describe('a model inside a bundle', () => {
  it('finds a relative buffer by archive path through the host’s resolver', async () => {
    const bundle = fakeBundle({
      'models/a.gltf': gltfNeeding('a.bin'),
      'models/a.bin': triangleBytes(),
    });
    const fetched = stubFetch(bundle.bodies);
    act(() =>
      root.render(
        underApp(
          bundle.assets,
          <Scene3D
            objects={[{ id: 'a', type: 'model', modelUrl: bundle.url('models/a.gltf') }]}
            onModelState={onModelState}
          />
        )
      )
    );
    await waitFor(settled('a'), 'the model to settle');
    expect(last('a')?.state).toBe('loaded');
    expect(fetched.calls).toEqual([bundle.url('models/a.gltf'), bundle.url('models/a.bin')]);
  });

  it('resolves dotted and encoded paths against the model’s directory', async () => {
    const bundle = fakeBundle({
      'models/hero/hero.gltf': gltfNeeding('../shared/my%20mesh.bin'),
      'models/shared/my mesh.bin': triangleBytes(),
    });
    const fetched = stubFetch(bundle.bodies);
    act(() =>
      root.render(
        underApp(
          bundle.assets,
          <Scene3D
            objects={[{ id: 'h', type: 'model', modelUrl: bundle.url('models/hero/hero.gltf') }]}
            onModelState={onModelState}
          />
        )
      )
    );
    await waitFor(settled('h'), 'the model to settle');
    expect(last('h')?.state).toBe('loaded');
    expect(fetched.calls).toContain(bundle.url('models/shared/my mesh.bin'));
  });

  it('sends no request for a path that climbs out of the bundle, and fails closed', async () => {
    const bundle = fakeBundle({ 'models/b.gltf': gltfNeeding('../../escape.bin') });
    const fetched = stubFetch(bundle.bodies);
    act(() =>
      root.render(
        underApp(
          bundle.assets,
          <Scene3D
            objects={[{ id: 'b', type: 'model', modelUrl: bundle.url('models/b.gltf') }]}
            onModelState={onModelState}
          />
        )
      )
    );
    await waitFor(settled('b'), 'the model to settle');
    expect(last('b')?.state).toBe('error');
    expect(last('b')?.error).toContain('../../escape.bin');
    expect(fetched.calls.filter((url) => !url.startsWith('data:'))).toEqual([bundle.url('models/b.gltf')]);
  });

  it('sends no request for a file the bundle does not have', async () => {
    const bundle = fakeBundle({ 'models/c.gltf': gltfNeeding('missing.bin') });
    const fetched = stubFetch(bundle.bodies);
    act(() =>
      root.render(
        underApp(
          bundle.assets,
          <Scene3D
            objects={[{ id: 'c', type: 'model', modelUrl: bundle.url('models/c.gltf') }]}
            onModelState={onModelState}
          />
        )
      )
    );
    await waitFor(settled('c'), 'the model to settle');
    expect(last('c')?.state).toBe('error');
    expect(last('c')?.error).toContain('models/missing.bin');
    expect(fetched.calls.filter((url) => !url.startsWith('data:'))).toEqual([bundle.url('models/c.gltf')]);
  });

  it('judges an absolute URL inside a bundle model by the egress policy', async () => {
    const bundle = fakeBundle({ 'models/d.gltf': gltfNeeding('https://elsewhere.example/buf.bin') });
    const fetched = stubFetch({
      ...bundle.bodies,
      'https://elsewhere.example/buf.bin': () => triangleBytes(),
    });
    act(() =>
      root.render(
        underApp(
          bundle.assets,
          <Scene3D
            objects={[{ id: 'd', type: 'model', modelUrl: bundle.url('models/d.gltf') }]}
            onModelState={onModelState}
          />
        )
      )
    );
    await waitFor(settled('d'), 'the model to settle');
    expect(last('d')?.state).toBe('error');
    expect(fetched.calls.some((url) => url.includes('elsewhere.example'))).toBe(false);
  });
});

describe('two objects naming one model', () => {
  it('fetch it once and each get their own copy', async () => {
    const fetched = stubFetch({
      'https://allowed.example/shared.gltf': () => gltfNeeding('shared.bin'),
      'https://allowed.example/shared.bin': () => triangleBytes(),
    });
    act(() =>
      root.render(
        <Scene3D
          objects={[
            { id: 'one', type: 'model', modelUrl: 'https://allowed.example/shared.gltf', color: '#ff0000' },
            { id: 'two', type: 'model', modelUrl: 'https://allowed.example/shared.gltf', color: '#00ff00' },
          ]}
          onModelState={onModelState}
        />
      )
    );
    await waitFor(() => settled('one')() && settled('two')(), 'both models to settle');
    expect(last('one')?.state).toBe('loaded');
    expect(last('two')?.state).toBe('loaded');
    expect(fetched.calls.filter((url) => url.endsWith('shared.gltf'))).toHaveLength(1);
    expect(fetched.calls.filter((url) => url.endsWith('shared.bin'))).toHaveLength(1);
    const scene = (container.querySelector('canvas') as HTMLCanvasElement & { __softnScene: THREE.Scene })
      .__softnScene;
    const meshes: THREE.Mesh[] = [];
    scene.traverse((node) => {
      if ((node as THREE.Mesh).isMesh) meshes.push(node as THREE.Mesh);
    });
    expect(meshes).toHaveLength(2);
    expect(meshes[0].geometry).toBe(meshes[1].geometry);
    expect(meshes[0].material).not.toBe(meshes[1].material);
    const colours = meshes.map((m) => (m.material as THREE.MeshStandardMaterial).color.getHexString()).sort();
    expect(colours).toEqual(['00ff00', 'ff0000']);
  });
});

describe('resolveBundleRelative', () => {
  it('walks the archive like a path', () => {
    expect(resolveBundleRelative('models/hero', 'textures/skin.png')).toBe('models/hero/textures/skin.png');
    expect(resolveBundleRelative('models/hero', './skin.png')).toBe('models/hero/skin.png');
    expect(resolveBundleRelative('models/hero', '../shared/a.bin')).toBe('models/shared/a.bin');
    expect(resolveBundleRelative('models/hero', '/root.bin')).toBe('root.bin');
    expect(resolveBundleRelative('', 'a.bin')).toBe('a.bin');
    expect(resolveBundleRelative('models', 'a%20b.bin?v=2#frag')).toBe('models/a b.bin');
  });

  it('refuses to climb above the bundle root, or to name nothing', () => {
    expect(resolveBundleRelative('models', '../../a.bin')).toBeNull();
    expect(resolveBundleRelative('', '..')).toBeNull();
    expect(resolveBundleRelative('models', '')).toBeNull();
    expect(resolveBundleRelative('models', '%')).toBeNull();
  });
});

describe('the policy a load reads', () => {
  it('is the policy of the moment, decision by decision', () => {
    let policy: ModelResourcePolicy = {
      judge: () => ({ allowed: false, reason: 'Withheld until the user answers the permission bar' }),
    };
    const resources = createLoadResources('https://allowed.example/m.gltf', () => policy);
    const texture = 'https://allowed.example/t.png';
    expect(resources.manager.resolveURL(texture)).toBe(NO_REQUEST_URL);
    policy = { judge: () => ({ allowed: true }) };
    expect(resources.manager.resolveURL(texture)).toBe(texture);
    expect(resources.refused).toEqual([
      { url: texture, reason: 'Withheld until the user answers the permission bar' },
    ]);
  });

  it('lets a consent answered while the bytes were on their way reach the model’s parts', async () => {
    const bundle = fakeBundle({ 'models/e.gltf': gltfNeeding('https://allowed.example/buf.bin') });
    let releaseModel: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    const fetched = stubFetch({
      [bundle.url('models/e.gltf')]: async () => {
        await held;
        return gltfNeeding('https://allowed.example/buf.bin');
      },
      'https://allowed.example/buf.bin': () => triangleBytes(),
    });
    const render = (capability: CapabilityState) =>
      act(() =>
        root.render(
          <AppScopeProvider value={{ appId: 'app-a', xdb: {} as XDBService, active: true, assets: bundle.assets }}>
            <CapabilityProvider value={capability}>
              <Scene3D
                objects={[{ id: 'e', type: 'model', modelUrl: bundle.url('models/e.gltf') }]}
                onModelState={onModelState}
              />
            </CapabilityProvider>
          </AppScopeProvider>
        )
      );
    // A bundle model is not egress, so its load starts while the permission
    // bar is still up; the buffer it names on the network would not pass.
    render({ ...netTo('allowed.example'), consentPending: true });
    await waitFor(() => fetched.calls.includes(bundle.url('models/e.gltf')), 'the model bytes to be asked for');
    expect(fetched.calls).not.toContain('https://allowed.example/buf.bin');
    // The user allows; then the bytes arrive and the loader asks for the buffer.
    render(netTo('allowed.example'));
    releaseModel();
    await waitFor(settled('e'), 'the model to settle');
    expect(last('e')?.state).toBe('loaded');
    expect(fetched.calls).toContain('https://allowed.example/buf.bin');
  });
});

describe('a bundle model across opens of its app', () => {
  it('is found again by archive path when the host has minted fresh object URLs', async () => {
    const files = { 'models/r.gltf': gltfNeeding('r.bin'), 'models/r.bin': triangleBytes() };
    const first = fakeBundle(files, 'first-open');
    const second = fakeBundle(files, 'second-open');
    const fetched = stubFetch({ ...first.bodies, ...second.bodies });
    const open = (bundle: ReturnType<typeof fakeBundle>) =>
      act(() =>
        root.render(
          underApp(
            bundle.assets,
            <Scene3D
              objects={[{ id: 'r', type: 'model', modelUrl: bundle.url('models/r.gltf') }]}
              onModelState={onModelState}
            />
          )
        )
      );
    open(first);
    await waitFor(settled('r'), 'the first open to settle');
    expect(last('r')?.state).toBe('loaded');
    act(() => root.render(null));
    states = [];

    open(second);
    await waitFor(settled('r'), 'the second open to settle');
    expect(last('r')?.state).toBe('loaded');
    // Nothing of the second open's URLs was fetched: the template filed under
    // the archive path was still there.
    expect(fetched.calls).toEqual([first.url('models/r.gltf'), first.url('models/r.bin')]);
  });
});
