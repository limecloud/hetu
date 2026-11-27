import {sameWork,type WorkRef} from "@hetu/plugin-sdk";
import type {AgentTool} from "../../agent-session-contract.ts";
import type {SessionResult,SessionResults} from "../../session-results.ts";
import {executionPlanReference,recoverExecutionResults,type PlanQuery} from "./execution-results.ts";
import {isDeepStrictEqual} from "node:util";
import {validBotContext} from "./bot-context.ts";

type Read=(action:string,input:Record<string,unknown>)=>Promise<any>;
type Candidate={tool:AgentTool;kind:SessionResult["kind"];reference:Record<string,any>;recovered?:boolean};
type BotResultIdentity={session_id:string;bot_ref:Record<string,unknown>;generation:number;client:string;work_ref?:WorkRef};

/** Bot身份先由原Core描述核对，成果继续使用原引擎的作品资格。 */
export async function readBotSessionResults(fixed:BotResultIdentity,readBot:(input:Record<string,unknown>)=>Promise<any>,verify:(tools:AgentTool[],provider:string)=>Promise<SessionResults>):Promise<SessionResults>{
 if(typeof fixed.session_id!=="string"||!Number.isSafeInteger(fixed.generation)||fixed.generation<0)throw Error("原Bot会话身份或代次无效。");
 const scope=fixed.work_ref?{work_ref:fixed.work_ref}:{};
 const original=await readBot({method:"session_get",session_id:fixed.session_id,...scope});
 const config=original.bot?.config;
 if(original.session_id!==fixed.session_id||original.client!==fixed.client||!isDeepStrictEqual(original.bot_ref,fixed.bot_ref)||!validBotContext({bot_ref:original.bot_ref,name:config?.name,purpose:config?.purpose})||typeof config?.execution?.provider_id!=="string"||!isDeepStrictEqual(original.bot?.work_ref??null,fixed.work_ref??null))throw Error("原Bot配置、客户端或作品范围与成果请求不符。");
 const value=await readBot({method:"session_read",session_id:fixed.session_id,generation:fixed.generation,format:"conversation",...scope});
 if(value.session_id!==fixed.session_id||value.generation!==fixed.generation||value.client!==config.execution.provider_id||!isDeepStrictEqual(value.bot_ref,fixed.bot_ref)||!isDeepStrictEqual(value.work_ref??null,fixed.work_ref??null))throw Error("原Bot执行端已变化，成果尚未回读。");
 const conversation=value.conversation;
 if(!conversation||!Array.isArray(conversation.tools)||!Array.isArray(conversation.receipts))throw Error("原Bot会话成果投影无法核对。");
 const results=await verify([...conversation.tools,...conversation.receipts],config.execution.provider_id);
 const omitted=Math.max(0,(conversation.total_receipts??conversation.receipts.length)-conversation.receipts.length)+Math.max(0,(conversation.total_tools??conversation.tools.length)-conversation.tools.length);
 return {...results,unread:results.unread+omitted};
}
/** 只展开已知回执合同；插件正文、聊天文本和读取结果不构成写入回执。 */
function savedResults(receipt:any,tool:AgentTool,depth=0):Candidate[]{
 if(depth>4||receipt?.status!=="succeeded")return [];
 const {action,data}=receipt;
 if(action==="hetu.execution.invoke")return savedResults(data?.result,tool,depth+1);
 if(action==="hetu.execution.execute")return (Array.isArray(data?.results)?data.results.slice(0,100):[]).flatMap((result:any)=>savedResults(result,tool,depth+1));
 if(action==="hetu.plugins.invoke"){
  if(data?.format_version!==1||!["write","managed_write"].includes(data.invocation?.effect)||data.result?.status!=="succeeded")return [];
  const result=data.result;
  // Core动作带原动作名；专业动作只接收其原Owner保存的对象，不递归搜索专业正文。
  if(result.action)return savedResults(result,tool,depth+1).filter(item=>item.kind!=="plugin"||item.reference.owner_plugin_id===data.plugin_id);
  const object=result.data?.object;
  if(object?.owner_plugin_id!==data.plugin_id)return [];
  return pluginResult(result.data,tool);
 }
 if(action==="hetu.agent_operations.execute"){
  if(data?.result?.action)return savedResults(data.result,tool,depth+1);
  return savedData(data?.result,tool);
 }
 if(action==="hetu.extensions.objects.save")return pluginResult(data,tool);
 if(!/^(?:hetu\.documents\.(?:create|save|import)|hetu\.resources\.(?:create|update|adopt|archive)|hetu\.creative_tasks\.submit_result|hetu\.bundles\.export|hetu\.video\.media\.save)$/.test(action??""))return [];
 return savedData(data,tool);
}
function pluginResult(data:any,tool:AgentTool):Candidate[]{
 const object=data?.object;
 return object?.owner_plugin_id&&object.object_id&&Number.isInteger(object.revision)&&object.revision>0&&data.sha256
  ?[{tool,kind:"plugin",reference:{owner_plugin_id:object.owner_plugin_id,object_id:object.object_id,revision:object.revision,sha256:data.sha256}}]:[];
}
function savedData(data:any,tool:AgentTool):Candidate[]{
 if(data?.document?.document_id&&data?.revision?.revision_id&&data?.revision?.sha256)return [{tool,kind:"document",reference:{document_id:data.document.document_id,revision_id:data.revision.revision_id,sha256:data.revision.sha256}}];
 if(data?.resource?.resource_id&&Number.isInteger(data.resource.revision)&&data.sha256)return [{tool,kind:"resource",reference:{resource_id:data.resource.resource_id,revision:data.resource.revision,sha256:data.sha256}}];
 if(data?.submission_ref?.submission_id&&data.task_ref)return [{tool,kind:"submission",reference:{task_ref:data.task_ref,submission_ref:data.submission_ref}}];
 if(data?.bundle_id&&data.sha256)return [{tool,kind:"bundle",reference:{bundle_id:data.bundle_id,sha256:data.sha256}}];
 if(data?.media?.video_episode_id&&data?.media_ref?.media_id&&Number.isInteger(data.media_ref.revision)&&data.media_ref.sha256)return [{tool,kind:"video",reference:{video_episode_id:data.media.video_episode_id,media_ref:{media_id:data.media_ref.media_id,revision:data.media_ref.revision,sha256:data.media_ref.sha256}}}];
 return [];
}
/** 回执只提供待核验引用；名称、归属和保存状态必须从Core重新读取。 */
export async function readSessionResults(tools:AgentTool[],work:WorkRef,read:Read):Promise<SessionResults>{
 const candidates:Candidate[]=[];
 const planQueries:PlanQuery[]=[];
 let unread=0;
 for(const tool of tools){
  if(tool.server!=="hetu"||tool.state!=="completed")continue;
  let receipt:any;try{receipt=JSON.parse(tool.output??"").structuredContent;}catch{unread++;continue;}
  candidates.push(...savedResults(receipt,tool));
  const reference=executionPlanReference(receipt);if(reference)planQueries.push({tool,reference});
  if(receipt?.status==="succeeded"&&receipt.response?.read)unread++;
 }
 const recovered=await recoverExecutionResults(planQueries,work,read);unread+=recovered.unread;
 for(const {tool,receipt}of recovered.steps)candidates.push(...savedResults(receipt,tool).map(item=>({...item,recovered:true})));
 const order=new Map(tools.map((tool,index)=>[tool,index]));candidates.sort((left,right)=>order.get(left.tool)!-order.get(right.tool)!);
 // 同一固定成果可被保存／回读多次；只保留最后一次真实回执，不按标题去重。
 const unique=new Map(candidates.map(item=>[JSON.stringify([item.kind,item.reference]),item]));
 const selected=[...unique.values()].slice(-12),items:SessionResult[]=[];
 unread+=Math.max(0,unique.size-selected.length);
 for(const {tool,kind,reference,recovered}of selected){
  const result:SessionResult={id:JSON.stringify([tool.id,kind,reference]),turn_id:tool.turn_id,kind,reference,work_ref:work,title:({document:"写作稿",resource:"资料",submission:"参考稿",bundle:"交付包",work:"作品",video:"视频成果",plugin:"专业成果"})[kind],state:"unavailable"};
  try{
   if(kind==="document"){
    const value=await read("hetu.documents.get",{document_id:reference.document_id,revision_id:reference.revision_id});
    if(!sameWork(value.work_ref,work)||value.document.document_id!==reference.document_id||value.revision.document_id!==reference.document_id||value.revision.revision_id!==reference.revision_id||value.revision.sha256!==reference.sha256)throw new Error("写作稿归属或修订摘要与回执不一致。");
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
   }else if(kind==="video"){
    const value=await read("hetu.video.media.get",{work_ref:work,media_ref:reference.media_ref});
    const media=value.media,fixed=reference.media_ref;
    if(!sameWork(media.work_ref,work)||media.video_episode_id!==reference.video_episode_id||media.media_id!==fixed.media_id||media.revision!==fixed.revision||value.sha256!==fixed.sha256||value.media_ref?.media_id!==fixed.media_id||value.media_ref?.revision!==fixed.revision||value.media_ref?.sha256!==fixed.sha256)throw new Error("视频归属或固定版本与回执不一致。");
    result.title=media.title;
   }else if(kind==="plugin"){
    const {sha256,...fixed}=reference;
    const value=await read("hetu.plugin_results.get",{work_ref:work,...fixed});
    const object=value.object;
    if(!sameWork(object.work_ref,work)||object.owner_plugin_id!==fixed.owner_plugin_id||object.object_id!==fixed.object_id||object.revision!==fixed.revision||value.sha256!==sha256)throw new Error("专业成果归属或固定版本与回执不一致。");
    result.title=object.title;
   }
   result.state="verified";
   if(recovered)result.message=["已核对原计划的保存记录。",result.message].filter(Boolean).join(" ");
  }catch(error){result.message=(error as Error).message;}
  items.push(result);
 }
 return {items,unread};
}
/** 创作库只认本客户端已登记且再次由Core核验身份的作品，不消费回执里的本机路径。 */
export function readLibrarySessionResults(tools:AgentTool[],registered:{work_ref:WorkRef;title:string;unavailable?:boolean}[],workspaceIds:Set<string>):SessionResults{
 const items=new Map<string,SessionResult>();let unread=0;
 const creations=(receipt:any,depth=0):{workspace_id:string;kind:WorkRef["kind"];object_id?:string}[]=>{
  if(depth>4||receipt?.status!=="succeeded")return [];
  if(receipt.action==="hetu.execution.invoke")return creations(receipt.data?.result,depth+1);
  if(receipt.action==="hetu.execution.execute")return (Array.isArray(receipt.data?.results)?receipt.data.results.slice(0,100):[]).flatMap((item:any)=>creations(item,depth+1));
  if(receipt.action==="hetu.execution.initialize"){
   const result=receipt.data?.result,workspace=result?.data?.workspace;
   return result?.status==="succeeded"&&result.action==="hetu.workspaces.get"&&workspace?.workspace_id===result.context?.scope_id&&["novel","drama","video"].includes(workspace?.work_type)
    ?[{workspace_id:workspace.workspace_id,kind:workspace.work_type}]:[];
  }
  const kind=({"hetu.creation_projects.create_novel":"novel","hetu.creation_projects.create_drama":"drama","hetu.creation_projects.create_video":"video"}as const)[receipt.action as "hetu.creation_projects.create_novel"];
  const created=receipt.data?.created_workspace_ref;
  if(!kind||!created)return [];
  const object_id=created[({novel:"novel_id",drama:"drama_project_id",video:"video_project_id"})[kind]];
  return typeof created.workspace_id==="string"&&typeof object_id==="string"?[{workspace_id:created.workspace_id,kind,object_id}]:[];
 };
 for(const tool of tools){
  if(tool.server!=="hetu"||tool.state!=="completed")continue;
  let receipt:any;try{receipt=JSON.parse(tool.output??"").structuredContent;}catch{unread++;continue;}
  for(const created of creations(receipt)){
   if(!workspaceIds.has(created.workspace_id))continue;
   const matches=registered.filter(item=>item.work_ref.workspace_id===created.workspace_id&&item.work_ref.kind===created.kind&&(!created.object_id||item.work_ref.object_id===created.object_id));
   if(matches.length!==1)continue;
   const actual=matches[0],work_ref=actual.work_ref;
   items.set(JSON.stringify(work_ref),{id:JSON.stringify([tool.id,work_ref]),turn_id:tool.turn_id,kind:"work",title:actual.title,reference:{work_ref},work_ref,state:actual.unavailable?"unavailable":"verified",...(actual.unavailable?{message:"作品位置尚未通过本机身份核验，请刷新创作库。"}:{})});
  }
 }
 return {items:[...items.values()].slice(-12),unread:unread+Math.max(0,items.size-12)};
}
