/**
 * Looking through a camera that is in a model.
 *
 * A scene made in another program has its cameras in it: where each stands,
 * which way it faces, how wide its lens is, and (keyframed with everything
 * else) how it moves. They were loaded with the model and never used: the
 * scene's view was always the one camera the app placed. What is here finds
 * a model's cameras by the names their author gave them and stands the
 * scene's camera where one of them is, for this frame.
 */

import * as THREE from 'three';
import { cameraAt, fovAt, type FilmCamera, type FilmRecord } from './film-record';

export type Lens = THREE.PerspectiveCamera | THREE.OrthographicCamera;

const isCamera = (node: THREE.Object3D): node is Lens => (node as THREE.Camera).isCamera === true;
const isPerspective = (cam: THREE.Camera): cam is THREE.PerspectiveCamera =>
  (cam as THREE.PerspectiveCamera).isPerspectiveCamera === true;

/** The most cameras of one model that are listed: a list is for reading. */
const MAX_CAMERAS = 256;

/**
 * The longest a name may be and still be a name: one longer is not a name an
 * author will type, and what is listed here crosses into the app's logic
 * with every model that loads.
 */
export const MAX_NAME_LENGTH = 200;

/**
 * A model's cameras by the names their author gave them, and the first of
 * them whether or not it has a name: other programs than Blender write
 * cameras with none, and such a camera is still a camera of the model.
 */
export class ModelCameras extends Map<string, Lens> {
  /** The file's first camera: the one looked through when none is asked for and no cut names one. */
  first: Lens | undefined = undefined;
  /** The name `first` goes by, for a first camera that has one. */
  firstName: string | undefined = undefined;
}

/**
 * A model's cameras, in the order the file has them, by name. A camera whose
 * own node has no name (some exporters put the camera on an unnamed child of
 * the node the author named) goes by its parent's. A camera with no name at
 * all cannot be asked for by one and is not listed, but it counts: it is
 * `first` if the file has it first.
 */
export function modelCameras(root: THREE.Object3D): ModelCameras {
  const found = new ModelCameras();
  root.traverse((node) => {
    if (!isCamera(node)) return;
    const named = cameraName(node, root);
    if (found.first === undefined) {
      found.first = node;
      found.firstName = named;
    }
    if (named !== undefined && found.size < MAX_CAMERAS && !found.has(named)) found.set(named, node);
  });
  return found;
}

// A node the file left unnamed is named by its uuid when it is loaded
// (model-loaders.ts): no name an author gave. Nor is one too long to be one.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const given = (value: string): boolean => value !== '' && value.length <= MAX_NAME_LENGTH && !UUID.test(value);

function cameraName(camera: THREE.Object3D, root: THREE.Object3D): string | undefined {
  return authorsName(camera, root);
}

/**
 * The name its author gave a camera or a light of the model `root`: its own
 * node's, or, where that has none, the name of the node it hangs from.
 * Undefined where neither has one.
 */
export function authorsName(node: THREE.Object3D, root: THREE.Object3D): string | undefined {
  const own = asWritten(node);
  if (own !== undefined) return own;
  const parent = node.parent;
  if (parent && parent !== root) return asWritten(parent);
  return undefined;
}

/** A name as three writes one when it loads a file: a space becomes an underscore, and `[ ] . : /` are dropped. */
const loaded = (name: string): string => THREE.PropertyBinding.sanitizeNodeName(name);

/**
 * A node's name as its author wrote it. three's glTF loader rewrites a
 * node's name ("Cam.Close" is loaded as "CamClose") and keeps what the file
 * said beside it; a film's record, and its author, know the camera by what
 * the file said. Undefined for a node with no name.
 */
function asWritten(node: THREE.Object3D): string | undefined {
  const kept: unknown = (node.userData as { name?: unknown } | undefined)?.name;
  if (typeof kept === 'string' && given(kept) && loaded(kept) === node.name) return kept;
  return given(node.name) ? node.name : undefined;
}

const spellings = new WeakMap<object, Map<string, string | null>>();

/**
 * The name `named` knows `name` by: the name as given, and failing that
 * the one that is the same in either spelling, the author's or three's
 * ("CamClose" finds "Cam.Close", and the other way about). What a name was
 * found to be is remembered, so a name asked for on every frame is looked
 * up once. Undefined for a name it has nothing under.
 */
export function keyByName(named: Map<string, unknown>, name: string): string | undefined {
  if (named.has(name)) return name;
  let known = spellings.get(named);
  if (!known) {
    known = new Map();
    spellings.set(named, known);
  }
  let found = known.get(name);
  if (found === undefined) {
    found = null;
    const wanted = loaded(name);
    for (const key of named.keys()) {
      if (loaded(key) === wanted) {
        found = key;
        break;
      }
    }
    if (known.size >= 256) known.clear();
    known.set(name, found);
  }
  return found ?? undefined;
}

