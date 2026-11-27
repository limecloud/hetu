import type {ExternalHistoryPage,ExternalMessage} from "../../shared/external-session.ts";
import {boundedExternalMessage,externalMessageIdentity} from "../../shared/external-message.ts";

export function externalHistoryCursor(value:unknown):string|undefined {
  if(value===null||value===undefined)return undefined;
  if(typeof value!=="string"||!value.length||Buffer.byteLength(value)>8192||/[\x00-\x1f\x7f]/.test(value))throw Error("提供方历史游标无效或超过预算。");
  return value;
}

/** 一页保持原顺序与原身份；裁剪显式报告，正文不进入布局或操作回执。 */
export function boundedExternalHistory(messages:ExternalMessage[],next?:unknown):ExternalHistoryPage {
  if(messages.length>16)throw Error("提供方历史页超过条目预算。");
  const ids=new Set<string>();let remaining=24*1024,truncated=false;
  const bounded=messages.map(message=>{
    const identity=externalMessageIdentity(message);
    if(typeof message.id!=="string"||!message.id||message.id.length>255||ids.has(identity)||!['user','assistant','tool','system'].includes(message.role)||typeof message.text!=="string"||message.turn_id!==undefined&&!/^[a-zA-Z0-9_.:-]{1,255}$/.test(message.turn_id))throw Error("提供方历史条目身份或内容无效。");
    ids.add(identity);
    // 预留后续条目的身份空间；参数和错误也计入整页预算。
    const budget=Math.max(1024,Math.min(8000,remaining-(messages.length-ids.size)*1024));
    const value=boundedExternalMessage(message,budget,6000);remaining-=Buffer.byteLength(JSON.stringify(value));truncated||=!!value.truncated;return value;
  });
  const next_cursor=externalHistoryCursor(next);
  return {messages:bounded,...(next_cursor?{next_cursor}:{}),truncated};
}
