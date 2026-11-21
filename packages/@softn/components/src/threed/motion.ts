/**
 * Movement eased between updates.
 *
 * A game's logic ticks about thirty times a second and the screen is drawn
 * sixty or more, so everything the logic moved jumped thirty times a second:
 * each object stood still for two frames and then leapt. A dashboard's model
 * jumped to each new figure. With a `transition` (milliseconds, on the scene
 * or on one object) a change of position, direction, size, colour, opacity
 * or glow is not written at once: the render loop takes the object there
 * over that time, at a steady rate, from wherever it is drawn now. A change
 * that arrives while the last is still under way starts from where the
 * object has got to, so a thing that moves every tick moves without a stop.
 *
 * What is not eased, each for a reason:
 * - a move further than `jump` units, which is a teleport and not a step;
 * - anything while the scene is not being drawn (its app is hidden): it
 *   would otherwise sweep across the view the moment it was shown again;
 * - an object as it first appears;
 * - a direction is turned the short way round, so an angle that wraps from
 *   just under a half turn to just over the opposite one turns a little,
 *   not almost a whole turn back.
 *
 * The frame's work allocates nothing: each node and each material that has
 * ever been eased keeps one record, with its own vectors, and the records in
 * motion are kept in two arrays walked once a frame.
 */

import * as THREE from 'three';

interface Channel3 {
  on: boolean;
  /** Milliseconds gone of `ms`. */
  t: number;
  ms: number;
  from: THREE.Vector3;
  to: THREE.Vector3;
}

interface NodeEase {
  node: THREE.Object3D;
  /** Its place among the records in motion, or -1. */
  at: number;
  /** `withY` false leaves the height to whatever else writes it (a bob the scene keeps up). */
  position: Channel3 & { withY: boolean };
  scale: Channel3;
  turn: {
    on: boolean;
    t: number;
    ms: number;
    from: THREE.Quaternion;
    to: THREE.Quaternion;
    /** The angles to rest at, when the object gave angles: its `rotation` reads back as written. */
    rest: THREE.Euler;
    hasRest: boolean;
  };
}

/** What of a material is eased: any that has it. */
type Looked = THREE.Material & { color?: THREE.Color; emissive?: THREE.Color; emissiveIntensity?: number };

interface LookEase {
  material: Looked;
  at: number;
  t: number;
  ms: number;
  hasColor: boolean;
  fromColor: THREE.Color;
  toColor: THREE.Color;
  hasEmissive: boolean;
  fromEmissive: THREE.Color;
  toEmissive: THREE.Color;
  fromGlow: number;
  toGlow: number;
  fromOpacity: number;
  toOpacity: number;
  /** Whether the material is see-through once it has arrived. */
  restTransparent: boolean;
}

/** Camera-local offset & orientation for `attach: 'camera'` objects, eased between ticks. */
export interface CarriedPose {
  readonly pos: THREE.Vector3;
  readonly quat: THREE.Quaternion;
}

interface CarriedEase extends CarriedPose {
  node: THREE.Object3D;
  at: number;
  t: number;
  ms: number;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  fromQuat: THREE.Quaternion;
  toQuat: THREE.Quaternion;
}

const isColor = (value: unknown): value is THREE.Color => !!value && (value as THREE.Color).isColor === true;
const sameColor = (a: THREE.Color, b: THREE.Color): boolean => a.r === b.r && a.g === b.g && a.b === b.b;

export class Easer {
  /** Whether the scene is being drawn. While it is not, nothing is eased. */
  live = false;
  /** A move further than this many units is written at once; 0 for no such limit. */
  jump = 4;

  private readonly nodes: NodeEase[] = [];
  private readonly looks: LookEase[] = [];
  private readonly carried: CarriedEase[] = [];
  private readonly byNode = new WeakMap<THREE.Object3D, NodeEase>();
  private readonly byMaterial = new WeakMap<THREE.Material, LookEase>();
  private readonly byCarried = new WeakMap<THREE.Object3D, CarriedEase>();

