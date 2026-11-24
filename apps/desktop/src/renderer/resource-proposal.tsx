import React,{useEffect,useState} from "react";
import {ManuscriptReading,ManuscriptComparison} from "@hetu/workbench-ui";
import {usePreferences} from "./preferences.tsx";
import {resourceCategories} from "./resource-source.ts";
import {desktop} from "./bridge.ts";

export function ResourceProposal({view}:{view:any}){
 const preferences=usePreferences(),next=view.preview.resource;
 const [previous,setPrevious]=useState<any>(),[error,setError]=useState("");
 useEffect(()=>{
  let active=true;setPrevious(undefined);setError("");
  if(view.action==="hetu.resources.update")void desktop.resources("get",{resource_id:view.input.resource_id,revision:view.input.expected.revision}).then(value=>{
   if(value.sha256!==view.input.expected.sha256)throw new Error("原资料摘要与方案依据不一致。");
   if(active)setPrevious(value.resource);
  }).catch(error=>{if(active)setError(error.message);});
  return()=>{active=false;};
 },[view.proposal_id]);
 return <section aria-label="资料变更预览"><p>{resourceCategories[next.category]??"资料"}</p>
  {error?<p role="alert">{error}</p>:previous?<ManuscriptComparison before={previous.body} after={next.body} beforeLabel="原资料" afterLabel="待保存资料" title={next.title} format="markdown" kind="novel" preferences={preferences}/>:view.action==="hetu.resources.update"?<p role="status">正在读取固定原资料…</p>:<ManuscriptReading text={next.body} title={next.title} label="待保存资料" format="markdown" kind="novel" preferences={preferences}/>}
  {next.source_notes&&<p>来源：{next.source_notes}</p>}{next.tags?.length>0&&<p>标签：{next.tags.join("、")}</p>}
 </section>;
}
