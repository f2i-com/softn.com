/**
 * The scene's readout (`onStats`): frames a second, and what a frame takes.
 *
 * The renderer here is a double that keeps the counters a real one keeps
 * (`renderer.info`), told by the test what one draw adds to them. Frames are
 * a sixty-fourth of a second apart, which adds up to a second exactly.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as THREE from 'three';
import { createRoot, type Root } from 'react-dom/client';
import { AppScopeProvider, type XDBService } from '@softn/core';
import { Scene3D, type Scene3DProps, type Scene3DStats } from '../src/threed/Scene3D';
import { StatsMeter } from '../src/threed/scene-stats';
import { stubFrames, type FrameStub, type TestWebGLRenderer } from './scene3d-doubles';

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

type Canvas = HTMLCanvasElement & { __softnScene: THREE.Scene; __softnRenderer: TestWebGLRenderer };
const rendererOf = () => (container.querySelector('canvas') as Canvas).__softnRenderer;
const show = (props: Partial<Scene3DProps>, active = true) =>
  act(() =>
    root.render(
      <AppScopeProvider value={{ appId: 'app', xdb: {} as XDBService, active }}>
        <Scene3D lights={[]} objects={[{ id: 'a', type: 'box' }]} {...props} />
      </AppScopeProvider>
    )
  );
/** `count` frames, a sixty-fourth of a second apart. */
function run(count: number): void {
  for (let i = 0; i < count; i++) {
    now += 15.625;
    act(() => frames.runFrame(now));
  }
}

describe('onStats', () => {
  it('says once a second how many frames were drawn in it, and what the last one took', () => {
    const readouts: Scene3DStats[] = [];
    show({ onStats: (stats) => readouts.push(stats) });
    rendererOf().drawn = { calls: 7, triangles: 1200 };
    run(63);
    expect(readouts).toEqual([]);
    run(1);
    expect(readouts).toEqual([{ fps: 64, drawCalls: 7, triangles: 1200 }]);
    // And again a second later, with what a frame takes by then.
    rendererOf().drawn = { calls: 9, triangles: 300 };
    run(64);
    expect(readouts).toHaveLength(2);
    expect(readouts[1]).toEqual({ fps: 64, drawCalls: 9, triangles: 300 });
  });

  it('clears the renderer’s counters once a frame itself, so the passes of a frame add up', () => {
    show({ onStats: () => undefined });
    const renderer = rendererOf();
    run(1);
    expect(renderer.info.autoReset).toBe(false);
    const before = renderer.info.resets;
    run(10);
    expect(renderer.info.resets - before).toBe(10);
  });

  it('counts nothing while it is not bound, and leaves the renderer’s counters to the renderer', () => {
    show({});
    const renderer = rendererOf();
    run(70);
    expect(renderer.info.autoReset).toBe(true);
  });

  it('starts when it is bound and stops when it is not, on a scene that stays', () => {
    const readouts: Scene3DStats[] = [];
    const onStats = (stats: Scene3DStats) => readouts.push(stats);
    show({});
    const renderer = rendererOf();
    run(40);
    show({ onStats });
    // A second from when it was asked for, not from when the scene began.
    run(63);
    expect(readouts).toEqual([]);
    run(1);
    expect(readouts).toHaveLength(1);
    expect(renderer.info.autoReset).toBe(false);

    show({});
    run(200);
    expect(readouts).toHaveLength(1);
    expect(renderer.info.autoReset).toBe(true);
  });

  it('says nothing while the app is hidden, and does not count the time it was', () => {
    const readouts: Scene3DStats[] = [];
    const onStats = (stats: Scene3DStats) => readouts.push(stats);
    show({ onStats });
    run(32);
    show({ onStats }, false);
    now += 60_000;
    show({ onStats }, true);
    run(31);
    expect(readouts).toEqual([]);
    run(1);
    // Sixty-four frames in the second it was drawn for, not in the minute and a second that passed.
    expect(readouts).toEqual([{ fps: 64, drawCalls: 0, triangles: 0 }]);
  });
});

describe('the meter by itself', () => {
  it('counts frames until a second of them has gone by, and starts again', () => {
    const meter = new StatsMeter();
    for (let i = 0; i < 29; i++) expect(meter.frame(1 / 32, { calls: 1, triangles: 2 })).toBeNull();
    for (let i = 0; i < 2; i++) expect(meter.frame(1 / 32, { calls: 1, triangles: 2 })).toBeNull();
    expect(meter.frame(1 / 32, { calls: 3, triangles: 40 })).toEqual({ fps: 32, drawCalls: 3, triangles: 40 });
    expect(meter.frame(1 / 32, undefined)).toBeNull();
  });

  it('takes a frame with no time before it as no measure, and a slow scene as slow', () => {
    const meter = new StatsMeter();
    expect(meter.frame(0, undefined)).toBeNull();
    expect(meter.frame(NaN, undefined)).toBeNull();
    // Two frames half a second apart: two a second.
    expect(meter.frame(0.5, undefined)).toBeNull();
    expect(meter.frame(0.5, undefined)).toEqual({ fps: 2, drawCalls: 0, triangles: 0 });
  });
});
