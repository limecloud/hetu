import { randomUUID } from "node:crypto";
import type { WorkRef } from "@hetu/plugin-sdk";

/** 作者主动发起协作时连接当前对象；未知结果先核对真实状态。 */
export async function ensureWorkConnection(context: {
  work: WorkRef; base: Record<string,unknown>; check():void;
  status():Promise<any>; call(action:string,input:Record<string,unknown>):Promise<any>;
}) {
  const status=await context.status();if(status.authorized)return status;
  context.check();
  try{await context.call("hetu.collaboration.authorize_workspace",{...context.base,work_ref:context.work,operation_key:randomUUID()});}
  catch(error){const actual=await context.status();if(!actual.authorized)throw error;}
  return context.status();
}
