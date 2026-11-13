/**
 * A scene made in another program, played as it was made: a clip held at a
 * second, every clip at once, what the "loaded" report says of the file's
 * cameras, lights and film, and the scene's view taken from a camera that
 * is in the model.
 *
 * The loader is mocked at `parse`, as in scene3d-models: the fixture is the
 * three.js objects a glTF of such a scene is loaded as (cameras and lights
 * as nodes, the film's record on the top node). The mixer, the cameras and
 * their matrices are three's own; what the view is expected to be is worked
 * out here from where the fixture's clip puts its camera.
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
import { blurOfLens } from '../src/threed/film-record';
import { modelTemplateCache } from '../src/threed/model-cache';
import { stubFetch, stubFrames, waitFor, type FrameStub } from './scene3d-doubles';

type Loaded = { scene: import('three').Object3D; animations: import('three').AnimationClip[] };
const loader = vi.hoisted(() => ({ make: new Map<string, () => unknown>() }));

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
      if (make) resolve(make());
      else reject(new Error(`no fixture called ${name}`));
    }
  },
}));

import * as THREE from 'three';

let run = 0;
const url = (name: string) => `https://models.test/f${run}/${name}.gltf`;

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
  states = [];
  frames = stubFrames();
  const routes: Record<string, () => string> = {};
  for (const name of ['film', 'parts', 'plain']) routes[url(name)] = () => JSON.stringify({ asset: { version: '2.0' }, name: `f${run}/${name}` });
  stubFetch(routes);
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

const serve = (name: string, make: () => Loaded) => loader.make.set(`f${run}/${name}`, make);

// The film: four seconds. Its wide camera rises from (14, 2, -12) to (10, 7, -16); its close camera stands
// still, with a lens that narrows; the rover drives from z = -6 to z = 6; the film cuts from wide to close at 2 s.
const RECORD = {
  version: 1,
  fps: 30,
  duration: 4,
  clip: 'Animation',
  clipStart: 0,
  cuts: [
    { time: 0, camera: 'Cam.Wide' },
    { time: 2, camera: 'Cam.Close' },
  ],
  cameras: {
    'Cam.Close': {
      fov: [
        [0, 0.42],
        [4, 0.22],
      ],
      focus: { object: 'Rover', fstop: 2.8, sensorHeight: 15.063 },
    },
  },
  view: { transform: 'AgX', exposure: 0.1375, look: 'None' },
  environment: { file: 'film.hdr', strength: 1, rotation: 0 },
};
const WIDE_FOV = 24.2877;

/** The scene's nodes, as a glTF of it is loaded. */
function nodes() {
  const scene = new THREE.Group();
  scene.name = 'Scene';
  scene.userData.softn = JSON.parse(JSON.stringify(RECORD));
  const wide = new THREE.PerspectiveCamera(WIDE_FOV, 2.39, 0.1, 500);
  wide.name = 'Cam.Wide';
  wide.position.set(14, 2, -12);
  wide.lookAt(0, 0.5, 0);
  const close = new THREE.PerspectiveCamera(24, 2.39, 0.05, 200);
  close.name = 'Cam.Close';
  close.position.set(-5, 1, -8);
  close.lookAt(0, 0.6, -6);
  const rover = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 2), new THREE.MeshStandardMaterial());
  rover.name = 'Rover';
  rover.position.set(0, 0.5, -6);
  const mast = new THREE.Group();
  mast.name = 'Mast';
  mast.position.set(0, 0.5, 0);
  rover.add(mast);
  const sun = new THREE.DirectionalLight(0xffffff, 4);
  sun.name = 'Sun';
  sun.position.set(5, 10, 2);
  sun.target.position.set(0, 0, -1);
  sun.add(sun.target);
  const glow = new THREE.PointLight(0xffaa66, 23.87);
  glow.name = 'Glow';
  glow.position.set(0, 0.95, -5.1);
  scene.add(wide, close, rover, sun, glow);
  return { scene, wide, close, rover, mast };
}
const track = (name: string, times: number[], from: number[], to: number[]) => new THREE.VectorKeyframeTrack(name, times, [...from, ...to]);

/** Everything in one clip, as Blender's "active actions" export writes it. */
function film(): Loaded {
  const { scene } = nodes();
  const clip = new THREE.AnimationClip('Animation', 4, [
    track('Cam.Wide.position', [0, 4], [14, 2, -12], [10, 7, -16]),
    track('Rover.position', [0, 4], [0, 0.5, -6], [0, 0.5, 6]),
  ]);
  return { scene, animations: [clip] };
}
/** A clip to each thing that moves, as Blender's default export writes them: of different lengths, and one whose keys begin a second in. */
function parts(): Loaded {
  const { scene } = nodes();
  (scene.userData.softn as { clip: string }).clip = '*';
  return {
    scene,
    animations: [
      new THREE.AnimationClip('Cam.WideAction', 4, [track('Cam.Wide.position', [0, 4], [14, 2, -12], [10, 7, -16])]),
      new THREE.AnimationClip('RoverAction', 2, [track('Rover.position', [0, 2], [0, 0.5, -6], [0, 0.5, 0])]),
      new THREE.AnimationClip('MastAction', 3, [track('Mast.position', [1, 3], [0, 0.5, 0], [0, 2.5, 0])]),
    ],
  };
}

const onModelState = (info: Scene3DModelStateInfo) => states.push(info);
const settled = (id: string) => () => states.some((s) => s.objectId === id && s.state !== 'pending');
const show = (objects: Scene3DObject[], props: Partial<Scene3DProps> = {}) =>
  act(() => root.render(<Scene3D objects={objects} lights={[]} onModelState={onModelState} {...props} />));
