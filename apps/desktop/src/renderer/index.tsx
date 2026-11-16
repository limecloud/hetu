import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { desktop } from "./bridge.ts";
import { surfaces } from "./contributions.tsx";
import { Preferences, applyPreferences } from "./preferences.tsx";
import { LocalSettings } from "./settings.tsx";
import { Icon, IconButton, Workbench, PageActionsTarget, type DocumentTools, type IconName, type AgentStatus } from "./workbench.tsx";
import { WorkCover, WorkCoverPreview } from "./work-cover.tsx";
import { PluginMigrations } from "./plugin-migrations.tsx";
import { PluginResults } from "./plugin-results.tsx";
import { AuditStatus } from "./audit-status.tsx";

function NavigationGroup({ title, active, children }: { title: string; active: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(active);
  useEffect(() => { if (active) setOpen(true); }, [active]);
  return <details className="navigation-group" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}><summary>{title}</summary>{children}</details>;
}
function App() {
  const [state, setState] = useState<any>({ plugins: [], views: [] }),
    [works, setWorks] = useState<any[]>([]),
    [active, setActive] = useState("library"),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [agentStatus, setAgentStatus] = useState<AgentStatus>({ state: "idle" }),
    [address, setAddress] = useState("");
  const [kind, setKind] = useState("all");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [listMode, setListMode] = useState<boolean>();
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
      } catch (error) {
        setNotice((error as Error).message);
      }
    })();
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
  useEffect(() => desktop.onPluginsChanged(setState), []);
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
  const ai = async (object?: Record<string, unknown>) => {
    await desktop.handoff(active, object);
    setNotice("已复制当前作品的协作请求，可粘贴到你选择的外部 Agent。");
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
          : active === "browser"
            ? "参考浏览器"
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
    "drama.reader": ["剧本", "file"], "video.review": ["视频", "film"],
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
  const visibleWorks = works.filter((item) => (kind === "all" || item.work_ref.kind === kind) &&
    (statusFilter === "all" || item.status === statusFilter || (statusFilter === "archived" && item.archived)) &&
    [item.title, item.author_name, item.genre].filter(Boolean).join(" ").toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const createWork = (type: string, name: string) => run(async () => {
    await desktop.library("bootstrap", { kind: type });
    setNotice("已复制新建" + name + "请求，可粘贴到所选外部 Agent；作品尚未创建。Agent 完成后刷新创作库。其间可以继续处理其他作品。");
  });
  return (
    <Preferences.Provider value={state.preferences ?? {}}>
    <PageActionsTarget.Provider value={pageActionsTarget}>
    <Workbench.Provider value={{ directoryVisible, setDirectoryVisible, inspector, setInspector, focus, setFocus, setDocumentTools, agentStatus, setAgentStatus }}>
      <header className={"workbench-topbar" + (workMode ? "" : " library-topbar")}>
        {workMode ? <>
          <IconButton icon="sidebar" label="项目导航" aria-pressed={navigationVisible} onClick={() => setNavigationVisible(!navigationVisible)}/>
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
          </details>
          {readerActive && <IconButton icon="list" label="卷章目录" aria-pressed={directoryVisible} onClick={() => { setDirectoryVisible(!directoryVisible); setFocus(false); }}/ >}
        </> : <div className="brand-lockup"><img className="brand-icon" src="app-icon.png" alt=""/><strong>河图洛书</strong></div>}
        <div className="topbar-actions">
          {workMode && !active.startsWith("fallback:") && (readerActive || !Component) &&
            <button className="ai-button" disabled={busy} aria-label="让 AI 处理" onClick={() => void run(async () => { if (readerActive && documentTools) documentTools.ai(); else await ai(); })}>
              <Icon name="sparkles"/><span>让 AI 处理</span>
            </button>
          }
          {readerActive && documentTools && <span className="save-state" aria-live="polite"><Icon name="check" size={13}/>{documentTools.busy ? "正在保存…" : documentTools.dirty ? "有未保存修改" : "修订已保存"}</span>}
          <IconButton icon="settings" label="本机设置" onClick={() => void desktop.settingsWindow("open")}/>
          {workMode && <IconButton icon="expand" label="缩放窗口" onClick={() => void desktop.zoom()}/>}
          {readerActive && documentTools && <>
            <button className="primary" disabled={documentTools.busy || !documentTools.dirty} onClick={documentTools.save}>保存修订</button>
            <IconButton icon="inspector" label="检查器" aria-pressed={inspector} onClick={() => setInspector(!inspector)}/>
          </>}
          {!workMode && <button disabled={busy} onClick={() => void openWorkspace()}>打开作品</button>}
          {!workMode && <details className="popover-menu create-work-menu"><summary className="primary">新建作品<Icon name="chevron" size={12}/></summary><div className="menu-panel">{([["novel", "小说"], ["drama", "剧本"], ["video", "视频"]] as const).map(([type, name]) => <button key={type} disabled={busy} onClick={() => void createWork(type, name)}>让 AI 新建{name}</button>)}</div></details>}
          <details className="popover-menu topbar-more"><summary aria-label="更多操作" title="更多操作"><Icon name="more"/></summary><div className="menu-panel">
            <button disabled={busy} onClick={() => void openWorkspace()}>打开作品</button>
            {readerActive && <button aria-pressed={focus} onClick={() => setFocus(!focus)}>{focus ? "退出专注" : "专注阅读"}</button>}

            {!workMode && <label>
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
                  </label>}
            <button disabled={busy} onClick={() => void run(() => navigate("plugins"))}>创作插件</button>
            <button disabled={busy} onClick={() => void run(() => navigate("browser"))}>参考浏览器</button>
            <button onClick={() => void desktop.settingsWindow("open")}>本机设置</button>
          </div></details>
        </div>
      </header>
      <div className={"layout" + (workMode ? " workspace-layout" : " library-layout") + (!navigationVisible || focus ? " navigation-hidden" : "") + (focus ? " focus-mode" : "")}>
        <aside className="project-navigation" aria-label={workMode ? "项目导航" : "创作库导航"}>
          {workMode ? <>
            <button className="back-library" disabled={busy} onClick={() => void run(() => navigate("library"))}><Icon name="back" size={13}/>返回创作库</button>
            <div className="navigation-scroll">
              {navItem("work.profile")}
              {navItem(state.work.kind === "novel" ? "novel.reader" : state.work.kind === "drama" ? "drama.reader" : "video.review")}
              {navItem("work.tasks")}{navItem("work.links")}
              <div className="navigation-divider"/>
              <NavigationGroup title="创作资料" active={["work.canon", "work.images", "work.resources", "work.media"].includes(active)}>{["work.canon", "work.images", "work.resources", "work.media"].map(navItem)}</NavigationGroup>
              <NavigationGroup title="版本与交付" active={["work.versions", "work.import", "work.delivery"].includes(active)}>{["work.versions", "work.import", "work.delivery"].map(navItem)}</NavigationGroup>
              <NavigationGroup title="检查工具" active={["work.management", "work.agent", "plugins", "browser"].includes(active)}>
                {navItem("work.management")}{navItem("work.agent")}
                {globalItem("plugins", "创作插件", "plugin")}{globalItem("browser", "参考浏览器", "search")}
              </NavigationGroup>
              {state.views.length > 0 && <details className="navigation-group" open><summary>创作插件</summary>{state.views.map((view: any) => <button key={view.key} disabled={busy} className={active === view.key ? "selected" : ""} onClick={() => void run(async () => { await navigate(view.key); await desktop.view(view.owner, view.id); })}><Icon name="plugin"/>{view.title}</button>)}</details>}
            </div>
            <div className="current-work"><WorkCover work={state.work} title={selected?.title ?? "当前作品"} compact/><div><strong>{selected?.title ?? "当前作品"}</strong><small>{{novel:"小说",drama:"剧本",video:"视频"}[state.work.kind as "novel"]}</small></div></div>
          </> : <>

            {([["all", "全部作品", "layers"], ["novel", "小说", "book"], ["drama", "剧本", "file"], ["video", "视频", "film"]] as [string, string, IconName][]).map(([id,label,icon]) => <button key={id} disabled={busy} className={kind === id && active === "library" ? "selected" : ""} onClick={() => { setKind(id); void run(() => navigate("library")); }}><Icon name={icon}/>{label}</button>)}
            <div className="navigation-divider"/>
            {globalItem("plugins", "创作插件", "plugin")}{globalItem("browser", "参考浏览器", "search")}
          </>}
        </aside>
        <main className={readerActive ? "reader-main" : "page-main"}>
          {!readerActive && !Component && !active.startsWith("fallback:") && <div className="toolbar"><div><h1>{title}</h1></div>{active === "plugins" && <button disabled={busy} onClick={() => void run(async () => setState(await desktop.install()))}>安装插件包</button>}</div>}
          {notice && (
            <div className="notice" role="status">
              {notice}
            </div>
          )}
          <AuditStatus
            state={agentStatus.state}
            message={agentStatus.message}
            onReview={() => void run(() => navigate("work.tasks"))}
          />
          {active === "library" ? (
            <div className="content library-content">
              <div className="library-search-row">
                <strong>{({ all:"全部作品",novel:"小说",drama:"剧本",video:"视频" } as Record<string,string>)[kind]}<span className="muted"> {visibleWorks.length}</span></strong><IconButton icon="refresh" label="刷新创作库" disabled={busy} onClick={() => void run(async () => { const next = await desktop.library("refresh"); setState(next); setWorks(next.works ?? []); })}/>
                <select aria-label="创作状态筛选" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>{[["all","全部状态"],["planning","筹备中"],["writing","创作中"],["completed","已完成"],["archived","已归档"]].map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select>
                <label className="library-search"><Icon name="search"/><input aria-label="搜索作品" placeholder="搜索作品" value={search} onChange={(e) => setSearch(e.target.value)}/></label>
                <div className="segmented-control" aria-label="创作库布局"><IconButton icon="list" label="列表视图" aria-pressed={listMode ?? state.preferences?.library_list ?? true} onClick={() => setListMode(true)}/><IconButton icon="grid" label="封面视图" aria-pressed={!(listMode ?? state.preferences?.library_list ?? true)} onClick={() => setListMode(false)}/></div>
              </div>
              {works.length ? (
                <div
                  className={
                    (listMode ?? state.preferences?.library_list ?? true)
                      ? "library-works"
                      : "library-works library-grid"
                  }
                >
                  {visibleWorks.map((item) => (
                      <button
                        className="work"
                        data-work-kind={item.work_ref.kind}
                        key={item.work_ref.object_id}
                        disabled={busy || item.unavailable}
                        onClick={() =>
                          void run(async () => {
                            await desktop.library("open", {
                              work_ref: item.work_ref,
                            });
                            const next = await desktop.select(item.work_ref);
                            setState(next);
                            setActive(
                              surfaces
                                .list()
                                .find(({ value }) =>
                                  value.kinds.includes(item.work_ref.kind),
                                )?.id ?? "library",
                            );
                          })
                        }
                      >
                        <div className="work-thumbnail"><WorkCoverPreview work={item.work_ref} title={item.title} author={item.author_name} compact={(listMode ?? state.preferences?.library_list ?? true) || item.work_ref.kind !== "novel"} preview={item.cover_preview} error={item.unavailable ? item.error : ""}/></div>
                        <div className="library-work-description"><strong>{item.title}</strong>{(item.author_name || item.genre) && <small>{[item.author_name, item.genre].filter(Boolean).join(" ")}</small>}</div>
                        {item.unavailable && <span>{item.error}</span>}
                        <span className="pill">
                          {
                            { novel: "小说", drama: "剧本", video: "视频" }[
                              item.work_ref.kind as "novel" | "drama" | "video"
                            ]
                          }
                        </span>
                        <div className="library-work-metrics">{item.status && <span className="library-work-status">{({planning:"筹备中",writing:"创作中",completed:"已完成",archived:"已归档"} as Record<string,string>)[item.status]}</span>}
                        {item.chapter_count !== undefined && <small className="library-work-count">{item.chapter_count} 章</small>}</div>
                        {item.updated_at && <small className="library-work-date">{new Date(item.updated_at).toLocaleDateString()}</small>}
                      </button>
                    ))}
                </div>
              ) : (
                <div className="empty">
                  <h1>还没有作品</h1>
                  <p>新建作品，或打开已有作品。</p>
                  <button
                    onClick={() =>
                      void run(async () => {
                        const next = await desktop.open();
                        if (next) {
                          setState(next);
                          setWorks(next.works);
                        }
                      })
                    }
                  >
                    打开作品
                  </button>
                </div>
              )}
              {!!works.length && !visibleWorks.length && <div className="empty"><Icon name="search" size={28}/><h2>没有匹配的作品</h2><button onClick={() => { setKind("all"); setSearch(""); setStatusFilter("all"); }}>清除筛选</button></div>}
            </div>
          ) : active === "plugins" ? (
            <div className="content plugin-content">
              {!state.plugins.length && <div className="empty"><Icon name="plugin" size={28}/><p>还没有安装插件</p></div>}
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
          ) : active === "browser" ? (
            <>
              <div className="browser-address">
                <input
                  aria-label="参考网页地址"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="输入参考网页地址"
                />
                <button
                  onClick={() => void run(() => desktop.browser(address))}
                >
                  打开参考
                </button>
                <button onClick={() => void desktop.closeSurface()}>
                  关闭网页
                </button>
              </div>
              <div className="surface" ref={surface} />
            </>
          ) : Component ? (
            <div className={readerActive ? "content manuscript-content" : "content workbench-page"} data-surface={active}>
              {!readerActive && <div className="surface-heading"><h1>{title}</h1><div className="surface-heading-actions" ref={setPageActionsTarget}/></div>}
              <Component
                key={active + state.epoch}
                work={state.work}
                notify={setNotice}
                ai={(object) => void run(() => ai(object))}
              />
            </div>
          ) : (
            <div className="surface" ref={surface} />
          )}
        </main>
      </div>
    </Workbench.Provider>
    </PageActionsTarget.Provider>
    </Preferences.Provider>
  );
}
function SettingsApp() {
  const [notice, setNotice] = useState("");
  useEffect(() => {
    document.documentElement.dataset.window = "settings";
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
