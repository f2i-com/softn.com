/**
 * A file in the app's bundle, named from logic by its path.
 *
 * `asset("assets/robot.glb")` is the page's: logic is not given it, and a
 * game builds its objects in logic. So a `modelUrl` or `textureUrl` that is
 * a plain path was handed to the browser as it stood, which asked the page's
 * own address for a file only the bundle holds. The scene now offers such a
 * path to the app's resolver first, as `softn.audio.play` offers a sound's,
 * and what comes back is judged by the permission policy like any other URL.
 *
 * The real GLTFLoader against a stubbed `fetch`, as in scene3d-resources:
 * the URL its loader asks for is the URL that would have left the page.
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
import { Scene3D, type Scene3DModelStateInfo, type Scene3DObject } from '../src/threed/Scene3D';
import { modelTemplateCache } from '../src/threed/model-cache';
import { gltfNeeding, stubFetch, stubFrames, triangleBytes, waitFor, type FetchRoute } from './scene3d-doubles';

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
  modelTemplateCache.clearIdle();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  consoleError.mockRestore();
});

const onModelState = (info: Scene3DModelStateInfo) => states.push(info);
const settled = (id: string) => () => states.some((s) => s.objectId === id && s.state !== 'pending');
const last = (id: string) => states.filter((s) => s.objectId === id).at(-1);

/** A bundle that mints the kind of URL the web host mints, and says what it was asked for. */
function fakeBundle(files: Record<string, string | Uint8Array<ArrayBuffer>>) {
  const urls = new Map<string, string>();
  const paths = new Map<string, string>();
  const bodies: Record<string, FetchRoute> = {};
  const asked: string[] = [];
  for (const [path, body] of Object.entries(files)) {
    const url = `blob:https://host.test/minted/${path.replace(/\//g, '-')}`;
    urls.set(path, url);
    paths.set(url, path);
    bodies[url] = () => body;
  }
  const assets = ((path: string) => {
    asked.push(path);
    return urls.get(path) ?? '';
  }) as AppAssetResolver;
  assets.pathOf = (url: string) => paths.get(url);
  return { assets, bodies, asked, url: (path: string) => urls.get(path) as string };
}

function inApp(
  assets: AppAssetResolver,
  child: React.ReactElement,
  capability: CapabilityState = { consentPending: false, permissions: {} }
): React.ReactElement {
  return (
    <AppScopeProvider value={{ appId: 'app-paths', xdb: {} as XDBService, active: true, assets }}>
      <CapabilityProvider value={capability}>{child}</CapabilityProvider>
    </AppScopeProvider>
  );
}

function nodeById(id: string): THREE.Object3D | undefined {
  const scene = (container.querySelector('canvas') as HTMLCanvasElement & { __softnScene: THREE.Scene }).__softnScene;
  let found: THREE.Object3D | undefined;
  scene.traverse((node) => {
    if (!found && node.userData.__softnId === id) found = node;
  });
  return found;
}

describe('a model named by its path in the bundle', () => {
  it('is the bundle’s file: the resolver is asked, and the model and what it names beside itself are read from it', async () => {
    const bundle = fakeBundle({
      'assets/robot.gltf': gltfNeeding('robot.bin'),
      'assets/robot.bin': triangleBytes(),
    });
    const fetched = stubFetch(bundle.bodies);
    act(() =>
      root.render(
        inApp(
          bundle.assets,
          <Scene3D objects={[{ id: 'robot', type: 'model', modelUrl: 'assets/robot.gltf' }]} onModelState={onModelState} />
        )
      )
    );
    await waitFor(settled('robot'), 'the model to settle');
    expect(last('robot')?.state).toBe('loaded');
    expect(bundle.asked).toContain('assets/robot.gltf');
    // Nothing was asked of the page's own address.
    expect(fetched.calls).toEqual([bundle.url('assets/robot.gltf'), bundle.url('assets/robot.bin')]);
  });

  it('is found the same way when it is a group’s child', async () => {
    const bundle = fakeBundle({
      'assets/wheel.gltf': gltfNeeding('wheel.bin'),
      'assets/wheel.bin': triangleBytes(),
    });
    const fetched = stubFetch(bundle.bodies);
    act(() =>
      root.render(
        inApp(
          bundle.assets,
          <Scene3D
            objects={[
              { id: 'car', type: 'group', children: [{ id: 'wheel', type: 'model', modelUrl: 'assets/wheel.gltf' }] },
            ]}
            onModelState={onModelState}
          />
        )
      )
    );
    await waitFor(settled('wheel'), 'the model to settle');
    expect(last('wheel')).toMatchObject({ state: 'loaded', parentId: 'car' });
    expect(fetched.calls).toEqual([bundle.url('assets/wheel.gltf'), bundle.url('assets/wheel.bin')]);
  });

  it('is fetched as written when the bundle has no such file', async () => {
    const bundle = fakeBundle({});
    // As written is against the page's own address, where a deployment that
    // serves its files beside the page has them. A browser reads a path that
    // way; Node's Request refuses one, so here a request is what it was
    // asked for and no more.
    vi.stubGlobal(
      'Request',
      class {
        constructor(public url: string) {}
      }
    );
    const fetched = stubFetch({
      'models/served.gltf': () => gltfNeeding('served.bin'),
      'models/served.bin': () => triangleBytes(),
    });
    act(() =>
      root.render(
        inApp(
          bundle.assets,
          <Scene3D objects={[{ id: 'served', type: 'model', modelUrl: 'models/served.gltf' }]} onModelState={onModelState} />
        )
      )
    );
    await waitFor(settled('served'), 'the model to settle');
    expect(bundle.asked).toContain('models/served.gltf');
    expect(fetched.calls).toEqual(['models/served.gltf', 'models/served.bin']);
    expect(last('served')?.state).toBe('loaded');
  });

  it('is not offered to the resolver when it names a place of its own', async () => {
    const bundle = fakeBundle({});
    stubFetch({});
    const objects: Scene3DObject[] = [
      { id: 'web', type: 'model', modelUrl: 'https://models.test/a.gltf' },
      { id: 'data', type: 'model', modelUrl: 'data:model/gltf+json,{}' },
      // Another host, written without its scheme: no path of the bundle's.
      { id: 'elsewhere', type: 'model', modelUrl: '//models.test/b.gltf' },
    ];
    act(() => root.render(inApp(bundle.assets, <Scene3D objects={objects} onModelState={onModelState} />, {
      consentPending: false,
      permissions: { net: { enabled: true } },
    })));
    await waitFor(() => settled('web')() && settled('data')(), 'the models to settle');
    expect(bundle.asked).toEqual([]);
  });

  it('is still judged by the permission policy, whatever the resolver answers with', async () => {
    // A host whose files are on the network: what it answers is an address
    // like any other, and this app was granted no network.
    const assets = ((path: string) => `https://cdn.host.test/${path}`) as AppAssetResolver;
    const fetched = stubFetch({ 'https://cdn.host.test/assets/robot.gltf': () => gltfNeeding('robot.bin') });
    const scene = (capability: CapabilityState) =>
      act(() =>
        root.render(
          inApp(
            assets,
            <Scene3D objects={[{ id: 'robot', type: 'model', modelUrl: 'assets/robot.gltf' }]} onModelState={onModelState} />,
            capability
          )
        )
      );
    scene({ consentPending: false, permissions: {} });
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
    expect(fetched.calls).toEqual([]);
    expect(states).toEqual([]);
    // Withheld, it is drawn as a model with no URL is: not at all. It used to be a one-unit box.
    const withheld = nodeById('robot') as THREE.Mesh;
    expect(withheld.isMesh).toBeUndefined();
    expect(withheld.children).toHaveLength(0);

    // Granted that host, it is fetched from where the resolver said.
    scene({ consentPending: false, permissions: { net: { enabled: true, allowed_hosts: ['cdn.host.test'] } as { enabled: boolean } } });
    await waitFor(() => fetched.calls.length > 0, 'the fetch');
    expect(fetched.calls[0]).toBe('https://cdn.host.test/assets/robot.gltf');
  });
});

