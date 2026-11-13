/**
 * What a scene says about a model, how it sizes one, how it holds a clip at
 * a point, and models as children of groups.
 *
 * The loader is mocked at `parse`: each fixture's JSON carries a name, and
 * the mock answers with the three.js object a test registered under it, at
 * once or when the test lets it go. The bytes come from a stubbed fetch, so
 * a retry is visible as a second request.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import {
  Scene3D,
  type Scene3DAnimationInfo,
  type Scene3DModelStateInfo,
  type Scene3DObject,
  type Scene3DProps,
} from '../src/threed/Scene3D';
import { modelTemplateCache } from '../src/threed/model-cache';
import { describeModel, fitModel } from '../src/threed/model-info';
import { stubFetch, stubFrames, tick, waitFor, type FetchStub, type FrameStub } from './scene3d-doubles';

type Loaded = {
  scene: import('three').Object3D;
  animations: import('three').AnimationClip[];
  /** As three's glTF loader keeps it: which node of the file, or which piece of which mesh, each object was made from. */
  parser?: { associations: Map<import('three').Object3D, { nodes?: number; meshes?: number; primitives?: number }> };
};
const loader = vi.hoisted(() => ({
  make: new Map<string, () => unknown>(),
  held: new Map<string, Array<() => void>>(),
  hold: new Set<string>(),
}));

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  const { TestWebGLRenderer } = await import('./scene3d-doubles');
  return { ...actual, WebGLRenderer: TestWebGLRenderer };
});

vi.mock('three/addons/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    setMeshoptDecoder() {}
    parse(data: ArrayBuffer, _path: string, resolve: (value: unknown) => void, reject: (error: unknown) => void) {
      const { name } = JSON.parse(new TextDecoder().decode(data)) as { name: string };
      const make = loader.make.get(name);
      if (!make) {
        reject(new Error(`no fixture called ${name}`));
        return;
      }
      if (!loader.hold.has(name)) {
        resolve(make());
        return;
      }
      const waiting = loader.held.get(name) ?? [];
      waiting.push(() => resolve(make()));
      loader.held.set(name, waiting);
    }
  },
}));

import * as THREE from 'three';

// URLs carry the test's number: the template cache is page-wide.
let run = 0;
const url = (name: string) => `https://models.test/m${run}/${name}.gltf`;

let container: HTMLDivElement;
let root: Root;
let frames: FrameStub;
let fetched: FetchStub;
let states: Scene3DModelStateInfo[];
let now = 0;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  run += 1;
  loader.make.clear();
  loader.held.clear();
  loader.hold.clear();
  states = [];
  frames = stubFrames();
  const routes: Record<string, () => string> = {};
  for (const name of ['crate', 'spinner', 'plain']) {
    routes[url(name)] = () => JSON.stringify({ asset: { version: '2.0' }, name: `m${run}/${name}` });
  }
  fetched = stubFetch(routes);
  now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  modelTemplateCache.clearIdle();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Register what the loader makes of a fixture; `hold` keeps each parse open until `letGo`. */
function serve(name: string, make: () => Loaded, hold = false): void {
  loader.make.set(`m${run}/${name}`, make);
  if (hold) loader.hold.add(`m${run}/${name}`);
}
const parsing = (name: string) => () => (loader.held.get(`m${run}/${name}`)?.length ?? 0) > 0;
async function letGo(name: string): Promise<void> {
  await waitFor(parsing(name), `${name} to reach the loader`);
  await act(async () => {
    loader.held.get(`m${run}/${name}`)?.shift()?.();
    await tick();
  });
}

/**
 * A crate two wide, four tall and one deep, standing ten units off to one
 * side of its file's origin, with a lid of two materials, a morph and a clip.
 */
