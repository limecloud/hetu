import React, { useEffect, useRef, useState } from "react";
import { desktop } from "./bridge.ts";
import { Icon, IconButton, type IconName } from "./workbench.tsx";
import { version } from "../../package.json";
import "./settings.css";
import { ModelSettings } from "./model-settings.tsx";

const labels: Record<string, string> = {
  language: "界面语言",
  appearance: "外观",
  library_list: "创作库布局",
  autosave: "自动保存人工编辑",
  font_family: "阅读字体",
  font_size: "正文字号",
  line_spacing: "正文行距",
  first_line_indent: "正文首行缩进",
  git_author_name: "版本作者姓名",
  git_author_email: "版本作者邮箱",
  agent_client: "默认外部 Agent",
};
const values: Record<string, string> = {
  "zh-CN": "简体中文",
  en: "English",
  system: "跟随系统",
  light: "浅色",
  dark: "深色",
  songti: "宋体",
  pingfang: "黑体",
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
  { id: "general", title: "通用", icon: "settings" },
  { id: "writing", title: "写作", icon: "file" },
  { id: "agents", title: "AI协作", icon: "plugin" },
  { id: "models", title: "模型服务", icon: "link" },
  { id: "versions", title: "版本", icon: "branch" },
  { id: "plans", title: "设置方案", icon: "list" },
  { id: "about", title: "关于", icon: "book" },
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
    [draft, setDraft] = useState<any>(),
    [suite, setSuite] = useState("general"),
    [client, setClient] = useState("codex"),
    [install, setInstall] = useState(false),
    [tab, setTab] = useState<Tab>("general");
  const panel = useRef<HTMLDivElement>(null);
  const draftBase = useRef<any>();
  const plan = plans.find((p) => p.operation_id === selected);
  async function refresh(next?: string) {
    const [current, list] = await Promise.all([
      desktop.settings("get"),
      desktop.settings("list", next ? { cursor: next } : {}),
    ]);
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
  function field(key: string) {
    const value = draft ? draft[key] : state.preferences[key];
    return (
      <label className="settings-field" key={key}>
        <span>{labels[key]}</span>
        {!draft ? (
          <output>{preferenceValue(key, value)}</output>
        ) : key === "library_list" ? (
          <select
            aria-label={labels[key]}
            value={value ? "list" : "grid"}
            disabled={busy}
            onChange={(e) =>
              setDraft({ ...draft, [key]: e.target.value === "list" })
            }
          >
            <option value="grid">封面</option>
            <option value="list">列表</option>
          </select>
        ) : typeof value === "boolean" ? (
          <input
            type="checkbox"
            aria-label={labels[key]}
            checked={value}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, [key]: e.target.checked })}
          />
        ) : ["font_size", "line_spacing"].includes(key) ? (
          <input
            type="number"
            aria-label={labels[key]}
            disabled={busy}
            min={key === "font_size" ? 14 : 0}
            max={key === "font_size" ? 30 : 16}
            value={value}
            onChange={(e) =>
              setDraft({ ...draft, [key]: Number(e.target.value) })
            }
          />
        ) : choices[key] ? (
          <select
            aria-label={labels[key]}
            value={value}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
          >
            {choices[key].map((choice) => (
              <option key={choice} value={choice}>
                {display(choice)}
              </option>
            ))}
          </select>
        ) : (
          <input
            aria-label={labels[key]}
            maxLength={256}
            value={value}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
          />
        )}
      </label>
    );
  }
  function fields(title: string, keys: string[]) {
    return (
      <section className="settings-group">
        <h3>{title}</h3>
        <div>{keys.map(field)}</div>
      </section>
    );
  }
  const editable = ["general", "writing", "agents", "versions"].includes(tab);
  const current = draft ?? state?.preferences;
  return (
    <section className="local-settings" aria-label="本机设置">
      <div className="settings-tools">
        {tab !== "models" && <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await desktop.settings("handoff", { section: tab });
              notify("已复制本机设置协作请求。");
            })
          }
        >
          <Icon name="sparkles" />让 AI 调整设置
        </button>}
        {tab !== "models" && <IconButton
          icon="refresh"
          label="刷新本机设置"
          disabled={busy}
          onClick={() => void run(() => refresh())}
        />}
      </div>
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
            {item.id === "plans" &&
              plans.some((p) => p.state === "pending") && (
                <span className="settings-pending" aria-label="有待审方案" />
              )}
          </button>
        ))}
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
            aria-labelledby={"settings-tab-" + tab}
            tabIndex={0}
          >
            {preview ? (
              <section
                className="author-preview"
                role="region"
                aria-label="本机设置决定预览"
              >
                <h3>{preview.title}</h3>
                {preview.kind === "manual" ? (
                  <Changes
                    before={preview.view.preferences}
                    patch={preview.input.patch}
                  />
                ) : (
                  <p>
                    仅{preview.input.approve ? "批准" : "拒绝"}
                    刚才审阅的固定方案；批准后由外部 Agent 执行。
                  </p>
                )}
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
                        setDraft(undefined);
                        await refresh();
                        notify(
                          preview.kind === "manual"
                            ? "已保存本机偏好。"
                            : "本机审核决定已保存；批准本身不会执行设置或安装。",
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
                    <h2 className="settings-section-heading">
                      阅读与工作台偏好
                    </h2>
                    {fields("界面", ["language", "appearance"])}
                    {fields("创作库", ["library_list"])}
                  </>
                )}
                {tab === "writing" && (
                  <>
                    {fields("正文", [
                      "autosave",
                      "font_family",
                      "font_size",
                      "line_spacing",
                      "first_line_indent",
                    ])}
                    <section className="settings-group">
                      <h3>阅读预览</h3>
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
                        清晨的雾气沿着山谷缓缓流动。她将旧日记放回书袋，沿海岸寻找灯塔。每一封信，都有自己的来处。
                      </div>
                    </section>
                  </>
                )}
                {tab === "versions" && (
                  <>
                    {fields("版本作者", [
                      "git_author_name",
                      "git_author_email",
                    ])}
                    <p className="settings-note">
                      仅用于河图的版本操作，不修改系统 Git 身份。
                    </p>
                  </>
                )}
                {tab === "agents" && (
                  <>
                    {fields("外部 Agent", ["agent_client"])}
                    <details className="settings-suite">
                      <summary>选择创作方法与外部 Agent 套件</summary>
                      <label className="settings-field">
                        <span>创作方法</span>
                        <select
                          aria-label="创作方法套件"
                          disabled={busy}
                          value={suite}
                          onChange={(e) => setSuite(e.target.value)}
                        >
                          {state.suites.map((s: any) => (
                            <option value={s.suite_id} key={s.suite_id}>
                              {s.family} {s.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <p className="settings-note">
                        {
                          state.suites.find((s: any) => s.suite_id === suite)
                            ?.summary
                        }
                      </p>
                      <label className="settings-field">
                        <span>接入客户端</span>
                        <select
                          aria-label="套件接入客户端"
                          disabled={busy}
                          value={client}
                          onChange={(e) => {
                            setClient(e.target.value);
                            setInstall(false);
                          }}
                        >
                          {["codex", "workbuddy", "claudeCode", "other"].map(
                            (v) => (
                              <option key={v} value={v}>
                                {display(v)}
                              </option>
                            ),
                          )}
                        </select>
                      </label>
                      <label className="settings-install">
                        <input
                          type="checkbox"
                          checked={install}
                          disabled={
                            busy || !state.installable_clients.includes(client)
                          }
                          onChange={(e) => setInstall(e.target.checked)}
                        />
                        安装所选方法文件
                      </label>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            const result = await desktop.settings(
                              "select_suite",
                              {
                                suite_id: suite,
                                agent_client: client,
                                install,
                              },
                            );
                            await refresh();
                            setSelected(result.operation_id);
                            setTab("plans");
                            notify("已准备套件方案，请审阅固定版本后批准。");
                          })
                        }
                      >
                        准备套件选择方案
                      </button>
                    </details>
                  </>
                )}
                {tab === "plans" && (
                  <>
                    <h2 className="settings-section-heading">设置方案</h2>
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
                    <h2>河图洛书</h2>
                    <p className="settings-note">{version}</p>
                    <p>设定有据，作者掌规，Agent 佐笔。</p>
                    <p className="settings-note">作品与偏好保存在本机。</p>
                  </div>
                )}
              </>
            )}
          </div>
          {!preview && editable && (
            <div className="settings-edit-actions">
              {draft ? (
                <>
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const patch = Object.fromEntries(
                          Object.entries(draft).filter(
                            ([key, value]) =>
                              draftBase.current.preferences[key] !== value,
                          ),
                        );
                        if (!Object.keys(patch).length)
                          throw new Error("尚未修改偏好。");
                        setPreview({
                          ...(await desktop.settings("manual", {
                            expected_revision: draftBase.current.revision,
                            patch,
                          })),
                          kind: "manual",
                        });
                      })
                    }
                  >
                    预览偏好变化
                  </button>
                  <button disabled={busy} onClick={() => setDraft(undefined)}>
                    收起编辑
                  </button>
                </>
              ) : (
                <button
                  disabled={busy}
                  onClick={() => {
                    draftBase.current = {
                      revision: state.revision,
                      preferences: { ...state.preferences },
                    };
                    setDraft({ ...state.preferences });
                  }}
                >
                  自行调整偏好
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
