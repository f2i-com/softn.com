/**
 * Scene3D, and with it Three.js, the GLTF/OBJ/FBX/STL loaders, the orbit
 * controls, the room environment and the post-processing passes: the one
 * feature the runtime must never load for an app that has no scene. Reached
 * through registerRuntimeComponents() as a loader, or directly by a host that
 * knows it wants it.
 */
export * from '../threed/Scene3D';

import { Scene3D } from '../threed/Scene3D';

export const scene3dComponents = { Scene3D };
