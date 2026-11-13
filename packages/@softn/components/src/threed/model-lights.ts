/**
 * The lights that are in a model.
 *
 * A scene made in another program has its lights in the file (glTF's
 * KHR_lights_punctual): a sun, a lamp on a mast. The loader makes them as
 * nodes of the model and they shine, at whatever strength the file gave
 * them: nothing could dim them, switch them off or have them cast shadows.
 * An object of `type: 'model'` now takes `lights`:
 *
 *   lights: false                        none of them shines
 *   lights: { intensity: 0.5 }           each at that multiple of its own strength
 *   lights: { castShadow: true, shadowMapSize, shadowCameraSize, shadowBias, shadowNormalBias }
 *
 * A light of a model is a node of it: it moves with the object, and with a
 * clip that moves it. So the box a sun's shadows are drawn in cannot be
 * moved about by moving the light, as a scene's own sun is carried with the
 * camera. Its shadow camera stays where the light is, facing the way the
 * light shines, and the window it draws through is slid sideways and along
 * its depth until the box is about the point ahead of the scene's camera
 * (the same point as a scene light with `follow: 'view'`): the shadows are
 * where the picture is, wherever in the model the sun lamp was put.
 */

import * as THREE from 'three';
import { SWITCHED_OFF_KEY, shownByAppearance } from './model-appearance';

/** What an object says of its model's own lights. */
export interface Scene3DModelLights {
  /** A multiple of each light's own strength (default 1). 1 / 683 turns a Blender export in its "Standard" units into plain numbers. */
  intensity?: number;
  /** Whether the model's directional and spot lights cast shadows (default false; the scene's `shadows` must be on). */
  castShadow?: boolean;
  /** The shadow map's resolution in pixels (default 1024 for a directional light, 512 for a spot). */
  shadowMapSize?: number;
  /** A directional light's shadows cover a box this many units each way (default 15), kept about what the camera sees. */
  shadowCameraSize?: number;
  /** As a scene light's `shadowBias` (default -0.0005 for a directional light, none for a spot). */
  shadowBias?: number;
  /** As a scene light's `shadowNormalBias`, in scene units (default 0). */
  shadowNormalBias?: number;
}

/** Set on a model's light while its object's `lights` speaks for it: its shadows are that prop's, not the object's `castShadow`. */
export const MODEL_LIGHT_KEY = '__softnModelLight';

/** What `writeShadow` is given: the shadow settings of a scene light, for the kind of light it is. */
export interface ModelLightShadow extends Scene3DModelLights {
  type: 'directional' | 'spot';
}

/** How far ahead of the camera the middle of a sun's shadow box is, as a share of the box's half-width. */
const AHEAD = 0.8;
/** How far toward the light, and how far away from it, the box reaches from its middle, in scene units. */
const TOWARD_LIGHT = 100;
const AWAY_FROM_LIGHT = 50;

const lightAt = new THREE.Vector3();
const targetAt = new THREE.Vector3();
const middle = new THREE.Vector3();
const sight = new THREE.Vector3();

const isDirectional = (light: THREE.Light): light is THREE.DirectionalLight => (light as THREE.DirectionalLight).isDirectionalLight === true;
const isSpot = (light: THREE.Light): light is THREE.SpotLight => (light as THREE.SpotLight).isSpotLight === true;

/**
 * Let go of the map a light's shadows were drawn into, and of what blurs
 * it: memory on the graphics card that three frees only when told. three
 * makes another if the light casts again.
 */
export function dropShadowMap(light: THREE.Object3D): void {
  const shadow = (light as THREE.DirectionalLight).shadow as THREE.LightShadow | undefined;
  if (!shadow) return;
  if (shadow.map) {
    shadow.map.dispose();
    shadow.map = null;
  }
  if (shadow.mapPass) {
    shadow.mapPass.dispose();
    shadow.mapPass = null;
  }
}

/** The lights of one instance of a model. */
export class ModelLights {
  private readonly lights: Array<{ light: THREE.Light; intensity: number; visible: boolean }> = [];
  /** The suns that cast shadows now: their boxes are kept about the view on every frame. */
  private readonly suns: Array<{ light: THREE.DirectionalLight; size: number }> = [];
  /** What `lights` last said, as text: a record handed over afresh on every tick is the same record. */
  private said: string | undefined;

  constructor(private readonly root: THREE.Object3D) {
    root.traverse((node) => {
      const light = node as THREE.Light;
      if (light.isLight === true) this.lights.push({ light, intensity: light.intensity, visible: light.visible });
    });
  }

