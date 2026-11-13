/**
 * The named parts of a model, moved from logic: `parts` on a model object.
 *
 * The loader is mocked at `parse`, as in scene3d-models: each fixture's JSON
 * carries a name and the mock answers with the three.js object registered
 * under it, at once or when the test lets it go. Everything else is three's
 * own: the nodes, their quaternions, the mixer that plays a clip over them.
 * What a part is expected to hold is worked out here with three's own maths
 * from the pose the fixture gave it.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { Scene3D, type Scene3DModelStateInfo, type Scene3DObject, type Scene3DProps } from '../src/threed/Scene3D';
import { modelTemplateCache } from '../src/threed/model-cache';
import { ModelParts } from '../src/threed/model-parts';
import { stubFetch, stubFrames, tick, waitFor, type FrameStub } from './scene3d-doubles';

type Loaded = { scene: import('three').Object3D; animations: import('three').AnimationClip[] };
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
const url = (name: string) => `https://models.test/p${run}/${name}.gltf`;

let container: HTMLDivElement;
let root: Root;
let frames: FrameStub;
let states: Scene3DModelStateInfo[];
let warned: ReturnType<typeof vi.spyOn>;
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
  stubFetch({ [url('rover')]: () => JSON.stringify({ asset: { version: '2.0' }, name: `p${run}/rover` }) });
  now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
  modelTemplateCache.clearIdle();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function serve(make: () => Loaded, hold = false): void {
  loader.make.set(`p${run}/rover`, make);
  if (hold) loader.hold.add(`p${run}/rover`);
}
const parsing = () => (loader.held.get(`p${run}/rover`)?.length ?? 0) > 0;
async function letGo(): Promise<void> {
  await waitFor(parsing, 'the rover to reach the loader');
  await act(async () => {
    loader.held.get(`p${run}/rover`)?.shift()?.();
    await tick();
  });
}

// The poses the file gives its parts: a wheel laid on its side (its axle,
// the cylinder's own y, along the rover's x), twice as wide as it is round.
const WHEEL_REST = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI / 2));
const WHEEL_SCALE = [1, 2, 1];
const ARM_AT = [0, 0.6, -1];

/** A rover: a chassis with two wheels, a hatch with a lamp on it, and an arm a clip waves. */
function rover(): Loaded {
  const scene = new THREE.Group();
  scene.name = 'Scene';
  const chassis = new THREE.Group();
  chassis.name = 'Rover';
  chassis.position.set(0, 1, 0);
  const wheel = (name: string, x: number) => {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.2), new THREE.MeshStandardMaterial());
    mesh.name = name;
    mesh.position.set(x, -0.5, 1);
    mesh.quaternion.copy(WHEEL_REST);
    mesh.scale.fromArray(WHEEL_SCALE);
    return mesh;
  };
  const hatch = new THREE.Mesh(new THREE.BoxGeometry(1, 0.1, 1), new THREE.MeshStandardMaterial());
  hatch.name = 'Hatch';
  hatch.position.set(0, 0.5, 0);
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.1), new THREE.MeshStandardMaterial());
  lamp.name = 'Lamp';
  hatch.add(lamp);
  const arm = new THREE.Group();
  arm.name = 'Arm';
  arm.position.fromArray(ARM_AT);
  chassis.add(wheel('Wheel_FL', -1), wheel('Wheel_FR', 1), hatch, arm);
  scene.add(chassis);
  const quarter = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI / 2));
  const wave = new THREE.AnimationClip('Wave', 2, [
    new THREE.VectorKeyframeTrack('Arm.position', [0, 2], [...ARM_AT, 0, 2.6, -1]),
    new THREE.QuaternionKeyframeTrack('Arm.quaternion', [0, 2], [0, 0, 0, 1, ...quarter.toArray()]),
  ]);
  return { scene, animations: [wave] };
}

