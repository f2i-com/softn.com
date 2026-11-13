/**
 * Scene3D, and with it Three.js, the GLTF/OBJ/FBX/STL loaders, the orbit
 * controls, the room environment and the post-processing passes: the one
 * feature the runtime must never load for an app that has no scene. Reached
 * through registerRuntimeComponents() as a loader, or directly by a host that
 * knows it wants it.
 *
 * SceneAnchor, the page content pinned to a place in a scene, is here with
 * it: it does nothing outside a Scene3D, so it loads with one and never
 * without.
 */
export * from '../threed/Scene3D';
export * from '../threed/SceneAnchor';
export { preloadScene3DAddons } from '../threed/model-loaders';

import { Scene3D } from '../threed/Scene3D';
import { SceneAnchor } from '../threed/SceneAnchor';

export const scene3dComponents = { Scene3D, SceneAnchor };
