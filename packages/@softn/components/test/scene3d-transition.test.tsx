/**
 * Movement eased between updates (`transition`).
 *
 * A game's logic ticks thirty times a second and the screen is drawn sixty
 * or more, so everything the logic moved stood still for two frames and then
 * leapt. With a `transition` a change is taken there by the render loop over
 * that many milliseconds. Each test here changes an object, runs frames by
 * hand on a clock it sets, and looks at where the object is drawn part of
 * the way.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createRoot, type Root } from 'react-dom/client';
import { AppScopeProvider, type XDBService } from '@softn/core';
import { Scene3D, type Scene3DObject, type Scene3DProps } from '../src/threed/Scene3D';
import { Easer, transitionOf } from '../src/threed/motion';
import { stubFetch, stubFrames, type FrameStub } from './scene3d-doubles';

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

type Canvas = HTMLCanvasElement & { __softnScene: THREE.Scene; __softnCamera: THREE.PerspectiveCamera };
const canvasOf = () => container.querySelector('canvas') as Canvas;
const show = (objects: Scene3DObject[], props: Partial<Scene3DProps> = {}) =>
  act(() => root.render(<Scene3D objects={objects} lights={[]} {...props} />));
/** The same, in an app the host is showing or has hidden. */
const showIn = (active: boolean, objects: Scene3DObject[], props: Partial<Scene3DProps> = {}) =>
  act(() =>
    root.render(
      <AppScopeProvider value={{ appId: 'app', xdb: {} as XDBService, active }}>
        <Scene3D objects={objects} lights={[]} {...props} />
      </AppScopeProvider>
    )
  );

function nodeById<T extends THREE.Object3D = THREE.Mesh>(id: string): T {
  let found: THREE.Object3D | undefined;
  canvasOf().__softnScene.traverse((node) => {
    if (!found && node.userData.__softnId === id) found = node;
  });
  return found as T;
}
/** A frame, `ms` after the last. */
function frame(ms: number): void {
  now += ms;
  act(() => frames.runFrame(now));
}
const at = (x: number, y = 0, z = 0) => ({ x, y, z });
const box = (extra: Partial<Scene3DObject> = {}): Scene3DObject => ({ id: 'a', type: 'box', position: at(0), ...extra });

