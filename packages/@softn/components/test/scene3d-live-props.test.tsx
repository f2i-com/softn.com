/**
 * Props that were read once, when the scene was made, and are now followed.
 *
 * A camera mode, a graphics setting or a sensitivity slider changed after
 * mount did nothing: turning `orbitControls` on created none, turning it off
 * left them steering, `shadows` stayed as they began. The only way to change
 * one was a new scene, and with it a new WebGL context. Each test here
 * changes a prop on a scene that stays, and checks the canvas is still the
 * one it started with.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createRoot, type Root } from 'react-dom/client';
import { Scene3D, type Scene3DHit, type Scene3DProps } from '../src/threed/Scene3D';
import { placeCanvas, pointerEvent, stubFrames, waitFor, type FrameStub, type TestWebGLRenderer } from './scene3d-doubles';

const orbit = vi.hoisted(() => ({
  made: [] as Array<{ target: { x: number; y: number; z: number }; disposed: boolean; updates: number; element: unknown }>,
}));

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  const { TestWebGLRenderer } = await import('./scene3d-doubles');
  return { ...actual, WebGLRenderer: TestWebGLRenderer };
});

vi.mock('three/addons/controls/OrbitControls.js', async () => {
  const THREE = await import('three');
  return {
    // An event dispatcher, as the real ones are: the scene listens for the
    // person taking hold of them and letting go.
    OrbitControls: class extends THREE.EventDispatcher<{ start: object; end: object }> {
      target = new THREE.Vector3();
      enabled = true;
      enableDamping = false;
      dampingFactor = 0;
      autoRotate = false;
      autoRotateSpeed = 0;
      disposed = false;
      updates = 0;
      constructor(
        public camera: unknown,
        public element: unknown
      ) {
        super();
        orbit.made.push(this);
      }
      update() {
        this.updates++;
      }
      dispose() {
        this.disposed = true;
      }
    },
  };
});

type Canvas = HTMLCanvasElement & {
  __softnScene: THREE.Scene;
  __softnRenderer: TestWebGLRenderer;
  __softnCamera: THREE.PerspectiveCamera;
};
type SceneWindow = Window & { __scene3dYaw?: number; __scene3dPitch?: number; __scene3dLocked?: boolean };

let container: HTMLDivElement;
let root: Root;
let frames: FrameStub;
const sceneWindow = window as SceneWindow;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  frames = stubFrames();
  orbit.made.length = 0;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete sceneWindow.__scene3dYaw;
  delete sceneWindow.__scene3dPitch;
  delete sceneWindow.__scene3dLocked;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const canvasOf = () => container.querySelector('canvas') as Canvas;
const render = (props: Partial<Scene3DProps>) => act(() => root.render(<Scene3D lights={[]} {...props} />));
/** The live controls: made and not yet disposed. */
const steering = () => orbit.made.filter((controls) => !controls.disposed);
/** A drag of the mouse across the canvas, a button held. */
function drag(canvas: HTMLCanvasElement, pointerId: number, dx: number, dy: number): void {
  act(() => {
    canvas.dispatchEvent(pointerEvent('pointerdown', pointerId, 100, 100));
    canvas.dispatchEvent(pointerEvent('pointermove', pointerId, 100 + dx, 100 + dy));
    canvas.dispatchEvent(pointerEvent('pointerup', pointerId, 100 + dx, 100 + dy));
  });
}

