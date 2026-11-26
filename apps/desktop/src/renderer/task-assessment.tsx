import React,{useEffect,useRef,useState} from "react";
import type {WorkRef} from "@hetu/plugin-sdk";
import {desktop,data} from "./bridge.ts";
import {AgentContextPicker} from "./agent-context-picker.tsx";
import {IconButton} from "./workbench.tsx";
import "./task-assessment.css";

type FixedReport={kind:"plugin_object";work_ref:WorkRef;owner_plugin_id:string;object_id:string;revision:number;sha256:string};
type SelectedReport={reference:FixedReport;label:string};
type Coverage={candidate_ref:{candidate_id:string};status:string;missing_domains:string[];checks:{domain:string;status:string;summary:string}[];counterevidence:{title:string;description:string}[]};
type Assessment={
 delivery:{status:string;agent_reported_complete:boolean|null;agent_reported_missing_items:string[];target:{status:string};candidates:{candidate_ref:{candidate_id:string};title?:string;adoption:string}[]};
 professional:{status:string;reports:{reference:FixedReport;title?:string;status:string;candidate_coverage:Coverage[]}[]};
 author_decision:{status:string};
};
const labels={
 "zh-CN":{title:"交付与检查",refresh:"重新核对交付",choose:"选择专业报告",remove:"移除报告",loading:"正在核对固定成果…",retry:"重新核对",delivery:"候选交付",missing:"尚无已提交候选",candidates:"份固定候选",partial:"Agent报告部分交付",stale:"原目标已有新修订，请先比较。",professional:"专业检查",none:"未附加专业报告",unsupported:"此来源未提供可核对的审校报告",report:"固定专业报告",version:"版",owner:"报告声明由专业工具提供，需结合原文判断。",adoption:"正文采纳",adopted:"已有采纳记录",awaiting:"尚未采纳",na:"不适用于正文采纳",preference:"已记录方案偏好",unverified:"尚未核对",details:"固定引用",inconclusive:"仍有不确定项",findings:"报告有待处理问题",partialCoverage:"报告覆盖不完整",wrongTarget:"报告未检查当前候选",pass:"报告记录通过",unchecked:"未检查",checkPass:"报告通过",checkFinding:"有发现",continuity:"连贯逻辑",characters:"角色关系",promises:"情节承诺",pacing:"节奏场景",prose:"文风表达",canon:"设定资料",candidate:"候选",omitted:"未检查的维度"},
 en:{title:"Delivery and checks",refresh:"Recheck delivery",choose:"Choose professional report",remove:"Remove report",loading:"Checking fixed results…",retry:"Retry checks",delivery:"Candidate delivery",missing:"No submitted candidates",candidates:"fixed candidates",partial:"Agent reports partial delivery",stale:"The original target has a newer revision. Compare it first.",professional:"Professional checks",none:"No professional report attached",unsupported:"This source does not provide a supported review report",report:"Fixed professional report",version:"revision",owner:"Reports are professional tool claims. Check them against the source.",adoption:"Manuscript adoption",adopted:"Adoption recorded",awaiting:"Not adopted",na:"Not applicable to manuscript adoption",preference:"Candidate preference recorded",unverified:"Not checked",details:"Fixed reference",inconclusive:"Some checks remain inconclusive",findings:"Report has findings",partialCoverage:"Report coverage is incomplete",wrongTarget:"Report did not check this candidate",pass:"Report claims a pass",unchecked:"Not checked",checkPass:"Reported pass",checkFinding:"Finding",continuity:"Continuity",characters:"Characters",promises:"Promises",pacing:"Pacing",prose:"Prose",canon:"Canon",candidate:"Candidate",omitted:"Unchecked domains"},
};