describe('a position that changes, with a transition', () => {
  it('is half way there after half the time, and exactly there at the end', () => {
    show([box()], { transition: 400 });
    const node = nodeById('a');
    show([box({ position: at(2, 1, -2) })], { transition: 400 });
    // Nothing has been drawn since: it is where it was.
    expect(node.position.toArray()).toEqual([0, 0, 0]);
    frame(200);
    expect(node.position.x).toBeCloseTo(1, 6);
    expect(node.position.y).toBeCloseTo(0.5, 6);
    expect(node.position.z).toBeCloseTo(-1, 6);
    frame(100);
    expect(node.position.x).toBeCloseTo(1.5, 6);
    frame(100);
    expect(node.position.toArray()).toEqual([2, 1, -2]);
    // And stays: nothing is left running.
    frame(500);
    expect(node.position.toArray()).toEqual([2, 1, -2]);
  });

  it('jumps as it always did when no transition is given', () => {
    show([box()]);
    show([box({ position: at(2) })]);
    expect(nodeById('a').position.x).toBe(2);
  });

  it('is the object’s own where it gives one: 0 jumps under a scene that eases, a time eases under a scene that does not', () => {
    const pair = (x: number): Scene3DObject[] => [
      box({ id: 'jumps', position: at(x), transition: 0 }),
      box({ id: 'follows', position: at(x) }),
    ];
    show(pair(0), { transition: 400 });
    show(pair(2), { transition: 400 });
    expect(nodeById('jumps').position.x).toBe(2);
    expect(nodeById('follows').position.x).toBe(0);
    frame(200);
    expect(nodeById('follows').position.x).toBeCloseTo(1, 6);

    show([box({ id: 'own', transition: 100 })]);
    show([box({ id: 'own', position: at(1), transition: 100 })]);
    frame(50);
    expect(nodeById('own').position.x).toBeCloseTo(0.5, 6);
  });

  it('given a new place while still on its way, goes there from where it has got to', () => {
    show([box()], { transition: 100 });
    const node = nodeById('a');
    show([box({ position: at(1) })], { transition: 100 });
    frame(50);
    expect(node.position.x).toBeCloseTo(0.5, 6);
    // The next tick arrives before the last was finished, as a game's does.
    show([box({ position: at(2) })], { transition: 100 });
    frame(50);
    expect(node.position.x).toBeCloseTo(1.25, 6);
    frame(50);
    expect(node.position.x).toBeCloseTo(2, 6);
    // The same place again is not a new start.
    show([box({ position: at(3) })], { transition: 100 });
    frame(50);
    show([box({ position: at(3) })], { transition: 100 });
    frame(50);
    expect(node.position.x).toBe(3);
  });

  it('jumps when it is further than jumpDistance, which 0 switches off', () => {
    show([box()], { transition: 400 });
    show([box({ position: at(5) })], { transition: 400 });
    // Further than the four units that are a step: put there.
    expect(nodeById('a').position.x).toBe(5);
    show([box({ position: at(8) })], { transition: 400 });
    frame(200);
    expect(nodeById('a').position.x).toBeCloseTo(6.5, 6);
    frame(200);

    show([box({ position: at(18) })], { transition: 400, jumpDistance: 20 });
    frame(200);
    expect(nodeById('a').position.x).toBeCloseTo(13, 6);
    frame(200);
    show([box({ position: at(1018) })], { transition: 400, jumpDistance: 0 });
    frame(200);
    expect(nodeById('a').position.x).toBeCloseTo(518, 6);
  });

  // Found by review, 2026-11-13. "Too far to ease" was measured from where the object is drawn.
  // A steady mover whose transition outlasts a tick is always some way behind what it was last
  // told, so the gap grew tick by tick until it passed jumpDistance: an ease, a jump, an ease, a
  // jump (a transition of 100 at 1.5 units a tick jumped on every sixth tick).
  it('goes on easing a steady mover whose transition outlasts a tick: it never jumps to catch up', () => {
    for (const [ms, step] of [[100, 1.5], [40, 3.6], [200, 1]] as const) {
      show([box()], { transition: ms, jumpDistance: 4 });
      const node = nodeById('a');
      let told = 0;
      let last = node.position.x;
      let longest = 0;
      for (let tick = 0; tick < 40; tick++) {
        told += step;
        show([box({ position: at(told) })], { transition: ms, jumpDistance: 4 });
        // Two frames a tick, 33 ms a tick: sixty frames a second over thirty ticks.
        for (const wait of [16, 17]) {
          frame(wait);
          longest = Math.max(longest, node.position.x - last);
          last = node.position.x;
        }
      }
      // Never further in one frame than a little over what it is told to go in a tick. A jump
      // to catch up covers the whole gap at once, which by then is over four units.
      expect(longest, `transition ${ms} at ${step} units a tick`).toBeLessThan(step * 1.6);
      // And it keeps up: no more than a few ticks' worth behind.
      expect(told - node.position.x, `transition ${ms} at ${step} units a tick`).toBeLessThan(step * (ms / 33 + 1.5));
      act(() => root.render(<Scene3D objects={[]} lights={[]} />));
    }
  });

  it('still jumps when it is told to be somewhere far off in one update, part of the way through an ease or not', () => {
    show([box()], { transition: 400, jumpDistance: 4 });
    const node = nodeById('a');
    show([box({ position: at(2) })], { transition: 400, jumpDistance: 4 });
    frame(100);
    expect(node.position.x).toBeCloseTo(0.5, 6);
    // From 2 to 30 in one update: a teleport, however near where it has got to is to anything.
    show([box({ position: at(30) })], { transition: 400, jumpDistance: 4 });
    expect(node.position.x).toBe(30);
  });

  it('does not ease an object into the place it first appears at', () => {
    show([box()], { transition: 400 });
    show([box(), box({ id: 'new', position: at(3) })], { transition: 400 });
    expect(nodeById('new').position.x).toBe(3);
  });
});

describe('while the app is hidden', () => {
  it('a change is written at once, and nothing sweeps across the view when the app is shown again', () => {
    showIn(true, [box()], { transition: 400 });
    const node = nodeById('a');
    showIn(false, [box()], { transition: 400 });
    showIn(false, [box({ position: at(2) })], { transition: 400 });
    expect(node.position.x).toBe(2);
    now += 30_000;
    showIn(true, [box({ position: at(3) })], { transition: 400 });
    // Shown in the same breath as the change: still not a sweep from where it was.
    expect(node.position.x).toBe(3);
    frame(16);
    expect(node.position.x).toBe(3);
    // From the next change on it is eased again.
    showIn(true, [box({ position: at(4) })], { transition: 400 });
    frame(200);
    expect(node.position.x).toBeCloseTo(3.5, 6);
  });

  it('what was on its way when the app was hidden is put where it was going', () => {
    showIn(true, [box()], { transition: 400 });
    const node = nodeById('a');
    showIn(true, [box({ position: at(2), color: '#ff0000', opacity: 0.5 })], { transition: 400 });
    frame(100);
    expect(node.position.x).toBeCloseTo(0.5, 6);
    showIn(false, [box({ position: at(2), color: '#ff0000', opacity: 0.5 })], { transition: 400 });
    expect(node.position.x).toBe(2);
    const material = node.material as THREE.MeshStandardMaterial;
    expect(material.opacity).toBe(0.5);
    expect(material.color.getHexString()).toBe('ff0000');
  });
});