describe('orbit controls, after the scene is made', () => {
  it('are created when turned on, about what the camera looks at, and steer from the next frame', async () => {
    render({ orbitControls: false, camera: { position: { x: 0, y: 2, z: 6 }, lookAt: { x: 1, y: 0.5, z: 0 } } });
    const canvas = canvasOf();
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(orbit.made).toHaveLength(0);

    render({ orbitControls: true, camera: { position: { x: 0, y: 2, z: 6 }, lookAt: { x: 1, y: 0.5, z: 0 } } });
    await act(() => waitFor(() => orbit.made.length === 1, 'the controls'));
    expect(canvasOf()).toBe(canvas);
    expect(orbit.made[0].element).toBe(canvas);
    expect(orbit.made[0].target).toMatchObject({ x: 1, y: 0.5, z: 0 });
    const before = orbit.made[0].updates;
    act(() => frames.runFrame());
    expect(orbit.made[0].updates).toBe(before + 1);
  });

  it('are disposed when turned off, and no longer steer; turned on again they are new ones', async () => {
    render({ orbitControls: true });
    await act(() => waitFor(() => orbit.made.length === 1, 'the controls'));
    render({ orbitControls: false });
    expect(orbit.made[0].disposed).toBe(true);
    const updates = orbit.made[0].updates;
    act(() => frames.runFrame());
    expect(orbit.made[0].updates).toBe(updates);

    render({ orbitControls: true });
    await act(() => waitFor(() => orbit.made.length === 2, 'new controls'));
    expect(steering()).toEqual([orbit.made[1]]);
  });

  it('turned off before their chunk arrived are never made', async () => {
    render({ orbitControls: true });
    render({ orbitControls: false });
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
    expect(orbit.made).toHaveLength(0);
  });

  it('give way to mouse look, and come back when it goes', async () => {
    render({ orbitControls: true });
    await act(() => waitFor(() => orbit.made.length === 1, 'the controls'));
    render({ orbitControls: true, mouseLook: true });
    expect(steering()).toEqual([]);
    render({ orbitControls: true, mouseLook: false });
    await act(() => waitFor(() => orbit.made.length === 2, 'the controls again'));
    expect(steering()).toHaveLength(1);
  });
});

describe('graphics settings, after the scene is made', () => {
  it('shadows go on and off, and every material is asked to compile again', () => {
    render({ shadows: false, objects: [{ id: 'crate', type: 'box', castShadow: true }] });
    const canvas = canvasOf();
    const renderer = canvas.__softnRenderer;
    let crate: THREE.Mesh | undefined;
    canvas.__softnScene.traverse((node) => {
      if (node.userData.__softnId === 'crate') crate = node as THREE.Mesh;
    });
    const material = (crate as THREE.Mesh).material as THREE.Material;
    expect(renderer.shadowMap.enabled).toBe(false);

    const compiled = material.version;
    render({ shadows: true, objects: [{ id: 'crate', type: 'box', castShadow: true }] });
    expect(renderer.shadowMap.enabled).toBe(true);
    expect(renderer.shadowMap.type).toBe(THREE.PCFSoftShadowMap);
    expect(material.version).toBeGreaterThan(compiled);

    render({ shadows: false, objects: [{ id: 'crate', type: 'box', castShadow: true }] });
    expect(renderer.shadowMap.enabled).toBe(false);
    expect(canvasOf()).toBe(canvas);
  });

  it('the pixel ratio follows maxPixelRatio, and is not set again for the same answer', () => {
    vi.stubGlobal('devicePixelRatio', 3);
    render({ maxPixelRatio: 2 });
    const renderer = canvasOf().__softnRenderer;
    expect(renderer.pixelRatios).toEqual([2]);
    render({ maxPixelRatio: 1 });
    expect(renderer.pixelRatios).toEqual([2, 1]);
    render({ maxPixelRatio: 1 });
    expect(renderer.pixelRatios).toEqual([2, 1]);
    // The screen's own ratio is the most there is to draw.
    render({ maxPixelRatio: 8 });
    expect(renderer.pixelRatios).toEqual([2, 1, 3]);
  });

  it('the grid appears, changes and goes, and the one it replaces is disposed', () => {
    const grids = () => {
      const found: THREE.GridHelper[] = [];
      canvasOf().__softnScene.traverse((node) => {
        if (node instanceof THREE.GridHelper) found.push(node);
      });
      return found;
    };
    render({});
    expect(grids()).toHaveLength(0);
    render({ grid: true });
    expect(grids()).toHaveLength(1);
    const first = grids()[0];
    const dispose = vi.spyOn(first.geometry, 'dispose');
    // The same grid handed over as a new object is the same grid.
    render({ grid: { size: 50 } });
    render({ grid: { size: 50 } });
    const second = grids()[0];
    expect(second).not.toBe(first);
    expect(dispose).toHaveBeenCalledOnce();
    render({ grid: { size: 50 } });
    expect(grids()[0]).toBe(second);
    render({ grid: { size: 50, position: { x: 0, y: 2, z: 0 } } });
    expect(grids()).toHaveLength(1);
    expect(grids()[0].position.y).toBe(2);
    render({ grid: false });
    expect(grids()).toHaveLength(0);
  });
});