function crate(): Loaded {
  const scene = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial();
  paint.name = 'Paint';
  const trim = new THREE.MeshStandardMaterial();
  trim.name = 'Trim';
  const body = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 1), paint);
  body.name = 'Body';
  body.position.set(10, 2, 0);
  body.morphTargetDictionary = { Dent: 0 };
  body.morphTargetInfluences = [0];
  // A mesh of two materials, as the glTF loader makes one: a group named
  // after it, holding a mesh for each.
  const lid = new THREE.Group();
  lid.name = 'Lid';
  lid.position.set(10, 3.9, 0);
  const lidTop = new THREE.Mesh(new THREE.BoxGeometry(2, 0.2, 1), paint);
  lidTop.name = 'Lid_1';
  const lidEdge = new THREE.Mesh(new THREE.BoxGeometry(2, 0.2, 1), trim);
  lidEdge.name = 'Lid_2';
  lid.add(lidTop, lidEdge);
  // A node the file left unnamed is named by its uuid when loaded.
  const unnamed = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshStandardMaterial());
  unnamed.position.set(10, 2, 0);
  scene.add(body, lid, unnamed);
  const open = new THREE.AnimationClip('Open', 2, [
    new THREE.NumberKeyframeTrack('Lid.rotation[z]', [0, 2], [0, Math.PI / 2]),
  ]);
  // The body, the lid and the unnamed one are nodes of the file; the lid's two meshes are pieces of its one mesh.
  const associations: NonNullable<Loaded['parser']>['associations'] = new Map<
    THREE.Object3D,
    { nodes?: number; meshes?: number; primitives?: number }
  >([
    [body, { nodes: 0, meshes: 0, primitives: 0 }],
    [lid, { nodes: 1, meshes: 1 }],
    [lidTop, { meshes: 1, primitives: 0 }],
    [lidEdge, { meshes: 1, primitives: 1 }],
    [unnamed, { nodes: 2, meshes: 2, primitives: 0 }],
  ]);
  return { scene, animations: [open], parser: { associations } };
}

const onModelState = (info: Scene3DModelStateInfo) => states.push(info);
const of = (id: string) => states.filter((s) => s.objectId === id);
const settled = (id: string) => () => of(id).some((s) => s.state !== 'pending');
const show = (objects: Scene3DObject[], props: Partial<Scene3DProps> = {}) =>
  act(() => root.render(<Scene3D objects={objects} lights={[]} onModelState={onModelState} {...props} />));
const sceneOf = () => (container.querySelector('canvas') as HTMLCanvasElement & { __softnScene: THREE.Scene }).__softnScene;

function nodeById(id: string): THREE.Object3D {
  let found: THREE.Object3D | undefined;
  sceneOf().traverse((node) => {
    if (!found && node.userData.__softnId === id) found = node;
  });
  return found as THREE.Object3D;
}
function named(under: THREE.Object3D, name: string): THREE.Object3D {
  let found: THREE.Object3D | undefined;
  under.traverse((node) => {
    if (!found && node.name === name) found = node;
  });
  return found as THREE.Object3D;
}
/** Where an object is drawn, as a box in the world. */
function boundsOf(id: string): { min: number[]; max: number[] } {
  sceneOf().updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(nodeById(id), true);
  const round = (v: THREE.Vector3) => v.toArray().map((n) => Math.round(n * 1000) / 1000);
  return { min: round(box.min), max: round(box.max) };
}
/** A frame, sixteen milliseconds on. */
function frame(): void {
  now += 16;
  act(() => frames.runFrame(now));
}

