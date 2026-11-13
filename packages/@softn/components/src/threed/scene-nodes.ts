/**
 * The node an object of the scene is drawn as, found by the object's id.
 *
 * A camera that follows an object and a piece of the page pinned to one both
 * name it by id, and both ask where it is on every frame. A top-level object
 * is one map lookup. A group's child is found by walking the groups, which
 * is done once for each id after the scene's objects change and remembered
 * until they change again, whether it was found or not: a name that matches
 * nothing must not cost a walk a frame.
 */

import type * as THREE from 'three';

const GROUP_KEY = '__softnGroup';
const ID_KEY = '__softnId';

/** The most ids remembered between changes: an id that is new every tick would otherwise pile up. */
const MAX_REMEMBERED = 256;

export class SceneNodes {
  private readonly remembered = new Map<string, THREE.Object3D | null>();

  constructor(
    /** The node of a top-level object. */
    private readonly topLevel: (id: string) => THREE.Object3D | undefined,
    /** The nodes of every top-level object. */
    private readonly roots: () => Iterable<THREE.Object3D>
  ) {}

  /** The scene's objects changed: what was found before is looked for afresh. */
  changed(): void {
    this.remembered.clear();
  }

  /** The node drawn for the object `id`, at the top level or in a group; null when there is none. */
  find(id: string): THREE.Object3D | null {
    const top = this.topLevel(id);
    if (top) return top;
    const known = this.remembered.get(id);
    if (known !== undefined) return known;
    let found: THREE.Object3D | null = null;
    const walk = (group: THREE.Object3D): void => {
      for (const child of group.children) {
        if (found) return;
        if (child.userData[ID_KEY] === id) {
          found = child;
          return;
        }
        if (child.userData[GROUP_KEY]) walk(child);
      }
    };
    for (const root of this.roots()) {
      if (found) break;
      if (root.userData[GROUP_KEY]) walk(root);
    }
    if (this.remembered.size >= MAX_REMEMBERED) this.remembered.clear();
    this.remembered.set(id, found);
    return found;
  }
}
