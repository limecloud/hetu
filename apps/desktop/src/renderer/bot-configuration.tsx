import React, {useEffect, useRef, useState} from "react";
import {Icon, IconButton} from "@hetu/workbench-ui";
import type {AgentEngine, AgentModel} from "../agent-session-contract.ts";
import type {ExecutionSessionItem} from "./execution-navigation.tsx";
import {AgentLaunchPicker, engineTitle, type AgentPickerValue} from "./agent-launch-picker.tsx";
import {AgentProviderIcon} from "./agent-provider-icons.tsx";
import {desktop} from "./bridge.ts";

type BotConfig = {name: string; purpose: string; execution: {provider_id: string; surface: string; model_id: string}};
export const botSessionStatus: Record<string, string> = {ready: "已连接", running: "处理中", starting: "正在连接", stopping: "正在停止", stopped: "已停止", idle: "尚未启动", uncertain: "结果待核对", failed: "连接失败", disconnected: "连接中断"};

/** 模型选择只提交固定执行配置；原聊天和执行端不会随配置修改而重启。 */
export function BotExecutionPicker({config, engines, disabled, compact, onSave, notify}: {
  config: BotConfig; engines: AgentEngine[]; disabled?: boolean; compact?: boolean;
  onSave(patch: Record<string, unknown>): Promise<void>; notify(message: string): void;
}) {
  const [choice, setChoice] = useState<AgentPickerValue>({client: config.execution.provider_id, model: config.execution.model_id});
  const [surface, setSurface] = useState(config.execution.surface);
  const [models, setModels] = useState<AgentModel[]>([]), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [dismiss, setDismiss] = useState(0);
  const saving = useRef(false);
  const reset = () => {setChoice({client: config.execution.provider_id, model: config.execution.model_id}); setSurface(config.execution.surface); setError("");};
  useEffect(reset, [config.execution.provider_id, config.execution.model_id, config.execution.surface]);
  useEffect(() => {
    let active = true; setModels([]); setLoading(true);
    void desktop.agentSession("model_options", {client: choice.client}).then(value => {if(active)setModels(value);}).catch(error => {if(active)setError(error.message);}).finally(() => {if(active)setLoading(false);});
    return () => {active = false;};
  }, [choice.client]);
  const execution = {provider_id: choice.client, surface, model_id: choice.model};
  const changed = choice.client !== config.execution.provider_id || choice.model !== config.execution.model_id || surface !== config.execution.surface;
  const save = async () => {
    if(saving.current || !choice.model?.trim() || !changed) return;
    saving.current = true; setBusy(true); setError("");
    try {await onSave({execution}); setDismiss(value => value + 1);}
    catch(error) {setError((error as Error).message); notify((error as Error).message);} finally {saving.current = false; setBusy(false);}
  };
  return <div className={compact ? "bot-composer-model" : "bot-execution-setting"}>
    <AgentLaunchPicker value={choice} onOpen={reset} dismissKey={dismiss} onChange={value => {setChoice({client:value.client,model:value.model}); if(!engines.find(item => item.id === value.client)?.chat) setSurface("tui");}} engines={engines.filter(item => item.id !== "shell")} models={models.map(item=>({...item,efforts:[]}))} loading={loading} label={compact ? "助手模型" : "智能体"} showEngine={!compact} customModelLabel="助手模型" allowDefault={false} disabled={disabled || busy} footer={<div className="bot-picker-footer">
      <div className="bot-surface-choice" role="group" aria-label="运行方式"><button type="button" disabled={busy || !engines.find(item => item.id === choice.client)?.chat} aria-pressed={surface === "gui"} onClick={() => setSurface("gui")}><Icon name="comment" size={14}/>聊天</button><button type="button" disabled={busy} aria-pressed={surface === "tui"} onClick={() => setSurface("tui")}><Icon name="terminal" size={14}/>终端</button></div>
      <p>新聊天使用此配置，原聊天保留。</p>{error && <p role="alert">{error}</p>}
      <button type="button" className="primary" disabled={disabled || busy || !changed || !choice.model?.trim() || !engines.find(item => item.id === choice.client)?.available} onClick={() => void save()}>{busy ? "正在保存…" : "保存配置"}</button>
    </div>}/>
  </div>;
}