  /** Whether anything is on its way somewhere. */
  get busy(): boolean {
    return this.nodes.length > 0 || this.looks.length > 0 || this.carried.length > 0;
  }

  /** Whether `node` is on its way somewhere. */
  isMoving(node: THREE.Object3D): boolean {
    const ease = this.byNode.get(node);
    return !!ease && ease.at !== -1;
  }

  /**
   * Take `node` to a position over `ms`. False means it is not being eased
   * there (no time given, the scene not drawn, already there, or too far),
   * any ease it was on is dropped, and the caller writes the position.
   */
  moveTo(node: THREE.Object3D, x: number, y: number, z: number, ms: number, withY: boolean): boolean {
    const known = this.byNode.get(node);
    if (!(ms > 0) || !this.live) {
      if (known) known.position.on = false;
      return false;
    }
    const now = node.position;
    if (known?.position.on) {
      const to = known.position.to;
      if (to.x === x && to.y === y && to.z === z && known.position.withY === withY) return true;
    } else if (now.x === x && now.z === z && (!withY || now.y === y)) {
      return false;
    }
    // How far it has been moved in this one update: from where it was last
    // told to be, while it is still on its way there, and from where it is
    // otherwise. Measured from where it is drawn, a steady mover whose
    // transition outlasts a tick fell further behind what it was told on each
    // one until the gap passed `jump`, was put there at once, and began
    // again: an ease, a jump, an ease, a jump.
    const told = known?.position.on ? known.position.to : now;
    const dx = x - told.x;
    const dy = withY ? y - told.y : 0;
    const dz = z - told.z;
    if (this.jump > 0 && dx * dx + dy * dy + dz * dz > this.jump * this.jump) {
      if (known) known.position.on = false;
      return false;
    }
    const ease = known ?? this.recordOf(node);
    const channel = ease.position;
    channel.from.set(now.x, withY ? now.y : y, now.z);
    channel.to.set(x, y, z);
    channel.withY = withY;
    channel.t = 0;
    channel.ms = ms;
    channel.on = true;
    this.start(ease);
    return true;
  }

  /**
   * Turn `node` to an orientation over `ms`, the short way round. `rest`,
   * when given, is the angles the object wrote, which its rotation is set to
   * on arrival. False as for `moveTo`: the caller writes the orientation.
   */
  turnTo(node: THREE.Object3D, to: THREE.Quaternion, ms: number, rest?: THREE.Euler): boolean {
    const known = this.byNode.get(node);
    if (!(ms > 0) || !this.live) {
      if (known) known.turn.on = false;
      return false;
    }
    const facing = known?.turn.on ? known.turn.to : node.quaternion;
    if (Math.abs(facing.dot(to)) > 1 - 1e-12) {
      // The same turn: one under way goes on, with the angles to rest at as they are now given.
      if (!known?.turn.on) return false;
      known.turn.hasRest = !!rest;
      if (rest) known.turn.rest.copy(rest);
      return true;
    }
    const ease = known ?? this.recordOf(node);
    const channel = ease.turn;
    channel.from.copy(node.quaternion);
    channel.to.copy(to);
    channel.hasRest = !!rest;
    if (rest) channel.rest.copy(rest);
    channel.t = 0;
    channel.ms = ms;
    channel.on = true;
    this.start(ease);
    return true;
  }

  /** Bring `node` to a size over `ms`. False as for `moveTo`: the caller writes the scale. */
  scaleTo(node: THREE.Object3D, x: number, y: number, z: number, ms: number): boolean {
    const known = this.byNode.get(node);
    if (!(ms > 0) || !this.live) {
      if (known) known.scale.on = false;
      return false;
    }
    const now = node.scale;
    if (known?.scale.on) {
      const to = known.scale.to;
      if (to.x === x && to.y === y && to.z === z) return true;
    } else if (now.x === x && now.y === y && now.z === z) {
      return false;
    }
    const ease = known ?? this.recordOf(node);
    const channel = ease.scale;
    channel.from.copy(now);
    channel.to.set(x, y, z);
    channel.t = 0;
    channel.ms = ms;
    channel.on = true;
    this.start(ease);
    return true;
  }

