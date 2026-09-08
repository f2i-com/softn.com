/**
 * A scene draws only while its app is shown.
 *
 * The host's word arrives through AppScope.active; the document's through
 * visibilitychange. Either says no and no frame is scheduled; both say yes
 * and the loop resumes with a clock that does not hand the first frame the
 * whole hidden interval.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createRoot, type Root } from 'react-dom/client';
import { AppScopeProvider, type XDBService } from '@softn/core';
import { Scene3D } from '../src/threed/Scene3D';
import { FrameLoop } from '../src/threed/activity';
import { stubFrames, type FrameStub } from './scene3d-doubles';

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
  setVisibility('visible');
});

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

function inApp(active: boolean, child: React.ReactElement): React.ReactElement {
  return (
    <AppScopeProvider value={{ appId: 'app', xdb: {} as XDBService, active }}>{child}</AppScopeProvider>
  );
}

const spinner = { id: 'spin', type: 'box' as const, animate: { rotateY: 0.1 } };

function spinnerNode(): THREE.Object3D {
  const scene = (container.querySelector('canvas') as HTMLCanvasElement & { __softnScene: THREE.Scene })
    .__softnScene;
  let found: THREE.Object3D | undefined;
  scene.traverse((node) => {
    if (node.userData.__softnId === 'spin') found = node;
  });
  return found as THREE.Object3D;
}

describe('Scene3D activity', () => {
  it('schedules no frame while the app is inactive, and starts when it becomes active', () => {
    act(() => root.render(inApp(false, <Scene3D objects={[spinner]} />)));
    expect(container.querySelector('canvas')).not.toBeNull();
    expect(frames.raf).not.toHaveBeenCalled();

    act(() => root.render(inApp(true, <Scene3D objects={[spinner]} />)));
    expect(frames.raf).toHaveBeenCalledTimes(1);

    act(() => root.render(inApp(false, <Scene3D objects={[spinner]} />)));
    expect(frames.caf).toHaveBeenCalledWith(1);
    // A frame the browser had already queued is a no-op once stopped.
    act(() => frames.runFrame());
    expect(frames.raf).toHaveBeenCalledTimes(1);
  });

  it('re-baselines the clock on resume so animation does not jump the hidden interval', () => {
    act(() => root.render(inApp(false, <Scene3D objects={[spinner]} />)));
    const node = spinnerNode();
    const before = node.rotation.y;

    now += 30_000;
    act(() => root.render(inApp(true, <Scene3D objects={[spinner]} />)));
    now += 16;
    act(() => frames.runFrame(now));
    // 0.1 per 60 Hz frame: one frame's worth, not thirty seconds' worth.
    expect(node.rotation.y - before).toBeGreaterThan(0.05);
    expect(node.rotation.y - before).toBeLessThan(0.2);
  });

  it('stops for a hidden document and resumes when it is shown', () => {
    act(() => root.render(<Scene3D objects={[spinner]} />));
    expect(frames.raf).toHaveBeenCalledTimes(1);

    setVisibility('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(frames.caf).toHaveBeenCalledWith(1);
    act(() => frames.runFrame());
    expect(frames.raf).toHaveBeenCalledTimes(1);

    setVisibility('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(frames.raf).toHaveBeenCalledTimes(2);
  });

  it('keeps every object while stopped', () => {
    act(() => root.render(inApp(true, <Scene3D objects={[spinner]} />)));
    const node = spinnerNode();
    act(() => root.render(inApp(false, <Scene3D objects={[spinner]} />)));
    expect(spinnerNode()).toBe(node);
    act(() => root.render(inApp(true, <Scene3D objects={[spinner]} />)));
    expect(spinnerNode()).toBe(node);
  });

  it('cancels its frame on unmount', () => {
    act(() => root.render(<Scene3D />));
    act(() => root.unmount());
    expect(frames.caf).toHaveBeenCalledWith(1);
  });
});

describe('FrameLoop', () => {
  it('schedules the next frame before drawing, so a throwing frame does not end the loop', () => {
    const clock = new THREE.Clock();
    let draws = 0;
    const loop = new FrameLoop(clock, () => {
      draws += 1;
      if (draws === 1) throw new Error('one bad frame');
    });
    loop.setRunning(true);
    expect(frames.raf).toHaveBeenCalledTimes(1);
    expect(() => frames.runFrame()).toThrow('one bad frame');
    expect(frames.raf).toHaveBeenCalledTimes(2);
    frames.runFrame();
    expect(draws).toBe(2);
    expect(frames.raf).toHaveBeenCalledTimes(3);
    loop.dispose();
    expect(frames.caf).toHaveBeenCalledWith(3);
    // Disposed is final: the switch no longer schedules anything.
    loop.setRunning(true);
    expect(frames.raf).toHaveBeenCalledTimes(3);
    expect(loop.isRunning).toBe(false);
  });

  it('is idempotent about its switch', () => {
    const loop = new FrameLoop(new THREE.Clock(), () => {});
    loop.setRunning(true);
    loop.setRunning(true);
    expect(frames.raf).toHaveBeenCalledTimes(1);
    loop.setRunning(false);
    loop.setRunning(false);
    expect(frames.caf).toHaveBeenCalledTimes(1);
    expect(loop.isRunning).toBe(false);
  });
});

describe('Scene3D float animation across a pause', () => {
  const floater = { id: 'float', type: 'box' as const, animate: { floatAmplitude: 1, floatSpeed: 1 } };

  function floaterNode(): THREE.Object3D {
    const scene = (container.querySelector('canvas') as HTMLCanvasElement & { __softnScene: THREE.Scene })
      .__softnScene;
    let found: THREE.Object3D | undefined;
    scene.traverse((node) => {
      if (node.userData.__softnId === 'float') found = node;
    });
    return found as THREE.Object3D;
  }

  // Height is a function of the clock's elapsed time, so the hidden interval
  // has to come out of that as well as out of the first delta.
  it('keeps its phase: elapsed time advances a frame on resume, not the hidden interval', () => {
    act(() => root.render(inApp(true, <Scene3D objects={[floater]} />)));
    const node = floaterNode();
    now += 16;
    act(() => frames.runFrame(now));
    expect(node.position.y).toBeCloseTo(Math.sin(0.016), 4);

    act(() => root.render(inApp(false, <Scene3D objects={[floater]} />)));
    now += 30_000;
    act(() => root.render(inApp(true, <Scene3D objects={[floater]} />)));
    now += 16;
    act(() => frames.runFrame(now));
    expect(node.position.y).toBeCloseTo(Math.sin(0.032), 4);
  });

  it('is what FrameLoop does to the clock on resume', () => {
    const clock = new THREE.Clock();
    const loop = new FrameLoop(clock, () => {});
    loop.setRunning(true);
    now += 16;
    expect(clock.getDelta()).toBeCloseTo(0.016, 6);
    loop.setRunning(false);
    now += 30_000;
    loop.setRunning(true);
    expect(clock.getElapsedTime()).toBeCloseTo(0.016, 6);
    now += 16;
    expect(clock.getDelta()).toBeCloseTo(0.016, 6);
    expect(clock.getElapsedTime()).toBeCloseTo(0.032, 6);
    loop.dispose();
  });
});
