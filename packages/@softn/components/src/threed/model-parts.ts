/**
 * The named parts of a model, moved from the app's logic.
 *
 * A vehicle or a figure made in another program is one file of named nodes:
 * four wheels, a turret, a hatch. Logic could not reach any of them, so a
 * rover whose wheels turn was shipped as seven files and put together as a
 * group. An object of `type: 'model'` now takes `parts`, a record from a
 * node's name to what is done to it:
 *
 *   parts: { Wheel_FL: { rotation: { x: 1.2, y: 0, z: 0 } }, Hatch: { visible: false } }
 *
 * What a part is given is measured from the pose its file gives it, its rest
 * pose: `rotation` is a turn on top of it, about the node's own axes, so a
 * wheel rolls about its own axle whichever way it was modelled; `position`
 * is added to its place among its siblings; `scale` multiplies its size. A
 * part that is no longer named, or a field that is no longer given, goes
 * back to rest.
 *
 * The rest pose is read from the model's template (model-cache.ts), which is
 * the file as it was loaded and is never written to: a node an animation has
 * been moving is not at rest by the time logic first names it, and its twin
 * in the template is.
 *
 * Who writes a node. A clip that is playing writes the nodes it moves on
 * every frame, and this is run after it: where `parts` gives a node its
 * rotation, its position or its scale, that is what the node has, and
 * whatever of the three it does not give is the clip's. `visible` likewise
 * has the last word over `appearance.hiddenMeshes`. A part that lets go of a
 * node gives it back as it would be without the part: the pose its file
 * gives it, unless a clip is moving that property of it at that moment, and
 * then the clip's pose (a clip that is held writes a pose once and not
 * again, so what it wrote is kept while the part is over it).
 *
 * What three's mixer remembers is not relied on for either. When a clip
 * starts, the mixer keeps each node's pose as it then stands, to put back
 * when the clip stops; started while a part held the node, that was the
 * part's pose, and it was put back long after the part had let go. So the
 * model's animation is changed with the parts lifted off (`atRest`): the
 * pose the mixer keeps is then the file's. And whether a clip is moving a
 * node is asked (`drives`), not guessed from what was last found written
 * there.
 *
 * What it costs. Names are found once for each model instance, the first
 * time `parts` is used on it. A tick that hands over the same parts again
 * compares numbers and writes nothing. A part that changes is a handful of
 * assignments. On a frame, each part in use is compared with what its node
 * holds (something else may have written it) and written only if it
 * differs. Nothing is allocated after a part's first use.
 */

import * as THREE from 'three';
import { shownByAppearance } from './model-appearance';

/** What is done to one named part of a model. */
export interface Scene3DPart {
  /** A turn on top of the pose the file gives the part, about its own x, y and z, in radians, applied in that order. */
  rotation?: { x: number; y: number; z: number };
  /** How far the part is moved from where the file puts it, in the units and directions of what it hangs from. */
  position?: { x: number; y: number; z: number };
  /** A multiple of the size the file gives the part: one number, or one for each of x, y and z. */
  scale?: number | { x: number; y: number; z: number };
  /** Show or hide the part and everything that hangs from it. Left out, it is as the file and `appearance` have it. */
  visible?: boolean;
}

/** The most parts of one model that are moved: a record handed over on every tick is read on every tick. */
const MAX_PARTS = 256;

/** How many names one model remembers the answer for, found or not. */
const MAX_NAMES_KEPT = 1024;

/** How many "no such part" warnings are remembered across the page. */
const MAX_WARNED = 512;
const warned = new Set<string>();

interface Channel<T> {
  /** Whether the part gives this now, and the numbers it gave. */
  given: boolean;
  a: number;
  b: number;
  c: number;
  /** Whether this property of the node is being written here: from when it is first given until it is back at rest. */
  held: boolean;
  /** Where it is now, between `from` and `to` while it is eased. */
  now: T;
  from: T;
  to: T;
  easing: boolean;
  t: number;
  ms: number;
  /** What the node is to hold: the rest pose with `now` applied. Worked out again when `now` changes. */
  out: T;
  stale: boolean;
  /**
   * What the node held of this when it was last found holding something
   * this did not write: its own pose before the part took it, or what a
   * clip has written there since. Given back when the part lets go.
   */
  under: T;
  /** What this last wrote into the node, to tell its own writing from another's; `hasWrote` once it has written. */
  wrote: T;
  hasWrote: boolean;
}

