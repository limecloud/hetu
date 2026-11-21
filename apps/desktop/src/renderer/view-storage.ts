import type { WorkRef } from "@hetu/plugin-sdk";

export const documentSelectionKey = (work: WorkRef) =>
 "hetu-document:" + work.workspace_id + ":" + work.kind + ":" + work.object_id;

/** 阅读位置属于当前视图会话；MCP沙箱无Web Storage时保留在同一视图内存。 */
const positions=new Map<string,string>();
export const viewStorage={
 getItem(key:string){try{return sessionStorage.getItem(key)??positions.get(key)??null;}catch{return positions.get(key)??null;}},
 setItem(key:string,value:string){positions.set(key,value);try{sessionStorage.setItem(key,value);}catch{/* 无同源存储的MCP沙箱使用当前视图会话。 */}},
};