const onModelState = (info: Scene3DModelStateInfo) => states.push(info);
const settled = (id: string) => () => states.some((s) => s.objectId === id && s.state !== 'pending');
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
function part(id: string, name: string): THREE.Object3D {
  let found: THREE.Object3D | undefined;
  nodeById(id).traverse((node) => {
    if (!found && node.name === name) found = node;
  });
  return found as THREE.Object3D;
}
function frame(ms = 16): void {
  now += ms;
  act(() => frames.runFrame(now));
}
const model = (id: string, extra: Partial<Scene3DObject> = {}): Scene3DObject => ({ id, type: 'model', modelUrl: url('rover'), ...extra });
/** A turn about x, y and z as three makes one of it. */
const turn = (x: number, y: number, z: number) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z));
const close = (actual: THREE.Quaternion | THREE.Vector3, expected: number[], digits = 9) =>
  actual.toArray().forEach((v, i) => expect(v, `component ${i}`).toBeCloseTo(expected[i], digits));
async function showRover(extra: Partial<Scene3DObject> = {}, props: Partial<Scene3DProps> = {}): Promise<void> {
  serve(rover);
  show([model('r', extra)], props);
  await waitFor(settled('r'), 'the rover');
}

describe('`parts`', () => {
  it('turns a part on top of the pose its file gives it, about the part’s own axes', async () => {
    await showRover({ parts: { Wheel_FL: { rotation: { x: 0, y: 1.2, z: 0 } } } });
    const wheel = part('r', 'Wheel_FL');
    // The file's pose, then the turn: as three composes the two.
    close(wheel.quaternion, WHEEL_REST.clone().multiply(turn(0, 1.2, 0)).toArray());
    // Rolled about its own axle: the axle points where it did, and a point on the rim has gone round.
    const axle = new THREE.Vector3(0, 1, 0).applyQuaternion(wheel.quaternion);
    close(axle, new THREE.Vector3(0, 1, 0).applyQuaternion(WHEEL_REST).toArray());
    const rim = new THREE.Vector3(1, 0, 0).applyQuaternion(wheel.quaternion);
    expect(rim.angleTo(new THREE.Vector3(1, 0, 0).applyQuaternion(WHEEL_REST))).toBeCloseTo(1.2, 9);
    // Nothing else of it is touched, nor is the wheel beside it.
    expect(wheel.position.toArray()).toEqual([-1, -0.5, 1]);
    expect(wheel.scale.toArray()).toEqual(WHEEL_SCALE);
    close(part('r', 'Wheel_FR').quaternion, WHEEL_REST.toArray());

    // All three angles, in the order x, y, z.
    show([model('r', { parts: { Wheel_FL: { rotation: { x: 0.3, y: -0.4, z: 0.5 } } } })]);
    close(wheel.quaternion, WHEEL_REST.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, -0.4, 0.5, 'XYZ'))).toArray());
  });

  it('moves a part from where the file puts it, multiplies its size, and shows or hides it and what hangs from it', async () => {
    await showRover({
      parts: {
        Arm: { position: { x: 0, y: 0.2, z: 0 }, scale: 1.1 },
        Wheel_FR: { scale: { x: 2, y: 3, z: 4 } },
        Hatch: { visible: false },
      },
    });
    const arm = part('r', 'Arm');
    close(arm.position, [ARM_AT[0], ARM_AT[1] + 0.2, ARM_AT[2]]);
    close(arm.scale, [1.1, 1.1, 1.1]);
    close(part('r', 'Wheel_FR').scale, [2, 6, 4]);
    const hatch = part('r', 'Hatch');
    expect(hatch.visible).toBe(false);
    // The lamp hangs from the hatch: hidden with it, without being hidden itself.
    expect(part('r', 'Lamp').visible).toBe(true);
    expect(part('r', 'Lamp').parent).toBe(hatch);

    show([model('r', { parts: { Hatch: { visible: true } } })]);
    expect(hatch.visible).toBe(true);
  });

  it('puts a part back as its file has it when it is left out, or its field is', async () => {
    const all = {
      Wheel_FL: { rotation: { x: 1, y: 2, z: 3 }, position: { x: 5, y: 5, z: 5 }, scale: 3 },
      Hatch: { visible: false },
    };
    await showRover({ parts: all });
    const wheel = part('r', 'Wheel_FL');
    expect(wheel.position.toArray()).toEqual([4, 4.5, 6]);

    // One field of it taken away.
    show([model('r', { parts: { ...all, Wheel_FL: { rotation: { x: 1, y: 2, z: 3 } } } })]);
    expect(wheel.position.toArray()).toEqual([-1, -0.5, 1]);
    expect(wheel.scale.toArray()).toEqual(WHEEL_SCALE);
    close(wheel.quaternion, WHEEL_REST.clone().multiply(turn(1, 2, 3)).toArray());

    // The part itself, and then `parts` altogether.
    show([model('r', { parts: { Hatch: { visible: false } } })]);
    expect(wheel.quaternion.toArray()).toEqual(WHEEL_REST.toArray());
    expect(part('r', 'Hatch').visible).toBe(false);
    show([model('r')]);
    expect(part('r', 'Hatch').visible).toBe(true);
    for (let i = 0; i < 3; i++) frame();
    expect(wheel.quaternion.toArray()).toEqual(WHEEL_REST.toArray());
    expect(wheel.position.toArray()).toEqual([-1, -0.5, 1]);
  });

  it('warns once for a name the model has no node for, however many objects show the file and however often it is handed over', async () => {
    serve(rover);
    const wrong = { Wheel_XX: { rotation: { x: 1, y: 0, z: 0 } }, Wheel_FL: { rotation: { x: 1, y: 0, z: 0 } } };
    show([model('a', { parts: wrong }), model('b', { parts: wrong })]);
    await waitFor(() => settled('a')() && settled('b')(), 'both rovers');
    for (let i = 0; i < 4; i++) show([model('a', { parts: { ...wrong } }), model('b', { parts: { ...wrong } })]);
    const about = (name: string) => warned.mock.calls.filter((call: unknown[]) => String(call[0]).includes(`"${name}"`));
    expect(about('Wheel_XX')).toHaveLength(1);
    expect(String(about('Wheel_XX')[0][0])).toContain('no part called');
    // The part it does have is moved all the same; another wrong name is another warning.
    close(part('a', 'Wheel_FL').quaternion, WHEEL_REST.clone().multiply(turn(1, 0, 0)).toArray());
    show([model('a', { parts: { Wheel_YY: {} } }), model('b')]);
    expect(about('Wheel_YY')).toHaveLength(1);
  });

  it('is applied when a model that was still loading arrives, as the object has it by then', async () => {
    serve(rover, true);
    show([model('r', { parts: { Wheel_FL: { rotation: { x: 0, y: 1, z: 0 } } } })]);
    show([model('r', { parts: { Wheel_FL: { rotation: { x: 0, y: 2, z: 0 } }, Hatch: { visible: false } } })]);
    await letGo();
    close(part('r', 'Wheel_FL').quaternion, WHEEL_REST.clone().multiply(turn(0, 2, 0)).toArray());
    expect(part('r', 'Hatch').visible).toBe(false);
  });

  it('works on a model that is a group’s child, and with `fit`', async () => {
    serve(rover);
    const car = (parts: Scene3DObject['parts'], extra: Partial<Scene3DObject> = {}): Scene3DObject => ({
      id: 'convoy',
      type: 'group',
      position: { x: 10, y: 0, z: 0 },
      children: [{ id: 'lead', type: 'model', modelUrl: url('rover'), parts, ...extra }],
    });
    show([car({ Wheel_FR: { rotation: { x: 0, y: 0.5, z: 0 } } })]);
    await waitFor(settled('lead'), 'the rover');
    const wheel = part('lead', 'Wheel_FR');
    close(wheel.quaternion, WHEEL_REST.clone().multiply(turn(0, 0.5, 0)).toArray());
    show([car({ Wheel_FR: { rotation: { x: 0, y: 0.9, z: 0 } } }, { fit: 2 })]);
    expect(part('lead', 'Wheel_FR')).toBe(wheel);
    close(wheel.quaternion, WHEEL_REST.clone().multiply(turn(0, 0.9, 0)).toArray());
    // `fit` sized the model, not the part: the wheel keeps its own place and size in it.
    expect(wheel.position.toArray()).toEqual([1, -0.5, 1]);
    expect(wheel.scale.toArray()).toEqual(WHEEL_SCALE);
    show([car(undefined, { fit: 2 })]);
    expect(wheel.quaternion.toArray()).toEqual(WHEEL_REST.toArray());

    // At the top level, `fit` given and taken away around a part that is turned.
    show([model('r', { fit: 3, parts: { Wheel_FL: { rotation: { x: 0, y: 0.7, z: 0 } } } })]);
    await waitFor(settled('r'), 'the second rover');
    const top = part('r', 'Wheel_FL');
    close(top.quaternion, WHEEL_REST.clone().multiply(turn(0, 0.7, 0)).toArray());
    show([model('r', { parts: { Wheel_FL: { rotation: { x: 0, y: 0.7, z: 0 } } } })]);
    expect(part('r', 'Wheel_FL')).toBe(top);
    close(top.quaternion, WHEEL_REST.clone().multiply(turn(0, 0.7, 0)).toArray());
  });

  it('never touches another object showing the same file, nor the file as it is kept', async () => {
    serve(rover);
    show([model('a', { parts: { Wheel_FL: { rotation: { x: 0, y: 1, z: 0 }, position: { x: 0, y: 3, z: 0 } }, Hatch: { visible: false } } }), model('b')]);
    await waitFor(() => settled('a')() && settled('b')(), 'both rovers');
    expect(part('a', 'Wheel_FL')).not.toBe(part('b', 'Wheel_FL'));
    expect(part('b', 'Wheel_FL').quaternion.toArray()).toEqual(WHEEL_REST.toArray());
    expect(part('b', 'Wheel_FL').position.toArray()).toEqual([-1, -0.5, 1]);
    expect(part('b', 'Hatch').visible).toBe(true);
    // One shown later is cut from the same kept file, and is at rest.
    show([model('a', { parts: { Wheel_FL: { rotation: { x: 0, y: 2, z: 0 } } } }), model('b'), model('c')]);
    await waitFor(settled('c'), 'the third rover');
    expect(part('c', 'Wheel_FL').quaternion.toArray()).toEqual(WHEEL_REST.toArray());
    expect(part('c', 'Hatch').visible).toBe(true);
  });

  it('does nothing for the same parts handed over as a new record, and writes a changed one without walking the model', async () => {
    const rolling = (angle: number): Scene3DObject['parts'] => ({
      Wheel_FL: { rotation: { x: 0, y: angle, z: 0 } },
      Wheel_FR: { rotation: { x: 0, y: angle, z: 0 } },
    });
    await showRover({ parts: rolling(0.1) });
    const left = part('r', 'Wheel_FL');
    const right = part('r', 'Wheel_FR');
    const written = [vi.spyOn(left.quaternion, 'copy'), vi.spyOn(right.quaternion, 'copy')];
    // Every node of the model: a walk of it would be seen on any of them.
    const walked: Array<ReturnType<typeof vi.spyOn>> = [];
    nodeById('r').traverse((node) => walked.push(vi.spyOn(node, 'traverse')));
    walked.forEach((spy) => spy.mockClear());

    for (let i = 0; i < 5; i++) {
      show([model('r', { parts: rolling(0.1) })]);
      frame();
    }
    expect(written.map((spy) => spy.mock.calls.length)).toEqual([0, 0]);
    expect(walked.every((spy) => spy.mock.calls.length === 0)).toBe(true);

    show([model('r', { parts: rolling(0.2) })]);
    expect(written.map((spy) => spy.mock.calls.length)).toEqual([1, 1]);
    expect(walked.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    close(left.quaternion, WHEEL_REST.clone().multiply(turn(0, 0.2, 0)).toArray());
  });
});

