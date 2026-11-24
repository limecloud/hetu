import {InterfaceScale} from "./interface-scale.tsx";
import { newerPreferences, usePopoverMenus } from "@hetu/workbench-ui";
import { documentSelectionKey, viewStorage } from "./view-storage.ts";
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { desktop, requestAgent } from "./bridge.ts";
import { AgentWorkspace } from "./agent-workspace.tsx";
import { surfaces } from "./contributions.tsx";
import { Preferences, applyPreferences, useEffectiveAppearance, watchPreferences } from "./preferences.tsx";
import { LocalSettings } from "./settings.tsx";
import { Icon, IconButton, Workbench, PageActionsTarget, type DocumentTools, type IconName, type AgentStatus } from "./workbench.tsx";
import { WorkCover } from "./work-cover.tsx";
import { LibraryHeader, LibraryNavigation, LibraryContent, NavigationGroup, WorkspaceHeader, DocumentTabs, WorkSidebar, NavigationResize, navigationWidth, clampNavigationWidth, type SidebarLayer, type SidebarPanel, type LibraryAssets, type DocumentTab } from "@hetu/workbench-ui";
import {SidebarDirectory, SidebarTasks, SidebarAttachments} from "./work-sidebar-panels.tsx";
import {ResourceReading, type ResourceSelection} from "./resource-reading.tsx";
import {ContextMenuProvider} from "@hetu/workbench-ui";
import {TextContextMenus} from "./text-context-menus.tsx";
const libraryAssets: LibraryAssets = (window as any).hetuWorkbenchAssets ?? {brand:"app-icon.png",covers:["cover-river-jade.jpg","cover-cloud-rose.jpg","cover-stars-ink.jpg"]};
import { PluginMigrations } from "./plugin-migrations.tsx";
import { PluginResults } from "./plugin-results.tsx";
import { AuditStatus } from "./audit-status.tsx";
import { sameWork } from "@hetu/plugin-sdk";

/** 作品入口固定先到资料页；正文、分集及视频成果由资料页明确进入。 */
const workNavigationOrder = {
  profile: ["work.profile"],
  materials: ["novel.outlines", "work.canon", "work.images", "work.resources", "work.media"],
  collaboration: ["work.tasks", "work.links", "work.management", "work.agent"],
  versions: ["work.versions", "work.import", "work.delivery"],
} as const;
function workEntrySurface(): string { return workNavigationOrder.profile[0]; }

