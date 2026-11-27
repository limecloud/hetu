import { StorageSettings, StoragePlan } from "./storage-settings.tsx";
import {InterfaceScale} from "./interface-scale.tsx";
import React, { useEffect, useRef, useState } from "react";
import { desktop } from "./bridge.ts";
import { Icon, IconButton, PageActionsTarget, type IconName } from "./workbench.tsx";
import { version } from "../../package.json";
import "./settings.css";
import { ModelSettings } from "./model-settings.tsx";
import { CodexSettings } from "./codex-settings.tsx";
import { WorkAgent } from "./work-agent.tsx";
import { ReadingControls, mergeReadingPreferences, readingProfile, type ReadingKind } from "@hetu/workbench-ui";

const labels: Record<string, string> = {
  language: "界面语言",
  appearance: "外观",
  library_list: "创作库布局",
  autosave: "自动保存正文",
  execution_mode: "执行模式",
  font_family: "字体",
  font_size: "字号",
  line_spacing: "行间距",
  first_line_indent: "小说段落首行缩进两字",
  git_author_name: "姓名",
  git_author_email: "邮箱",
  agent_client: "默认外部 Agent",
  document_theme: "文稿纸色",
  line_height: "行高",
  paragraph_spacing: "段距",
  line_width: "行宽",
  font_name: "本机字体",
  focus_paragraph: "聚焦当前段落",
  typewriter_scroll: "打字机滚动",
  smart_pairs: "智能配对括号与引号",
};
const values: Record<string, string> = {
  auto: "自动执行",
  confirm: "确认后执行",
  "zh-CN": "简体中文",
  en: "English",
  system: "跟随系统",
  light: "浅色",
  dark: "深色",
  songti: "宋体",
  pingfang: "苹方",
  mono: "剧本等宽",
  custom: "本机字体",
  paper: "清纸",
  warm: "暖纸",
  night: "夜墨",
  codex: "Codex",
  workbuddy: "WorkBuddy",
  claudeCode: "Claude Code",
  other: "其他客户端",
  none: "未选择",
};
const choices: Record<string, string[]> = {
  execution_mode: ["auto", "confirm"],
  language: ["zh-CN", "en"],
  appearance: ["system", "light", "dark"],
  font_family: ["songti", "pingfang", "system"],
  agent_client: ["none", "codex", "claudeCode", "workbuddy", "other"],
};
const planStates: Record<string, string> = {
  pending: "待审阅",
  approved: "已批准",
  rejected: "已拒绝",
  executing: "结果待确认",
  executed: "已执行",
};
type Tab = "storage" | "general" | "writing" | "agents" | "models" | "versions" | "plans" | "about";
const tabs: { id: Tab; title: string; icon: IconName }[] = [
  { id: "general", title: "通用", icon: "sliders" },
  { id: "writing", title: "写作", icon: "type" },
  { id: "storage", title: "存储空间", icon: "layers" },
  { id: "models", title: "模型服务", icon: "globe" },
  { id: "agents", title: "AI 协作", icon: "plugin" },
  { id: "versions", title: "版本", icon: "branch" },
  { id: "about", title: "关于", icon: "info" },
];
const categories = [
  {title: "应用设置", ids: ["general", "writing", "storage"]},
  {title: "创作与协作", ids: ["models", "agents", "versions"]},
  {title: "河图洛书", ids: ["about"]},
];
function display(value: any) {
  return typeof value === "boolean"
    ? value
      ? "开启"
      : "关闭"
    : (values[value] ?? String(value ?? "未填写")) || "未填写";
}
function preferenceValue(key: string, value: any) {
  if (key === "library_list") return value ? "列表" : "封面";
  if (["font_size", "line_spacing"].includes(key)) return `${value} px`;
  if (key === "line_height") return `${Number(Number(value).toFixed(4))} 倍`;
  if (key === "paragraph_spacing") return `${value} em`;
  if (key === "line_width") return `${Number(Number(value).toFixed(2))} 字形`;
  if (key === "document_theme" && value === "system") return "跟随应用";
  return display(value);
}
function Changes({ before, patch }: { before: any; patch: any }) {
  const changes = Object.entries(patch).flatMap(([key, value]) => key === "reading_profiles"
    ? Object.entries(value as Record<ReadingKind, any>).flatMap(([kind, fields]) => Object.entries(fields).map(([field, target]) => ({
      key: kind + ":" + field, label: (kind === "novel" ? "小说 " : "剧本 ") + (labels[field] ?? field),
      before: preferenceValue(field, readingProfile(before, kind as ReadingKind)[field as keyof ReturnType<typeof readingProfile>]), after: preferenceValue(field, target),
    })))
    : [{ key, label: labels[key] ?? key, before: preferenceValue(key, before[key]), after: preferenceValue(key, value) }]);
  return (
    <table className="settings-changes">
      <thead>
        <tr>
          <th>设置</th>
          <th>当前值</th>
          <th>目标值</th>
        </tr>
      </thead>
      <tbody>
        {changes.map(item => (
          <tr key={item.key}>
            <th>{item.label}</th>
            <td>{item.before}</td>
            <td>{item.after}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
export function LocalSettings({
  notify,
  changed,
}: {
  notify: (message: string) => void;
  changed: (preferences: any) => void;
}) {
  const [state, setState] = useState<any>(),
    [plans, setPlans] = useState<any[]>([]),
    [selected, setSelected] = useState(""),
    [cursor, setCursor] = useState<string>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [preview, setPreview] = useState<any>(),
    [textDrafts, setTextDrafts] = useState<Record<string, string>>({}),
    [pendingPreferences, setPendingPreferences] = useState<Record<string, unknown>>({}),
    [tab, setTab] = useState<Tab>("general"), [search, setSearch] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  const [pageActionsTarget, setPageActionsTarget] = useState<HTMLDivElement | null>(null);
  const [readingKind, setReadingKind] = useState<ReadingKind>("novel");
  const returnTab = useRef<Tab>("general");
  const [horizontalTabs, setHorizontalTabs] = useState(() => matchMedia("(max-width:760px)").matches);
  const settingsSearch = useRef<HTMLInputElement>(null);
  const visibleTabs = tabs.filter(item => item.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  useEffect(() => {
    const query = matchMedia("(max-width:760px)"), update = () => setHorizontalTabs(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {const find = (event: KeyboardEvent) => {if((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f" && !document.querySelector("dialog[open]:not(.embedded-settings)")){event.preventDefault();settingsSearch.current?.focus();}};window.addEventListener("keydown",find);return()=>window.removeEventListener("keydown",find);},[]);
  const saves = useRef<Promise<void>>(Promise.resolve());
  const currentState = useRef<any>();
  const drafts = useRef(textDrafts), closing = useRef(false), closeReady = useRef(false);
  const pendingValues = useRef(pendingPreferences);
  drafts.current = textDrafts;
  pendingValues.current = pendingPreferences;
  const plan = plans.find((p) => p.operation_id === selected);
  async function refresh(next?: string) {
    const [current, list] = await Promise.all([
      desktop.settings("get"),
      desktop.settings("list", next ? { cursor: next } : {}),
    ]);
    currentState.current = current;
    setState(current);
    changed({ ...current.preferences, settings_revision: current.revision });
    setPlans(list.operations);
    setCursor(list.next_cursor ?? undefined);
    setSelected((previous) =>
      list.operations.some((p: any) => p.operation_id === previous)
        ? previous
        : (list.operations[0]?.operation_id ?? ""),
    );
  }
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
      notify(message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void run(() => refresh());
  }, []);
  useEffect(() => {
    if (panel.current) panel.current.scrollTop = 0;
  }, [tab, preview]);
  function chooseTab(next: Tab) {
    for (const [key, value] of Object.entries(drafts.current)) {
      if (value !== currentState.current?.preferences[key]) void savePreference(key, value);
    }
    setPreview(undefined);
    setTab(next);
  }
  function tabKey(
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    const next =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? (index + 1) % visibleTabs.length
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? (index + visibleTabs.length - 1) % visibleTabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? visibleTabs.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    chooseTab(visibleTabs[next].id);
    document.getElementById("settings-tab-" + visibleTabs[next].id)?.focus();
  }
  function savePreference(key: string, value: unknown) {
    if (!["git_author_name", "git_author_email"].includes(key)) setPendingPreferences(current => ({ ...current, [key]: value }));
    const pending = saves.current.then(async () => {
      const latest = currentState.current;
      if (!latest || latest.journal?.status === "pending") return;
      await run(async () => {
        try {
          if (value !== latest.preferences[key]) {
            await desktop.settings("update", { expected_revision: latest.revision, patch: { [key]: value } });
            await refresh();
          }
          setTextDrafts(current => {
            if (current[key] !== value) return current;
            const next = { ...current }; delete next[key]; return next;
          });
        } catch (error) {
          // 先回读原操作状态，不换键重发；保留作者尚未确认的输入。
          await refresh().catch(() => {});
          throw error;
        }
      });
    }).finally(() => setPendingPreferences(current => {
      if (current[key] !== value) return current;
      const next = { ...current }; delete next[key]; return next;
    }));
    saves.current = pending.catch(() => {});
    return pending;
  }
  useEffect(() => {
    const beforeClose = (event: Event) => {
      const embedded = event.type === "hetu:settings-close-request";
      if (closeReady.current) { if (embedded) void desktop.settingsWindow("close"); return; }
      const edits = Object.entries(drafts.current).filter(([key, value]) => value !== currentState.current?.preferences[key]);
      if (!edits.length && !busy && !Object.keys(pendingValues.current).length) { if (embedded) void desktop.settingsWindow("close"); return; }
      event.preventDefault(); if (!embedded) (event as BeforeUnloadEvent).returnValue = false;
      if (closing.current) return;
      closing.current = true;
      void (async () => {
        for (const [key, value] of edits) await savePreference(key, value);
        await saves.current;
        const remaining = Object.entries(drafts.current).some(([key, value]) => value !== currentState.current?.preferences[key]);
        if (!remaining && currentState.current?.journal?.status !== "pending") {
          closeReady.current = true;
          // 先让本次 beforeunload 取消完成，再关闭窗口，避免跨平台重入时丢失关闭请求。
          await new Promise<void>(resolve => setTimeout(resolve, 0));
          await desktop.settingsWindow("close");
        }
      })().catch((error: unknown) => {
        closeReady.current = false;
        const message = (error as Error).message;
        setError(message);
        notify(message);
      }).finally(() => { closing.current = false; });
    };
    window.addEventListener("beforeunload", beforeClose);
    window.addEventListener("hetu:settings-close-request", beforeClose);
    return () => { window.removeEventListener("beforeunload", beforeClose); window.removeEventListener("hetu:settings-close-request", beforeClose); };
  }, [busy]);
  function field(key: string) {
    const value = pendingPreferences[key] ?? state.preferences[key], disabled = busy || state.journal?.status === "pending";
    const label = labels[key];
    return <label className={"settings-field" + (choices[key] || key === "library_list" ? " settings-choice" : "")} key={key}>
      <span>{label}</span>
      {key === "library_list" ? <select aria-label={label} value={value ? "list" : "grid"} disabled={disabled}
        onChange={e => void savePreference(key, e.target.value === "list")}><option value="grid">封面网格</option><option value="list">作品列表</option></select>
      : typeof value === "boolean" ? <input className="settings-switch" type="checkbox" role="switch" aria-label={label} checked={value} disabled={disabled}
        onChange={e => void savePreference(key, e.target.checked)}/>
      : ["font_size", "line_spacing"].includes(key) ? <span className="settings-stepper">
        <output aria-label={label + "当前值"}>{value} px</output>
        <span><button type="button" aria-label={"减小" + label} disabled={disabled || value <= (key === "font_size" ? 14 : 0)} onClick={() => void savePreference(key, value - 1)}>−</button>
        <button type="button" aria-label={"增大" + label} disabled={disabled || value >= (key === "font_size" ? 30 : 16)} onClick={() => void savePreference(key, value + 1)}>+</button></span>
      </span>
      : choices[key] ? <select aria-label={label} value={value} disabled={disabled} onChange={e => void savePreference(key, e.target.value)}>
        {choices[key].map(choice => <option key={choice} value={choice}>{key === "font_family" && choice === "system" ? "系统字体" : display(choice)}</option>)}
      </select>
      : <input aria-label={label} maxLength={256} value={textDrafts[key] ?? value} disabled={state.journal?.status === "pending"}
        onChange={e => setTextDrafts(current => ({ ...current, [key]: e.target.value }))}
        onBlur={e => void savePreference(key, e.target.value)} onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}/>
      }
    </label>;
  }
  function fields(title: string, keys: string[]) {
    return (
      <section className="settings-group">
        <h3>{title}</h3>
        <div>{keys.map(field)}</div>
      </section>
    );
  }
  const current = state && { ...mergeReadingPreferences(state.preferences, pendingPreferences), agent_session: { ...state.preferences.agent_session, ...(pendingPreferences.agent_session as object ?? {}) } };
  return (
    <PageActionsTarget.Provider value={pageActionsTarget}><section className="local-settings" aria-label="本机设置">
      <header className="settings-titlebar" aria-label="设置窗口"/>
      <aside className="settings-navigation" aria-label="设置导航"><header><button type="button" onClick={()=>window.dispatchEvent(new Event("hetu:settings-close-request"))}><Icon name="back" size={14}/>返回应用</button></header><div className="settings-search"><Icon name="search" size={14}/><input ref={settingsSearch} type="search" aria-label="搜索设置" placeholder="搜索设置" value={search} onChange={event=>setSearch(event.target.value)} onKeyDown={event=>{if(event.key==="Escape"&&search&&!event.nativeEvent.isComposing){event.preventDefault();event.stopPropagation();setSearch("");}}}/><kbd aria-hidden>{navigator.platform.includes("Mac")?"⌘":"Ctrl"} F</kbd></div>
      <div className="settings-tabs" role="tablist" aria-label="设置分类" aria-orientation={horizontalTabs ? "horizontal" : "vertical"}>
        {categories.filter(category=>visibleTabs.some(item=>category.ids.includes(item.id))).map(category => <div className="settings-category" role="presentation" key={category.title}><span className="settings-category-title">{category.title}</span>{visibleTabs.filter(item => category.ids.includes(item.id)).map(item => (
          <button key={item.id} id={"settings-tab-"+item.id} type="button" role="tab" aria-selected={tab===item.id} aria-controls={"settings-panel-"+item.id} tabIndex={tab===item.id||!visibleTabs.some(item=>item.id===tab)&&item.id===visibleTabs[0]?.id?0:-1} onClick={()=>chooseTab(item.id)} onKeyDown={event=>tabKey(event,visibleTabs.indexOf(item))}><Icon name={item.icon} size={16}/><span>{item.title}</span></button>
        ))}</div>)}
        {!visibleTabs.length&&<p className="settings-search-empty">没有匹配的设置</p>}
      </div></aside>
      <div className="settings-body">
      <div className="settings-tools">
        {tab==="plans"&&<IconButton icon="back" label="返回设置" onClick={()=>chooseTab(returnTab.current)}/>}
        <nav aria-label="设置导航路径"><span>设置</span><span>/</span><h1>{tab === "plans" ? "本机操作审阅" : tabs.find(item => item.id === tab)?.title}</h1></nav>
        <div className="settings-global-actions">
        {tab === "plans" ? <><button disabled={busy} onClick={() => void run(async () => { await desktop.settings("handoff", { section: returnTab.current }); notify("已复制本机设置协作请求。"); })}><Icon name="sparkles"/>让 AI 调整设置</button>
          <IconButton icon="refresh" label="刷新本机设置" disabled={busy} onClick={() => void run(() => refresh())}/></>
          : tab === "storage" ? <button disabled={busy} onClick={() => void run(async () => { await desktop.settings("handoff", { section: "storage" }); notify("已复制存储整理请求。"); })}><Icon name="sparkles"/>让 AI 整理</button>
          : <button disabled={busy} onClick={() => { returnTab.current = tab; chooseTab("plans"); void run(() => refresh()); }}><Icon name="sparkles"/>让 AI 处理与审阅{plans.some(p => p.state === "pending") && <span className="settings-pending" aria-label="有待审方案"/>}</button>}
      </div>
        <div className="settings-page-actions" ref={setPageActionsTarget}/>
        <IconButton icon="close" label="关闭设置" onClick={()=>window.dispatchEvent(new Event("hetu:settings-close-request"))}/>
      </div>
      {error && (
        <p role="alert" className="settings-feedback">
          {error}
        </p>
      )}
      {!state && !error && (
        <p className="settings-feedback" role="status">
          正在读取本机偏好…
        </p>
      )}
      {state?.journal && (
        <div className="recover settings-recovery">
          <p>
            {state.journal.status === "pending"
              ? "原本机操作的结果尚未确认。"
              : state.journal.status === "blocked"
                ? "原本机操作因输入或基线冲突被阻止，请核对后继续。"
                : "上次本机操作已确认。"}
          </p>
          <div className="actions">
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await desktop.settings("recover");
                  setPreview(undefined);
                  await refresh();
                  notify("原本机操作已确认，未重复执行其他操作。");
                })
              }
            >
              恢复原本机操作
            </button>
            {state.journal.status !== "pending" && (
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await desktop.settings("acknowledge");
                    await refresh();
                  })
                }
              >
                收起已确认操作
              </button>
            )}
          </div>
        </div>
      )}
      {state && (
        <>
          <div
            ref={panel}
            className="settings-panel"
            role="tabpanel"
            id={"settings-panel-" + tab}
            aria-label={tab === "plans" ? "本机操作审阅" : undefined}
            aria-labelledby={tab === "plans" ? undefined : "settings-tab-" + tab}
            tabIndex={0}
          >
            <div className="settings-content">
            {preview ? (
              <section
                className="author-preview"
                role="region"
                aria-label="本机设置决定预览"
              >
                <h3>{preview.title}</h3>
                  <p>
                    仅{preview.input.approve ? "批准" : "拒绝"}
                    刚才审阅的固定方案；批准后由外部 Agent 执行。
                  </p>
                <div className="actions">
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await desktop.settings("commit", {
                          token: preview.token,
                        });
                        setPreview(undefined);
                        await refresh();
                        notify(
                          "本机审核决定已保存；批准本身不会执行设置或安装。",
                        );
                      })
                    }
                  >
                    确认本机决定
                  </button>
                  <button disabled={busy} onClick={() => setPreview(undefined)}>
                    返回审阅
                  </button>
                </div>
              </section>
            ) : (
              <>
                {tab === "models" && <ModelSettings/>}
                {tab === "storage" && <StorageSettings notify={notify}/>}
                {tab === "general" && (
                  <>
                    <fieldset className="settings-appearance"><legend>外观</legend><div role="radiogroup" aria-label="外观">{(["system", "light", "dark"] as const).map(appearance => <button key={appearance} type="button" role="radio" tabIndex={current.appearance === appearance ? 0 : -1} aria-checked={current.appearance === appearance} disabled={busy || state.journal?.status === "pending"}
                      onClick={() => void savePreference("appearance", appearance)} onKeyDown={event => {if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return; event.preventDefault(); const siblings = [...event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>("button")], index = siblings.indexOf(event.currentTarget), next = (index + (event.key === "ArrowRight" ? 1 : 2)) % 3; siblings[next].focus(); siblings[next].click();}}><span className="appearance-preview" data-appearance={appearance} aria-hidden="true">{(appearance === "system" ? ["light", "dark"] : [appearance]).map(tone => <span className="appearance-window" data-tone={tone} key={tone}><span><i/><i/><i/><i/><i/></span><span><i/><i/><i/><i/></span><span><i/><i/><i/><i/></span></span>)}</span><span>{values[appearance]}</span></button>)}</div></fieldset>
                    <section className="settings-group"><h3>界面</h3><div>{field("language")}<InterfaceScale language={current.language}/></div></section>
                    {fields("创作库", ["library_list"])}
                    {fields("AI 执行", ["execution_mode"])}
                    <p className="settings-note">自动执行可直接处理当前工作区；确认后执行会在写入前集中展示本次变更。此设置由桌面、MCP、CLI 和 Skills 共用。</p>
                    <p className="settings-note">外观和创作偏好会同步到本机工作台。界面大小只影响当前窗口。</p>
                  </>
                )}
                {tab === "writing" && (
                  <>
                    {fields("写作保存", ["autosave"])}
                    <ReadingControls loadFonts={refresh => desktop.fonts(refresh)} preferences={current} kind={readingKind} onKindChange={setReadingKind} preview disabled={busy || state.journal?.status === "pending"}
                      onChange={patch => { for (const [key, value] of Object.entries(patch)) void savePreference(key, value); }}/>
                    {fields("写作习惯", ["focus_paragraph", "typewriter_scroll", "smart_pairs"])}
                    <p className="settings-note">排版只改变显示，不向正文添加空格。Fountain 剧本保持场次与对白的原有对齐。</p>
                  </>
                )}
                {tab === "versions" && (
                  <>
                    {fields("快照作者信息", [
                      "git_author_name",
                      "git_author_email",
                    ])}
                    <p className="settings-note">
                      名称与邮箱会写入 Git 历史，并随仓库同步。这里只保存本机署名，不修改系统 Git 配置，也不执行提交或同步。
                    </p>
                  </>
                )}
                {tab === "agents" && <>{desktop.agentSessionHost !== false && <CodexSettings preferences={current} disabled={busy || state.journal?.status === "pending"} onChange={patch => void savePreference("agent_session", patch)}/>}<details><summary>外部客户端、MCP App与Skills接入</summary><WorkAgent notify={notify} changed={() => refresh()}/></details></>}
                {tab === "plans" && (
                  <>
                    {plans.length ? (
                      <>
                        <label className="settings-plan-picker">
                          当前本机方案
                          <select
                            aria-label="当前本机方案"
                            disabled={busy}
                            value={selected}
                            onChange={(e) => {
                              setSelected(e.target.value);
                              setPreview(undefined);
                            }}
                          >
                            {plans.map((p) => (
                              <option
                                key={p.operation_id}
                                value={p.operation_id}
                              >
                                {p.fixed.summary} {planStates[p.state]}
                              </option>
                            ))}
                          </select>
                        </label>
                        {plan && (
                          <section
                            aria-label="本机方案内容"
                            className="settings-plan"
                          >
                            <h3>{plan.fixed.summary}</h3>
                            <p className="settings-note">
                              {
                                (
                                  {
                                    pending: "待作者审阅",
                                    approved: "已批准，等待外部 Agent 执行",
                                    rejected: "已拒绝",
                                    executing:
                                      "操作结果待确认，请让原 Agent 回读原方案",
                                    executed: "已执行，结果保留在原方案",
                                  } as Record<string, string>
                                )[plan.state]
                              }
                            </p>
                            {plan.fixed.kind === "preferences" ? (
                              <Changes
                                before={plan.fixed.before.preferences}
                                patch={plan.fixed.patch}
                              />
                            ) : plan.fixed.kind === "storage_cleanup" ? <StoragePlan plan={plan}/> : (
                              <dl className="settings-plan-metadata">
                                <dt>套件</dt>
                                <dd>
                                  {state.suites.find(
                                    (s: any) =>
                                      s.suite_id === plan.fixed.suite.suite_id,
                                  )?.family ?? plan.fixed.suite.name}{" "}
                                  {plan.fixed.suite.version}
                                </dd>
                                <dt>目标客户端</dt>
                                <dd>{display(plan.fixed.agent_client)}</dd>
                                <dt>本次操作</dt>
                                <dd>
                                  {plan.fixed.install
                                    ? "安装固定版本并选择此套件"
                                    : "仅选择，不安装文件"}
                                </dd>
                                <dt>适用范围</dt>
                                <dd>
                                  {plan.fixed.workspace_id
                                    ? "固定工作区"
                                    : "默认创作方法"}
                                </dd>
                              </dl>
                            )}
                            {plan.state !== "executed" &&
                              (!plan.is_current || plan.is_expired) && (
                                <p role="alert">
                                  方案已过期或偏好基线已变化，请让 Agent
                                  重新准备。
                                </p>
                              )}
                            {!["executing", "executed"].includes(
                              plan.state,
                            ) && (
                              <div className="actions">
                                {[true, false].map((approve) => (
                                  <button
                                    key={String(approve)}
                                    disabled={
                                      busy ||
                                      (approve &&
                                        (!plan.is_current || plan.is_expired))
                                    }
                                    onClick={() =>
                                      void run(async () => {
                                        setPreview({
                                          ...(await desktop.settings(
                                            "prepare",
                                            {
                                              operation_id: plan.operation_id,
                                              sha256: plan.sha256,
                                              revision: plan.revision,
                                              approve,
                                            },
                                          )),
                                          kind: "decide",
                                        });
                                      })
                                    }
                                  >
                                    {approve ? "批准本机方案" : "拒绝本机方案"}
                                  </button>
                                ))}
                              </div>
                            )}
                            {plan.state === "approved" && (
                              <button
                                disabled={busy}
                                onClick={() =>
                                  void run(async () => {
                                    await desktop.settings("continue", {
                                      operation_id: plan.operation_id,
                                    });
                                    notify(
                                      "已复制原方案执行请求，批准本身未执行设置或安装。",
                                    );
                                  })
                                }
                              >
                                让 AI 执行此方案
                              </button>
                            )}
                            {plan.installation && (
                              <p className="settings-note">
                                {plan.installation.state === "registered"
                                  ? "官方客户端已登记固定版本"
                                  : "所选方法文件已安装"}
                                ；需在外部 Agent 中检查会话加载状态。
                              </p>
                            )}
                            <details className="settings-technical">
                              <summary>固定方案与执行依据</summary>
                              <pre>{JSON.stringify(plan, null, 2)}</pre>
                            </details>
                          </section>
                        )}
                      </>
                    ) : (
                      <div className="settings-empty">
                        <Icon name="check" size={24} />
                        <p>暂无设置方案</p>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              await desktop.settings("handoff", {
                                section: tab,
                              });
                              notify("已复制本机设置协作请求。");
                            })
                          }
                        >
                          让 AI 准备设置方案
                        </button>
                      </div>
                    )}
                    {cursor && (
                      <button
                        disabled={busy}
                        onClick={() => void run(() => refresh(cursor))}
                      >
                        下一页本机方案
                      </button>
                    )}
                  </>
                )}
                {tab === "about" && (
                  <div className="settings-about">
                    <img src={(window as any).hetuWorkbenchAssets?.brand ?? "app-icon.png"} width="80" height="80" alt="" />
                    <h2>河图洛书 Hetu Luoshu</h2>
                    <p className="settings-note">{version}</p>
                    <p>设定有据，创作有序。</p>
                    <p className="settings-note">作品保存在各自的本地目录。创作由你选择的外部 Agent 协助完成。</p>
                  </div>
                )}
              </>
            )}
            </div>
          </div>
        </>
      )}
      </div>
    </section></PageActionsTarget.Provider>
  );
}