interface Part {
  node: THREE.Object3D;
  /** The call to `set` that last named it. */
  seen: number;
  /** Its place among the parts in use, or -1. */
  at: number;
  restPosition: THREE.Vector3;
  restQuaternion: THREE.Quaternion;
  restScale: THREE.Vector3;
  restVisible: boolean;
  turn: Channel<THREE.Quaternion>;
  move: Channel<THREE.Vector3>;
  size: Channel<THREE.Vector3>;
  /** `visible` as given, or undefined when it is not. */
  shows: boolean | undefined;
}

const angles = new THREE.Euler();
const turned = new THREE.Quaternion();
const path: number[] = [];

const finite = (value: unknown, otherwise: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : otherwise;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Whether `parts` names anything: a record with at least one name in it. */
export function namesParts(parts: unknown): boolean {
  if (!isRecord(parts)) return false;
  for (const name in parts) if (Object.prototype.hasOwnProperty.call(parts, name)) return true;
  return false;
}

function channel<T>(make: () => T): Channel<T> {
  return {
    given: false,
    a: 0,
    b: 0,
    c: 0,
    held: false,
    now: make(),
    from: make(),
    to: make(),
    easing: false,
    t: 0,
    ms: 0,
    out: make(),
    stale: false,
    under: make(),
    wrote: make(),
    hasWrote: false,
  };
}

export interface ModelPartsOptions {
  /**
   * The model as its file has it, node for node the same shape as the
   * instance: where each part's rest pose is read. Without one, a part's
   * rest pose is how its node stands when it is first named.
   */
  rest?: THREE.Object3D;
  /** The object's id, for a warning to name. */
  id?: string;
  /** What the model was loaded from: a name it has no node for is warned of once for the file, not once for each object showing it. */
  file?: string;
  /**
   * Whether a clip of the model is moving this property of this node now:
   * one that is playing or held, not one that has stopped. A part that lets
   * go of the property gives it back to such a clip, and to the file's pose
   * otherwise. Left out, no clip is taken to be moving anything.
   */
  drives?: (node: THREE.Object3D, property: PartProperty) => boolean;
}

/** The three things of a node a part may give: where it is, how it is turned, how big it is. */
export type PartProperty = 'position' | 'quaternion' | 'scale';

/** The parts of one instance of a model. */
export class ModelParts {
  /** Every named node under the root, by its name; made when a part is first asked for. */
  private nodes: Map<string, THREE.Object3D> | null = null;
  /** Each name asked for, with its part; null for a name the model has no node for. */
  private readonly byName = new Map<string, Part | null>();
  /** The part of each node that has one, whichever spelling of its name it was asked for by. */
  private readonly byNode = new Map<THREE.Object3D, Part>();
  /** The parts in use: those with anything held or shown. */
  private readonly inUse: Part[] = [];
  private calls = 0;
  private tooMany = false;

  constructor(
    private readonly root: THREE.Object3D,
    private readonly options: ModelPartsOptions = {}
  ) {}

  /** Whether any part is being moved, shown or hidden. */
  get active(): boolean {
    return this.inUse.length > 0;
  }

  /**
   * What the object's `parts` say now. A part whose numbers are what they
   * were is not touched; one that changed is taken there over `ms`
   * milliseconds, or at once with none; one no longer named goes back to
   * rest the same way.
   */
  set(parts: unknown, ms = 0): void {
    const seen = ++this.calls;
    if (isRecord(parts)) {
      let count = 0;
      for (const name in parts) {
        if (!Object.prototype.hasOwnProperty.call(parts, name)) continue;
        if (++count > MAX_PARTS) {
          if (!this.tooMany) {
            this.tooMany = true;
            console.warn(`[Scene3D] Model "${this.options.id ?? ''}" names more than ${MAX_PARTS} parts; the rest are left as they are.`);
          }
          break;
        }
        const part = this.partOf(name);
        if (!part) continue;
        part.seen = seen;
        this.give(part, parts[name], ms);
      }
    }
    // What was named before and is not now goes back to rest.
    for (let i = this.inUse.length - 1; i >= 0; i--) {
      const part = this.inUse[i];
      if (part.seen !== seen) this.give(part, undefined, ms);
    }
    this.frame(0);
  }

  /**
   * One frame, `elapsedMs` since the last: what is being eased goes on its
   * way, and every part in use is what `parts` says, whatever else wrote
   * its node since (a clip, `appearance`).
   */
  frame(elapsedMs: number): void {
    for (let i = this.inUse.length - 1; i >= 0; i--) {
      const part = this.inUse[i];
      const node = part.node;

      const turn = part.turn;
      if (turn.held) {
        if (turn.easing) {
          turn.t += elapsedMs;
          if (turn.t >= turn.ms) {
            turn.now.copy(turn.to);
            turn.easing = false;
          } else {
            // The short way round, as an object's own turn is eased.
            turn.now.slerpQuaternions(turn.from, turn.to, turn.t / turn.ms);
          }
          turn.stale = true;
        }
        if (turn.stale) {
          turn.out.multiplyQuaternions(part.restQuaternion, turn.now);
          turn.stale = false;
        }
        if (!turn.hasWrote || !node.quaternion.equals(turn.wrote)) turn.under.copy(node.quaternion);
        if (!node.quaternion.equals(turn.out)) node.quaternion.copy(turn.out);
        turn.wrote.copy(turn.out);
        turn.hasWrote = true;
        if (!turn.easing && !turn.given) {
          turn.held = false;
          turn.hasWrote = false;
          node.quaternion.copy(this.driven(node, 'quaternion') ? turn.under : part.restQuaternion);
        }
      }

      const move = part.move;
      if (move.held) {
        if (move.easing) {
          move.t += elapsedMs;
          if (move.t >= move.ms) {
            move.now.copy(move.to);
            move.easing = false;
          } else {
            move.now.lerpVectors(move.from, move.to, move.t / move.ms);
          }
          move.stale = true;
        }
        if (move.stale) {
          move.out.addVectors(part.restPosition, move.now);
          move.stale = false;
        }
        if (!move.hasWrote || !node.position.equals(move.wrote)) move.under.copy(node.position);
        if (!node.position.equals(move.out)) node.position.copy(move.out);
        move.wrote.copy(move.out);
        move.hasWrote = true;
        if (!move.easing && !move.given) {
          move.held = false;
          move.hasWrote = false;
          node.position.copy(this.driven(node, 'position') ? move.under : part.restPosition);
        }
      }

      const size = part.size;
      if (size.held) {
        if (size.easing) {
          size.t += elapsedMs;
          if (size.t >= size.ms) {
            size.now.copy(size.to);
            size.easing = false;
          } else {
            size.now.lerpVectors(size.from, size.to, size.t / size.ms);
          }
          size.stale = true;
        }
        if (size.stale) {
          size.out.multiplyVectors(part.restScale, size.now);
          size.stale = false;
        }
        if (!size.hasWrote || !node.scale.equals(size.wrote)) size.under.copy(node.scale);
        if (!node.scale.equals(size.out)) node.scale.copy(size.out);
        size.wrote.copy(size.out);
        size.hasWrote = true;
        if (!size.easing && !size.given) {
          size.held = false;
          size.hasWrote = false;
          node.scale.copy(this.driven(node, 'scale') ? size.under : part.restScale);
        }
      }

      if (part.shows !== undefined && node.visible !== part.shows) node.visible = part.shows;

      if (!turn.held && !move.held && !size.held && part.shows === undefined) this.release(part);
    }
  }

  /**
   * Run `change`, which starts, stops or changes the model's clips, with
   * every node a part is holding put back as its file has it, and the parts'
   * own poses put back over them afterwards. three's mixer keeps the pose
   * each node has when a clip that moves it starts, and writes it back when
   * the clip stops: with the parts lifted off, what it keeps is the file's
   * pose and not a part's.
   */
  atRest(change: () => void): void {
    for (const part of this.inUse) {
      if (part.turn.hasWrote) part.node.quaternion.copy(part.restQuaternion);
      if (part.move.hasWrote) part.node.position.copy(part.restPosition);
      if (part.size.hasWrote) part.node.scale.copy(part.restScale);
    }
    try {
      change();
    } finally {
      for (const part of this.inUse) {
        if (part.turn.hasWrote) part.node.quaternion.copy(part.turn.wrote);
        if (part.move.hasWrote) part.node.position.copy(part.move.wrote);
        if (part.size.hasWrote) part.node.scale.copy(part.size.wrote);
      }
    }
  }

  private driven(node: THREE.Object3D, property: PartProperty): boolean {
    return this.options.drives?.(node, property) === true;
  }

  /** Put everything where it was going, now: the scene is about to stop being drawn. */
  finish(): void {
    for (const part of this.inUse) {
      for (const eased of [part.turn, part.move, part.size] as Array<Channel<THREE.Quaternion | THREE.Vector3>>) {
        // Past its time: the next frame puts it there.
        if (eased.easing) eased.t = eased.ms;
      }
    }
    this.frame(0);
  }

  private give(part: Part, spec: unknown, ms: number): void {
    const given = isRecord(spec) ? (spec as Scene3DPart) : undefined;

    const rotation = isRecord(given?.rotation) ? given.rotation : undefined;
    const rx = finite(rotation?.x, 0);
    const ry = finite(rotation?.y, 0);
    const rz = finite(rotation?.z, 0);
    if (this.changed(part.turn, rotation !== undefined, rx, ry, rz)) {
      turned.setFromEuler(angles.set(rx, ry, rz, 'XYZ'));
      const posed = rotation === undefined && part.turn.hasWrote && this.driven(part.node, 'quaternion') && !part.turn.under.equals(part.restQuaternion);
      this.head(part.turn, turned, posed ? 0 : ms);
    }

    const position = isRecord(given?.position) ? given.position : undefined;
    const px = finite(position?.x, 0);
    const py = finite(position?.y, 0);
    const pz = finite(position?.z, 0);
    if (this.changed(part.move, position !== undefined, px, py, pz)) {
      // Let go of where a clip is posing it: at once, since easing it to rest first would end in a jump to the clip's pose.
      const posed = position === undefined && part.move.hasWrote && this.driven(part.node, 'position') && !part.move.under.equals(part.restPosition);
      this.headTo(part.move, px, py, pz, posed ? 0 : ms);
    }

    const scale = given?.scale;
    const each = isRecord(scale) ? (scale as { x?: unknown; y?: unknown; z?: unknown }) : undefined;
    const all = finite(scale, 1);
    const sx = each ? finite(each.x, 1) : all;
    const sy = each ? finite(each.y, 1) : all;
    const sz = each ? finite(each.z, 1) : all;
    const sized = each !== undefined || typeof scale === 'number';
    if (this.changed(part.size, sized, sx, sy, sz)) {
      const posed = !sized && part.size.hasWrote && this.driven(part.node, 'scale') && !part.size.under.equals(part.restScale);
      this.headTo(part.size, sx, sy, sz, posed ? 0 : ms);
    }

    const shows = typeof given?.visible === 'boolean' ? given.visible : undefined;
    if (part.shows !== shows) {
      part.shows = shows;
      // No longer said here: as its file has it, less what `appearance` hides.
      if (shows === undefined) part.node.visible = shownByAppearance(this.root, part.node) ?? part.restVisible;
    }

    if (part.at === -1 && (part.turn.held || part.move.held || part.size.held || part.shows !== undefined)) {
      part.at = this.inUse.length;
      this.inUse.push(part);
    }
  }

  /** Whether what a part gives for one property is other than it last gave; the new numbers are kept. */
  private changed(to: Channel<unknown>, given: boolean, a: number, b: number, c: number): boolean {
    if (to.given === given && to.a === a && to.b === b && to.c === c) return false;
    to.given = given;
    to.a = a;
    to.b = b;
    to.c = c;
    // Never given and not given now: nothing of the node's is touched.
    return given || to.held;
  }

  private head(to: Channel<THREE.Quaternion>, target: THREE.Quaternion, ms: number): void {
    to.held = true;
    to.stale = true;
    if (ms > 0) {
      to.from.copy(to.now);
      to.to.copy(target);
      to.t = 0;
      to.ms = ms;
      to.easing = true;
    } else {
      to.now.copy(target);
      to.easing = false;
    }
  }

  private headTo(to: Channel<THREE.Vector3>, x: number, y: number, z: number, ms: number): void {
    to.held = true;
    to.stale = true;
    if (ms > 0) {
      to.from.copy(to.now);
      to.to.set(x, y, z);
      to.t = 0;
      to.ms = ms;
      to.easing = true;
    } else {
      to.now.set(x, y, z);
      to.easing = false;
    }
  }

  private release(part: Part): void {
    const last = this.inUse.pop() as Part;
    if (last !== part) {
      this.inUse[part.at] = last;
      last.at = part.at;
    }
    part.at = -1;
  }

  private partOf(name: string): Part | null {
    const known = this.byName.get(name);
    if (known !== undefined) return known;
    const node = this.find(name);
    if (!node) {
      // Names that are new on every tick would otherwise pile up here.
      if (this.byName.size >= MAX_NAMES_KEPT) {
        for (const [kept, found] of this.byName) if (found === null) this.byName.delete(kept);
      }
      this.byName.set(name, null);
      const key = `${this.options.file ?? `one object ${this.options.id ?? ''}`}|${name}`;
      if (!warned.has(key)) {
        if (warned.size >= MAX_WARNED) warned.clear();
        warned.add(key);
        console.warn(
          `[Scene3D] Model "${this.options.id ?? ''}" has no part called "${name}" (parts); ` +
            'the "loaded" state of onModelState lists the names it has as `nodes`.'
        );
      }
      return null;
    }
    // A node found under two spellings of its name is one part, not two that write over each other.
    const same = this.byNode.get(node);
    if (same) {
      this.byName.set(name, same);
      return same;
    }
    const rest = this.twinOf(node) ?? node;
    const size = channel(() => new THREE.Vector3());
    // No size given is the part's full size, not none of it.
    size.now.set(1, 1, 1);
    const part: Part = {
      node,
      seen: 0,
      at: -1,
      restPosition: rest.position.clone(),
      restQuaternion: rest.quaternion.clone(),
      restScale: rest.scale.clone(),
      restVisible: rest.visible,
      turn: channel(() => new THREE.Quaternion()),
      move: channel(() => new THREE.Vector3()),
      size,
      shows: undefined,
    };
    this.byName.set(name, part);
    this.byNode.set(node, part);
    return part;
  }

  /**
   * The node called `name`: by the name as it stands, and failing that as
   * three writes names when it loads a file (a space becomes an underscore;
   * `[`, `]`, `.`, `:` and `/` are dropped), so the name seen in the program
   * the model was made in finds its node. The first node of a name is the
   * one found; the model's own top node is not a part.
   */
  private find(name: string): THREE.Object3D | undefined {
    let nodes = this.nodes;
    if (!nodes) {
      const found = new Map<string, THREE.Object3D>();
      const root = this.root;
      root.traverse((node) => {
        if (node !== root && node.name !== '' && !found.has(node.name)) found.set(node.name, node);
      });
      this.nodes = nodes = found;
    }
    return nodes.get(name) ?? nodes.get(THREE.PropertyBinding.sanitizeNodeName(name));
  }

  /** The node of the model's template that `node` is the copy of: the same steps down from the top. */
  private twinOf(node: THREE.Object3D): THREE.Object3D | null {
    const template = this.options.rest;
    if (!template) return null;
    path.length = 0;
    let at = node;
    while (at !== this.root) {
      const parent = at.parent;
      if (!parent) return null;
      path.push(parent.children.indexOf(at));
      at = parent;
    }
    let twin: THREE.Object3D | undefined = template;
    for (let i = path.length - 1; i >= 0 && twin; i--) twin = twin.children[path[i]];
    return twin && twin.name === node.name ? twin : null;
  }
}
