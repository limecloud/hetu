import React, { useEffect, useRef, useState } from "react";
import type { WorkRef } from "@hetu/plugin-sdk";
import { desktop } from "./bridge.ts";
import { Icon, IconButton, Workbench } from "./workbench.tsx";
import "./work-agent.css";

const clients = [["codex", "Codex"], ["claudeCode", "Claude Code"], ["workbuddy", "WorkBuddy"], ["other", "其他客户端"], ["none", "暂不使用"]];
const clientName = (value: string) => clients.find(([id]) => id === value)?.[1] ?? value;
const states: Record<string, string> = { missing: "未发现安装记录或包文件", found: "已找到完整套件文件", invalid: "套件文件不完整或身份不符", unsupported: "请手动接入后在客户端验证", manual: "暂不使用外部客户端" };
const registrations: Record<string, string> = { enabled: "已启用", disabled: "已登记，尚未启用", missing: "未发现对应启用登记", unknown: "未能核对", not_applicable: "待在客户端验证" };

export function WorkAgent({ work, notify }: { work?: WorkRef; notify(message: string): void }) {
  const { agentStatus } = React.useContext(Workbench);
  const request = work ? desktop.workAgent : desktop.settingsAgent;
  const [state, setState] = useState<any>(), [inspection, setInspection] = useState<any>(), [busy, setBusy] = useState(false), [checking, setChecking] = useState(false), [error, setError] = useState("");
  const [query, setQuery] = useState(""), [platform, setPlatform] = useState(""), [channel, setChannel] = useState("");
  const [brief, setBrief] = useState(""), [reply, setReply] = useState(""), [advice, setAdvice] = useState<any[]>([]), [adviceError, setAdviceError] = useState("");
  const [modal, setModal] = useState<"guide" | "install">(), [plan, setPlan] = useState<any>(), [decision, setDecision] = useState<any>();
  const alive = useRef(true), generation = useRef(0), dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false; generation.current++; }; }, [work?.workspace_id, work?.kind, work?.object_id]);
  useEffect(() => { if (modal) dialog.current?.showModal(); else dialog.current?.close(); }, [modal]);
  async function check() {
    const token = ++generation.current; setChecking(true); setInspection(undefined);
    try { const value = await request("inspect"); if (alive.current && token === generation.current) setInspection(value); }
    catch (e) { if (alive.current && token === generation.current) setError((e as Error).message); }
    finally { if (alive.current && token === generation.current) setChecking(false); }
  }
  async function refresh() {
    setError("");
    try { const value = await request("get"); if (!alive.current) return; setState(value); await check(); }
    catch (e) { if (alive.current) setError((e as Error).message); }
  }
  async function run(action: () => Promise<void>) {
    setBusy(true); setError("");
    try { await action(); } catch (e) { if (alive.current) setError((e as Error).message); }
    finally { if (alive.current) setBusy(false); }
  }
  async function select(client: string, suite: string) {
    generation.current++; setInspection(undefined);
    await run(async () => { const value = await request("select", { expected_revision: state.revision, agent_client: client, suite_id: suite }); if (!alive.current) return; setState(value); await check(); });
  }
  const association = state?.association, selected = state?.suites.find((s: any) => s.suite_id === association.suite);
  const scoped = state?.categories.filter((c: any) => (!platform || c.platform === platform) && (!channel || c.channel === channel || c.channel === "shared")) ?? [];
  const allowed = new Set(scoped.flatMap((c: any) => c.suiteIDs));
  const matching = state?.suites.filter((s: any) => (!platform && !channel || allowed.has(s.suite_id)) && (!query || [s.title, s.family, ...(s.aliases ?? [])].some((v: string) => v?.includes(query)) || scoped.some((c: any) => c.name.includes(query) && c.suiteIDs.includes(s.suite_id)))) ?? [];
  const options = state?.suites.filter((s: any) => s.suite_id === association.suite || matching.includes(s)) ?? [];
  const disabled = busy || !!state?.other_pending || state?.journal?.status === "pending" || agentStatus.state === 'running';
  const installable = state?.installable_clients.includes(association?.client);
  async function prepareInstall() {
    await run(async () => { const value = await request("prepare_install"); if (!alive.current) return; setPlan(value); setDecision(undefined); setModal("install"); });
  }
  async function copySelection() {
    await desktop.copy("请帮助我为河图洛书" + (work ? "当前作品" : "新作品默认创作方法") + "选择题材Skills套件。先理解我的创作意图，再从以下真实目录推荐最多三项；不要安装全部套件，不要改写作品或声称已接入。返回JSON：{\"recommendations\":[{\"suiteID\":\"目录ID\",\"reason\":\"推荐理由与取舍\"}]}。\n" + JSON.stringify({ work_ref: work, scope: work ? "work" : "default", author_input: brief, suites: state.suites.map((s: any) => ({ id: s.suite_id, title: s.title, summary: s.summary })) }, null, 2));
    notify("已复制套件选择请求。");
  }
  function readAdvice() {
    setAdviceError(""); setAdvice([]);
    try {
      const value = JSON.parse(reply), items = value.recommendations;
      if (!Array.isArray(items) || !items.length || items.length > 3 || new Set(items.map(i => i.suiteID)).size !== items.length
        || items.some(i => !state.suites.some((s: any) => s.suite_id === i.suiteID) || typeof i.reason !== "string" || !i.reason.trim() || i.reason.length > 4000)) throw new Error();
      setAdvice(items);
    } catch { setAdviceError("建议格式或套件ID无效，请让Agent按请求中的格式返回。"); }
  }
  return <section className="work-agent" aria-label={work ? "作品AI协作" : "默认AI协作"} aria-busy={busy || checking}>
    <header><h3><Icon name="plugin"/>AI 协作</h3><div className="actions">
      <button disabled={!state || busy} onClick={() => void desktop.settings("handoff", { section: "agent_suite", work_ref: work }).then(() => notify(work ? "已复制当前作品的协作设置请求。" : "已复制默认协作设置请求。")).catch(e => setError(e.message))}>让 AI 调整</button>
      <button disabled={!state || busy || checking} onClick={() => void refresh()}><Icon name="refresh"/>重新检查</button>
    </div></header>
    {error && <p role="alert">{error}</p>}
    {!state ? <p className="muted">正在读取协作设置…</p> : <>
      {(state.journal || state.other_pending) && <div className="work-agent-recovery" role="status"><p>{state.other_pending ? "有待确认的本机操作，请在设置中恢复。" : state.journal.status === "pending" ? "上次选择的结果尚未确认。" : "上次选择已有明确结果。"}</p>{!state.other_pending && <button disabled={busy} onClick={() => void run(async () => { await request(state.journal.status === "pending" ? "recover" : "acknowledge"); await refresh(); })}>{state.journal.status === "pending" ? "恢复原操作" : "收起已确认操作"}</button>}</div>}
      <div className="work-agent-options">
        <label className="work-agent-client"><span>{work ? "本作品客户端" : "默认客户端"}</span><select aria-label={work ? "本作品客户端" : "默认客户端"} value={association.client} disabled={disabled} onChange={e => void select(e.target.value, association.suite)}>{clients.map(([id,title]) => <option key={id} value={id}>{title}</option>)}</select></label>
        <label><span>题材 Skills 套件</span><select aria-label="题材 Skills 套件" value={association.suite} disabled={disabled} onChange={e => void select(association.client, e.target.value)}>{options.map((s: any) => <option key={s.suite_id} value={s.suite_id}>{s.title}</option>)}</select></label>
        <details className="work-agent-finder"><summary>按分类查找或由外部 Agent 引导</summary><div>
          <input aria-label="搜索题材套件" placeholder="搜索题材或分类" value={query} onChange={e => setQuery(e.target.value)}/>
          <div className="work-agent-filters"><label>平台<select aria-label="题材平台" value={platform} onChange={e => setPlatform(e.target.value)}><option value="">全部平台</option><option value="fanqie">番茄小说</option><option value="qidian">起点中文网</option></select></label><label>频道<select aria-label="题材频道" value={channel} onChange={e => setChannel(e.target.value)}><option value="">全部频道</option><option value="male">男频</option><option value="female">女频</option></select></label></div>
          {!matching.length && <p className="muted">没有符合条件的套件，已保留当前选择。</p>}
          {query && scoped.filter((c: any) => c.name.includes(query)).slice(0,3).map((c: any) => <p className="work-agent-scope" key={c.id}>{c.path}</p>)}
          <section className="work-agent-advice"><h4>让 Agent 帮我选择</h4><textarea aria-label="套件选择目标" placeholder="描述作品方向、主要读者与写作偏好" value={brief} maxLength={6000} onChange={e => setBrief(e.target.value)}/><button onClick={() => void run(copySelection)}>复制选择请求</button>
            <textarea aria-label="Agent 套件建议" placeholder="粘贴 Agent 返回的建议" value={reply} maxLength={20000} onChange={e => { setReply(e.target.value); setAdvice([]); setAdviceError(""); }}/><button disabled={!reply.trim()} onClick={readAdvice}>读取建议</button>
            {adviceError && <p role="alert">{adviceError}</p>}{advice.map(item => <article key={item.suiteID}><strong>{state.suites.find((s: any) => s.suite_id === item.suiteID)?.title}</strong><p>{item.reason}</p><button disabled={disabled} onClick={() => void select(association.client, item.suiteID)}>采用此建议</button></article>)}
          </section>
        </div></details>
      </div>
      {checking ? <p className="work-agent-checking muted">正在检查所选客户端与套件…</p> : inspection && <div className="work-agent-inspection">
        <dl><dt>套件检测</dt><dd>{states[inspection.state]}</dd><dt>本机包版本</dt><dd>{inspection.version ?? "未知"}</dd><dt>随附套件版本</dt><dd>{inspection.bundled.version}</dd>
          {association.client === "codex" && <><dt>Codex 本机启用配置</dt><dd>{registrations[inspection.registration]}</dd></>}
          {inspection.directory && <><dt>本机包目录</dt><dd className="work-agent-path">{inspection.directory}</dd></>}
          <dt>检查时间</dt><dd>{new Date(inspection.checked_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</dd><dt>当前会话加载</dt><dd>待在客户端验证</dd><dt>任务 MCP 连接</dt><dd>待在客户端验证</dd>
        </dl>{inspection.version_differs && <p className="work-agent-scope">本机包与随附套件的版本不同。</p>}
        <p className="work-agent-scope">安装状态不代表当前会话已加载。</p>
      </div>}
      <details className="work-agent-skills" open><summary>套件包含的 Skills</summary><ul>{state.skills.map((skill: any) => {
        const found = inspection?.found_skills.includes(skill.id); return <li key={skill.id}><span className={found ? "work-agent-skill-check found" : "work-agent-skill-check"} aria-hidden="true">{found ? <Icon name="check"/> : <svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="2 2"/></svg>}</span><div><span>{skill.title}</span><small>{skill.id}</small></div><div className="work-agent-skill-state"><span>{checking ? "正在检查" : found ? "已找到方法文件" : "未验证安装"}</span>{found && <small>版本 {inspection.version}</small>}</div></li>;
      })}</ul></details>
      <div className="actions work-agent-package-actions"><button disabled={disabled || !installable} onClick={() => void prepareInstall()}>安装 Skills 套件</button><button onClick={() => setModal("guide")}>安装与接入说明</button><button disabled={busy} onClick={() => void run(async () => { await request("reveal_bundle"); })}>查看随附套件</button><button disabled={disabled || association.client === "none"} onClick={() => void run(async () => { await request("choose_package"); await refresh(); })}>选择已安装目录</button>{inspection?.selected_directory && <button disabled={disabled} onClick={() => void run(async () => { await request("auto_detect"); await refresh(); })}>自动检测</button>}</div>
      {state.directory && <div className="work-agent-folder"><span>作品目录</span><span>{state.directory}</span></div>}
    </>}
    {modal && <dialog className="work-agent-dialog" ref={dialog} onCancel={() => { setModal(undefined); setDecision(undefined); }}><header><h2>{modal === "guide" ? "安装与接入说明" : "安装 Skills 套件"}</h2><IconButton icon="close" label="关闭接入窗口" disabled={busy} onClick={() => { setModal(undefined); setDecision(undefined); }}/></header>
      {modal === "guide" ? <><p>将所选题材套件安装到{clientName(association?.client)}，再在该客户端的新会话中验证 Skills 与任务连接。</p><p>Codex 和 WorkBuddy 可准备固定安装方案；其他客户端使用随附目录中的任务方法与接入说明。</p><p className="muted">套件选择与当前作品授权分别管理。安装不会修改正文、采纳候选或确认定稿。</p><button onClick={() => void run(async () => { await request("reveal_bundle"); })}>打开所选套件目录</button></> : plan && <>
        <dl><dt>接入客户端</dt><dd>{clientName(plan.fixed.agent_client)}</dd><dt>所选套件</dt><dd>{selected?.title}</dd><dt>固定版本</dt><dd>{plan.fixed.suite.version}</dd><dt>文件数量</dt><dd>{plan.fixed.suite.file_count}</dd><dt>作者决定</dt><dd>{plan.state === "approved" ? "已批准，待 Agent 执行" : "待审阅"}</dd></dl>
        <p className="muted">只安装当前所选套件。批准后由外部 Agent 沿原方案执行。</p>
        {plan.state === "approved" ? <button className="primary" disabled={busy} onClick={() => void run(async () => { await desktop.settings("continue", { operation_id: plan.operation_id }); notify("已复制原安装方案，请交给当前客户端执行。"); })}>复制给 Agent 执行</button> : <button className="primary" disabled={busy} onClick={() => void run(async () => {
          const preview = decision ?? await desktop.settings("prepare", { operation_id: plan.operation_id, sha256: plan.sha256, revision: plan.revision, approve: true });
          if (!alive.current) return; setDecision(preview);
          const approved = await desktop.settings("commit", { token: preview.token }); if (alive.current) { setPlan(approved); setDecision(undefined); }
        })}>批准此安装方案</button>}
      </>}{error && <p role="alert">{error}</p>}
    </dialog>}
  </section>;
}
