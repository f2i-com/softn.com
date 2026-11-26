/**
 * The third round of the threed audit: what was still wrong after the long
 * list of earlier fixes, each pinned by a test that failed before its fix.
 *
 * Every app mounts under StrictMode (core's strict-mode-mount test), which in
 * a development build runs each effect, takes it down and runs it again: the
 * scene's canvas, renderer and three.js scene are made twice, and whatever the
 * second scene is not given again is missing from it.
 *
 * The renderer is the GPU-less stand-in the other Scene3D suites use; a model
 * is held open at the glTF loader's `parse` until a test settles it.
 */

import { StrictMode, act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

type Parsed = { scene: import('three').Object3D; animations: import('three').AnimationClip[] };
type Pending = { resolve: (value: Parsed) => void; reject: (error: unknown) => void };
const parses = vi.hoisted(() => new Map<string, Pending[]>());

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  const { TestWebGLRenderer } = await import('./scene3d-doubles');
  return { ...actual, WebGLRenderer: TestWebGLRenderer };
});

// Each fixture's JSON carries a `name`; the mock files the parse under it.
vi.mock('three/addons/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    setMeshoptDecoder() {}
    parse(data: ArrayBuffer, _path: string, resolve: Pending['resolve'], reject: Pending['reject']) {
      const { name } = JSON.parse(new TextDecoder().decode(data)) as { name: string };
      const list = parses.get(name) ?? [];
      list.push({ resolve, reject });
      parses.set(name, list);
    }
  },
}));

