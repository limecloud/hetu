import React, { useState } from "react";
import type { WorkRef } from "@hetu/plugin-sdk";
import { Icon, IconButton, type IconName } from "./icons.tsx";
import { WorkCoverPreview } from "./cover.tsx";
import {useContextMenu, type ContextMenuItem} from "./context-menu.tsx";

export interface LibraryAssets {
  brand: string;
  covers: readonly string[];
}
export interface LibraryWork {
  work_ref: WorkRef;
  title: string;
  author_name?: string;
  genre?: string;
  status?: string;
  archived?: boolean;
  unavailable?: boolean;
  error?: string;
  chapter_count?: number;
  updated_at?: string;
  cover_preview?: { media_type: string; base64: string };
  authorized?: boolean;
}
const kinds = [["all", "全部作品", "layers"], ["novel", "小说", "book"], ["drama", "剧本", "file"], ["video", "视频", "film"]] as const;
const states = [["all", "全部状态"], ["planning", "筹备中"], ["writing", "创作中"], ["completed", "已完成"], ["archived", "已归档"]] as const;
const creations = [["novel", "小说", "book"], ["drama", "剧本", "file"], ["video", "视频", "film"]] as const;

export function LibraryHeader({ assets, busy, onOpen, onCreate, onSettings, onPlugins, onToggleNavigation, menu }: {
  assets: LibraryAssets; busy?: boolean; onOpen(): void; onCreate(kind: WorkRef["kind"], title: string): void;
  onSettings(): void; onPlugins(): void; onToggleNavigation?(): void; menu?: React.ReactNode;
}) {
  return <header className="workbench-topbar library-topbar">
    {onToggleNavigation && <span className="library-navigation-toggle"><IconButton icon="sidebar" label="创作库导航" onClick={onToggleNavigation}/></span>}
    <div className="brand-lockup"><img className="brand-icon" src={assets.brand} alt=""/><strong role="heading" aria-level={1}>河图洛书</strong></div>
    <div className="topbar-actions">
      <IconButton icon="settings" label="本机设置" onClick={onSettings}/>
      <button disabled={busy} onClick={onOpen}>打开作品</button>
      <details className="popover-menu create-work-menu"><summary className="primary">新建作品<Icon name="chevron" size={12}/></summary><div className="menu-panel">{creations.map(([kind, title]) => <button key={kind} disabled={busy} onClick={() => onCreate(kind, title)}>让 AI 新建{title}</button>)}</div></details>
      <details className="popover-menu topbar-more"><summary aria-label="更多操作" title="更多操作"><Icon name="more"/></summary><div className="menu-panel"><button disabled={busy} onClick={onOpen}>打开作品</button>{menu}<button disabled={busy} onClick={onPlugins}>创作插件</button><button onClick={onSettings}>本机设置</button></div></details>
    </div>
  </header>;
}

export function LibraryNavigation({ kind, active, busy, onKind, onPlugins }: {
  kind: string; active: string; busy?: boolean; onKind(kind: string): void; onPlugins(): void;
}) {
  return <>{kinds.map(([id, label, icon]) => <button key={id} disabled={busy} className={kind === id && active === "library" ? "selected" : ""} aria-current={kind === id && active === "library" ? "page" : undefined} onClick={() => onKind(id)}><Icon name={icon}/>{label}</button>)}
    <div className="navigation-divider"/>
    <button disabled={busy} className={active === "plugins" ? "selected" : ""} aria-current={active === "plugins" ? "page" : undefined} onClick={onPlugins}><Icon name="plugin"/>创作插件</button>
  </>;
}

