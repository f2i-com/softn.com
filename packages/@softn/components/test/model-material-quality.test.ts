import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { prepareModelMaterials } from '../src/threed/model-material-quality';

describe('imported model material quality', () => {
  it('smooths cutouts and caps texture filtering to the device limit', () => {
    const map = new THREE.Texture();
    const cutout = new THREE.MeshStandardMaterial({ alphaTest: .22, map });
    const glass = new THREE.MeshStandardMaterial({ transparent: true, opacity: .4 });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), [cutout, glass]);
    prepareModelMaterials(mesh, 4);
    expect(cutout.alphaToCoverage).toBe(true);
    expect(cutout.transparent).toBe(false);
    expect(map.anisotropy).toBe(4);
    expect(glass.alphaToCoverage).toBe(false);
    expect(glass.opacity).toBe(.4);
  });
  it('leaves untextured opaque materials opaque', () => {
    const material = new THREE.MeshBasicMaterial();
    prepareModelMaterials(new THREE.Mesh(new THREE.BoxGeometry(), material), 16);
    expect(material.alphaToCoverage).toBe(false);
    expect(material.transparent).toBe(false);
  });
});

