/**
 * Nine things the scene got wrong, each held here to what it now does:
 *
 * - a group's `castShadow` and `receiveShadow` were written over every
 *   child's own;
 * - a light's `castShadow`, its shadow map's size and its near and far
 *   distances were read when the light was made and not again;
 * - a top-level `model` with no file to load was drawn as a box, and the box
 *   made anew on every reconcile;
 * - an object that stopped being attached to the camera kept the raised
 *   draw order and the switched-off depth test;
 * - `cameraSmoothing` pulled the camera back toward `camera.position` while
 *   the person steered it with orbit controls;
 * - (particles with no `opacity` are drawn solid, as they always were: making them see-through
 *   was tried here and taken back, since it changes every cloud made so far);
 * - a mesh hidden by `appearance.hiddenMeshes` still took clicks;
 * - `onPointerMove` cast a ray and called the app for every move of the
 *   mouse;
 * - `onHoverChange` said nothing when the object under a pointer at rest
 *   was taken out of the scene.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createRoot, type Root } from 'react-dom/client';
import {
  Scene3D,
  type Scene3DHit,
  type Scene3DLight,
  type Scene3DModelStateInfo,
  type Scene3DObject,
  type Scene3DProps,
} from '../src/threed/Scene3D';
import { pickTargets } from '../src/threed/picking';
import { placeCanvas, pointerEvent, stubFetch, stubFrames, waitFor, type FrameStub } from './scene3d-doubles';

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  const { TestWebGLRenderer } = await import('./scene3d-doubles');
  return { ...actual, WebGLRenderer: TestWebGLRenderer };
});

let container: HTMLDivElement;
let root: Root;
let frames: FrameStub;
let now = 0;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  frames = stubFrames();
  now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Canvas = HTMLCanvasElement & {
  __softnScene: THREE.Scene;
  __softnCamera: THREE.PerspectiveCamera;
  __softnControls: () => OrbitControls | null;
};
const canvasOf = () => container.querySelector('canvas') as Canvas;
const v = (x: number, y: number, z: number) => ({ x, y, z });
const show = (props: Partial<Scene3DProps>) => act(() => root.render(<Scene3D lights={[]} {...props} />));
function nodeById<T extends THREE.Object3D = THREE.Mesh>(id: string): T {
  let found: THREE.Object3D | undefined;
  canvasOf().__softnScene.traverse((node) => {
    if (!found && node.userData.__softnId === id) found = node;
  });
  return found as T;
}
function frame(ms = 16): void {
  now += ms;
  act(() => frames.runFrame(now));
}
/** Run every frame asked for so far, and no frame those frames ask for. */
function runFrames(): void {
  act(() => {
    for (let pending = frames.frames.length; pending > 0; pending--) frames.runFrame(now);
  });
}

describe('shadows in a group', () => {
  const shadows = (id: string) => [nodeById(id).castShadow, nodeById(id).receiveShadow];

  it('a child that says for itself keeps its own; one that does not takes its group’s', () => {
    const scene = (roofCasts: boolean): Scene3DObject[] => [
      {
        id: 'car',
        type: 'group',
        castShadow: true,
        receiveShadow: true,
        children: [
          { id: 'body', type: 'box' },
          { id: 'glass', type: 'box', castShadow: false },
          { id: 'decal', type: 'plane', castShadow: false, receiveShadow: false },
        ],
      },
      {
        id: 'shed',
        type: 'group',
        children: [
          { id: 'roof', type: 'box', castShadow: roofCasts, receiveShadow: true },
          { id: 'wall', type: 'box' },
        ],
      },
    ];
    show({ objects: scene(true) });
    expect(shadows('body')).toEqual([true, true]);
    expect(shadows('glass')).toEqual([false, true]);
    expect(shadows('decal')).toEqual([false, false]);
    // A child of a group that casts none casts its own.
    expect(shadows('roof')).toEqual([true, true]);
    expect(shadows('wall')).toEqual([false, false]);

    // And it is still so after the group is brought up to date.
    show({ objects: scene(false) });
    expect(shadows('roof')).toEqual([false, true]);
    expect(shadows('body')).toEqual([true, true]);
    expect(shadows('glass')).toEqual([false, true]);
  });

  it('a group in a group passes on what it was given, or what it says itself', () => {
    const scene = (inner: Partial<Scene3DObject>): Scene3DObject[] => [
      {
        id: 'train',
        type: 'group',
        castShadow: true,
        children: [{ id: 'bogie', type: 'group', ...inner, children: [{ id: 'wheel', type: 'cylinder' }] }],
      },
    ];
    show({ objects: scene({}) });
    expect(nodeById('wheel').castShadow).toBe(true);
    show({ objects: scene({ castShadow: false }) });
    expect(nodeById('wheel').castShadow).toBe(false);
    // What a child once said and no longer says is its group's again.
    show({ objects: scene({}) });
    expect(nodeById('wheel').castShadow).toBe(true);
  });

  it('a top-level object is as it says, and casts none when it says nothing, as before', () => {
    show({ objects: [{ id: 'a', type: 'box', castShadow: true }, { id: 'b', type: 'box' }] });
    expect(shadows('a')).toEqual([true, false]);
    expect(shadows('b')).toEqual([false, false]);
  });
});

