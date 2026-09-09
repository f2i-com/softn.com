export interface TileWindow { x0:number; y0:number; x1:number; y1:number; pixels:number; }
export interface MapRect { left:number; top:number; width:number; height:number; }
export interface ClipRect { left:number; top:number; right:number; bottom:number; }
/** Tile-aligned overscan, screen-density sampling and a hard backing-store budget. */
export function tileWindow(rect:MapRect, clip:ClipRect, width:number, height:number, tileSize:number, dpr:number):TileWindow|null {
 if (!(rect.width>0&&rect.height>0&&width>0&&height>0&&tileSize>0)) return null;
 const left=Math.max(rect.left,clip.left),top=Math.max(rect.top,clip.top),right=Math.min(rect.left+rect.width,clip.right),bottom=Math.min(rect.top+rect.height,clip.bottom);
 if(right<=left||bottom<=top)return null;
 const tx=rect.width/width,ty=rect.height/height,margin=96,block=4;
 const x0=Math.max(0,Math.floor((left-rect.left-margin)/tx/block)*block), y0=Math.max(0,Math.floor((top-rect.top-margin)/ty/block)*block);
 const x1=Math.min(width,Math.ceil((right-rect.left+margin)/tx/block)*block), y1=Math.min(height,Math.ceil((bottom-rect.top+margin)/ty/block)*block);
 const cols=x1-x0,rows=y1-y0;
 const density=Math.min(2,Math.max(1,Number.isFinite(dpr)?dpr:1));
 const pixels=Math.max(1,Math.min(tileSize,Math.ceil(Math.max(tx,ty)*density),Math.floor(Math.sqrt(8000000/(cols*rows))),Math.floor(8192/cols),Math.floor(8192/rows)));
 return {x0,y0,x1,y1,pixels};
}