/** The most lights of one model that are listed. */
const MAX_LIGHTS = 256;

/** A model's lights, in the order the file has them, by name: named as its cameras are. */
export function modelLights(root: THREE.Object3D): Map<string, THREE.Light> {
  const found = new Map<string, THREE.Light>();
  root.traverse((node) => {
    if ((node as THREE.Light).isLight !== true || found.size >= MAX_LIGHTS) return;
    const named = authorsName(node, root);
    if (named !== undefined && !found.has(named)) found.set(named, node as THREE.Light);
  });
  return found;
}

/**
 * The camera of `root` called `name`; with no name, its first, whether or
 * not that one has a name. Undefined for a model with no such camera.
 */
export function findModelCamera(root: THREE.Object3D, name?: string): Lens | undefined {
  const cameras = modelCameras(root);
  if (name === undefined) return cameras.first;
  const key = keyByName(cameras, name);
  return key === undefined ? undefined : cameras.get(key);
}

/** Which of a model's cameras the scene looks through for a frame, and what the film's record says of it then. */
export interface ModelView {
  camera: Lens;
  /** The name the camera goes by; empty for a camera with none. */
  name: string;
  /**
   * Seconds on the film's clock: `animation.time` where the object gives
   * one, and otherwise the clip's own seconds, less where the film's first
   * frame is in them.
   */
  seconds: number;
  /** The camera's vertical field of view then, in radians, for a lens that changes; undefined for the camera's own. */
  fov: number | undefined;
  /** What the record holds of the camera: its focus, for depth of field. */
  film: FilmCamera | undefined;
}

/**
 * Choose the camera of a model to look through, into `out` (the caller's to
 * keep and hand back, so a frame makes nothing). With a `name`, that one, or
 * none if the model has no camera of the name. Without: the one the film's
 * cuts name for the second the film stands at, and where there are no cuts,
 * or they name a camera the file has not, the model's first, whether or not
 * that one has a name.
 *
 * The film's second is `time` where the object holds its animation at one
 * (`animation.time`): no further than the film's own `duration`, but not
 * held to the length of any clip, so a film with no clip in it, or one whose
 * clip is shorter than the film (only a lens moves; nothing moves and the
 * cuts are all there is), is run by `time` alone. With no `time` it is
 * `clipSeconds`, where the model's animation stands in its clips' own
 * seconds, less where the film's first frame is in them; a model that is
 * playing nothing (`clipSeconds` undefined) stands at the film's first frame.
 */
export function chooseModelView(
  cameras: Map<string, Lens> & { first?: Lens; firstName?: string },
  film: FilmRecord | undefined,
  clipSeconds: number | undefined,
  name: string | undefined,
  out: ModelView,
  time?: number
): boolean {
  let seconds: number;
  if (time !== undefined && Number.isFinite(time)) {
    seconds = Math.max(0, time);
    if (film && film.duration > 0 && seconds > film.duration) seconds = film.duration;
  } else {
    seconds = clipSeconds === undefined ? 0 : clipSeconds - (film?.clipStart ?? 0);
  }
  let chosen: string | undefined;
  let camera: Lens | undefined;
  if (name !== undefined) {
    chosen = keyByName(cameras, name);
    camera = chosen === undefined ? undefined : cameras.get(chosen);
  } else {
    const cut = cameraAt(film, seconds);
    chosen = cut === undefined ? undefined : keyByName(cameras, cut);
    camera = chosen === undefined ? undefined : cameras.get(chosen);
    if (!camera) {
      // No cuts, or a cut to a camera the file has not: the file's first, named or not.
      if (cameras.first) {
        camera = cameras.first;
        chosen = cameras.firstName;
      } else {
        // A plain list of cameras by name: its first.
        for (const [key, value] of cameras) {
          chosen = key;
          camera = value;
          break;
        }
      }
    }
  }
  if (!camera) return false;
  const about = chosen === undefined ? undefined : film?.cameras[chosen];
  out.camera = camera;
  out.name = chosen ?? '';
  out.seconds = seconds;
  out.fov = fovAt(about, seconds);
  out.film = about;
  return true;
}

/** What may be said over the model camera's own numbers. */
export interface LookThroughOptions {
  /** The scene's shape: its width over its height. */
  aspect: number;
  /** A vertical field of view in radians to use instead of the camera's own (a lens that changes over time). */
  fov?: number;
  /** The scene's own nearest and farthest (`camera.near`, `camera.far`), in the scene's units: used as they are, over the camera's. */
  near?: number;
  far?: number;
  /** The scene's farthest as it stands with no model's camera in force, for a camera whose file gave it no far of its own. */
  sceneFar?: number;
}