describe('a light’s shadows, after the light is made', () => {
  const sun = (extra: Partial<Scene3DLight>): Scene3DLight => ({ id: 'sun', type: 'directional', position: v(5, 10, 5), ...extra });
  const lightOf = <T extends THREE.Light>() => {
    let found: THREE.Light | undefined;
    canvasOf().__softnScene.traverse((node) => {
      if ((node as THREE.Light).isLight && !(node as THREE.AmbientLight).isAmbientLight) found = node as THREE.Light;
    });
    return found as T;
  };
  const same = (a: THREE.Matrix4, b: THREE.Matrix4) => a.elements.every((value, i) => Math.abs(value - b.elements[i]) < 1e-9);

  it('castShadow goes on and off', () => {
    show({ lights: [sun({})] });
    const light = lightOf<THREE.DirectionalLight>();
    expect(light.castShadow).toBe(false);
    show({ lights: [sun({ castShadow: true })] });
    expect(lightOf()).toBe(light);
    expect(light.castShadow).toBe(true);
    show({ lights: [sun({ castShadow: false })] });
    expect(light.castShadow).toBe(false);

    show({ lights: [{ id: 'lamp', type: 'point' }, { id: 'torch', type: 'spot' }] });
    const kinds = () => {
      const found: THREE.Light[] = [];
      canvasOf().__softnScene.traverse((node) => {
        if ((node as THREE.Light).isLight) found.push(node as THREE.Light);
      });
      return found.map((l) => l.castShadow);
    };
    expect(kinds()).toEqual([false, false]);
    show({ lights: [{ id: 'lamp', type: 'point', castShadow: true }, { id: 'torch', type: 'spot', castShadow: true }] });
    expect(kinds()).toEqual([true, true]);
  });

  it('the box its shadows are drawn in follows its size, near and far, and is what scenes always got when none is given', () => {
    // No size: 15 each way, from 0.5 to 150 deep, as it always was. The released code wrote
    // these to the light and never asked for the box to be worked out; three does that itself
    // when it first makes the light's shadow map (WebGLShadowMap), which the renderer here
    // never does. Found by review in a real browser, 2026-11-13, after this default had been
    // taken for three's own 5 and 500, which left everything further out than 5 with no shadow.
    show({ lights: [sun({ castShadow: true })] });
    const light = lightOf<THREE.DirectionalLight>();
    expect(same(light.shadow.camera.projectionMatrix, new THREE.OrthographicCamera(-15, 15, 15, -15, 0.5, 150).projectionMatrix)).toBe(true);
    expect(light.shadow.mapSize.toArray()).toEqual([1024, 1024]);
    expect(light.shadow.bias).toBe(-0.0005);

    // A size and nothing else: the same depth.
    show({ lights: [sun({ castShadow: true, shadowCameraSize: 25 })] });
    expect(same(light.shadow.camera.projectionMatrix, new THREE.OrthographicCamera(-25, 25, 25, -25, 0.5, 150).projectionMatrix)).toBe(true);
    // And the size taken away is the first box again.
    show({ lights: [sun({ castShadow: true })] });
    expect(same(light.shadow.camera.projectionMatrix, new THREE.OrthographicCamera(-15, 15, 15, -15, 0.5, 150).projectionMatrix)).toBe(true);
    // A size that is none, and a depth that ends before it begins, are not taken.
    show({ lights: [sun({ castShadow: true, shadowCameraSize: 0, shadowNear: Number.NaN, shadowFar: -4 })] });
    expect(light.shadow.camera.projectionMatrix.elements.every(Number.isFinite)).toBe(true);
    expect([light.shadow.camera.left, light.shadow.camera.near]).toEqual([-15, 0.5]);
    expect(light.shadow.camera.far).toBeGreaterThan(light.shadow.camera.near);

    show({ lights: [sun({ castShadow: true, shadowCameraSize: 40, shadowNear: 2, shadowFar: 90, shadowBias: -0.001 })] });
    expect(lightOf()).toBe(light);
    expect(same(light.shadow.camera.projectionMatrix, new THREE.OrthographicCamera(-40, 40, 40, -40, 2, 90).projectionMatrix)).toBe(true);
    expect(light.shadow.bias).toBe(-0.001);

    // Near and far alone, which changed nothing before.
    show({ lights: [sun({ castShadow: true, shadowCameraSize: 40, shadowNear: 5, shadowFar: 60 })] });
    expect(same(light.shadow.camera.projectionMatrix, new THREE.OrthographicCamera(-40, 40, 40, -40, 5, 60).projectionMatrix)).toBe(true);
  });

  it('a point or spot light’s map size, bias, near and far are applied too, and are three’s own when not given', () => {
    // They were a sun's alone: a lamp's `shadowMapSize` was read by nothing.
    for (const type of ['point', 'spot'] as const) {
      show({ lights: [{ id: 'lamp', type, castShadow: true }] });
      const lamp = lightOf<THREE.PointLight | THREE.SpotLight>();
      const made = type === 'point' ? new THREE.PointLight() : new THREE.SpotLight();
      const own = made.shadow.camera as THREE.PerspectiveCamera;
      const cam = lamp.shadow.camera as THREE.PerspectiveCamera;
      // Nothing said: as three makes one, which is what a lamp's shadows always were.
      expect(lamp.shadow.mapSize.toArray()).toEqual(made.shadow.mapSize.toArray());
      expect(lamp.shadow.bias).toBe(made.shadow.bias);
      expect([cam.near, cam.far]).toEqual([own.near, own.far]);

      show({ lights: [{ id: 'lamp', type, castShadow: true, shadowMapSize: 2048, shadowBias: -0.002, shadowNear: 0.1, shadowFar: 40 }] });
      expect(lightOf()).toBe(lamp);
      expect(lamp.shadow.mapSize.toArray()).toEqual([2048, 2048]);
      expect(lamp.shadow.bias).toBe(-0.002);
      expect([cam.near, cam.far]).toEqual([0.1, 40]);
      expect(same(cam.projectionMatrix, new THREE.PerspectiveCamera(cam.fov, cam.aspect, 0.1, 40).projectionMatrix)).toBe(true);

      // Taken away again, they are three's own again.
      show({ lights: [{ id: 'lamp', type, castShadow: true }] });
      expect(lamp.shadow.mapSize.toArray()).toEqual(made.shadow.mapSize.toArray());
      expect(lamp.shadow.bias).toBe(made.shadow.bias);
      expect([cam.near, cam.far]).toEqual([own.near, own.far]);

      // A light with a reach draws its shadows that far, which three sees to: `shadowFar` is left alone.
      show({ lights: [{ id: 'lamp', type, castShadow: true, distance: 12, shadowFar: 40 }] });
      expect(cam.far).toBe(own.far);

      // A lamp's shadows are drawn through a lens: a nearest of nothing or less has no picture.
      // Found by review, 2026-11-13: it was applied as given, and the picture was all NaN.
      for (const [shadowNear, shadowFar] of [[0, 40], [-1, 40], [Number.NaN, 40], [0.5, 0.2], [0.5, Number.POSITIVE_INFINITY]] as const) {
        show({ lights: [{ id: 'lamp', type, castShadow: true, shadowNear, shadowFar }] });
        expect(cam.near, `${shadowNear}, ${shadowFar}`).toBeGreaterThan(0);
        expect(cam.far, `${shadowNear}, ${shadowFar}`).toBeGreaterThan(cam.near);
        expect(cam.projectionMatrix.elements.every(Number.isFinite), `${shadowNear}, ${shadowFar}`).toBe(true);
      }
      show({ lights: [] });
    }
  });

  it('a map the device made smaller than was asked is kept, not made again on every update', () => {
    // Found by review, 2026-11-13. three writes the size it could make back into
    // `shadow.mapSize`; held against that, a size the device could not give was "another size"
    // every time the lights were handed over: five maps thrown away in five updates.
    show({ lights: [{ id: 'lamp', type: 'point', castShadow: true, shadowMapSize: 4096 }] });
    const lamp = lightOf<THREE.PointLight>();
    expect(lamp.shadow.mapSize.toArray()).toEqual([4096, 4096]);
    // What three does when it first draws the light on a device whose largest texture is 4096
    // (a point light's map is four frames by two): it makes the map smaller and says so.
    lamp.shadow.mapSize.set(1024, 2048);
    const map = new THREE.WebGLRenderTarget(4096, 4096);
    const dispose = vi.spyOn(map, 'dispose');
    lamp.shadow.map = map;
    for (let update = 0; update < 5; update++) show({ lights: [{ id: 'lamp', type: 'point', castShadow: true, shadowMapSize: 4096, intensity: 1 + update }] });
    expect(dispose).not.toHaveBeenCalled();
    expect(lamp.shadow.map).toBe(map);
    // Another size asked for is another map, as before.
    show({ lights: [{ id: 'lamp', type: 'point', castShadow: true, shadowMapSize: 512 }] });
    expect(dispose).toHaveBeenCalledOnce();
    expect(lamp.shadow.mapSize.toArray()).toEqual([512, 512]);
    // And a size that is none is the light's usual one.
    show({ lights: [{ id: 'lamp', type: 'point', castShadow: true, shadowMapSize: Number.NaN }] });
    expect(lamp.shadow.mapSize.toArray()).toEqual([512, 512]);
  });

  it('a new map size is a new map: the old one is let go, for three.js to make one of the new size', () => {
    show({ lights: [sun({ castShadow: true })] });
    const light = lightOf<THREE.DirectionalLight>();
    // As it is once a frame has been drawn with shadows on.
    const map = new THREE.WebGLRenderTarget(1024, 1024);
    const dispose = vi.spyOn(map, 'dispose');
    light.shadow.map = map;
    show({ lights: [sun({ castShadow: true, shadowMapSize: 2048 })] });
    expect(light.shadow.mapSize.toArray()).toEqual([2048, 2048]);
    expect(dispose).toHaveBeenCalledOnce();
    expect(light.shadow.map).toBeNull();

    // The same size again leaves the map it has.
    const second = new THREE.WebGLRenderTarget(2048, 2048);
    light.shadow.map = second;
    show({ lights: [sun({ castShadow: true, shadowMapSize: 2048, intensity: 3 })] });
    expect(light.shadow.map).toBe(second);
    // And a light that stops casting has no use for it.
    const let_go = vi.spyOn(second, 'dispose');
    show({ lights: [sun({ castShadow: false })] });
    expect(let_go).toHaveBeenCalledOnce();
    expect(light.shadow.map).toBeNull();
  });
});