describe('a direction and a size that change', () => {
  it('a rotation is turned through, and reads back as the angles written once it has arrived', () => {
    show([box({ rotation: at(0) })], { transition: 200 });
    const node = nodeById('a');
    show([box({ rotation: at(0, 1, 0) })], { transition: 200 });
    frame(100);
    expect(node.rotation.y).toBeCloseTo(0.5, 6);
    frame(100);
    expect(node.rotation.x).toBe(0);
    expect(node.rotation.y).toBe(1);
    expect(node.rotation.z).toBe(0);
  });

  it('turns the short way round when an angle wraps', () => {
    // A heading worked out with atan2 wraps from just under a half turn to
    // just over the opposite one: a small turn, not most of a circle back.
    show([box({ rotation: at(0, 3, 0) })], { transition: 200 });
    const node = nodeById('a');
    show([box({ rotation: at(0, -3, 0) })], { transition: 200 });
    frame(100);
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(node.quaternion);
    // Half way between the two headings by the short way is straight back (a half turn).
    expect(forward.x).toBeCloseTo(0, 6);
    expect(forward.z).toBeCloseTo(-1, 6);
  });

  it('a scale is grown into, as a number or as three', () => {
    show([box({ scale: 1 })], { transition: 200 });
    const node = nodeById('a');
    show([box({ scale: 3 })], { transition: 200 });
    frame(100);
    expect(node.scale.toArray()).toEqual([2, 2, 2]);
    frame(100);
    show([box({ scale: { x: 3, y: 5, z: 3 } })], { transition: 200 });
    frame(100);
    expect(node.scale.toArray()).toEqual([3, 4, 3]);
  });
});

describe('a colour, an opacity and a glow that change', () => {
  it('are passed through, in the material the object has', () => {
    show([box({ color: '#000000', emissive: '#000000', emissiveIntensity: 1 })], { transition: 200 });
    const material = nodeById('a').material as THREE.MeshStandardMaterial;
    show([box({ color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 3 })], { transition: 200 });
    expect(material.color.r).toBe(0);
    frame(100);
    expect(material.color.r).toBeCloseTo(0.5, 6);
    expect(material.emissive.g).toBeCloseTo(0.5, 6);
    expect(material.emissiveIntensity).toBeCloseTo(2, 6);
    frame(100);
    expect(material.color.getHexString()).toBe('ffffff');
    expect(material.emissiveIntensity).toBe(3);
    expect(nodeById('a').material).toBe(material);
  });

  it('a fade to solid is see-through until it is solid, and a fade from solid is see-through from the start', () => {
    show([box({ opacity: 0.2 })], { transition: 200 });
    const material = nodeById('a').material as THREE.MeshStandardMaterial;
    expect(material.transparent).toBe(true);
    show([box({ opacity: 1 })], { transition: 200 });
    frame(100);
    expect(material.opacity).toBeCloseTo(0.6, 6);
    // Drawn solid at 0.6 it would have popped to opaque at the first frame.
    expect(material.transparent).toBe(true);
    frame(100);
    expect(material.opacity).toBe(1);
    expect(material.transparent).toBe(false);

    show([box({ opacity: 0 })], { transition: 200 });
    expect(material.opacity).toBe(1);
    expect(material.transparent).toBe(true);
    frame(100);
    expect(material.opacity).toBeCloseTo(0.5, 6);
  });

  it('what is not a colour, an opacity or a glow is written at once', () => {
    show([box({ roughness: 0.2, wireframe: false })], { transition: 200 });
    const material = nodeById('a').material as THREE.MeshStandardMaterial;
    show([box({ roughness: 0.9, wireframe: true, color: '#ff0000' })], { transition: 200 });
    expect(material.roughness).toBe(0.9);
    expect(material.wireframe).toBe(true);
  });

  it('a cloud of particles fades too', () => {
    const smoke = (opacity: number): Scene3DObject => ({ id: 'smoke', type: 'particles', particlePositions: [0, 0, 0], opacity });
    show([smoke(1)], { transition: 200 });
    const material = nodeById<THREE.Points>('smoke').material as THREE.PointsMaterial;
    show([smoke(0)], { transition: 200 });
    frame(100);
    expect(material.opacity).toBeCloseTo(0.5, 6);
    expect(material.transparent).toBe(true);
  });
});

