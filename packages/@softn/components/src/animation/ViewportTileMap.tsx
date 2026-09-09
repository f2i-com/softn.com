import * as React from 'react';
import {isSafeUrl} from '@softn/core';
import type {TileMapProps} from './TileMap';
import {tileWindow} from './tilemap-window';

/** Keeps world geometry for input, but allocates pixels only for the clipped view. */
export const ViewportTileMap=React.memo(function ViewportTileMap(props:TileMapProps){
 const root=React.useRef<HTMLDivElement>(null),surface=React.useRef<HTMLCanvasElement>(null);
 const latest=React.useRef(props);latest.current=props;
 const image=React.useRef<HTMLCanvasElement|null>(null),dirty=React.useRef(true);
 const lastWindow=React.useRef(''),lastRange=React.useRef(''),paintCount=React.useRef(0);
 const scheduleRef=React.useRef<()=>void>(()=>{});
 const [ready,setReady]=React.useState(false);
 const {mapWidth,mapHeight,tileSize=32,scale=1,src,className,style}=props;
 React.useEffect(()=>{
  let live=true;image.current=null;dirty.current=true;setReady(false);
  if(!src||!isSafeUrl(src))return;
  const img=new window.Image();img.crossOrigin='anonymous';
  img.onload=()=>{if(!live)return;
   // Rasterise a vector tileset once, rather than once per tile on every pan.
   const atlas=document.createElement('canvas');atlas.width=img.naturalWidth;atlas.height=img.naturalHeight;
   const ctx=atlas.getContext('2d');if(!ctx)return;ctx.drawImage(img,0,0);
   image.current=atlas;dirty.current=true;setReady(true);scheduleRef.current();};
  img.src=src;
  return()=>{live=false;img.onload=null;};
 },[src]);
 React.useLayoutEffect(()=>{
  const el=root.current,canvas=surface.current;if(!el||!canvas)return;
  let disposed=false,frame=0,remaining=0,previousRect='',stable=0;
  const ancestors:HTMLElement[]=[];for(let p=el.parentElement;p;p=p.parentElement)ancestors.push(p);
  function paint(){
   if(disposed||!el||!canvas)return;
   const p=latest.current,ts=p.tileSize||32,sc=p.scale||1,rect=el.getBoundingClientRect();
   const clip={left:0,top:0,right:window.innerWidth,bottom:window.innerHeight};
   for(const parent of ancestors){
    const css=getComputedStyle(parent),x=/(hidden|clip|auto|scroll)/.test(css.overflowX),y=/(hidden|clip|auto|scroll)/.test(css.overflowY);
    if(!x&&!y)continue;const box=parent.getBoundingClientRect();
    if(x){clip.left=Math.max(clip.left,box.left);clip.right=Math.min(clip.right,box.right);}
    if(y){clip.top=Math.max(clip.top,box.top);clip.bottom=Math.min(clip.bottom,box.bottom);}
   }
   const view=tileWindow(rect,clip,p.mapWidth,p.mapHeight,ts,window.devicePixelRatio);
   const rectKey=[rect.left,rect.top,rect.width,rect.height].join(',');stable=rectKey===previousRect?stable+1:0;previousRect=rectKey;
   const range=view?{x:view.x0,y:view.y0,width:view.x1-view.x0,height:view.y1-view.y0}:{x:0,y:0,width:0,height:0};
   const rangeKey=JSON.stringify(range);
   if(rangeKey!==lastRange.current){lastRange.current=rangeKey;p.onVisibleRangeChange?.(range);}
   if(!view){if(canvas.width!==1||canvas.height!==1){canvas.width=1;canvas.height=1;}canvas.style.display='none';lastWindow.current='';dirty.current=true;return;}
   const key=JSON.stringify(view);
   if(!dirty.current&&key===lastWindow.current)return;
   const img=image.current;if(!img)return;
   const ctx=canvas.getContext('2d');if(!ctx)return;
   const start=performance.now(),cols=range.width,rows=range.height,px=view.pixels;
   const w=cols*px,h=rows*px;
   if(canvas.width!==w)canvas.width=w;if(canvas.height!==h)canvas.height=h;
   Object.assign(canvas.style,{display:'block',left:(view.x0*ts*sc)+'px',top:(view.y0*ts*sc)+'px',width:(cols*ts*sc)+'px',height:(rows*ts*sc)+'px'});
   ctx.imageSmoothingEnabled=!!p.smooth;ctx.clearRect(0,0,w,h);let tiles=0;
   for(const layer of p.layers||[]){
    for(let y=view.y0;y<view.y1;y++){const row=layer?.[y];if(!row)continue;
     for(let x=view.x0;x<view.x1;x++){const index=row[x];if(index==null||index<0)continue;
      ctx.drawImage(img,(index%(p.tilesetColumns||16))*ts,Math.floor(index/(p.tilesetColumns||16))*ts,ts,ts,(x-view.x0)*px,(y-view.y0)*px,px,px);tiles++;
     }
    }
   }
   lastWindow.current=key;dirty.current=false;paintCount.current++;
   canvas.dataset.window=rangeKey;canvas.dataset.tiles=String(tiles);canvas.dataset.paints=String(paintCount.current);canvas.dataset.renderMs=String(performance.now()-start);canvas.dataset.sourceTileSize=String(ts);
  }
  function tick(){frame=0;paint();if(!disposed&&--remaining>0&&stable<2)frame=requestAnimationFrame(tick);}
  function schedule(){if(disposed)return;remaining=16;stable=0;if(!frame)frame=requestAnimationFrame(tick);}
  scheduleRef.current=schedule;
  const resize=typeof ResizeObserver==='function'?new ResizeObserver(schedule):null;
  resize?.observe(el);for(const parent of ancestors)resize?.observe(parent);
  const mutation=typeof MutationObserver==='function'?new MutationObserver(schedule):null;
  for(const parent of ancestors)mutation?.observe(parent,{attributes:true,attributeFilter:['style','class']});
  window.addEventListener('resize',schedule);window.addEventListener('scroll',schedule,true);
  schedule();
  return()=>{disposed=true;cancelAnimationFrame(frame);resize?.disconnect();mutation?.disconnect();window.removeEventListener('resize',schedule);window.removeEventListener('scroll',schedule,true);scheduleRef.current=()=>{};};
 },[]);
 React.useLayoutEffect(()=>{dirty.current=true;scheduleRef.current();},[props.layers,mapWidth,mapHeight,tileSize,scale,props.smooth,ready]);
 return <div ref={root} className={className} data-viewport-tilemap="true" style={{position:'relative',width:mapWidth*tileSize*scale,height:mapHeight*tileSize*scale,imageRendering:props.smooth?'auto':'pixelated',...style}}>
  <canvas ref={surface} width={1} height={1} data-tilemap-surface="true" style={{position:'absolute',pointerEvents:'none'}}/>
  <canvas width={1} height={1} data-tilemap-input="true" style={{position:'absolute',inset:0,width:'100%',height:'100%',background:'transparent'}}/>
 </div>;
});
