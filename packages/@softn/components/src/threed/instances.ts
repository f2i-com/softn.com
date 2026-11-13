/**
 * Where each copy of an instanced object stands, and how it is turned and
 * sized.
 *
 * A copy was a position and nothing else, so copies that differ in size or
 * in direction were separate batches: one batch of grass for each stage of
 * growth, one batch of rails running north and another running east, and a
 * crowd of walkers could not be instanced at all. Two optional flat arrays
 * now sit beside `instances`, each a number array like it, the cheapest
 * thing that crosses from an app's logic:
 *
 * - `instanceRotations`: one number a copy is a turn about the upright (y)
 *   axis, in radians; three numbers a copy are its turns about x, y and z.
 * - `instanceScales`: one number a copy is its size in every direction;
 *   three numbers a copy are its sizes along x, y and z.
 *
 * Which it is goes by the array's length: three times the number of copies
 * or more is three numbers each, anything shorter is one each. A copy the
 * array does not reach is not turned, and is its full size.
 */

import * as THREE from 'three';

const matrix = new THREE.Matrix4();
const position = new THREE.Vector3();
const quaternion = new THREE.Quaternion();
const scale = new THREE.Vector3();
const angles = new THREE.Euler();
const UPRIGHT = new THREE.Vector3(0, 1, 0);

/** How many numbers of `values` describe one copy: 0 for none given, 1 or 3. */
export function numbersPerCopy(values: unknown, count: number): 0 | 1 | 3 {
  if (!Array.isArray(values) || values.length === 0 || count <= 0) return 0;
  return values.length >= count * 3 ? 3 : 1;
}

const numberAt = (values: number[], index: number, fallback: number): number => {
  const value = values[index];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

/**
 * Write the matrix of each of `count` copies into `mesh`. `data` is the
 * `instances` array, `stride` numbers a copy with x, y, z first.
 */
export function placeInstances(
  mesh: THREE.InstancedMesh,
  data: number[],
  stride: number,
  count: number,
  rotations: number[] | undefined,
  scales: number[] | undefined
): void {
  const turns = numbersPerCopy(rotations, count);
  const sizes = numbersPerCopy(scales, count);
  if (turns === 0 && sizes === 0) {
    // Most batches: a position each, and a matrix that is only that.
    for (let i = 0; i < count; i++) {
      const o = i * stride;
      matrix.makeTranslation(data[o] ?? 0, data[o + 1] ?? 0, data[o + 2] ?? 0);
      mesh.setMatrixAt(i, matrix);
    }
    return;
  }
  const r = rotations as number[];
  const s = scales as number[];
  for (let i = 0; i < count; i++) {
    const o = i * stride;
    position.set(data[o] ?? 0, data[o + 1] ?? 0, data[o + 2] ?? 0);
    if (turns === 3) {
      angles.set(numberAt(r, i * 3, 0), numberAt(r, i * 3 + 1, 0), numberAt(r, i * 3 + 2, 0));
      quaternion.setFromEuler(angles);
    } else if (turns === 1) {
      quaternion.setFromAxisAngle(UPRIGHT, numberAt(r, i, 0));
    } else {
      quaternion.identity();
    }
    if (sizes === 3) scale.set(numberAt(s, i * 3, 1), numberAt(s, i * 3 + 1, 1), numberAt(s, i * 3 + 2, 1));
    else if (sizes === 1) scale.setScalar(numberAt(s, i, 1));
    else scale.set(1, 1, 1);
    matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(i, matrix);
  }
}