describe('a top-level model with no file to load', () => {
  it('is nothing to draw, and is the same node from one reconcile to the next', () => {
    const states: Scene3DModelStateInfo[] = [];
    const onModelState = (info: Scene3DModelStateInfo) => states.push(info);
    const geometries = vi.spyOn(THREE.BoxGeometry.prototype, 'dispose');
    show({ objects: [{ id: 'robot', type: 'model', position: v(1, 0, 0) }], onModelState });
    const node = nodeById<THREE.Group>('robot');
    expect((node as unknown as THREE.Mesh).isMesh).toBeUndefined();
    expect(node.children).toHaveLength(0);
    expect(node.position.x).toBe(1);

    for (let i = 2; i < 6; i++) show({ objects: [{ id: 'robot', type: 'model', position: v(i, 0, 0) }], onModelState });
    expect(nodeById('robot')).toBe(node);
    expect(node.position.x).toBe(5);
    // It was a box, thrown away and made again each time.
    expect(geometries).not.toHaveBeenCalled();
    expect(states).toEqual([]);
  });

  it('is loaded once it names a file, and is nothing again when it no longer does', () => {
    stubFetch({});
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const states: Scene3DModelStateInfo[] = [];
    const onModelState = (info: Scene3DModelStateInfo) => states.push(info);
    show({ objects: [{ id: 'robot', type: 'model' }], onModelState });
    const empty = nodeById('robot');
    show({ objects: [{ id: 'robot', type: 'model', modelUrl: 'https://models.test/robot.glb' }], onModelState });
    expect(states).toEqual([{ objectId: 'robot', state: 'pending', attempt: 1 }]);
    expect(nodeById('robot')).not.toBe(empty);
    expect(empty.parent).toBeNull();

    show({ objects: [{ id: 'robot', type: 'model' }], onModelState });
    expect(nodeById('robot').children).toHaveLength(0);
    // A shape takes its place as it would any object's.
    show({ objects: [{ id: 'robot', type: 'box' }], onModelState });
    expect(nodeById('robot').isMesh).toBe(true);
  });
});

