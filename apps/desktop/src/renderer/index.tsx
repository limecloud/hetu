import { viewStorage } from "./view-storage.ts";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { desktop } from "./bridge.ts";
import { surfaces } from "./contributions.tsx";
import { Preferences, applyPreferences } from "./preferences.tsx";
import { LocalSettings } from "./settings.tsx";
import { Icon, IconButton, Workbench, PageActionsTarget, type DocumentTools, type IconName, type AgentStatus } from "./workbench.tsx";
import { WorkCover } from "./work-cover.tsx";
import { LibraryHeader, LibraryNavigation, LibraryContent, NavigationGroup, WorkspaceHeader, type LibraryAssets } from "@hetu/workbench-ui";
const libraryAssets: LibraryAssets = (window as any).hetuWorkbenchAssets ?? {brand:"app-icon.png",light:"river-dawn-v1.webp",dark:"river-night-v1.webp",covers:["cover-river-jade.jpg","cover-cloud-rose.jpg","cover-stars-ink.jpg"]};
import { PluginMigrations } from "./plugin-migrations.tsx";
import { PluginResults } from "./plugin-results.tsx";
import { AuditStatus } from "./audit-status.tsx";
import { sameWork } from "@hetu/plugin-sdk";

function App() {
  const [settingsOpen,setSettingsOpen]=useState(false);
  const embeddedSettings=useRef<HTMLDialogElement>(null);
  useEffect(()=>{if(settingsOpen)embeddedSettings.current?.showModal();},[settingsOpen]);
  useEffect(()=>{const listener=(event:Event)=>setSettingsOpen((event as CustomEvent).detail==="open");window.addEventListener("hetu:settings-window",listener);return()=>window.removeEventListener("hetu:settings-window",listener);},[]);
  const [state, setState] = useState<any>({ plugins: [], views: [] }),
    [works, setWorks] = useState<any[]>([]),
    [active, setActive] = useState("library"),
    [notice, setNotice] = useState(""),
    [operationBusy, setBusy] = useState(false),
    [agentStatus, setAgentStatus] = useState<AgentStatus>({ state: "idle" });
  const [initializing, setInitializing] = useState(true);
  const busy = initializing || operationBusy;
  const appearance = state.preferences?.appearance ?? "system";
  const [kind, setKind] = useState("all");
  const [navigationVisible, setNavigationVisible] = useState(true);
  const [directoryVisible, setDirectoryVisible] = useState(true);
  const [inspector, setInspector] = useState(false);
  const [focus, setFocus] = useState(false);
  const [documentTools, setDocumentTools] = useState<DocumentTools>();
  const [pageActionsTarget, setPageActionsTarget] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 760px)");
    const collapse = () => { if (narrow.matches) setNavigationVisible(false); };
    collapse(); narrow.addEventListener("change", collapse);
    return () => narrow.removeEventListener("change", collapse);
  }, []);
  useEffect(() => {
    const closeMenus = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      const target = event.target as HTMLElement;
      document.querySelectorAll<HTMLDetailsElement>(".popover-menu[open]").forEach((menu) => {
        if (event instanceof KeyboardEvent || !menu.contains(target) || target.closest(".menu-panel button")) menu.open = false;
      });
    };
    document.addEventListener("click", closeMenus);
    document.addEventListener("keydown", closeMenus);
    return () => { document.removeEventListener("click", closeMenus); document.removeEventListener("keydown", closeMenus); };
  }, []);
  useEffect(() => {
    const refresh = () => { void desktop.library("refresh").then(value => { setState(value); setWorks(value.works ?? []); }).catch(error => setNotice(error.message)); };
    window.addEventListener("hetu:work-changed", refresh);
    return () => window.removeEventListener("hetu:work-changed", refresh);
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
          setActive(initial.task_id?"work.tasks":surfaces.list().find(({value})=>value.kinds.includes(initial.work_ref.kind))?.id??"library");
          if(initial.task_id)setAgentStatus({state:"waiting_for_audit",taskId:initial.task_id});
        }
      } catch (error) {
        setNotice((error as Error).message);
      }
    })().catch(error => setNotice(error.message)).finally(() => setInitializing(false));
  }, []);
  useEffect(
    () =>
      desktop.onPreferences((value) =>
        setState((current: any) => ({ ...current, preferences: value })),
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
  const navigate = async (id: string) => {
    if (documentTools?.dirty && id !== active) throw new Error("请先保存当前修改，再切换工作面。");
    await desktop.closeSurface();
    setActive(id);
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
    void run(async () => {
      if (documentTools?.dirty) throw new Error("请先保存当前修改，再打开关联正文。");
      viewStorage.setItem("hetu-document:" + value.work_ref.workspace_id + ":" + value.work_ref.object_id, value.document_id);
      await navigate(value.work_ref.kind === "novel" ? "novel.reader" : "drama.reader");
    });
  }), [state.work, documentTools?.dirty]);
  const ai = async (object?: Record<string, unknown>) => {
    await desktop.handoff(active, object);
    setNotice("已准备当前作品的协作请求，请在所选 Agent 中继续。");
  };
  const items = surfaces
    .list()
    .filter(({ value }) => value.kinds.includes(state.work?.kind));
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
  const workMode = !!state.work && active !== "library";
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
  const globalItem = (id: string, label: string, icon: IconName) => <button disabled={busy} className={active === id ? "selected" : ""}
    onClick={() => void run(() => navigate(id))}><Icon name={icon}/><span>{label}</span></button>;
  const openWorkspace = () => run(async () => {
    const next = await desktop.open();
    if (next) { setState(next); setWorks(next.works); setActive("library"); }
  });
  const createWork = (type: string, name: string) => run(async () => {
    await desktop.library("bootstrap", { kind: type });
    setNotice("已准备新建" + name + "请求，请在所选 Agent 中继续；作品尚未创建。Agent 完成后刷新创作库。其间可以继续处理其他作品。");
  });
  return (
    <Preferences.Provider value={state.preferences ?? {}}>
    <PageActionsTarget.Provider value={pageActionsTarget}>
    <Workbench.Provider value={{ directoryVisible, setDirectoryVisible, inspector, setInspector, focus, setFocus, setDocumentTools, agentStatus, setAgentStatus }}>
      {!pluginActive && !workMode && <LibraryHeader assets={libraryAssets} busy={busy} onOpen={() => void openWorkspace()} onCreate={(type, title) => void createWork(type, title)} onSettings={() => void desktop.settingsWindow("open")} onPlugins={() => void run(() => navigate("plugins"))} onToggleNavigation={() => setNavigationVisible(!navigationVisible)} menu={<label>
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
                  </label>}/> }
      {!pluginActive && workMode && <WorkspaceHeader title={selected?.title ?? "当前作品"} kind={state.work.kind} onNavigation={() => setNavigationVisible(!navigationVisible)} switcher={
          <details className="workspace-switcher popover-menu">
            <summary><span className="workspace-title">{selected?.title ?? "当前作品"}</span><span className="workspace-kind">{{ novel: "小说", drama: "剧本", video: "视频" }[state.work.kind as "novel"]}</span><Icon name="chevron" size={12}/></summary>
            <div className="menu-panel">
              <button disabled={busy} onClick={() => void run(() => navigate("library"))}>返回创作库</button>
              <button disabled={busy} onClick={() => void openWorkspace()}>打开作品</button>
              {works.filter((item) => !item.unavailable).map((item) => <button key={item.work_ref.object_id} disabled={busy} onClick={() => void run(async () => {
                if (documentTools?.dirty) throw new Error("请先保存当前修改。");
                await desktop.library("open", { work_ref: item.work_ref });
                setState(await desktop.select(item.work_ref));
                setActive(item.work_ref.kind === "novel" ? "novel.reader" : item.work_ref.kind === "drama" ? "drama.reader" : "video.review");
              })}>{item.title}</button>)}
            </div>
          </details>}>
          {readerActive && <IconButton icon="list" label="卷章目录" aria-pressed={directoryVisible} onClick={() => { setDirectoryVisible(!directoryVisible); setFocus(false); }}/ >}
        <div className="topbar-actions">
          {workMode && !active.startsWith("fallback:") && (readerActive || !Component) &&
            <button className="ai-button" disabled={busy} aria-label="让 AI 处理" onClick={() => void run(async () => { if (readerActive && documentTools) documentTools.ai(); else await ai(); })}>
              <Icon name="sparkles"/><span>让 AI 处理</span>
            </button>
          }
          {readerActive && documentTools && <span className="save-state" aria-live="polite"><Icon name="check" size={13}/>{documentTools.readOnly ? documentTools.busy ? "正在读取…" : "参考稿 只读" : documentTools.busy ? "正在保存…" : documentTools.dirty ? "有未保存修改" : "修订已保存"}</span>}
          <IconButton icon="settings" label="本机设置" onClick={() => void desktop.settingsWindow("open")}/>
          {workMode && desktop.windowControls?.zoom !== false && <IconButton icon="expand" label="缩放窗口" onClick={() => void desktop.zoom()}/>}
          {readerActive && documentTools && <>
            <button className="primary" disabled={documentTools.busy || !documentTools.dirty} onClick={documentTools.save}>保存修订</button>
            <IconButton icon="inspector" label="检查器" aria-pressed={inspector} onClick={() => setInspector(!inspector)}/>
          </>}
          <details className="popover-menu topbar-more"><summary aria-label="更多操作" title="更多操作"><Icon name="more"/></summary><div className="menu-panel">
            <button disabled={busy} onClick={() => void openWorkspace()}>打开作品</button>
            {readerActive && <button aria-pressed={focus} onClick={() => setFocus(!focus)}>{focus ? "退出专注" : "专注阅读"}</button>}


            <button disabled={busy} onClick={() => void run(() => navigate("plugins"))}>创作插件</button>
            <button onClick={() => void desktop.settingsWindow("open")}>本机设置</button>
          </div></details>
        </div>
      </WorkspaceHeader>}
      <div className={"layout" + (workMode ? " workspace-layout" : " library-layout") + (!navigationVisible || focus ? " navigation-hidden" : "") + (focus ? " focus-mode" : "")}>
        {!pluginActive && <aside className="project-navigation" aria-label={workMode ? "项目导航" : "创作库导航"}>
          {workMode ? <>
            <button className="back-library" disabled={busy} onClick={() => void run(() => navigate("library"))}><Icon name="back" size={13}/>返回创作库</button>
            <div className="navigation-scroll">
              {navItem("work.profile")}
              {navItem(state.work.kind === "novel" ? "novel.reader" : state.work.kind === "drama" ? "drama.reader" : "video.review")}
              {navItem("work.tasks")}{navItem("work.links")}
              <div className="navigation-divider"/>
              <NavigationGroup title="创作资料" active={["novel.outlines", "work.canon", "work.images", "work.resources", "work.media"].includes(active)}>{["novel.outlines", "work.canon", "work.images", "work.resources", "work.media"].map(navItem)}</NavigationGroup>
              <NavigationGroup title="版本与交付" active={["work.versions", "work.import", "work.delivery"].includes(active)}>{["work.versions", "work.import", "work.delivery"].map(navItem)}</NavigationGroup>
              <NavigationGroup title="检查工具" active={["work.management", "work.agent", "plugins"].includes(active)}>
                {navItem("work.management")}{navItem("work.agent")}
                {globalItem("plugins", "创作插件", "plugin")}
              </NavigationGroup>
              {state.views.length > 0 && <details className="navigation-group" open><summary>创作插件</summary>{state.views.map((view: any) => <button key={view.key} disabled={busy} className={active === view.key ? "selected" : ""} onClick={() => void run(() => openPlugin(view))}><Icon name="plugin"/>{view.title}</button>)}</details>}
            </div>
            <div className="current-work"><WorkCover work={state.work} title={selected?.title ?? "当前作品"} compact/><div><strong>{selected?.title ?? "当前作品"}</strong><small>{{novel:"小说",drama:"剧本",video:"视频"}[state.work.kind as "novel"]}</small></div></div>
          </> : <LibraryNavigation kind={kind} active={active} busy={busy} onKind={id => { setKind(id); void run(() => navigate("library")); }} onPlugins={() => void run(() => navigate("plugins"))}/>
          }
        </aside>}
        <main className={pluginActive ? "plugin-page" : readerActive ? "reader-main" : "page-main"}>
          {pluginActive && pluginView.navigation !== "integrated" && <nav className="plugin-page-navigation" aria-label="插件页面导航"><button disabled={busy} aria-label="返回工作台" onClick={() => void run(() => navigate(pluginReturn.current))}><Icon name="back" size={14}/>返回</button></nav>}
          {!pluginActive && active !== "library" && !readerActive && !Component && !active.startsWith("fallback:") && <div className="toolbar"><div><h1>{title}</h1></div>{active === "plugins" && <button disabled={busy} onClick={() => void run(async () => setState(await desktop.install()))}>安装插件包</button>}</div>}
          {notice && (
            <div className="notice" role="status">
              {notice}
            </div>
          )}
          {!pluginActive && active !== "work.tasks" && <AuditStatus
            state={agentStatus.state}
            message={agentStatus.message}
            onReview={() => void run(() => navigate("work.tasks"))}
          />}
          {active === "library" ? (
            <LibraryContent works={works} assets={libraryAssets} appearance={appearance} kind={kind} busy={busy} loading={initializing} initialListMode={state.preferences?.library_list ?? true} onKind={setKind} onOpen={() => void openWorkspace()} onCreate={(type,title) => void createWork(type,title)} onRefresh={() => void run(async () => { const next=await desktop.library("refresh"); setState(next); setWorks(next.works ?? []); })} onSelect={item => void run(async () => { await desktop.library("open",{work_ref:item.work_ref}); const next=await desktop.select(item.work_ref); setState(next); setActive(surfaces.list().find(({value}) => value.kinds.includes(item.work_ref.kind))?.id ?? "library"); })}/>
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
              {!readerActive && <div className="surface-heading"><h1>{title}</h1><div className="surface-heading-actions" ref={setPageActionsTarget}/></div>}
              <Component
                key={active + state.epoch}
                work={state.work}
                notify={setNotice}
                ai={(object) => void run(() => ai(object))}
                reviewTask={(taskId) => { setAgentStatus({ state: "waiting_for_audit", taskId }); setActive("work.tasks"); }}
              />
            </div>
          ) : (
            <div className="surface" ref={surface} />
          )}
        </main>
      </div>
      {settingsOpen && <dialog ref={embeddedSettings} className="embedded-settings" aria-label="设置" onCancel={event=>{event.preventDefault();window.dispatchEvent(new Event("hetu:settings-close-request"));}}><button className="embedded-settings-close" aria-label="关闭设置" onClick={()=>window.dispatchEvent(new Event("hetu:settings-close-request"))}>关闭</button><SettingsApp embedded/></dialog>}
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
    const remove = desktop.onPreferences(applyPreferences);
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector("dialog[open]")) void desktop.settingsWindow("close");
    };
    document.addEventListener("keydown", close);
    return () => { remove(); document.removeEventListener("keydown", close); };
  }, []);
  return <main className="settings-window"><LocalSettings notify={setNotice} changed={applyPreferences}/>{notice && <p className="settings-window-notice" role="status">{notice}</p>}</main>;
}
createRoot(document.getElementById("root")!).render(new URLSearchParams(location.search).get("view") === "settings" ? <SettingsApp/> : <App />);
