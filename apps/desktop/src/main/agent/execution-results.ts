import type {WorkRef} from "@hetu/plugin-sdk";
import type {AgentTool} from "../../agent-session-contract.ts";

type PlanRef={plan_id:string;sha256:string};
export type PlanQuery={tool:AgentTool;reference:PlanRef};
type Read=(action:string,input:Record<string,unknown>)=>Promise<any>;

/** 查询回执只用于定位原计划，不接受其内附的步骤或正文。 */
export function executionPlanReference(receipt:any):PlanRef|undefined{
 const data=receipt?.data;
 if(receipt?.action!=="hetu.execution.get_plan"||receipt.status!=="succeeded"||!/^execution_[a-f0-9-]{36}$/.test(data?.plan_id??"")||!/^[a-f0-9]{64}$/.test(data?.sha256??""))return;
 return {plan_id:data.plan_id,sha256:data.sha256};
}

export async function recoverExecutionResults(queries:PlanQuery[],work:WorkRef,read:Read){
 const unique=new Map(queries.map(query=>[JSON.stringify(query.reference),query]));
 const selected=[...unique.values()].slice(-12),steps:{tool:AgentTool;receipt:any}[]=[];
 let unread=unique.size-selected.length;
 for(const {tool,reference}of selected){
  try{
   const plan=await read("hetu.execution.get_plan",{plan_ref:reference});
   const identity=plan?.initialized_identity??plan?.fixed?.workspace_identity,commands=plan?.fixed?.commands,results=plan?.results;
   if(plan?.plan_id!==reference.plan_id||plan.sha256!==reference.sha256||identity?.kind!=="workspace"||identity.id!==work.workspace_id||!Array.isArray(commands)||!commands.length||commands.length>100||!Array.isArray(results)||results.length>commands.length)throw Error("原执行计划的身份或范围不一致。");
   if(["prepared","confirmed","rejected"].includes(plan.state)&&results.length===0)continue;
   if(!["blocked","executing","completed"].includes(plan.state)||plan.state==="completed"&&results.length!==commands.length||plan.state==="blocked"&&results.length===commands.length)throw Error("原执行计划的完成范围不一致。");
   if(results.some((result:any,index:number)=>!commands[index]?.action||result?.action!==commands[index].action||!["succeeded","partial"].includes(result.status)))throw Error("原执行步骤与固定命令不一致。");
   for(const receipt of results){if(receipt.status==="succeeded")steps.push({tool,receipt});else unread++;}
  }catch{unread++;}
 }
 return {steps,unread};
}