describe('`parts` and a clip that is playing', () => {
  it('has the last word where it gives a part its rotation, its place or its size, and leaves the rest to the clip', async () => {
    await showRover({ animation: { clip: 'Wave' }, parts: { Arm: { rotation: { x: 0.5, y: 0, z: 0 } } } });
    const arm = part('r', 'Arm');
    const heights: number[] = [];
    for (let i = 0; i < 20; i++) {
      frame();
      // The turn is the part's on every frame, though the clip turns the arm too.
      close(arm.quaternion, turn(0.5, 0, 0).toArray());
      heights.push(arm.position.y);
    }
    // Its place is the clip's: it rises as the clip plays.
    expect(heights.at(-1)).toBeGreaterThan(heights[0]);
    expect(heights.at(-1)).toBeGreaterThan(ARM_AT[1]);
    expect(heights.at(-1)).toBeLessThan(2.6);
  });

  it('measures from the pose the file gives a part, not from where the clip had taken it', async () => {
    await showRover({ animation: { clip: 'Wave' } });
    const arm = part('r', 'Arm');
    for (let i = 0; i < 30; i++) frame();
    // Half a second in: the clip has raised the arm and turned it.
    expect(arm.position.y).toBeGreaterThan(ARM_AT[1] + 0.3);
    const turnedByClip = arm.quaternion.clone();

    show([model('r', { animation: { clip: 'Wave' }, parts: { Arm: { position: { x: 1, y: 0, z: 0 } } } })]);
    frame();
    // One along from where the file puts it, whatever the clip says of its place.
    close(arm.position, [ARM_AT[0] + 1, ARM_AT[1], ARM_AT[2]]);
    // Its turn is still the clip's, and still going.
    expect(arm.quaternion.angleTo(turnedByClip)).toBeGreaterThan(0);

    // Let go of, its place is the clip's again.
    show([model('r', { animation: { clip: 'Wave' } })]);
    for (let i = 0; i < 3; i++) frame();
    expect(arm.position.x).toBeCloseTo(ARM_AT[0], 9);
    expect(arm.position.y).toBeGreaterThan(ARM_AT[1] + 0.3);
  });
});