describe('what "loaded" says is in a model', () => {
  it('the names of its clips, materials, meshes and morphs, and its size and middle as the file has them', async () => {
    serve('crate', crate);
    show([{ id: 'c', type: 'model', modelUrl: url('crate'), scale: 3, position: { x: 5, y: 5, z: 5 } }]);
    await waitFor(settled('c'), 'the crate');
    expect(of('c').at(-1)).toEqual({
      objectId: 'c',
      state: 'loaded',
      attempt: 1,
      clips: ['Open'],
      materials: ['Paint', 'Trim'],
      // The lid by the name of its group, which hides both its meshes, and by each; nothing for the unnamed one.
      meshes: ['Body', 'Lid', 'Lid_1', 'Lid_2'],
      morphs: ['Dent'],
      // What its author named, for `parts`: not the two meshes the lid was cut into, nor the unnamed one.
      nodes: ['Body', 'Lid'],
      // How long its one clip is, in seconds; it has no camera and no light of its own.
      clipLengths: [2],
      cameras: [],
      lights: [],
      // Before the object's own scale and position.
      size: { x: 2, y: 4, z: 1 },
      center: { x: 10, y: 2, z: 0 },
    });
  });

  it('is read once for a file, however many objects show it', async () => {
    const boxes = vi.spyOn(THREE.Box3.prototype, 'setFromObject');
    serve('crate', crate);
    show([
      { id: 'a', type: 'model', modelUrl: url('crate') },
      { id: 'b', type: 'model', modelUrl: url('crate') },
      { id: 'c', type: 'model', modelUrl: url('crate') },
    ]);
    await waitFor(() => settled('a')() && settled('b')() && settled('c')(), 'the crates');
    expect(boxes).toHaveBeenCalledOnce();
    expect(of('c').at(-1)?.size).toEqual({ x: 2, y: 4, z: 1 });
  });

  it('describeModel reads a model that has nothing in it as nothing', () => {
    expect(describeModel(new THREE.Group(), [])).toEqual({
      clips: [],
      materials: [],
      meshes: [],
      morphs: [],
      nodes: [],
      clipLengths: [],
      cameras: [],
      lights: [],
      size: { x: 0, y: 0, z: 0 },
      center: { x: 0, y: 0, z: 0 },
    });
  });
});

describe('`fit`', () => {
  it('scales a model so its longest side is that long, centred and standing on the ground', async () => {
    serve('crate', crate);
    show([{ id: 'c', type: 'model', modelUrl: url('crate'), fit: 2 }]);
    await waitFor(settled('c'), 'the crate');
    // Four tall became two; it stood ten units off to one side and is over the origin.
    expect(boundsOf('c')).toEqual({ min: [-0.5, 0, -0.25], max: [0.5, 2, 0.25] });
  });

  it('is applied before the object’s own scale and position, not in place of them', async () => {
    serve('crate', crate);
    show([{ id: 'c', type: 'model', modelUrl: url('crate'), fit: 2, scale: 2, position: { x: 3, y: 1, z: 0 } }]);
    await waitFor(settled('c'), 'the crate');
    expect(boundsOf('c')).toEqual({ min: [2, 1, -0.5], max: [4, 5, 0.5] });
  });

  it('follows a change of size, and being given and taken away, without the model being fetched again', async () => {
    serve('crate', crate);
    const model = (extra: Partial<Scene3DObject>): Scene3DObject => ({ id: 'c', type: 'model', modelUrl: url('crate'), ...extra });
    show([model({ position: { x: 1, y: 0, z: 0 } })]);
    await waitFor(settled('c'), 'the crate');
    // As the file has it, moved one along.
    expect(boundsOf('c')).toEqual({ min: [10, 0, -0.5], max: [12, 4, 0.5] });
    const body = named(nodeById('c'), 'Body');

    show([model({ position: { x: 1, y: 0, z: 0 }, fit: 4 })]);
    expect(boundsOf('c')).toEqual({ min: [0, 0, -0.5], max: [2, 4, 0.5] });
    show([model({ position: { x: 1, y: 0, z: 0 }, fit: 1 })]);
    expect(boundsOf('c')).toEqual({ min: [0.75, 0, -0.125], max: [1.25, 1, 0.125] });
    show([model({ position: { x: 1, y: 0, z: 0 } })]);
    expect(boundsOf('c')).toEqual({ min: [10, 0, -0.5], max: [12, 4, 0.5] });

    // The same model throughout: one fetch, one "loaded".
    expect(named(nodeById('c'), 'Body')).toBe(body);
    expect(fetched.calls.filter((u) => u === url('crate'))).toHaveLength(1);
    expect(of('c').map((s) => s.state)).toEqual(['pending', 'loaded']);
  });

  it('fitModel leaves a model as its file had it when there is nothing to fit to', () => {
    const model = new THREE.Group();
    model.position.set(1, 2, 3);
    model.scale.setScalar(0.5);
    const contents = { ...describeModel(new THREE.Group(), []), size: { x: 2, y: 4, z: 1 }, center: { x: 0, y: 2, z: 0 } };
    fitModel(model, contents, 8);
    expect(model.scale.toArray()).toEqual([1, 1, 1]);
    // Its own place, scaled with it, less where its middle and its feet were.
    expect(model.position.toArray()).toEqual([2, 4, 6]);
    for (const nothing of [undefined, 0, -1, Number.NaN, '2']) {
      fitModel(model, contents, nothing);
      expect(model.position.toArray()).toEqual([1, 2, 3]);
      expect(model.scale.toArray()).toEqual([0.5, 0.5, 0.5]);
    }
  });
});