/** 同一作品投影和表现组件；权限、读取及交接由各宿主回调执行。 */
export function LibraryContent({ works, assets, appearance = "system", kind, busy = false, loading = false, error, initialListMode = true, emptyTitle = "还没有作品", emptyMessage, onKind, onOpen, onCreate, onSelect, onRefresh, contextItems, onContextError }: {
  works: LibraryWork[]; assets: LibraryAssets; appearance?: string; kind: string; busy?: boolean; loading?: boolean;
  initialListMode?: boolean; emptyTitle?: string; emptyMessage?: string; onKind(kind: string): void;
  error?: string;
  contextItems?: (work: LibraryWork) => ContextMenuItem[]; onContextError?: (error: Error) => void;
  onOpen(): void; onCreate(kind: WorkRef["kind"], title: string): void; onSelect(work: LibraryWork): void; onRefresh(): void;
}) {
  const [search, setSearch] = useState(""), [status, setStatus] = useState("all"), [listChoice, setList] = useState<boolean>();
  const showMenu = useContextMenu();
  const menu = (event: React.MouseEvent | React.KeyboardEvent, item: LibraryWork) => {if (contextItems) showMenu(event, item.title, contextItems(item), {onError: onContextError});};
  const list=listChoice??initialListMode;
  const visible = works.filter(item => (kind === "all" || item.work_ref.kind === kind) &&
    (status === "all" || item.status === status || (status === "archived" && item.archived)) &&
    [item.title, item.author_name, item.genre].filter(Boolean).join(" ").toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <div className="content library-content" aria-busy={loading || busy}>
    <div className="library-search-row"><div className="library-page-heading"><details className="popover-menu"><summary aria-label="新建创作" title="新建创作"><Icon name="plus" size={18}/></summary><div className="menu-panel">{creations.map(([type,title]) => <button key={type} disabled={busy} onClick={() => onCreate(type,title)}>新建{title}</button>)}</div></details><h1 id="library-title">{kind === "all" ? "创作库" : kinds.find(item => item[0] === kind)?.[1] ?? "创作库"}</h1><span className="muted">{visible.length}</span></div><IconButton icon="refresh" label="刷新创作库" disabled={busy || loading} onClick={onRefresh}/>
      <select aria-label="创作状态筛选" value={status} onChange={event => setStatus(event.target.value)}>{states.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <label className="library-search"><Icon name="search"/><input aria-label="搜索作品" placeholder="搜索作品" value={search} onChange={event => setSearch(event.target.value)}/></label>
      <div className="segmented-control" aria-label="创作库布局"><IconButton icon="list" label="列表视图" aria-pressed={list} onClick={() => setList(true)}/><IconButton icon="grid" label="封面视图" aria-pressed={!list} onClick={() => setList(false)}/></div>
    </div>
    {error ? <div className="empty" role="alert"><p>{error}</p><button onClick={onRefresh} disabled={busy}>重新读取创作库</button></div> : loading ? <p className="empty" role="status">正在连接河图…</p> : works.length ? <div className={"library-works" + (list ? "" : " library-grid")}>{visible.map(item => <button onContextMenu={event => menu(event, item)} onKeyDown={event => {if (!event.nativeEvent.isComposing && (event.key === "ContextMenu" || event.shiftKey && event.key === "F10")) menu(event, item);}} className="work" aria-label={`打开作品 ${item.title}`} data-work-kind={item.work_ref.kind} key={[item.work_ref.workspace_id, item.work_ref.kind, item.work_ref.object_id].join(":")} disabled={busy || item.unavailable} onClick={() => onSelect(item)}>
      <div className="work-thumbnail"><WorkCoverPreview work={item.work_ref} title={item.title} author={item.author_name} compact={list || item.work_ref.kind !== "novel"} preview={item.cover_preview} error={item.unavailable ? item.error : ""} defaultCovers={assets.covers}/></div>
      <div className="library-work-description"><strong>{item.title}</strong>{(item.author_name || item.genre) && <small>{[item.author_name, item.genre].filter(Boolean).join(" ")}</small>}</div>
      {item.unavailable && <span>{item.error}</span>}<span className="pill">{{ novel: "小说", drama: "剧本", video: "视频" }[item.work_ref.kind]}</span>{item.authorized===false&&<small className="muted">需作品授权</small>}
      <div className="library-work-metrics">{item.status && <span className="library-work-status">{states.find(state => state[0] === item.status)?.[1]}</span>}{item.chapter_count !== undefined && <small className="library-work-count">{item.chapter_count} 章</small>}</div>
      {item.updated_at && <small className="library-work-date">{new Date(item.updated_at).toLocaleDateString()}</small>}
    </button>)}</div> : <div className="library-empty"><h2>{emptyTitle}</h2>{emptyMessage && <p>{emptyMessage}</p>}<div className="library-start-options">{creations.map(([type, title, icon]) => <button key={type} disabled={busy} onClick={() => onCreate(type, title)}><Icon name={icon as IconName} size={24}/><span>新建{title}</span><Icon name="chevron" size={14}/></button>)}</div><button className="library-open-existing" disabled={busy} onClick={onOpen}><Icon name="file"/>打开已有作品</button></div>}
    {!!works.length && !visible.length && <div className="empty"><Icon name="search" size={28}/><h2>没有匹配的作品</h2><button onClick={() => { onKind("all"); setSearch(""); setStatus("all"); }}>清除筛选</button></div>}
  </div>;
}
