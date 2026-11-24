/** 会话过程投影不展示机器授权材料；MCP文本块内的JSON同样处理。 */
function publicValue(value:unknown):unknown{
 if(Array.isArray(value))return value.map(publicValue);
 if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).filter(([key])=>!/^(?:(?:workspace|related)_)?management_ref$|^(?:access_token|api_key|authorization|password)$/i.test(key)).map(([key,child])=>[key,publicValue(child)]));
 if(typeof value==="string"&&/^\s*[\[{]/.test(value)){
  try{return JSON.stringify(publicValue(JSON.parse(value)));}catch{/* 普通文本保留原样。 */}
 }
 return value;
}
export function toolOutput(value:unknown){
 const projected=publicValue(value??"");
 return (typeof projected==="string"?projected:JSON.stringify(projected)).slice(0,128_000);
}