describe('a part let go of, and a clip that was started while the part held its node', () => {
  const held = { Arm: { rotation: { x: 1, y: 0, z: 0 }, position: { x: 0, y: 5, z: 0 } } };
  const atRest = (arm: THREE.Object3D) => {
    close(arm.quaternion, [0, 0, 0, 1]);
    close(arm.position, ARM_AT);
  };

  it('goes back to the pose its file gives it once the clip has been stopped: not to the clip’s last pose, nor to the part’s', async () => {
    await showRover({ parts: held });
    const arm = part('r', 'Arm');
    frame();
    close(arm.quaternion, turn(1, 0, 0).toArray());
    // The clip starts while the part holds the arm: three's mixer keeps the pose the arm has then, to put back later.
    show([model('r', { parts: held, animation: { clip: 'Wave' } })]);
    for (let i = 0; i < 30; i++) frame();
    close(arm.quaternion, turn(1, 0, 0).toArray());
    // The clip is stopped, and then the part is let go.
    show([model('r', { parts: held })]);
    frame();
    close(arm.quaternion, turn(1, 0, 0).toArray());
    show([model('r')]);
    frame();
    atRest(arm);
    for (let i = 0; i < 5; i++) frame();
    atRest(arm);
  });

  it('is the clip’s while the clip plays on, and the file’s when the clip is stopped after: never the part’s old pose', async () => {
    await showRover({ parts: held });
    const arm = part('r', 'Arm');
    show([model('r', { parts: held, animation: { clip: 'Wave' } })]);
    for (let i = 0; i < 30; i++) frame();
    // The part is let go while the clip plays: the arm is where the clip has it, half a second in, and goes on.
    show([model('r', { animation: { clip: 'Wave' } })]);
    frame();
    expect(arm.position.y).toBeGreaterThan(ARM_AT[1] + 0.3);
    expect(arm.position.y).toBeLessThan(2.6);
    const before = arm.position.y;
    for (let i = 0; i < 10; i++) frame();
    expect(arm.position.y).toBeGreaterThan(before);
    // The clip is stopped: what the mixer puts back is the file's pose, though it started over the part's.
    show([model('r')]);
    frame();
    atRest(arm);
  });

  it('goes back to the file’s pose after a clip played once has ended and let go', async () => {
    await showRover({ parts: held });
    const arm = part('r', 'Arm');
    const once = { clip: 'Wave', loop: 'once' as const, clampWhenFinished: false };
    show([model('r', { parts: held, animation: once })]);
    // Past the clip's two seconds: it has ended, and holds nothing.
    for (let i = 0; i < 150; i++) frame();
    show([model('r', { animation: once })]);
    frame();
    atRest(arm);
  });

  it('is still given back to a clip that is held at a second, which writes its pose once and not again', async () => {
    await showRover({ animation: { clip: 'Wave', time: 1 } });
    const arm = part('r', 'Arm');
    frame();
    // Half way through the clip's two seconds: half way up (the clip's keys are 32-bit numbers).
    close(arm.position, [ARM_AT[0], 1.6, ARM_AT[2]], 6);
    show([model('r', { animation: { clip: 'Wave', time: 1 }, parts: held })]);
    for (let i = 0; i < 3; i++) frame();
    close(arm.position, [ARM_AT[0], ARM_AT[1] + 5, ARM_AT[2]], 6);
    show([model('r', { animation: { clip: 'Wave', time: 1 } })]);
    frame();
    close(arm.position, [ARM_AT[0], 1.6, ARM_AT[2]], 6);
  });
});