function App() {
  const [settingsOpen,setSettingsOpen]=useState(false);
  const embeddedSettings=useRef<HTMLDialogElement>(null);
  useEffect(()=>{if(settingsOpen)embeddedSettings.current?.showModal();},[settingsOpen]);
  useEffect(()=>{const listener=(event:Event)=>setSettingsOpen((event as CustomEvent).detail==="open");window.addEventListener("hetu:settings-window",listener);return()=>window.removeEventListener("hetu:settings-window",listener);},[]);
  const [state, setRawState] = useState<any>({ plugins: [], views: [] }),
    [works, setWorks] = useState<any[]>([]),
    [active, setActive] = useState("library"),
    [notice, setNotice] = useState(""),
    [operationBusy, setBusy] = useState(false),
    [agentStatus, setAgentStatus] = useState<AgentStatus>({ state: "idle" });
  const setState = useCallback((next: any) => setRawState((current: any) => {
    const value = typeof next === "function" ? next(current) : next;
    return {...value, preferences: newerPreferences(current.preferences ?? {}, value.preferences ?? current.preferences ?? {})};
  }), []);
  const [initializing, setInitializing] = useState(true);
  const [agentOpen,setAgentOpen]=useState(false),[agentExpanded,setAgentExpanded]=useState(true);
  const [agentMaximized,setAgentMaximized]=useState(false),[agentMaximizedNavigation,setAgentMaximizedNavigation]=useState(false);
  const [windowFullscreen,setWindowFullscreen]=useState(false);
  const fullscreenReturn=useRef<boolean>();
  useEffect(()=>{void desktop.fullscreen?.("get").then(setWindowFullscreen).catch(error=>setNotice(error.message));return desktop.onWindowChrome?.(value=>{if(value.fullscreen!==undefined)setWindowFullscreen(value.fullscreen);});},[]);
  useEffect(()=>{if(windowFullscreen){if(fullscreenReturn.current===undefined)fullscreenReturn.current=agentMaximized;setAgentMaximized(true);}else if(fullscreenReturn.current!==undefined){setAgentMaximized(fullscreenReturn.current);fullscreenReturn.current=undefined;}},[windowFullscreen]);
  useEffect(()=>{if(agentMaximized)setAgentMaximizedNavigation(false);},[agentMaximized]);
  const [agentWidth,setAgentWidth]=useState(()=>Math.max(360,Math.min(800,Number(viewStorage.getItem("hetu-agent-width"))||420)));
  const [windowWidth,setWindowWidth]=useState(window.innerWidth);
  const agentReturn=useRef("work.profile");
  useEffect(()=>{const resize=()=>setWindowWidth(window.innerWidth);window.addEventListener("resize",resize);return()=>window.removeEventListener("resize",resize);},[]);
  useEffect(()=>{viewStorage.setItem("hetu-agent-width",String(agentWidth));},[agentWidth]);
  useEffect(()=>{if(!["work.agent","codex.library"].includes(active))agentReturn.current=active;},[active]);
  const busy = initializing || operationBusy;
  const appearance = useEffectiveAppearance();
  const [kind, setKind] = useState("all");
  const [navigationVisible, setNavigationVisible] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = viewStorage.getItem("hetu-sidebar-width");
    return saved === null ? navigationWidth.initial : clampNavigationWidth(Number(saved));
  });
  useEffect(() => viewStorage.setItem("hetu-sidebar-width", String(sidebarWidth)), [sidebarWidth]);
  const [sidebarLayer, setSidebarLayer] = useState<SidebarLayer>("document");
  const [sidebarPanel, setSidebarPanel] = useState<SidebarPanel>("directory");
  const [attachment, setAttachment] = useState<ResourceSelection>();
  const attachmentTrigger = useRef<HTMLButtonElement>();
  const closeAttachment = () => {
    setAttachment(undefined);
    requestAnimationFrame(() => {
      const trigger = attachmentTrigger.current;
      if (trigger?.isConnected && trigger.getClientRects().length) trigger.focus({preventScroll: true});
      else document.querySelector<HTMLElement>('main:not([hidden]) .manuscript-stage, .sidebar-header-controls button')?.focus({preventScroll: true});
    });
  };
  useEffect(() => {setAttachment(undefined);}, [state.work?.workspace_id, state.work?.kind, state.work?.object_id]);
  const [directoryVisible, setDirectoryVisible] = useState(true);
  const [directoryTarget, setDirectoryTarget] = useState<HTMLDivElement | null>(null);
  const [searchTarget, setSearchTarget] = useState<HTMLDivElement | null>(null);
  const [inspector, setInspector] = useState(false);
  const [focus, setFocus] = useState(false);
  const [documentTools, setDocumentTools] = useState<DocumentTools>();
  const [documentTabs, setDocumentTabs] = useState<DocumentTab[]>([]);
  const [activeDocumentId, setActiveDocumentId] = useState<string>();
  const [pageActionsTarget, setPageActionsTarget] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 760px)");
    const collapse = () => { if (narrow.matches) setNavigationVisible(false); };
    collapse(); narrow.addEventListener("change", collapse);
    return () => narrow.removeEventListener("change", collapse);
  }, []);
  useLayoutEffect(() => {
    if ((!navigationVisible || focus) && document.activeElement?.closest(".project-navigation"))
      document.querySelector<HTMLElement>("main .manuscript-stage")?.focus({preventScroll: true});
  }, [navigationVisible, focus]);
  useEffect(() => {
    const refresh = () => { void desktop.library("refresh").then(value => { setState(value); setWorks(value.works ?? []); }).catch(error => setNotice(error.message)); };
    window.addEventListener("hetu:work-changed", refresh);
    const unsubscribe=desktop.onAgentSession(event=>{if(event.type==="notification"&&["turn/completed","results/verified"].includes(event.method))refresh();});
    return () => {window.removeEventListener("hetu:work-changed", refresh);unsubscribe();};
  }, []);
  const surface = useRef<HTMLDivElement>(null);
  const pluginReturn = useRef("plugins");
  const pluginReturning = useRef(false);
  const pluginView = state.views.find((view: any) => view.key === active);
  const pluginActive = !!pluginView;
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setNotice("");
    try {
      await fn();
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void (async () => {
      const initial = await desktop.state();
      setState(initial);
      setWorks(initial.works ?? []);
      try {
        const current = await desktop.library("refresh");
        setState(current);
        setWorks(current.works ?? []);
        const initial=(window as any).hetuWorkbenchInitial;
        if(initial?.work_ref&&current.works?.some((item:any)=>sameWork(item.work_ref,initial.work_ref))){
          await desktop.library("open",{work_ref:initial.work_ref});
          const selected=await desktop.select(initial.work_ref);setState(selected);setWorks(selected.works??[]);
          setActive(initial.task_id ? "work.tasks" : workEntrySurface());
          setSidebarLayer("project");
          if(initial.task_id)setAgentStatus({state:"waiting_for_audit",taskId:initial.task_id});
        }
      } catch (error) {
        setNotice((error as Error).message);
      }
    })().catch(error => setNotice(error.message)).finally(() => setInitializing(false));
  }, []);
  useEffect(
    () =>
      watchPreferences((value) =>
        setState((current: any) => ({ ...current, preferences: newerPreferences(current.preferences ?? {}, value) })),
      ),
    [],
  );
  useEffect(() => {
    if (state.preferences) applyPreferences(state.preferences);
  }, [state.preferences]);
  useEffect(() => desktop.onPluginsChanged(value => {
    setState(value);
    if (pluginActive) {
      setActive(pluginReturn.current);
      setNotice("插件状态已更新，可重新打开工作面。恢复稿已保留。");
    }
  }), [pluginActive]);
  useEffect(() => {
    if (!surface.current) return;
    const element = surface.current;
    const report = () => {
      const r = element.getBoundingClientRect();
      void desktop.bounds({ x: r.x, y: r.y, width: r.width, height: r.height });
    };
    const observer = new ResizeObserver(report);
    observer.observe(element);
    window.addEventListener("resize", report);
    report();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", report);
    };
  }, [active]);
  const navigate = async (id: string, documentId?: string) => {
    if (documentTools?.dirty && id !== active) throw new Error("请先保存当前修改，再切换工作面。");
    await desktop.closeSurface();
    setAttachment(undefined);
    if (documentId && state.work) viewStorage.setItem(documentSelectionKey(state.work), documentId);
    if (state.work) setSidebarLayer(id === "novel.reader" || id === "drama.reader" || id === "work.profile" ? "document" : "project");
    setActive(id);
  };
  const registerDocumentTab = useCallback((tab: DocumentTab | undefined) => {
    if (!tab) return;
    const next = {...tab, preview: tab.preview ?? true};
    setDocumentTabs(current => {
      const same = current.findIndex(item => item.id === next.id);
      if (same >= 0) return current.map((item, index) => index === same ? {...item, ...next, preview: item.preview === false ? false : next.preview} : item);
      const preview = current.findIndex(item => item.preview);
      if (preview >= 0) return current.map((item, index) => index === preview ? next : item);
      return [...current, next];
    });
    setActiveDocumentId(tab.id);
  }, []);
  const pinDocumentTab = useCallback((documentId: string) => {
    setDocumentTabs(current => current.map(tab => tab.id === documentId ? {...tab, preview: false} : tab));
  }, []);
  const openDocument = async (documentId: string) => {
    if (!state.work || state.work.kind === "video") return;
    if (documentTools?.dirty) throw new Error("请先保存当前修改，再打开关联正文。");
    await navigate(state.work.kind === "novel" ? "novel.reader" : "drama.reader", documentId);
    setActiveDocumentId(documentId);
    setDirectoryVisible(true);
    setSidebarLayer("document"); setSidebarPanel("directory");
    setFocus(false);
    setNavigationVisible(!window.matchMedia("(max-width: 760px)").matches);
  };
  const closeDocumentTab = async (documentId: string) => {
    if (documentTools?.dirty) throw new Error("请先保存当前修改，再关闭文稿标签。");
    const index = documentTabs.findIndex(tab => tab.id === documentId);
    if (index < 0) return;
    const remaining = documentTabs.filter(tab => tab.id !== documentId);
    const next = remaining[index] ?? remaining[index - 1];
    setDocumentTabs(remaining);
    if (documentId === activeDocumentId && next) await openDocument(next.id);
    else if (documentId === activeDocumentId) { setActiveDocumentId(undefined); await navigate("work.profile"); }
  };
  const openPlugin = async (view: { key: string; owner: string; id: string }) => {
    const previous = active;
    await navigate(view.key);
    pluginReturn.current = previous;
    try {
      await desktop.view(view.owner, view.id);
    } catch (error) {
      await desktop.closeSurface();
      setActive(previous);
      throw error;
    }
  };
  async function selectLibraryWork(item: {work_ref: import("@hetu/plugin-sdk").WorkRef}, target?: string) {
    await desktop.library("open", {work_ref: item.work_ref});
    const next = await desktop.select(item.work_ref); setState(next);
    const surface = target ?? workEntrySurface();
    setNavigationVisible(!window.matchMedia("(max-width: 760px)").matches);
    setSidebarLayer(surface === "novel.reader" || surface === "drama.reader" || surface === "work.profile" ? "document" : "project");
    setSidebarPanel("directory");
    setFocus(false);
    setActive(surface);
  }
  async function selectAgentWork(target?:import("@hetu/plugin-sdk").WorkRef,launch?:import("../agent-session-contract.ts").SessionLaunch){
    if(documentTools?.dirty)throw new Error("请先保存当前修改，再切换作品。");
    if(target&&!works.some(item=>!item.unavailable&&!item.archived&&sameWork(item.work_ref,target)))throw new Error("作品未在当前创作库中，请刷新后重试。");
    let next=state;
    if(target){await desktop.library("open",{work_ref:target});next=await desktop.select(target);}
    try{if(launch)await desktop.agentSession("new",{...(target?{work_ref:target}:{scope:"library"}),launch});}
    finally{setState(next);setActive(target?"work.agent":"codex.library");setAgentOpen(true);setAgentExpanded(true);}
  }
  useEffect(() => desktop.onClosePlugin(value => {
    if (!pluginView || value.owner !== pluginView.owner || value.view !== pluginView.id || value.epoch !== state.epoch || pluginReturning.current) return;
    pluginReturning.current = true;
    void run(async () => {
      try { await navigate(pluginReturn.current); }
      finally { pluginReturning.current = false; }
    });
  }), [active, state.epoch]);
  useEffect(() => desktop.onOpenWork(value => {
    if (!pluginActive || value.epoch !== state.epoch || !state.work || !sameWork(value.work_ref, state.work)) return;
    const target = value.target === "profile" ? "work.profile" : value.target === "canon" ? "work.canon" : value.target === "manuscript" ? ({novel:"novel.reader",drama:"drama.reader",video:"video.review"}[state.work.kind as "novel"]) : undefined;
    if (target) void run(() => navigate(target));
  }), [active, state.epoch]);
  useEffect(() => desktop.onOpenDocument?.(value => {
    if (!state.work || !sameWork(value.work_ref, state.work)) return;
    void run(() => openDocument(value.document_id));
  }), [state.work, documentTools?.dirty]);
  useEffect(()=>{
    const open=(event:Event)=>{const value=(event as CustomEvent).detail;if(!state.work||!value?.work_ref||!sameWork(value.work_ref,state.work))return;void run(async()=>{if(documentTools?.dirty)throw new Error("请先保存当前修改，再打开预览内容。");if(value.document_id)await openDocument(value.document_id);else {if(["work.agent","codex.library"].includes(active))await navigate("work.resources");setAttachment({resource_id:value.resource_id,revision:value.revision,title:value.title});}setAgentOpen(false);setAgentExpanded(true);});};
    window.addEventListener("hetu:agent-document",open);window.addEventListener("hetu:agent-resource",open);return()=>{window.removeEventListener("hetu:agent-document",open);window.removeEventListener("hetu:agent-resource",open);};
  },[state.work,documentTools?.dirty,active]);
  useEffect(() => { const open = (event:Event) => { const ref=(event as CustomEvent).detail?.work_ref;if(ref&&state.work&&sameWork(ref,state.work)){setAgentOpen(true);setAgentExpanded(true);} };window.addEventListener("hetu:agent-open",open);return()=>window.removeEventListener("hetu:agent-open",open); },[state.work]);
  useEffect(()=>{
    const open=(event:Event)=>{const result=(event as CustomEvent).detail as import("../session-results.ts").SessionResult;
      if(result.state!=="verified")return;
      if(result.kind!=="work"&&(!state.work||!sameWork(result.work_ref,state.work)))return;
      void run(async()=>{
        if(documentTools?.dirty)throw new Error("请先保存当前修改，再打开会话成果。");
        if(result.kind==="work"){await selectLibraryWork({work_ref:result.work_ref});const next=await desktop.library("refresh");setState(next);setWorks(next.works??[]);}
        else if(result.kind==="document")await openDocument(result.reference.document_id);
        else if(result.kind==="resource"){await navigate("work.resources");setAttachment({resource_id:result.reference.resource_id,revision:result.reference.revision,title:result.title});}
        else if(result.kind==="submission"){await navigate("work.tasks");setAgentStatus({state:"waiting_for_audit",taskId:result.reference.task_ref.task_id,submissionId:result.reference.submission_ref.submission_id});}
        else if(result.kind==="bundle")await navigate("work.delivery");
        setAgentOpen(false);setAgentExpanded(false);
      });
    };
    window.addEventListener("hetu:session-result",open);return()=>window.removeEventListener("hetu:session-result",open);
  },[state.work,documentTools?.dirty,active]);
  const ai = async (object?: Record<string, unknown>) => {
    await requestAgent(active, object);
    setNotice(desktop.agentSessionHost ? "已放入当前会话草稿，请核对后发送。" : "已准备当前作品的协作请求，请在所选 Agent 中继续。");
  };
  const items = surfaces
    .list()
    .filter(({ value }) => value.kinds.includes(state.work?.kind))
    .filter(({id}) => id !== "work.agent" || desktop.agentSessionHost !== false);
  const contribution = items.find((item) => item.id === active)?.value;
  const Component = contribution?.component;
  const selected = works.find(
    (item) => JSON.stringify(item.work_ref) === JSON.stringify(state.work),
  );
  const title =
    active === "library"
      ? "创作库"
      : active === "plugins"
        ? "创作插件"
        : active === "settings"
          ? "本机设置"
          : active.startsWith("fallback:")
            ? "插件成果"
            : (contribution?.title ??
                state.views.find((v: any) => v.key === active)?.title ??
                "创作工作面");
  const readerActive = active === "novel.reader" || active === "drama.reader";
  const workMode = !!state.work && active !== "library" && active !== "codex.library";
  const agentRoute=active==="work.agent" || active==="codex.library";
  const agentVisible=desktop.agentSessionHost!==false && (agentOpen || agentRoute);
  useEffect(()=>{if(agentVisible)void desktop.maximize?.().catch(error=>setNotice(error.message));},[agentVisible]);
  const agentAvailable=windowWidth-(navigationVisible&&!focus?sidebarWidth+8:0);
  const agentFull=agentVisible && (agentRoute || agentExpanded || agentAvailable<960);
  const shellNavigationVisible=agentFull&&agentMaximized?agentMaximizedNavigation:navigationVisible;
  const shellFocus=focus&&!agentFull;
  const toggleAgentNavigation=()=>{
    if(agentMaximized)setAgentMaximizedNavigation(value=>!value);else setNavigationVisible(value=>!value);
    requestAnimationFrame(()=>[...document.querySelectorAll<HTMLButtonElement>('.terminal-project-header button[aria-label="折叠左侧栏"], .agent-workspace button[aria-label="展开左侧栏"]')].find(button=>button.checkVisibility())?.focus({preventScroll:true}));
  };
  useEffect(()=>{void desktop.windowLayout?.(agentFull?"terminal":"default").catch(error=>setNotice(error.message));},[agentFull]);
  const agentNavigation=useRef<{active:string;layer:SidebarLayer}>();
  useEffect(()=>{if(agentFull){agentNavigation.current={active,layer:sidebarLayer};setSidebarLayer("project");}else if(agentNavigation.current){if(agentNavigation.current.active===active)setSidebarLayer(agentNavigation.current.layer);agentNavigation.current=undefined;}},[agentFull]);
  const agentMaximum=Math.max(360,agentAvailable-600);
  const agentDockWidth=Math.max(360,Math.min(agentWidth,agentMaximum));
  const closeAgent=()=>{setAgentOpen(false);setAgentExpanded(false);if(agentRoute)void run(()=>navigate(workMode?agentReturn.current==="library"?"work.profile":agentReturn.current:"library"));};
  const expandAgent=()=>{if(agentRoute){setAgentOpen(true);setAgentExpanded(false);void run(()=>navigate(workMode?agentReturn.current==="library"?"work.profile":agentReturn.current:"library"));}else setAgentExpanded(value=>!value);};
  useEffect(() => { setDocumentTabs([]); setActiveDocumentId(undefined); }, [state.work?.workspace_id, state.work?.kind, state.work?.object_id]);
  useEffect(() => { document.title = workMode ? selected?.title ?? "河图洛书" : "河图洛书"; }, [workMode, selected?.title]);
  const labels: Record<string, [string, IconName]> = {
    "work.profile": ["作品资料", "file"], "novel.reader": ["小说", "book"],
    "novel.outlines": ["作品大纲", "file"], "drama.reader": ["剧本", "file"], "video.review": ["视频", "film"],
    "work.tasks": ["参考稿审核", "shield"], "work.links": ["关联作品", "link"],
    "work.canon": ["作品设定", "layers"], "work.images": ["图片成果", "image"],
    "work.resources": ["资料与素材", "file"], "work.media": ["素材与线索", "image"],
    "work.versions": ["文稿版本", "branch"], "work.import": ["原稿导入", "file"],
    "work.delivery": ["作品交付", "export"], "work.management": ["管理方案", "shield"],
    "work.agent": ["Agent 协作", "sparkles"],
  };
  const navItem = (id: string) => {
    const item = items.find((item) => item.id === id);
    if (!item) return null;
    const [label, icon] = labels[id] ?? [item.value.title, "file"];
    return <button key={id} disabled={busy} className={active === id ? "selected" : ""} aria-current={active === id ? "page" : undefined}
      onClick={() => void run(() => navigate(id))}><Icon name={icon}/><span>{label}</span></button>;
  };
  const activeIn = (ids: readonly string[]) => ids.includes(active);
  const globalItem = (id: string, label: string, icon: IconName) => <button disabled={busy} className={active === id ? "selected" : ""}
    onClick={() => void run(() => navigate(id))}><Icon name={icon}/><span>{label}</span></button>;
  const openWorkspace = () => run(async () => {
    const next = await desktop.open();
    if (next) { setState(next); setWorks(next.works); setActive("library"); }
  });
  const createWork = (type: string, name: string) => run(async () => {
    if(desktop.agentSessionHost && desktop.promptDelivery){const request=await desktop.library("bootstrap",{kind:type,delivery:"draft"});await desktop.promptDelivery.send(request.prompt,"draft");setActive("codex.library");}
    else await desktop.library("bootstrap", { kind: type });
    setNotice(desktop.agentSessionHost?"新建"+name+"请求已放入当前会话草稿，核对后发送；作品尚未创建。":"已准备新建" + name + "请求，请在所选 Agent 中继续；作品尚未创建。Agent 完成后刷新创作库。其间可以继续处理其他作品。");
  });
  return (
    <Preferences.Provider value={state.preferences ?? {}}>
    <PageActionsTarget.Provider value={pageActionsTarget}>
    <Workbench.Provider value={{ sidebarLayer, setSidebarLayer, sidebarPanel, setSidebarPanel, directoryTarget, searchTarget, navigationVisible, setNavigationVisible, directoryVisible, setDirectoryVisible, inspector, setInspector, focus, setFocus, setDocumentTools, setDocumentTab: registerDocumentTab, pinDocumentTab, agentStatus, setAgentStatus }}>
      {pluginActive && desktop.windowControls?.titlebarInset && <div className="plugin-window-chrome" aria-hidden="true"/>}
      {!pluginActive && !agentFull && !workMode && <LibraryHeader assets={libraryAssets} busy={busy} onOpen={() => void openWorkspace()} onCreate={(type, title) => void createWork(type, title)} onSettings={() => void desktop.settingsWindow("open")} onPlugins={() => void run(() => navigate("plugins"))} onToggleNavigation={() => setNavigationVisible(!navigationVisible)} menu={<>{desktop.agentSessionHost !== false && <button onClick={() => setActive(active === "codex.library" ? "library" : "codex.library")}>打开终端工作区</button>}<label>
                    外部 Agent{" "}
                    <select
                      aria-label="创作库协作客户端"
                      value={state.agentClient ?? "codex"}
                      disabled={busy}
                      onChange={(e) =>
                        void run(async () =>
                          setState(
                            await desktop.library("client", {
                              client: e.target.value,
                            }),
                          ),
                        )
                      }
                    >
                      <option value="codex">Codex</option>
                      <option value="claude-code">Claude Code</option>
                      <option value="workbuddy">WorkBuddy</option>
                      <option value="generic">其他客户端</option>
                    </select>
                  </label><InterfaceScale language={state.preferences?.language}/></>}/> }
      {!pluginActive && !agentFull && workMode && <WorkspaceHeader title={selected?.title ?? "当前作品"} kind={state.work.kind} onNavigation={() => {setNavigationVisible(!navigationVisible || focus); setFocus(false);}} navigationMenu={
        <details className="popover-menu sidebar-display-menu"><summary aria-label="侧栏显示" title="侧栏显示"><Icon name="chevron" size={12}/></summary><div className="menu-panel">
          <button aria-pressed={focus} onClick={() => setFocus(!focus)}>{focus ? "退出专注模式" : "启用专注模式"}</button>
          <hr/><span className="menu-caption">显示</span>
          <button aria-pressed={sidebarLayer === "project"} onClick={() => {setSidebarLayer("project"); setNavigationVisible(true); setFocus(false);}}>项目导航</button>
          <button aria-pressed={sidebarLayer === "document"} onClick={() => {setSidebarLayer("document"); setNavigationVisible(true); setFocus(false);}}>当前作品</button>
        </div></details>} switcher={
          <details className="workspace-switcher popover-menu">
            <summary><span className="workspace-title">{selected?.title ?? "当前作品"}</span><span className="workspace-kind">{{ novel: "小说", drama: "剧本", video: "视频" }[state.work.kind as "novel"]}</span><Icon name="chevron" size={12}/></summary>
            <div className="menu-panel">
              <button disabled={busy} onClick={() => void run(() => navigate("library"))}>返回创作库</button>
              <button disabled={busy} onClick={() => void openWorkspace()}>打开作品</button>
              {works.filter((item) => !item.unavailable).map((item) => <button key={item.work_ref.object_id} disabled={busy} onClick={() => void run(async () => {
                if (documentTools?.dirty) throw new Error("请先保存当前修改。");
                await desktop.library("open", { work_ref: item.work_ref });
                setState(await desktop.select(item.work_ref));
                setActive(workEntrySurface());
                setSidebarLayer("document");
              })}>{item.title}</button>)}
            </div>
          </details>}>
          {readerActive && !agentFull && <IconButton icon="list" label={state.work.kind === "drama" ? "分集目录" : "卷章目录"} aria-pressed={sidebarLayer === "document" && sidebarPanel === "directory" && navigationVisible && !focus} onClick={() => { const open = sidebarLayer !== "document" || sidebarPanel !== "directory" || !navigationVisible || focus; setSidebarLayer("document"); setSidebarPanel("directory"); setDirectoryVisible(true); setNavigationVisible(open); setFocus(false); }}/ >}
          {readerActive && !agentFull && <DocumentTabs tabs={documentTabs} activeId={activeDocumentId} onSelect={id => void run(() => openDocument(id))} onPin={pinDocumentTab} onClose={id => void run(() => closeDocumentTab(id))}/>}
        <div className="topbar-actions">
          {desktop.agentSessionHost!==false && !agentRoute && <IconButton icon="sparkles" label={agentOpen?"收起终端会话":"打开终端会话"} aria-pressed={agentOpen} onClick={()=>{setAgentOpen(value=>!value);setAgentExpanded(true);}}/>}
          {workMode && !agentFull && !attachment && !active.startsWith("fallback:") && (readerActive || !Component) &&
            <button className="ai-button" disabled={busy || readerActive && !!documentTools?.composing} aria-label="让 AI 处理" onClick={() => void run(async () => { if (readerActive && documentTools) documentTools.ai(); else await ai(); })}>
              <Icon name="sparkles"/><span>让 AI 处理</span>
            </button>
          }
          {readerActive && !agentFull && !attachment && documentTools && <span className="save-state" aria-live="polite"><Icon name="check" size={13}/>{documentTools.readOnly ? documentTools.busy ? "正在读取…" : "参考稿 只读" : documentTools.composing ? "正在输入…" : documentTools.busy ? "正在保存…" : documentTools.dirty ? "有未保存修改" : "修订已保存"}</span>}
          <IconButton icon="settings" label="本机设置" onClick={() => void desktop.settingsWindow("open")}/>
          {workMode && desktop.windowControls?.zoom !== false && <IconButton icon="expand" label="缩放窗口" onClick={() => void desktop.zoom()}/>}
          {readerActive && !agentFull && !attachment && documentTools && <>
            <button className="primary" disabled={documentTools.busy || documentTools.composing || !documentTools.dirty} onClick={documentTools.save}>保存修订</button>
          </>}
          <details className="popover-menu topbar-more"><summary aria-label="更多操作" title="更多操作"><Icon name="more"/></summary><div className="menu-panel">
            <button disabled={busy} onClick={() => void openWorkspace()}>打开作品</button>
            {readerActive && <button aria-pressed={focus} onClick={() => setFocus(!focus)}>{focus ? "退出专注" : "专注阅读"}</button>}


            <InterfaceScale language={state.preferences?.language}/>
            <button disabled={busy} onClick={() => void run(() => navigate("plugins"))}>创作插件</button>
            <button onClick={() => void desktop.settingsWindow("open")}>本机设置</button>
          </div></details>
        </div>
      </WorkspaceHeader>}
      <div style={{"--navigation-width": `${sidebarWidth}px`} as React.CSSProperties} className={"layout" + (workMode ? " workspace-layout" : " library-layout") + (!shellNavigationVisible || shellFocus ? " navigation-hidden" : "") + (shellFocus ? " focus-mode" : "") + (agentVisible?" agent-open":"") + (agentFull?" agent-full":"")+(agentFull&&agentMaximized?" agent-immersive":"")}>
        {!pluginActive && shellNavigationVisible && !shellFocus && <button className="navigation-backdrop" aria-label="关闭导航浮层" onClick={agentFull?toggleAgentNavigation:()=>setNavigationVisible(false)}/>}
        {!pluginActive && <aside className="project-navigation" aria-label={workMode ? "项目导航" : "创作库导航"}>
          {agentFull&&<header className="terminal-project-header"><span>河图洛书</span><IconButton icon="sidebar" label="折叠左侧栏" onClick={toggleAgentNavigation}/></header>}
          {workMode ? <WorkSidebar layer={sidebarLayer} panel={sidebarPanel} onLayer={setSidebarLayer} onPanel={panel => {setAttachment(undefined); setSidebarPanel(panel); setDirectoryVisible(true);}}
            title={selected?.title ?? "当前作品"} updatedAt={selected?.updated_at} subtitle={{novel:"小说",drama:"剧本",video:"视频"}[state.work.kind as "novel"]}
            cover={<WorkCover work={state.work} title={selected?.title ?? "当前作品"} compact/>} onProfile={() => void run(() => navigate("work.profile"))} profileActive={active === "work.profile"} project={<>
            <button className="back-library" disabled={busy} onClick={() => void run(() => navigate("library"))}><Icon name="back" size={13}/>返回创作库</button>
            <div className="navigation-scroll">
              {workNavigationOrder.profile.map(navItem)}
              <NavigationGroup title="创作资料" active={activeIn(workNavigationOrder.materials)}>{workNavigationOrder.materials.map(navItem)}</NavigationGroup>
              <NavigationGroup title="协作与审核" active={activeIn(workNavigationOrder.collaboration)}>
                {workNavigationOrder.collaboration.map(navItem)}
              </NavigationGroup>
              <div className="navigation-divider"/>
              {navItem(state.work.kind === "novel" ? "novel.reader" : state.work.kind === "drama" ? "drama.reader" : "video.review")}
              <NavigationGroup title="版本与交付" active={activeIn(workNavigationOrder.versions)}>{workNavigationOrder.versions.map(navItem)}</NavigationGroup>
              <NavigationGroup title="本机与扩展" active={["plugins"].includes(active)}>{globalItem("plugins", "创作插件", "plugin")}</NavigationGroup>
            </div>
            </>}>
            <div role="tabpanel" id="sidebar-panel-directory" aria-labelledby="sidebar-tab-directory" hidden={sidebarPanel !== "directory"}>
              {readerActive ? <div ref={setDirectoryTarget} className="navigation-directory"/> : <SidebarDirectory work={state.work} onOpen={documentId => void run(() => openDocument(documentId))}/>}
            </div>
            <div role="tabpanel" id="sidebar-panel-tasks" aria-labelledby="sidebar-tab-tasks" hidden={sidebarPanel !== "tasks"}>
              <SidebarTasks notify={setNotice} key={JSON.stringify(state.work)} work={state.work} active={sidebarLayer === "document" && sidebarPanel === "tasks"} onAI={() => void run(() => requestAgent("work.tasks"))} onOpen={taskId => void run(async () => {await navigate("work.tasks"); setAgentStatus({state:"waiting_for_audit",taskId});})}/>
            </div>
            <div role="tabpanel" id="sidebar-panel-attachments" aria-labelledby="sidebar-tab-attachments" hidden={sidebarPanel !== "attachments"}>
              <SidebarAttachments key={JSON.stringify(state.work)} work={state.work} active={sidebarLayer === "document" && sidebarPanel === "attachments"} notify={setNotice} selected={attachment} onOpen={(item, trigger) => {attachmentTrigger.current = trigger; setAttachment(item); if (window.matchMedia("(max-width: 760px)").matches) setNavigationVisible(false);}} onNavigate={id => void run(() => navigate(id))}/>
            </div>
            <div role="tabpanel" id="sidebar-panel-search" aria-labelledby="sidebar-tab-search" hidden={sidebarPanel !== "search"}>
              {readerActive ? <div ref={setSearchTarget} className="navigation-search"/> : <><div className="sidebar-panel-heading"><strong>查找</strong></div><p className="sidebar-empty">{state.work.kind === "video" ? "请在视频目录中选择需要查看的成果。" : "打开正文后查找当前稿件或整部作品。"}</p><button onClick={() => void run(() => navigate(state.work.kind === "novel" ? "novel.reader" : state.work.kind === "drama" ? "drama.reader" : "video.review"))}><Icon name="search"/>打开{state.work.kind === "video" ? "视频" : "正文"}</button></>}
            </div>
          </WorkSidebar> : <LibraryNavigation kind={kind} active={active} busy={busy} onKind={id => { setKind(id); void run(() => navigate("library")); }} onPlugins={() => void run(() => navigate("plugins"))}/>
          }
          {agentFull&&<footer className="terminal-project-footer"><IconButton icon="settings" label="本机设置" onClick={()=>void desktop.settingsWindow("open")}/></footer>}
        </aside>}
        {!pluginActive && shellNavigationVisible && !shellFocus && <NavigationResize width={sidebarWidth} onWidth={setSidebarWidth} onCollapse={() => {
          if(agentFull&&agentMaximized){setAgentMaximizedNavigation(false);return;}
          setNavigationVisible(false);
          document.querySelector<HTMLElement>('.sidebar-header-controls button, .library-navigation-toggle button')?.focus({preventScroll: true});
        }}/>}
        <main
          hidden={!!attachment}
          className={pluginActive ? "plugin-page" : readerActive ? "reader-main" : "page-main"}
          aria-labelledby={!pluginActive && active === "library" ? "library-title" : undefined}
          aria-label={pluginActive ? "插件工作区" : readerActive ? "文稿工作区" : active === "library" ? undefined : "工作台内容"}
          aria-busy={busy || initializing ? "true" : undefined}
        >
          {pluginActive && pluginView.navigation !== "integrated" && <nav className="plugin-page-navigation" aria-label="插件页面导航"><button disabled={busy} aria-label="返回工作台" onClick={() => void run(() => navigate(pluginReturn.current))}><Icon name="back" size={14}/>返回</button></nav>}
          {!pluginActive && active !== "library" && !readerActive && !Component && !active.startsWith("fallback:") && <div className="toolbar"><div><h1>{title}</h1></div>{active === "plugins" && <button disabled={busy} onClick={() => void run(async () => setState(await desktop.install()))}>安装插件包</button>}</div>}
          {!pluginActive && active !== "work.tasks" && <AuditStatus
            state={agentStatus.state}
            message={agentStatus.message}
            onReview={() => void run(() => navigate("work.tasks"))}
          />}
          {active === "codex.library" || active === "work.agent" ? null : active === "library" ? (
            <LibraryContent works={works} assets={libraryAssets} appearance={appearance} kind={kind} busy={busy} loading={initializing} initialListMode={state.preferences?.library_list ?? false} onKind={setKind} onOpen={() => void openWorkspace()} onCreate={(type,title) => void createWork(type,title)} onRefresh={() => void run(async () => { const next=await desktop.library("refresh"); setState(next); setWorks(next.works ?? []); })} onSelect={item => void run(() => selectLibraryWork(item))} onContextError={error => setNotice(error.message)} contextItems={item => [
              {id: "open", label: "打开", disabled: busy || item.unavailable, action: () => run(() => selectLibraryWork(item))},
              {id: "profile", label: "作品资料", disabled: busy || item.unavailable, action: () => run(() => selectLibraryWork(item, "work.profile"))},
              {id: "copy-title", label: "复制名称", action: () => desktop.copy(item.title)},
              {id: "review", separator: true},
              {id: "history", label: "版本历史", disabled: busy || item.unavailable || item.work_ref.kind === "video", action: () => run(() => selectLibraryWork(item, "work.versions"))},
              {id: "export", label: "作品交付", disabled: busy || item.unavailable || item.work_ref.kind === "video", action: () => run(() => selectLibraryWork(item, "work.delivery"))},
              {id: "archive", label: item.archived ? "从废纸篓恢复" : "移入废纸篓", disabled: busy || item.unavailable, action: () => run(async () => {
                await desktop.library("archive", {work_ref: item.work_ref, archived: !item.archived});
                const next = await desktop.library("refresh"); setState(next); setWorks(next.works ?? []);
              })},
            ]}/>
          ) : active === "plugins" ? (
            <div className="content plugin-content">
              {state.plugin_state_error && <p role="alert">{state.plugin_state_error} 请保留原文件后修复。基础创作仍可使用。</p>}
              {!state.plugins.length && !state.plugin_state_error && <div className="empty"><Icon name="plugin" size={28}/><p>还没有安装插件</p></div>}
              {state.plugins.map((plugin: any) => (
                <React.Fragment key={plugin.id}>
                <div className="row">
                  <div>
                    <strong>{plugin.display["zh-CN"]}</strong>
                    <p className="muted">{plugin.description["zh-CN"]}</p>
                    <span className="pill">
                      {plugin.reason ??
                        (
                          {
                            active: "已启用",
                            disabled: "已停用",
                            blocked: "依赖未就绪",
                            installed: "已安装",
                            uninstalled: "已卸载",
                            unavailable: "插件包不可用",
                            failed: "清理失败",
                          } as Record<string, string>
                        )[plugin.state]}{" "}
                      {plugin.version}
                    </span>
                    <span className="muted"> {plugin.work_kinds?.map((kind: string) => ({ novel: "小说", drama: "剧本", video: "视频" })[kind as "novel"]).join("、") ?? "全部作品"}</span>
                  </div>
                  <div className="actions">
                    {plugin.installed && (
                      <>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void run(async () =>
                              setState(
                                await desktop.toggle(
                                  plugin.id,
                                  plugin.state !== "active",
                                ),
                              ),
                            )
                          }
                        >
                          {plugin.state === "active" ? "停用" : "启用"}
                        </button>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void run(async () =>
                              setState(await desktop.uninstall(plugin.id)),
                            )
                          }
                        >
                          卸载
                        </button>
                      </>
                    )}
                    {state.work && (
                      <button
                        onClick={() =>
                          void run(() => navigate("fallback:" + plugin.id))
                        }
                      >
                        读取成果
                      </button>
                    )}
                  </div>
                </div>
                {state.work && <PluginMigrations key={JSON.stringify(state.work) + plugin.version} plugin={plugin} />}
                </React.Fragment>
              ))}
            </div>
          ) : active.startsWith("fallback:") ? (
            <div className="content workbench-page"><PluginResults key={active + state.epoch} owner={active.slice(9)}
              title={state.plugins.find((plugin: any) => plugin.id === active.slice(9))?.display["zh-CN"] ?? "插件"}
              enabled={state.plugins.some((plugin: any) => plugin.id === active.slice(9) && plugin.state === "active")}
              back={() => void run(() => navigate("plugins"))}/></div>
          ) : Component ? (
            <div className={readerActive ? "content manuscript-content" : "content workbench-page"} data-surface={active}>
              {!readerActive && active !== "work.agent" && <div className="surface-heading"><h1>{title}</h1><div className="surface-heading-actions" ref={setPageActionsTarget}/></div>}
              <Component
                key={active + state.epoch}
                work={state.work}
                documentId={readerActive ? activeDocumentId : undefined}
                notify={setNotice}
                ai={(object) => void run(() => ai(object))}
                reviewTask={(taskId) => { setAgentStatus({ state: "waiting_for_audit", taskId }); setActive("work.tasks"); }}
                openDocument={documentId => void run(() => openDocument(documentId))}
                openContent={() => void run(() => navigate(state.work.kind === "novel" ? "novel.reader" : state.work.kind === "drama" ? "drama.reader" : "video.review"))}
                plugins={state.views}
                openPlugin={view => void run(() => openPlugin(view))}
              />
            </div>
          ) : (
            <div className="surface" ref={surface} />
          )}
        </main>
        {attachment && <main className="attachment-main" aria-label="附件工作区" onKeyDown={event => {
          if (event.key === "Escape" && !event.defaultPrevented && !event.nativeEvent.isComposing && !document.querySelector("dialog[open]")) {event.preventDefault(); event.stopPropagation(); closeAttachment();}
        }}><ResourceReading key={attachment.resource_id + ":" + attachment.revision} selection={attachment} onClose={closeAttachment} onManage={() => void run(() => navigate("work.resources"))} onAI={() => void run(() => requestAgent("work.resources", {resource_id: attachment.resource_id, revision: attachment.revision}))}/></main>}
        {desktop.agentSessionHost!==false && <AgentWorkspace works={works} onScope={target=>selectAgentWork(target)} onLaunch={async(launch,target)=>{try{await selectAgentWork(target,launch);return true;}catch(error){setNotice((error as Error).message);return false;}}} key={workMode?JSON.stringify(state.work):"library"} work={workMode?state.work:undefined} visible={agentVisible} full={agentFull} width={agentDockWidth} maxWidth={agentMaximum} onWidth={setAgentWidth} onClose={closeAgent} onExpand={expandAgent} notify={setNotice} maximized={agentMaximized&&agentFull} fullscreen={windowFullscreen} onMaximize={()=>{setAgentExpanded(true);setAgentMaximized(value=>!value);}} onFullscreen={desktop.fullscreen?()=>{void desktop.fullscreen!("set",!windowFullscreen).catch(error=>setNotice(error.message));}:undefined} navigationVisible={shellNavigationVisible&&!shellFocus} onNavigation={toggleAgentNavigation}/ >}
      </div>
      {settingsOpen && <dialog ref={embeddedSettings} className="embedded-settings" aria-label="设置" onCancel={event=>{event.preventDefault();window.dispatchEvent(new Event("hetu:settings-close-request"));}}><SettingsApp embedded/></dialog>}
      {notice && <div className="notice" role="status">{notice}<IconButton icon="close" label="关闭提示" onClick={()=>setNotice("")}/></div>}
    </Workbench.Provider>
    </PageActionsTarget.Provider>
    </Preferences.Provider>
  );
}
function SettingsApp({embedded=false}:{embedded?:boolean}) {
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if(!embedded)document.documentElement.dataset.window = "settings";
    document.title = "设置";
    const remove = embedded ? desktop.onPreferences(applyPreferences) : watchPreferences(applyPreferences);
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing && event.keyCode !== 229 && !document.querySelector("dialog[open]")) void desktop.settingsWindow("close");
    };
    window.addEventListener("keydown", close);
    return () => { remove(); window.removeEventListener("keydown", close); };
  }, []);
  return <main className="settings-window"><LocalSettings notify={setNotice} changed={applyPreferences}/>{notice && <p className="settings-window-notice" role="status">{notice}</p>}</main>;
}
function WorkbenchRoot() {
  usePopoverMenus();
  useEffect(() => {
    if (!desktop.windowControls?.titlebarInset) return;
    const update = ({inset, scale}: {inset: boolean; scale: number}) => {
      document.documentElement.dataset.windowChrome = inset ? "inset" : "fullscreen";
      document.documentElement.style.setProperty("--window-controls-inset", `${84 / scale}px`);
    };
    update({inset: true, scale: 1});
    return desktop.onWindowChrome?.(update);
  }, []);
  return <ContextMenuProvider><TextContextMenus>{new URLSearchParams(location.search).get("view") === "settings" ? <SettingsApp/> : <App/>}</TextContextMenus></ContextMenuProvider>;
}
createRoot(document.getElementById("root")!).render(<WorkbenchRoot/>);
