import React, { useEffect, useRef, useState } from "react";
import { desktop } from "./bridge.ts";
import { Icon, IconButton, type IconName } from "./workbench.tsx";
import { version } from "../../package.json";
import "./settings.css";
import { ModelSettings } from "./model-settings.tsx";
import { WorkAgent } from "./work-agent.tsx";

const labels: Record<string, string> = {
  language: "界面语言",
  appearance: "外观",
  library_list: "创作库布局",
  autosave: "自动保存正文",
  font_family: "字体",
  font_size: "字号",
  line_spacing: "行间距",
  first_line_indent: "小说段落首行缩进两字",
  git_author_name: "姓名",
  git_author_email: "邮箱",
  agent_client: "默认外部 Agent",
};
const values: Record<string, string> = {
  "zh-CN": "简体中文",
  en: "English",
  system: "跟随系统",
  light: "浅色",
  dark: "深色",
  songti: "宋体",
  pingfang: "苹方",
  codex: "Codex",
  workbuddy: "WorkBuddy",
  claudeCode: "Claude Code",
  other: "其他客户端",
  none: "未选择",
};
const choices: Record<string, string[]> = {
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
type Tab = "general" | "writing" | "agents" | "models" | "versions" | "plans" | "about";
const tabs: { id: Tab; title: string; icon: IconName }[] = [
  { id: "general", title: "通用", icon: "sliders" },
  { id: "writing", title: "写作", icon: "type" },
  { id: "models", title: "模型服务", icon: "globe" },
  { id: "agents", title: "AI 协作", icon: "plugin" },
  { id: "versions", title: "版本", icon: "branch" },
  { id: "about", title: "关于", icon: "info" },
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
  return display(value);
}
function Changes({ before, patch }: { before: any; patch: any }) {
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
        {Object.entries(patch).map(([key, value]) => (
          <tr key={key}>
            <th>{labels[key] ?? key}</th>
            <td>{preferenceValue(key, before[key])}</td>
            <td>{preferenceValue(key, value)}</td>
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
    [tab, setTab] = useState<Tab>("general");
  const panel = useRef<HTMLDivElement>(null);
  const returnTab = useRef<Tab>("general");
  const saves = useRef<Promise<void>>(Promise.resolve());
  const currentState = useRef<any>();
  const plan = plans.find((p) => p.operation_id === selected);
  async function refresh(next?: string) {
    const [current, list] = await Promise.all([
      desktop.settings("get"),
      desktop.settings("list", next ? { cursor: next } : {}),
    ]);
    currentState.current = current;
    setState(current);
    changed(current.preferences);
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
    setPreview(undefined);
    setTab(next);
  }
  function tabKey(
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % tabs.length
        : event.key === "ArrowLeft"
          ? (index + tabs.length - 1) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    chooseTab(tabs[next].id);
    document.getElementById("settings-tab-" + tabs[next].id)?.focus();
  }
  function savePreference(key: string, value: unknown) {
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
    });
    saves.current = pending.catch(() => {});
    return pending;
  }
  function field(key: string) {
    const value = state.preferences[key], disabled = busy || state.journal?.status === "pending";
    const label = labels[key];
    return <label className="settings-field" key={key}>
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
  const current = state?.preferences;
  return (
    <section className="local-settings" aria-label="本机设置">
      <div className="settings-tabs" role="tablist" aria-label="设置分类">
        {tabs.map((item, index) => (
          <button
            key={item.id}
            id={"settings-tab-" + item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            aria-controls={"settings-panel-" + item.id}
            tabIndex={tab === item.id ? 0 : -1}
            onClick={() => chooseTab(item.id)}
            onKeyDown={(event) => tabKey(event, index)}
          >
            <Icon name={item.icon} size={18} />
            <span>{item.title}</span>
          </button>
        ))}
      </div>
      <div className="settings-tools">
        {tab === "plans" ? <><button onClick={() => { setPreview(undefined); setTab(returnTab.current); }}>返回设置</button>
          <button disabled={busy} onClick={() => void run(async () => { await desktop.settings("handoff", { section: returnTab.current }); notify("已复制本机设置协作请求。"); })}><Icon name="sparkles"/>让 AI 调整设置</button>
          <IconButton icon="refresh" label="刷新本机设置" disabled={busy} onClick={() => void run(() => refresh())}/></>
          : <button disabled={busy} onClick={() => { returnTab.current = tab; setPreview(undefined); setTab("plans"); void run(() => refresh()); }}><Icon name="sparkles"/>让 AI 处理与审阅{plans.some(p => p.state === "pending") && <span className="settings-pending" aria-label="有待审方案"/>}</button>}
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
                {tab === "general" && (
                  <>
                    {fields("界面", ["language", "appearance"])}
                    {fields("创作库", ["library_list"])}
                    <p className="settings-note">设置自动保存，并立即应用到所有河图洛书窗口。</p>
                  </>
                )}
                {tab === "writing" && (
                  <>
                    {fields("正文排版", [
                      "autosave",
                      "font_family",
                      "font_size",
                      "line_spacing",
                      "first_line_indent",
                    ])}
                    <section className="settings-group">
                      <h3>排版预览</h3>
                      <div
                        className="settings-reading-preview"
                        style={{
                          fontFamily: (
                            {
                              songti: '"Songti SC", serif',
                              pingfang: '"PingFang SC", sans-serif',
                              system: "system-ui, sans-serif",
                            } as Record<string, string>
                          )[current.font_family],
                          fontSize: `${current.font_size}px`,
                          lineHeight: `calc(1.35em + ${current.line_spacing}px)`,
                          textIndent: current.first_line_indent ? "2em" : "0",
                        }}
                      >
                        <p>雨落在窗边，故事从这一刻开始。</p><p>远处的灯亮了，有人正踏着夜色归来。</p>
                      </div>
                    </section>
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
                {tab === "agents" && <WorkAgent notify={notify}/>}
                {tab === "plans" && (
                  <>
                    <h2 className="settings-section-heading">本机操作审阅</h2>
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
                                      "安装结果待确认，请让原 Agent 回读原方案",
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
                            ) : (
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
                    <img src="app-icon.png" width="80" height="80" alt="" />
                    <h2>河图洛书 Hetu Luoshu</h2>
                    <p className="settings-note">{version}</p>
                    <p>设定有据，创作有序。</p>
                    <p className="settings-note">作品保存在各自的本地目录。创作由你选择的外部 Agent 协助完成。</p>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