describe('`animation.progress`', () => {
  it('holds a clip at that point however many frames go by, and lets it play on when taken away', async () => {
    serve('crate', crate);
    const model = (animation: Scene3DObject['animation']): Scene3DObject => ({ id: 'c', type: 'model', modelUrl: url('crate'), animation });
    show([model({ clip: 'Open', progress: 0.5 })]);
    await waitFor(settled('c'), 'the crate');
    const lid = named(nodeById('c'), 'Lid');
    frame();
    // Half of a quarter turn.
    expect(lid.rotation.z).toBeCloseTo(Math.PI / 4, 6);
    for (let i = 0; i < 30; i++) frame();
    expect(lid.rotation.z).toBeCloseTo(Math.PI / 4, 6);

    show([model({ clip: 'Open', progress: 0.25 })]);
    frame();
    expect(lid.rotation.z).toBeCloseTo(Math.PI / 8, 6);
    // Past either end is the end.
    show([model({ clip: 'Open', progress: 7 })]);
    frame();
    expect(lid.rotation.z).toBeCloseTo(Math.PI / 2, 6);
    show([model({ clip: 'Open', progress: 0.25 })]);
    frame();

    show([model({ clip: 'Open' })]);
    frame();
    frame();
    expect(lid.rotation.z).toBeGreaterThan(Math.PI / 8);
    expect(lid.rotation.z).toBeLessThan(Math.PI / 4);
  });

  it('never reports the clip as finished while it is held', async () => {
    serve('crate', crate);
    const events: Scene3DAnimationInfo[] = [];
    show(
      [{ id: 'c', type: 'model', modelUrl: url('crate'), animation: { clip: 'Open', loop: 'once', progress: 1 } }],
      { onAnimation: (info) => events.push(info) }
    );
    await waitFor(settled('c'), 'the crate');
    for (let i = 0; i < 10; i++) frame();
    expect(named(nodeById('c'), 'Lid').rotation.z).toBeCloseTo(Math.PI / 2, 6);
    expect(events).toEqual([]);
  });
});