describe('mouse look, after the scene is made', () => {
  const at = { position: { x: 0, y: 0, z: 8 }, lookAt: { x: 0, y: 0, z: 0 } };

  it('reads its sensitivity and its pitch limit as they are now', () => {
    render({ mouseLook: true, mouseLookSensitivity: 0.01, camera: at });
    const canvas = canvasOf();
    const start = sceneWindow.__scene3dYaw as number;
    drag(canvas, 1, 50, 0);
    expect((sceneWindow.__scene3dYaw as number) - start).toBeCloseTo(-0.5, 6);

    render({ mouseLook: true, mouseLookSensitivity: 0.002, camera: at });
    const middle = sceneWindow.__scene3dYaw as number;
    drag(canvas, 2, 50, 0);
    expect((sceneWindow.__scene3dYaw as number) - middle).toBeCloseTo(-0.1, 6);

    // A long pull down stops at the limit there is now.
    render({ mouseLook: true, mouseLookSensitivity: 0.01, pitchLimit: 0.3, camera: at });
    drag(canvas, 3, 0, 500);
    expect(sceneWindow.__scene3dPitch).toBeCloseTo(-0.3, 6);
    render({ mouseLook: true, mouseLookSensitivity: 0.01, pitchLimit: 1.2, camera: at });
    drag(canvas, 4, 0, 500);
    expect(sceneWindow.__scene3dPitch).toBeCloseTo(-1.2, 6);
    expect(canvasOf()).toBe(canvas);
  });

  it('starts when turned on, facing what the camera looks at, and stops when turned off', () => {
    render({ mouseLook: false, camera: { position: { x: 8, y: 0, z: 0 }, lookAt: { x: 0, y: 0, z: 0 } } });
    const canvas = canvasOf();
    canvas.setPointerCapture = vi.fn();
    expect(sceneWindow.__scene3dYaw).toBeUndefined();
    drag(canvas, 1, 40, 0);
    expect(sceneWindow.__scene3dYaw).toBeUndefined();

    render({ mouseLook: true, camera: { position: { x: 8, y: 0, z: 0 }, lookAt: { x: 0, y: 0, z: 0 } } });
    expect(canvasOf()).toBe(canvas);
    expect(sceneWindow.__scene3dYaw).toBeCloseTo(-Math.PI / 2);
    expect(canvas.style.cursor).toBe('grab');
    drag(canvas, 2, 40, 0);
    expect(sceneWindow.__scene3dYaw).toBeCloseTo(-Math.PI / 2 - 40 * 0.003);
    const camera = canvas.__softnCamera;
    const towardsTheOrigin = new THREE.Vector3(-1, 0, 0);
    act(() => frames.runFrame());
    expect(camera.getWorldDirection(new THREE.Vector3()).distanceTo(towardsTheOrigin)).toBeGreaterThan(0.1);

    render({ mouseLook: false, camera: { position: { x: 8, y: 0, z: 0 }, lookAt: { x: 0, y: 0, z: 0 } } });
    expect(sceneWindow.__scene3dYaw).toBeUndefined();
    expect(canvas.style.cursor).toBe('default');
    // The camera is the `camera` prop's again, and a drag no longer turns it.
    expect(camera.getWorldDirection(new THREE.Vector3()).distanceTo(towardsTheOrigin)).toBeLessThan(1e-6);
    drag(canvas, 3, 40, 0);
    act(() => frames.runFrame());
    expect(camera.getWorldDirection(new THREE.Vector3()).distanceTo(towardsTheOrigin)).toBeLessThan(1e-6);
  });

  it('turns the camera each frame while it is on', () => {
    render({ mouseLook: true, camera: at });
    const canvas = canvasOf();
    const camera = canvas.__softnCamera;
    sceneWindow.__scene3dYaw = 0;
    act(() => frames.runFrame());
    // Yaw 0 looks along +z: away from where the camera prop pointed it.
    expect(camera.getWorldDirection(new THREE.Vector3()).z).toBeCloseTo(1, 6);
  });
});