describe('an object that is no longer attached to the camera', () => {
  const gun = (extra: Partial<Scene3DObject>): Scene3DObject => ({ id: 'gun', type: 'box', ...extra });

  it('is drawn in its turn and behind what is in front of it again', () => {
    show({ objects: [gun({ attach: 'camera', position: v(0.3, -0.2, -0.5) })] });
    const node = nodeById('gun');
    const material = node.material as THREE.MeshStandardMaterial;
    frame();
    expect(node.renderOrder).toBe(1000);
    expect([material.depthTest, material.depthWrite]).toEqual([false, false]);

    show({ objects: [gun({ position: v(1, 2, 3) })] });
    expect(nodeById('gun')).toBe(node);
    expect(node.renderOrder).toBe(0);
    expect([material.depthTest, material.depthWrite]).toEqual([true, true]);
    expect(node.position.toArray()).toEqual([1, 2, 3]);
    // And the camera no longer carries it.
    frame();
    expect(node.position.toArray()).toEqual([1, 2, 3]);
  });

  it('stands at the middle of the scene, facing forward, when it says no more than that it is let go', () => {
    show({ objects: [gun({ attach: 'camera', position: v(0.3, -0.2, -0.5), rotation: v(0, 1, 0) })], camera: { position: v(4, 5, 6), lookAt: v(0, 0, 0) } });
    const node = nodeById('gun');
    frame();
    expect(node.position.length()).toBeGreaterThan(5);
    show({ objects: [gun({})], camera: { position: v(4, 5, 6), lookAt: v(0, 0, 0) } });
    expect(node.position.toArray()).toEqual([0, 0, 0]);
    expect(node.quaternion.toArray()).toEqual([0, 0, 0, 1]);
  });

  it('keeps what its own material says of depth: a decal let go still writes none', () => {
    show({ objects: [gun({ attach: 'camera', alphaTest: 0.5 })] });
    const material = nodeById('gun').material as THREE.MeshStandardMaterial;
    expect([material.depthTest, material.depthWrite]).toEqual([false, false]);
    // Changed while it is held: still drawn over everything.
    show({ objects: [gun({ attach: 'camera', color: '#ff0000' })] });
    expect([material.depthTest, material.depthWrite]).toEqual([false, false]);
    show({ objects: [gun({ color: '#ff0000' })] });
    expect([material.depthTest, material.depthWrite]).toEqual([true, true]);

    show({ objects: [gun({ attach: 'camera', color: '#ff0000' })] });
    show({ objects: [gun({ attach: 'camera', color: '#ff0000', alphaTest: 0.5 })] });
    show({ objects: [gun({ color: '#ff0000', alphaTest: 0.5 })] });
    // A cut-out writes no depth of its own accord.
    expect([material.depthTest, material.depthWrite]).toEqual([true, false]);
  });

  it('a group let go gives every part of it back its depth', () => {
    const rig = (attach: boolean): Scene3DObject => ({
      id: 'rig',
      type: 'group',
      ...(attach ? { attach: 'camera' as const } : {}),
      children: [{ id: 'barrel', type: 'cylinder' }, { id: 'sight', type: 'box' }],
    });
    show({ objects: [rig(true)] });
    const barrel = nodeById('barrel').material as THREE.Material;
    expect(barrel.depthTest).toBe(false);
    show({ objects: [rig(false)] });
    expect(nodeById('rig').renderOrder).toBe(0);
    expect(barrel.depthTest).toBe(true);
    expect((nodeById('sight').material as THREE.Material).depthTest).toBe(true);
  });
});

