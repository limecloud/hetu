import React,{useEffect,useRef} from "react";
import {IconButton} from "@hetu/workbench-ui";

export type ContextSelection={page:string;object:Record<string,unknown>;label:string};
export function ContextPickerDialog({title,disabled=false,onClose,children,className=""}:{title:string;disabled?:boolean;onClose():void;children:React.ReactNode;className?:string}){
 const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{const element=dialog.current!;element.showModal();return()=>element.close();},[]);
 return <dialog ref={dialog} className={"agent-context-picker"+(className?" "+className:"")} aria-label={title} onCancel={event=>{event.preventDefault();if(!disabled)onClose();}}>
  <header><h2>{title}</h2><IconButton icon="close" label="关闭上下文选择" disabled={disabled} onClick={onClose}/></header>
  <div className="agent-context-picker-body">{children}</div>
 </dialog>;
}
