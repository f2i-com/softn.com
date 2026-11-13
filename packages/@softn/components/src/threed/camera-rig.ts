/**
 * The camera: which kind it is, what it follows, and how far the person may
 * orbit it.
 *
 * A chase camera was trigonometry in a game's logic, worked out thirty times
 * a second and drawn at sixty, so it shook. The near and far planes were
 * fixed whatever the app passed, there was one kind of camera, the person
 * could orbit under the floor and zoom through a wall, and the app never
 * learned where they had orbited to. What is here is the arithmetic for each
 * of those; the scene (Scene3D.tsx) decides when to use it.
 */

import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export type SceneCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;

/** The numbers a camera's picture is made from. */
export interface CameraShape {
  /** A perspective camera's field of view, top to bottom, in degrees. */
  fov: number;
  near: number;
  far: number;
  /** An orthographic camera's view, top to bottom, in scene units. */
  size: number;
}

export const DEFAULT_CAMERA_SHAPE: Readonly<CameraShape> = { fov: 60, near: 0.1, far: 1000, size: 10 };

const isOrthographic = (cam: THREE.Camera): cam is THREE.OrthographicCamera =>
  (cam as THREE.OrthographicCamera).isOrthographicCamera === true;

/** A number above zero, or undefined: a camera has no use for any other. */
export function aboveZero(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Write a camera's shape into it, for a view `width` by `height` pixels. */
export function shapeCamera(cam: SceneCamera, shape: CameraShape, width: number, height: number): void {
  const aspect = width > 0 && height > 0 ? width / height : 1;
  if (isOrthographic(cam)) {
    const halfHeight = shape.size / 2;
    cam.left = -halfHeight * aspect;
    cam.right = halfHeight * aspect;
    cam.top = halfHeight;
    cam.bottom = -halfHeight;
  } else {
    cam.fov = shape.fov;
    cam.aspect = aspect;
  }
  cam.near = shape.near;
  // A far plane at or before the near one is no picture at all.
  cam.far = shape.far > shape.near ? shape.far : shape.near + 1;
  cam.updateProjectionMatrix();
}

/** A camera of the kind asked for. */
export function createCamera(orthographic: boolean, shape: CameraShape, width: number, height: number): SceneCamera {
  const cam = orthographic ? new THREE.OrthographicCamera() : new THREE.PerspectiveCamera();
  shapeCamera(cam, shape, width, height);
  return cam;
}

/** What `camera.follow` gives, as it is read here. */
export interface FollowSpec {
  target?: unknown;
  distance?: number;
  height?: number;
  lookAhead?: number;
}

/** What following remembers between frames. */
export interface FollowState {
  /** Whether the frame before this one was following too. */
  held: boolean;
  /** Where the target was drawn in that frame. */
  at: THREE.Vector3;
  /** The way it was heading: kept for a frame in which it points straight up or down. */
  forward: THREE.Vector3;
}

export function createFollowState(): FollowState {
  return { held: false, at: new THREE.Vector3(), forward: new THREE.Vector3(0, 0, 1) };
}

const finiteOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const at = new THREE.Vector3();
const heading = new THREE.Vector3();

/**
 * Where a camera following `node` should stand and what it should look at,
 * from where the node is drawn now: `distance` behind it (its front is its
 * +z, turned as the node is turned, flat on the ground), `height` above it,
 * looking at the point `lookAhead` in front of it. Answers how far the node
 * has moved since the frame before, or -1 when that frame was not following.
 */
export function followGoal(
  node: THREE.Object3D,
  follow: FollowSpec,
  state: FollowState,
  outPosition: THREE.Vector3,
  outLook: THREE.Vector3
): number {
  node.updateWorldMatrix(true, false);
  at.setFromMatrixPosition(node.matrixWorld);
  // An object whose place is not a number (logic divided by nothing) is nowhere to stand behind.
  // The camera waits where it was going: eased toward such a place it was itself nowhere from
  // then on, whatever the object did after.
  if (!Number.isFinite(at.x) || !Number.isFinite(at.y) || !Number.isFinite(at.z)) return state.held ? 0 : -1;
  heading.set(0, 0, 1).transformDirection(node.matrixWorld);
  heading.y = 0;
  if (heading.lengthSq() > 1e-8) state.forward.copy(heading.normalize());
  const forward = state.forward;
  const distance = finiteOr(follow.distance, 6);
  const height = finiteOr(follow.height, 3);
  const lookAhead = finiteOr(follow.lookAhead, 0);
  outPosition.set(at.x - forward.x * distance, at.y + height, at.z - forward.z * distance);
  outLook.set(at.x + forward.x * lookAhead, at.y, at.z + forward.z * lookAhead);
  const moved = state.held ? at.distanceTo(state.at) : -1;
  state.at.copy(at);
  state.held = true;
  return moved;
}

/** What `orbit` gives, as it is read here. */
export interface OrbitLimits {
  minDistance?: number;
  maxDistance?: number;
  minPolar?: number;
  maxPolar?: number;
  pan?: boolean;
  zoom?: boolean;
}

/**
 * Write the limits into orbit controls. A limit not given is the controls'
 * own: any distance, any angle from straight above to straight below, and
 * panning and zooming both allowed.
 */
export function applyOrbitLimits(controls: OrbitControls, limits: OrbitLimits | undefined): void {
  const least = Math.max(0, finiteOr(limits?.minDistance, 0));
  const most = finiteOr(limits?.maxDistance, Infinity);
  controls.minDistance = least;
  controls.maxDistance = most >= least ? most : least;
  const steepest = Math.min(Math.PI, Math.max(0, finiteOr(limits?.minPolar, 0)));
  const flattest = Math.min(Math.PI, Math.max(0, finiteOr(limits?.maxPolar, Math.PI)));
  controls.minPolarAngle = steepest;
  controls.maxPolarAngle = flattest >= steepest ? flattest : steepest;
  controls.enablePan = limits?.pan !== false;
  controls.enableZoom = limits?.zoom !== false;
}

/** Where a camera is and what it looks at, as plain numbers for the app. */
export function describeCamera(
  cam: SceneCamera,
  target: { x: number; y: number; z: number }
): { position: { x: number; y: number; z: number }; target: { x: number; y: number; z: number }; size?: number } {
  const info: ReturnType<typeof describeCamera> = {
    position: { x: cam.position.x, y: cam.position.y, z: cam.position.z },
    target: { x: target.x, y: target.y, z: target.z },
  };
  // An orthographic camera is zoomed by its size, not by coming closer: the
  // size it shows now is what brings the same view back.
  if (isOrthographic(cam)) info.size = (cam.top - cam.bottom) / (cam.zoom > 0 ? cam.zoom : 1);
  return info;
}