  /** Whether any sun of the model casts shadows: there is something to do on a frame. */
  get follows(): boolean {
    return this.suns.length > 0;
  }

  /**
   * What the object's `lights` says now: false for none of them, a record
   * for their strength and their shadows, anything else for the lights as
   * the file has them. `writeShadow` is the scene's own way of giving a
   * light its shadow settings.
   */
  apply(spec: unknown, writeShadow: (light: THREE.DirectionalLight | THREE.SpotLight, shadow: ModelLightShadow) => void): void {
    const given = spec === false || (typeof spec === 'object' && spec !== null);
    const said = given ? JSON.stringify(spec) : '';
    if (said === this.said) return;
    this.said = said;
    const about = (given && spec !== false ? spec : {}) as Scene3DModelLights;
    const factor = typeof about.intensity === 'number' && Number.isFinite(about.intensity) ? Math.max(0, about.intensity) : 1;
    this.suns.length = 0;
    for (const { light, intensity, visible } of this.lights) {
      // Off is said on the light itself, where the model's appearance reads
      // it: a change of `hiddenMeshes` or `colors` writes every node's
      // visibility again, and would have switched the lights back on. On
      // again is as far as the appearance shows it (a light named in
      // `hiddenMeshes` stays dark, as it always did).
      if (spec === false) {
        light.userData[SWITCHED_OFF_KEY] = true;
        light.visible = false;
      } else {
        delete light.userData[SWITCHED_OFF_KEY];
        light.visible = shownByAppearance(this.root, light) ?? visible;
      }
      light.intensity = intensity * factor;
      if (given) light.userData[MODEL_LIGHT_KEY] = true;
      else delete light.userData[MODEL_LIGHT_KEY];
      const casts = given && spec !== false && about.castShadow === true;
      if (isDirectional(light) || isSpot(light)) {
        writeShadow(light, { ...about, castShadow: casts, type: isDirectional(light) ? 'directional' : 'spot' });
        if (casts && isDirectional(light)) {
          const size = typeof about.shadowCameraSize === 'number' && about.shadowCameraSize > 0 ? about.shadowCameraSize : 15;
          this.suns.push({ light, size });
        }
      } else {
        // A lamp that shines every way draws its shadows six times over: not
        // asked of a model's. One that was casting (the object's own
        // `castShadow` reaches every node of a model) gives back its map.
        light.castShadow = false;
        dropShadowMap(light);
      }
    }
  }

  /**
   * One frame: the box each shadow-casting sun draws its shadows in is put
   * about the point ahead of `camera`, along the camera's line of sight,
   * moved in whole texels of the shadow map so that no shadow's edge crawls
   * as the camera moves. The light itself is not moved.
   */
  aim(camera: THREE.Camera): void {
    for (const { light, size } of this.suns) {
      const shadow = light.shadow;
      const box = shadow.camera;
      // Three's own placing of the shadow camera: at the light, facing its target.
      light.updateWorldMatrix(true, false);
      light.target.updateWorldMatrix(true, false);
      lightAt.setFromMatrixPosition(light.matrixWorld);
      targetAt.setFromMatrixPosition(light.target.matrixWorld);
      if (lightAt.distanceToSquared(targetAt) < 1e-12) continue;
      box.position.copy(lightAt);
      box.lookAt(targetAt);
      box.updateMatrixWorld();
      // The point the box is to be about, as the shadow camera sees it.
      middle.copy(camera.position).addScaledVector(sight.set(0, 0, -1).applyQuaternion(camera.quaternion), AHEAD * size);
      middle.applyMatrix4(box.matrixWorldInverse);
      if (!Number.isFinite(middle.x) || !Number.isFinite(middle.y) || !Number.isFinite(middle.z)) continue;
      const texel = shadow.mapSize.width > 0 ? (2 * size) / shadow.mapSize.width : 0;
      const across = texel > 0 ? Math.round(middle.x / texel) * texel : middle.x;
      const up = texel > 0 ? Math.round(middle.y / texel) * texel : middle.y;
      const depth = -middle.z;
      const near = depth - TOWARD_LIGHT;
      const far = depth + AWAY_FROM_LIGHT;
      if (box.left === across - size && box.bottom === up - size && box.near === near && box.far === far && box.right === across + size && box.top === up + size) continue;
      box.left = across - size;
      box.right = across + size;
      box.bottom = up - size;
      box.top = up + size;
      box.near = near;
      box.far = far;
      box.updateProjectionMatrix();
    }
  }
}