describe('a texture named by its path in the bundle', () => {
  it('is the bundle’s file, on a top-level object and on a group’s child; an unknown path is as written', () => {
    const bundle = fakeBundle({ 'assets/crate.png': 'png', 'assets/label.png': 'png' });
    const loaded: string[] = [];
    vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(function (url: string) {
      loaded.push(url);
      return new THREE.Texture();
    });
    act(() =>
      root.render(
        inApp(
          bundle.assets,
          <Scene3D
            objects={[
              { id: 'crate', type: 'box', textureUrl: 'assets/crate.png' },
              { id: 'shelf', type: 'group', children: [{ id: 'label', type: 'plane', textureUrl: 'assets/label.png' }] },
              { id: 'floor', type: 'plane', textureUrl: 'images/served.png' },
            ]}
          />
        )
      )
    );
    expect(loaded).toEqual([bundle.url('assets/crate.png'), bundle.url('assets/label.png'), 'images/served.png']);
    expect(((nodeById('crate') as THREE.Mesh).material as THREE.MeshStandardMaterial).map).not.toBeNull();
  });

  it('withheld by the policy is no texture at all', () => {
    const assets = ((path: string) => `https://cdn.host.test/${path}`) as AppAssetResolver;
    const load = vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(() => new THREE.Texture());
    act(() =>
      root.render(inApp(assets, <Scene3D objects={[{ id: 'crate', type: 'box', textureUrl: 'assets/crate.png' }]} />))
    );
    expect(load).not.toHaveBeenCalled();
    expect(((nodeById('crate') as THREE.Mesh).material as THREE.MeshStandardMaterial).map).toBeNull();
  });
});

describe('an object whose path was turned into the bundle’s file', () => {
  it('comes out the same object each time, so scenery handed over unchanged is still seen to be unchanged', () => {
    const bundle = fakeBundle({ 'assets/label.png': 'png' });
    const load = vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(() => new THREE.Texture());
    const shelf: Scene3DObject = {
      id: 'shelf',
      type: 'group',
      children: [{ id: 'label', type: 'plane', textureUrl: 'assets/label.png', position: { x: 1, y: 0, z: 0 } }],
    };
    // What the host publishes stands still between renders, as a host's does.
    const scope = { appId: 'app-paths', xdb: {} as XDBService, active: true, assets: bundle.assets };
    const capability: CapabilityState = { consentPending: false, permissions: {} };
    const scene = (tick: number) =>
      act(() =>
        root.render(
          <AppScopeProvider value={scope}>
            <CapabilityProvider value={capability}>
              <Scene3D staticObjects={[shelf]} objects={[{ id: 'mover', type: 'box', position: { x: tick, y: 0, z: 0 } }]} />
            </CapabilityProvider>
          </AppScopeProvider>
        )
      );
    scene(0);
    const label = nodeById('label') as THREE.Mesh;
    const material = label.material;
    // A child whose spec is the same object as last time is not looked at:
    // moved by hand, it stays moved.
    label.position.x = 9;
    scene(1);
    scene(2);
    expect(nodeById('label')).toBe(label);
    expect(label.position.x).toBe(9);
    expect(label.material).toBe(material);
    expect(load).toHaveBeenCalledOnce();
  });
});
