import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { applyModelAppearance } from '../src/threed/model-appearance';
function fixture() {
 const material=new THREE.MeshStandardMaterial({color:'#ffffff'});material.name='Fabric';
 const mesh=new THREE.Mesh(new THREE.BoxGeometry(),material);mesh.name='Coat';mesh.morphTargetDictionary={Shape:0,Blink:1};mesh.morphTargetInfluences=[0,.7];return {mesh,material};
}
describe('declarative model appearance',()=>{
 it('clamps named shapes and preserves unrequested animation channels',()=>{
  const {mesh}=fixture();applyModelAppearance(mesh,{morphs:{Shape:2,Unknown:1}});
  expect(mesh.morphTargetInfluences).toEqual([1,.7]);
  mesh.morphTargetInfluences![0]=0;applyModelAppearance(mesh,{morphs:{Shape:.5}});
  expect(mesh.morphTargetInfluences).toEqual([.5,.7]);
  applyModelAppearance(mesh,undefined);expect(mesh.morphTargetInfluences).toEqual([0,.7]);
 });
 it('restores materials and visibility and rejects non-colour input',()=>{
  const {mesh,material}=fixture();applyModelAppearance(mesh,{colors:{Fabric:'#ff0000'},hiddenMeshes:['Coat']});
  expect(material.color.getHexString()).toBe('ff0000');expect(mesh.visible).toBe(false);
  applyModelAppearance(mesh,{colors:{Fabric:'url(https://invalid.test)'}});
  expect(material.color.getHexString()).toBe('ffffff');expect(mesh.visible).toBe(true);
 });
 it('hides named multipart groups and restores authored morph defaults',()=>{
  const {mesh}=fixture();mesh.morphTargetInfluences![0]=.25;
  const group=new THREE.Group();group.name='Garment';group.add(mesh);
  applyModelAppearance(group,{hiddenMeshes:['Garment'],morphs:{Shape:.8}});
  expect(group.visible).toBe(false);expect(mesh.visible).toBe(true);
  applyModelAppearance(group,undefined);
  expect(group.visible).toBe(true);expect(mesh.morphTargetInfluences![0]).toBe(.25);
 });
 it('rejects nonfinite weights and inherited target names',()=>{
  const {mesh}=fixture();applyModelAppearance(mesh,{morphs:{Shape:NaN,toString:1}});
  expect(mesh.morphTargetInfluences).toEqual([0,.7]);
 });
 it('smooths only requested targets across mixer writes and closes on silence',()=>{
  const {mesh}=fixture(); const spec={morphs:{Shape:1},morphSmoothingMs:{Shape:50}};
  applyModelAppearance(mesh,spec,1/60); const first=mesh.morphTargetInfluences![0];
  expect(first).toBeGreaterThan(0); expect(first).toBeLessThan(1);
  mesh.morphTargetInfluences![0]=0; applyModelAppearance(mesh,spec,1/60);
  expect(mesh.morphTargetInfluences![0]).toBeGreaterThan(first); expect(mesh.morphTargetInfluences![1]).toBe(.7);
  for(let i=0;i<30;i++){mesh.morphTargetInfluences![0]=1;applyModelAppearance(mesh,{morphs:{Shape:0},morphSmoothingMs:{Shape:50}},1/60);}
  expect(mesh.morphTargetInfluences![0]).toBe(0);
 });
 it('bounds smoothing and frame gaps and clears removed controls',()=>{
  const {mesh}=fixture();applyModelAppearance(mesh,{morphs:{Shape:1},morphSmoothingMs:{Shape:Infinity}},1/60);
  expect(mesh.morphTargetInfluences![0]).toBe(1);
  applyModelAppearance(mesh,{morphs:{Shape:0},morphSmoothingMs:{Shape:99999}},9999);
  expect(mesh.morphTargetInfluences![0]).toBeCloseTo(Math.exp(-.5));
  applyModelAppearance(mesh,undefined,1/60);expect(mesh.morphTargetInfluences![0]).toBe(0);
  applyModelAppearance(mesh,{morphs:{Shape:1},morphSmoothingMs:{Shape:50}},1/60);
  expect(mesh.morphTargetInfluences![0]).toBeCloseTo(1-Math.exp(-1/3));
 });
});
