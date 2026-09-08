/**
 * Post-processing: retuned in place, rebuilt only when its shape changes,
 * and every pass disposed when it goes.
 *
 * The real composer and passes run against a renderer that draws nothing;
 * the chain is never rendered here, only built, retuned and torn down.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Scene3D } from '../src/threed/Scene3D';
import type { EffectsRig } from '../src/threed/effects';
import { effectsShapeKey, effectsTuneKey, planEffects } from '../src/threed/effects';
import { stubFrames, tick, waitFor } from './scene3d-doubles';

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  const { TestWebGLRenderer } = await import('./scene3d-doubles');
  return { ...actual, WebGLRenderer: TestWebGLRenderer };
});

type Handles = HTMLCanvasElement & { __softnEffects: () => EffectsRig | null };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  stubFrames();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const rig = () => (container.querySelector('canvas') as Handles).__softnEffects();

describe('Scene3D effects', () => {
  it('retunes bloom in place and rebuilds only when an effect is switched', async () => {
    const bloomDispose = vi.spyOn(UnrealBloomPass.prototype, 'dispose');
    const composerDispose = vi.spyOn(EffectComposer.prototype, 'dispose');
    act(() => root.render(<Scene3D effects={{ bloom: { strength: 0.5 } }} />));
    expect(rig()).toBeNull();
    await waitFor(() => rig() !== null, 'the chain to be built');
    const built = rig() as EffectsRig;
    expect(built.bloom?.strength).toBe(0.5);
    expect(built.composer).toBeInstanceOf(EffectComposer);

    act(() => root.render(<Scene3D effects={{ bloom: { strength: 1.2, radius: 0.1 } }} />));
    await tick();
    expect(rig()).toBe(built);
    expect(rig()?.composer).toBe(built.composer);
    expect(built.bloom?.strength).toBe(1.2);
    expect(built.bloom?.radius).toBe(0.1);
    expect(bloomDispose).not.toHaveBeenCalled();
    expect(composerDispose).not.toHaveBeenCalled();

    act(() => root.render(<Scene3D effects={{ bloom: false }} />));
    await tick();
    expect(rig()).toBeNull();
    expect(bloomDispose).toHaveBeenCalledOnce();
    expect(composerDispose).toHaveBeenCalledOnce();
  });

  it('retunes the vignette and grain uniforms without a new pass', async () => {
    act(() => root.render(<Scene3D effects={{ vignette: 0.2, grain: 0.1 }} />));
    await waitFor(() => rig() !== null, 'the chain to be built');
    const built = rig() as EffectsRig;
    expect(built.bloom).toBeNull();
    expect(built.grain?.uniforms.vignette.value).toBe(0.2);

    act(() => root.render(<Scene3D effects={{ vignette: 0.6, grain: 0.3 }} />));
    await tick();
    expect(rig()).toBe(built);
    expect(built.grain?.uniforms.vignette.value).toBe(0.6);
    expect(built.grain?.uniforms.grain.value).toBe(0.3);
  });

  it('adding an effect rebuilds the chain and disposes the old passes', async () => {
    const shaderDispose = vi.spyOn(ShaderPass.prototype, 'dispose');
    const outputDispose = vi.spyOn(OutputPass.prototype, 'dispose');
    act(() => root.render(<Scene3D effects={{ vignette: 0.2 }} />));
    await waitFor(() => rig() !== null, 'the chain to be built');
    const first = rig() as EffectsRig;

    act(() => root.render(<Scene3D effects={{ vignette: 0.2, bloom: true }} />));
    await waitFor(() => rig() !== first && rig() !== null, 'the chain to be rebuilt');
    expect(rig()?.bloom).not.toBeNull();
    expect(rig()?.grain?.uniforms.vignette.value).toBe(0.2);
    // The old grain pass and output pass went with the old chain; the
    // composer's own copy pass is a ShaderPass too, hence two.
    expect(outputDispose).toHaveBeenCalledOnce();
    expect(shaderDispose).toHaveBeenCalledTimes(2);
  });

  it('disposes every pass on unmount', async () => {
    const bloomDispose = vi.spyOn(UnrealBloomPass.prototype, 'dispose');
    const outputDispose = vi.spyOn(OutputPass.prototype, 'dispose');
    act(() => root.render(<Scene3D effects={{ bloom: true, grain: 0.5 }} />));
    await waitFor(() => rig() !== null, 'the chain to be built');
    act(() => root.unmount());
    expect(bloomDispose).toHaveBeenCalledOnce();
    expect(outputDispose).toHaveBeenCalledOnce();
  });

  it('drops a chain whose modules arrive after the effects were switched off', async () => {
    act(() => root.render(<Scene3D effects={{ bloom: true }} />));
    act(() => root.render(<Scene3D />));
    await tick(10);
    expect(rig()).toBeNull();
  });
});

describe('effects plans', () => {
  it('separate shape from tune', () => {
    expect(planEffects(undefined)).toBeNull();
    expect(planEffects({ bloom: false, vignette: 0 })).toBeNull();
    const a = planEffects({ bloom: { strength: 0.5 } });
    const b = planEffects({ bloom: { strength: 2 } });
    const c = planEffects({ bloom: true, grain: 0.2 });
    expect(effectsShapeKey(a)).toBe(effectsShapeKey(b));
    expect(effectsTuneKey(a)).not.toBe(effectsTuneKey(b));
    expect(effectsShapeKey(a)).not.toBe(effectsShapeKey(c));
    expect(effectsShapeKey(null)).toBe('');
  });

  it('clamps vignette and grain to 0..1 and drops non-numbers', () => {
    expect(planEffects({ vignette: 4, grain: -1 })).toEqual({ bloom: null, vignette: 1, grain: 0 });
    expect(planEffects({ vignette: Number.NaN })).toBeNull();
  });
});

describe('bloom numbers', () => {
  // A NaN written into the bloom pass is a NaN in every pixel: a black frame.
  it('fall back to their defaults when they are not finite', () => {
    expect(planEffects({ bloom: { strength: Number.NaN, radius: Number.POSITIVE_INFINITY } })).toEqual({
      bloom: { strength: 0.45, radius: 0.4, threshold: 0.85 },
      vignette: 0,
      grain: 0,
    });
    expect(planEffects({ bloom: true })?.bloom).toEqual({ strength: 0.45, radius: 0.4, threshold: 0.85 });
    expect(planEffects({ bloom: { strength: 2, threshold: 0 } })?.bloom).toEqual({
      strength: 2,
      radius: 0.4,
      threshold: 0,
    });
  });
});
