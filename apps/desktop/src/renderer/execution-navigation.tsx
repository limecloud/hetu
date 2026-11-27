import React, {createContext, useContext, useEffect, useRef, useState} from "react";
import {sameWork, type WorkRef} from "@hetu/plugin-sdk";
import {Icon, IconButton, NavigationResize} from "@hetu/workbench-ui";
import type {AgentWorkChoice} from "./agent-business.tsx";
import {workChoiceKey} from "./agent-business.tsx";
import {viewStorage} from "./view-storage.ts";
import {desktop} from "./bridge.ts";
import "./execution-workspace.css";

export type ExecutionLayout = {
  full: boolean;
  navigationVisible: boolean;
  navigationWidth: number;
  onNavigation(visible?:boolean): void;
  onNavigationWidth(width: number): void;
  onLibrary(): void;
  onScope?(work?: WorkRef): Promise<void>;
  onWorkSurface?(page:string):Promise<void>;
  works: AgentWorkChoice[];
  work?: WorkRef;
};
export type ExecutionSessionItem = {session_id: string; title: string};
export type BotNavigationItem = {id: string; name: string; purpose: string; status: string};
export type ExecutionNavigationProps = {
  layout: ExecutionLayout;
  active: "sessions" | "bots" | "computer";
  sessions: ExecutionSessionItem[];
  sessionId?: string;
  bots: BotNavigationItem[];
  botId?: string;
  botSessions?: ExecutionSessionItem[];
  botSessionId?: string;
  busy?: boolean;
  error?: string;
  onSession(id: string): Promise<void>;
  onBot(id: string): Promise<void>;
  onBotSession?(id: string): Promise<void>;
  onSessions(): void;
  onBots(): void;
  onNewBot(): void;
  onComputer(): void;
  onRefresh(): void;
  notify(message: string): void;
};
type NavigationState={query:string;setQuery(value:string):void;botsOpen:boolean;setBotsOpen(value:boolean):void;worksOpen:boolean;setWorksOpen(value:boolean):void};
const NavigationContext=createContext<NavigationState|undefined>(undefined);
export function ExecutionNavigationProvider({children}:{children:React.ReactNode}) {
  const [query,setQuery]=useState(""),[botsOpen,setBotsOpen]=useState(()=>viewStorage.getItem("hetu-execution-bots-open")!=="false"),[worksOpen,setWorksOpen]=useState(()=>viewStorage.getItem("hetu-execution-works-open")!=="false");
  useEffect(()=>viewStorage.setItem("hetu-execution-bots-open",String(botsOpen)),[botsOpen]);
  useEffect(()=>viewStorage.setItem("hetu-execution-works-open",String(worksOpen)),[worksOpen]);
  return <NavigationContext.Provider value={{query,setQuery,botsOpen,setBotsOpen,worksOpen,setWorksOpen}}>{children}</NavigationContext.Provider>;
}

