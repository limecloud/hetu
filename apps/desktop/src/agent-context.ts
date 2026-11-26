import type {AgentContextRef} from "./agent-session-contract.ts";

const privateKey=/^(?:(?:workspace|related)_)?management_ref$|^(?:authorization|access_token|api_key|password|secret|workspace_path|file_path)$/i;
function privateField(value:unknown):boolean{
 if(Array.isArray(value))return value.some(privateField);
 return !!value&&typeof value==="object"&&Object.entries(value).some(([key,entry])=>privateKey.test(key)||privateField(entry));
}
export function validateContextRefs(value:unknown):AgentContextRef[]{
 if(!Array.isArray(value)||value.length>30)throw Error("最多附加30项固定上下文。");
 if(new TextEncoder().encode(JSON.stringify(value)).length>64_000)throw Error("上下文引用超过预算，请减少附加内容。");
 for(const ref of value){
  if(!ref||typeof ref.label!=="string"||!ref.label.trim()||ref.label.length>300||!ref.reference||typeof ref.reference!=="object"||Array.isArray(ref.reference))throw Error("固定上下文格式无效。");
  if(privateField(ref.reference))throw Error("上下文不能包含授权材料、凭据或任意本机路径。");
 }
 return structuredClone(value);
}