describe('cameraSmoothing while the person steers with orbit controls', () => {
  const ready = () => act(() => waitFor(() => canvasOf().__softnControls() !== null, 'the orbit controls'));

  it('does not pull the camera back to where the app last put it', async () => {
    show({ orbitControls: true, cameraSmoothing: 0.5, camera: { position: v(0, 0, 10), lookAt: v(0, 0, 0) } });
    await ready();
    frame();
    // Where an orbit took it.
    canvasOf().__softnCamera.position.set(10, 0, 0);
    for (let i = 0; i < 30; i++) frame();
    const cam = canvasOf().__softnCamera;
    expect(cam.position.distanceTo(new THREE.Vector3(10, 0, 0))).toBeLessThan(1e-6);
  });

  it('a new camera.position is taken at once, and the camera is the person’s again from there', async () => {
    show({ orbitControls: true, cameraSmoothing: 0.5, camera: { position: v(0, 0, 10), lookAt: v(0, 0, 0) } });
    await ready();
    frame();
    show({ orbitControls: true, cameraSmoothing: 0.5, camera: { position: v(3, 0, 10), lookAt: v(0, 0, 0) } });
    expect(canvasOf().__softnCamera.position.toArray()).toEqual([3, 0, 10]);
  });

  it('a turn the camera was part of the way through is not taken up again when the controls go', async () => {
    const direction = () => canvasOf().__softnCamera.getWorldDirection(new THREE.Vector3());
    show({ cameraSmoothing: 0.5, camera: { position: v(0, 0, 10), lookAt: v(0, 0, 0) } });
    // A new lookAt, eased: the view is on its way round when the person takes the camera.
    show({ cameraSmoothing: 0.5, camera: { position: v(0, 0, 10), lookAt: v(2, 0, 0) } });
    show({ orbitControls: true, cameraSmoothing: 0.5, camera: { position: v(0, 0, 10), lookAt: v(2, 0, 0) } });
    await ready();
    const controls = canvasOf().__softnControls() as OrbitControls;
    // Where they panned to, and where they took the camera.
    controls.target.set(-3, 0, 0);
    canvasOf().__softnCamera.position.set(-3, 4, 6);
    for (let i = 0; i < 5; i++) frame();
    const left = direction();
    const stood = canvasOf().__softnCamera.position.clone();
    show({ orbitControls: false, cameraSmoothing: 0.5, camera: { position: v(0, 0, 10), lookAt: v(2, 0, 0) } });
    for (let i = 0; i < 30; i++) frame();
    // Turned off, the camera stays where it was left: not turned back, and not eased back.
    expect(direction().distanceTo(left)).toBeLessThan(1e-9);
    expect(canvasOf().__softnCamera.position.distanceTo(stood)).toBeLessThan(1e-9);
  });

  it('still eases a camera nobody is steering', () => {
    show({ cameraSmoothing: 0.5, camera: { position: v(0, 0, 10) } });
    show({ cameraSmoothing: 0.5, camera: { position: v(2, 0, 10) } });
    frame(1000 / 60);
    expect(canvasOf().__softnCamera.position.x).toBeCloseTo(1, 3);
  });
});

