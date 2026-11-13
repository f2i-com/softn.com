import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import type { FilmRecord } from '../src/threed/film-record';
import { chooseModelView, findModelCamera, fittedFov, lookThrough, MAX_NAME_LENGTH, modelCameras, sightScale, type ModelView } from '../src/threed/model-camera';

/** A model as a loader gives it: a root, a mesh, and cameras as nodes among the rest. */
function model() {
  const root = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  body.name = 'Rover';
  const wide = new THREE.PerspectiveCamera(24.29, 2.39, 0.1, 500);
  wide.name = 'Cam.Wide';
  wide.position.set(14, 2, -12);
  wide.lookAt(0, 0.5, 0);
  const close = new THREE.PerspectiveCamera(40, 2.39, 0.05, 80);
  close.name = 'Cam.Close';
  close.position.set(-5, 1, -8);
  close.lookAt(0, 0.6, -6);
  root.add(body, wide, close);
  return { root, wide, close };
}

const forward = (cam: THREE.Camera) => new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));

describe("a model's cameras", () => {
  it('are found by the names their author gave them, in the file order', () => {
    const { root, wide, close } = model();
    expect([...modelCameras(root).keys()]).toEqual(['Cam.Wide', 'Cam.Close']);
    expect(findModelCamera(root, 'Cam.Close')).toBe(close);
    expect(findModelCamera(root)).toBe(wide);
    expect(findModelCamera(root, 'Cam.Missing')).toBeUndefined();
    expect(findModelCamera(new THREE.Group())).toBeUndefined();
  });

  it('go by the node an author named when the camera itself has no name', () => {
    const root = new THREE.Group();
    const node = new THREE.Group();
    node.name = 'Camera';
    const lens = new THREE.PerspectiveCamera();
    lens.name = '6f9619ff-8b86-4d11-b42d-00c04fc964ff'; // what an unnamed node is called when it is loaded
    node.add(lens);
    const loose = new THREE.PerspectiveCamera(); // no name anywhere: not addressable
    root.add(node, loose);
    expect([...modelCameras(root).keys()]).toEqual(['Camera']);
    expect(findModelCamera(root, 'Camera')).toBe(lens);
  });

  it('the first of two of the same name is the one that answers to it', () => {
    const root = new THREE.Group();
    const a = new THREE.PerspectiveCamera();
    const b = new THREE.PerspectiveCamera();
    a.name = 'Cam';
    b.name = 'Cam';
    root.add(a, b);
    expect(findModelCamera(root, 'Cam')).toBe(a);
  });

  it('a camera with no name counts: it is the first if the file has it first, though no name asks for it', () => {
    const root = new THREE.Group();
    const loose = new THREE.PerspectiveCamera(); // no name on it, nor on what holds it
    const named = new THREE.PerspectiveCamera();
    named.name = 'Second';
    root.add(loose, named);
    const cameras = modelCameras(root);
    expect([...cameras.keys()]).toEqual(['Second']);
    expect(cameras.first).toBe(loose);
    expect(cameras.firstName).toBeUndefined();
    expect(findModelCamera(root)).toBe(loose);
    expect(findModelCamera(root, '')).toBeUndefined();

    const out = {} as ModelView;
    // No cuts: the file's first camera. A cut to a camera the file has not: the same.
    expect(chooseModelView(cameras, undefined, undefined, undefined, out)).toBe(true);
    expect([out.camera, out.name, out.film]).toEqual([loose, '', undefined]);
    const film: FilmRecord = { version: 1, fps: 30, duration: 4, clipStart: 0, cuts: [{ time: 0, camera: 'Gone' }, { time: 2, camera: 'Second' }], cameras: {} };
    expect(chooseModelView(cameras, film, 1, undefined, out)).toBe(true);
    expect(out.camera).toBe(loose);
    expect(chooseModelView(cameras, film, 3, undefined, out)).toBe(true);
    expect([out.camera, out.name]).toEqual([named, 'Second']);
  });

  it('a name too long to be one is no name: the camera goes by the name three gave it, or by none', () => {
    const root = new THREE.Group();
    const a = new THREE.PerspectiveCamera();
    a.name = 'x'.repeat(MAX_NAME_LENGTH + 1);
    const b = new THREE.PerspectiveCamera();
    b.name = 'Kept';
    b.userData.name = `Kept${'.'.repeat(5000)}`;
    const c = new THREE.PerspectiveCamera();
    c.name = 'y'.repeat(MAX_NAME_LENGTH);
    root.add(a, b, c);
    const cameras = modelCameras(root);
    expect([...cameras.keys()]).toEqual(['Kept', c.name]);
    expect(cameras.first).toBe(a);
  });
});