describe('groups, batches and what the scene moves by itself', () => {
  it('a group’s child is eased in the group’s own space, and the group with it', () => {
    const car = (x: number, wheelY: number): Scene3DObject => ({
      id: 'car',
      type: 'group',
      position: at(x),
      children: [{ id: 'wheel', type: 'cylinder', position: at(0, wheelY, 0) }],
    });
    show([car(0, 0)], { transition: 200 });
    show([car(2, 1)], { transition: 200 });
    frame(100);
    expect(nodeById('car').position.x).toBeCloseTo(1, 6);
    expect(nodeById('wheel').position.y).toBeCloseTo(0.5, 6);
    canvasOf().__softnScene.updateMatrixWorld(true);
    const world = new THREE.Vector3().setFromMatrixPosition(nodeById('wheel').matrixWorld);
    expect(world.toArray().map((n) => Math.round(n * 1e6) / 1e6)).toEqual([1, 0.5, 0]);
  });

  it('a group’s transition is its children’s, unless a child gives its own', () => {
    const arm = (y: number): Scene3DObject => ({
      id: 'arm',
      type: 'group',
      transition: 200,
      children: [
        { id: 'slow', type: 'box', position: at(0, y, 0) },
        { id: 'quick', type: 'box', position: at(0, y, 0), transition: 0 },
        { id: 'inner', type: 'group', children: [{ id: 'deep', type: 'box', position: at(0, y, 0) }] },
      ],
    });
    show([arm(0)]);
    show([arm(2)]);
    expect(nodeById('quick').position.y).toBe(2);
    frame(100);
    expect(nodeById('slow').position.y).toBeCloseTo(1, 6);
    expect(nodeById('deep').position.y).toBeCloseTo(1, 6);
  });

  it('an instanced batch is eased as a whole; where each copy stands is not', () => {
    const crowd = (x: number, instances: number[]): Scene3DObject => ({ id: 'crowd', type: 'instanced', shape: 'box', position: at(x), instances });
    show([crowd(0, [0, 0, 0, 1, 0, 0])], { transition: 200 });
    const mesh = nodeById<THREE.InstancedMesh>('crowd');
    show([crowd(2, [0, 0, 0, 3, 0, 0])], { transition: 200 });
    const copy = new THREE.Matrix4();
    mesh.getMatrixAt(1, copy);
    expect(new THREE.Vector3().setFromMatrixPosition(copy).x).toBe(3);
    frame(100);
    expect(mesh.position.x).toBeCloseTo(1, 6);
  });

  it('leaves to `animate` the height it is bobbing and the turn it keeps up', () => {
    const coin = (x: number, y: number): Scene3DObject => ({
      id: 'coin',
      type: 'cylinder',
      position: at(x, y, 0),
      rotation: at(0),
      animate: { floatAmplitude: 1, floatSpeed: 1, rotateY: 0.1 },
    });
    show([coin(0, 0)], { transition: 200 });
    const node = nodeById('coin');
    frame(16);
    const turned = node.rotation.y;
    expect(turned).toBeGreaterThan(0);
    show([coin(2, 5)], { transition: 200 });
    frame(100);
    // Across, it is eased; its height is the new base and the bob, at once.
    expect(node.position.x).toBeCloseTo(1, 6);
    expect(node.position.y).toBeCloseTo(5 + Math.sin(0.116), 4);
    // And the turn goes on from where it was, not back to the angle written.
    expect(node.rotation.y).toBeGreaterThan(turned);
  });

  it('a model is eased as any object is, whatever has become of its load', () => {
    stubFetch({});
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const robot = (x: number): Scene3DObject => ({ id: 'robot', type: 'model', modelUrl: 'https://models.test/robot.glb', position: at(x) });
    show([robot(0)], { transition: 200 });
    const node = nodeById<THREE.Group>('robot');
    show([robot(2)], { transition: 200 });
    frame(100);
    expect(nodeById('robot')).toBe(node);
    expect(node.position.x).toBeCloseTo(1, 6);
  });
});

