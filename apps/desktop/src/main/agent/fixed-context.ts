import {isDeepStrictEqual} from "node:util";
import {sameWork,type WorkRef} from "@hetu/plugin-sdk";
import type {AgentContextRef} from "../../agent-session-contract.ts";
import {validateContextRefs} from "../../agent-context.ts";
import {handoffViewKind} from "../workbench-handoff.ts";

type Handoff=(kind:string,object:Record<string,unknown>)=>Promise<{fixed_refs:Record<string,any>[]}>;
const labels:Record<string,string>={"work.profile":"作品资料","novel.outlines":"作品大纲","work.canon":"人物与设定","work.resources":"资料","novel.reader":"章节","drama.reader":"剧本","work.images":"图片成果","work.media":"媒体成果","work.versions":"文稿版本","work.tasks":"参考稿与公开意见","plugin.results":"专业成果"};
function refs(value:{fixed_refs:Record<string,any>[]},object:Record<string,unknown>,page?:string,excludeNovel=false){
 if(!Array.isArray(value.fixed_refs)||!value.fixed_refs.length)throw Error("当前内容没有可附加的固定来源。");
 // 明确对象不夹带可变的作品资料，旧文稿修订不因作品改名而失效。
 const targeted=page==="work.canon"||Object.keys(object).some(key=>!["blueprint_revision","revision"].includes(key));
 const sources=value.fixed_refs.filter(ref=>(!targeted||ref.kind!=="work")&&(!excludeNovel||ref.kind!=="novel"));
 if(!sources.length)throw Error("当前对象没有可附加的固定来源。");
 return sources;
}
function pinnedObject(object:Record<string,unknown>,sources:Record<string,any>[]){
 const pinned=structuredClone(object);
 for(const source of sources){
  if(source.kind==="document"&&source.document_id===pinned.document_id)pinned.revision_id=source.revision_id;
  if(source.kind==="resource"&&source.resource_id===pinned.resource_id)pinned.revision=source.revision;
  if(source.kind==="blueprint")pinned.blueprint_revision=source.revision;
  if(source.kind==="outline"){pinned.outline_revision=source.revision;pinned.outline_sha256=source.sha256;}
  if(source.kind==="task_submission")pinned.submission_id=source.submission_id;
  if(source.kind==="task_feedback")pinned.feedback_ref=source.feedback_ref;
 }
 if(sources.some(source=>source.kind==="task_request")){
  pinned.submission_id=sources.find(source=>source.kind==="task_submission")?.submission_id??null;
  pinned.feedback_ref=sources.find(source=>source.kind==="task_feedback")?.feedback_ref??null;
 }
 return pinned;
}
export async function prepareAgentContext(input:{page:string;object?:Record<string,unknown>;label?:string},work:WorkRef,handoff:Handoff):Promise<AgentContextRef>{
 if(!labels[input.page])throw Error("当前页面尚不支持附加固定上下文，请从作品目录选择。");
 if(input.label!==undefined&&typeof input.label!=="string")throw Error("固定上下文名称无效。");
 const object=input.object??{};
 if(!object||typeof object!=="object"||Array.isArray(object))throw Error("请选择作品中的固定对象。");
 const sources=refs(await handoff(handoffViewKind(input.page,work),object),object,input.page,typeof object.document_id==="string");
 const result={label:input.label?.trim()||labels[input.page],reference:{schema_version:1,work_ref:work,page:input.page,object_ref:pinnedObject(object,sources),fixed_refs:sources}};
 return validateContextRefs([result])[0];
}
export async function verifyAgentContexts(input:unknown,work:WorkRef|undefined,handoff:Handoff):Promise<AgentContextRef[]>{
 const contexts=validateContextRefs(input);
 for(const item of contexts){
  const fixed=item.reference as any;
  if(!work||!fixed.work_ref||!sameWork(work,fixed.work_ref)||fixed.schema_version!==1||!labels[fixed.page]||!fixed.object_ref||!Array.isArray(fixed.fixed_refs))throw Error(`“${item.label}”不属于当前作品，未发送。请移除后重新附加。`);
  try{
   // 先前附加的整个作品含作品资料；补充固定设定版本不改变当时的覆盖。
   const expected=fixed.fixed_refs as Record<string,any>[];
   const actual=refs(await handoff(handoffViewKind(fixed.page,work),fixed.object_ref),fixed.object_ref,
    expected.some(ref=>ref.kind==="work")?undefined:fixed.page,!expected.some(ref=>ref.kind==="novel")&&typeof fixed.object_ref.document_id==="string");
   const relevant=expected.some(ref=>ref.kind==="work")?actual:actual.filter(ref=>ref.kind!=="work");
   if(!isDeepStrictEqual(relevant,expected))throw Error("固定来源已变化。");
  }catch(error){throw Error(`“${item.label}”暂时无法核对，未发送。${(error as Error).message} 请从作品目录重新附加。`);}
 }
 return contexts;
}
