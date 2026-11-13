/**
 * Which way an object faces.
 *
 * An object's `rotation` is three angles applied in one fixed order, and
 * that was all there was. To lay a capsule along a direction, or to turn a
 * figure toward a point, a game carried its own quaternion arithmetic and
 * converted the answer back into three angles, every tick, for every part.
 *
 * An object can now say what it means: `lookAt` (a point its front faces),
 * `align` (a direction its long axis lies along), and `rotationOrder` for the
 * angles themselves. Everything here answers in a quaternion, built with
 * three's own arithmetic, so what an object is told is what
 * `Object3D.lookAt` and `Quaternion.setFromUnitVectors` would have made.
 */

import * as THREE from 'three';

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** What of an object says which way it faces. */
export interface Facing {
  position?: Vec3;
  rotation?: Vec3;
  rotationOrder?: string;
  lookAt?: Vec3;
  align?: Vec3;
}

const ORDERS: ReadonlySet<string> = new Set(['XYZ', 'YXZ', 'ZXY', 'ZYX', 'YZX', 'XZY']);

/** `order` as three reads one; 'XYZ', which is what it always was, for anything else. */
export function rotationOrderOf(order: unknown): THREE.EulerOrder {
  return typeof order === 'string' && ORDERS.has(order) ? (order as THREE.EulerOrder) : 'XYZ';
}

const isVec = (v: unknown): v is Vec3 => {
  if (!v || typeof v !== 'object') return false;
  const p = v as Vec3;
  return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
};

const UP = new THREE.Vector3(0, 1, 0);
const eye = new THREE.Vector3();
const target = new THREE.Vector3();
const direction = new THREE.Vector3();
const matrix = new THREE.Matrix4();
const turn = new THREE.Quaternion();
const angles = new THREE.Euler();

/**
 * Whether `spec` points the object with `lookAt` or `align`, and so its
 * direction is a quaternion and not three angles. `lookAt` wins when both
 * are given; a point the object already stands on, or a direction of no
 * length, points nowhere and is not counted.
 */
export function pointsSomewhere(spec: Facing): boolean {
  if (isVec(spec.lookAt)) {
    const p = spec.position;
    if (spec.lookAt.x !== (p?.x ?? 0) || spec.lookAt.y !== (p?.y ?? 0) || spec.lookAt.z !== (p?.z ?? 0)) return true;
  }
  return isVec(spec.align) && (spec.align.x !== 0 || spec.align.y !== 0 || spec.align.z !== 0);
}

/**
 * The orientation `spec` asks for, written into `out`.
 *
 * - `lookAt`: the object's front (its +z, three's convention for anything
 *   that is not a camera) faces the point, its top as near to up as that
 *   allows. The point is in the same space as `position`: the world for a
 *   top-level object, the group for a group's child.
 * - `align`: the object's long axis (its +y: the axis a cylinder, a capsule
 *   or a cone stands along) lies along the direction, by the shortest turn
 *   from upright.
 * - `rotation`, in `rotationOrder`: the object's own turn. With `lookAt` or
 *   `align` it is applied first, in the object's own axes: a roll about the
 *   axis that was aligned, or the quarter turn a model needs whose front is
 *   not its +z.
 */
export function orientationOf(spec: Facing, out: THREE.Quaternion): THREE.Quaternion {
  const r = spec.rotation;
  angles.set(r?.x ?? 0, r?.y ?? 0, r?.z ?? 0, rotationOrderOf(spec.rotationOrder));
  out.setFromEuler(angles);
  if (!pointsSomewhere(spec)) return out;

  const p = spec.position;
  if (isVec(spec.lookAt) && (spec.lookAt.x !== (p?.x ?? 0) || spec.lookAt.y !== (p?.y ?? 0) || spec.lookAt.z !== (p?.z ?? 0))) {
    // As Object3D.lookAt does for an object that is not a camera.
    eye.set(spec.lookAt.x, spec.lookAt.y, spec.lookAt.z);
    target.set(p?.x ?? 0, p?.y ?? 0, p?.z ?? 0);
    matrix.lookAt(eye, target, UP);
    turn.setFromRotationMatrix(matrix);
  } else {
    const a = spec.align as Vec3;
    direction.set(a.x, a.y, a.z).normalize();
    turn.setFromUnitVectors(UP, direction);
  }
  return out.premultiply(turn);
}

/** Whether two orientations are the same turn (a quaternion and its negative are). */
export function sameOrientation(a: THREE.Quaternion, b: THREE.Quaternion): boolean {
  return Math.abs(a.dot(b)) > 1 - 1e-12;
}
