import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sceneMocks = vi.hoisted(() => ({
  rendererDispose: vi.fn(),
  rendererForceContextLoss: vi.fn(),
  pendingLoad: null as null | {
    resolve: (value: {
      scene: import('three').Object3D;
      animations: import('three').AnimationClip[];
    }) => void;
    reject: (error: unknown) => void;
  },
}));

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();

  class TestWebGLRenderer {
    domElement = document.createElement('canvas');
    shadowMap = { enabled: false, type: 0 };
    setSize() {}
    setPixelRatio() {}
    render() {}
    dispose() {
      sceneMocks.rendererDispose();
    }
    forceContextLoss() {
      sceneMocks.rendererForceContextLoss();
    }
  }

  return { ...actual, WebGLRenderer: TestWebGLRenderer };
});

vi.mock('three/addons/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    load(
      _url: string,
      resolve: (value: {
        scene: import('three').Object3D;
        animations: import('three').AnimationClip[];
      }) => void,
      _progress: unknown,
      reject: (error: unknown) => void
    ) {
      sceneMocks.pendingLoad = { resolve, reject };
    }
  },
}));

import * as THREE from 'three';
import { createRoot, type Root } from 'react-dom/client';
import { Scene3D } from '../src/threed/Scene3D';

function pointerEvent(
  type: string,
  pointerId: number,
  clientX = 0,
  clientY = 0,
  button = 0
): PointerEvent {
  const event = new MouseEvent(type, { bubbles: true, clientX, clientY, button });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  return event as PointerEvent;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sceneMocks.rendererDispose.mockClear();
  sceneMocks.rendererForceContextLoss.mockClear();
  sceneMocks.pendingLoad = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1)
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as Window & { __scene3dYaw?: number }).__scene3dYaw;
  delete (window as Window & { __scene3dPitch?: number }).__scene3dPitch;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Scene3D resource ownership', () => {
  it('disposes its renderer and detaches its canvas on unmount', () => {
    act(() => root.render(<Scene3D />));
    expect(container.querySelector('canvas')).not.toBeNull();

    act(() => root.unmount());

    expect(sceneMocks.rendererDispose).toHaveBeenCalledOnce();
    expect(sceneMocks.rendererForceContextLoss).toHaveBeenCalledOnce();
    expect(container.querySelector('canvas')).toBeNull();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
  });

  it('disposes a model that finishes loading after unmount', async () => {
    act(() =>
      root.render(<Scene3D objects={[{ id: 'late', type: 'model', modelUrl: '/late.glb' }]} />)
    );
    expect(sceneMocks.pendingLoad).not.toBeNull();

    const geometry = new THREE.BoxGeometry();
    const material = new THREE.MeshStandardMaterial();
    const disposeGeometry = vi.spyOn(geometry, 'dispose');
    const disposeMaterial = vi.spyOn(material, 'dispose');
    const loaded = new THREE.Group();
    loaded.add(new THREE.Mesh(geometry, material));

    act(() => root.unmount());
    await act(async () => {
      sceneMocks.pendingLoad!.resolve({ scene: loaded, animations: [] });
      await Promise.resolve();
    });

    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disposeMaterial).toHaveBeenCalledOnce();
  });

  it('does not report an expected stale load rejection after unmount', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    act(() =>
      root.render(<Scene3D objects={[{ id: 'late', type: 'model', modelUrl: '/late.glb' }]} />)
    );

    act(() => root.unmount());
    await act(async () => {
      sceneMocks.pendingLoad!.reject(new Error('request aborted'));
      await Promise.resolve();
    });

    expect(consoleError.mock.calls.some(([message]) => String(message).includes('[Scene3D]'))).toBe(
      false
    );
  });

  it('ends mouse look on pointer cancellation or lost capture', () => {
    act(() => root.render(<Scene3D mouseLook />));
    const canvas = container.querySelector('canvas')!;
    canvas.setPointerCapture = vi.fn();
    const sceneWindow = window as Window & { __scene3dYaw?: number };

    const initialYaw = sceneWindow.__scene3dYaw!;
    act(() => {
      canvas.dispatchEvent(pointerEvent('pointerdown', 7, 10, 10));
      canvas.dispatchEvent(pointerEvent('pointermove', 7, 30, 10));
    });
    expect(canvas.style.cursor).toBe('grabbing');
    expect(sceneWindow.__scene3dYaw).not.toBe(initialYaw);

    act(() => canvas.dispatchEvent(pointerEvent('pointercancel', 7, 30, 10)));
    expect(canvas.style.cursor).toBe('grab');
    const cancelledYaw = sceneWindow.__scene3dYaw;
    act(() => canvas.dispatchEvent(pointerEvent('pointermove', 7, 80, 10)));
    expect(sceneWindow.__scene3dYaw).toBe(cancelledYaw);

    act(() => {
      canvas.dispatchEvent(pointerEvent('pointerdown', 8, 10, 10));
      canvas.dispatchEvent(pointerEvent('lostpointercapture', 8, 10, 10));
    });
    expect(canvas.style.cursor).toBe('grab');
    const lostCaptureYaw = sceneWindow.__scene3dYaw;
    act(() => canvas.dispatchEvent(pointerEvent('pointermove', 8, 80, 10)));
    expect(sceneWindow.__scene3dYaw).toBe(lostCaptureYaw);
  });

  it('captures click tracking and releases ownership on completion or cancellation', () => {
    act(() => root.render(<Scene3D />));
    const canvas = container.querySelector('canvas')!;
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    canvas.setPointerCapture = setPointerCapture;
    canvas.hasPointerCapture = () => true;
    canvas.releasePointerCapture = releasePointerCapture;

    act(() => {
      canvas.dispatchEvent(pointerEvent('pointerdown', 13, 10, 10));
      canvas.dispatchEvent(pointerEvent('pointerup', 13, 10, 10));
    });
    expect(setPointerCapture).toHaveBeenCalledWith(13);
    expect(releasePointerCapture).toHaveBeenCalledWith(13);

    act(() => {
      canvas.dispatchEvent(pointerEvent('pointerdown', 14, 10, 10));
      canvas.dispatchEvent(pointerEvent('pointercancel', 14, 10, 10));
      // A fresh gesture must not remain blocked by the cancelled pointer.
      canvas.dispatchEvent(pointerEvent('pointerdown', 15, 10, 10));
    });
    expect(releasePointerCapture).toHaveBeenCalledWith(14);
    expect(setPointerCapture).toHaveBeenCalledWith(15);
  });

  it('restores the next scene and pre-existing globals as mouse-look owners unmount', () => {
    const sceneWindow = window as Window & {
      __scene3dYaw?: number;
      __scene3dPitch?: number;
    };
    sceneWindow.__scene3dYaw = 42;
    sceneWindow.__scene3dPitch = 0.25;
    const first = (
      <Scene3D
        key="first"
        mouseLook
        camera={{ position: { x: 0, y: 0, z: 8 }, lookAt: { x: 0, y: 0, z: 0 } }}
      />
    );

    act(() =>
      root.render(
        <>
          {first}
          <Scene3D
            key="second"
            mouseLook
            camera={{ position: { x: 8, y: 0, z: 0 }, lookAt: { x: 0, y: 0, z: 0 } }}
          />
        </>
      )
    );
    expect(sceneWindow.__scene3dYaw).toBeCloseTo(-Math.PI / 2);

    act(() => root.render(first));
    expect(container.querySelectorAll('canvas')).toHaveLength(1);
    expect(sceneWindow.__scene3dYaw).toBeCloseTo(Math.PI);

    act(() => root.unmount());
    expect(sceneWindow.__scene3dYaw).toBe(42);
    expect(sceneWindow.__scene3dPitch).toBe(0.25);
  });
});