import * as THREE from 'three';
import type { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { Scene3D, type Scene3DObject, type Scene3DProps } from '../src/threed/Scene3D';
import type { EffectsRig } from '../src/threed/effects';
import { modelTemplateCache } from '../src/threed/model-cache';
import { applyModelAppearance } from '../src/threed/model-appearance';
import { SceneNodes } from '../src/threed/scene-nodes';
import { stubFetch, stubFrames, tick, waitFor, type FrameStub } from './scene3d-doubles';

// URLs and fixture names carry the test's number: the template cache is
// page-wide, and a load one test left in flight must not be the one the next joins.
let run = 0;
const fixture = (name: string) => JSON.stringify({ asset: { version: '2.0' }, name: `${run}/${name}` });
const url = (name: string) => `https://models.test/r3/${run}/${name}.gltf`;
const parsing = (name: string) => () => (parses.get(`${run}/${name}`)?.length ?? 0) > 0;
/** Every parse waiting for `name`, taken. */
const takeParses = (name: string): Pending[] => {
  const list = parses.get(`${run}/${name}`) ?? [];
  parses.set(`${run}/${name}`, []);
  return list;
};

type Handles = HTMLCanvasElement & {
  __softnScene: THREE.Scene;
  __softnEffects: () => EffectsRig | null;
};

let container: HTMLDivElement;
let root: Root;
let frames: FrameStub;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  run += 1;
  parses.clear();
  frames = stubFrames();
  stubFetch({
    [url('a')]: () => fixture('a'),
    [url('b')]: () => fixture('b'),
    [url('c')]: () => fixture('c'),
  });
  modelTemplateCache.clearIdle();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.devicePixelRatio = 1;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const canvasOf = (): Handles => container.querySelector('canvas') as Handles;
const sceneOf = (): THREE.Scene => canvasOf().__softnScene;

describe('a scene made twice, as StrictMode makes it', () => {
  it('keeps its fog', () => {
    act(() =>
      root.render(
        <StrictMode>
          <Scene3D fog={{ color: '#223344', near: 2, far: 40 }} />
        </StrictMode>
      )
    );
    expect(container.querySelectorAll('canvas')).toHaveLength(1);
    const fog = sceneOf().fog as THREE.Fog | null;
    expect(fog).toBeInstanceOf(THREE.Fog);
    expect(fog?.far).toBe(40);
  });

  it('says its assets are ready once a model in a group has loaded', async () => {
    const events: string[] = [];
    const objects: Scene3DObject[] = [
      { id: 'solo', type: 'model', modelUrl: url('b') },
      { id: 'car', type: 'group', children: [{ id: 'body', type: 'model', modelUrl: url('a') }] },
    ];
    act(() =>
      root.render(
        <StrictMode>
          <Scene3D objects={objects} onAssetsReady={() => events.push('assets')} onFirstFrame={() => events.push('first frame')} />
        </StrictMode>
      )
    );
    await waitFor(parsing('a'), 'the group’s model to reach the loader');
    await waitFor(parsing('b'), 'the top-level model to reach the loader');
    await act(async () => {
      for (const pending of [...takeParses('a'), ...takeParses('b')]) pending.resolve({ scene: new THREE.Group(), animations: [] });
      await tick();
    });
    expect(events).toEqual(['assets']);
    // The stand-in's cancel does nothing, so the first scene's loop is still in the queue: it draws nothing.
    for (let i = 0; i < 3; i++) act(() => frames.runFrame());
    expect(events).toEqual(['assets', 'first frame']);
  });
});

describe('bloom', () => {
  it('is drawn at the scene’s CSS size from the first frame, as it is after a resize', async () => {
    // A screen of two device pixels to the CSS pixel.
    window.devicePixelRatio = 2;
    act(() => root.render(<Scene3D effects={{ bloom: true }} />));
    await waitFor(() => canvasOf().__softnEffects() !== null, 'the chain to be built');
    const rig = canvasOf().__softnEffects() as EffectsRig;
    const bloom = rig.bloom as UnrealBloomPass;
    const asBuilt = [bloom.renderTargetBright.width, bloom.renderTargetBright.height];
    // The same box again, as a resize to the size it already had.
    rig.setSize(300, 150);
    const afterResize = [bloom.renderTargetBright.width, bloom.renderTargetBright.height];
    expect(afterResize).toEqual([150, 75]);
    expect(asBuilt).toEqual(afterResize);
  });
});

describe('a model’s clip', () => {
  /** A model whose node `arm` its clip `wave` moves one unit along x over a second. */
  const waving = (): Parsed => {
    const scene = new THREE.Group();
    const arm = new THREE.Object3D();
    arm.name = 'arm';
    scene.add(arm);
    const track = new THREE.VectorKeyframeTrack('arm.position', [0, 1], [0, 0, 0, 1, 0, 0]);
    return { scene, animations: [new THREE.AnimationClip('wave', 1, [track])] };
  };
  const show = (animation: Scene3DObject['animation']) =>
    act(() => root.render(<Scene3D objects={[{ id: 'm', type: 'model', modelUrl: url('c'), animation }]} />));
  const arm = () => sceneOf().getObjectByName('arm') as THREE.Object3D;

  it('goes on playing once a speed that is not a number is put right', async () => {
    // The scene's clock, a tenth of a second a frame.
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const step = () => {
      now += 100;
      act(() => frames.runFrame(now));
    };
    // Logic that divided by nothing for a moment (a walk cycle at speed / topSpeed, with no top speed yet).
    show({ clip: 'wave', speed: Number.NaN });
    await waitFor(parsing('c'), 'the model to reach the loader');
    await act(async () => {
      for (const pending of takeParses('c')) pending.resolve(waving());
      await tick();
    });
    for (let i = 0; i < 3; i++) step();
    show({ clip: 'wave', speed: 1 });
    step();
    const before = arm().position.x;
    step();
    const after = arm().position.x;
    // A tenth of a second of a one-second clip further on, and not stuck at its last key.
    expect(after).not.toBe(before);
    expect(after).toBeLessThan(1);
  });
});

describe('a camera eased by cameraSmoothing', () => {
  it('comes back from a place that was not a number once it is given one that is', () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const step = (frames_: number) => {
      for (let i = 0; i < frames_; i++) {
        now += 16;
        act(() => frames.runFrame(now));
      }
    };
    const show = (x: number) =>
      act(() =>
        root.render(<Scene3D cameraSmoothing={0.3} camera={{ position: { x, y: 2, z: 8 }, lookAt: { x: 0, y: 0, z: 0 } }} />)
      );
    // Updates further apart than a game loop's ticks, so the camera is eased by `cameraSmoothing` itself.
    show(0);
    step(12);
    // Logic that divided by nothing, once.
    show(Number.NaN);
    step(12);
    show(3);
    step(90);
    const cam = (canvasOf() as Handles & { __softnCamera: THREE.PerspectiveCamera }).__softnCamera;
    expect(cam.position.x).toBeCloseTo(3, 3);
    expect(Number.isFinite(cam.quaternion.x)).toBe(true);
  });
});