  /**
   * Before a material is written with new values: remember how it is drawn
   * now. True means `endLook` is to be called once it has been written.
   * False means nothing is eased, and any ease it was on is dropped.
   */
  beginLook(material: THREE.Material, ms: number): boolean {
    const mat = material as Looked;
    const known = this.byMaterial.get(mat);
    if (!(ms > 0) || !this.live) {
      // What it was on its way to is what it is, before the caller writes over it.
      if (known && known.at !== -1) this.arriveLook(known);
      return false;
    }
    const look = known ?? this.lookOf(mat);
    look.hasColor = isColor(mat.color);
    if (look.hasColor) look.fromColor.copy(mat.color as THREE.Color);
    look.hasEmissive = isColor(mat.emissive);
    if (look.hasEmissive) look.fromEmissive.copy(mat.emissive as THREE.Color);
    look.fromGlow = typeof mat.emissiveIntensity === 'number' ? mat.emissiveIntensity : 1;
    look.fromOpacity = mat.opacity;
    look.ms = ms;
    if (look.at !== -1) {
      // Part of the way already: what it was going to is what it holds for
      // the caller to write over, so anything the caller leaves alone is
      // still gone to.
      if (look.hasColor) (mat.color as THREE.Color).copy(look.toColor);
      if (look.hasEmissive) (mat.emissive as THREE.Color).copy(look.toEmissive);
      if (typeof mat.emissiveIntensity === 'number') mat.emissiveIntensity = look.toGlow;
      mat.opacity = look.toOpacity;
      if (mat.transparent !== look.restTransparent) {
        mat.transparent = look.restTransparent;
        mat.needsUpdate = true;
      }
    }
    return true;
  }

  /**
   * After the material was written: what it was given is where it is going,
   * and it is put back to how it was drawn, to go there over the time given
   * to `beginLook`.
   */
  endLook(material: THREE.Material): void {
    const mat = material as Looked;
    const look = this.byMaterial.get(mat);
    if (!look) return;
    if (look.hasColor) look.toColor.copy(mat.color as THREE.Color);
    if (look.hasEmissive) look.toEmissive.copy(mat.emissive as THREE.Color);
    look.toGlow = typeof mat.emissiveIntensity === 'number' ? mat.emissiveIntensity : 1;
    look.toOpacity = mat.opacity;
    look.restTransparent = mat.transparent;
    const same =
      look.fromOpacity === look.toOpacity &&
      look.fromGlow === look.toGlow &&
      (!look.hasColor || sameColor(look.fromColor, look.toColor)) &&
      (!look.hasEmissive || sameColor(look.fromEmissive, look.toEmissive));
    if (same) {
      if (look.at !== -1) this.releaseLook(look);
      return;
    }
    look.t = 0;
    this.writeLook(look, 0);
    // Part of the way between see-through and solid is see-through: for an
    // ease of the opacity itself, and only that. A material whose colour
    // alone is eased stays as its object has it: one that is drawn solid at
    // less than full opacity on purpose (a cloud of square particles) was
    // made see-through for the length of every change of its colour, and
    // sorted and blended as see-through things are.
    if (!mat.transparent && look.fromOpacity !== look.toOpacity && (look.fromOpacity < 1 || look.toOpacity < 1)) {
      mat.transparent = true;
      mat.needsUpdate = true;
    }
    if (look.at === -1) {
      look.at = this.looks.length;
      this.looks.push(look);
    }
  }