describe('particles', () => {
  it('are solid unless they give an opacity below 1, as they always were drawn, and follow it when it changes', () => {
    const smoke = (extra: Partial<Scene3DObject>): Scene3DObject => ({ id: 'smoke', type: 'particles', particlePositions: [0, 0, 0], ...extra });
    show({ objects: [smoke({})] });
    const material = nodeById<THREE.Points>('smoke').material as THREE.PointsMaterial;
    // As the released code made it: 0.8 on the material, and not drawn see-through.
    expect([material.opacity, material.transparent]).toEqual([0.8, false]);
    show({ objects: [smoke({ opacity: 1 })] });
    expect([material.opacity, material.transparent]).toEqual([1, false]);
    show({ objects: [smoke({ opacity: 0.3 })] });
    expect([material.opacity, material.transparent]).toEqual([0.3, true]);
  });
});

describe('what is not drawn', () => {
  it('is not there to be clicked, nor is anything under it', () => {
    const tagged = (node: THREE.Object3D, id: string) => {
      node.userData.__softnId = id;
      return node;
    };
    const mesh = () => new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    const model = tagged(new THREE.Group(), 'robot');
    const body = mesh();
    const visor = mesh();
    const arm = new THREE.Group();
    const hand = mesh();
    arm.add(hand);
    model.add(body, visor, arm);
    expect(pickTargets([model]).solid).toEqual([model, body, visor, arm, hand]);
    // As `appearance.hiddenMeshes` leaves them.
    visor.visible = false;
    arm.visible = false;
    expect(pickTargets([model]).solid).toEqual([model, body]);
  });

  it('lets a click through to what can be seen behind it', () => {
    const clicks: Scene3DHit[] = [];
    const objects: Scene3DObject[] = [
      { id: 'door', type: 'box', width: 4, height: 4, depth: 0.2 },
      { id: 'screen', type: 'box', width: 4, height: 4, depth: 0.1, position: v(0, 0, 2) },
    ];
    show({ objects, camera: { position: v(0, 0, 5), lookAt: v(0, 0, 0) }, onClick: (hit) => clicks.push(hit) });
    const canvas = placeCanvas(canvasOf());
    canvasOf().__softnScene.updateMatrixWorld(true);
    const click = (id: number) =>
      act(() => {
        canvas.dispatchEvent(pointerEvent('pointerdown', id, 150, 75));
        canvas.dispatchEvent(pointerEvent('pointerup', id, 150, 75));
      });
    click(1);
    nodeById('screen').visible = false;
    click(2);
    expect(clicks.map((hit) => hit.objectId)).toEqual(['screen', 'door']);
  });
});