type Handles = HTMLCanvasElement & { __softnScene: THREE.Scene; __softnCamera: THREE.PerspectiveCamera; __softnControls: () => { enabled: boolean } | null };
const canvas = () => container.querySelector('canvas') as Handles;
function named(name: string): THREE.Object3D {
  let found: THREE.Object3D | undefined;
  canvas().__softnScene.traverse((node) => {
    if (!found && node.name === name) found = node;
  });
  return found as THREE.Object3D;
}
function frame(ms = 16): void {
  now += ms;
  act(() => frames.runFrame(now));
}
const model = (id: string, file: string, extra: Partial<Scene3DObject> = {}): Scene3DObject => ({ id, type: 'model', modelUrl: url(file), ...extra });
async function showFilm(extra: Partial<Scene3DObject> = {}, props: Partial<Scene3DProps> = {}, file = 'film'): Promise<void> {
  serve(file, file === 'film' ? film : parts);
  show([model('film', file, extra)], props);
  await waitFor(settled('film'), 'the film');
}
const close = (actual: THREE.Vector3 | THREE.Quaternion, expected: number[], digits = 9) =>
  actual.toArray().forEach((v, i) => expect(v, `component ${i}`).toBeCloseTo(expected[i], digits));
/** Where the wide camera is `t` seconds into the film. */
const wideAt = (t: number) => [14 - t, 2 + 1.25 * t, -12 - t];

