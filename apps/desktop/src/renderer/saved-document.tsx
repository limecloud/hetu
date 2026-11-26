import React,{useEffect,useRef,useState} from "react";
import {createPortal} from "react-dom";
import {sameWork} from "@hetu/plugin-sdk";
import {IconButton,ManuscriptComparison,ManuscriptText,ScreenplayText,readingProfile,readingStyle} from "@hetu/workbench-ui";
import type {DocumentResultReference} from "../session-results.ts";
import type {SurfaceContext} from "./contributions.tsx";
import {desktop,data} from "./bridge.ts";
import {usePreferences} from "./preferences.tsx";
import {useWorkbench} from "./workbench.tsx";
import {SidebarDirectory} from "./work-sidebar-panels.tsx";
import {ReadingOptions} from "./reading-options.tsx";
import {documentTitleInSource} from "./document-title.ts";

/** 固定成果只读投影；编辑继续使用原作者稿，不创建恢复稿或移动正文头。 */
export function SavedDocument({work,reference,ai,openDocument}:SurfaceContext&{reference:DocumentResultReference}){
 const shell=useWorkbench(),preferences=usePreferences();
 const [value,setValue]=useState<any>(),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const [comparison,setComparison]=useState<any>(),[comparing,setComparing]=useState(false),[compareError,setCompareError]=useState("");
 const [preview,setPreview]=useState<Record<string,any>>(),[zoom,setZoom]=useState(100);
 const generation=useRef(0),compareGeneration=useRef(0),dialog=useRef<HTMLDialogElement>(null);
 const key=JSON.stringify([work,reference]),reading=preview??preferences,kind=work.kind==="drama"?"screenplay":"novel";
 const typography=readingStyle(readingProfile(reading,kind),zoom);
 async function read(fixed?:DocumentResultReference){
  const result=data(await desktop.read("hetu.documents.get",{document_id:reference.document_id,...(fixed?{revision_id:fixed.revision_id}:{})}));
  if(!sameWork(result.work_ref,work)||result.document.document_id!==reference.document_id||result.revision.document_id!==reference.document_id||typeof result.content!=="string"||fixed&&(result.revision.revision_id!==fixed.revision_id||result.revision.sha256!==fixed.sha256))throw Error("文稿归属或修订与保存记录不一致。");
  return result;
 }
 async function load(){
  const token=++generation.current;setBusy(true);setError("");
  try{const result=await read(reference);if(token===generation.current)setValue(result);}
  catch(error){if(token===generation.current)setError((error as Error).message);}
  finally{if(token===generation.current)setBusy(false);}
 }
 async function compare(){
  const token=++compareGeneration.current;setComparing(true);setCompareError("");
  try{const result=await read();if(token===compareGeneration.current)setComparison(result);}
  catch(error){if(token===compareGeneration.current)setCompareError((error as Error).message);}
  finally{if(token===compareGeneration.current)setComparing(false);}
 }
 useEffect(()=>{setValue(undefined);setComparison(undefined);setComparing(false);setCompareError("");void load();return()=>{generation.current++;compareGeneration.current++;};},[key]);
 useEffect(()=>{if(comparison)dialog.current?.showModal();},[comparison]);
 useEffect(()=>{
  shell.setDocumentTools(value?{title:value.document.title,readOnly:true,readOnlyLabel:"保存修订 只读",dirty:false,busy,save:()=>{},ai:()=>ai(reference)}:undefined);
  if(value)shell.setDocumentTab({id:reference.document_id,title:value.document.title,preview:true});
 },[value,busy]);
 useEffect(()=>()=>shell.setDocumentTools(undefined),[]);
 const directory=<SidebarDirectory work={work} heading={false} onOpen={id=>openDocument?.(id)}/>;
 const historical=value&&value.document.current_revision_id!==reference.revision_id;
 const sourceTitle=value&&documentTitleInSource(value.content,value.document.title,value.revision.source_format,kind==="screenplay");
 const titleInBody=sourceTitle&&(sourceTitle.heading||sourceTitle.plain);
 return <div className="document-layout">
  {shell.directoryTarget?createPortal(directory,shell.directoryTarget):directory}
  <section className={"manuscript-workspace reading-surface"+(kind==="screenplay"?" screenplay-workspace":"")} style={typography as React.CSSProperties} data-document-theme={reading.document_theme??"system"} aria-label="已保存文稿" aria-busy={busy} data-revision-id={value?.revision.revision_id}>
   <header className="manuscript-header" aria-label="稿件页头"><span className="manuscript-source-state">{value?(historical?"历史修订":"已保存修订"):"已保存文稿"}</span><div className="paper-toolbar"><div className="paper-actions">
    <ReadingOptions kind={kind} composing={false} zoom={zoom} beforeChange={()=>{}} onPreview={setPreview} onZoom={setZoom}/>
    <IconButton icon="refresh" label="重新读取保存修订" disabled={busy} onClick={()=>void load()}/>
    <button disabled={!value||comparing} onClick={()=>void compare()}>{comparing?"正在读取当前稿…":"与当前稿比较"}</button>
    <button disabled={!value} onClick={()=>ai(reference)}>让 AI 处理本稿</button>
    <button onClick={()=>openDocument?.(reference.document_id)}>打开当前稿</button>
   </div></div></header>
   <div className="manuscript-stage" tabIndex={0} aria-label="正文滚动区"><section className={"manuscript-paper"+(kind==="screenplay"?" screenplay-paper":"")}>
    {error&&<div className="manuscript-load-error" role="alert"><p>无法打开保存修订：{error}</p><button disabled={busy} onClick={()=>void load()}>重新读取保存修订</button></div>}
    {compareError&&<div className="manuscript-load-error" role="alert"><p>无法比较当前稿：{compareError}</p><button disabled={comparing} onClick={()=>void compare()}>重新比较当前稿</button></div>}
    {busy&&!value&&<p role="status">正在读取保存修订…</p>}
    {value&&<div className="manuscript-scroll" data-source-title={titleInBody||undefined}>
     {!titleInBody&&<div className="manuscript-title"><h1>{value.document.title}</h1></div>}
     {value.revision.source_format==="fountain"?<ScreenplayText text={value.content} title={value.document.title} aria-label="保存修订正文"/>:<ManuscriptText text={value.content} title={value.document.title} format={value.revision.source_format==="markdown"?"markdown":"plain"} novel={kind==="novel"} aria-label="保存修订正文"/>}
    </div>}
   </section></div>
   {comparison&&value&&<dialog ref={dialog} aria-label={"比较修订 "+value.document.title} className="revision-comparison" onClose={()=>setComparison(undefined)}><div className="dialog-heading"><h2>比较修订 {value.document.title}</h2><IconButton icon="close" label="关闭修订比较" onClick={()=>setComparison(undefined)}/></div><ManuscriptComparison before={value.content} after={comparison.content} beforeLabel="保存修订" afterLabel="当前稿" title={value.document.title} format={value.revision.source_format} kind={kind} preferences={reading}/></dialog>}
  </section>
 </div>;
}
