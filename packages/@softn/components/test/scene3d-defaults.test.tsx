/**
 * What a scene is when it is told little.
 *
 * `<Scene3D objects={…} />`, the first thing anyone writes, drew black
 * objects on a dark ground, eight hundred pixels wide whatever it stood in.
 * A scene that names no lights is now lit, and one that is not told to fill
 * its box is never wider than the room it has. And a sun can be told to
 * keep the camera inside its shadows.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createRoot, type Root } from 'react-dom/client';
import { Scene3D, type Scene3DLight, type Scene3DProps } from '../src/threed/Scene3D';
import { stubFrames, type FrameStub, type TestWebGLRenderer } from './scene3d-doubles';

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  const { TestWebGLRenderer } = await import('./scene3d-doubles');
  class TestPMREMGenerator {
    fromScene() {
      return new actual.WebGLRenderTarget(16, 16);
    }
    dispose() {}
  }
  return { ...actual, WebGLRenderer: TestWebGLRenderer, PMREMGenerator: TestPMREMGenerator };
});

type Canvas = HTMLCanvasElement & {
  __softnScene: THREE.Scene;
  __softnRenderer: TestWebGLRenderer;
  __softnCamera: THREE.PerspectiveCamera;
};

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

const canvasOf = () => container.querySelector('canvas') as Canvas;
const render = (props: Partial<Scene3DProps>) => act(() => root.render(<Scene3D {...props} />));
function lightsIn(): THREE.Light[] {
  const found: THREE.Light[] = [];
  canvasOf().__softnScene.traverse((node) => {
    if ((node as THREE.Light).isLight) found.push(node as THREE.Light);
  });
  return found;
}
const kinds = () => lightsIn().map((light) => light.type).sort();

describe('a scene that names no lights', () => {
  it('is lit by a soft ambient light and a sun, so what is in it can be seen', () => {
    render({ objects: [{ id: 'a', type: 'box' }] });
    expect(kinds()).toEqual(['AmbientLight', 'DirectionalLight']);
    const sun = lightsIn().find((light) => light.type === 'DirectionalLight') as THREE.DirectionalLight;
    expect(sun.intensity).toBeGreaterThan(1);
    // From above and to one side, not straight down: a box has a lit side and a shaded one.
    expect(sun.position.y).toBeGreaterThan(0);
    expect(Math.abs(sun.position.x) + Math.abs(sun.position.z)).toBeGreaterThan(0);
    // It casts shadows, which are drawn when the scene asks for them.
    expect(sun.castShadow).toBe(true);
  });

  it('is dark when it says so with an empty list', () => {
    render({ objects: [{ id: 'a', type: 'box' }], lights: [] });
    expect(lightsIn()).toEqual([]);
  });

  it('is left to its studio environment when it has one', () => {
    render({ environment: 'studio' });
    expect(lightsIn()).toEqual([]);
    render({ environment: 'none' });
    expect(kinds()).toEqual(['AmbientLight', 'DirectionalLight']);
  });

  it('gives the lights up for its own as soon as it names any, and takes them back when it names none again', () => {
    render({});
    expect(lightsIn()).toHaveLength(2);
    const own: Scene3DLight[] = [{ id: 'lamp', type: 'point', position: { x: 0, y: 2, z: 0 } }];
    render({ lights: own });
    expect(kinds()).toEqual(['PointLight']);
    render({});
    expect(kinds()).toEqual(['AmbientLight', 'DirectionalLight']);
  });

  it('keeps the same two lights from one render to the next', () => {
    render({ objects: [{ id: 'a', type: 'box' }] });
    const first = lightsIn();
    render({ objects: [{ id: 'a', type: 'box', color: '#ff0000' }] });
    expect(lightsIn()).toEqual(first);
    expect(lightsIn()[0]).toBe(first[0]);
  });
});

describe('a scene that is not told to fill its box', () => {
  /** Give every element a layout width, which jsdom has none of, and a way to say it changed. */
  function layOut(width: number) {
    const state = { width, observers: [] as Array<() => void> };
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(() => state.width);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(notify: () => void) {
          state.observers.push(notify);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    return {
      resize(next: number) {
        state.width = next;
        act(() => state.observers.forEach((notify) => notify()));
      },
    };
  }
  const box = () => container.firstElementChild as HTMLElement;

  it('is its width where there is room, and says how to be narrower where there is not', () => {
    render({});
    expect(box().style.width).toBe('800px');
    expect(box().style.maxWidth).toBe('100%');
    // Its height is a number of pixels, as it always was: left to the browser to work out
    // from the width, a scene beside something taller in a row was stretched to that height.
    expect(box().style.height).toBe('600px');
    expect((box().style as CSSStyleDeclaration & { aspectRatio?: string }).aspectRatio ?? '').toBe('');
    // With nowhere measured to stand, it is drawn at the size it was given.
    expect(canvasOf().__softnRenderer.sizes.every(([w, h]) => w === 800 && h === 600)).toBe(true);
    expect(canvasOf().__softnCamera.aspect).toBeCloseTo(800 / 600);
  });

  it('is drawn at the width it was given, keeping its shape, from the first frame', () => {
    layOut(390);
    render({});
    const renderer = canvasOf().__softnRenderer;
    // 390 wide is 292.5 tall at four to three.
    expect(renderer.sizes[0]).toEqual([390, 293]);
    expect(renderer.sizes.every(([w, h]) => w === 390 && h === 293)).toBe(true);
    expect(canvasOf().__softnCamera.aspect).toBeCloseTo(390 / 293);
    // And its box is as tall as the canvas in it, so nothing is left over beneath.
    expect(box().style.height).toBe('293px');
  });

  // Found by review in a real browser, 2026-11-13: with the height left to the browser, a scene
  // whose page gave it `width: 100%` in a place 1400 wide was 1400 by 1050, where it had been
  // 1400 by 600 round a canvas of 800 by 600.
  it('is as tall as it was asked to be in a place wider than it, whatever width the page’s own style gives its box', () => {
    layOut(1400);
    render({ style: { width: '100%' } });
    expect(box().style.width).toBe('100%');
    expect(box().style.height).toBe('600px');
    expect(canvasOf().__softnRenderer.sizes.at(-1)).toEqual([800, 600]);
  });

  it('follows the room it has as that changes, and is never wider than it was asked to be', () => {
    const room = layOut(1200);
    render({ width: 640, height: 360 });
    const renderer = canvasOf().__softnRenderer;
    expect(renderer.sizes.at(-1)).toEqual([640, 360]);
    expect(box().style.height).toBe('360px');
    room.resize(320);
    expect(renderer.sizes.at(-1)).toEqual([320, 180]);
    expect(box().style.height).toBe('180px');
    expect(canvasOf().__softnCamera.aspect).toBeCloseTo(16 / 9);
    room.resize(2000);
    expect(renderer.sizes.at(-1)).toEqual([640, 360]);
    expect(box().style.height).toBe('360px');
  });

  it('leaves a scene that fills its box, and a page’s own style, as they were', () => {
    layOut(390);
    render({ fill: true });
    expect(box().style.width).toBe('100%');
    expect(box().style.height).toBe('100%');
    expect(box().style.maxWidth).toBe('');
    render({ style: { maxWidth: 'none', height: 300 } });
    // The page's own style has the last word.
    expect(box().style.maxWidth).toBe('none');
    expect(box().style.height).toBe('300px');
  });
});

