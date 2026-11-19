import type { AppServer } from "./rpc.ts";

/** 创作库的作品资料与封面投影只有这一份，两端刷新使用同一读取流程。 */
export async function readLibraryWorks(connection: AppServer) {
  const unwrap=(result:any)=>{if(result.status!=="succeeded")throw new Error(result.error?.message??"创作库读取失败。");return result.data;};
  const call=(action:string,input:unknown)=>connection.request("workspace/request",{action,contract_revision:"1",input});
  const works:any[]=[];let cursor:string|undefined;
  do{const page=unwrap(await call("hetu.works.list",{limit:100,include_archived:true,...(cursor?{cursor}:{})}));works.push(...page.works);cursor=page.next_cursor??undefined;}while(cursor);
  for(const item of works){
    if(item.work_ref.kind!=="novel")continue;
    const result=unwrap(await call("hetu.works.get",{work_ref:item.work_ref}));
    Object.assign(item,{author_name:result.record.metadata.author_name,genre:result.record.metadata.genre,status:result.record.metadata.status,chapter_count:result.record.chapters.length});
    try{item.cover_preview=unwrap(await call("hetu.covers.get",{})).preview;}catch{item.cover_error="封面读取失败";}
  }
  return works;
}
