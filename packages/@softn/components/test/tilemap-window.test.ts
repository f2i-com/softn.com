import {describe,it,expect} from 'vitest';
import {tileWindow} from '../src/animation/tilemap-window';
const clip={left:0,top:0,right:1280,bottom:558};
describe('viewport terrain geometry',()=>{
 it('draws a bounded subset at screen density, retaining 128px source tiles',()=>{const v=tileWindow({left:-896,top:-1257,width:3072,height:3072},clip,96,96,128,1)!;expect((v.x1-v.x0)*(v.y1-v.y0)).toBeLessThan(2000);expect(v.pixels).toBe(32);expect(v.x0*32-896).toBeLessThanOrEqual(0);expect(v.x1*32-896).toBeGreaterThanOrEqual(1280);});
 it('clamps to map edges and handles wholly hidden maps',()=>{const v=tileWindow({left:30,top:30,width:3072,height:3072},clip,96,96,128,2)!;expect(v.x0).toBe(0);expect(v.y0).toBe(0);expect(tileWindow({left:1300,top:0,width:3072,height:3072},clip,96,96,128,1)).toBeNull();});
 it('caps allocation at eight million pixels across zoom and screen sizes',()=>{for(const zoom of [.1,.4,1,2,4])for(const dpr of [1,2,4]){const v=tileWindow({left:-100,top:-100,width:3072*zoom,height:3072*zoom},{left:0,top:0,right:7680,bottom:4320},96,96,128,dpr)!;expect((v.x1-v.x0)*(v.y1-v.y0)*v.pixels*v.pixels).toBeLessThanOrEqual(8000000);expect((v.x1-v.x0)*v.pixels).toBeLessThanOrEqual(8192);}});
 it('panning changes the tile window while nearby positions reuse it',()=>{const rect={left:-896,top:-1257,width:3072,height:3072};const a=tileWindow(rect,clip,96,96,128,1);expect(tileWindow({...rect,left:-895},clip,96,96,128,1)).toEqual(a);expect(tileWindow({...rect,left:-400},clip,96,96,128,1)).not.toEqual(a);});
 it('rejects empty geometry and handles phone screens',()=>{expect(tileWindow({left:0,top:0,width:0,height:0},clip,96,96,128,1)).toBeNull();const v=tileWindow({left:-1400,top:-1400,width:3072,height:3072},{left:0,top:0,right:390,bottom:600},96,96,128,2)!;expect((v.x1-v.x0)*(v.y1-v.y0)).toBeLessThan(700);});
});