describe('the film’s second', () => {
  const { root } = model();
  const cameras = modelCameras(root);
  const film: FilmRecord = {
    version: 1,
    fps: 30,
    duration: 10,
    clipStart: 0.5,
    cuts: [{ time: 0, camera: 'Cam.Wide' }, { time: 6, camera: 'Cam.Close' }],
    cameras: { 'Cam.Close': { fov: [[6, 0.4], [10, 0.2]] } },
  };
  const out = {} as ModelView;

  it('is the clip’s own second, less where the film begins in it, for a model that is given no `time`', () => {
    chooseModelView(cameras, film, 4.5, undefined, out);
    expect([out.name, out.seconds]).toEqual(['Cam.Wide', 4]);
    chooseModelView(cameras, film, 6.5, undefined, out);
    expect([out.name, out.seconds]).toEqual(['Cam.Close', 6]);
    // Playing nothing: the film's first frame.
    chooseModelView(cameras, film, undefined, undefined, out);
    expect([out.name, out.seconds]).toEqual(['Cam.Wide', 0]);
  });

  it('is `time` where the object gives one, whatever the clip stands at, and no further than the film is long', () => {
    // A clip two seconds long stands at its end; the film goes on.
    chooseModelView(cameras, film, 2, undefined, out, 8);
    expect([out.name, out.seconds]).toEqual(['Cam.Close', 8]);
    expect(out.fov).toBeCloseTo(0.3, 12);
    // No clip at all.
    chooseModelView(cameras, film, undefined, undefined, out, 7);
    expect([out.name, out.seconds]).toEqual(['Cam.Close', 7]);
    chooseModelView(cameras, film, undefined, undefined, out, 99);
    expect(out.seconds).toBe(10);
    chooseModelView(cameras, film, undefined, undefined, out, -3);
    expect([out.name, out.seconds]).toEqual(['Cam.Wide', 0]);
    // A record that does not say how long the film is holds it to nothing.
    chooseModelView(cameras, { ...film, duration: 0 }, undefined, undefined, out, 99);
    expect(out.seconds).toBe(99);
    // Not a number: as if none were given.
    chooseModelView(cameras, film, 6.5, undefined, out, Number.NaN);
    expect(out.seconds).toBe(6);
  });
});