describe('the camera, with cameraSmoothing', () => {
  const direction = () => canvasOf().__softnCamera.getWorldDirection(new THREE.Vector3());
  const toward = (from: THREE.Vector3, x: number, y: number, z: number) => new THREE.Vector3(x, y, z).sub(from).normalize();

  it('turns to a new lookAt over the frames that follow, where it snapped on the tick', () => {
    const camera = (lookX: number) => ({ position: at(0, 0, 10), lookAt: at(lookX) });
    show([], { camera: camera(0), cameraSmoothing: 0.5 });
    const cam = canvasOf().__softnCamera;
    expect(direction().distanceTo(new THREE.Vector3(0, 0, -1))).toBeLessThan(1e-9);

    show([], { camera: camera(2), cameraSmoothing: 0.5 });
    // Not yet: the view has not been drawn since.
    expect(direction().distanceTo(new THREE.Vector3(0, 0, -1))).toBeLessThan(1e-9);
    frame(1000 / 60);
    // One frame at 0.5: looking half way between the two points.
    expect(direction().distanceTo(toward(cam.position, 1, 0, 0))).toBeLessThan(1e-3);
    for (let i = 0; i < 80; i++) frame(1000 / 60);
    expect(direction().distanceTo(toward(cam.position, 2, 0, 0))).toBeLessThan(1e-6);
  });

  it('with no smoothing a new lookAt is looked at at once, as it was', () => {
    show([], { camera: { position: at(0, 0, 10), lookAt: at(0) } });
    show([], { camera: { position: at(0, 0, 10), lookAt: at(2) } });
    expect(direction().distanceTo(toward(new THREE.Vector3(0, 0, 10), 2, 0, 0))).toBeLessThan(1e-9);
  });

  it('a lookAt further off than jumpDistance is looked at at once', () => {
    show([], { camera: { position: at(0, 0, 10), lookAt: at(0) }, cameraSmoothing: 0.5 });
    show([], { camera: { position: at(0, 0, 10), lookAt: at(9) }, cameraSmoothing: 0.5 });
    expect(direction().distanceTo(toward(new THREE.Vector3(0, 0, 10), 9, 0, 0))).toBeLessThan(1e-9);
  });

  it('is put where it should be when the app comes back, not swept there', () => {
    const camera = (x: number) => ({ position: at(x, 0, 10), lookAt: at(x) });
    showIn(true, [], { camera: camera(0), cameraSmoothing: 0.2 });
    const cam = canvasOf().__softnCamera;
    showIn(false, [], { camera: camera(0), cameraSmoothing: 0.2 });
    showIn(false, [], { camera: camera(3), cameraSmoothing: 0.2 });
    now += 30_000;
    showIn(true, [], { camera: camera(3), cameraSmoothing: 0.2 });
    frame(16);
    expect(cam.position.x).toBe(3);
    expect(direction().distanceTo(new THREE.Vector3(0, 0, -1))).toBeLessThan(1e-9);
  });
});

describe('the easer by itself', () => {
  it('reads an object’s own transition, and the one it inherits for anything that is not a time', () => {
    expect(transitionOf(120, 40)).toBe(120);
    expect(transitionOf(0, 40)).toBe(0);
    expect(transitionOf(undefined, 40)).toBe(40);
    expect(transitionOf(-5, 40)).toBe(40);
    expect(transitionOf(NaN, 40)).toBe(40);
    expect(transitionOf('100', 40)).toBe(40);
  });

  it('keeps nothing in motion once everything has arrived, and forgets a node it is told to', () => {
    const easer = new Easer();
    easer.live = true;
    const a = new THREE.Object3D();
    const b = new THREE.Object3D();
    expect(easer.moveTo(a, 1, 0, 0, 100, true)).toBe(true);
    expect(easer.scaleTo(b, 2, 2, 2, 50)).toBe(true);
    expect(easer.busy).toBe(true);
    easer.advance(50);
    expect(b.scale.x).toBe(2);
    expect(easer.isMoving(b)).toBe(false);
    expect(easer.isMoving(a)).toBe(true);
    easer.forget(a);
    expect(easer.busy).toBe(false);
    easer.advance(100);
    // Left where it had got to.
    expect(a.position.x).toBeCloseTo(0.5, 6);
  });

  it('eases nothing while the scene is not drawn, and says so, so the caller writes it', () => {
    const easer = new Easer();
    const node = new THREE.Object3D();
    expect(easer.moveTo(node, 1, 0, 0, 100, true)).toBe(false);
    expect(easer.turnTo(node, new THREE.Quaternion(0, 1, 0, 0), 100)).toBe(false);
    expect(easer.scaleTo(node, 2, 2, 2, 100)).toBe(false);
    expect(easer.beginLook(new THREE.MeshStandardMaterial(), 100)).toBe(false);
    expect(easer.busy).toBe(false);
  });
});
