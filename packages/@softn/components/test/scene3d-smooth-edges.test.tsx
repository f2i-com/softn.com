/**
 * Smooth edges with effects on.
 *
 * A frame drawn through the post-processing chain is drawn into a target of
 * the composer's, not into the canvas, so the canvas's own smoothing does not
 * reach it. The target the scene is drawn into is given samples when the
 * scene was made with `antialias`; nothing else is.
 *
 * The composer, its targets and its passes are three's own; the renderer is
 * a stand-in that says how many samples its device allows. That the edges
 * come out smooth is checked in a browser.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { Scene3D, type Scene3DProps } from '../src/threed/Scene3D';
import type { EffectsRig } from '../src/threed/effects';
import { sceneSamples } from '../src/threed/effects';
import { stubFrames, waitFor, type FrameStub } from './scene3d-doubles';

const device = vi.hoisted(() => ({ maxSamples: 8 as number | undefined }));

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  const { TestWebGLRenderer } = await import('./scene3d-doubles');
  class DeviceRenderer extends TestWebGLRenderer {
    capabilities = { getMaxAnisotropy: () => 4, maxSamples: device.maxSamples };
  }
  return { ...actual, WebGLRenderer: DeviceRenderer };
});

import * as THREE from 'three';

type Handles = HTMLCanvasElement & { __softnEffects: () => EffectsRig | null };

let container: HTMLDivElement;
let root: Root;
let frames: FrameStub;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  frames = stubFrames();
  device.maxSamples = 8;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const rig = () => (container.querySelector('canvas') as Handles | null)?.__softnEffects() ?? null;
async function build(props: Partial<Scene3DProps>): Promise<EffectsRig> {
  act(() => root.render(<Scene3D {...props} />));
  await waitFor(() => rig() !== null, 'the chain to be built');
  return rig() as EffectsRig;
}
/** Every target the bloom pass keeps for itself. */
const bloomTargets = (bloom: UnrealBloomPass): THREE.WebGLRenderTarget[] => [
  bloom.renderTargetBright,
  ...bloom.renderTargetsHorizontal,
  ...bloom.renderTargetsVertical,
];

describe('the target a scene with effects is drawn into', () => {
  it('has four samples when the scene has `antialias` (the default), and nothing else of the chain has any', async () => {
    const built = await build({ effects: { bloom: true, vignette: 0.3 } });
    const { composer } = built;
    expect(built.samples).toBe(4);
    // The second of the composer's two: the one passes read from first.
    expect(composer.renderTarget2.samples).toBe(4);
    expect(composer.renderTarget1.samples).toBe(0);
    const mips = bloomTargets(built.bloom as UnrealBloomPass);
    expect(mips.length).toBeGreaterThan(5);
    expect(mips.map((target) => target.samples)).toEqual(mips.map(() => 0));
    // Light values with room above white, as before: what tone mapping at the end works on.
    expect(composer.renderTarget2.texture.type).toBe(THREE.HalfFloatType);
    // And the chain ends as it did: tone mapping and the screen's colours, then the grain.
    expect(composer.passes[0]).toBeInstanceOf(RenderPass);
    expect(composer.passes[1]).toBe(built.bloom);
    expect(composer.passes[2]).toBeInstanceOf(OutputPass);
    expect(composer.passes[3]).toBe(built.grain);
  });

  it('keeps them through a new size and a new pixel ratio', async () => {
    const built = await build({ effects: { bloom: true }, width: 320, height: 200 });
    const target = built.composer.renderTarget2;
    act(() => root.render(<Scene3D effects={{ bloom: true }} width={640} height={360} />));
    expect([target.width, target.height]).toEqual([640, 360]);
    expect(target.samples).toBe(4);
    built.setPixelRatio(2);
    expect([target.width, target.height]).toEqual([1280, 720]);
    expect(target.samples).toBe(4);
    expect(built.composer.renderTarget1.samples).toBe(0);
    expect(rig()).toBe(built);
  });

  it('has none when the scene was made without `antialias`', async () => {
    const built = await build({ effects: { bloom: true }, antialias: false });
    expect(built.samples).toBe(0);
    expect(built.composer.renderTarget2.samples).toBe(0);
    expect(built.composer.renderTarget1.samples).toBe(0);
  });

  it('is held to what the device allows', async () => {
    device.maxSamples = 2;
    const built = await build({ effects: { bloom: true } });
    expect(built.composer.renderTarget2.samples).toBe(2);

    const renderer = (limit: unknown) => ({ capabilities: { maxSamples: limit } }) as unknown as THREE.WebGLRenderer;
    expect(sceneSamples(renderer(16), true)).toBe(4);
    expect(sceneSamples(renderer(4), true)).toBe(4);
    expect(sceneSamples(renderer(0), true)).toBe(0);
    // A renderer that does not say is left to three, which holds a target to the device's limit itself.
    expect(sceneSamples(renderer(undefined), true)).toBe(4);
    expect(sceneSamples(renderer(16), false)).toBe(0);
  });

  it('is the one the scene is drawn into on every frame, though the composer swaps its two as it goes', async () => {
    const built = await build({ effects: { bloom: true } });
    const { composer } = built;
    const drawnInto: THREE.WebGLRenderTarget[] = [];
    // A chain of bloom alone swaps the two targets once a frame: stood in for here, since the stand-in renderer draws no pass.
    vi.spyOn(composer, 'render').mockImplementation(() => {
      drawnInto.push(composer.readBuffer);
      composer.swapBuffers();
    });
    for (let i = 0; i < 4; i++) act(() => frames.runFrame());
    expect(drawnInto).toHaveLength(4);
    expect(drawnInto.every((target) => target === composer.renderTarget2)).toBe(true);
  });

  // What the above relies on: three's scene pass draws into the target it is handed to read from.
  it('three’s RenderPass draws the scene into the buffer the next pass reads', () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const read = new THREE.WebGLRenderTarget(4, 4, { samples: 4 });
    const write = new THREE.WebGLRenderTarget(4, 4);
    const calls: unknown[] = [];
    const renderer = {
      autoClear: true,
      setRenderTarget: (target: unknown) => calls.push(['target', target]),
      clear: () => calls.push(['clear']),
      render: (drawn: unknown) => calls.push(['render', drawn]),
    } as unknown as THREE.WebGLRenderer;
    const pass = new RenderPass(scene, camera);
    pass.renderToScreen = false;
    pass.render(renderer, write, read, 0, false);
    expect(calls).toEqual([['target', read], ['clear'], ['render', scene]]);
    expect(pass.needsSwap).toBe(false);
  });
});
