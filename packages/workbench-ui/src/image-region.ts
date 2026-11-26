export type ImageRegion = {x:number;y:number;width:number;height:number};
export type ImageSize = {width:number;height:number};
export type ImagePoint = {x:number;y:number};

export function validImageRegion(region:ImageRegion,size:ImageSize){
 return [region.x,region.y,region.width,region.height,size.width,size.height].every(Number.isSafeInteger)
  &&size.width>0&&size.height>0&&region.x>=0&&region.y>=0&&region.width>0&&region.height>0
  &&region.x+region.width<=size.width&&region.y+region.height<=size.height;
}

/** 只在实际图片矩形内换算原图坐标，容器留白不计入区域。 */
export function imageRegionFromDrag(start:ImagePoint,end:ImagePoint,display:ImageSize,source:ImageSize):ImageRegion|undefined{
 if(![start.x,start.y,end.x,end.y,display.width,display.height,source.width,source.height].every(Number.isFinite)
  ||display.width<=0||display.height<=0||!Number.isSafeInteger(source.width)||!Number.isSafeInteger(source.height)||source.width<=0||source.height<=0)return;
 const edge=(value:number,extent:number,limit:number)=>Math.max(0,Math.min(limit,value/extent*limit));
 const x=Math.floor(edge(Math.min(start.x,end.x),display.width,source.width));
 const y=Math.floor(edge(Math.min(start.y,end.y),display.height,source.height));
 const right=Math.ceil(edge(Math.max(start.x,end.x),display.width,source.width));
 const bottom=Math.ceil(edge(Math.max(start.y,end.y),display.height,source.height));
 const region={x,y,width:right-x,height:bottom-y};
 return validImageRegion(region,source)?region:undefined;
}

export function adjustImageRegion(region:ImageRegion,size:ImageSize,key:string,resize=false):ImageRegion{
 if(!validImageRegion(region,size))return region;
 const dx=key==="ArrowLeft"?-1:key==="ArrowRight"?1:0,dy=key==="ArrowUp"?-1:key==="ArrowDown"?1:0;
 return resize?{...region,width:Math.max(1,Math.min(size.width-region.x,region.width+dx)),height:Math.max(1,Math.min(size.height-region.y,region.height+dy))}
  :{...region,x:Math.max(0,Math.min(size.width-region.width,region.x+dx)),y:Math.max(0,Math.min(size.height-region.height,region.y+dy))};
}