describe('onPointerMove', () => {
  const door: Scene3DObject = { id: 'door', type: 'box', width: 4, height: 4, depth: 0.2 };
  const camera = { position: v(0, 0, 5), lookAt: v(0, 0, 0) };

  it('is sent once a frame, with where the pointer is by then, however often the mouse reports', () => {
    const moves: Scene3DHit[] = [];
    show({ objects: [door], camera, onPointerMove: (hit) => moves.push(hit) });
    const canvas = placeCanvas(canvasOf());
    canvasOf().__softnScene.updateMatrixWorld(true);
    act(() => {
      canvas.dispatchEvent(pointerEvent('pointerdown', 1, 100, 75));
      for (let i = 1; i <= 8; i++) canvas.dispatchEvent(pointerEvent('pointermove', 1, 100 + i * 5, 75));
    });
    // Eight moves were eight rays and eight calls into the app.
    expect(moves).toEqual([]);
    runFrames();
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ objectId: 'door', screen: { x: 140, y: 75 }, dragged: true, locked: false });
    // No move, no report.
    runFrames();
    expect(moves).toHaveLength(1);
    act(() => canvas.dispatchEvent(pointerEvent('pointerup', 1, 140, 75)));
  });

  it('the last place it moved to is sent before the release, though no frame came between', () => {
    const order: string[] = [];
    show({
      objects: [door],
      camera,
      onPointerMove: (hit) => order.push(`move ${hit.screen.x}`),
      onPointerUp: (hit) => order.push(`up ${hit.screen.x}`),
    });
    const canvas = placeCanvas(canvasOf());
    act(() => {
      canvas.dispatchEvent(pointerEvent('pointerdown', 1, 100, 75));
      canvas.dispatchEvent(pointerEvent('pointermove', 1, 120, 75));
      canvas.dispatchEvent(pointerEvent('pointermove', 1, 160, 75));
      canvas.dispatchEvent(pointerEvent('pointerup', 1, 160, 75));
    });
    expect(order).toEqual(['move 160', 'up 160']);
    // And it is not sent a second time by the frame that was waiting.
    runFrames();
    expect(order).toEqual(['move 160', 'up 160']);
  });

  it('a press that is called off sends no move it had not yet sent', () => {
    const moves: Scene3DHit[] = [];
    show({ objects: [door], camera, onPointerMove: (hit) => moves.push(hit) });
    const canvas = placeCanvas(canvasOf());
    act(() => {
      canvas.dispatchEvent(pointerEvent('pointerdown', 1, 100, 75));
      canvas.dispatchEvent(pointerEvent('pointermove', 1, 160, 75));
      canvas.dispatchEvent(pointerEvent('pointercancel', 1, 160, 75));
    });
    runFrames();
    expect(moves).toEqual([]);
  });
});

