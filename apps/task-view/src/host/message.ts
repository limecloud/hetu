import type { McpUiHostCapabilities } from "@modelcontextprotocol/ext-apps";
import {messageMetadata as openaiMetadata,supportsMessageDrafts} from "./openai.ts";

export function localMessageCapability(capabilities?:McpUiHostCapabilities){
 const value=capabilities?.experimental?.["hetu/message"];
 return value&&typeof value==="object"&&!Array.isArray(value)?value as {drafts?:boolean;directSend?:boolean}:undefined;
}
export function canDraft(capabilities?:McpUiHostCapabilities){
 return !!capabilities?.message?.text&&(localMessageCapability(capabilities)?.drafts===true||supportsMessageDrafts(capabilities));
}
export function messageMetadata(capabilities:McpUiHostCapabilities|undefined,target:"active"|"new",send:boolean){
 if(localMessageCapability(capabilities)){
  if(!canDraft(capabilities)||send&&localMessageCapability(capabilities)?.directSend===false)throw new Error("当前宿主仅接受会话草稿。");
  return {_meta:{"hetu/message":{target,send}}};
 }
 return openaiMetadata(capabilities,target,send);
}
