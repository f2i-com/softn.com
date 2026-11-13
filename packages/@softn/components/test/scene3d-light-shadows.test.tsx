/**
 * Two things a light's shadows can be told: `shadowNormalBias`, and
 * `follow: 'view'` for a directional light.
 *
 * The lights and their shadow cameras are three's own; the renderer draws
 * nothing. Where the box a light shadows is asked about, it is asked of
 * three's own shadow camera, as three places it for the light. That a shadow
 * comes out without banding is checked in a browser.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { Scene3D, type Scene3DLight, type Scene3DProps } from '../src/threed/Scene3D';
import { stubFrames, type FrameStub } from './scene3d-doubles';

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  const { TestWebGLRenderer } = await import('./scene3d-doubles');
  return { ...actual, WebGLRenderer: TestWebGLRenderer };
});

import * as THREE from 'three';

let container: HTMLDivElement;
let root: Root;
let frames: FrameStub;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  frames = stubFrames();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const show = (lights: Scene3DLight[], props: Partial<Scene3DProps> = {}) => act(() => root.render(<Scene3D shadows lights={lights} {...props} />));
const frame = () => act(() => frames.runFrame());
const sceneOf = () => (container.querySelector('canvas') as HTMLCanvasElement & { __softnScene: THREE.Scene }).__softnScene;
const lightsIn = () => sceneOf().children.filter((node) => (node as THREE.Light).isLight) as THREE.Light[];
type Shadowed = THREE.DirectionalLight | THREE.SpotLight | THREE.PointLight;

describe('`shadowNormalBias`', () => {
  it('is none unless a light gives one, for each kind of light that casts shadows', () => {
    show([
      { id: 'sun', type: 'directional', castShadow: true },
      { id: 'lamp', type: 'point', castShadow: true },
      { id: 'torch', type: 'spot', castShadow: true },
    ]);
    expect(lightsIn().map((light) => (light as Shadowed).shadow.normalBias)).toEqual([0, 0, 0]);
  });

  it('is three’s own normal bias, in scene units, and follows a change while the light stays', () => {
    show([
      { id: 'sun', type: 'directional', castShadow: true, shadowNormalBias: 0.05 },
      { id: 'torch', type: 'spot', castShadow: true, shadowNormalBias: 0.02 },
    ]);
    const [sun, torch] = lightsIn() as Shadowed[];
    expect([sun.shadow.normalBias, torch.shadow.normalBias]).toEqual([0.05, 0.02]);
    // The constant bias is its own number, as it was.
    expect(sun.shadow.bias).toBe(-0.0005);

    show([
      { id: 'sun', type: 'directional', castShadow: true, shadowNormalBias: 0.2, shadowBias: -0.001 },
      { id: 'torch', type: 'spot', castShadow: true },
    ]);
    expect(lightsIn()[0]).toBe(sun);
    expect([sun.shadow.normalBias, sun.shadow.bias, torch.shadow.normalBias]).toEqual([0.2, -0.001, 0]);
    // A number that is none, or that would pull the lookup into the surface, is none.
    for (const none of [Number.NaN, -1, '0.1' as unknown as number]) {
      show([{ id: 'sun', type: 'directional', castShadow: true, shadowNormalBias: none }]);
      expect(sun.shadow.normalBias).toBe(0);
    }
  });
});

describe('`follow: \'view\'` on a directional light', () => {
  // Looking level along -z from two units up; a sun straight overhead, shadowing ten units each way.
  const camera = { position: { x: 0, y: 2, z: 0 }, lookAt: { x: 0, y: 2, z: -10 } };
  const sun = (follow: Scene3DLight['follow']): Scene3DLight => ({
    id: 'sun',
    type: 'directional',
    position: { x: 0, y: 10, z: 0 },
    castShadow: true,
    shadowCameraSize: 10,
    follow,
  });
  const light = () => lightsIn()[0] as THREE.DirectionalLight;
  /** Whether three's shadow camera for the light, placed as three places it, has a point of the world in its box. */
  function shadows(point: [number, number, number]): boolean {
    const l = light();
    sceneOf().updateMatrixWorld(true);
    l.shadow.updateMatrices(l);
    const at = new THREE.Vector3(...point).applyMatrix4(l.shadow.camera.matrixWorldInverse).applyMatrix4(l.shadow.camera.projectionMatrix);
    return Math.abs(at.x) <= 1 && Math.abs(at.y) <= 1 && Math.abs(at.z) <= 1;
  }
  // A shadow map of 1024 over twenty units: the box moves in steps this long.
  const texel = 20 / 1024;

  it('puts the middle of the shadow box 0.8 of its half-width ahead of the camera, along its line of sight', () => {
    show([sun('view')], { camera });
    frame();
    const target = light().target.position;
    expect(Math.abs(target.x)).toBeLessThanOrEqual(texel);
    expect(Math.abs(target.z - -8)).toBeLessThanOrEqual(texel);
    // It shines the way it did: straight down, from as far off as it stood.
    const from = light().position.clone().sub(target);
    expect(from.x).toBeCloseTo(0, 9);
    expect(from.y).toBeCloseTo(10, 9);
    expect(from.z).toBeCloseTo(0, 9);

    // What is in the picture, far ahead, is in the box; what is behind the camera is not.
    expect(shadows([0, 0, -15])).toBe(true);
    expect(shadows([0, 0, -1])).toBe(true);
    expect(shadows([0, 0, 5])).toBe(false);
  });

  it('`follow: \'camera\'` is about the camera as it was: half the box behind it', () => {
    show([sun('camera')], { camera });
    frame();
    expect(Math.abs(light().target.position.z)).toBeLessThanOrEqual(texel);
    expect(shadows([0, 0, -15])).toBe(false);
    expect(shadows([0, 0, 5])).toBe(true);
  });

  it('goes with the camera as it moves and turns, and lets the light go when it follows no more', () => {
    show([sun('view')], { camera });
    frame();
    // Forty along x, and looking along +x now.
    show([sun('view')], { camera: { position: { x: 40, y: 2, z: 0 }, lookAt: { x: 50, y: 2, z: 0 } } });
    frame();
    const target = light().target.position;
    expect(Math.abs(target.x - 48)).toBeLessThanOrEqual(texel);
    expect(Math.abs(target.z)).toBeLessThanOrEqual(texel);
    expect(shadows([55, 0, 0])).toBe(true);
    expect(shadows([35, 0, 0])).toBe(false);

    // From one way of following to the other, on the light it has.
    const same = light();
    show([sun('camera')], { camera: { position: { x: 40, y: 2, z: 0 }, lookAt: { x: 50, y: 2, z: 0 } } });
    frame();
    expect(light()).toBe(same);
    expect(Math.abs(light().target.position.x - 40)).toBeLessThanOrEqual(texel);

    show([sun(undefined)], { camera: { position: { x: 40, y: 2, z: 0 }, lookAt: { x: 50, y: 2, z: 0 } } });
    frame();
    expect(light().target.position.toArray()).toEqual([0, 0, 0]);
    expect(light().position.toArray()).toEqual([0, 10, 0]);
  });
});
