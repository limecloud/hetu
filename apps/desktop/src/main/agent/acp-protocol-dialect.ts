import type {ExternalElicitationResponse} from "../../shared/external-elicitation.ts";
import {grokTurnReport,grokResultReport,type AcpTurnReport} from "./acp-turn-report.ts";

export type AcpProtocolDialect={
 normalize(frame:any):any;
 form(params:unknown):{params:unknown;source?:string;provider_item_id?:string;reply(value:ExternalElicitationResponse):unknown};
 promptMetadata?(id:string):{promptId:string;requestId:string};
 turnReport?(frame:unknown):AcpTurnReport|undefined;
 resultReport?(value:unknown):AcpTurnReport;
 sessionMetadata?(instructions:string):{rules:string};
};
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
const dialectForm=Symbol("acp-dialect-form");
export const isAcpDialectForm=(frame:Record<PropertyKey,unknown>)=>frame[dialectForm]===true;
const standard:AcpProtocolDialect={normalize:value=>value,form:params=>({params,reply:value=>value})};
/** 方言只解释已协商的协议差异，不按可执行文件名推测提供方或改变用户决定。 */
export function acpProtocolDialect(initialized:unknown):AcpProtocolDialect{
 if(!object(initialized)||!object(initialized._meta)||initialized._meta.grokShell!==true)return standard;
 return {
  promptMetadata:id=>({promptId:id,requestId:id}),turnReport:grokTurnReport,resultReport:grokResultReport,
  sessionMetadata(instructions){if(typeof instructions!=="string"||!instructions||Buffer.byteLength(instructions)>64*1024||/[\x00-\x08\x0b-\x1f\x7f]/.test(instructions))throw Error("固定作品接入说明无效或超过预算。");return {rules:instructions};},
  normalize(frame){
   if(typeof frame.method!=="string")return frame;const method=frame.method.replace(/^_/,"");
   if(["x.ai/session_notification","x.ai/session/update"].includes(method))return {...frame,method:"session/update"};
   if(method==="x.ai/mcp/elicit_complete")return {...frame,method:"elicitation/complete"};
   if(method==="x.ai/mcp/elicit")return {...frame,method:"elicitation/create",[dialectForm]:true};
   return frame;
  },
  form(params){
   if(!object(params)||typeof params.serverName!=="string"||!params.serverName||params.serverName.length>255||/[\x00-\x1f\x7f]/.test(params.serverName))throw Error("提供方表单缺少有效原服务身份。");
   const {serverName,toolCallId,...fields}=params;
   if(toolCallId!==undefined&&(typeof toolCallId!=="string"||!toolCallId||toolCallId.length>255||/[\x00-\x1f\x7f]/.test(toolCallId)))throw Error("提供方表单的原工具身份无效。");
   return {params:fields,source:serverName,...(typeof toolCallId==="string"?{provider_item_id:toolCallId}:{}),reply:value=>({outcome:value.action,...(value.content!==undefined?{content:value.content}:{})})};
  },
 };
}
