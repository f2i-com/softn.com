/**
 * What a scene imports, against what it uses.
 *
 * Each three.js addon is mocked with a factory that counts how many times it
 * was evaluated. A module is evaluated once per page, on its first import, so
 * the first scene to use a feature is the one that proves the others were not
 * fetched alongside it — the order of the tests below is the order the claims
 * are made in.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { Scene3D, type Scene3DModelStateInfo } from '../src/threed/Scene3D';
import { emptyGltf, stubFetch, stubFrames, TestWebGLRenderer, waitFor } from './scene3d-doubles';
import { exrBytes, hdrBytes } from './scene3d-panoramas';

const counters = vi.hoisted(() => ({
  gltf: 0,
  obj: 0,
  fbx: 0,
  stl: 0,
  orbit: 0,
  room: 0,
  composer: 0,
  renderPass: 0,
  bloom: 0,
  output: 0,
  shader: 0,
  skeleton: 0,
  meshopt: 0,
  hdr: 0,
  exr: 0,
  focus: 0,
  occlusion: 0,
}));

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

vi.mock('three/addons/loaders/GLTFLoader.js', async () => {
  counters.gltf++;
  const THREE = await import('three');
  return {
    GLTFLoader: class {
      setMeshoptDecoder() {}
      parse(
        _data: ArrayBuffer,
        _path: string,
        onLoad: (gltf: { scene: import('three').Group; animations: [] }) => void
      ) {
        onLoad({ scene: new THREE.Group(), animations: [] });
      }
    },
  };
});
vi.mock('three/addons/loaders/OBJLoader.js', async () => {
  counters.obj++;
  const THREE = await import('three');
  return {
    OBJLoader: class {
      parse() {
        return new THREE.Group();
      }
    },
  };
});
vi.mock('three/addons/loaders/FBXLoader.js', async () => {
  counters.fbx++;
  const THREE = await import('three');
  return {
    FBXLoader: class {
      parse() {
        return new THREE.Group();
      }
    },
  };
});
vi.mock('three/addons/loaders/STLLoader.js', async () => {
  counters.stl++;
  const THREE = await import('three');
  return {
    STLLoader: class {
      parse() {
        return new THREE.BufferGeometry();
      }
    },
  };
});
vi.mock('three/addons/controls/OrbitControls.js', async () => {
  counters.orbit++;
  const THREE = await import('three');
  return {
    OrbitControls: class {
      target = new THREE.Vector3();
      enableDamping = false;
      dampingFactor = 0;
      autoRotate = false;
      autoRotateSpeed = 0;
      update() {}
      dispose() {}
    },
  };
});
vi.mock('three/addons/environments/RoomEnvironment.js', async () => {
  counters.room++;
  const THREE = await import('three');
  return {
    RoomEnvironment: class extends THREE.Scene {
      dispose() {}
    },
  };
});
vi.mock('three/addons/postprocessing/EffectComposer.js', () => {
  counters.composer++;
  return {
    EffectComposer: class {
      addPass() {}
      setSize() {}
      render() {}
      dispose() {}
    },
  };
});
vi.mock('three/addons/postprocessing/RenderPass.js', () => {
  counters.renderPass++;
  return {
    RenderPass: class {
      dispose() {}
    },
  };
});
vi.mock('three/addons/postprocessing/UnrealBloomPass.js', () => {
  counters.bloom++;
  return {
    UnrealBloomPass: class {
      constructor(
        _resolution: unknown,
        public strength: number,
        public radius: number,
        public threshold: number
      ) {}
      dispose() {}
    },
  };
});
vi.mock('three/addons/postprocessing/OutputPass.js', () => {
  counters.output++;
  return {
    OutputPass: class {
      dispose() {}
    },
  };
});
vi.mock('three/addons/postprocessing/ShaderPass.js', () => {
  counters.shader++;
  return {
    ShaderPass: class {
      uniforms = { vignette: { value: 0 }, grain: { value: 0 }, time: { value: 0 } };
      dispose() {}
    },
  };
});
vi.mock('three/addons/utils/SkeletonUtils.js', () => {
  counters.skeleton++;
  return { clone: (source: import('three').Object3D) => source.clone() };
});
vi.mock('three/addons/libs/meshopt_decoder.module.js', () => {
  counters.meshopt++;
  return { MeshoptDecoder: { ready: Promise.resolve(), supported: true } };
});
// The readers of a panorama: one pixel of light (as half floats, three's 1016), whatever the bytes.
vi.mock('three/addons/loaders/RGBELoader.js', () => {
  counters.hdr++;
  return {
    RGBELoader: class {
      parse() {
        return { width: 1, height: 1, data: new Uint16Array(4), type: 1016 };
      }
    },
  };
});
vi.mock('three/addons/loaders/EXRLoader.js', () => {
  counters.exr++;
  return {
    EXRLoader: class {
      parse() {
        return { width: 1, height: 1, data: new Uint16Array(4), type: 1016 };
      }
    },
  };
});
vi.mock('three/addons/postprocessing/BokehPass.js', () => {
  counters.focus++;
  return {
    BokehPass: class {
      enabled = true;
      camera: unknown = null;
      uniforms = { focus: { value: 0 }, aperture: { value: 0 }, maxblur: { value: 0 } };
      materialBokeh = { defines: {} as Record<string, number>, needsUpdate: false };
      render() {}
      dispose() {}
    },
  };
});
vi.mock('three/addons/postprocessing/GTAOPass.js', () => {
  counters.occlusion++;
  return {
    GTAOPass: class {
      blendIntensity = 1;
      camera: unknown = null;
      gtaoMaterial = { defines: {} as Record<string, number>, needsUpdate: false, dispose() {} };
      blendMaterial = { dispose() {} };
      updateGtaoMaterial() {}
      render() {}
      dispose() {}
    },
  };
});

type Counters = typeof counters;
const snapshot = (): Counters => ({ ...counters });
const delta = (before: Counters): Counters => {
  const out = {} as Counters;
  for (const key of Object.keys(counters) as Array<keyof Counters>) out[key] = counters[key] - before[key];
  return out;
};
const nothing: Counters = {
  gltf: 0,
  obj: 0,
  fbx: 0,
  stl: 0,
  orbit: 0,
  room: 0,
  composer: 0,
  renderPass: 0,
  bloom: 0,
  output: 0,
  shader: 0,
  skeleton: 0,
  meshopt: 0,
  hdr: 0,
  exr: 0,
  focus: 0,
  occlusion: 0,
};

let container: HTMLDivElement;
let root: Root;
let states: Scene3DModelStateInfo[];

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  states = [];
  stubFrames();
  stubFetch({
    'https://models.test/plain.gltf': () => emptyGltf(),
    'https://models.test/thing.obj': () => 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n',
    'https://models.test/packed.gltf': () => emptyGltf({ extensionsUsed: ['EXT_meshopt_compression'] }),
    'https://models.test/draco.glb': () =>
      emptyGltf({
        extensionsUsed: ['KHR_draco_mesh_compression'],
        extensionsRequired: ['KHR_draco_mesh_compression'],
      }),
    'https://models.test/basis.gltf': () =>
      emptyGltf({ extensionsUsed: ['KHR_texture_basisu'], extensionsRequired: ['KHR_texture_basisu'] }),
    // One pixel each, as a real file of its kind: the scene reads a panorama's header itself before its reader does.
    'https://models.test/sky.hdr': () => hdrBytes(1, 1, () => [1, 1, 1]),
    'https://models.test/sky.exr': () => exrBytes(1, 1, () => [1, 1, 1]),
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const settled = (id: string) => () => states.some((s) => s.objectId === id && s.state !== 'pending');
const onModelState = (info: Scene3DModelStateInfo) => states.push(info);

describe('Scene3D imports what the scene uses', () => {
  it('a glTF model imports the glTF loader and nothing else', async () => {
    const before = snapshot();
    act(() =>
      root.render(
        <Scene3D
          objects={[{ id: 'm', type: 'model', modelUrl: 'https://models.test/plain.gltf' }]}
          onModelState={onModelState}
        />
      )
    );
    await waitFor(settled('m'), 'the model to settle');
    expect(states.at(-1)?.state).toBe('loaded');
    expect(delta(before)).toEqual({ ...nothing, gltf: 1 });
    expect(TestWebGLRenderer).toBeDefined();
  });

  it('bloom imports the post-processing modules, and only those', async () => {
    const before = snapshot();
    act(() => root.render(<Scene3D effects={{ bloom: true }} />));
    await waitFor(() => counters.bloom > before.bloom, 'the bloom chunk');
    await waitFor(
      () => !!(container.querySelector('canvas') as { __softnEffects?: () => unknown } | null)?.__softnEffects?.(),
      'the chain to be built'
    );
    expect(delta(before)).toEqual({ ...nothing, composer: 1, renderPass: 1, bloom: 1, output: 1, shader: 1 });
  });

  it('studio lighting imports the room environment', async () => {
    const before = snapshot();
    act(() => root.render(<Scene3D environment="studio" />));
    await waitFor(() => counters.room > before.room, 'the room chunk');
    expect(delta(before)).toEqual({ ...nothing, room: 1 });
  });

  it('orbit controls import OrbitControls', async () => {
    const before = snapshot();
    act(() => root.render(<Scene3D orbitControls />));
    await waitFor(() => counters.orbit > before.orbit, 'the controls chunk');
    expect(delta(before)).toEqual({ ...nothing, orbit: 1 });
  });

  it('an OBJ model imports the OBJ loader alone', async () => {
    const before = snapshot();
    act(() =>
      root.render(
        <Scene3D
          objects={[{ id: 'o', type: 'model', modelUrl: 'https://models.test/thing.obj' }]}
          onModelState={onModelState}
        />
      )
    );
    await waitFor(settled('o'), 'the model to settle');
    expect(states.at(-1)?.state).toBe('loaded');
    expect(delta(before)).toEqual({ ...nothing, obj: 1 });
  });

  // Each of the two readers of a panorama is fetched for a file of its kind and no other; an ordinary picture needs neither.
  it('an .hdr environment imports its reader, an .exr its own, and a picture neither', async () => {
    const lit = () => (container.querySelector('canvas') as HTMLCanvasElement & { __softnScene: { environment: unknown } }).__softnScene.environment !== null;
    let before = snapshot();
    act(() => root.render(<Scene3D environment={{ url: 'https://models.test/sky.hdr' }} />));
    await waitFor(lit, 'the panorama');
    expect(delta(before)).toEqual({ ...nothing, hdr: 1 });
    act(() => root.unmount());

    root = createRoot(container);
    before = snapshot();
    act(() => root.render(<Scene3D environment={{ url: 'https://models.test/sky.exr' }} />));
    await waitFor(lit, 'the panorama');
    expect(delta(before)).toEqual({ ...nothing, exr: 1 });
    act(() => root.unmount());

    root = createRoot(container);
    before = snapshot();
    act(() => root.render(<Scene3D environment={{ url: 'https://models.test/sky.jpg' }} />));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(delta(before)).toEqual(nothing);
  });

  // Bloom was the first scene with effects above, and fetched neither of these.
  it('depth of field imports its pass, and ambient occlusion its own', async () => {
    const chain = () => (container.querySelector('canvas') as { __softnEffects?: () => { depthOfField: unknown; ambientOcclusion: unknown } | null } | null)?.__softnEffects?.();
    let before = snapshot();
    act(() => root.render(<Scene3D effects={{ depthOfField: { focus: 3 } }} />));
    await waitFor(() => !!chain()?.depthOfField, 'the chain to be built');
    expect(delta(before)).toEqual({ ...nothing, focus: 1 });
    expect(chain()?.ambientOcclusion).toBeNull();

    before = snapshot();
    act(() => root.render(<Scene3D effects={{ depthOfField: { focus: 3 }, ambientOcclusion: true }} />));
    await waitFor(() => !!chain()?.ambientOcclusion, 'the chain to be built again');
    expect(delta(before)).toEqual({ ...nothing, occlusion: 1 });
  });

  it('a plain scene imports no addon at all', async () => {
    const before = snapshot();
    act(() => root.render(<Scene3D objects={[{ id: 'b', type: 'box' }]} />));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(delta(before)).toEqual(nothing);
  });
});

describe('codecs are taken from the asset, not in advance', () => {
  it('a Meshopt-compressed glTF fetches the Meshopt decoder', async () => {
    const before = snapshot();
    act(() =>
      root.render(
        <Scene3D
          objects={[{ id: 'p', type: 'model', modelUrl: 'https://models.test/packed.gltf' }]}
          onModelState={onModelState}
        />
      )
    );
    await waitFor(settled('p'), 'the model to settle');
    expect(states.at(-1)?.state).toBe('loaded');
    expect(delta(before).meshopt).toBe(1);
  });

  it('a Draco-compressed glTF fails early, naming the decoder', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = snapshot();
    act(() =>
      root.render(
        <Scene3D
          objects={[{ id: 'd', type: 'model', modelUrl: 'https://models.test/draco.glb' }]}
          onModelState={onModelState}
        />
      )
    );
    await waitFor(settled('d'), 'the model to settle');
    const last = states.at(-1);
    expect(last?.state).toBe('error');
    expect(last?.error).toMatch(/Draco decoder/);
    expect(delta(before).meshopt).toBe(0);
    error.mockRestore();
  });

  it('a glTF that requires KTX2 textures fails early, naming the transcoder', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    act(() =>
      root.render(
        <Scene3D
          objects={[{ id: 'k', type: 'model', modelUrl: 'https://models.test/basis.gltf' }]}
          onModelState={onModelState}
        />
      )
    );
    await waitFor(settled('k'), 'the model to settle');
    expect(states.at(-1)?.state).toBe('error');
    expect(states.at(-1)?.error).toMatch(/KTX2/);
    error.mockRestore();
  });
});