/** 普通会话和Bots使用同一导航结构；列表只定位原记录，不持有执行事实。 */
export function ExecutionNavigation(props: ExecutionNavigationProps) {
  const {layout, active, sessions, sessionId, bots, botId, botSessions = [], botSessionId, busy, error, notify} = props;
  const context=useContext(NavigationContext);
  if(!context)throw Error("会话导航缺少所属工作面。");
  const {query,setQuery,botsOpen,setBotsOpen,worksOpen,setWorksOpen}=context;
  const input = useRef<HTMLInputElement>(null);
  const matches = (title: string) => title.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  const invoke = (action: () => Promise<void>) => { void action().catch(error => notify(error.message)); };
  useEffect(() => {
    if (!layout.full) return;
    const find = (event: KeyboardEvent) => {
      if (event.defaultPrevented || input.current?.closest('[inert],[aria-hidden="true"]') || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k" || document.querySelector("dialog[open]")) return;
      event.preventDefault();
      if (!layout.navigationVisible) layout.onNavigation(true);
      requestAnimationFrame(() => input.current?.focus());
    };
    window.addEventListener("keydown", find);
    return () => window.removeEventListener("keydown", find);
  }, [layout.full, layout.navigationVisible]);
  if (!layout.full) return null;
  const currentSessions = sessions.filter(item => matches(item.title));
  const works = layout.works.filter(item => !item.archived && (matches(item.title) || !!layout.work && sameWork(layout.work,item.work_ref) && currentSessions.length>0));
  return <>
    {layout.navigationVisible && <button className="execution-navigation-backdrop" aria-label="关闭会话导航" onClick={()=>layout.onNavigation(false)}/>}
    <aside className="execution-navigation" aria-label="会话导航" hidden={!layout.navigationVisible} style={{"--execution-navigation-width": `${layout.navigationWidth}px`} as React.CSSProperties} onKeyDown={event=>{if(event.key==="Escape"&&!event.defaultPrevented&&!event.nativeEvent.isComposing&&innerWidth<760){event.preventDefault();event.stopPropagation();layout.onNavigation(false);}}}>
      <header className="execution-navigation-header"><strong>河图洛书</strong><IconButton icon="sidebar" label="折叠左侧栏" onClick={()=>layout.onNavigation(false)}/></header>
      <div className="execution-search"><Icon name="search" size={14}/><input ref={input} type="search" aria-label="搜索 bots、作品和会话" placeholder="搜索" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if(event.key === "Escape" && query) {event.preventDefault(); event.stopPropagation(); setQuery("");} }}/><kbd aria-hidden>{navigator.platform.includes("Mac") ? "⌘" : "Ctrl"} K</kbd></div>
      <nav className="execution-navigation-scroll" aria-label="会话与作品">
        <button className="execution-nav-entry" disabled={busy} onClick={layout.onLibrary}><Icon name="book"/>创作库</button>
        <button className="execution-nav-entry" aria-current={active === "sessions" ? "page" : undefined} disabled={busy} onClick={props.onSessions}><Icon name="comment"/>会话</button>
        <section className="execution-nav-group">
          <header><button className="execution-group-toggle" aria-label="Bots" aria-expanded={botsOpen || !!query} onClick={() => {if(active !== "bots") props.onBots(); else setBotsOpen(!botsOpen);}}><Icon name="chevron" size={12}/><span>Bots</span></button><IconButton icon="plus" label="新建 bot" disabled={busy} onClick={props.onNewBot}/></header>
          {(botsOpen || query) && <div>{bots.filter(item => matches(item.name + " " + item.purpose)).map(bot => <div key={bot.id}>
            <button className="external-bot-row" aria-current={botId === bot.id ? "true" : undefined} disabled={busy} onClick={() => invoke(() => props.onBot(bot.id))}><span className="bot-avatar" aria-hidden>{Array.from(bot.name)[0]}</span><span><strong>{bot.name}</strong><small>{bot.status === "active" ? bot.purpose : bot.status === "paused" ? "已停用" : "已归档"}</small></span><span className="execution-status-dot" data-state={bot.status} aria-label={bot.status === "active" ? "已启用" : bot.status === "paused" ? "已停用" : "已归档"}/></button>
            {botId === bot.id && botSessions.map(item => <button className="execution-nav-session bot-sidebar-chat" key={item.session_id} aria-current={botSessionId === item.session_id ? "true" : undefined} disabled={busy} onClick={() => invoke(() => props.onBotSession!(item.session_id))}><Icon name="comment" size={12}/><span>{item.title}</span></button>)}
          </div>)}{!bots.length && !error && <p className="execution-nav-empty">还没有 bots</p>}</div>}
        </section>
        <section className="execution-nav-group execution-work-group">
          <header><button className="execution-group-toggle" aria-label="作品" aria-expanded={worksOpen || !!query} onClick={() => setWorksOpen(!worksOpen)}><Icon name="chevron" size={12}/><span>作品</span></button></header>
          {(worksOpen || query) && <div>
            {matches("创作库筹备") && <button className="execution-nav-entry" aria-current={!layout.work && active === "sessions" ? "true" : undefined} disabled={busy} onClick={() => invoke(() => layout.onScope?.() ?? Promise.resolve())}><Icon name="folder" size={14}/><span>创作库筹备</span></button>}
            {!layout.work && currentSessions.map(item => <button key={item.session_id} className="execution-nav-session" disabled={busy} aria-current={active === "sessions" && item.session_id === sessionId ? "true" : undefined} onClick={() => invoke(() => props.onSession(item.session_id))}><Icon name="terminal" size={12}/><span>{item.title}</span></button>)}
            {works.map(item => <div key={workChoiceKey(item.work_ref)}><button className="execution-nav-entry" aria-current={active==="sessions" && layout.work && sameWork(layout.work, item.work_ref) ? "true" : undefined} disabled={busy || item.unavailable} onClick={() => invoke(() => layout.onScope?.(item.work_ref) ?? Promise.resolve())}><Icon name={item.work_ref.kind === "novel" ? "book" : item.work_ref.kind === "video" ? "film" : "file"} size={14}/><span>{item.title}</span></button>
              {layout.work&&sameWork(layout.work,item.work_ref)&&layout.onWorkSurface&&<><button className="execution-nav-session" disabled={busy} onClick={()=>invoke(()=>layout.onWorkSurface!("work.profile"))}><Icon name="file" size={12}/><span>作品资料</span></button><button className="execution-nav-session" disabled={busy} onClick={()=>invoke(()=>layout.onWorkSurface!(item.work_ref.kind==="novel"?"novel.reader":item.work_ref.kind==="drama"?"drama.reader":"video.review"))}><Icon name={item.work_ref.kind==="video"?"film":"book"} size={12}/><span>{item.work_ref.kind==="novel"?"小说":item.work_ref.kind==="drama"?"剧本":"视频"}</span></button></>}
              {layout.work && sameWork(layout.work, item.work_ref) && currentSessions.map(session => <button key={session.session_id} className="execution-nav-session" disabled={busy} aria-current={active === "sessions" && session.session_id === sessionId ? "true" : undefined} onClick={() => invoke(() => props.onSession(session.session_id))}><Icon name="terminal" size={12}/><span>{session.title}</span></button>)}
            </div>)}
          </div>}
        </section>
        {error && <div className="execution-nav-error" role="alert"><p>{error}</p><button onClick={props.onRefresh}>重新读取</button></div>}
      </nav>
      <footer><IconButton icon="settings" label="本机设置" onClick={() => void desktop.settingsWindow("open").catch(error => notify(error.message))}/><IconButton icon="shield" label="计算机控制" aria-pressed={active === "computer"} onClick={props.onComputer}/><span/><IconButton icon="refresh" label="刷新会话导航" disabled={busy} onClick={props.onRefresh}/></footer>
      <NavigationResize width={layout.navigationWidth} onWidth={layout.onNavigationWidth} onCollapse={()=>layout.onNavigation(false)}/>
    </aside>
  </>;
}
