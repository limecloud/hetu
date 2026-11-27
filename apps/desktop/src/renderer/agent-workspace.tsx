import React, { useEffect, useRef, useState } from "react";
import type { WorkRef } from "@hetu/plugin-sdk";
import type {SessionLaunch} from "../agent-session-contract.ts";
import type {AgentWorkChoice} from "./agent-business.tsx";
import { AgentSession } from "./agent-session.tsx";
import { Icon } from "./workbench.tsx";
import type {ExecutionLayout} from "./execution-navigation.tsx";

/** 会话保持挂载，收起仅隐藏；线程与业务范围由主进程持有。 */
export function AgentWorkspace({work,visible,full,width,maxWidth,onWidth,onClose,onExpand,notify,maximized,fullscreen,onMaximize,onFullscreen,navigationVisible,onNavigation,navigationWidth,onNavigationWidth,onLibrary,onWorkSurface,works,onScope,onLaunch,onRuntimeChange}: {
  works?:AgentWorkChoice[];onScope?(work?:WorkRef):Promise<void>;onLaunch?(launch:SessionLaunch,work?:WorkRef):Promise<boolean>;
  work?:WorkRef;visible:boolean;full:boolean;width:number;maxWidth:number;
  onWidth(width:number):void;onClose():void;onExpand():void;notify(message:string):void;
  maximized:boolean;fullscreen:boolean;onMaximize():void;onFullscreen?():void;navigationVisible:boolean;onNavigation(visible?:boolean):void;
  navigationWidth:number;onNavigationWidth(width:number):void;onLibrary():void;
  onWorkSurface?(page:string):Promise<void>;
  onRuntimeChange?(open:boolean):void;
}) {
  const [visited,setVisited]=useState(visible), [dragging,setDragging]=useState(false);
  const drag=useRef<{x:number;width:number}>();
  const separator=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(visible)setVisited(true);},[visible]);
  useEffect(()=>()=>{document.body.style.removeProperty("cursor");},[]);
  const change=(next:number)=>onWidth(Math.round(Math.max(360,Math.min(maxWidth,next))));
  const end=()=>{drag.current=undefined;setDragging(false);document.body.style.removeProperty("cursor");};
  const layout:ExecutionLayout={full,navigationVisible,navigationWidth,onNavigation,onNavigationWidth,onLibrary,onWorkSurface,onScope,works:works??[],work};
  return <section className={"agent-workspace"+(full?" agent-workspace-full":"")+(dragging?" agent-workspace-dragging":"")} role={full?"main":"complementary"} aria-label="终端工作区" hidden={!visible} style={full?undefined:{width}}>
    {!full && <div ref={separator} className="agent-workspace-resize" role="separator" aria-label="调整终端侧栏宽度" aria-orientation="vertical" aria-valuemin={360} aria-valuemax={maxWidth} aria-valuenow={width} tabIndex={0}
      onPointerDown={event=>{if(event.button!==0)return;drag.current={x:event.clientX,width};event.currentTarget.setPointerCapture(event.pointerId);setDragging(true);document.body.style.cursor="col-resize";event.preventDefault();}}
      onPointerMove={event=>{if(drag.current)change(drag.current.width+drag.current.x-event.clientX);}}
      onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end} onDoubleClick={()=>change(420)}
      onKeyDown={event=>{if(["ArrowLeft","ArrowRight","Home","End"].includes(event.key)){event.preventDefault();change(event.key==="Home"?360:event.key==="End"?maxWidth:width+(event.key==="ArrowLeft"?20:-20));}}}/ >}
    {visited && <AgentSession layout={layout} works={works} onScope={onScope} onLaunch={onLaunch} onRuntimeChange={onRuntimeChange} work={work} notify={notify} ai={()=>{}} maximized={maximized} controls={<details className="popover-menu"><summary aria-label="工作区布局" title="工作区布局"><Icon name="maximize" size={14}/></summary><div className="menu-panel">
      <button onClick={onMaximize}>{maximized?"还原终端布局":"最大化终端"}</button>
      {onFullscreen&&<button onClick={onFullscreen}>{fullscreen?"退出全屏":"全屏显示"}</button>}
      <button onClick={onExpand}>{full?"并排查看作品":"展开终端工作区"}</button>
      <button onClick={onClose}>关闭终端面板</button>
    </div></details>}/ >}
  </section>;
}
