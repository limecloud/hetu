import React,{useEffect,useId,useRef,useState} from "react";
import {adjustImageRegion,imageRegionFromDrag,validImageRegion,type ImagePoint,type ImageRegion,type ImageSize} from "./image-region.ts";

/** 图片只作固定版本预览；区域选择不裁切、生成或保存图片。 */
export function ImageRegionPreview({src,title,width,height,value,disabled,onChange,onSelect,language="zh-CN"}:{
 src:string;title:string;width:number;height:number;value?:ImageRegion;disabled?:boolean;language?:"zh-CN"|"en";
 onChange?(region:ImageRegion|undefined):void;onSelect?(region:ImageRegion):void;
}){
 const image=useRef<HTMLImageElement>(null),surface=useRef<HTMLDivElement>(null),id=useId();
 const [active,setActive]=useState(false),[ready,setReady]=useState(false),[failed,setFailed]=useState(false),[draft,setDraft]=useState<ImageRegion>();
 const [frame,setFrame]=useState({left:0,top:0,width:0,height:0});
 const drag=useRef<{id:number;start:ImagePoint}>();
 const size:ImageSize={width,height},english=language==="en";
 const labels=english?{mark:"Mark region",clear:"Remove region",select:"Comment on this region",canvas:"Image feedback region",error:"Image preview unavailable",help:"Drag within the image. Enter creates a region. Arrow keys move it; Shift and arrow keys resize it. Escape cancels dragging; Delete removes the region."}
  :{mark:"标记区域",clear:"移除区域",select:"对此区域提意见",canvas:"图片意见区域",error:"图片预览不可用",help:"在图片内拖动。Enter建立区域，方向键移动，Shift加方向键调整尺寸，Escape取消拖动，Delete移除区域。"};
 useEffect(()=>{
  const node=image.current;if(!node)return;
  const measure=()=>{
   const rect=node.getBoundingClientRect(),ratio=node.naturalWidth/node.naturalHeight;
   if(!ratio||!rect.width||!rect.height){setFrame({left:0,top:0,width:0,height:0});return;}
   const shownWidth=Math.min(rect.width,rect.height*ratio),shownHeight=shownWidth/ratio;
   setFrame({left:(rect.width-shownWidth)/2,top:(rect.height-shownHeight)/2,width:shownWidth,height:shownHeight});
  };
  const loaded=()=>{setReady(node.naturalWidth>0);setFailed(false);measure();};
  setActive(false);setDraft(undefined);drag.current=undefined;setFailed(false);setReady(node.complete&&node.naturalWidth>0);
  const observer=new ResizeObserver(measure);observer.observe(node);node.addEventListener("load",loaded);measure();
  return()=>{observer.disconnect();node.removeEventListener("load",loaded);};
 },[src,width,height]);
 useEffect(()=>{if(disabled){drag.current=undefined;setDraft(undefined);}},[disabled]);
 const editable=!!onChange&&!disabled&&ready&&!failed,shown=draft??value;
 const region=shown&&validImageRegion(shown,size)?shown:undefined;
 function point(event:React.PointerEvent<HTMLDivElement>){const box=event.currentTarget.getBoundingClientRect();return {x:event.clientX-box.left,y:event.clientY-box.top};}
 function cancel(event:React.PointerEvent<HTMLDivElement>){if(drag.current?.id!==event.pointerId)return;drag.current=undefined;setDraft(undefined);}
 function centered():ImageRegion{const x=Math.floor(width/4),y=Math.floor(height/4);return {x,y,width:Math.max(1,Math.floor(width/2)),height:Math.max(1,Math.floor(height/2))};}
 return <div className="image-region-preview">
  <div className="image-region-picture">
   <img ref={image} className="image-region-image" src={src} alt={title} draggable={false} onError={()=>{setReady(false);setFailed(true);drag.current=undefined;setDraft(undefined);}}/>
   {ready&&!failed&&frame.width>0&&<div ref={surface} className="image-region-surface" role="group" aria-label={labels.canvas} aria-describedby={id} tabIndex={active&&editable?0:-1} data-active={active&&editable} style={frame}
    onPointerDown={event=>{if(!active||!editable||event.button!==0)return;event.preventDefault();event.currentTarget.focus();drag.current={id:event.pointerId,start:point(event)};setDraft(undefined);event.currentTarget.setPointerCapture(event.pointerId);}}
    onPointerMove={event=>{if(!editable||drag.current?.id!==event.pointerId)return;setDraft(imageRegionFromDrag(drag.current.start,point(event),frame,size));}}
    onPointerUp={event=>{if(!editable||drag.current?.id!==event.pointerId)return;const start=drag.current.start,end=point(event);drag.current=undefined;setDraft(undefined);if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);if(Math.hypot(end.x-start.x,end.y-start.y)<2)return;const next=imageRegionFromDrag(start,end,frame,size);if(next)onChange?.(next);}}
    onPointerCancel={cancel} onLostPointerCapture={cancel}
    onKeyDown={event=>{
     if(!active||!editable||event.nativeEvent.isComposing)return;
     if(event.key==="Escape"){event.preventDefault();event.stopPropagation();drag.current=undefined;setDraft(undefined);setActive(false);return;}
     if(["Delete","Backspace"].includes(event.key)){event.preventDefault();onChange?.(undefined);return;}
     if(event.key==="Enter"||event.key===" "){event.preventDefault();if(!value)onChange?.(centered());return;}
     if(event.key.startsWith("Arrow")){event.preventDefault();onChange?.(adjustImageRegion(value??centered(),size,event.key,event.shiftKey));}
    }}>
    {region&&<span className="image-region-selection" style={{left:`${region.x/width*100}%`,top:`${region.y/height*100}%`,width:`${region.width/width*100}%`,height:`${region.height/height*100}%`}}/>}
   </div>}
  </div>
  <span id={id} className="image-region-help">{labels.help}</span>
  {failed&&<p role="alert">{labels.error}</p>}
  {onChange&&<div className="image-region-tools">
   <button type="button" aria-pressed={active} disabled={!editable} onClick={()=>{setActive(!active);if(!active)requestAnimationFrame(()=>surface.current?.focus());}}>{labels.mark}</button>
   {value&&<button type="button" disabled={disabled} onClick={()=>{drag.current=undefined;setDraft(undefined);onChange(undefined);}}>{labels.clear}</button>}
   {value&&onSelect&&<button type="button" disabled={!editable} onClick={()=>{setActive(false);onSelect(value);}}>{labels.select}</button>}
  </div>}
  {(onChange||region)&&<p className="image-region-position" role={region?"status":undefined}>{region?<>{english?"Original image region":"原图区域"} {region.x}, {region.y}　{region.width} × {region.height} px</>:null}</p>}
 </div>;
}
