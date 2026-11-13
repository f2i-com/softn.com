/**
 * What a ray is tested against.
 *
 * The scene used to hand every object to the raycaster and take the first
 * thing it hit, and two things went wrong. A cloud of particles is tested by
 * three with a radius of one whole unit around each point, whatever size the
 * points are drawn, so decorative smoke took the click meant for the door
 * behind it. And nothing could be left out: a ground plane, a glass wall or
 * a marker took every click that passed through it.
 *
 * Each object now says whether it is picked (`pickable`), and particles are
 * not unless they say so; a cloud that asks is tested at the size its points
 * are drawn.
 */

import type * as THREE from 'three';

/** Set on a node by the scene: the object's own `pickable`, when it gave one. */
export const PICKABLE_KEY = '__softnPickable';
/** Set on every node that is an object of the scene (as against a node inside a loaded model). */
export const ID_KEY = '__softnId';

export interface PickTargets {
  /** Everything but particles, flattened: tested one by one, not recursively. */
  solid: THREE.Object3D[];
  /** Particle clouds that asked to be picked. */
  clouds: THREE.Points[];
}

function collect(node: THREE.Object3D, inherited: boolean | undefined, out: PickTargets): void {
  // What is not drawn is not there to be clicked, nor is anything under it:
  // a mesh hidden by `appearance.hiddenMeshes` went on taking the clicks
  // meant for what could be seen behind it, since a ray is tested against a
  // node whether or not it is visible.
  if (!node.visible) return;
  // A node inside a loaded model answers as the model does; an object of the
  // scene answers for itself.
  const own = typeof node.userData[ID_KEY] === 'string';
  const flag = own ? (node.userData[PICKABLE_KEY] as boolean | undefined) : inherited;
  if (flag === false) return;
  if ((node as THREE.Points).isPoints) {
    if (flag === true) out.clouds.push(node as THREE.Points);
  } else {
    out.solid.push(node);
  }
  for (const child of node.children) collect(child, flag, out);
}

/** The nodes under `roots` a ray may hit: nothing under an object that said `pickable: false`. */
export function pickTargets(roots: Iterable<THREE.Object3D>): PickTargets {
  const out: PickTargets = { solid: [], clouds: [] };
  for (const root of roots) collect(root, undefined, out);
  return out;
}

/** Half the size a cloud's points are drawn at, in world units; never nothing. */
function pointRadius(cloud: THREE.Points): number {
  const material = (Array.isArray(cloud.material) ? cloud.material[0] : cloud.material) as THREE.PointsMaterial | undefined;
  const size = typeof material?.size === 'number' && Number.isFinite(material.size) ? material.size : 1;
  return Math.max(size / 2, 0.01);
}

/** The nearest thing under `roots` the raycaster's ray hits, or null. */
export function nearestHit(raycaster: THREE.Raycaster, roots: Iterable<THREE.Object3D>): THREE.Intersection | null {
  const { solid, clouds } = pickTargets(roots);
  const hits = raycaster.intersectObjects(solid, false);
  if (clouds.length > 0) {
    const params = raycaster.params.Points;
    const before = params.threshold;
    for (const cloud of clouds) {
      params.threshold = pointRadius(cloud);
      raycaster.intersectObject(cloud, false, hits);
    }
    params.threshold = before;
    hits.sort((a, b) => a.distance - b.distance);
  }
  return hits[0] ?? null;
}
