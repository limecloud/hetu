import React, { useEffect, useState } from "react";
import { Icon, IconButton } from "./icons.tsx";

export function NavigationGroup({ title, active, children }: {title:string;active:boolean;children:React.ReactNode}) {
  const [open,setOpen]=useState(active);
  useEffect(()=>{if(active)setOpen(true);},[active]);
  return <details className="navigation-group" open={open} onToggle={event=>setOpen(event.currentTarget.open)}><summary>{title}</summary>{children}</details>;
}

export function WorkspaceHeader({title,kind,onNavigation,navigationMenu,switcher,children}:{title:string;kind:"novel"|"drama"|"video";onNavigation():void;navigationMenu?:React.ReactNode;switcher?:React.ReactNode;children?:React.ReactNode}) {
  return <header className="workbench-topbar"><div className="sidebar-header-controls"><IconButton icon="sidebar" label="项目导航" onClick={onNavigation}/>{navigationMenu}</div>{switcher??<div className="workspace-switcher"><span className="workspace-title">{title}</span><span className="workspace-kind">{{novel:"小说",drama:"剧本",video:"视频"}[kind]}</span></div>}{children}</header>;
}