describe('a torch the camera stops carrying', () => {
  it('aims where a spot light that is not carried aims, as a light that stops following does', () => {
    const torch = (carried: boolean): Scene3DProps['lights'] => [
      { id: 'torch', type: 'spot', position: { x: 0, y: 4, z: 0 }, ...(carried ? { attach: 'camera' as const } : {}) },
    ];
    const camera = { position: { x: 5, y: 2, z: 5 }, lookAt: { x: 9, y: 2, z: 9 } };
    act(() => root.render(<Scene3D lights={torch(true)} camera={camera} />));
    for (let i = 0; i < 2; i++) act(() => frames.runFrame());
    const light = sceneOf().children.find((node) => (node as THREE.SpotLight).isSpotLight) as THREE.SpotLight;
    // Carried, it shines where the camera looks.
    expect(light.target.position.length()).toBeGreaterThan(1);
    act(() => root.render(<Scene3D lights={torch(false)} camera={camera} />));
    for (let i = 0; i < 2; i++) act(() => frames.runFrame());
    expect(light.position.toArray()).toEqual([0, 4, 0]);
    expect(light.target.position.toArray()).toEqual([0, 0, 0]);
  });
});

describe('mouse look let go', () => {
  afterEach(() => {
    delete (window as Window & { __scene3dYaw?: number }).__scene3dYaw;
    delete (window as Window & { __scene3dPitch?: number }).__scene3dPitch;
  });

  it('leaves the view facing the way it faces, after the kind of camera changed under it', () => {
    const sceneWindow = window as Window & { __scene3dYaw?: number };
    const show = (type: 'perspective' | 'orthographic', mouseLook: boolean) =>
      act(() =>
        root.render(
          <Scene3D
            mouseLook={mouseLook}
            cameraSmoothing={0.2}
            jumpDistance={0}
            camera={{ type, position: { x: 0, y: 0, z: 8 }, lookAt: { x: 0, y: 0, z: 0 } }}
          />
        )
      );
    show('perspective', true);
    // Turned to face +x, then the plan view, then turned on to face +z.
    sceneWindow.__scene3dYaw = Math.PI / 2;
    act(() => frames.runFrame());
    show('orthographic', true);
    sceneWindow.__scene3dYaw = 0;
    act(() => frames.runFrame());
    const cam = () => (canvasOf() as Handles & { __softnCamera: THREE.Camera }).__softnCamera;
    const facing = () => cam().getWorldDirection(new THREE.Vector3());
    expect(facing().z).toBeCloseTo(1, 5);
    show('orthographic', false);
    act(() => frames.runFrame());
    // Turned from where it faced toward its `lookAt`: one frame on, still about where it faced.
    expect(facing().z).toBeGreaterThan(0.99);
  });
});