describe('looking through one', () => {
  it('stands the view where the camera is and faces it the same way', () => {
    const { root, close } = model();
    const view = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    expect(lookThrough(view, close, { aspect: 2.39 })).toBe(true);
    expect(view.position.toArray()).toEqual([-5, 1, -8]);
    expect(forward(view).distanceTo(forward(close))).toBeLessThan(1e-12);
    expect(view.fov).toBeCloseTo(40, 9);
    expect(view.aspect).toBe(2.39);
    expect(view.near).toBe(0.05);
    expect(view.far).toBe(80);
    expect(root.children.length).toBe(3);
  });

  it('follows the model where it is drawn: moved, turned and scaled', () => {
    const { root, close } = model();
    root.position.set(100, 0, 0);
    root.rotation.y = Math.PI / 2;
    root.scale.setScalar(2);
    const view = new THREE.PerspectiveCamera();
    lookThrough(view, close, { aspect: 2.39 });
    // (-5, 1, -8) scaled by 2, turned a quarter turn about y (x' = z, z' = -x), moved 100 along x.
    expect(view.position.x).toBeCloseTo(100 - 16, 9);
    expect(view.position.y).toBeCloseTo(2, 9);
    expect(view.position.z).toBeCloseTo(10, 9);
    expect(forward(view).distanceTo(forward(close))).toBeLessThan(1e-9);
    // The view is not scaled with the model: a scaled camera draws a skewed picture.
    expect(view.scale.toArray()).toEqual([1, 1, 1]);
  });

  it('follows a camera that a clip has moved since', () => {
    const { close } = model();
    const view = new THREE.PerspectiveCamera();
    lookThrough(view, close, { aspect: 2.39 });
    close.position.set(1, 2, 3);
    close.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 1);
    lookThrough(view, close, { aspect: 2.39 });
    expect(view.position.toArray()).toEqual([1, 2, 3]);
    expect(forward(view).distanceTo(forward(close))).toBeLessThan(1e-12);
  });

  it('takes a field of view said for this moment over the camera own', () => {
    const { close } = model();
    const view = new THREE.PerspectiveCamera();
    lookThrough(view, close, { aspect: 2.39, fov: 0.3 });
    expect(view.fov).toBeCloseTo(THREE.MathUtils.radToDeg(0.3), 9);
  });

  it('takes near and far said by the scene over the camera own', () => {
    const { close } = model();
    const view = new THREE.PerspectiveCamera();
    lookThrough(view, close, { aspect: 2.39, near: 0.5, far: 9000 });
    expect(view.near).toBe(0.5);
    expect(view.far).toBe(9000);
    // A far plane at or before the near one is not taken.
    lookThrough(view, close, { aspect: 2.39, near: 2, far: 1 });
    expect(view.near).toBe(2);
    expect(view.far).toBe(9000);
  });

  it('takes the camera’s near and far as lengths of the model: as long in the scene as the model is drawn', () => {
    const { root, close } = model();
    root.scale.setScalar(0.01);
    const view = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    lookThrough(view, close, { aspect: 2.39 });
    // A file in centimetres under a scale of a hundredth: 0.05 and 80 of its units.
    expect(view.near).toBeCloseTo(0.0005, 12);
    expect(view.far).toBeCloseTo(0.8, 12);
    expect(sightScale(close)).toBeCloseTo(0.01, 12);
    // What the scene says is the scene's, whatever the model's size.
    lookThrough(view, close, { aspect: 2.39, near: 0.5, far: 90 });
    expect([view.near, view.far]).toEqual([0.5, 90]);
    // Stretched unevenly: by the stretch along the line of sight.
    root.scale.set(1, 1, 4);
    root.updateMatrixWorld(true);
    const sight = new THREE.Vector3(0, 0, 1).applyQuaternion(close.quaternion);
    const along = Math.hypot(sight.x, sight.y, sight.z * 4);
    expect(sightScale(close)).toBeCloseTo(along, 12);
    lookThrough(view, close, { aspect: 2.39 });
    expect(view.near).toBeCloseTo(0.05 * along, 12);
  });

  it('does not take a far that is no far: a camera whose file names none keeps the scene’s', () => {
    const { root } = model();
    // What three's loader gives a camera with no `zfar`.
    const open = new THREE.PerspectiveCamera(40, 1.5, 0.2, 2e6);
    root.add(open);
    const view = new THREE.PerspectiveCamera(60, 1, 0.1, 750);
    lookThrough(view, open, { aspect: 1.5, sceneFar: 1000 });
    expect([view.near, view.far]).toEqual([0.2, 1000]);
    // And with nothing said of the scene's, the view's own is left.
    view.far = 640;
    lookThrough(view, open, { aspect: 1.5 });
    expect(view.far).toBe(640);
    // A far the scene gives is still the scene's to give.
    lookThrough(view, open, { aspect: 1.5, far: 5000, sceneFar: 1000 });
    expect(view.far).toBe(5000);
  });

  it('gives an orthographic view the place and the facing only', () => {
    const { close } = model();
    const view = new THREE.OrthographicCamera(-4, 4, 3, -3, 0.1, 100);
    expect(lookThrough(view, close, { aspect: 4 / 3 })).toBe(true);
    expect(view.position.toArray()).toEqual([-5, 1, -8]);
    expect([view.left, view.right, view.top, view.bottom]).toEqual([-4, 4, 3, -3]);
  });

  it('changes nothing for a camera whose place is not a place', () => {
    const { root, close } = model();
    const view = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    view.position.set(7, 8, 9);
    root.scale.setScalar(Number.NaN);
    expect(lookThrough(view, close, { aspect: 2 })).toBe(false);
    expect(view.position.toArray()).toEqual([7, 8, 9]);
    expect(view.fov).toBe(50);
  });
});

describe('a picture framed for one shape, shown in another', () => {
  const fov = THREE.MathUtils.degToRad(24.29);

  it('keeps its field of view in a scene of its own shape, or wider', () => {
    expect(fittedFov(fov, 2.39, 2.39)).toBeCloseTo(24.29, 9);
    expect(fittedFov(fov, 2.39, 3)).toBeCloseTo(24.29, 9);
  });

  it('keeps its sides in a narrower scene, by seeing more above and below', () => {
    const fitted = THREE.MathUtils.degToRad(fittedFov(fov, 2.39, 16 / 9));
    // The horizontal field of view is what it was.
    const before = 2 * Math.atan(Math.tan(fov / 2) * 2.39);
    const after = 2 * Math.atan(Math.tan(fitted / 2) * (16 / 9));
    expect(after).toBeCloseTo(before, 9);
    expect(fitted).toBeGreaterThan(fov);
  });

  it('stays a field of view however narrow the scene', () => {
    expect(fittedFov(fov, 2.39, 0.0001)).toBe(179);
    expect(fittedFov(fov, 0, 0.5)).toBeCloseTo(24.29, 9);
    expect(fittedFov(fov, 2.39, 0)).toBeCloseTo(24.29, 9);
  });
});
