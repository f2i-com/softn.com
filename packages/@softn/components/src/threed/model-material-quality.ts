import * as THREE from 'three';

/**
 * Smooth cutout edges under MSAA without enabling order-dependent blending,
 * and filter the maps anisotropically as far as the device allows.
 *
 * The materials are the instance's own clones, but the textures behind them
 * are the template's, shared by every instance of the model. Setting
 * `needsUpdate` on a texture bumps its version, and the renderer answers a
 * new version by uploading the image again and regenerating its mipmaps —
 * so a hundred crates would upload the crate's maps a hundred times over. A
 * texture is touched only when its anisotropy actually changes, which is
 * once, for the first instance; the rest find it already set.
 */
export function prepareModelMaterials(root: THREE.Object3D, maxAnisotropy: number): void {
  const anisotropy = Math.max(1, Math.min(8, maxAnisotropy));
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
        if (!texture || texture.anisotropy === anisotropy) continue;
        texture.anisotropy = anisotropy;
        texture.needsUpdate = true;
      }
    }
  });
}