  /**
   * Place or ease a camera-attached object's local offset & orientation over `ms`.
   * Viewmodel objects (`attach: 'camera'`) are positioned relative to the active
   * camera on every display frame, so easing their camera-local pose eliminates
   * 30 Hz viewmodel stutter on 60–240 Hz monitors while keeping them locked to
   * mouse-look turns with zero lag.
   */
  carryTo(
    node: THREE.Object3D,
    x: number,
    y: number,
    z: number,
    toQuat: THREE.Quaternion,
    ms: number,
    isUpdate: boolean
  ): void {
    let rec = this.byCarried.get(node);
    if (!rec) {
      rec = {
        node,
        at: -1,
        t: 0,
        ms: 0,
        pos: new THREE.Vector3(x, y, z),
        quat: toQuat.clone(),
        fromPos: new THREE.Vector3(x, y, z),
        toPos: new THREE.Vector3(x, y, z),
        fromQuat: toQuat.clone(),
        toQuat: toQuat.clone(),
      };
      this.byCarried.set(node, rec);
      return;
    }

    const toldPos = rec.at !== -1 ? rec.toPos : rec.pos;
    const dx = x - toldPos.x;
    const dy = y - toldPos.y;
    const dz = z - toldPos.z;
    const jumped = this.jump > 0 && dx * dx + dy * dy + dz * dz > this.jump * this.jump;

    if (!isUpdate || !(ms > 0) || !this.live || jumped) {
      rec.pos.set(x, y, z);
      rec.toPos.set(x, y, z);
      rec.quat.copy(toQuat);
      rec.toQuat.copy(toQuat);
      if (rec.at !== -1) this.releaseCarried(rec);
      return;
    }

    const posSame = toldPos.x === x && toldPos.y === y && toldPos.z === z;
    const toldQuat = rec.at !== -1 ? rec.toQuat : rec.quat;
    const quatSame = Math.abs(toldQuat.dot(toQuat)) > 1 - 1e-12;
    if (posSame && quatSame) return;

    rec.fromPos.copy(rec.pos);
    rec.toPos.set(x, y, z);
    rec.fromQuat.copy(rec.quat);
    rec.toQuat.copy(toQuat);
    rec.t = 0;
    rec.ms = ms;
    if (rec.at === -1) {
      rec.at = this.carried.length;
      this.carried.push(rec);
    }
  }

  /** Current camera-local pose for an `attach: 'camera'` object, if tracked. */
  carriedPose(node: THREE.Object3D): CarriedPose | undefined {
    return this.byCarried.get(node);
  }

  /** One frame: `elapsedMs` since the last. */
  advance(elapsedMs: number): void {
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const ease = this.nodes[i];
      const node = ease.node;
      let moving = false;

      const p = ease.position;
      if (p.on) {
        p.t += elapsedMs;
        const k = p.t >= p.ms ? 1 : p.t / p.ms;
        if (k === 1) p.on = false;
        else moving = true;
        node.position.x = k === 1 ? p.to.x : p.from.x + (p.to.x - p.from.x) * k;
        if (p.withY) node.position.y = k === 1 ? p.to.y : p.from.y + (p.to.y - p.from.y) * k;
        node.position.z = k === 1 ? p.to.z : p.from.z + (p.to.z - p.from.z) * k;
      }

      const s = ease.scale;
      if (s.on) {
        s.t += elapsedMs;
        if (s.t >= s.ms) {
          s.on = false;
          node.scale.copy(s.to);
        } else {
          moving = true;
          node.scale.lerpVectors(s.from, s.to, s.t / s.ms);
        }
      }

      const r = ease.turn;
      if (r.on) {
        r.t += elapsedMs;
        if (r.t >= r.ms) {
          r.on = false;
          if (r.hasRest) node.rotation.copy(r.rest);
          else node.quaternion.copy(r.to);
        } else {
          moving = true;
          node.quaternion.slerpQuaternions(r.from, r.to, r.t / r.ms);
        }
      }

      if (!moving) this.release(ease);
    }

    for (let i = this.carried.length - 1; i >= 0; i--) {
      const rec = this.carried[i];
      rec.t += elapsedMs;
      if (rec.t >= rec.ms) {
        rec.pos.copy(rec.toPos);
        rec.quat.copy(rec.toQuat);
        this.releaseCarried(rec);
      } else {
        const k = rec.t / rec.ms;
        rec.pos.lerpVectors(rec.fromPos, rec.toPos, k);
        rec.quat.slerpQuaternions(rec.fromQuat, rec.toQuat, k);
      }
    }