describe('a scene shown full screen', () => {
  it('follows the screen when it changes shape, as a phone turned on its side does', () => {
    act(() => root.render(<Scene3D expandable width={400} height={300} />));
    const renderer = (canvasOf() as Handles & { __softnRenderer: { sizes: Array<[number, number]> } }).__softnRenderer;
    const cam = (canvasOf() as Handles & { __softnCamera: THREE.PerspectiveCamera }).__softnCamera;
    const wrapper = container.firstElementChild;
    const descriptor = Object.getOwnPropertyDescriptor(document, 'fullscreenElement');
    const inner = { width: window.innerWidth, height: window.innerHeight };
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => wrapper });
    try {
      window.innerWidth = 390;
      window.innerHeight = 844;
      act(() => document.dispatchEvent(new Event('fullscreenchange')));
      expect(renderer.sizes.at(-1)).toEqual([390, 844]);
      // Turned on its side.
      window.innerWidth = 844;
      window.innerHeight = 390;
      act(() => window.dispatchEvent(new Event('resize')));
      expect(renderer.sizes.at(-1)).toEqual([844, 390]);
      expect(cam.aspect).toBeCloseTo(844 / 390, 6);
    } finally {
      if (descriptor) Object.defineProperty(document, 'fullscreenElement', descriptor);
      else delete (document as unknown as { fullscreenElement?: unknown }).fullscreenElement;
      window.innerWidth = inner.width;
      window.innerHeight = inner.height;
    }
  });
});

describe('what the render loop does on a frame', () => {
  /** A model of `count` meshes that each have one morph target, as a face exported with its shapes has. */
  const faces = (count: number): THREE.Group => {
    const root = new THREE.Group();
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
      mesh.morphTargetDictionary = { smile: 0 };
      mesh.morphTargetInfluences = [0.25];
      root.add(mesh);
    }
    return root;
  };

  it('writes nothing for the morphs of a model whose appearance names none', () => {
    const root = faces(20);
    applyModelAppearance(root, undefined, 1 / 60);
    const writes = vi.spyOn(Map.prototype, 'set');
    for (let frame = 0; frame < 60; frame++) applyModelAppearance(root, undefined, 1 / 60);
    const counted = writes.mock.calls.length;
    writes.mockRestore();
    expect(counted).toBe(0);
    // And the file's own weights are where they were.
    root.traverse((node) => {
      if ((node as THREE.Mesh).isMesh) expect((node as THREE.Mesh).morphTargetInfluences).toEqual([0.25]);
    });
  });

  it('still writes the morphs an appearance names, and gives them back when it no longer names them', () => {
    const root = faces(2);
    applyModelAppearance(root, { morphs: { smile: 1 } }, 1 / 60);
    const meshes = root.children as THREE.Mesh[];
    expect(meshes.map((mesh) => mesh.morphTargetInfluences?.[0])).toEqual([1, 1]);
    applyModelAppearance(root, {}, 1 / 60);
    expect(meshes.map((mesh) => mesh.morphTargetInfluences?.[0])).toEqual([0.25, 0.25]);
    applyModelAppearance(root, { morphs: { smile: 0.5 }, morphSmoothingMs: { smile: 100 } }, 1 / 60);
    const eased = meshes[0].morphTargetInfluences?.[0] as number;
    expect(eased).toBeGreaterThan(0.25);
    expect(eased).toBeLessThan(0.5);
  });
});

describe('a scene with no `objects`', () => {
  const scenery: Scene3DObject[] = [
    { id: 'ground', type: 'plane', width: 20, height: 20 },
    { id: 'rock', type: 'box', position: { x: 2, y: 0.5, z: 0 } },
  ];
  const props: Scene3DProps = { staticObjects: scenery };

  it('is not reconciled again when the page is drawn again with the same scenery', () => {
    act(() => root.render(<Scene3D {...props} />));
    expect(sceneOf().getObjectByProperty('type', 'Mesh')).toBeDefined();
    const reconciles = vi.spyOn(SceneNodes.prototype, 'changed');
    for (let i = 0; i < 10; i++) act(() => root.render(<Scene3D {...props} />));
    expect(reconciles).toHaveBeenCalledTimes(0);
    // New scenery is still drawn.
    act(() => root.render(<Scene3D staticObjects={[...scenery, { id: 'tree', type: 'cone' }]} />));
    expect(reconciles).toHaveBeenCalledTimes(1);
    expect(sceneOf().children.filter((node) => node.userData.__softnId === 'tree')).toHaveLength(1);
  });
});