describe('`parts` and `appearance`', () => {
  it('`visible` has the last word over `hiddenMeshes`, and gives the part back as `appearance` has it', async () => {
    await showRover({ appearance: { hiddenMeshes: ['Hatch'] } });
    const hatch = part('r', 'Hatch');
    expect(hatch.visible).toBe(false);
    show([model('r', { appearance: { hiddenMeshes: ['Hatch'] }, parts: { Hatch: { visible: true } } })]);
    frame();
    expect(hatch.visible).toBe(true);
    // The appearance written afresh hides it again; the part shows it again on the same frame.
    show([model('r', { appearance: { hiddenMeshes: ['Hatch', 'Lamp'] }, parts: { Hatch: { visible: true } } })]);
    frame();
    expect(hatch.visible).toBe(true);
    expect(part('r', 'Lamp').visible).toBe(false);
    show([model('r', { appearance: { hiddenMeshes: ['Hatch', 'Lamp'] } })]);
    frame();
    expect(hatch.visible).toBe(false);
  });
});

describe('`parts` with `transition`', () => {
  it('eases a part to a new rotation, place and size, and puts it there at once without one', async () => {
    await showRover({ parts: { Arm: { rotation: { x: 0, y: 0, z: 0 } } } }, { transition: 100 });
    const arm = part('r', 'Arm');
    frame();
    show([model('r', { parts: { Arm: { rotation: { x: 0, y: 1, z: 0 }, position: { x: 2, y: 0, z: 0 }, scale: 3 } } })], { transition: 100 });
    // Not yet: it is where it was.
    close(arm.quaternion, [0, 0, 0, 1]);
    frame(50);
    // Half way, at a steady rate.
    close(arm.quaternion, turn(0, 0.5, 0).toArray());
    close(arm.position, [ARM_AT[0] + 1, ARM_AT[1], ARM_AT[2]]);
    close(arm.scale, [2, 2, 2]);
    frame(60);
    close(arm.quaternion, turn(0, 1, 0).toArray());
    close(arm.position, [ARM_AT[0] + 2, ARM_AT[1], ARM_AT[2]]);
    close(arm.scale, [3, 3, 3]);

    // The object's own `transition` of none: at once.
    show([model('r', { transition: 0, parts: { Arm: { rotation: { x: 0, y: 2, z: 0 } } } })], { transition: 100 });
    close(arm.quaternion, turn(0, 2, 0).toArray());
    close(arm.position, ARM_AT);
  });

  it('turns the short way round', async () => {
    await showRover({ parts: { Arm: { rotation: { x: 0, y: 3, z: 0 } } } }, { transition: 100 });
    const arm = part('r', 'Arm');
    frame();
    // From just under half a turn one way to just under half a turn the other: a little, through the back.
    show([model('r', { parts: { Arm: { rotation: { x: 0, y: -3, z: 0 } } } })], { transition: 100 });
    frame(50);
    const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(arm.quaternion);
    // Half way it faces backwards (a turn of pi), not forwards (a turn of none).
    expect(facing.z).toBeCloseTo(-1, 6);
    frame(60);
    close(arm.quaternion.clone().multiply(turn(0, -3, 0).invert()).normalize(), [0, 0, 0, arm.quaternion.dot(turn(0, -3, 0)) < 0 ? -1 : 1]);
  });

  it('is put where it was going when the scene stops being drawn', () => {
    const model = rover().scene;
    const arm = model.getObjectByName('Arm') as THREE.Object3D;
    const parts = new ModelParts(model);
    parts.set({ Arm: { rotation: { x: 0, y: 1, z: 0 } } }, 200);
    parts.frame(50);
    expect(arm.quaternion.angleTo(turn(0, 1, 0))).toBeGreaterThan(0.1);
    parts.finish();
    close(arm.quaternion, turn(0, 1, 0).toArray());
    expect(parts.active).toBe(true);
    // Back at rest, and no longer held.
    parts.set(undefined, 0);
    close(arm.quaternion, [0, 0, 0, 1]);
    expect(parts.active).toBe(false);
  });
});
