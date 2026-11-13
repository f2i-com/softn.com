/**
 * The camera: near and far, an orthographic one, one that follows an object,
 * limits on how far the person may orbit, and word of where they left it.
 *
 * The camera's matrices are checked against cameras three.js makes itself;
 * the orbit limits against the real OrbitControls, which load here as they
 * do in an app. The scene is 800 by 600, as it is with no size given.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createRoot, type Root } from 'react-dom/client';
import { Scene3D, type Scene3DCameraInfo, type Scene3DHit, type Scene3DObject, type Scene3DProps } from '../src/threed/Scene3D';
import { placeCanvas, pointerEvent, stubFrames, waitFor, type FrameStub, type TestWebGLRenderer } from './scene3d-doubles';

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
  __softnRenderer: TestWebGLRenderer;
  __softnCamera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  __softnControls: () => OrbitControls | null;
};
const canvasOf = () => container.querySelector('canvas') as Canvas;
const cameraOf = () => canvasOf().__softnCamera;
const show = (props: Partial<Scene3DProps>) => act(() => root.render(<Scene3D lights={[]} {...props} />));
function frame(ms = 1000 / 60): void {
  now += ms;
  act(() => frames.runFrame(now));
}
const v = (x: number, y: number, z: number) => ({ x, y, z });
const direction = () => cameraOf().getWorldDirection(new THREE.Vector3());
const sameMatrix = (a: THREE.Matrix4, b: THREE.Matrix4) => a.elements.every((value, i) => Math.abs(value - b.elements[i]) < 1e-9);
const ASPECT = 800 / 600;

describe('near and far', () => {
  it('are what the camera is made with: they were 0.1 and 1000 whatever was passed', () => {
    show({ camera: { near: 0.5, far: 50, fov: 40 } });
    const cam = cameraOf() as THREE.PerspectiveCamera;
    expect([cam.near, cam.far, cam.fov]).toEqual([0.5, 50, 40]);
    expect(sameMatrix(cam.projectionMatrix, new THREE.PerspectiveCamera(40, ASPECT, 0.5, 50).projectionMatrix)).toBe(true);
  });

  it('are 0.1 and 1000 when not given, as they were', () => {
    show({});
    const cam = cameraOf() as THREE.PerspectiveCamera;
    expect(sameMatrix(cam.projectionMatrix, new THREE.PerspectiveCamera(60, ASPECT, 0.1, 1000).projectionMatrix)).toBe(true);
  });

  it('follow a change; a field left out, or one that is no distance, leaves the camera as it is', () => {
    show({ camera: { near: 0.5, far: 50 } });
    const cam = cameraOf() as THREE.PerspectiveCamera;
    show({ camera: { near: 2, far: 5000 } });
    expect(cameraOf()).toBe(cam);
    expect(sameMatrix(cam.projectionMatrix, new THREE.PerspectiveCamera(60, ASPECT, 2, 5000).projectionMatrix)).toBe(true);
    show({ camera: { far: 300 } });
    expect([cam.near, cam.far]).toEqual([2, 300]);
    show({ camera: { near: 0, far: -1 } });
    expect([cam.near, cam.far]).toEqual([2, 300]);
    expect(sameMatrix(cam.projectionMatrix, new THREE.PerspectiveCamera(60, ASPECT, 2, 300).projectionMatrix)).toBe(true);
  });
});

describe('a camera told where to look', () => {
  // Found by a camera carried round a fixed point in a real browser, 2026-11-13: the picture
  // went black, because the camera was turned only when `lookAt` itself changed.
  const toward = (point: { x: number; y: number; z: number }) =>
    new THREE.Vector3(point.x, point.y, point.z).sub(cameraOf().position).normalize();

  it('goes on looking there from wherever it is put, though `lookAt` is the same as before', () => {
    const lookAt = v(0, 1, 0);
    show({ camera: { position: v(0, 4, 10), lookAt } });
    frame();
    expect(direction().distanceTo(toward(lookAt))).toBeLessThan(1e-9);
    // A quarter of the way round, then half: the middle is still what it looks at.
    for (const position of [v(10, 4, 0), v(0, 4, -10), v(-7, 12, 3)]) {
      show({ camera: { position, lookAt: { ...lookAt } } });
      expect(cameraOf().position.toArray()).toEqual([position.x, position.y, position.z]);
      expect(direction().distanceTo(toward(lookAt))).toBeLessThan(1e-9);
      frame();
      expect(direction().distanceTo(toward(lookAt))).toBeLessThan(1e-9);
    }
  });

  it('with cameraSmoothing, looks there on every frame of its way', () => {
    const lookAt = v(0, 0, 0);
    show({ camera: { position: v(0, 2, 8), lookAt }, cameraSmoothing: 0.3, jumpDistance: 0 });
    for (let i = 0; i < 5; i++) frame();
    show({ camera: { position: v(8, 2, 0), lookAt: { ...lookAt } }, cameraSmoothing: 0.3, jumpDistance: 0 });
    let last = cameraOf().position.x;
    for (let i = 0; i < 12; i++) {
      frame();
      // On its way, not there at once.
      expect(cameraOf().position.x).toBeGreaterThan(last);
      last = cameraOf().position.x;
      expect(direction().distanceTo(toward(lookAt))).toBeLessThan(1e-9);
    }
    expect(last).toBeLessThan(8);
    for (let i = 0; i < 200; i++) frame();
    expect(cameraOf().position.distanceTo(new THREE.Vector3(8, 2, 0))).toBeLessThan(1e-4);
    // Once it is all but there it is no longer aimed on each frame: out by less than can be seen.
    expect(direction().distanceTo(toward(lookAt))).toBeLessThan(1e-6);
  });

  it('keeps the way it faces when it is moved and was never told where to look', () => {
    show({ camera: { position: v(0, 4, 10) } });
    frame();
    const faced = direction();
    show({ camera: { position: v(6, 4, 10) } });
    frame();
    expect(direction().distanceTo(faced)).toBeLessThan(1e-9);
  });

  it('is left to mouse look, which has the direction', () => {
    show({ camera: { position: v(0, 2, 0), lookAt: v(0, 2, 5) }, mouseLook: true });
    frame();
    const faced = direction();
    show({ camera: { position: v(3, 2, 0), lookAt: v(0, 2, 5) }, mouseLook: true });
    frame();
    // Still straight ahead, by the yaw it had: not turned back toward the point.
    expect(direction().distanceTo(faced)).toBeLessThan(1e-9);
  });
});

describe('where a mouse-look scene looks, on the window for the app’s logic', () => {
  // Found by review, 2026-11-13. Logic that goes takes what it wrote on the window with it (a
  // newer version of the app handed over in place); the logic that followed read a yaw of 0
  // while the view looked elsewhere, and "forward" was one fixed way until the mouse moved.
  const onWindow = window as unknown as { __scene3dYaw?: number; __scene3dPitch?: number };
  afterEach(() => {
    delete onWindow.__scene3dYaw;
    delete onWindow.__scene3dPitch;
  });

  it('is said again when it has been taken away, and is the same as before', () => {
    show({ camera: { position: v(0, 2, 0), lookAt: v(3, 2, 4) }, mouseLook: true });
    frame();
    const yaw = onWindow.__scene3dYaw;
    const pitch = onWindow.__scene3dPitch;
    expect(typeof yaw).toBe('number');
    expect(yaw).toBeCloseTo(Math.atan2(3, 4), 9);
    const faced = direction();

    delete onWindow.__scene3dYaw;
    delete onWindow.__scene3dPitch;
    frame();
    expect(onWindow.__scene3dYaw).toBe(yaw);
    expect(onWindow.__scene3dPitch).toBe(pitch);
    // The view did not move for it.
    expect(direction().distanceTo(faced)).toBeLessThan(1e-9);
  });

  // Found by review, 2026-11-13: with cameraSmoothing, turning mouse look off turned the view
  // from the point it had been aimed at before mouse look began. Told to look where it was
  // already facing, it swung away on the first frame (a yaw of 0.6 became 0.2) and eased back.
  it('turned off, hands the view over from where the mouse left it: no swing to a lookAt it already faces', () => {
    const position = v(0, 2, 0);
    show({ camera: { position, lookAt: v(0, 2, 5) }, mouseLook: true, cameraSmoothing: 0.3 });
    frame();
    // The mouse turns the view.
    onWindow.__scene3dYaw = 0.6;
    onWindow.__scene3dPitch = 0;
    frame();
    const faced = direction();
    expect(Math.atan2(faced.x, faced.z)).toBeCloseTo(0.6, 9);
    // Mouse look goes, and the app says to look where the view is facing.
    const ahead = v(position.x + Math.sin(0.6) * 5, position.y, position.z + Math.cos(0.6) * 5);
    show({ camera: { position, lookAt: ahead }, mouseLook: false, cameraSmoothing: 0.3 });
    for (let i = 0; i < 6; i++) {
      frame();
      expect(direction().distanceTo(faced), `frame ${i + 1}`).toBeLessThan(1e-6);
    }
    // Told to look somewhere else, it turns there from where it was facing, part of the way each frame.
    // (A point nearer than jumpDistance to the one it faces: one further off is looked at at once.)
    show({ camera: { position, lookAt: v(4, 2, 3) }, mouseLook: false, cameraSmoothing: 0.3 });
    frame();
    const yaw = Math.atan2(direction().x, direction().z);
    expect(yaw).toBeGreaterThan(0.6 + 1e-3);
    expect(yaw).toBeLessThan(Math.atan2(4, 3) - 1e-3);
  });

  it('is not put on the window by a scene without mouse look', () => {
    show({ camera: { position: v(0, 2, 0), lookAt: v(3, 2, 4) } });
    frame();
    frame();
    expect(onWindow.__scene3dYaw).toBeUndefined();
  });
});
describe('an orthographic camera', () => {
  it('is made when asked for, showing `size` units from top to bottom at the scene’s shape', () => {
    show({ camera: { type: 'orthographic', size: 12, near: 1, far: 80, position: v(0, 20, 0), lookAt: v(0, 0, 0) } });
    const cam = cameraOf() as THREE.OrthographicCamera;
    expect(cam.isOrthographicCamera).toBe(true);
    expect([cam.top, cam.bottom, cam.right, cam.left]).toEqual([6, -6, 6 * ASPECT, -6 * ASPECT]);
    expect(sameMatrix(cam.projectionMatrix, new THREE.OrthographicCamera(-6 * ASPECT, 6 * ASPECT, 6, -6, 1, 80).projectionMatrix)).toBe(true);
    // Straight down, but for the hair's breadth three.js leans a camera that looks along its own up.
    expect(direction().distanceTo(new THREE.Vector3(0, -1, 0))).toBeLessThan(1e-3);
  });

  it('shows ten units when no size is given', () => {
    show({ camera: { type: 'orthographic' } });
    const cam = cameraOf() as THREE.OrthographicCamera;
    expect(cam.top - cam.bottom).toBe(10);
  });

  it('is what the frame is drawn with', () => {
    show({ camera: { type: 'orthographic' } });
    frame();
    expect(canvasOf().__softnRenderer.lastCamera).toBe(cameraOf());
  });

  it('takes the place of a perspective one while the scene stays, standing where it stood and facing as it faced', () => {
    const at = { position: v(4, 6, 8), lookAt: v(1, 0, -1) };
    show({ camera: at });
    const canvas = canvasOf();
    const before = cameraOf();
    const facing = direction();
    expect((before as THREE.PerspectiveCamera).isPerspectiveCamera).toBe(true);

    show({ camera: { ...at, type: 'orthographic', size: 20 } });
    expect(canvasOf()).toBe(canvas);
    const plan = cameraOf() as THREE.OrthographicCamera;
    expect(plan).not.toBe(before);
    expect(plan.isOrthographicCamera).toBe(true);
    expect(plan.position.toArray()).toEqual([4, 6, 8]);
    expect(direction().distanceTo(facing)).toBeLessThan(1e-9);
    expect(plan.top).toBe(10);
    frame();
    expect(canvas.__softnRenderer.lastCamera).toBe(plan);

    // And back, to the field of view it had.
    show({ camera: { ...at, type: 'perspective' } });
    const again = cameraOf() as THREE.PerspectiveCamera;
    expect(again.isPerspectiveCamera).toBe(true);
    expect(again.fov).toBe(60);
    expect(again.position.toArray()).toEqual([4, 6, 8]);
    expect(direction().distanceTo(facing)).toBeLessThan(1e-9);
  });

  it('follows a new size', () => {
    show({ camera: { type: 'orthographic', size: 10 } });
    const cam = cameraOf() as THREE.OrthographicCamera;
    show({ camera: { type: 'orthographic', size: 4 } });
    expect(cameraOf()).toBe(cam);
    expect([cam.top, cam.right]).toEqual([2, 2 * ASPECT]);
    expect(sameMatrix(cam.projectionMatrix, new THREE.OrthographicCamera(-2 * ASPECT, 2 * ASPECT, 2, -2, 0.1, 1000).projectionMatrix)).toBe(true);
  });

  it('keeps its shape when the scene is another size', () => {
    show({ width: 800, height: 600, camera: { type: 'orthographic', size: 10 } });
    show({ width: 400, height: 400, camera: { type: 'orthographic', size: 10 } });
    const cam = cameraOf() as THREE.OrthographicCamera;
    expect([cam.top, cam.right]).toEqual([5, 5]);
  });

  it('a click goes straight in from where the pointer is, however far the object', () => {
    const clicks: Scene3DHit[] = [];
    const objects: Scene3DObject[] = [
      { id: 'near', type: 'box', position: v(-2, 0, 0) },
      { id: 'far', type: 'box', position: v(2, 0, -40) },
    ];
    show({ objects, camera: { type: 'orthographic', size: 6, position: v(0, 0, 10), lookAt: v(0, 0, 0) }, onClick: (hit) => clicks.push(hit) });
    const canvas = placeCanvas(canvasOf(), 800, 600) as Canvas;
    canvas.__softnScene.updateMatrixWorld(true);
    cameraOf().updateMatrixWorld();
    const click = (x: number, y: number, id: number) =>
      act(() => {
        canvas.dispatchEvent(pointerEvent('pointerdown', id, x, y));
        canvas.dispatchEvent(pointerEvent('pointerup', id, x, y));
      });
    // Six units of height in 600 pixels: a unit is 100 pixels, at any depth.
    click(400 - 200, 300, 1);
    click(400 + 200, 300, 2);
    expect(clicks.map((hit) => hit.objectId)).toEqual(['near', 'far']);
  });
});

describe('a camera that follows an object', () => {
  const hero = (extra: Partial<Scene3DObject> = {}): Scene3DObject => ({ id: 'hero', type: 'box', position: v(0, 0, 0), ...extra });
  const follow = { target: 'hero', distance: 6, height: 3, lookAhead: 2 };

  it('stands behind and above it and looks ahead of it, from the object’s own heading', () => {
    show({ objects: [hero({ position: v(10, 1, -5) })], camera: { follow } });
    frame();
    const cam = cameraOf();
    // Heading 0 is the object's +z: behind it is -z.
    expect(cam.position.distanceTo(new THREE.Vector3(10, 4, -11))).toBeLessThan(1e-9);
    const ahead = new THREE.Vector3(10, 1, -3).sub(cam.position).normalize();
    expect(direction().distanceTo(ahead)).toBeLessThan(1e-9);

    // Turned a quarter turn, it faces +x, and the camera comes round behind it.
    show({ objects: [hero({ position: v(10, 1, -5), rotation: v(0, Math.PI / 2, 0) })], camera: { follow } });
    frame();
    expect(cam.position.distanceTo(new THREE.Vector3(4, 4, -5))).toBeLessThan(1e-9);
    expect(direction().distanceTo(new THREE.Vector3(12, 1, -5).sub(cam.position).normalize())).toBeLessThan(1e-9);
  });

  it('keeps the object in the middle of the picture as it moves', () => {
    const centred = { target: 'hero', distance: 8, height: 4 };
    for (const x of [0, 3, -7, 40]) {
      show({ objects: [hero({ position: v(x, 0, x / 2) })], camera: { follow: centred } });
      frame();
      const cam = cameraOf();
      cam.updateMatrixWorld();
      const seen = new THREE.Vector3(x, 0, x / 2).project(cam);
      expect(Math.abs(seen.x)).toBeLessThan(1e-9);
      expect(Math.abs(seen.y)).toBeLessThan(1e-9);
    }
  });

  it('goes by where the object is drawn: part of the way, while a transition takes it there', () => {
    show({ objects: [hero()], camera: { follow }, transition: 200 });
    frame();
    show({ objects: [hero({ position: v(2, 0, 0) })], camera: { follow }, transition: 200 });
    frame(100);
    // The tick said x = 2; the object is drawn at 1, and so the camera stands behind 1.
    expect(cameraOf().position.x).toBeCloseTo(1, 6);
    frame(100);
    expect(cameraOf().position.x).toBeCloseTo(2, 6);
  });

  it('is eased by cameraSmoothing, position and direction alike, and jumps when its object does', () => {
    show({ objects: [hero()], camera: { follow }, cameraSmoothing: 0.5, jumpDistance: 4 });
    frame();
    for (let i = 0; i < 80; i++) frame();
    const cam = cameraOf();
    expect(cam.position.distanceTo(new THREE.Vector3(0, 3, -6))).toBeLessThan(1e-6);

    show({ objects: [hero({ position: v(2, 0, 0) })], camera: { follow }, cameraSmoothing: 0.5, jumpDistance: 4 });
    frame();
    // One frame at 0.5: half way to where it should stand.
    expect(cam.position.x).toBeCloseTo(1, 3);
    for (let i = 0; i < 80; i++) frame();
    expect(cam.position.x).toBeCloseTo(2, 6);

    // The object is put somewhere else altogether: the camera is put behind it.
    show({ objects: [hero({ position: v(500, 0, 0) })], camera: { follow }, cameraSmoothing: 0.5, jumpDistance: 4 });
    frame();
    expect(cam.position.distanceTo(new THREE.Vector3(500, 3, -6))).toBeLessThan(1e-9);
  });

  // Found by review, 2026-11-13: eased toward a place that is not a number, the camera was
  // itself not a number from then on, whatever its object did after.
  it('waits where it was while its object’s place is not a number, and follows again when it is one', () => {
    show({ objects: [hero()], camera: { follow }, cameraSmoothing: 0.5, jumpDistance: 4 });
    for (let i = 0; i < 80; i++) frame();
    const cam = cameraOf();
    const stood = cam.position.clone();
    show({ objects: [hero({ position: v(Number.NaN, 0, 0) })], camera: { follow }, cameraSmoothing: 0.5, jumpDistance: 4 });
    for (let i = 0; i < 6; i++) frame();
    expect(cam.position.toArray().every(Number.isFinite)).toBe(true);
    expect(cam.matrixWorld.elements.every(Number.isFinite)).toBe(true);
    expect(cam.position.distanceTo(stood)).toBeLessThan(1e-6);
    show({ objects: [hero({ position: v(2, 0, 0) })], camera: { follow }, cameraSmoothing: 0.5, jumpDistance: 4 });
    for (let i = 0; i < 80; i++) frame();
    expect(cam.position.x).toBeCloseTo(2, 5);
  });

  it('follows a group’s child where the child is in the world', () => {
    const train: Scene3DObject = {
      id: 'train',
      type: 'group',
      position: v(100, 0, 0),
      children: [{ id: 'cab', type: 'box', position: v(0, 2, 5) }],
    };
    show({ objects: [train], camera: { follow: { target: 'cab', distance: 4, height: 1 } } });
    frame();
    expect(cameraOf().position.distanceTo(new THREE.Vector3(100, 3, 1))).toBeLessThan(1e-9);
  });

  it('is the camera prop’s position and lookAt while there is nothing by that name, and again when the object goes', () => {
    const camera = { position: v(0, 20, 20), lookAt: v(0, 0, 0), follow };
    show({ objects: [], camera });
    frame();
    const cam = cameraOf();
    const overview = direction();
    expect(cam.position.toArray()).toEqual([0, 20, 20]);

    show({ objects: [hero()], camera });
    frame();
    expect(cam.position.distanceTo(new THREE.Vector3(0, 3, -6))).toBeLessThan(1e-9);

    show({ objects: [], camera });
    frame();
    expect(cam.position.toArray()).toEqual([0, 20, 20]);
    expect(direction().distanceTo(overview)).toBeLessThan(1e-9);
  });

  it('stops when it is no longer asked for, and leaves a camera that was given no place where it is', () => {
    show({ objects: [hero()], camera: { follow } });
    frame();
    const cam = cameraOf();
    const stood = cam.position.clone();
    show({ objects: [hero({ position: v(3, 0, 0) })], camera: {} });
    frame();
    expect(cam.position.distanceTo(stood)).toBeLessThan(1e-9);
  });
});

describe('limits on the orbit controls', () => {
  const ready = () => act(() => waitFor(() => canvasOf().__softnControls() !== null, 'the orbit controls'));
  const distance = () => cameraOf().position.distanceTo(canvasOf().__softnControls()!.target);

  it('hold: the camera cannot be zoomed through what it orbits, sent away, or taken under the floor', async () => {
    show({
      orbitControls: true,
      orbit: { minDistance: 2, maxDistance: 5, maxPolar: Math.PI / 2 },
      camera: { position: v(0, 0, 10), lookAt: v(0, 0, 0) },
    });
    await ready();
    frame();
    expect(distance()).toBeCloseTo(5, 6);

    cameraOf().position.set(0, 0.5, 0.5);
    frame();
    expect(distance()).toBeCloseTo(2, 6);

    // Under the floor: brought back up to the ground.
    cameraOf().position.set(0, -3, 3);
    frame();
    expect(cameraOf().position.y).toBeGreaterThan(-1e-6);
    expect(distance()).toBeLessThanOrEqual(5 + 1e-6);
  });

  // Found by review, 2026-11-13 (the released code had it too). three takes its key listener
  // off the canvas's root when it is asked to, and a scene that is going is asked after its
  // canvas has left the page: the listener stayed on the document, holding the camera, the
  // canvas and the scene, for every orbit scene a page had ever shown.
  it('leave nothing listening on the document when the scene goes, or when they are turned off', async () => {
    const added: EventListenerOrEventListenerObject[] = [];
    const removed: EventListenerOrEventListenerObject[] = [];
    const add = document.addEventListener.bind(document);
    const remove = document.removeEventListener.bind(document);
    vi.spyOn(document, 'addEventListener').mockImplementation((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      if (type === 'keydown') added.push(listener);
      add(type, listener, options);
    });
    vi.spyOn(document, 'removeEventListener').mockImplementation((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
      if (type === 'keydown') removed.push(listener);
      remove(type, listener, options);
    });
    const left = () => added.filter((listener) => !removed.includes(listener));

    show({ orbitControls: true, camera: { position: v(0, 0, 6), lookAt: v(0, 0, 0) } });
    await ready();
    const whileShown = left();
    expect(whileShown.length, 'the controls listen for keys on the document').toBeGreaterThan(0);

    // Turned off while the scene stays.
    show({ orbitControls: false, camera: { position: v(0, 0, 6), lookAt: v(0, 0, 0) } });
    expect(left()).toEqual([]);

    // On again, and then the whole scene goes: its canvas has left the page by the time it is asked.
    show({ orbitControls: true, camera: { position: v(0, 0, 6), lookAt: v(0, 0, 0) } });
    await ready();
    expect(left().length).toBeGreaterThan(0);
    act(() => root.unmount());
    expect(left()).toEqual([]);
    // For the file's own tidying-up, which unmounts again.
    root = createRoot(container);
  });

  it('may change while the controls stay, and one left out is no limit', async () => {
    show({ orbitControls: true, orbit: { maxDistance: 5, pan: false, zoom: false }, camera: { position: v(0, 0, 4), lookAt: v(0, 0, 0) } });
    await ready();
    const controls = canvasOf().__softnControls() as OrbitControls;
    expect([controls.maxDistance, controls.enablePan, controls.enableZoom]).toEqual([5, false, false]);
    expect([controls.minDistance, controls.minPolarAngle, controls.maxPolarAngle]).toEqual([0, 0, Math.PI]);

    show({ orbitControls: true, orbit: { minPolar: 0.2, maxPolar: 1.2 }, camera: { position: v(0, 0, 4), lookAt: v(0, 0, 0) } });
    expect(canvasOf().__softnControls()).toBe(controls);
    expect([controls.maxDistance, controls.enablePan, controls.enableZoom]).toEqual([Infinity, true, true]);
    expect([controls.minPolarAngle, controls.maxPolarAngle]).toEqual([0.2, 1.2]);

    // No limits given at all is the controls as they come.
    show({ orbitControls: true, camera: { position: v(0, 0, 4), lookAt: v(0, 0, 0) } });
    expect([controls.minDistance, controls.maxDistance, controls.minPolarAngle, controls.maxPolarAngle]).toEqual([0, Infinity, 0, Math.PI]);
  });

  it('wait while the camera follows, and take it up again from where it was left', async () => {
    const hero: Scene3DObject = { id: 'hero', type: 'box', position: v(5, 0, 0) };
    show({ orbitControls: true, objects: [hero], camera: { position: v(0, 0, 10), lookAt: v(0, 0, 0), follow: { target: 'hero', distance: 6, height: 3 } } });
    await ready();
    const controls = canvasOf().__softnControls() as OrbitControls;
    frame();
    expect(controls.enabled).toBe(false);
    expect(cameraOf().position.distanceTo(new THREE.Vector3(5, 3, -6))).toBeLessThan(1e-9);

    show({ orbitControls: true, objects: [hero], camera: { position: v(0, 0, 10), lookAt: v(0, 0, 0) } });
    frame();
    expect(controls.enabled).toBe(true);
    // They turn about what the camera was following.
    expect(controls.target.distanceTo(new THREE.Vector3(5, 0, 0))).toBeLessThan(1e-9);
  });
});

describe('onCameraChange', () => {
  const ready = () => act(() => waitFor(() => canvasOf().__softnControls() !== null, 'the orbit controls'));

  it('says where the camera came to rest when the person lets go, and nothing for a press that moved nothing', async () => {
    const changes: Scene3DCameraInfo[] = [];
    show({ orbitControls: true, camera: { position: v(0, 0, 10), lookAt: v(0, 1, 0) }, onCameraChange: (info) => changes.push(info) });
    await ready();
    const controls = canvasOf().__softnControls() as OrbitControls;
    frame();

    // A click: taken hold of and let go, with nothing moved.
    act(() => {
      controls.dispatchEvent({ type: 'start' });
      controls.dispatchEvent({ type: 'end' });
    });
    for (let i = 0; i < 5; i++) frame();
    expect(changes).toEqual([]);

    // An orbit: the camera is somewhere else when they let go.
    act(() => controls.dispatchEvent({ type: 'start' }));
    cameraOf().position.set(10, 0, 0);
    act(() => controls.dispatchEvent({ type: 'end' }));
    for (let i = 0; i < 200 && changes.length === 0; i++) frame();
    expect(changes).toHaveLength(1);
    const { position, target, size } = changes[0];
    expect(size).toBeUndefined();
    expect(target).toEqual({ x: 0, y: 1, z: 0 });
    expect(position).toEqual({ x: cameraOf().position.x, y: cameraOf().position.y, z: cameraOf().position.z });
    expect(Math.hypot(position.x - 10, position.y, position.z)).toBeLessThan(0.5);
    // Nothing more until the next time.
    for (let i = 0; i < 10; i++) frame();
    expect(changes).toHaveLength(1);
  });

  it('given back as the camera prop, shows the same view and moves nothing', async () => {
    const changes: Scene3DCameraInfo[] = [];
    const onCameraChange = (info: Scene3DCameraInfo) => changes.push(info);
    show({ orbitControls: true, camera: { position: v(0, 0, 10), lookAt: v(0, 0, 0) }, onCameraChange });
    await ready();
    const controls = canvasOf().__softnControls() as OrbitControls;
    frame();
    act(() => controls.dispatchEvent({ type: 'start' }));
    cameraOf().position.set(6, 2, 6);
    controls.target.set(1, 0, 1);
    act(() => controls.dispatchEvent({ type: 'end' }));
    for (let i = 0; i < 200 && changes.length === 0; i++) frame();
    const stood = cameraOf().position.clone();
    const facing = direction();

    show({ orbitControls: true, camera: { position: changes[0].position, lookAt: changes[0].target }, onCameraChange });
    frame();
    expect(cameraOf().position.distanceTo(stood)).toBeLessThan(1e-6);
    expect(direction().distanceTo(facing)).toBeLessThan(1e-6);
    expect(controls.target.toArray()).toEqual([1, 0, 1]);
  });

  it('for an orthographic camera, says the size in view as zoomed, which given back as `size` is the same view', async () => {
    const changes: Scene3DCameraInfo[] = [];
    const onCameraChange = (info: Scene3DCameraInfo) => changes.push(info);
    const camera = { type: 'orthographic' as const, size: 10, position: v(0, 10, 0.001), lookAt: v(0, 0, 0) };
    show({ orbitControls: true, camera, onCameraChange });
    await ready();
    const controls = canvasOf().__softnControls() as OrbitControls;
    const cam = cameraOf() as THREE.OrthographicCamera;
    frame();
    act(() => controls.dispatchEvent({ type: 'start' }));
    cam.zoom = 2;
    cam.updateProjectionMatrix();
    act(() => controls.dispatchEvent({ type: 'end' }));
    for (let i = 0; i < 200 && changes.length === 0; i++) frame();
    expect(changes[0].size).toBe(5);
    const seen = cam.projectionMatrix.clone();

    show({ orbitControls: true, camera: { ...camera, size: changes[0].size }, onCameraChange });
    expect(cam.zoom).toBe(1);
    expect(sameMatrix(cam.projectionMatrix, seen)).toBe(true);
  });

  it('the controls are made again for a camera of the other kind, turning about what the old ones turned about', async () => {
    show({ orbitControls: true, camera: { position: v(0, 5, 10), lookAt: v(0, 0, 0) } });
    await ready();
    const first = canvasOf().__softnControls() as OrbitControls;
    first.target.set(3, 0, 3);
    show({ orbitControls: true, camera: { position: v(0, 5, 10), lookAt: v(0, 0, 0), type: 'orthographic' } });
    await act(() => waitFor(() => canvasOf().__softnControls() !== null && canvasOf().__softnControls() !== first, 'new controls'));
    const second = canvasOf().__softnControls() as OrbitControls;
    expect(second.object).toBe(cameraOf());
    expect(second.target.toArray()).toEqual([3, 0, 3]);
  });
});
