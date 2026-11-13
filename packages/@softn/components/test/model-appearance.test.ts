import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { applyModelAppearance, readColour } from '../src/threed/model-appearance';
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

// Only six hex digits were read: `red`, three digits or `rgb(…)` left the
// material as it was and said nothing.
describe('a tint in any form three.js reads', () => {
 const tinted = (tint: unknown) => {
  const { mesh, material } = fixture();
  applyModelAppearance(mesh, { colors: { Fabric: tint as string } });
  return material.color.getHexString();
 };
 it('is applied: a name, three or six hex digits, rgb() and hsl()', () => {
  expect(tinted('red')).toBe('ff0000');
  expect(tinted('RebeccaPurple')).toBe('663399');
  expect(tinted('#0f0')).toBe('00ff00');
  expect(tinted('#00FF00')).toBe('00ff00');
  expect(tinted('rgb(0, 0, 255)')).toBe('0000ff');
  expect(tinted('rgb(100%, 0%, 0%)')).toBe('ff0000');
  expect(tinted('hsl(120, 100%, 50%)')).toBe('00ff00');
  expect(tinted('  red  ')).toBe('ff0000');
 });
 it('leaves the material as it was for one that cannot be read, and warns once for it, not on every tick', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
   const { mesh, material } = fixture();
   // A new appearance object each time, as logic hands one over on every tick.
   for (let i = 0; i < 5; i++) applyModelAppearance(mesh, { colors: { Fabric: 'bluish-test' } });
   expect(material.color.getHexString()).toBe('ffffff');
   expect(warn).toHaveBeenCalledOnce();
   expect(String(warn.mock.calls[0][0])).toContain('appearance.colors.Fabric');
   expect(String(warn.mock.calls[0][0])).toContain('bluish-test');
   // three's own warning, which it gives on every use, was never set off.
   expect(warn.mock.calls.some(([message]) => String(message).startsWith('THREE.Color'))).toBe(false);

   for (const unreadable of ['#12', '#1234567', 'rgb(a, b, c)', 'hwb(0 0% 0%)', 'url(https://invalid.test/x)', 'constructor', '', 255, { r: 1 }]) {
    applyModelAppearance(mesh, { colors: { Fabric: unreadable as string } });
    expect(material.color.getHexString()).toBe('ffffff');
   }
   expect(warn.mock.calls.some(([message]) => String(message).startsWith('THREE.Color'))).toBe(false);
  } finally {
   warn.mockRestore();
  }
 });
 it('is written when it is another appearance, not whenever it is another object, and leaves alone what it never tinted', () => {
  // A list from logic is a new list on every tick, so the same appearance arrives as a new
  // object each time. It was written again each time, over the colour the object's own
  // `color` had given the model since.
  const { mesh, material } = fixture();
  const lining = new THREE.MeshStandardMaterial({ color: '#ffffff' });
  lining.name = 'Lining';
  const inner = new THREE.Mesh(new THREE.BoxGeometry(), lining);
  inner.name = 'Inner';
  mesh.add(inner);
  applyModelAppearance(mesh, { colors: { Fabric: 'teal' }, hiddenMeshes: ['Inner'] });
  expect(material.color.getHexString()).toBe('008080');
  expect(inner.visible).toBe(false);
  // Something else colours the part the appearance says nothing of, and shows the hidden one.
  lining.color.set('#ff0000');
  inner.visible = true;
  for (let i = 0; i < 3; i++) applyModelAppearance(mesh, { colors: { Fabric: 'teal' }, hiddenMeshes: ['Inner'] });
  expect(lining.color.getHexString()).toBe('ff0000');
  expect(inner.visible).toBe(true);
  // Another appearance is written: the tint changes, and the part it never tinted keeps its colour.
  applyModelAppearance(mesh, { colors: { Fabric: 'navy' }, hiddenMeshes: ['Inner'] });
  expect(material.color.getHexString()).toBe('000080');
  expect(lining.color.getHexString()).toBe('ff0000');
  expect(inner.visible).toBe(false);
  // The tint taken away is the material's own colour again; the other is still not this one's to set.
  applyModelAppearance(mesh, undefined);
  expect(material.color.getHexString()).toBe('ffffff');
  expect(lining.color.getHexString()).toBe('ff0000');
  expect(inner.visible).toBe(true);
 });
 it('says nothing of a tint that is not there, and goes back to the material’s own colour', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
   const { mesh, material } = fixture();
   applyModelAppearance(mesh, { colors: { Fabric: 'teal' } });
   expect(material.color.getHexString()).toBe('008080');
   applyModelAppearance(mesh, { colors: { Fabric: null as unknown as string } });
   expect(material.color.getHexString()).toBe('ffffff');
   applyModelAppearance(mesh, { colors: {} });
   expect(material.color.getHexString()).toBe('ffffff');
   expect(warn).not.toHaveBeenCalled();
  } finally {
   warn.mockRestore();
  }
 });
 it('readColour reads a text once, however often it is asked', () => {
  const first = readColour('rgb(1, 2, 3)', 'a test');
  expect(first).toBeInstanceOf(THREE.Color);
  expect(readColour('rgb(1, 2, 3)', 'a test')).toBe(first);
 });
});