describe('`animation.time`', () => {
  it('holds a clip at that many seconds, and no further than either end', async () => {
    await showFilm({ animation: { time: 1 } });
    frame();
    close(named('Rover').position, [0, 0.5, -3]);
    close(named('Cam.Wide').position, wideAt(1));
    for (let i = 0; i < 20; i++) frame();
    close(named('Rover').position, [0, 0.5, -3]);

    for (const [time, z] of [[3.5, 4.5], [99, 6], [-2, -6]]) {
      show([model('film', 'film', { animation: { time } })]);
      frame();
      close(named('Rover').position, [0, 0.5, z]);
    }
    // It is used in place of `progress` when both are given.
    show([model('film', 'film', { animation: { time: 1, progress: 0.75 } })]);
    frame();
    close(named('Rover').position, [0, 0.5, -3]);
  });

  it('counts from the clip’s first key, where `progress` counts from the clip’s own nought', async () => {
    await showFilm({ animation: { clip: 'MastAction', time: 0.5 } }, {}, 'parts');
    frame();
    // Its keys run from 1 s to 3 s of the clip: half a second in is a quarter of the way up.
    close(named('Mast').position, [0, 1, 0]);
    show([model('film', 'parts', { animation: { clip: 'MastAction', time: 5 } })]);
    frame();
    close(named('Mast').position, [0, 2.5, 0]);
    // Half of the clip's three seconds is a second and a half: a quarter of the way up, as it always was.
    show([model('film', 'parts', { animation: { clip: 'MastAction', progress: 0.5 } })]);
    frame();
    close(named('Mast').position, [0, 1, 0]);
  });

  it('set again on every frame, as `progress` may be, starts nothing again, fades nothing and warns of nothing', async () => {
    const resets = vi.spyOn(THREE.AnimationAction.prototype, 'reset');
    const fades = vi.spyOn(THREE.AnimationAction.prototype, 'crossFadeTo');
    const events: Scene3DAnimationInfo[] = [];
    const onAnimation = (info: Scene3DAnimationInfo) => events.push(info);
    await showFilm({ animation: { time: 0 } }, { onAnimation });
    const started = resets.mock.calls.length;
    for (let i = 1; i <= 60; i++) {
      show([model('film', 'film', { animation: { time: i / 15 } })], { onAnimation });
      frame();
      close(named('Rover').position, [0, 0.5, -6 + 3 * (i / 15)], 6);
    }
    for (let i = 0; i <= 30; i++) {
      show([model('film', 'film', { animation: { progress: i / 30 } })], { onAnimation });
      frame();
      close(named('Rover').position, [0, 0.5, -6 + 12 * (i / 30)], 6);
    }
    expect(resets.mock.calls.length).toBe(started);
    expect(fades).not.toHaveBeenCalled();
    expect(warned).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});

describe('`clip: "*"`', () => {
  it('holds every clip of the model at one second: each thing moves, and a clip that has ended stands at its end', async () => {
    await showFilm({ animation: { clip: '*', time: 1 } }, {}, 'parts');
    frame();
    close(named('Cam.Wide').position, wideAt(1));
    close(named('Rover').position, [0, 0.5, -3]);
    // The mast's keys begin at one second: it has not moved yet.
    close(named('Mast').position, [0, 0.5, 0]);

    show([model('film', 'parts', { animation: { clip: '*', time: 2.5 } })]);
    frame();
    close(named('Cam.Wide').position, wideAt(2.5));
    // The rover's clip is two seconds long: it stands where that left it.
    close(named('Rover').position, [0, 0.5, 0]);
    close(named('Mast').position, [0, 2, 0]);

    // `progress` is a share of the longest.
    show([model('film', 'parts', { animation: { clip: '*', progress: 0.25 } })]);
    frame();
    close(named('Cam.Wide').position, wideAt(1));
    close(named('Rover').position, [0, 0.5, -3]);
    expect(warned).not.toHaveBeenCalled();
  });

  it('plays them on one clock: the shorter wait at their ends for the longest, and all start again together', async () => {
    await showFilm({ animation: { clip: '*' } }, {}, 'parts');
    frame(1000);
    close(named('Rover').position, [0, 0.5, -3], 6);
    close(named('Cam.Wide').position, wideAt(1), 6);
    frame(2000);
    // Three seconds in: the rover's two seconds are over, and it has not started again.
    close(named('Rover').position, [0, 0.5, 0], 6);
    close(named('Mast').position, [0, 2.5, 0], 6);
    close(named('Cam.Wide').position, wideAt(3), 6);
    frame(1500);
    // Past the four seconds of the longest: half a second into the next time round, every one of them.
    close(named('Rover').position, [0, 0.5, -4.5], 6);
    close(named('Cam.Wide').position, wideAt(0.5), 6);
    close(named('Mast').position, [0, 0.5, 0], 6);
  });

  it('played once says so once, as "*", and stands at its end; one clip after it starts as from nothing', async () => {
    const events: Scene3DAnimationInfo[] = [];
    const onAnimation = (info: Scene3DAnimationInfo) => events.push(info);
    await showFilm({ animation: { clip: '*', loop: 'once' } }, { onAnimation }, 'parts');
    frame(3000);
    expect(events).toEqual([]);
    frame(2000);
    for (let i = 0; i < 5; i++) frame();
    expect(events).toEqual([{ objectId: 'film', clip: '*', type: 'finished' }]);
    close(named('Cam.Wide').position, wideAt(4), 6);
    close(named('Rover').position, [0, 0.5, 0], 6);

    const fades = vi.spyOn(THREE.AnimationAction.prototype, 'crossFadeTo');
    show([model('film', 'parts', { animation: { clip: 'RoverAction', time: 1 } })], { onAnimation });
    frame();
    close(named('Rover').position, [0, 0.5, -3]);
    // The other clips let go of what they held.
    close(named('Cam.Wide').position, wideAt(0));
    expect(fades).not.toHaveBeenCalled();
    // And a model with no clips at all has none to play: nothing is said to be missing.
    serve('plain', () => ({ scene: new THREE.Group(), animations: [] }));
    show([model('bare', 'plain', { animation: { clip: '*' } })], { onAnimation });
    await waitFor(settled('bare'), 'the bare model');
    expect(warned).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
  });
});

describe('what "loaded" says of a scene that is a film', () => {
  it('names its cameras and its lights, says how long each clip is, and hands over the film’s record', async () => {
    await showFilm({}, {}, 'parts');
    const report = states.find((s) => s.state === 'loaded') as Scene3DModelStateInfo;
    expect(report.clips).toEqual(['Cam.WideAction', 'RoverAction', 'MastAction']);
    // From each clip's first key to its last.
    expect(report.clipLengths).toEqual([4, 2, 2]);
    expect(report.cameras).toEqual(['Cam.Wide', 'Cam.Close']);
    expect(report.lights).toEqual(['Sun', 'Glow']);
    expect(report.film).toEqual({ ...RECORD, clip: '*' });
  });

  it('gives the app a copy of the record of a bounded size, and nothing of a record that is not one', async () => {
    serve('film', () => {
      const made = film();
      const record = made.scene.userData.softn as { cuts: unknown[]; cameras: Record<string, { fov?: number[][] }>; duration: unknown };
      record.cuts = Array.from({ length: 1000 }, (_, i) => ({ time: i, camera: 'Cam.Wide' }));
      record.cameras['Cam.Close'].fov = Array.from({ length: 5000 }, (_, i) => [i, 0.4]);
      record.duration = 'long';
      return made;
    });
    show([model('film', 'film'), model('twin', 'film')]);
    await waitFor(() => settled('film')() && settled('twin')(), 'both films');
    const [one, two] = states.filter((s) => s.state === 'loaded').map((s) => s.film);
    expect(one?.cuts).toHaveLength(256);
    const keys = one?.cameras['Cam.Close'].fov as [number, number][];
    expect(keys.length).toBeLessThanOrEqual(256);
    // Thinned evenly, with both ends kept.
    expect([keys[0][0], keys.at(-1)?.[0]]).toEqual([0, 4999]);
    // What was not a number is the default, not what the file said.
    expect(one?.duration).toBe(0);
    // Each report has its own: an app that changes one changes no one else's.
    expect(one).toEqual(two);
    expect(one).not.toBe(two);
    expect(one?.cuts).not.toBe(two?.cuts);

    serve('plain', () => {
      const scene = new THREE.Group();
      scene.userData.softn = { version: 7, cuts: 'none' };
      return { scene, animations: [] };
    });
    show([model('bare', 'plain')]);
    await waitFor(settled('bare'), 'the bare model');
    const bare = states.find((s) => s.objectId === 'bare' && s.state === 'loaded') as Scene3DModelStateInfo;
    expect('film' in bare).toBe(false);
    expect([bare.cameras, bare.lights, bare.clipLengths]).toEqual([[], [], []]);
  });

  it('lists no name longer than 200 characters, in any of its lists: a file may name a thing with a hundred thousand', async () => {
    const long = (start: string) => start + 'x'.repeat(201);
    serve('film', () => {
      const made = film();
      const camera = new THREE.PerspectiveCamera();
      camera.name = long('Cam');
      // three keeps what the file called a node beside the name it gives it: a file's to write, at any length.
      const kept = new THREE.PerspectiveCamera();
      kept.name = 'Kept';
      kept.userData.name = `Kept${'.'.repeat(100000)}`;
      const lamp = new THREE.PointLight();
      lamp.name = long('Lamp');
      const paint = new THREE.MeshStandardMaterial();
      paint.name = long('Paint');
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(), paint);
      mesh.name = long('Mesh');
      mesh.morphTargetDictionary = { [long('Smile')]: 0, Frown: 1 };
      mesh.morphTargetInfluences = [0, 0];
      made.scene.add(camera, kept, lamp, mesh);
      made.animations.push(new THREE.AnimationClip(long('Clip'), 1, [track('Rover.position', [0, 1], [0, 0, 0], [1, 0, 0])]));
      return made;
    });
    show([model('film', 'film')]);
    await waitFor(settled('film'), 'the film');
    const report = states.find((s) => s.state === 'loaded') as Scene3DModelStateInfo;
    for (const list of [report.clips, report.materials, report.meshes, report.morphs, report.nodes, report.cameras, report.lights]) {
      expect((list as string[]).every((name) => name.length <= 200)).toBe(true);
    }
    // The camera whose long name was only what the file called it goes by the name three gave it.
    expect(report.cameras).toEqual(['Cam.Wide', 'Cam.Close', 'Kept']);
    expect(report.lights).toEqual(['Sun', 'Glow']);
    expect(report.morphs).toEqual(['Frown']);
    // A clip left out takes its length with it: the two lists still go together.
    expect([report.clips, report.clipLengths]).toEqual([['Animation'], [4]]);
    expect(JSON.stringify(report).length).toBeLessThan(5000);
  });
});

describe('`camera={{ from }}`', () => {
  const view = () => canvas().__softnCamera;
  /** Where a camera of the model is and how it is turned, as three places it in the world. */
  function placed(name: string): { position: number[]; quaternion: number[] } {
    const node = named(name);
    canvas().__softnScene.updateMatrixWorld(true);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    node.matrixWorld.decompose(position, quaternion, new THREE.Vector3());
    return { position: position.toArray(), quaternion: quaternion.normalize().toArray() };
  }

  it('is the model’s camera once the model has loaded, and `position` and `lookAt` until then and for a model with none', async () => {
    serve('film', film);
    const camera = { from: 'film', position: { x: 1, y: 2, z: 3 }, lookAt: { x: 0, y: 0, z: 0 } };
    show([model('film', 'film', { animation: { time: 0 } })], { camera });
    close(view().position, [1, 2, 3]);
    expect(view().fov).toBe(60);
    await waitFor(settled('film'), 'the film');
    frame();
    close(view().position, [14, 2, -12]);
    close(view().quaternion, placed('Cam.Wide').quaternion);
    // The lens the file gives it, and how near and how far it draws.
    expect(view().fov).toBeCloseTo(2 * THREE.MathUtils.radToDeg(Math.atan((Math.tan(THREE.MathUtils.degToRad(WIDE_FOV) / 2) * 2.39) / (800 / 600))), 9);
    expect([view().near, view().far]).toEqual([0.1, 500]);

    // A model with no camera in it: the view is the prop's.
    serve('plain', () => ({ scene: new THREE.Group(), animations: [] }));
    show([model('bare', 'plain')], { camera: { ...camera, from: 'bare' } });
    await waitFor(settled('bare'), 'the bare model');
    frame();
    close(view().position, [1, 2, 3]);
    expect(view().fov).toBe(60);
    expect([view().near, view().far]).toEqual([0.1, 1000]);
  });

  it('follows the film’s cuts by the clip’s second, on the very frame, with nothing eased', async () => {
    const camera = { from: 'film' };
    const at = (time: number): Scene3DObject[] => [model('film', 'film', { animation: { time } })];
    // Everything that eases is on: none of it is to touch a model's camera.
    const easing = { camera, cameraSmoothing: 0.5, transition: 300 };
    await showFilm({ animation: { time: 0 } }, easing);
    frame();
    const seen: Array<[number, number[]]> = [];
    for (const time of [1, 1.99, 2, 2.01, 3]) {
      show(at(time), easing);
      frame();
      seen.push([time, view().position.toArray().map((v) => Math.round(v * 1000) / 1000)]);
    }
    expect(seen).toEqual([
      [1, wideAt(1)],
      [1.99, wideAt(1.99).map((v) => Math.round(v * 1000) / 1000)],
      // The cut: the frame at two seconds is through the other camera, where it stands.
      [2, [-5, 1, -8]],
      [2.01, [-5, 1, -8]],
      [3, [-5, 1, -8]],
    ]);
    close(view().quaternion, placed('Cam.Close').quaternion);
    // Back across the cut, the same.
    show(at(1.5), easing);
    frame();
    close(view().position, wideAt(1.5));
    close(view().quaternion, placed('Cam.Wide').quaternion);
  });

  it('takes the lens from the record where it changes, fitted to the scene’s shape, and `near` and `far` from the prop where given', async () => {
    await showFilm({ animation: { time: 3 } }, { camera: { from: 'film', near: 0.5, far: 80 }, width: 1195, height: 500 });
    frame();
    // Three seconds in, the close camera's lens is three quarters of the way from 0.42 to 0.22 radians;
    // the scene is the camera's own shape (2.39 to 1), so that is the angle.
    expect(view().fov).toBeCloseTo(THREE.MathUtils.radToDeg(0.27), 6);
    expect([view().near, view().far]).toEqual([0.5, 80]);
    expect(view().aspect).toBeCloseTo(2.39, 9);

    // Narrower than the camera's picture: the sides of the picture are kept, so the view is taller.
    show([model('film', 'film', { animation: { time: 3 } })], { camera: { from: 'film' }, width: 500, height: 500 });
    frame();
    expect(view().fov).toBeCloseTo(2 * THREE.MathUtils.radToDeg(Math.atan(Math.tan(0.27 / 2) * 2.39)), 6);
    expect([view().near, view().far]).toEqual([0.05, 200]);
  });

  it('looks through the camera named, wherever the object stands, and is the prop’s view again when `from` goes', async () => {
    const camera = { from: 'film', name: 'Cam.Close', position: { x: 0, y: 3, z: 9 }, lookAt: { x: 0, y: 0, z: 0 }, fov: 50 };
    const moved = { animation: { time: 1 }, position: { x: 100, y: 0, z: 0 }, rotation: { x: 0, y: Math.PI / 2, z: 0 }, scale: 2 };
    await showFilm(moved, { camera });
    frame();
    // The object is a hundred along, turned a quarter and twice the size: so is where its camera stands.
    const where = placed('Cam.Close');
    close(view().position, where.position);
    close(view().quaternion, where.quaternion);
    close(view().position, [100 + 2 * -8, 2, 2 * 5], 6);

    // A name the model has not: the prop's view, as for a model with no camera.
    show([model('film', 'film', moved)], { camera: { ...camera, name: 'Cam.Nowhere' } });
    frame();
    close(view().position, [0, 3, 9]);
    expect(view().fov).toBe(50);

    show([model('film', 'film', moved)], { camera });
    frame();
    close(view().position, where.position);
    show([model('film', 'film', moved)], { camera: { position: camera.position, lookAt: camera.lookAt, fov: 50 } });
    frame();
    close(view().position, [0, 3, 9]);
    expect(view().fov).toBe(50);
    expect([view().near, view().far]).toEqual([0.1, 1000]);
    const facing = new THREE.Vector3(0, 0, -1).applyQuaternion(view().quaternion);
    close(facing, new THREE.Vector3(0, -3, -9).normalize().toArray(), 6);
  });

  it('is taken after the clip and after `parts`, on the same frame', async () => {
    await showFilm({ animation: { time: 0 } }, { camera: { from: 'film', name: 'Cam.Wide' } });
    frame();
    // One update moves the clip on and moves the camera's own node by `parts`: the next frame's view has both.
    show([model('film', 'film', { animation: { time: 2 }, parts: { 'Cam.Wide': { position: { x: 0, y: 10, z: 0 } } } })], { camera: { from: 'film', name: 'Cam.Wide' } });
    frame();
    // `parts` has the last word on the camera's place: ten up from where the file puts it.
    close(view().position, [14, 12, -12]);
    show([model('film', 'film', { animation: { time: 2 } })], { camera: { from: 'film', name: 'Cam.Wide' } });
    frame();
    close(view().position, wideAt(2));
  });

  it('is found in a group’s child, and orbit controls wait while it is in force', async () => {
    serve('film', film);
    const set: Scene3DObject = { id: 'set', type: 'group', position: { x: 0, y: 5, z: 0 }, children: [model('film', 'film', { animation: { time: 1 } })] };
    show([set], { camera: { from: 'film' }, orbitControls: true });
    await waitFor(settled('film'), 'the film');
    await waitFor(() => canvas().__softnControls() !== null, 'the controls');
    frame();
    close(view().position, [13, 8.25, -13]);
    expect(canvas().__softnControls()?.enabled).toBe(false);
    show([set], { camera: { position: { x: 0, y: 3, z: 8 } }, orbitControls: true });
    frame();
    expect(canvas().__softnControls()?.enabled).toBe(true);
  });
});

describe('`depthOfField: "camera"`', () => {
  type Rig = { depthOfField: { enabled: boolean; uniforms: Record<string, { value: number }> } | null; composer: { render(): void } };
  const rig = () => (canvas() as unknown as { __softnEffects: () => Rig | null }).__softnEffects();
  const view = () => canvas().__softnCamera;
  const at = (time: number): Scene3DObject[] => [model('film', 'film', { animation: { time } })];
  const through = { effects: { depthOfField: 'camera' as const }, camera: { from: 'film' } };
  /** Show the film with the camera's own focus, and wait for the chain; its drawing is stood in for. */
  async function focused(make: () => Loaded = film): Promise<Rig> {
    serve('film', make);
    show(at(3), through);
    await waitFor(settled('film'), 'the film');
    await waitFor(() => rig() !== null, 'the chain to be built');
    const built = rig() as Rig;
    vi.spyOn(built.composer, 'render').mockImplementation(() => {});
    return built;
  }
  /** How far ahead of the scene's camera a node of the model is, by three's own matrices. */
  function ahead(name: string): number {
    canvas().__softnScene.updateMatrixWorld(true);
    view().updateMatrixWorld();
    return -new THREE.Vector3().setFromMatrixPosition(named(name).matrixWorld).applyMatrix4(view().matrixWorldInverse).z;
  }

  it('focuses on what the camera in force is focused on in the record, as it is drawn, with that camera’s lens', async () => {
    const built = await focused();
    frame();
    const pass = built.depthOfField as NonNullable<Rig['depthOfField']>;
    expect(pass.enabled).toBe(true);
    const sharp = ahead('Rover');
    expect(sharp).toBeGreaterThan(1);
    expect(pass.uniforms.focus.value).toBeCloseTo(sharp, 9);
    // The close camera's lens three seconds in is 0.27 radians top to bottom, at f/2.8 on a sensor 15.063 mm tall.
    // The scene is narrower than the camera's picture, so its view is taller: the circle is the same on the
    // sensor, and so a smaller share of the taller view.
    const own = blurOfLens(2.8, 0.27, sharp, 15.063);
    const shown = (own * Math.tan(0.27 / 2)) / Math.tan(THREE.MathUtils.degToRad(view().fov) / 2);
    expect(shown).toBeLessThan(own);
    expect(pass.uniforms.lens.value).toBeCloseTo(shown, 9);

    // The rover drives on and the lens narrows: the focus and the blur go with them, frame by frame.
    show(at(3.5), through);
    frame();
    expect(pass.uniforms.focus.value).toBeCloseTo(ahead('Rover'), 9);
    expect(pass.uniforms.focus.value).not.toBeCloseTo(sharp, 3);
  });

  it('blurs nothing through a camera with no focus in the record, and nothing when the scene looks through no camera of a model', async () => {
    const built = await focused();
    const pass = built.depthOfField as NonNullable<Rig['depthOfField']>;
    // Before the cut the film is through the wide camera, which the record gives no focus.
    show(at(1), through);
    frame();
    expect(pass.enabled).toBe(false);
    show(at(3), through);
    frame();
    expect(pass.enabled).toBe(true);
    show(at(3), { effects: through.effects, camera: { position: { x: 0, y: 3, z: 8 } } });
    frame();
    expect(pass.enabled).toBe(false);
  });

  it('follows a focus that the record gives as a distance, and one that moves', async () => {
    const built = await focused(() => {
      const made = film();
      (made.scene.userData.softn as { cameras: Record<string, unknown> }).cameras['Cam.Wide'] = {
        focus: { distance: 5, distances: [[0, 5], [2, 9]], fstop: 4 },
      };
      return made;
    });
    const pass = built.depthOfField as NonNullable<Rig['depthOfField']>;
    show(at(1), through);
    frame();
    expect(pass.enabled).toBe(true);
    // Half way from five units to nine.
    expect(pass.uniforms.focus.value).toBeCloseTo(7, 9);
    // The wide camera's own lens, on a full frame since the record names no sensor.
    const own = THREE.MathUtils.degToRad(WIDE_FOV);
    expect(pass.uniforms.lens.value).toBeCloseTo((blurOfLens(4, own, 7) * Math.tan(own / 2)) / Math.tan(THREE.MathUtils.degToRad(view().fov) / 2), 9);

    // That distance is a length of the model: a model drawn at twice its size is focused twice as far off.
    show([model('film', 'film', { animation: { time: 1 }, scale: 2 })], through);
    frame();
    expect(pass.uniforms.focus.value).toBeCloseTo(14, 9);
    show([model('film', 'film', { animation: { time: 1 }, scale: 0.01 })], through);
    frame();
    expect(pass.uniforms.focus.value).toBeCloseTo(0.07, 12);
  });
});

describe('a model’s own lights: `lights`', () => {
  const sun = () => named('Sun') as THREE.DirectionalLight;
  const glow = () => named('Glow') as THREE.PointLight;
  const lit = (lights: Scene3DObject['lights'], extra: Partial<Scene3DObject> = {}) => [model('film', 'film', { lights, ...extra })];

  it('left out, they shine as the file has them; `false` switches them off; `intensity` multiplies each', async () => {
    await showFilm();
    expect([sun().visible, sun().intensity, glow().visible, glow().intensity]).toEqual([true, 4, true, 23.87]);
    show(lit(false));
    expect([sun().visible, glow().visible]).toEqual([false, false]);
    show(lit({ intensity: 0.5 }));
    expect([sun().visible, sun().intensity, glow().visible, glow().intensity]).toEqual([true, 2, true, 11.935]);
    // The same again, as a new record, is the same: nothing is multiplied twice.
    show(lit({ intensity: 0.5 }));
    expect(sun().intensity).toBe(2);
    show(lit(undefined));
    expect([sun().visible, sun().intensity, glow().intensity]).toEqual([true, 4, 23.87]);
  });

  it('`castShadow` lets its sun cast shadows, with the settings of a scene’s light; a lamp that shines every way casts none', async () => {
    await showFilm({ lights: { castShadow: true, shadowMapSize: 2048, shadowCameraSize: 20, shadowBias: -0.001, shadowNormalBias: 0.03 }, castShadow: true }, { shadows: true });
    const shadow = sun().shadow;
    expect(sun().castShadow).toBe(true);
    expect([shadow.mapSize.width, shadow.bias, shadow.normalBias]).toEqual([2048, -0.001, 0.03]);
    expect(shadow.camera.right - shadow.camera.left).toBe(40);
    // The object's own `castShadow` is its meshes': it does not make a lamp cast.
    expect(glow().castShadow).toBe(false);
    expect((named('Rover') as THREE.Mesh).castShadow).toBe(true);

    show(lit({ intensity: 1 }, { castShadow: true }), { shadows: true });
    expect(sun().castShadow).toBe(false);
    expect(sun().shadow.map).toBeNull();
  });

  it('shines the way its node faces wherever the object is put: a light of a model moves with the model', async () => {
    await showFilm({ rotation: { x: 0, y: Math.PI / 2, z: 0 }, position: { x: 50, y: 0, z: 0 } });
    canvas().__softnScene.updateMatrixWorld(true);
    // Its target is a node of this copy of the model, a step in front of the light: not one left behind in the file.
    expect(sun().target.parent).toBe(sun());
    const from = new THREE.Vector3().setFromMatrixPosition(sun().matrixWorld).sub(new THREE.Vector3().setFromMatrixPosition(sun().target.matrixWorld));
    // The file's sun shines along -z; the object is turned a quarter about the upright, so it shines along -x.
    close(from, [1, 0, 0], 6);
  });

  it('keeps the box of its sun’s shadows about what the camera sees, without moving the light', async () => {
    const lights = { castShadow: true, shadowCameraSize: 10 };
    const looking = (x: number) => ({ position: { x, y: 2, z: 0 }, lookAt: { x, y: 2, z: -10 } });
    await showFilm({ lights }, { shadows: true, camera: looking(0) });
    frame();
    /** Whether three's shadow camera for the sun, placed as three places it, has a point of the world in its box. */
    const shadows = (point: [number, number, number]): boolean => {
      canvas().__softnScene.updateMatrixWorld(true);
      sun().shadow.updateMatrices(sun());
      const box = sun().shadow.camera;
      const at = new THREE.Vector3(...point).applyMatrix4(box.matrixWorldInverse).applyMatrix4(box.projectionMatrix);
      return Math.abs(at.x) <= 1 && Math.abs(at.y) <= 1 && Math.abs(at.z) <= 1;
    };
    // The middle of the box is eight units ahead of the camera: ten each way across the light from there.
    expect(shadows([9, 2, -8])).toBe(true);
    expect(shadows([-9, 2, -8])).toBe(true);
    expect(shadows([12, 2, -8])).toBe(false);
    expect(sun().position.toArray()).toEqual([5, 10, 2]);

    show(lit(lights), { shadows: true, camera: looking(40) });
    frame();
    expect(shadows([45, 2, -8])).toBe(true);
    expect(shadows([9, 2, -8])).toBe(false);
    expect(sun().position.toArray()).toEqual([5, 10, 2]);
  });

  it('`false` holds through every change of the model’s appearance, and they shine again when `lights` says so', async () => {
    await showFilm({ lights: false });
    expect([sun().visible, glow().visible]).toEqual([false, false]);
    // A change of what is hidden, and of a colour, writes every node of the model again.
    for (const appearance of [{ hiddenMeshes: ['Mast'] }, { hiddenMeshes: [] }, { colors: { Paint: '#ff0000' } }, undefined]) {
      show(lit(false, { appearance }));
      frame();
      expect([sun().visible, glow().visible], JSON.stringify(appearance)).toEqual([false, false]);
    }
    // On again, as far as the appearance shows them: a node named in `hiddenMeshes` stays hidden, as it always did.
    show(lit(undefined, { appearance: { hiddenMeshes: ['Glow'] } }));
    frame();
    expect([sun().visible, glow().visible]).toEqual([true, false]);
    show(lit({ intensity: 1 }));
    frame();
    expect([sun().visible, glow().visible]).toEqual([true, true]);
    // And off again holds through a change that comes with it.
    show(lit(false, { appearance: { hiddenMeshes: ['Rover'] } }));
    frame();
    expect([sun().visible, glow().visible]).toEqual([false, false]);
  });

  it('gives back the maps its lights drew their shadows into when the model is reloaded, given another file or removed', async () => {
    const lights = { castShadow: true };
    const loads = () => states.filter((s) => s.objectId === 'film' && s.state === 'loaded').length;
    await showFilm({ lights }, { shadows: true });
    /** A map as the renderer leaves one on a light that casts, after it has drawn a frame. */
    const drawn = () => {
      const map = new THREE.WebGLRenderTarget(16, 16);
      sun().shadow.map = map;
      return vi.spyOn(map, 'dispose');
    };
    let freed = drawn();
    show([model('film', 'film', { lights, reload: 1 })], { shadows: true });
    await waitFor(() => loads() === 2, 'the reload');
    expect(freed).toHaveBeenCalledOnce();

    freed = drawn();
    serve('plain', film);
    show([model('film', 'plain', { lights })], { shadows: true });
    await waitFor(() => loads() === 3, 'the other file');
    expect(freed).toHaveBeenCalledOnce();

    freed = drawn();
    show([], { shadows: true });
    expect(freed).toHaveBeenCalledOnce();
  });

  it('a lamp of the model that was casting gives back its map when `lights` first speaks of the model’s lights', async () => {
    // The object's own `castShadow` reaches every node of a model, its lamp among them.
    await showFilm({ castShadow: true }, { shadows: true });
    expect(glow().castShadow).toBe(true);
    const map = new THREE.WebGLRenderTarget(16, 16);
    glow().shadow.map = map;
    const freed = vi.spyOn(map, 'dispose');
    show(lit({ intensity: 1 }, { castShadow: true }), { shadows: true });
    expect(glow().castShadow).toBe(false);
    expect(freed).toHaveBeenCalledOnce();
    expect(glow().shadow.map).toBeNull();
  });

  it('aims a light whose definition several nodes share along its own node: the loader gives each of them three’s clone', async () => {
    serve('film', () => {
      const made = film();
      let first: THREE.DirectionalLight | undefined;
      made.scene.traverse((node) => {
        if (node.name === 'Sun') first = node as THREE.DirectionalLight;
      });
      // As GLTFLoader hands a light to every node after the first that uses its definition:
      // three's own clone, whose target is a copy that is in no scene.
      const twin = (first as THREE.DirectionalLight).clone();
      twin.name = 'Sun_instance_1';
      twin.position.set(-5, 10, 2);
      twin.rotation.set(0, Math.PI / 2, 0);
      expect(twin.target.parent).toBeNull();
      made.scene.add(twin);
      return made;
    });
    show([model('film', 'film', { position: { x: 30, y: 0, z: 0 } })]);
    await waitFor(settled('film'), 'the film');
    canvas().__softnScene.updateMatrixWorld(true);
    const twin = named('Sun_instance_1') as THREE.DirectionalLight;
    expect(twin.target.parent).toBe(twin);
    const from = new THREE.Vector3().setFromMatrixPosition(twin.matrixWorld).sub(new THREE.Vector3().setFromMatrixPosition(twin.target.matrixWorld));
    // It is turned a quarter about the upright: it shines along -x, from +x.
    close(from, [1, 0, 0], 6);
    // And the first of them still along its own.
    const own = new THREE.Vector3().setFromMatrixPosition(sun().matrixWorld).sub(new THREE.Vector3().setFromMatrixPosition(sun().target.matrixWorld));
    close(own, [0, 0, 1], 6);
  });
});

describe('what a review of the film’s camera found', () => {
  const view = () => canvas().__softnCamera;
  const filmAt = (time: number, extra: Partial<Scene3DObject> = {}, file = 'film'): Scene3DObject[] => [model('film', file, { animation: { time }, ...extra })];
  async function showMade(make: () => Loaded, objects: Scene3DObject[], props: Partial<Scene3DProps> = {}, file = 'film'): Promise<void> {
    serve(file, make);
    show(objects, props);
    await waitFor(settled('film'), 'the film');
    frame();
  }

  it('near and far are lengths of the model: a model drawn at a hundredth of its size has its camera’s a hundredth as long', async () => {
    await showFilm({ animation: { time: 0 }, scale: 0.01 }, { camera: { from: 'film' } });
    frame();
    // The wide camera draws from 0.1 to 500 of the file's units.
    expect(view().near).toBeCloseTo(0.001, 12);
    expect(view().far).toBeCloseTo(5, 9);
    close(view().position, [0.14, 0.02, -0.12], 9);
    // What the scene itself says is in the scene's units, and is used as it is.
    show(filmAt(0, { scale: 0.01 }), { camera: { from: 'film', near: 0.5, far: 80 } });
    frame();
    expect([view().near, view().far]).toEqual([0.5, 80]);
    // A model stretched unevenly: by its stretch along the camera's line of sight.
    show(filmAt(0, { scale: { x: 1, y: 1, z: 3 }, rotation: { x: 0, y: 0, z: 0 } }), { camera: { from: 'film', name: 'Cam.Close' } });
    frame();
    const sight = new THREE.Vector3(0, 0, -1).applyQuaternion(named('Cam.Close').quaternion);
    const along = Math.hypot(sight.x, sight.y, sight.z * 3);
    expect(view().near).toBeCloseTo(0.05 * along, 9);
    expect(view().far).toBeCloseTo(200 * along, 6);
  });

  it('a camera whose file gives it no farthest keeps the scene’s: three loads such a camera with one two million units off', async () => {
    const make = () => {
      const made = film();
      const open = new THREE.PerspectiveCamera(30, 1.5, 0.2, 2e6);
      open.name = 'Cam.Open';
      open.position.set(1, 2, 3);
      made.scene.add(open);
      return made;
    };
    await showMade(make, filmAt(0), { camera: { from: 'film', name: 'Cam.Open' } });
    close(view().position, [1, 2, 3]);
    expect([view().near, view().far]).toEqual([0.2, 1000]);
    // After a camera that has a farthest of its own, it is the scene's again, not the last camera's.
    show(filmAt(0), { camera: { from: 'film', name: 'Cam.Wide' } });
    frame();
    expect(view().far).toBe(500);
    show(filmAt(0), { camera: { from: 'film', name: 'Cam.Open' } });
    frame();
    expect(view().far).toBe(1000);
  });

  it('looks through the file’s first camera whether or not it has a name; a camera with none is in no list and answers to no name', async () => {
    const make = (): Loaded => {
      const scene = new THREE.Group();
      scene.name = 'Scene';
      // No name on the camera or on what holds it, as some programs write them.
      const first = new THREE.PerspectiveCamera(35, 1.5, 0.1, 100);
      first.position.set(3, 4, 5);
      const second = new THREE.PerspectiveCamera(50, 1.5, 0.1, 100);
      second.name = 'Second';
      second.position.set(-7, 1, 0);
      scene.add(first, second);
      return { scene, animations: [] };
    };
    await showMade(make, [model('film', 'film')], { camera: { from: 'film' }, width: 600, height: 400 });
    close(view().position, [3, 4, 5]);
    expect(view().fov).toBeCloseTo(35, 9);
    expect(states.find((s) => s.state === 'loaded')?.cameras).toEqual(['Second']);
    show([model('film', 'film')], { camera: { from: 'film', name: 'Second' }, width: 600, height: 400 });
    frame();
    close(view().position, [-7, 1, 0]);
    // No name asks for the nameless one.
    show([model('film', 'film')], { camera: { from: 'film', name: '', position: { x: 9, y: 9, z: 9 } }, width: 600, height: 400 });
    frame();
    close(view().position, [3, 4, 5]);
  });

  it('when `from` goes and the prop gives no place, the camera is back where it stood and looking as it did', async () => {
    serve('film', film);
    show(filmAt(1));
    await waitFor(settled('film'), 'the film');
    frame();
    const stood = view().position.toArray();
    const turned = view().quaternion.toArray();
    expect(stood).toEqual([0, 3, 8]);

    show(filmAt(1), { camera: { from: 'film' } });
    frame();
    close(view().position, wideAt(1));
    show(filmAt(1), { camera: {} });
    for (let i = 0; i < 3; i++) frame();
    close(view().position, stood);
    close(view().quaternion, turned);
    expect([view().near, view().far, view().fov]).toEqual([0.1, 1000, 60]);

    // What the prop gives is the prop's: a place given while the model's camera was in force.
    show(filmAt(1), { camera: { from: 'film' } });
    frame();
    show(filmAt(1), { camera: { from: 'film', position: { x: 1, y: 2, z: 3 }, lookAt: { x: 1, y: 2, z: -5 } } });
    frame();
    close(view().position, wideAt(1));
    show(filmAt(1), { camera: { position: { x: 1, y: 2, z: 3 }, lookAt: { x: 1, y: 2, z: -5 } } });
    frame();
    close(view().position, [1, 2, 3]);
    close(new THREE.Vector3(0, 0, -1).applyQuaternion(view().quaternion), [0, 0, -1], 9);
  });

  it('gives the camera back to where the person had orbited it to, about what they were orbiting', async () => {
    serve('film', film);
    show(filmAt(1), { orbitControls: true });
    await waitFor(settled('film'), 'the film');
    await waitFor(() => canvas().__softnControls() !== null, 'the controls');
    const controls = canvas().__softnControls() as unknown as { target: THREE.Vector3; update(): void; enabled: boolean };
    // As a drag leaves it.
    view().position.set(5, 6, 7);
    controls.target.set(1, 1, 1);
    controls.update();
    frame();
    const turned = view().quaternion.toArray();

    show(filmAt(1), { orbitControls: true, camera: { from: 'film' } });
    frame();
    close(view().position, wideAt(1));
    show(filmAt(1), { orbitControls: true });
    frame();
    close(view().position, [5, 6, 7], 6);
    close(controls.target, [1, 1, 1]);
    close(view().quaternion, turned, 6);
    expect(controls.enabled).toBe(true);
  });

  it('keeps nothing of the model once its view is left, or once the model has gone', async () => {
    type Held = { on: boolean; model: unknown; camera: unknown; film: unknown };
    const held = () => (canvas() as unknown as { __softnModelView: () => Held }).__softnModelView();
    const nothing = () => [held().on, held().model, held().camera, held().film];
    await showFilm({ animation: { time: 3 } }, { camera: { from: 'film' } });
    frame();
    expect(held().on).toBe(true);
    expect(held().camera).toBe(named('Cam.Close'));
    expect(held().film).toBeDefined();
    show(filmAt(3), { camera: {} });
    frame();
    expect(nothing()).toEqual([false, null, null, undefined]);

    show(filmAt(3), { camera: { from: 'film' } });
    frame();
    expect(held().camera).not.toBeNull();
    // The model goes while `from` still names it.
    show([], { camera: { from: 'film' } });
    frame();
    expect(nothing()).toEqual([false, null, null, undefined]);
  });

  it('runs a film by `animation.time` alone: a still scene whose cameras cut has no clip, and a clip may be shorter than the film', async () => {
    // Nothing moves: the cuts are all there is.
    await showMade(() => ({ scene: nodes().scene, animations: [] }), filmAt(1), { camera: { from: 'film' }, width: 1195, height: 500 });
    close(view().position, [14, 2, -12]);
    show(filmAt(2), { camera: { from: 'film' }, width: 1195, height: 500 });
    frame();
    close(view().position, [-5, 1, -8]);
    show(filmAt(3), { camera: { from: 'film' }, width: 1195, height: 500 });
    frame();
    // The close camera's lens three seconds in, from the record.
    expect(view().fov).toBeCloseTo(THREE.MathUtils.radToDeg(0.27), 6);
    expect(warned).not.toHaveBeenCalled();
    states = [];

    // Another file: a clip of one second in a film of three. The clip stands at its end, and the film goes on to its cut.
    const short = (): Loaded => {
      const { scene } = nodes();
      (scene.userData.softn as { duration: number }).duration = 3;
      return { scene, animations: [new THREE.AnimationClip('Animation', 1, [track('Rover.position', [0, 1], [0, 0.5, -6], [0, 0.5, -3])])] };
    };
    await showMade(short, filmAt(0.5, {}, 'parts'), { camera: { from: 'film' }, width: 1195, height: 500 }, 'parts');
    close(view().position, [14, 2, -12]);
    close(named('Rover').position, [0, 0.5, -4.5]);
    show(filmAt(2.5, {}, 'parts'), { camera: { from: 'film' }, width: 1195, height: 500 });
    frame();
    close(view().position, [-5, 1, -8]);
    close(named('Rover').position, [0, 0.5, -3]);
    expect(view().fov).toBeCloseTo(THREE.MathUtils.radToDeg(0.42 - 0.2 * (2.5 / 4)), 6);
    // No further than the film is long: its three seconds, not the lens's last key at four.
    show(filmAt(99, {}, 'parts'), { camera: { from: 'film' }, width: 1195, height: 500 });
    frame();
    expect(view().fov).toBeCloseTo(THREE.MathUtils.radToDeg(0.27), 6);
  });
});
