import React, { useEffect, useRef, useState } from "react";
import { Icon, IconButton } from "./icons.tsx";

export function NavigationGroup({ title, active, children }: {title:string;active:boolean;children:React.ReactNode}) {
  const [open,setOpen]=useState(active);
  useEffect(()=>{if(active)setOpen(true);},[active]);
  return <details className="navigation-group" open={open} onToggle={event=>setOpen(event.currentTarget.open)}><summary>{title}</summary>{children}</details>;
}

export function WorkspaceHeader({title,kind,onNavigation,navigationMenu,switcher,children}:{title:string;kind:"novel"|"drama"|"video";onNavigation():void;navigationMenu?:React.ReactNode;switcher?:React.ReactNode;children?:React.ReactNode}) {
  const label=({novel:"小说",drama:"剧本",video:"视频"} as const)[kind];
  return <header className="workbench-topbar"><div className="sidebar-header-controls"><IconButton icon="sidebar" label="项目导航" onClick={onNavigation}/>{navigationMenu}</div>{switcher??<div className="workspace-switcher"><span className="workspace-title">{title}</span><span className="workspace-kind">{label}</span></div>}{children}</header>;
}

export interface DocumentTab {
  id: string;
  title: string;
  /** 单击打开的预览标签；双击后固定为常驻标签。 */
  preview?: boolean;
}

export function DocumentTabs({tabs, activeId, onSelect, onClose, onPin}: {
  tabs: DocumentTab[];
  activeId?: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onPin?: (id: string) => void;
}) {
  const clickTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => () => { for (const timer of clickTimers.current.values()) clearTimeout(timer); }, []);
  const selectAfterClick = (id: string) => {
    const previous = clickTimers.current.get(id);
    if (previous) clearTimeout(previous);
    clickTimers.current.set(id, setTimeout(() => {
      clickTimers.current.delete(id);
      onSelect(id);
    }, 220));
  };
  const pinAfterDoubleClick = (id: string) => {
    const pending = clickTimers.current.get(id);
    if (pending) clearTimeout(pending);
    clickTimers.current.delete(id);
    onPin?.(id);
  };
  if (!tabs.length) return null;
  return <nav className="document-tabs" aria-label="打开的文稿" role="tablist">
    {tabs.map((tab, index) => { const labelId = `document-tab-label-${index}`; return <div className="document-tab" key={tab.id} data-active={tab.id === activeId || undefined} data-preview={tab.preview ? "true" : "false"}>
      <button type="button" role="tab" id={labelId} aria-selected={tab.id === activeId} aria-label={`打开文稿 ${tab.title}`} title={tab.preview ? `预览文稿 ${tab.title}，双击固定` : `打开文稿 ${tab.title}`} onClick={() => selectAfterClick(tab.id)} onDoubleClick={() => pinAfterDoubleClick(tab.id)} onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const pending = clickTimers.current.get(tab.id);
        if (pending) clearTimeout(pending);
        clickTimers.current.delete(tab.id);
        const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowLeft" ? -1 : 1) + tabs.length) % tabs.length;
        const tabButtons = event.currentTarget.parentElement?.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]');
        onSelect(tabs[next].id);
        requestAnimationFrame(() => tabButtons?.[next]?.focus({preventScroll: true}));
      }}>{tab.title}</button>
      <button type="button" className="document-tab-close" aria-label="关闭当前文稿" aria-describedby={labelId} title={`关闭文稿 ${tab.title}`} onClick={() => onClose(tab.id)}>×</button>
    </div>; })}
  </nav>;
}