    for (let i = this.looks.length - 1; i >= 0; i--) {
      const look = this.looks[i];
      look.t += elapsedMs;
      if (look.t >= look.ms) this.arriveLook(look);
      else this.writeLook(look, look.t / look.ms);
    }
  }

  /** Put everything where it was going, now: the scene is about to stop being drawn. */
  finishAll(): void {
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const ease = this.nodes[i];
      const node = ease.node;
      const p = ease.position;
      if (p.on) {
        node.position.x = p.to.x;
        if (p.withY) node.position.y = p.to.y;
        node.position.z = p.to.z;
        p.on = false;
      }
      if (ease.scale.on) {
        node.scale.copy(ease.scale.to);
        ease.scale.on = false;
      }
      const r = ease.turn;
      if (r.on) {
        if (r.hasRest) node.rotation.copy(r.rest);
        else node.quaternion.copy(r.to);
        r.on = false;
      }
      ease.at = -1;
    }
    this.nodes.length = 0;
    for (let i = this.carried.length - 1; i >= 0; i--) {
      const rec = this.carried[i];
      rec.pos.copy(rec.toPos);
      rec.quat.copy(rec.toQuat);
      rec.at = -1;
    }
    this.carried.length = 0;
    for (let i = this.looks.length - 1; i >= 0; i--) this.arriveLook(this.looks[i]);
  }

  /** `node` is no longer an object of the scene, or no longer the node of one: leave it as it is. */
  forget(node: THREE.Object3D): void {
    const held = this.byCarried.get(node);
    if (held) {
      if (held.at !== -1) this.releaseCarried(held);
      this.byCarried.delete(node);
    }
    const ease = this.byNode.get(node);
    if (!ease) return;
    ease.position.on = false;
    ease.scale.on = false;
    ease.turn.on = false;
    if (ease.at !== -1) this.release(ease);
  }

  private recordOf(node: THREE.Object3D): NodeEase {
    const ease: NodeEase = {
      node,
      at: -1,
      position: { on: false, t: 0, ms: 0, from: new THREE.Vector3(), to: new THREE.Vector3(), withY: true },
      scale: { on: false, t: 0, ms: 0, from: new THREE.Vector3(), to: new THREE.Vector3() },
      turn: {
        on: false,
        t: 0,
        ms: 0,
        from: new THREE.Quaternion(),
        to: new THREE.Quaternion(),
        rest: new THREE.Euler(),
        hasRest: false,
      },
    };
    this.byNode.set(node, ease);
    return ease;
  }

  private lookOf(material: Looked): LookEase {
    const look: LookEase = {
      material,
      at: -1,
      t: 0,
      ms: 0,
      hasColor: false,
      fromColor: new THREE.Color(),
      toColor: new THREE.Color(),
      hasEmissive: false,
      fromEmissive: new THREE.Color(),
      toEmissive: new THREE.Color(),
      fromGlow: 1,
      toGlow: 1,
      fromOpacity: 1,
      toOpacity: 1,
      restTransparent: false,
    };
    this.byMaterial.set(material, look);
    return look;
  }

  private start(ease: NodeEase): void {
    if (ease.at !== -1) return;
    ease.at = this.nodes.length;
    this.nodes.push(ease);
  }

  private release(ease: NodeEase): void {
    const last = this.nodes.pop() as NodeEase;
    if (last !== ease) {
      this.nodes[ease.at] = last;
      last.at = ease.at;
    }
    ease.at = -1;
  }

  private releaseLook(look: LookEase): void {
    const last = this.looks.pop() as LookEase;
    if (last !== look) {
      this.looks[look.at] = last;
      last.at = look.at;
    }
    look.at = -1;
  }

  private releaseCarried(rec: CarriedEase): void {
    const last = this.carried.pop() as CarriedEase;
    if (last !== rec) {
      this.carried[rec.at] = last;
      last.at = rec.at;
    }
    rec.at = -1;
  }

  private writeLook(look: LookEase, k: number): void {
    const mat = look.material;
    if (look.hasColor) (mat.color as THREE.Color).copy(look.fromColor).lerp(look.toColor, k);
    if (look.hasEmissive) (mat.emissive as THREE.Color).copy(look.fromEmissive).lerp(look.toEmissive, k);
    if (typeof mat.emissiveIntensity === 'number') mat.emissiveIntensity = look.fromGlow + (look.toGlow - look.fromGlow) * k;
    mat.opacity = look.fromOpacity + (look.toOpacity - look.fromOpacity) * k;
  }

  private arriveLook(look: LookEase): void {
    const mat = look.material;
    if (look.hasColor) (mat.color as THREE.Color).copy(look.toColor);
    if (look.hasEmissive) (mat.emissive as THREE.Color).copy(look.toEmissive);
    if (typeof mat.emissiveIntensity === 'number') mat.emissiveIntensity = look.toGlow;
    mat.opacity = look.toOpacity;
    if (mat.transparent !== look.restTransparent) {
      mat.transparent = look.restTransparent;
      mat.needsUpdate = true;
    }
    this.releaseLook(look);
  }
}

