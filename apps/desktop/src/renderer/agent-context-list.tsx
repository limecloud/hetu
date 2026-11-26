import React from "react";
import {IconButton} from "@hetu/workbench-ui";
import type {AgentContextRef} from "../agent-session-contract.ts";

const sourceName:Record<string,string>={work:"作品资料",novel:"小说资料",outline:"正式大纲",document:"文稿",source_range:"原文选区",document_scene:"原稿场次",blueprint:"人物与设定",resource:"资料",asset:"素材",cue:"线索",video_episode:"视频分集",video_media:"媒体",git_snapshot:"文稿快照",git_difference:"版本差异",git_commit:"历史版本",plugin_object:"专业成果",skeleton:"分集与场次",scene:"场次",draft:"参考稿",report:"检查记录",task_request:"任务要求",task_submission:"已提交参考稿",working_copy:"参考稿工作修订",task_feedback:"公开意见"};

/** 标签只展示引用，展开内容与本次实际发送的固定上下文相同。 */
export function AgentContextList({references,disabled,onRemove}:{references:AgentContextRef[];disabled?:boolean;onRemove?(reference:AgentContextRef):void}){
 if(!references.length)return null;
 return <div className="agent-context-list" aria-label={onRemove?"附加的上下文":"本次消息的固定上下文"}>{references.map(item=><div className="agent-context-chip" key={JSON.stringify(item.reference)}>
  <details><summary title={item.label}>{item.label}<span>固定修订</span></summary><div>
   {Array.isArray(item.reference.fixed_refs)&&<ul>{item.reference.fixed_refs.map((source:any,index:number)=><li key={index}>{sourceName[source.kind]??"固定来源"}{source.kind==="outline"&&` 第${source.revision}版`}{typeof source.quote==="string"&&<blockquote>{source.quote}</blockquote>}</li>)}</ul>}
   <details><summary>完整引用</summary><pre tabIndex={0} aria-label={item.label+"的固定引用"}>{JSON.stringify(item.reference,null,2)}</pre></details>
  </div></details>
  {onRemove&&<IconButton icon="close" label={"移除上下文 "+item.label} disabled={disabled} onClick={()=>onRemove(item)}/>}
 </div>)}</div>;
}