export function BotInspector({selected, session, sessions, engines, view, onView, onClose, onOpenSession, onSave, onStatus, requests, onRequest, busy, notify}: {
  selected: any; session?: any; sessions: (ExecutionSessionItem & {state?: string; surface?: string})[]; engines: AgentEngine[];
  view: "home" | "history" | "settings"; onView(view: "home" | "history" | "settings"): void; onClose(): void;
  onOpenSession(id: string): Promise<void>; onSave(patch: Record<string, unknown>): Promise<void>;
  onStatus(method: "pause" | "resume" | "archive" | "restore"): Promise<void>;
  requests: any[]; onRequest(item: any): void; busy: boolean; notify(message: string): void;
}) {
  const [field, setField] = useState<"name" | "purpose">(), [text, setText] = useState(""), [error, setError] = useState("");
  const config: BotConfig | undefined = selected?.bot.config;
  const edit = (key: "name" | "purpose") => {setText(config![key]); setField(key); setError("");};
  useEffect(() => {setField(undefined); setError("");}, [selected?.bot_ref.bot_id, view]);
  const saveField = async () => {try {await onSave({[field!]: text}); setField(undefined); setError("");} catch(error) {setError((error as Error).message);}};
  return <aside className="bot-inspector" aria-label="Bot 详情" onKeyDown={event=>{if(event.key==="Escape"&&!event.defaultPrevented&&!event.nativeEvent.isComposing&&(field||view==="settings")){event.preventDefault();event.stopPropagation();if(field)setField(undefined);else onView("home");}}}>
    <header className="bot-inspector-toolbar"><button type="button" aria-pressed={view === "home" || view === "settings"} onClick={() => onView("home")}><Icon name="book" size={14}/>主页</button><button type="button" aria-pressed={view === "history"} onClick={() => onView("history")}><Icon name="comment" size={14}/>聊天</button><span/><IconButton icon="inspector" label="关闭 Bot 详情" onClick={onClose}/></header>
    {config && <div className="bot-inspector-body">
      {view === "home" && <>
        <div className="bot-profile"><span className="bot-avatar" aria-hidden>{Array.from(config.name)[0]}</span><div><h3>{config.name}</h3><p>{config.purpose}</p></div><IconButton icon="settings" label="Bot 设置" onClick={() => onView("settings")}/></div>
        <section className="bot-home-status" aria-label="Bot 当前事项"><Icon name={requests.length ? "shield" : "list"} size={22}/><h4>{requests.length ? "需要你答复" : session?.state === "running" ? "正在处理当前任务" : "还没有待答事项"}</h4><p>{requests.length ? "查看当前会话的原请求并继续。" : session?.state === "running" ? "进展和成果会在原会话中更新。" : "在聊天中告诉它接下来处理什么。"}</p></section>
        {requests.map(item => <button className="bot-home-request" key={item.id} onClick={() => onRequest(item)}><Icon name="shield" size={14}/><span>{item.title ?? "查看待答请求"}</span><Icon name="chevron" size={12}/></button>)}
        <button className="bot-settings-link" onClick={() => onView("settings")}><Icon name="settings" size={14}/>Bot 设置…<Icon name="chevron" size={12}/></button>
      </>}
      {view === "history" && <><h3 className="bot-pane-title">聊天</h3>{sessions.map(item => <button key={item.session_id} className="bot-history-row" aria-current={session?.session_id === item.session_id ? "true" : undefined} disabled={busy} onClick={() => void onOpenSession(item.session_id).catch(error => notify(error.message))}><Icon name={item.surface === "tui" ? "terminal" : "comment"} size={14}/><span><strong>{item.title}</strong><small>{botSessionStatus[item.state ?? ""] ?? item.state}</small></span><Icon name="chevron" size={12}/></button>)}{!sessions.length && <p className="bot-pane-empty">还没有聊天。</p>}</>}
      {view === "settings" && <>
        <header className="bot-settings-path"><IconButton icon="back" label={field ? "返回 Bot 设置" : "返回 Bot 主页"} onClick={() => field ? setField(undefined) : onView("home")}/><span>{config.name} / {field === "name" ? "名称" : field === "purpose" ? "身份" : "设置"}</span></header>
        {field ? <form className="bot-field-editor" onSubmit={event => {event.preventDefault(); void saveField();}}><label>{field === "name" ? "名称" : "身份"}{field === "name" ? <input autoFocus aria-label="Bot 名称" maxLength={100} value={text} onChange={event => setText(event.target.value)}/> : <textarea autoFocus aria-label="Bot 身份" maxLength={8000} rows={8} value={text} onChange={event => setText(event.target.value)}/>}</label>{error && <p role="alert">{error}</p>}<p>原聊天保留固定身份，新聊天使用更新后的配置。</p><footer><button type="button" disabled={busy} onClick={() => setField(undefined)}>取消</button><button className="primary" disabled={busy || !text.trim() || text === config[field]}>{busy ? "正在保存…" : "保存"}</button></footer></form> : <>
          <button className="bot-settings-profile" disabled={busy} onClick={() => edit("name")}><span className="bot-avatar" aria-hidden>{Array.from(config.name)[0]}</span><strong>{config.name}</strong><Icon name="chevron" size={12}/></button>
          <section className="bot-inset-group"><h4>智能体</h4><div className="bot-setting-row"><AgentProviderIcon client={config.execution.provider_id} size={14}/><BotExecutionPicker config={config} engines={engines} disabled={busy || selected.bot.status === "archived"} onSave={onSave} notify={notify}/></div><div className="bot-setting-row"><Icon name="terminal" size={14}/><strong>电脑</strong><span>本地{navigator.platform.includes("Mac") ? " Mac" : "电脑"}</span></div><div className="bot-setting-row"><Icon name="check" size={14}/><strong>已启用</strong><button role="switch" aria-label="已启用" aria-checked={selected.bot.status === "active"} disabled={busy || selected.bot.status === "archived"} onClick={() => void onStatus(selected.bot.status === "active" ? "pause" : "resume").catch(error => notify(error.message))}><span/></button></div></section>
          <section className="bot-inset-group"><h4>身份</h4><button className="bot-setting-row bot-purpose-row" disabled={busy} onClick={() => edit("purpose")}><Icon name="file" size={14}/><span>{config.purpose}</span><Icon name="chevron" size={12}/></button></section>
          {selected.bot.status === "archived" ? <button className="bot-settings-link" disabled={busy} onClick={() => void onStatus("restore").catch(error => notify(error.message))}>恢复 bot</button> : <button className="bot-archive-link" disabled={busy} onClick={() => void onStatus("archive").catch(error => notify(error.message))}>归档 bot…</button>}
        </>}
      </>}
    </div>}
  </aside>;
}
