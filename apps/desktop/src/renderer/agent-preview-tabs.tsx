import React, {useLayoutEffect,useRef} from "react";
import {IconButton, type DocumentTab} from "@hetu/workbench-ui";
import {useObjectContextMenu} from "./text-context-menus.tsx";

/** 预览标签只管理视图，关闭预览不触及线程或内容。 */
export function AgentPreviewTabs({sessionTitle,tabs,activeId,onSelect,onClose,onKeep,onReveal,notify,children,includeSession=true}:{
  sessionTitle:string;
  tabs:DocumentTab[];activeId?:string;onSelect(id?:string):void;onClose(ids:string[]):string|undefined;onKeep(id:string):void;onReveal(id:string):void;
  notify(message:string):void;children?:React.ReactNode;includeSession?:boolean;
}) {
  const host=useRef<HTMLDivElement>(null),context=useObjectContextMenu(notify);
  const tabLayout=JSON.stringify(tabs.map(({id,title})=>[id,title]));
  useLayoutEffect(()=>{
    const element=host.current;if(!element)return;
    const reveal=()=>{
      const selected=element.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');if(!selected)return;
      const target=selected.parentElement===element?selected:selected.parentElement!;
      const bounds=element.getBoundingClientRect(),item=target.getBoundingClientRect();
      if(item.right>bounds.right)element.scrollLeft+=item.right-bounds.right;
      if(item.left<bounds.left)element.scrollLeft-=bounds.left-item.left;
    };
    reveal();const observer=new ResizeObserver(reveal);observer.observe(element);return()=>observer.disconnect();
  },[activeId,tabLayout]);
  const focus=(id?:string)=>requestAnimationFrame(()=>[...host.current?.querySelectorAll<HTMLButtonElement>("[role=tab]")??[]].find(button=>button.dataset.previewId===(id??""))?.focus({preventScroll:true}));
  const close=(ids:string[])=>focus(onClose(ids));
  function key(event:React.KeyboardEvent,id?:string){
    if(event.nativeEvent.isComposing)return;
    const ids=[...(includeSession?[undefined]:[]),...tabs.map(tab=>tab.id)],index=ids.indexOf(id);
    if(["ArrowLeft","ArrowRight","Home","End"].includes(event.key)){
      event.preventDefault();const next=event.key==="Home"?0:event.key==="End"?ids.length-1:(index+(event.key==="ArrowLeft"?-1:1)+ids.length)%ids.length;
      onSelect(ids[next]);focus(ids[next]);
    }else if(id&&(event.key==="Delete"||(event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==="w")){
      event.preventDefault();event.stopPropagation();close([id]);
    }
  }
  return <div className="agent-content-tabs" ref={host} role={includeSession?"tablist":"presentation"} aria-label={includeSession?"会话与预览":undefined}>
    {includeSession&&<button type="button" role="tab" data-preview-id="" tabIndex={activeId?-1:0} aria-selected={!activeId} onClick={()=>onSelect()} onKeyDown={event=>key(event)}>{sessionTitle}</button>}
    {tabs.map((tab,index)=><div key={tab.id} className={tab.preview?"agent-content-temporary":""}
      {...context(tab.title,[
        {id:"keep",label:"保留标签",disabled:!tab.preview,action:()=>onKeep(tab.id)},
        {id:"reveal",label:"在目录中显示",action:()=>onReveal(tab.id)},
        {id:"separator",separator:true},
        {id:"close",label:"关闭预览",action:()=>{close([tab.id]);}},
        {id:"others",label:"关闭其他预览",disabled:tabs.length<2,action:()=>{close(tabs.filter(item=>item.id!==tab.id).map(item=>item.id));}},
        {id:"right",label:"关闭右侧预览",disabled:index===tabs.length-1,action:()=>{close(tabs.slice(index+1).map(item=>item.id));}},
        {id:"all",label:"关闭所有预览",action:()=>{close(tabs.map(item=>item.id));}},
      ])}
      onMouseDown={event=>{if(event.button===1)event.preventDefault();}}
      onAuxClick={event=>{if(event.button===1){event.preventDefault();event.stopPropagation();close([tab.id]);}}}>
      <button type="button" role="tab" data-preview-id={tab.id} tabIndex={activeId===tab.id?0:-1} aria-selected={activeId===tab.id} title={tab.preview?tab.title+"，双击保留标签":tab.title}
        onClick={()=>onSelect(tab.id)} onDoubleClick={()=>onKeep(tab.id)} onKeyDown={event=>key(event,tab.id)}>{tab.title}</button>
      <IconButton icon="close" label={"关闭预览 "+tab.title} onClick={()=>close([tab.id])}/>
    </div>)}
    {children}
  </div>;
}
