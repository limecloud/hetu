import {sameWork,type WorkRef} from "@hetu/plugin-sdk";
import type {AgentTool} from "../../agent-session-contract.ts";
import type {SessionResult,SessionResults} from "../../session-results.ts";

type Read=(action:string,input:Record<string,unknown>)=>Promise<any>;
/** 回执只提供待核验引用；名称、归属和保存状态必须从Core重新读取。 */
export async function readSessionResults(tools:AgentTool[],work:WorkRef,read:Read):Promise<SessionResults>{
 const candidates:{tool:AgentTool;kind:SessionResult["kind"];reference:Record<string,any>}[]=[];
 let unread=0;
 for(const tool of tools){
  if(tool.server!=="hetu"||tool.state!=="completed")continue;
  let receipt:any;try{receipt=JSON.parse(tool.output??"").structuredContent;}catch{unread++;continue;}
  if(receipt?.status!=="succeeded")continue;
  if(!/^(?:hetu\.documents\.(?:create|save|import)|hetu\.resources\.(?:create|update|adopt|archive)|hetu\.creative_tasks\.submit_result|hetu\.bundles\.export|hetu\.agent_operations\.execute)$/.test(receipt.action??""))continue;
  let data=receipt.data;
  if(receipt.action==="hetu.agent_operations.execute")data=data?.result;
  if(data?.document?.document_id&&data?.revision?.revision_id&&data?.revision?.sha256)candidates.push({tool,kind:"document",reference:{document_id:data.document.document_id,revision_id:data.revision.revision_id,sha256:data.revision.sha256}});
  else if(data?.resource?.resource_id&&Number.isInteger(data.resource.revision)&&data.sha256)candidates.push({tool,kind:"resource",reference:{resource_id:data.resource.resource_id,revision:data.resource.revision,sha256:data.sha256}});
  else if(data?.submission_ref?.submission_id&&data.task_ref)candidates.push({tool,kind:"submission",reference:{task_ref:data.task_ref,submission_ref:data.submission_ref}});
  else if(data?.bundle_id&&data.sha256)candidates.push({tool,kind:"bundle",reference:{bundle_id:data.bundle_id,sha256:data.sha256}});
 }
 // 同一固定成果可被保存／回读多次；只保留最后一次真实回执，不按标题去重。
 const unique=new Map(candidates.map(item=>[JSON.stringify([item.kind,item.reference]),item]));
 const selected=[...unique.values()].slice(-12),items:SessionResult[]=[];
 unread+=Math.max(0,unique.size-selected.length);
 for(const {tool,kind,reference}of selected){
  const result:SessionResult={id:tool.id,turn_id:tool.turn_id,kind,reference,work_ref:work,title:({document:"写作稿",resource:"资料",submission:"参考稿",bundle:"交付包",work:"作品"})[kind],state:"unavailable"};
  try{
   if(kind==="document"){
    const value=await read("hetu.documents.get",{document_id:reference.document_id,revision_id:reference.revision_id});
    if(!sameWork(value.document.work_ref,work)||value.revision.revision_id!==reference.revision_id||value.revision.sha256!==reference.sha256)throw new Error("写作稿归属或修订摘要与回执不一致。");
    result.title=value.document.title;
    if(value.document.current_revision_id!==reference.revision_id)result.message="已回读固定修订；当前写作稿已有更新。";
   }else if(kind==="resource"){
    const value=await read("hetu.resources.get",{resource_id:reference.resource_id,revision:reference.revision});
    if(!sameWork(value.resource.work_ref,work)||value.resource.revision!==reference.revision||value.sha256!==reference.sha256)throw new Error("资料归属或修订摘要与回执不一致。");
    result.title=value.resource.title;
   }else if(kind==="submission"){
    // stable连接的sha256用于路由核验；Core的TaskRef另有严格Schema。
    const {sha256:requestSha,...task_ref}=reference.task_ref;
    const value=await read("hetu.creative_tasks.get",{task_ref,submission_id:reference.submission_ref.submission_id});
    const fixed=value.observation?.submission_refs?.find((item:any)=>item.submission_id===reference.submission_ref.submission_id);
    if(!sameWork(value.request?.input_snapshot?.scope_context?.work_ref,work)||requestSha&&value.request_sha256!==requestSha||fixed?.sha256!==reference.submission_ref.sha256||value.submission?.submission_id!==reference.submission_ref.submission_id)throw new Error("参考稿归属或提交摘要与回执不一致。");
    result.title=(value.request.brief??"参考稿").slice(0,100);
   }else if(kind==="bundle"){
    const value=await read("hetu.bundles.verify",{work_ref:work,bundle_id:reference.bundle_id});
    if(value.verified!==true||value.sha256!==reference.sha256)throw new Error("交付包未通过真实文件核验。");
    result.title="审阅交付包";
   }
   result.state="verified";
  }catch(error){result.message=(error as Error).message;}
  items.push(result);
 }
 return {items,unread};
}
/** 创作库只认本客户端已登记且再次由Core核验身份的作品，不消费回执里的本机路径。 */
export function readLibrarySessionResults(tools:AgentTool[],registered:{work_ref:WorkRef;title:string;unavailable?:boolean}[],workspaceIds:Set<string>):SessionResults{
 const items=new Map<string,SessionResult>();let unread=0;
 for(const tool of tools){
  if(tool.server!=="hetu"||tool.state!=="completed")continue;
  let receipt:any;try{receipt=JSON.parse(tool.output??"").structuredContent;}catch{unread++;continue;}
  const kind=({"hetu.creation_projects.create_novel":"novel","hetu.creation_projects.create_drama":"drama","hetu.creation_projects.create_video":"video"}as const)[receipt?.action as "hetu.creation_projects.create_novel"];
  if(!kind||receipt.status!=="succeeded")continue;
  const created=receipt.data?.created_workspace_ref;
  if(!created||!workspaceIds.has(created.workspace_id))continue;
  const work_ref:WorkRef={workspace_id:created.workspace_id,kind,object_id:created[({novel:"novel_id",drama:"drama_project_id",video:"video_project_id"})[kind]]};
  const actual=registered.find(item=>sameWork(item.work_ref,work_ref));
  if(!actual)continue;
  items.set(JSON.stringify(work_ref),{id:tool.id,turn_id:tool.turn_id,kind:"work",title:actual.title,reference:{work_ref},work_ref,state:actual.unavailable?"unavailable":"verified",...(actual.unavailable?{message:"作品位置尚未通过本机身份核验，请刷新创作库。"}:{})});
 }
 return {items:[...items.values()].slice(-12),unread:unread+Math.max(0,items.size-12)};
}
