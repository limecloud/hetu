import { randomUUID } from "node:crypto";
import type { WorkRef } from "@hetu/plugin-sdk";

const connected = (status: any) => status.authorized && status.git_authorization_current !== false;

/** 作者主动发起协作时连接当前对象；未知结果先核对真实状态。 */
export async function ensureWorkConnection(context: {
  work: WorkRef; base: Record<string,unknown>; check():void;
  status():Promise<any>; call(action:string,input:Record<string,unknown>):Promise<any>;
}) {
  const status=await context.status();if(connected(status))return status;
  context.check();
  try{await context.call("hetu.collaboration.authorize_workspace",{...context.base,work_ref:context.work,operation_key:randomUUID()});}
  catch(error){const actual=await context.status();if(!connected(actual))throw error;return actual;}
  const actual=await context.status();
  if(!connected(actual))throw new Error("当前作品连接尚未完成，请保留原操作并重新核对。");
  return actual;
}
