import {createRoot} from 'react-dom/client';
import {act} from 'react';
import {it,expect,vi} from 'vitest';
vi.mock('@softn/core',()=>({isSafeUrl:()=>true}));
import {ViewportTileMap} from '../src/animation/ViewportTileMap';
it('caches the atlas, culls draws, preserves input geometry and avoids idle repaints',async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const draw=vi.fn(),clear=vi.fn(),callbacks=new Map<number,FrameRequestCallback>();let seq=0;
 vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({drawImage:draw,clearRect:clear} as any);
 vi.stubGlobal('requestAnimationFrame',(cb:FrameRequestCallback)=>{callbacks.set(++seq,cb);return seq;});
 vi.stubGlobal('cancelAnimationFrame',(id:number)=>callbacks.delete(id));
 let loaded:(()=>void)|null=null;
 vi.stubGlobal('Image',class{naturalWidth=1024;naturalHeight=512;set onload(v:any){loaded=v;}set src(_v:string){} });
 vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({left:-1000,top:-1000,width:3072,height:3072,right:2072,bottom:2072} as any);
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),range=vi.fn();
 const layers=[Array.from({length:96},()=>Array(96).fill(0))];
 const props={src:'/atlas.svg',layers,mapWidth:96,mapHeight:96,tileSize:128,scale:.25,onVisibleRangeChange:range};
 const flush=async()=>{await act(async()=>{for(let n=0;n<20&&callbacks.size;n++){const q=[...callbacks];callbacks.clear();q.forEach(([,cb])=>cb(n));}});};
 try{
 await act(async()=>root.render(<ViewportTileMap {...props}/>));await act(async()=>loaded?.());await flush();
 const surface=host.querySelector<HTMLCanvasElement>('[data-tilemap-surface]')!,input=host.querySelector<HTMLCanvasElement>('[data-tilemap-input]')!;
 expect(surface.width*surface.height).toBeLessThan(8000000);expect(input.width).toBe(1);expect(input.style.width).toBe('100%');
 expect(draw.mock.calls.length).toBeGreaterThan(1);expect(draw.mock.calls.length).toBeLessThan(9216);expect(range).toHaveBeenCalledTimes(1);
 const before=draw.mock.calls.length;await act(async()=>root.render(<ViewportTileMap {...props}/>));await flush();expect(draw).toHaveBeenCalledTimes(before);
 // Only the first call rasterises the SVG; tile copies read the cached canvas.
 expect(draw.mock.calls[1][0]).toBeInstanceOf(HTMLCanvasElement);
 await act(async()=>root.render(<ViewportTileMap {...props} layers={[layers[0].map(r=>r.map(()=>1))]}/>));await flush();expect(draw.mock.calls.length).toBeGreaterThan(before);
 }finally{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();}
});
