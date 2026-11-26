import React, {useEffect, useRef, useState} from "react";
import type {WorkRef} from "@hetu/plugin-sdk";
import {desktop, data} from "./bridge.ts";
import {ContextPickerDialog,type ContextSelection as Selection} from "./agent-context-dialog.tsx";
import {AgentDomainContextPicker} from "./agent-domain-context-picker.tsx";
import {pluginStateLabels} from "./plugin-state.ts";

export type AgentContextPickerKind="tasks"|"plugins"|"outlines"|"canon";
export function AgentContextPicker(props:{kind:AgentContextPickerKind;work:WorkRef;onSelect(value:Selection):Promise<boolean>;onClose():void}){
  return props.kind==="outlines"||props.kind==="canon"?<AgentDomainContextPicker {...props} kind={props.kind}/>:<TaskPluginContextPicker {...props} kind={props.kind}/>;
}
function TaskPluginContextPicker({kind,onSelect,onClose}:{kind:"tasks"|"plugins";onSelect(value:Selection):Promise<boolean>;onClose():void}){
  const generation = useRef(0);
  const [owners, setOwners] = useState<any[]>([]), [owner, setOwner] = useState("");
  const [query, setQuery] = useState(""), [items, setItems] = useState<any[]>([]), [cursor, setCursor] = useState<string>();
  const [task, setTask] = useState<any>(), [detail, setDetail] = useState<any>(), [loading, setLoading] = useState(false), [loaded, setLoaded] = useState(false), [attaching, setAttaching] = useState(false), [error, setError] = useState("");
  const [retry,setRetry]=useState<()=>void>();
  const busy=loading||attaching;
  const title = kind === "tasks" ? "参考稿与公开意见" : "专业成果";
  useEffect(() => () => {generation.current++;}, []);
  function invalidate(){generation.current++;setLoading(false);setError("");setRetry(undefined);}
  async function read<T>(request:()=>Promise<T>,apply:(value:T)=>void,retryRead:()=>void){
    const token=++generation.current;setLoading(true);setError("");setRetry(undefined);
    try{const value=await request();if(token===generation.current)apply(value);}
    catch(e){if(token===generation.current){setError((e as Error).message);setRetry(()=>retryRead);}}
    finally{if(token===generation.current)setLoading(false);}
  }
  function load(more = false, selectedOwner = owner, term=query,after=cursor) {
    if (!more) {setItems([]); setCursor(undefined);}
    return read(async()=>{
      const value = kind === "tasks" ? data(await desktop.tasks("list", undefined, {cursor: more ? after : undefined}))
        : data(await desktop.fallback(selectedOwner, "hetu.extensions.objects.search", {query:term, limit: 20, ...(more && after ? {cursor:after} : {})}));
      return value;
    },value=>{
      setItems(previous => more ? [...previous, ...(value.tasks ?? value.objects)] : (value.tasks ?? value.objects)); setCursor(value.next_cursor ?? undefined);
      setLoaded(true);
    },()=>void load(more,selectedOwner,term,after));
  }
  function loadOwners(){
    return read(async()=>{const value=await desktop.state();if(value.plugin_state_error)throw Error(value.plugin_state_error);return value;},value=>{
      setOwners(value.plugins);const selected=value.plugins.find((item:any)=>item.id===owner)?.id??value.plugins[0]?.id??"";setOwner(selected);
      if(selected)void load(false,selected,query);else setLoaded(true);
    },()=>void loadOwners());
  }
  useEffect(() => {
    if(kind==="tasks")void load();else void loadOwners();
  }, [kind]);
  async function choose(value: Selection) {
    const token=++generation.current;setAttaching(true);setError("");setRetry(undefined);
    try {if (await onSelect({...value, label: value.label.trim().slice(0, 120)})&&token===generation.current) onClose();}
    catch (e) {if(token===generation.current)setError((e as Error).message);}
    finally {if(token===generation.current)setAttaching(false);}
  }
  function openTask(value: any) {
    setTask(value);setDetail(undefined);
    return read(async()=>{
      const response = await desktop.tasks("call", value.task_ref, {name: "hetu_open_task_view", arguments: {task_ref: value.task_ref,detail:"review"}});
      return data(response.structuredContent);
    },setDetail,()=>void openTask(value));
  }
  function moreWorking() {
    const fixed=task.task_ref,after=detail.working_copies_next_cursor;
    return read(async()=>data((await desktop.tasks("call", fixed, {name: "hetu_list_working_copies", arguments: {task_ref: fixed, limit: 20, cursor: after}})).structuredContent),result=>{
      setDetail((previous: any) => ({...previous, working_copies: [...previous.working_copies, ...result.working_copies], working_copies_next_cursor: result.next_cursor}));
    },()=>void moreWorking());
  }
  return <ContextPickerDialog title={title} disabled={attaching} onClose={onClose}>
    {kind === "plugins" && !!owners.length && <form onSubmit={event => {event.preventDefault(); void load();}}>
      <select aria-label="成果所属插件" value={owner} disabled={attaching} onChange={event => {const next=event.target.value;setOwner(next);setQuery("");void load(false,next,"");}}>{owners.map(item => <option key={item.id} value={item.id}>{item.display?.["zh-CN"] ?? item.id}{item.state!=="active"?`（${pluginStateLabels[item.state]??"状态待核对"}）`:""}</option>)}</select>
      <input type="search" aria-label="查找专业成果" maxLength={120} value={query} disabled={attaching} onChange={event => setQuery(event.target.value)}/><button disabled={busy}>查找</button>
    </form>}
    {error && <p role="alert">{error}</p>}
    {busy && <p role="status">{attaching?"正在附加固定来源…":"正在读取来源目录…"}</p>}
    {task ? <section aria-label="选择参考内容"><button disabled={attaching} onClick={() => {invalidate();setTask(undefined); setDetail(undefined);}}>返回任务目录</button><h3>{task.brief}</h3>
      {detail&&<button disabled={busy} onClick={() => void choose({page: "work.tasks", object: {task_ref: task.task_ref}, label: task.brief})}>{detail.submission ? "附加已提交稿与意见" : "附加任务要求与意见"}</button>}
      {(detail?.working_copies ?? []).map((copy: any) => <button key={copy.working_copy_id} disabled={busy} onClick={() => void choose({page: "work.tasks", object: {task_ref: task.task_ref, working_copy_ref: copy.current_revision_ref}, label: copy.title || task.brief})}>{copy.title || "参考稿"}<small>固定工作修订</small></button>)}
      {detail?.working_copies_next_cursor && <button disabled={busy} onClick={() => void moreWorking()}>更多参考稿</button>}
    </section> : <div className="agent-context-picker-items">{items.map(item => <button key={item.task_ref?.task_id ?? item.object_id} disabled={busy || item.state === "closed"} onClick={() => kind === "tasks" ? void openTask(item) : void choose({page: "plugin.results", object: {owner_plugin_id: owner, object_id: item.object_id, revision: item.revision, sha256: item.sha256}, label: item.title})}>{item.brief ?? item.title}<small>{kind === "tasks" ? item.state === "closed" ? "已关闭" : `${item.submission_count}批已提交成果` : `第${item.revision}版`}</small></button>)}</div>}
    {loaded&&!busy && !error && !task && !items.length && <p>{kind === "tasks" ? "当前作品没有可附加的任务。" :owners.length? "没有匹配的专业成果。":"当前没有可读取的插件成果目录。"}</p>}
    {cursor && !task && <button disabled={busy} onClick={() => void load(true)}>更多{kind === "tasks" ? "任务" : "成果"}</button>}
    {retry&&<button disabled={busy} onClick={retry}>重新读取</button>}
  </ContextPickerDialog>;
}