/** 只读核对已有交付与专业声明；选择报告不建立新的任务或作品事实。 */
export function TaskAssessment({work,taskRef,submissionId,language}:{work:WorkRef;taskRef:unknown;submissionId?:string;language?:string}){
 const t=labels[language?.startsWith("en")?"en":"zh-CN"];
 const [value,setValue]=useState<Assessment>(),[reports,setReports]=useState<SelectedReport[]>(),[choose,setChoose]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const generation=useRef(0),expanded=useRef(false),selection=useRef(reports);selection.current=reports;
 useEffect(()=>()=>{generation.current++;},[]);
 async function load(selected=selection.current){
  const ticket=++generation.current;setBusy(true);setError("");setValue(undefined);
  try{
   const result:Assessment=data(await desktop.tasks("assessment",taskRef,{...(submissionId?{submission_id:submissionId}:{}),...(selected!==undefined?{professional_refs:selected.map(item=>item.reference)}:{})}));
   if(ticket===generation.current){
    setValue(result);
    if(selected===undefined)setReports(result.professional.reports.map((report,index)=>({reference:report.reference,label:report.title||`${t.report} ${index+1}`})));
   }
  }catch(e){if(ticket===generation.current)setError((e as Error).message);}
  finally{if(ticket===generation.current)setBusy(false);}
 }
 function change(selected:SelectedReport[]){generation.current++;setReports(selected);setValue(undefined);if(expanded.current)void load(selected);}
 const domain=(key:string)=>(t as Record<string,string>)[key]??key;
 const status=(key:string)=>({inconclusive:t.inconclusive,findings:t.findings,partial:t.partialCoverage,wrong_target:t.wrongTarget,reported_pass:t.pass,unsupported_owner:t.unsupported} as Record<string,string>)[key]??t.unverified;
 const selectedReports=reports??[];
 return <>
  <details className="task-assessment" onToggle={event=>{expanded.current=event.currentTarget.open;if(expanded.current&&!value&&!busy&&!error)void load();}}>
   <summary>{t.title}</summary>
   <section aria-label={t.title}>
    <div className="task-assessment-actions"><button disabled={busy} onClick={()=>setChoose(true)}>{t.choose}</button><IconButton icon="refresh" label={t.refresh} disabled={busy} onClick={()=>void load()}/></div>
    {!!selectedReports.length&&<ul className="task-assessment-selections">{selectedReports.map(item=><li key={JSON.stringify(item.reference)}><span>{item.label} {language?.startsWith("en")?`${t.version} ${item.reference.revision}`:`第${item.reference.revision}版`}</span><IconButton icon="close" label={t.remove+" "+item.label} onClick={()=>change(selectedReports.filter(other=>other!==item))}/></li>)}</ul>}
    {busy&&<p role="status">{t.loading}</p>}
    {error&&<div role="alert"><p>{error}</p><button disabled={busy} onClick={()=>void load()}>{t.retry}</button></div>}
    {value&&<>
     <dl className="task-assessment-status"><dt>{t.delivery}</dt><dd>{value.delivery.candidates.length?`${value.delivery.candidates.length} ${t.candidates}`:t.missing}{value.delivery.agent_reported_complete===false?` (${t.partial})`:""}</dd>
      <dt>{t.professional}</dt><dd>{value.professional.reports.length?`${value.professional.reports.length} ${language?.startsWith("en")?"fixed professional sources":"份固定专业来源"}`:t.none}</dd>
      <dt>{t.adoption}</dt><dd>{value.delivery.candidates.some(item=>item.adoption==="recorded")?t.adopted:value.delivery.candidates.some(item=>item.adoption==="awaiting_author")?t.awaiting:t.na}{value.author_decision.status==="preference_recorded"?` (${t.preference})`:""}</dd>
     </dl>
     {value.delivery.target.status==="stale_target"&&<p role="status">{t.stale}</p>}
     {!!value.delivery.agent_reported_missing_items?.length&&<ul>{value.delivery.agent_reported_missing_items.map((item,index)=><li key={index}>{item}</li>)}</ul>}
     {value.professional.reports.map((report,index)=>{
      const name=selectedReports.find(item=>item.reference.owner_plugin_id===report.reference.owner_plugin_id&&item.reference.object_id===report.reference.object_id&&item.reference.revision===report.reference.revision&&item.reference.sha256===report.reference.sha256)?.label??`${t.report} ${index+1}`;
      return <article className="task-assessment-report" key={JSON.stringify(report.reference)} aria-label={name}>
       <h3>{name}</h3>{report.status!=="owner_report_available"&&<p>{status(report.status)}</p>}
       {report.candidate_coverage.map((coverage,candidateIndex)=><div key={coverage.candidate_ref.candidate_id}>
        <p className="task-assessment-conclusion">{report.candidate_coverage.length>1?`${value.delivery.candidates.find(item=>item.candidate_ref.candidate_id===coverage.candidate_ref.candidate_id)?.title||`${t.candidate} ${candidateIndex+1}`}: `:""}{status(coverage.status)}</p>
        {!!coverage.missing_domains.length&&<p>{t.omitted}: {coverage.missing_domains.map(domain).join(", ")}</p>}
        <dl>{coverage.checks.map((check,checkIndex)=><React.Fragment key={checkIndex}><dt>{domain(check.domain)}</dt><dd><span>{({pass:t.checkPass,finding:t.checkFinding,inconclusive:t.inconclusive,unchecked:t.unchecked} as Record<string,string>)[check.status]??t.unverified}</span>{check.summary&&<p>{check.summary}</p>}</dd></React.Fragment>)}</dl>
        {!!coverage.counterevidence.length&&<ul>{coverage.counterevidence.map((issue,issueIndex)=><li key={issueIndex}><strong>{issue.title}</strong><p>{issue.description}</p></li>)}</ul>}
       </div>)}
       <details><summary>{t.details}</summary><pre>{JSON.stringify(report.reference,null,2)}</pre></details>
      </article>;
     })}
     {!!value.professional.reports.length&&<p className="muted">{t.owner}</p>}
    </>}
   </section>
  </details>
  {choose&&<AgentContextPicker kind="plugins" work={work} onClose={()=>setChoose(false)} onSelect={async item=>{
   const ref={kind:"plugin_object" as const,work_ref:work,...item.object} as FixedReport;
   const existing=selectedReports.findIndex(report=>report.reference.owner_plugin_id===ref.owner_plugin_id&&report.reference.object_id===ref.object_id);
   change(existing<0?[...selectedReports,{reference:ref,label:item.label}]:selectedReports.map((report,index)=>index===existing?{reference:ref,label:item.label}:report));return true;
  }}/>}
 </>;
}
