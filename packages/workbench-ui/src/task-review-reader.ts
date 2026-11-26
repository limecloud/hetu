import {readObjectProjection,type JsonProjection} from "./json-projection.ts";

type Projection={task_page:JsonProjection;task_page_sha256:string};
type WorkingProjection={working_page:JsonProjection;working_page_sha256:string};
/** 只重组固定审阅元数据；候选及来源正文另按原引用读取。 */
async function readReview<T>(read:(input:Record<string,unknown>)=>Promise<T>,detail:string,project:(result:T)=>JsonProjection,identity:(result:T)=>string,signal?:AbortSignal){
 let expected:string|undefined;
 const page=async(result_path:string,offset:number)=>{
  signal?.throwIfAborted();
  const result=await read({detail,result_path,offset,max_bytes:8192,...(expected?{expected_result_sha256:expected}:{})});
  signal?.throwIfAborted();
  if(!result||!project(result)||!/^[a-f0-9]{64}$/.test(identity(result)))throw Error("审阅未返回完整的固定引用。");
  expected??=identity(result);return result;
 };
 return (await readObjectProjection(page,project,identity,undefined,4*1024*1024)).object;
}
export const readTaskReview=(read:(input:Record<string,unknown>)=>Promise<Projection>,signal?:AbortSignal)=>readReview(read,"review",result=>result.task_page,result=>result.task_page_sha256,signal);
export const readWorkingCopyReview=(read:(input:Record<string,unknown>)=>Promise<WorkingProjection>,signal?:AbortSignal)=>readReview(read,"summary",result=>result.working_page,result=>result.working_page_sha256,signal);