/** An object's own `transition` where it gives one, and otherwise the one it inherits. */
export function transitionOf(own: unknown, inherited: number): number {
  return typeof own === 'number' && Number.isFinite(own) && own >= 0 ? own : inherited;
}

/**
 * Tracks whether updates are arriving from a periodic sub-frame-rate game loop
 * (such as `<Loop interval={33} />` ticking at ~30 Hz while the screen draws
 * at 60–240 Hz). Returns an interpolation duration in milliseconds once two
 * consecutive multi-frame tick intervals have been observed, and `0` for
 * single manual edits, frame-locked loops (`<Loop frame />`), or synchronous
 * updates.
 */
export class TickCadence {
  private lastAt = -1;
  private framesSinceLast = 0;
  private avgFrameMs = 0;
  private streak = 0;
  private smoothedMs = 0;

  /** Record one rendered display frame (`dtMs` is the frame delta in ms). */
  frame(dtMs = 0): void {
    this.framesSinceLast++;
    if (dtMs > 0.5 && dtMs < 120) {
      this.avgFrameMs = this.avgFrameMs === 0 ? dtMs : this.avgFrameMs * 0.8 + dtMs * 0.2;
    }
  }

  /** Seed the initial timestamp at scene mount without counting a tick. */
  seed(now: number): void {
    this.lastAt = now;
    this.framesSinceLast = 0;
    this.streak = 0;
    this.smoothedMs = 0;
  }

  /** Clear cadence history when the scene pauses, resumes, or teleports. */
  reset(): void {
    this.lastAt = -1;
    this.framesSinceLast = 0;
    this.avgFrameMs = 0;
    this.streak = 0;
    this.smoothedMs = 0;
  }

  /** Record an update at `now` ms and return the active interpolation window (0 if none). */
  update(now: number): number {
    const frames = this.framesSinceLast;
    this.framesSinceLast = 0;
    if (this.lastAt < 0) {
      this.lastAt = now;
      return 0;
    }
    const dt = now - this.lastAt;
    this.lastAt = now;

    const active = this.streak >= 2;
    const subFrameRate = frames >= 2 || (frames >= 1 && this.avgFrameMs > 0 && dt >= this.avgFrameMs * 1.35);
    const qualifies = active
      ? frames >= 1 && dt >= 14 && dt <= 115 && (subFrameRate || dt >= 22)
      : subFrameRate && dt >= 22 && dt <= 95;

    if (!qualifies) {
      this.streak = 0;
      this.smoothedMs = 0;
      return 0;
    }

    const clamped = Math.min(85, Math.max(18, dt));
    this.streak++;
    this.smoothedMs = this.smoothedMs === 0 ? clamped : this.smoothedMs * 0.7 + clamped * 0.3;
    return this.streak >= 2 ? Math.round(this.smoothedMs * 1.05) : 0;
  }
}
