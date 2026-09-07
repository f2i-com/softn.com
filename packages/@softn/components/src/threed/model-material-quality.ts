import * as THREE from 'three';

/** Smooth cutout edges under MSAA without enabling order-dependent blending. */
export function prepareModelMaterials(root: THREE.Object3D, maxAnisotropy: number): void {
  root.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;
    const mesh = child as THREE.Mesh;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      const mat = material as THREE.MeshStandardMaterial;
      if (mat.alphaTest > 0 && !mat.transparent) {
        mat.alphaToCoverage = true;
        mat.needsUpdate = true;
      }
      for (const texture of [mat.map, mat.normalMap, mat.roughnessMap]) {
        if (!texture) continue;
        texture.anisotropy = Math.max(1, Math.min(8, maxAnisotropy));
        texture.needsUpdate = true;
      }
    }
  });
}