describe('a sun that follows the camera', () => {
  const sunOf = () => lightsIn().find((light) => light.type === 'DirectionalLight') as THREE.DirectionalLight;
  const sun = (extra: Partial<Scene3DLight> = {}): Scene3DLight => ({
    id: 'sun',
    type: 'directional',
    position: { x: 10, y: 20, z: 0 },
    castShadow: true,
    shadowCameraSize: 16,
    shadowMapSize: 1024,
    ...extra,
  });
  const at = (x: number, z: number) => ({ position: { x, y: 2, z }, lookAt: { x: x + 1, y: 2, z } });

  it('stays where it is put, shining at the middle of the world, unless it is told to follow', () => {
    render({ lights: [sun()], camera: at(300, -40) });
    act(() => frames.runFrame());
    expect(sunOf().position.toArray()).toEqual([10, 20, 0]);
    expect(sunOf().target.position.toArray()).toEqual([0, 0, 0]);
  });

  it('stands the same way from the camera wherever the camera is, so its shadows are around the camera', () => {
    render({ lights: [sun({ follow: 'camera' })], camera: at(300, -40) });
    act(() => frames.runFrame());
    const light = sunOf();
    const target = light.target.position.clone();
    // A texel of this shadow map is 32 / 1024 of a unit: the middle of the
    // shadow box is within one of the camera.
    expect(target.distanceTo(new THREE.Vector3(300, 2, -40))).toBeLessThan(0.05);
    // The same direction as where it was put: only the place moved.
    expect(light.position.clone().sub(target).distanceTo(new THREE.Vector3(10, 20, 0))).toBeLessThan(1e-6);

    render({ lights: [sun({ follow: 'camera' })], camera: at(-75, 12) });
    act(() => frames.runFrame());
    expect(light.target.position.distanceTo(new THREE.Vector3(-75, 2, 12))).toBeLessThan(0.05);
    expect(light.position.clone().sub(light.target.position).distanceTo(new THREE.Vector3(10, 20, 0))).toBeLessThan(1e-6);
  });

  it('moves in whole texels of its shadow map, so shadow edges do not crawl as the camera walks', () => {
    render({ lights: [sun({ follow: 'camera' })], camera: at(0, 0) });
    act(() => frames.runFrame());
    const light = sunOf();
    const first = light.target.position.clone();
    // A step of a hundredth of a unit is a third of a texel: the box stays.
    render({ lights: [sun({ follow: 'camera' })], camera: at(0, 0.01) });
    act(() => frames.runFrame());
    expect(light.target.position.distanceTo(first)).toBeLessThan(1e-9);
    // A step of a whole unit moves it by thirty-two of them.
    render({ lights: [sun({ follow: 'camera' })], camera: at(0, 1) });
    act(() => frames.runFrame());
    expect(light.target.position.distanceTo(first)).toBeCloseTo(1, 6);
  });

  it('goes back to where it was put when it stops following', () => {
    render({ lights: [sun({ follow: 'camera' })], camera: at(300, -40) });
    act(() => frames.runFrame());
    render({ lights: [sun()], camera: at(300, -40) });
    act(() => frames.runFrame());
    expect(sunOf().position.toArray()).toEqual([10, 20, 0]);
    expect(sunOf().target.position.toArray()).toEqual([0, 0, 0]);
  });
});
