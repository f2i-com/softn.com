/**
 * What is in a model, and how big it is.
 *
 * `appearance.colors` wants material names, `animation.clip` clip names,
 * `appearance.morphs` morph names, and a model arrives at whatever size its
 * author worked in: a figure in centimetres is a hundred units tall. None of
 * that could be learned from the scene, so an author opened the file in
 * another program and guessed a `scale`. The scene now says what it loaded,
 * and `fit` scales a model to a stated size.
 *
 * Read once per template (model-cache.ts), not per instance: a hundred crates
 * are one file, and the bounds below visit every vertex.
 */

import * as THREE from 'three';
import { filmForReport, readFilmRecord, type FilmRecord } from './film-record';
import { MAX_NAME_LENGTH, modelCameras, modelLights } from './model-camera';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * A model's contents, as the "loaded" state reports them. Each list is of
 * names an author can use: at most 256 of a kind, and none longer than 200
 * characters (a thing with a longer name is still in the model; it is only
 * not listed).
 */
export interface ModelContents {
  clips: string[];
  materials: string[];
  meshes: string[];
  morphs: string[];
  /** The names of the model's nodes, for `parts`: the things its author named, not the pieces a loader cut a mesh into. */
  nodes: string[];
  /** How long each clip of `clips` is, in seconds from its first key to its last: the same order, the same number of them. */
  clipLengths: number[];
  /** The names of the model's cameras, for `camera.name`. */
  cameras: string[];
  /** The names of the model's lights. */
  lights: string[];
  /**
   * What the file says of itself as a film (film-record.ts), when it says
   * anything: which camera from when, a lens that changes, what is in
   * focus. Here whole, for the scene; a bounded copy goes to the app.
   */
  film?: FilmRecord;
  size: Vec3;
  center: Vec3;
}

const firstKeys = new WeakMap<THREE.AnimationClip, number>();

/** The second of a clip's first key, in its own seconds: 0 for a clip with no keys. */
export function firstKeyOf(clip: THREE.AnimationClip): number {
  let first = firstKeys.get(clip);
  if (first === undefined) {
    first = Infinity;
    for (const track of clip.tracks) {
      const at = track.times[0];
      if (typeof at === 'number' && at < first) first = at;
    }
    if (!Number.isFinite(first)) first = 0;
    firstKeys.set(clip, first);
  }
  return first;
}

/** The most names of one kind reported: a list is for reading, and it crosses into the app's logic. */
const MAX_NAMES = 256;

// A node the file left unnamed is named by its uuid when it is loaded
// (model-loaders.ts), so a clip can find it on a clone. That name is new on
// every page load and no use to an author.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Nor is a name longer than an author will type (MAX_NAME_LENGTH): every
// list here crosses into the app's logic, and a file may name a thing with
// a hundred thousand characters.
const isNamed = (name: unknown): name is string =>
  typeof name === 'string' && name !== '' && name.length <= MAX_NAME_LENGTH && !UUID.test(name);

function add(names: Set<string>, name: unknown): void {
  if (isNamed(name) && names.size < MAX_NAMES) names.add(name);
}

/**
 * The names an author can address in `root`, and its bounds as the file gives
 * them: before the object's own position, rotation, scale or `fit`. `root`
 * must not be in a scene (its parents' transforms would be counted).
 *
 * `pieces` are the objects under `root` that are no node of the file (the
 * meshes a loader cut one mesh of several materials into): they are left out
 * of `nodes`, which is for moving the parts an author named. So is `root`
 * itself, which is the object in the scene and is moved as one.
 */
export function describeModel(
  root: THREE.Object3D,
  animations: readonly THREE.AnimationClip[],
  pieces?: ReadonlySet<THREE.Object3D>
): ModelContents {
  // Each clip's name with its length: the first of a name, as `animation.clip` finds it.
  const clips = new Map<string, number>();
  const materials = new Set<string>();
  const meshes = new Set<string>();
  const morphs = new Set<string>();
  const nodes = new Set<string>();
  for (const clip of animations) {
    if (!clip || !isNamed(clip.name) || clips.has(clip.name) || clips.size >= MAX_NAMES) continue;
    clips.set(clip.name, finite(clip.duration - firstKeyOf(clip)));
  }
  root.traverse((node) => {
    if (node !== root && !pieces?.has(node)) add(nodes, node.name);
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    // A mesh of several materials is loaded as a group named after it, with
    // one mesh for each: the group's name hides them all (`hiddenMeshes`).
    const parent = node.parent;
    if (
      parent &&
      node !== root &&
      parent !== root &&
      (parent as THREE.Group).isGroup &&
      parent.children.every((child) => (child as THREE.Mesh).isMesh)
    ) {
      add(meshes, parent.name);
    }
    add(meshes, node.name);
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) add(materials, material?.name);
    if (mesh.morphTargetDictionary) for (const name of Object.keys(mesh.morphTargetDictionary)) add(morphs, name);
  });

  // Every vertex where it is drawn: a skinned mesh by its bones, which have
  // no world matrix until something asks for one.
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root, true);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  if (!box.isEmpty()) {
    box.getSize(size);
    box.getCenter(center);
  }
  const plain = (v: THREE.Vector3): Vec3 => ({ x: finite(v.x), y: finite(v.y), z: finite(v.z) });
  const contents: ModelContents = {
    clips: [...clips.keys()],
    materials: [...materials],
    meshes: [...meshes],
    morphs: [...morphs],
    nodes: [...nodes],
    clipLengths: [...clips.values()],
    cameras: [...modelCameras(root).keys()],
    lights: [...modelLights(root).keys()],
    size: plain(size),
    center: plain(center),
  };
  // A glTF's own notes about its scene are on its top node: the record a
  // film was exported with is among them, and nothing in it is trusted.
  const film = readFilmRecord((root.userData as { softn?: unknown } | undefined)?.softn);
  if (film) contents.film = film;
  return contents;
}

