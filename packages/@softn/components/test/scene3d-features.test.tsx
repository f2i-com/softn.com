import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createRoot, type Root } from 'react-dom/client';
import { Scene3D, type Scene3DObject, type Scene3DLight } from '../src/threed/Scene3D';

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();

  class TestWebGLRenderer {
    domElement = document.createElement('canvas');
    shadowMap = { enabled: false, type: 0 };
    toneMapping = 0;
    toneMappingExposure = 1;
    outputColorSpace = '';
    setSize() {}
    setPixelRatio() {}
    // The effects composer asks the renderer how big it is before it decides
    // whether there is anything to build.
    getSize(target: { set(x: number, y: number): unknown }) {
      target.set(300, 150);
      return target;
    }
    render() {}
    dispose() {}
    forceContextLoss() {}
  }

  return { ...actual, WebGLRenderer: TestWebGLRenderer };
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('Scene3D enhanced features', () => {
  it('renders capsule and prism shapes without error', () => {
    const objects: Scene3DObject[] = [
      { id: 'boiler', type: 'capsule', radius: 0.5, height: 2, color: '#333333' },
      { id: 'roof', type: 'prism', width: 2, height: 1, depth: 3, color: '#882222', flatShading: true },
    ];
    act(() => root.render(<Scene3D objects={objects} />));
    const canvas = container.querySelector('canvas') as (HTMLCanvasElement & { __softnScene?: THREE.Scene }) | null;
    expect(canvas).not.toBeNull();
    const scene = canvas?.__softnScene;
    expect(scene).toBeDefined();

    let foundCapsule = false;
    let foundPrism = false;
    scene?.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        if (mesh.geometry instanceof THREE.CapsuleGeometry) foundCapsule = true;
        if (mesh.geometry instanceof THREE.BufferGeometry && (mesh.material as THREE.MeshStandardMaterial)?.flatShading) {
          foundPrism = true;
        }
      }
    });
    expect(foundCapsule).toBe(true);
    expect(foundPrism).toBe(true);
  });

  it('renders hierarchical groups and transforms children relative to group', () => {
    const groupObject: Scene3DObject = {
      id: 'train-loco',
      type: 'group',
      position: { x: 5, y: 1, z: 2 },
      children: [
        { id: 'loco-cab', type: 'box', width: 1, height: 1, depth: 1, position: { x: 0, y: 0.5, z: 0 }, color: '#224488' },
        { id: 'loco-stack', type: 'cylinder', radius: 0.2, height: 0.6, position: { x: 0, y: 1.2, z: 0.5 }, color: '#111111' },
      ],
    };
    act(() => root.render(<Scene3D objects={[groupObject]} />));
    const canvas = container.querySelector('canvas') as (HTMLCanvasElement & { __softnScene?: THREE.Scene }) | null;
    const scene = canvas?.__softnScene;
    expect(scene).toBeDefined();

    let foundGroup = false;
    let childCount = 0;
    scene?.traverse((child) => {
      if (child.userData?.__softnId === 'train-loco') {
        foundGroup = true;
        expect(child.position.x).toBe(5);
        expect(child.position.y).toBe(1);
        expect(child.position.z).toBe(2);
      }
      if (child.userData?.__softnId === 'loco-cab' || child.userData?.__softnId === 'loco-stack') {
        childCount++;
      }
    });
    expect(foundGroup).toBe(true);
    expect(childCount).toBe(2);
  });

  it('renders particle systems using THREE.Points', () => {
    const particleObj: Scene3DObject = {
      id: 'smoke',
      type: 'particles',
      particlePositions: [0, 1, 0, 0, 1.5, 0.2, 0, 2, 0.4],
      particleSize: 0.4,
      color: '#cccccc',
      opacity: 0.6,
    };
    act(() => root.render(<Scene3D objects={[particleObj]} />));
    const canvas = container.querySelector('canvas') as (HTMLCanvasElement & { __softnScene?: THREE.Scene }) | null;
    const scene = canvas?.__softnScene;

    let foundPoints = false;
    scene?.traverse((child) => {
      if ((child as THREE.Points).isPoints) {
        foundPoints = true;
        const pts = child as THREE.Points;
        expect(pts.geometry.getAttribute('position').count).toBe(3);
      }
    });
    expect(foundPoints).toBe(true);
  });

  it('configures directional light shadows with shadowCameraSize and shadowBias', () => {
    const lights: Scene3DLight[] = [
      {
        id: 'sun',
        type: 'directional',
        color: '#fffaed',
        intensity: 1.5,
        castShadow: true,
        shadowCameraSize: 25,
        shadowBias: -0.0003,
      },
    ];
    act(() => root.render(<Scene3D lights={lights} shadows />));
    const canvas = container.querySelector('canvas') as (HTMLCanvasElement & { __softnScene?: THREE.Scene }) | null;
    const scene = canvas?.__softnScene;

    let foundDirLight = false;
    scene?.traverse((child) => {
      if (child instanceof THREE.DirectionalLight && child.castShadow) {
        foundDirLight = true;
        expect(child.shadow.camera.left).toBe(-25);
        expect(child.shadow.camera.right).toBe(25);
        expect(child.shadow.bias).toBe(-0.0003);
      }
    });
    expect(foundDirLight).toBe(true);
  });

  it('applies procedural textures to materials', () => {
    const objects: Scene3DObject[] = [
      { id: 'stonewall', type: 'box', width: 2, height: 2, depth: 0.5, color: '#555555', texture: 'stone', textureRepeat: { x: 2, y: 2 } },
      { id: 'woodfloor', type: 'plane', width: 10, height: 10, color: '#885522', texture: 'wood' },
    ];
    act(() => root.render(<Scene3D objects={objects} />));
    const canvas = container.querySelector('canvas') as (HTMLCanvasElement & { __softnScene?: THREE.Scene }) | null;
    const scene = canvas?.__softnScene;

    let stoneMesh: THREE.Mesh | undefined;
    scene?.traverse((child) => {
      if ((child as THREE.Mesh).isMesh && child.userData.__softnId === 'stonewall') {
        stoneMesh = child as THREE.Mesh;
      }
    });
    expect(stoneMesh).toBeDefined();
    const mat = stoneMesh?.material as THREE.MeshStandardMaterial;
    expect(mat).toBeDefined();
    expect(mat.roughness).toBeGreaterThan(0.3);
  });

  it('supports atmospheric sky and helper grid', () => {
    act(() => root.render(<Scene3D sky="sunset" grid={{ size: 40, divisions: 20 }} />));
    const canvas = container.querySelector('canvas') as (HTMLCanvasElement & { __softnScene?: THREE.Scene }) | null;
    const scene = canvas?.__softnScene;
    expect(scene).toBeDefined();

    let foundGrid = false;
    scene?.traverse((child) => {
      if (child instanceof THREE.GridHelper) foundGrid = true;
    });
    expect(foundGrid).toBe(true);
  });

  it('initializes gameControls window.__softnKeys', () => {
    act(() => root.render(<Scene3D gameControls={true} />));
    const win = window as unknown as { __softnKeys?: Record<string, boolean> };
    expect(win.__softnKeys).toBeDefined();
    expect(typeof win.__softnKeys?.w).toBe('boolean');
  });
});
