/**
 * 3D game smoothness & performance guarantees:
 * - automatic sub-frame-rate tick interpolation (30 Hz logic on 60–240 Hz displays);
 * - camera-local easing for `attach: 'camera'` viewmodels with zero turn lag;
 * - constant-velocity camera motion across periodic ticks (no exponential-lerp sawtooth);
 * - per-scene geometry pooling with reference-counted disposal;
 * - hover raycast elision when no hover callbacks or interactive cursors are present.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createRoot, type Root } from 'react-dom/client';
import { Scene3D, type Scene3DObject, type Scene3DProps } from '../src/threed/Scene3D';
import { TickCadence } from '../src/threed/motion';
import { placeCanvas, pointerEvent, stubFrames, type FrameStub } from './scene3d-doubles';

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

function nodeById<T extends THREE.Object3D = THREE.Mesh>(id: string): T {
  let found: THREE.Object3D | undefined;
  canvasOf().__softnScene.traverse((node) => {
    if (!found && node.userData.__softnId === id) found = node;
  });
  return found as T;
}

function frame(ms: number): void {
  now += ms;
  act(() => frames.runFrame(now));
}

const at = (x: number, y = 0, z = 0) => ({ x, y, z });

describe('TickCadence detector', () => {
  it('activates on 30 Hz ticks across both 120 Hz and 60 Hz displays, and ignores synchronous or 1:1 frame updates', () => {
    const sync = new TickCadence();
    expect(sync.update(1000)).toBe(0);
    expect(sync.update(1033)).toBe(0);
    expect(sync.update(1066)).toBe(0);

    const locked60 = new TickCadence();
    locked60.seed(1000);
    for (let i = 1; i <= 6; i++) {
      locked60.frame(16.67);
      expect(locked60.update(1000 + i * 16.67)).toBe(0);
    }

    // 60 Hz display where a 33 ms interval occasionally straddles only 1 rAF callback.
    const game60 = new TickCadence();
    game60.seed(1000);
    game60.frame(16.67);
    expect(game60.update(1033)).toBe(0); // tick 1 primes streak
    game60.frame(16.67);
    game60.frame(16.67);
    const windowMs = game60.update(1066); // tick 2 activates
    expect(windowMs).toBeGreaterThanOrEqual(33);
    expect(windowMs).toBeLessThanOrEqual(38);
    // Even if the next 33 ms tick catches 1 rAF due to phase alignment, cadence stays active.
    game60.frame(16.67);
    expect(game60.update(1099)).toBeGreaterThanOrEqual(33);
  });
});

describe('automatic sub-frame-rate game loop interpolation', () => {
  it('smoothly moves dynamic objects across intermediate 120 Hz frames on a 33 ms game loop without requiring `transition`', () => {
    const zombie = (x: number, color = '#44aa44'): Scene3DObject => ({
      id: 'zombie',
      type: 'box',
      position: at(x, 0, 0),
      color,
    });

    show([zombie(0)]);
    const mesh = nodeById('zombie');

    // Tick 1 (t + 33ms after four 8.25ms frames)
    for (let f = 0; f < 4; f++) frame(8.25);
    show([zombie(1)]);

    // Tick 2 (t + 66ms): cadence is now active!
    for (let f = 0; f < 4; f++) frame(8.25);
    show([zombie(2, '#ff0000')]);

    // Hit-flash colour still applies immediately (no washed-out flashes),
    // while position eases smoothly across all 4 frames of the 33 ms tick.
    expect((mesh.material as THREE.MeshStandardMaterial).color.getHexString()).toBe('ff0000');

    const xs: number[] = [];
    for (let f = 0; f < 4; f++) {
      frame(8.25);
      xs.push(mesh.position.x);
    }
    expect(xs[0]).toBeGreaterThan(1.1);
    expect(xs[0]).toBeLessThan(1.4);
    expect(xs[1]).toBeGreaterThan(xs[0]);
    expect(xs[2]).toBeGreaterThan(xs[1]);
    expect(xs[3]).toBeGreaterThan(xs[2]);
  });

  it('respects explicit `transition={0}` to opt out of automatic tick interpolation', () => {
    const box = (x: number): Scene3DObject => ({ id: 'b', type: 'box', position: at(x) });
    show([box(0)], { transition: 0 });
    for (let tick = 1; tick <= 4; tick++) {
      for (let f = 0; f < 4; f++) frame(8.25);
      show([box(tick)], { transition: 0 });
      expect(nodeById('b').position.x).toBe(tick);
    }
  });
});

describe('camera-attached viewmodel easing & constant-velocity camera ticks', () => {
  it('eases `attach: "camera"` local offset smoothly across frames while staying locked to camera rotation', () => {
    const gun = (x: number): Scene3DObject => ({
      id: 'gun',
      type: 'box',
      attach: 'camera',
      position: at(x, -0.2, -0.5),
    });
    const cam = { position: at(0, 1.6, 0), lookAt: at(0, 1.6, -5) };
    show([gun(0)], { camera: cam, transition: 100 });
    frame(16);
    const mesh = nodeById('gun');

    show([gun(0.4)], { camera: cam, transition: 100 });
    frame(50);
    // Halfway through 100ms ease: x offset in world space (looking down -Z, +X is world +X) is ~0.2
    expect(mesh.position.x).toBeCloseTo(0.2, 3);
    frame(50);
    expect(mesh.position.x).toBeCloseTo(0.4, 5);
  });

  it('moves the camera at uniform frame-to-frame speed during periodic 33 ms ticks instead of sawtooth lurching', () => {
    const step = 0.25; // ~7.5 m/s sprint at 30 Hz
    show([], { camera: { position: at(0, 1.65, 0), lookAt: at(0, 1.65, 10) }, cameraSmoothing: 0.4 });
    const cam = canvasOf().__softnCamera;

    let z = 0;
    // Run 3 warm-up ticks at 120 Hz (4 frames × 8.25 ms = 33 ms per tick)
    for (let tick = 0; tick < 3; tick++) {
      for (let f = 0; f < 4; f++) frame(8.25);
      z += step;
      show([], { camera: { position: at(0, 1.65, z), lookAt: at(0, 1.65, z + 10) }, cameraSmoothing: 0.4 });
    }

    // Measure per-frame deltas over the next 3 ticks (12 frames at 120 Hz)
    const deltas: number[] = [];
    let prevZ = cam.position.z;
    for (let tick = 0; tick < 3; tick++) {
      for (let f = 0; f < 4; f++) {
        frame(8.25);
        deltas.push(cam.position.z - prevZ);
        prevZ = cam.position.z;
      }
      z += step;
      show([], { camera: { position: at(0, 1.65, z), lookAt: at(0, 1.65, z + 10) }, cameraSmoothing: 0.4 });
    }

    const minDelta = Math.min(...deltas);
    const maxDelta = Math.max(...deltas);
    // Expected uniform delta is ~0.25 / 4 = 0.0625 m/frame. With exponential lerp(0.4),
    // max/min ratio was > 7x; with linear tick cadence, every frame moves smoothly within ~1.35x.
    expect(minDelta).toBeGreaterThan(0.04);
    expect(maxDelta / minDelta).toBeLessThan(1.4);
  });
});

describe('per-scene geometry pooling & hover raycast elision', () => {
  it('shares a single BufferGeometry across identical primitives and disposes it only when the last user leaves', () => {
    show([
      { id: 's1', type: 'sphere', radius: 0.4 },
      { id: 's2', type: 'sphere', radius: 0.4, position: at(2) },
      {
        id: 'grp',
        type: 'group',
        children: [{ id: 's3', type: 'sphere', radius: 0.4, position: at(4) }],
      },
    ]);

    const g1 = nodeById('s1').geometry;
    const g2 = nodeById('s2').geometry;
    const g3 = nodeById('s3').geometry;
    expect(g1).toBe(g2);
    expect(g2).toBe(g3);

    const disposeSpy = vi.spyOn(g1, 'dispose');

    // Removing 2 of the 3 spheres keeps the shared geometry alive
    show([{ id: 's1', type: 'sphere', radius: 0.4 }]);
    expect(disposeSpy).not.toHaveBeenCalled();

    // Removing the final sphere disposes the shared geometry
    show([]);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it('does not schedule hover raycast frames on pointermove when no hover handlers or cursors exist', () => {
    show([{ id: 'wall', type: 'box', width: 4, height: 4, depth: 0.2 }]);
    const canvas = placeCanvas(canvasOf()) as Canvas;
    const pendingBefore = frames.frames.length;

    act(() => {
      canvas.dispatchEvent(pointerEvent('pointermove', 1, 150, 75));
      canvas.dispatchEvent(pointerEvent('pointermove', 1, 160, 80));
    });

    expect(frames.frames.length).toBe(pendingBefore);
  });
});