// To a millionth of a unit: vertices are 32-bit, and a model four units tall
// should not be reported as 4.0000000015.
const finite = (n: number): number => (Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : 0);

/**
 * `describeModel`, for a caller that must not fail on it: a model the reading
 * cannot get through is still a model to show, with nothing said about it.
 */
export function describeModelSafely(
  root: THREE.Object3D,
  animations: readonly THREE.AnimationClip[],
  pieces?: ReadonlySet<THREE.Object3D>
): ModelContents {
  try {
    return describeModel(root, animations, pieces);
  } catch (err) {
    console.warn('[Scene3D] Could not read what a model holds:', err);
    return {
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
    };
  }
}

/**
 * A copy of a model's contents to hand to the app: what was read is kept
 * with the template and shared by every instance of it, and is not the
 * app's to change.
 */
export function copyContents(contents: ModelContents): ModelContents {
  const copy: ModelContents = {
    clips: [...contents.clips],
    materials: [...contents.materials],
    meshes: [...contents.meshes],
    morphs: [...contents.morphs],
    nodes: [...contents.nodes],
    clipLengths: [...contents.clipLengths],
    cameras: [...contents.cameras],
    lights: [...contents.lights],
    size: { ...contents.size },
    center: { ...contents.center },
  };
  // Of a size that does not grow with the file: this crosses into the app's logic.
  if (contents.film) copy.film = filmForReport(contents.film);
  return copy;
}

/** Whether `fit` asks for anything: a length above zero. */
export function wantsFit(fit: unknown): fit is number {
  return typeof fit === 'number' && Number.isFinite(fit) && fit > 0;
}

interface OwnTransform {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
}

const OWN_TRANSFORM = '__softnOwnTransform';

/**
 * Keep the transform the file gave a model's root, before anything is
 * written over it, so it can be put back. Idempotent: the first call is the
 * one that counts.
 */
export function rememberOwnTransform(model: THREE.Object3D): void {
  if (model.userData[OWN_TRANSFORM]) return;
  const own: OwnTransform = {
    position: model.position.clone(),
    quaternion: model.quaternion.clone(),
    scale: model.scale.clone(),
  };
  model.userData[OWN_TRANSFORM] = own;
}

/** Put a model's root back as its file had it. */
export function restoreOwnTransform(model: THREE.Object3D): void {
  rememberOwnTransform(model);
  const own = model.userData[OWN_TRANSFORM] as OwnTransform;
  model.position.copy(own.position);
  model.quaternion.copy(own.quaternion);
  model.scale.copy(own.scale);
}

/**
 * Scale and place a model within the holder it stands in, so its longest
 * side is `fit` long, its middle is over the holder's origin and its lowest
 * point is on the holder's ground (y = 0). With no `fit`, or a model with
 * nothing in it to measure, the model is as its file had it.
 *
 * The holder carries the object's own position, rotation and scale, so those
 * are applied after the fit: `fit: 2, scale: 1.5` is three units long.
 */
export function fitModel(model: THREE.Object3D, contents: ModelContents | undefined, fit: unknown): void {
  restoreOwnTransform(model);
  if (!contents || !wantsFit(fit)) return;
  const { size, center } = contents;
  const longest = Math.max(size.x, size.y, size.z);
  if (!(longest > 0)) return;
  const s = fit / longest;
  // The bounds were measured with the root's own transform applied, so the
  // fit goes outside it: scale about the origin, then move.
  model.position.multiplyScalar(s);
  model.position.x -= center.x * s;
  model.position.y -= (center.y - size.y / 2) * s;
  model.position.z -= center.z * s;
  model.scale.multiplyScalar(s);
}