describe('pointer lock, after the scene is made', () => {
  const at = { position: { x: 0, y: 0, z: 8 }, lookAt: { x: 0, y: 0, z: 0 } };
  let locked: Element | null = null;

  beforeEach(() => {
    locked = null;
    Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => locked });
    document.exitPointerLock = vi.fn(() => {
      locked = null;
    });
  });

  afterEach(() => {
    delete (document as unknown as { pointerLockElement?: unknown }).pointerLockElement;
    delete (document as unknown as { exitPointerLock?: unknown }).exitPointerLock;
  });

  it('is offered when turned on, with its crosshair, and withdrawn when turned off', () => {
    render({ pointerLock: false, camera: at });
    const canvas = canvasOf();
    expect(sceneWindow.__scene3dLocked).toBeUndefined();

    render({ pointerLock: true, camera: at });
    expect(canvasOf()).toBe(canvas);
    expect(sceneWindow.__scene3dLocked).toBe(false);
    expect(canvas.style.cursor).toBe('crosshair');
    // The crosshair is two bars over the middle of the scene.
    expect(container.querySelectorAll('div[style*="translate(-50%, -50%)"]')).toHaveLength(1);

    locked = canvas;
    act(() => document.dispatchEvent(new Event('pointerlockchange')));
    expect(sceneWindow.__scene3dLocked).toBe(true);

    render({ pointerLock: false, camera: at });
    expect(document.exitPointerLock).toHaveBeenCalledOnce();
    expect(sceneWindow.__scene3dLocked).toBeUndefined();
    expect(container.querySelectorAll('div[style*="translate(-50%, -50%)"]')).toHaveLength(0);
  });

  it('reports a press while locked as a click at the middle of the scene', () => {
    const clicks: Scene3DHit[] = [];
    render({ pointerLock: true, camera: at, onClick: (hit) => clicks.push(hit) });
    const canvas = placeCanvas(canvasOf(), 400, 200);
    locked = canvas;
    act(() => canvas.dispatchEvent(new MouseEvent('mousedown', { button: 2, bubbles: true, cancelable: true })));
    expect(clicks).toEqual([
      {
        objectId: '',
        instanceId: null,
        distance: null,
        point: null,
        normal: null,
        button: 2,
        locked: true,
        screen: { x: 200, y: 100 },
        dragged: false,
      },
    ]);
  });

  it('going on or off under mouse look leaves the view facing where it faces', () => {
    render({ mouseLook: true, camera: at });
    const canvas = canvasOf();
    drag(canvas, 1, 100, 0);
    const turned = sceneWindow.__scene3dYaw as number;
    expect(turned).not.toBeCloseTo(Math.PI);

    render({ mouseLook: true, pointerLock: true, camera: at });
    expect(sceneWindow.__scene3dYaw).toBe(turned);
    render({ mouseLook: true, pointerLock: false, camera: at });
    expect(sceneWindow.__scene3dYaw).toBe(turned);
  });
});