const position = new THREE.Vector3();
const quaternion = new THREE.Quaternion();
const scale = new THREE.Vector3();

/**
 * three's glTF loader gives a camera whose file names no far plane one two
 * million units away. A far that large is no far at all: it is not taken.
 */
const NO_FAR = 2e6;

/**
 * How long a unit of the model along `camera`'s line of sight is in the
 * scene: what a length that belongs to the model's camera (its near, its
 * far, a focus given as a distance) is multiplied by, so that a model drawn
 * at a hundredth of its size (a file in centimetres under `scale: 0.01`) has
 * them a hundredth as long. For a model stretched unevenly it is the stretch
 * along the line of sight, which is the way those lengths run. 1 for a
 * camera with no scale that can be read. The camera's world matrix must be
 * up to date (`lookThrough` leaves it so).
 */
export function sightScale(camera: THREE.Object3D): number {
  const e = camera.matrixWorld.elements;
  const along = Math.hypot(e[8], e[9], e[10]);
  return Number.isFinite(along) && along > 0 ? along : 1;
}

/**
 * The vertical field of view, in degrees, that shows in a scene of shape
 * `aspect` what a camera of vertical field of view `fov` (radians) shows at
 * its own shape `ownAspect`. A scene as wide as the camera's picture or
 * wider keeps the field of view (and sees more at the sides). A narrower one
 * widens it so the sides of the picture are kept (and sees more above and
 * below): what was framed is never cut off.
 */
export function fittedFov(fov: number, ownAspect: number, aspect: number): number {
  let vertical = fov;
  if (ownAspect > 0 && aspect > 0 && aspect < ownAspect) {
    vertical = 2 * Math.atan((Math.tan(fov / 2) * ownAspect) / aspect);
  }
  return THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(vertical), 1, 179);
}

/**
 * Stand `view` where `source` is and face it the way `source` faces, as the
 * model is drawn now; and, where both are perspective cameras, give it
 * `source`'s lens (fitted to the scene's shape) and its near and far planes.
 * An orthographic `view` takes the place and the facing only: its size is
 * the scene's own.
 *
 * The camera's near and far are lengths of the model, and are as long in the
 * scene as the model is drawn (`sightScale`): a model at a hundredth of its
 * size has its camera's near a hundredth as far off. `near` and `far` given
 * in `options` are the scene's and are used as they are. A camera whose file
 * gave it no far keeps the scene's (`sceneFar`).
 *
 * Returns false, and changes nothing, for a camera whose place is not a
 * place (a model scaled to nothing, a matrix of NaN).
 */
export function lookThrough(view: Lens, source: THREE.Camera, options: LookThroughOptions): boolean {
  source.updateWorldMatrix(true, false);
  source.matrixWorld.decompose(position, quaternion, scale);
  if (![position.x, position.y, position.z, quaternion.x, quaternion.y, quaternion.z, quaternion.w].every(Number.isFinite)) {
    return false;
  }
  if (quaternion.lengthSq() < 1e-12) return false;
  view.position.copy(position);
  view.quaternion.copy(quaternion).normalize();

  let changed = false;
  if (isPerspective(view)) {
    if (view.aspect !== options.aspect && options.aspect > 0) {
      view.aspect = options.aspect;
      changed = true;
    }
    const own = isPerspective(source) ? source : undefined;
    const fov = options.fov ?? (own ? THREE.MathUtils.degToRad(own.fov) : undefined);
    if (fov !== undefined && fov > 0 && fov < Math.PI) {
      // A camera with no shape of its own is given 1 by the loader: only a
      // scene taller than it is wide is "narrower" than that.
      const fitted = fittedFov(fov, own ? own.aspect : 0, options.aspect);
      if (Math.abs(view.fov - fitted) > 1e-9) {
        view.fov = fitted;
        changed = true;
      }
    }
  }
  const own = source as Lens;
  const along = sightScale(source);
  const near = options.near ?? (own.near > 0 ? own.near * along : undefined);
  const far = options.far ?? (own.far > 0 && own.far < NO_FAR ? own.far * along : options.sceneFar);
  if (near !== undefined && near > 0 && view.near !== near) {
    view.near = near;
    changed = true;
  }
  if (far !== undefined && far > view.near && view.far !== far) {
    view.far = far;
    changed = true;
  }
  if (changed) view.updateProjectionMatrix();
  view.updateMatrixWorld();
  return true;
}
