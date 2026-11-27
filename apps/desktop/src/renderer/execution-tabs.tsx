import React, {useEffect, useLayoutEffect, useRef, useState} from "react";
import {Icon, IconButton} from "@hetu/workbench-ui";
import type {ExecutionSessionItem} from "./execution-navigation.tsx";
import {viewStorage} from "./view-storage.ts";

/** 标签关闭只改变视图，保存草稿后才切换；原执行端由既有宿主保留。 */
function savedTabs(key: string): string[] {
  try {const saved = JSON.parse(viewStorage.getItem("hetu-execution-tabs:" + key) ?? "[]"); return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string").slice(-40) : [];} catch {return [];}
}
export function useExecutionTabs(key: string, activeId: string | undefined, flush: () => Promise<void>, select: (id: string) => Promise<void>) {
  const [state, setState] = useState(() => ({key, ids: savedTabs(key), closed: false}));
  if(state.key !== key) setState({key, ids: savedTabs(key), closed: false});
  const current = useRef(state), currentKey = useRef(key), previous = useRef<{key: string; id?: string}>();
  current.current = state; currentKey.current = key;
  useEffect(() => {
    if(activeId && (previous.current?.key !== key || previous.current?.id !== activeId)) {
      setState(value => value.key !== key ? value : {...value, ids: value.ids.includes(activeId) ? value.ids : [...value.ids.slice(-39), activeId], closed: false});
    }
    previous.current = {key, id: activeId};
  }, [key, activeId]);
  useEffect(() => {viewStorage.setItem("hetu-execution-tabs:" + state.key, JSON.stringify(state.ids));}, [state.key, state.ids]);
  const check = () => {if(currentKey.current !== key) throw Error("会话所属作品或Bot已切换，请从当前侧栏重新打开。");};
  const open = async (id: string) => {check(); await select(id); check(); setState(value => value.key !== key ? value : {...value, ids: value.ids.includes(id) ? value.ids : [...value.ids.slice(-39), id], closed: false});};
  const close = async (id: string) => {
    check(); await flush(); check();
    const index = current.current.ids.indexOf(id), remaining = current.current.ids.filter(item => item !== id);
    if(id === activeId && remaining.length) await select(remaining[Math.min(Math.max(0, index), remaining.length - 1)]);
    check(); setState(value => value.key !== key ? value : {...value, ids: remaining, closed: id === activeId && !remaining.length});
  };
  return {ids: state.key === key ? state.ids : [], closed: state.key === key && state.closed, open, close};
}

export function ExecutionTabs({items, activeId, disabled, onSelect, onClose, onNew, children, label = "会话标签",newLabel="新建会话",panelId}: {
  items: ExecutionSessionItem[]; activeId?: string; disabled?: boolean;
  onSelect(id: string): void; onClose(id: string): void; onNew(): void; children?: React.ReactNode; label?: string;newLabel?:string;panelId?:string;
}) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const reveal = () => {const selected = element.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]'); if (!selected) return; const bounds = element.getBoundingClientRect(), tab = selected.parentElement!.getBoundingClientRect(); if(tab.right > bounds.right) element.scrollLeft += tab.right - bounds.right; if(tab.left < bounds.left) element.scrollLeft -= bounds.left - tab.left;};
    reveal(); const observer = new ResizeObserver(reveal); observer.observe(element); return () => observer.disconnect();
  }, [activeId, items.map(item => item.session_id).join(",")]);
  return <div className="execution-tab-strip" role="tablist" aria-label={label} onKeyDownCapture={event=>{
    if(event.nativeEvent.isComposing||!["ArrowLeft","ArrowRight","Home","End"].includes(event.key)||(event.target as HTMLElement).getAttribute("role")!=="tab")return;
    const tabs=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')].filter(tab=>!tab.disabled),index=tabs.indexOf(event.target as HTMLButtonElement);if(!tabs.length)return;
    event.preventDefault();event.stopPropagation();const next=event.key==="Home"?0:event.key==="End"?tabs.length-1:(index+(event.key==="ArrowLeft"?-1:1)+tabs.length)%tabs.length;tabs[next]?.focus();
  }}><div ref={host} className="execution-tabs" role="presentation">
    {items.map((item, index) => <div className="execution-tab" key={item.session_id} data-active={activeId === item.session_id}>
      <button type="button" id={"execution-tab-"+item.session_id} role="tab" aria-controls={panelId} aria-selected={activeId === item.session_id} title={item.title} disabled={disabled} tabIndex={activeId === item.session_id ? 0 : -1} onClick={() => onSelect(item.session_id)} onKeyDown={event => {
        if(event.nativeEvent.isComposing) return;
        if(["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowLeft" ? -1 : 1) + items.length) % items.length; host.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();}
        if((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "w") {event.preventDefault(); event.stopPropagation(); onClose(item.session_id);}
      }}><Icon name="comment" size={12}/><span>{item.title}</span></button>
      <IconButton icon="close" label={"关闭标签 " + item.title} title="关闭视图，保留原会话与后台执行" disabled={disabled} onClick={() => onClose(item.session_id)}/>
    </div>)}
  </div>{children}<IconButton icon="plus" label={newLabel} disabled={disabled} onClick={onNew}/></div>;
}
