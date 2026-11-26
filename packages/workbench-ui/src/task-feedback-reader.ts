import {readObjectProjection,type JsonProjection} from "./json-projection.ts";
import type {TaskFeedbackPage} from "./task-feedback-history.tsx";

type FeedbackProjection={feedback_page:JsonProjection;feedback_page_sha256:string};
/** 长意见及原句沿同一逻辑页展开，避免MCP把大结果预算错误显示为空历史。 */
export async function readTaskFeedbackPage(read:(input:Record<string,unknown>)=>Promise<FeedbackProjection>,after?:string,signal?:AbortSignal):Promise<TaskFeedbackPage>{
 let expected:string|undefined,limit=10;
 const page=async(result_path:string,offset:number)=>{
  signal?.throwIfAborted();
  const result=await read({limit,...(after?{after_cursor:after}:{}),result_path,offset,max_bytes:8192,...(expected?{expected_result_sha256:expected}:{})});
  signal?.throwIfAborted();
  if(!result?.feedback_page||!/^[a-f0-9]{64}$/.test(result.feedback_page_sha256))throw Error("意见分页未返回完整的固定引用。");
  expected??=result.feedback_page_sha256;return result;
 };
 let first=await page("",0);
 if(first.feedback_page.summary.size_bytes>1024*1024){limit=1;expected=undefined;first=await page("",0);}
 const {object}=await readObjectProjection(page,result=>result.feedback_page,result=>result.feedback_page_sha256,first);
 return object as unknown as TaskFeedbackPage;
}
