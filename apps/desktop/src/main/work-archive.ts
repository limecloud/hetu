import {randomUUID} from "node:crypto";
import {sameWork,type WorkRef} from "@hetu/plugin-sdk";
import type {AppServer} from "./rpc.ts";

type Confirmation={message:string;detail:string;accept:string};
/** 两宿主沿原领域CAS归档单一作品，不移动目录或修改同根其他对象。 */
export async function archiveWork(server:Pick<AppServer,"request">,work:WorkRef,archived:boolean,confirm:(value:Confirmation)=>Promise<boolean>) {
  const call=async(action:string,input:unknown)=>{
    const result=await server.request("workspace/request",{action,contract_revision:"1",input});
    if(result.status!=="succeeded")throw Object.assign(new Error(result.error?.message??"作品操作未完成，请沿原操作核对。"),{code:result.error?.code});
    return result.data;
  };
  const exact=await call("hetu.works.get",{work_ref:work});
  if(!sameWork(exact.summary?.work_ref,work))throw new Error("作品身份与登记不一致，请重新读取创作库。");
  const current=exact.record,revision=exact.summary.fixed_ref;
  const operation_key=randomUUID();
  let action:string,input:Record<string,unknown>,title:string;
  if(work.kind==="novel"){
    const metadata={...current.metadata,status:archived?"archived":current.metadata.status==="archived"?"planning":current.metadata.status};
    action="hetu.novels.update";input={expected:{revision:revision.revision_ref.revision,sha256:revision.sha256},metadata,operation_key};title=metadata.title;
  }else if(work.kind==="drama"){
    action="hetu.drama.projects.update";input={project_ref:{project_id:work.object_id,revision:revision.revision_ref.revision,sha256:revision.sha256},title:current.title,description:current.description??"",archived,source_refs:current.source_refs??[],operation_key};title=current.title;
  }else{
    action="hetu.video.projects.update";input={project_ref:{video_project_id:work.object_id,revision:revision.revision_ref.revision,sha256:revision.sha256},title:current.title,brief:current.brief??"",archived,operation_key};title=current.title;
  }
  if(!await confirm({message:archived?`将「${title}」移入废纸篓？`:`恢复「${title}」？`,detail:"作品正文、历史、任务和关联资料会保留；此操作可从创作库的已归档状态恢复。",accept:archived?"移入废纸篓":"恢复作品"}))return false;
  await call(action,input);
  return true;
}