describe('a model that is a group’s child', () => {
  const car = (child: Partial<Scene3DObject> = {}, group: Partial<Scene3DObject> = {}): Scene3DObject => ({
    id: 'car',
    type: 'group',
    position: { x: 100, y: 0, z: 0 },
    children: [
      { id: 'body', type: 'model', modelUrl: url('crate'), position: { x: 0, y: 1, z: 0 }, ...child },
      { id: 'roof', type: 'box', position: { x: 0, y: 6, z: 0 } },
    ],
    ...group,
  });

  it('is loaded as a top-level one is, where the child stands in its group, and says which group it is in', async () => {
    serve('crate', crate);
    show([car()]);
    expect(of('body')).toEqual([{ objectId: 'body', parentId: 'car', state: 'pending', attempt: 1 }]);
    await waitFor(settled('body'), 'the body');
    expect(of('body').at(-1)).toMatchObject({
      objectId: 'body',
      parentId: 'car',
      state: 'loaded',
      attempt: 1,
      clips: ['Open'],
      size: { x: 2, y: 4, z: 1 },
    });
    const body = nodeById('body');
    expect(body.parent).toBe(nodeById('car'));
    expect(body.userData.__softnParentId).toBe('car');
    // Not the box a model in a group used to be drawn as.
    expect((body as THREE.Mesh).isMesh).toBeUndefined();
    // The group at 100, the child one up, the crate as its file has it.
    expect(boundsOf('body')).toEqual({ min: [109, 1, -0.5], max: [111, 5, 0.5] });
  });

  it('keeps its node and its model as the group is reconciled around it, and follows its own changes', async () => {
    serve('crate', crate);
    show([car()]);
    await waitFor(settled('body'), 'the body');
    const node = nodeById('body');
    const model = named(node, 'Body');
    const paint = (model as THREE.Mesh).material as THREE.MeshStandardMaterial;

    show([car({ position: { x: 0, y: 2, z: 0 }, color: '#ff0000', fit: 2 }, { position: { x: 0, y: 0, z: 0 } })]);
    expect(nodeById('body')).toBe(node);
    expect(named(node, 'Body')).toBe(model);
    expect(paint.color.getHexString()).toBe('ff0000');
    expect(boundsOf('body')).toEqual({ min: [-0.5, 2, -0.25], max: [0.5, 4, 0.25] });
    expect(fetched.calls.filter((u) => u === url('crate'))).toHaveLength(1);
    expect(of('body').map((s) => s.state)).toEqual(['pending', 'loaded']);
  });

  // A group passes its shadows, and a camera-attached group its depth
  // settings, down to everything in it: a model that arrives later is in it.
  it('is given what its group passes down when it arrives, with no update of the group to bring it', async () => {
    serve('crate', crate, true);
    show([car({}, { castShadow: true, receiveShadow: true, attach: 'camera' })]);
    expect((nodeById('roof') as THREE.Mesh).castShadow).toBe(true);
    await letGo('crate');
    const model = named(nodeById('body'), 'Body') as THREE.Mesh;
    expect(model.castShadow).toBe(true);
    expect(model.receiveShadow).toBe(true);
    // Held in front of the camera, it is drawn over what is behind it.
    expect((model.material as THREE.Material).depthTest).toBe(false);
  });

  it('plays its clips, and reports them with its group', async () => {
    serve('crate', crate);
    const events: Scene3DAnimationInfo[] = [];
    show([car({ animation: { clip: 'Open', loop: 'once' } })], { onAnimation: (info) => events.push(info) });
    await waitFor(settled('body'), 'the body');
    const lid = named(nodeById('body'), 'Lid');
    frame();
    frame();
    expect(lid.rotation.z).toBeGreaterThan(0);
    // Two seconds on, the clip has run out.
    now += 2500;
    act(() => frames.runFrame(now));
    expect(events).toEqual([{ objectId: 'body', parentId: 'car', clip: 'Open', type: 'finished' }]);

    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    show([car({ animation: { clip: 'Shut' } })], { onAnimation: (info) => events.push(info) });
    expect(events.at(-1)).toEqual({ objectId: 'body', parentId: 'car', clip: 'Shut', type: 'missing' });
    expect(warned).toHaveBeenCalledOnce();
  });

  it('shares its file with every other object that shows it, and gives its copy back when its group goes', async () => {
    serve('crate', crate);
    show([car(), { id: 'spare', type: 'model', modelUrl: url('crate') }]);
    await waitFor(() => settled('body')() && settled('spare')(), 'both crates');
    expect(fetched.calls.filter((u) => u === url('crate'))).toHaveLength(1);
    const inCar = named(nodeById('body'), 'Body') as THREE.Mesh;
    const spare = named(nodeById('spare'), 'Body') as THREE.Mesh;
    expect(inCar.geometry).toBe(spare.geometry);
    expect(inCar.material).not.toBe(spare.material);
    const geometry = vi.spyOn(inCar.geometry, 'dispose');
    const material = vi.spyOn(inCar.material as THREE.Material, 'dispose');
    const roof = vi.spyOn((nodeById('roof') as THREE.Mesh).geometry, 'dispose');

    show([{ id: 'spare', type: 'model', modelUrl: url('crate') }]);
    // The group's own box is disposed; the model's copy of the materials is
    // let go; the geometry the spare still draws with is not touched.
    expect(roof).toHaveBeenCalledOnce();
    expect(material).toHaveBeenCalledOnce();
    expect(geometry).not.toHaveBeenCalled();
    expect(named(nodeById('spare'), 'Body')).toBe(spare);
  });

  it('fetches the same file again when its `reload` changes, and is a new node for another file', async () => {
    serve('crate', crate);
    serve('plain', () => ({ scene: new THREE.Group(), animations: [] }));
    show([car()]);
    await waitFor(settled('body'), 'the body');
    const node = nodeById('body');

    show([car({ reload: 1 })]);
    expect(of('body').at(-1)).toEqual({ objectId: 'body', parentId: 'car', state: 'pending', attempt: 2 });
    await waitFor(() => of('body').at(-1)?.state === 'loaded', 'the retry');
    expect(of('body').at(-1)?.attempt).toBe(2);
    expect(fetched.calls.filter((u) => u === url('crate'))).toHaveLength(2);
    expect(nodeById('body')).toBe(node);

    show([car({ reload: 1, modelUrl: url('plain') })]);
    expect(nodeById('body')).not.toBe(node);
    expect(of('body').at(-1)).toEqual({ objectId: 'body', parentId: 'car', state: 'pending', attempt: 1 });
    await waitFor(() => of('body').at(-1)?.state === 'loaded', 'the other file');
  });

  it('holds the scene’s readiness as a top-level model does, and not once its group has gone', async () => {
    serve('crate', crate, true);
    const events: string[] = [];
    const milestones = { onAssetsReady: () => events.push('assets') };
    show([car()], milestones);
    expect(events).toEqual([]);
    await letGo('crate');
    expect(of('body').at(-1)?.state).toBe('loaded');
    expect(events).toEqual(['assets']);
  });

  it('that never arrives stops holding readiness when its group is removed, and arrives to no one', async () => {
    serve('crate', crate, true);
    const events: string[] = [];
    const milestones = { onAssetsReady: () => events.push('assets') };
    show([car()], milestones);
    await waitFor(parsing('crate'), 'the crate to reach the loader');
    show([], milestones);
    expect(events).toEqual(['assets']);
    await letGo('crate');
    expect(of('body').map((s) => s.state)).toEqual(['pending']);
    // Nothing holds the template: its one instance was handed straight back.
    expect(modelTemplateCache.stats().referenced).toBe(0);
  });

  it('still on its way when the scene itself goes does not make the scene ready on its way out', async () => {
    serve('crate', crate, true);
    const events: string[] = [];
    show([car()], { onAssetsReady: () => events.push('assets') });
    await waitFor(parsing('crate'), 'the crate to reach the loader');
    act(() => root.render(<div />));
    expect(events).toEqual([]);
    await letGo('crate');
    expect(events).toEqual([]);
    expect(modelTemplateCache.stats().referenced).toBe(0);
  });

  // It used to be a one-unit box: a model nobody had asked for.
  it('with no URL to load is nothing to draw, as a top-level model with none is, and is loaded once it has one', async () => {
    show([car({ modelUrl: undefined })]);
    const empty = nodeById('body');
    expect((empty as THREE.Mesh).isMesh).toBeUndefined();
    expect(empty.children).toHaveLength(0);
    expect(states).toEqual([]);
    // The same again is the same node, not one made anew.
    show([car({ modelUrl: undefined })]);
    expect(nodeById('body')).toBe(empty);

    serve('crate', crate);
    show([car()]);
    await waitFor(settled('body'), 'the crate');
    expect(nodeById('body')).not.toBe(empty);
    expect(of('body').at(-1)).toMatchObject({ state: 'loaded', parentId: 'car' });
  });
});