describe('onHoverChange, when the scene changes under a pointer at rest', () => {
  const camera = { position: v(0, 0, 5), lookAt: v(0, 0, 0) };
  const door: Scene3DObject = { id: 'door', type: 'box', width: 4, height: 4, depth: 0.2 };
  const wall: Scene3DObject = { id: 'wall', type: 'box', width: 8, height: 8, depth: 0.2, position: v(0, 0, -3), cursor: 'help' };

  function hovering(objects: Scene3DObject[], changes: Scene3DHit[], hovers: Scene3DHit[] = []) {
    const props = { camera, onHoverChange: (hit: Scene3DHit) => changes.push(hit), onHover: (hit: Scene3DHit) => hovers.push(hit) };
    show({ objects, ...props });
    const canvas = placeCanvas(canvasOf());
    canvasOf().__softnScene.updateMatrixWorld(true);
    act(() => canvas.dispatchEvent(pointerEvent('pointermove', 1, 150, 75)));
    runFrames();
    return { canvas, props };
  }

  it('says the object has gone when it is taken out of the scene', () => {
    const changes: Scene3DHit[] = [];
    const hovers: Scene3DHit[] = [];
    const { props } = hovering([{ ...door, interactive: true }], changes, hovers);
    expect(changes.map((hit) => hit.objectId)).toEqual(['door']);
    expect(canvasOf().style.cursor).toBe('pointer');

    show({ objects: [], ...props });
    runFrames();
    expect(changes.map((hit) => hit.objectId)).toEqual(['door', '']);
    expect(changes[1]).toMatchObject({ screen: { x: 150, y: 75 }, point: null, button: -1 });
    // The pointer did not move: `onHover` has nothing to say, and the cursor is the scene's own again.
    expect(hovers).toHaveLength(1);
    expect(canvasOf().style.cursor).toBe('default');
  });

  it('says what is under the pointer now, when something was behind what went', () => {
    const changes: Scene3DHit[] = [];
    const { props } = hovering([door, wall], changes);
    show({ objects: [wall], ...props });
    canvasOf().__softnScene.updateMatrixWorld(true);
    runFrames();
    expect(changes.map((hit) => hit.objectId)).toEqual(['door', 'wall']);
    expect(canvasOf().style.cursor).toBe('help');
  });

  it('says so for a group’s child that goes while its group stays', () => {
    const changes: Scene3DHit[] = [];
    const car = (children: Scene3DObject[]): Scene3DObject => ({ id: 'car', type: 'group', children });
    const { props } = hovering([car([door])], changes);
    expect(changes.map((hit) => [hit.objectId, hit.rootObjectId])).toEqual([['door', 'car']]);
    show({ objects: [car([])], ...props });
    runFrames();
    expect(changes.map((hit) => hit.objectId)).toEqual(['door', '']);
  });

  it('says nothing while the object is still there, nor once the pointer has left', () => {
    const changes: Scene3DHit[] = [];
    const { canvas, props } = hovering([door], changes);
    const asked = frames.raf.mock.calls.length;
    show({ objects: [{ ...door, color: '#ff0000' }], ...props });
    // Still there: no look is taken, and no frame asked for to take one.
    expect(frames.raf.mock.calls.length).toBe(asked);

    act(() => canvas.dispatchEvent(pointerEvent('pointerleave', 1, 400, 75)));
    expect(changes.map((hit) => hit.objectId)).toEqual(['door', '']);
    show({ objects: [], ...props });
    runFrames();
    expect(changes).toHaveLength(2);
  });
});
